/**
 * 音效引擎 —— 全部 WebAudio 现场合成，仓库里不放任何音频文件。
 *
 * 信号链（不是一堆裸振荡器直接怼 destination）：
 *
 *     一次性音源 ──┬─→ sfxBus ───────────┐
 *                  └─→ reverbSend ─→ Convolver ─→ wet ─┤
 *     环境音床 ─────→ ambientBus ────────────────────────┴─→ 限幅器 → destination
 *
 * 三条让它听起来不像廉价合成器的关键：
 *  1. **卷积混响**：用 OfflineAudioContext 渲一段指数衰减的滤波噪声当 IR。
 *     干声贴在耳朵上是"低保真"最大的来源。
 *  2. **总线限幅**：几十个爆炸同时响必须有东西接住，否则直接削波破音。
 *  3. **随机化**：噪声每次从随机偏移读起、音高音量都抖动。永远从第 0 个采样
 *     播起正是"机器复读"感的根源。
 *
 * 音色上一律走"瞬态 + 主体 + 尾音"的分层做法，不用音阶琶音 —— 三角波弹旋律
 * 就是 MIDI 味的来源。
 */

// ── 参数表 ──────────────────────────────────────────────────────

/** 六级武器的枪声配方。tier 5 走合成器 zap，不用噪声。 */
const GUN_TIERS = [
  // 手枪：脆、干、短
  { crack: 4200, crackGain: 0.5, body: 760, bodyQ: 1.1, bodyDur: 0.075, sub: 150, subDur: 0.05, gain: 0.5 },
  // 冲锋枪：更紧更高，尾巴更短
  { crack: 5200, crackGain: 0.42, body: 980, bodyQ: 1.4, bodyDur: 0.055, sub: 165, subDur: 0.04, gain: 0.42 },
  // 突击步枪：中庸，有一点胸腔感
  { crack: 3600, crackGain: 0.55, body: 640, bodyQ: 1.0, bodyDur: 0.095, sub: 120, subDur: 0.07, gain: 0.55 },
  // 轻机枪：低频明显更重
  { crack: 3000, crackGain: 0.6, body: 480, bodyQ: 0.9, bodyDur: 0.13, sub: 92, subDur: 0.1, gain: 0.62 },
  // 加特林：短促密集，偏"锯"而不是"爆"
  { crack: 6000, crackGain: 0.34, body: 1250, bodyQ: 2.2, bodyDur: 0.042, sub: 190, subDur: 0.03, gain: 0.36 },
  // 等离子：synth 标记，下面单独分支
  { crack: 0, crackGain: 0, body: 0, bodyQ: 0, bodyDur: 0, sub: 0, subDur: 0, gain: 0.5 },
] as const;

const REVERB_SECONDS = 2.4;
const NOISE_SECONDS = 2.0;

interface NoiseOpts {
  dur: number;
  gain: number;
  /** 滤波器类型，默认 bandpass。 */
  type?: BiquadFilterType;
  /** 起始截止频率。 */
  f0: number;
  /** 结束截止频率，默认与 f0 相同（不扫频）。 */
  f1?: number;
  q?: number;
  pan?: number;
  attack?: number;
  bank?: 0 | 1 | 2;
  /** 送进混响的量，0-1。 */
  send?: number;
  rate?: number;
  /** 相对当前时刻推迟多久播放。 */
  delay?: number;
}

interface ToneOpts {
  dur: number;
  gain: number;
  type?: OscillatorType;
  f0: number;
  f1?: number;
  pan?: number;
  attack?: number;
  send?: number;
  detune?: number;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ambient: GainNode | null = null;
  private wet: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  /** 白 / 粉 / 棕三条噪声，按音色挑。 */
  private banks: AudioBuffer[] = [];
  private crunch: WaveShaperNode | null = null;

  // 初值取负数：AudioContext 刚建好时 currentTime 就是 0，如果这两个也是 0，
  // 第一发枪声和第一声爆炸会被自己的限流判定吃掉。
  private lastShot = -1;
  private shotBudget = 0;
  private lastBoom = -1;
  private boomSkipped = 0;

  // 环境音床
  private bedGain: GainNode | null = null;
  private bedNodes: AudioScheduledSourceNode[] = [];
  private bedFilter: BiquadFilterNode | null = null;
  private bedTarget = 0;

  muted = false;

  // ── 生命周期 ──────────────────────────────────────────────────

  /** 浏览器要求音频必须由用户手势启动。 */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    // 总线限幅器：ratio 拉满 + 低阈值 = 砖墙，接住同时几十个爆炸
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 2;
    limiter.ratio.value = 16;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;
    limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.75;
    this.master.connect(limiter);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = 1;
    this.sfx.connect(this.master);

    this.ambient = ctx.createGain();
    this.ambient.gain.value = 1;
    this.ambient.connect(this.master);

    // 混响先接好，IR 渲染完再塞进去 —— 渲染是异步的，这几十毫秒里声音是干的
    this.convolver = ctx.createConvolver();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.9;
    this.convolver.connect(this.wet).connect(this.master);
    void this.renderImpulse(ctx).then((buf) => {
      if (this.convolver) this.convolver.buffer = buf;
    });

    // 爆炸用的软削波，给低频一点"撕裂"感
    this.crunch = ctx.createWaveShaper();
    this.crunch.curve = makeSaturation(2.4);
    this.crunch.oversample = '2x';
    this.crunch.connect(this.sfx);

    this.banks = [makeNoise(ctx, 0), makeNoise(ctx, 1), makeNoise(ctx, 2)];
    this.startBed(ctx);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : 0.75, this.ctx.currentTime, 0.02);
    }
  }

  /** 每帧重置一次开火预算，避免上百个士兵同时开枪把声音糊成噪音。 */
  frame(): void {
    this.shotBudget = 3;
  }

  // ── 战斗音效 ──────────────────────────────────────────────────

  shot(weaponLevel: number, pan = 0): void {
    if (!this.ready() || this.shotBudget <= 0) return;
    const now = this.ctx!.currentTime;
    if (now - this.lastShot < 0.026) return;
    this.lastShot = now;
    this.shotBudget--;

    const tier = GUN_TIERS[Math.max(0, Math.min(5, weaponLevel))]!;
    const jit = 1 + (Math.random() - 0.5) * 0.14;

    if (weaponLevel >= 5) {
      // 等离子：纯合成器，一声下扫的 zap + 一层亮的谐波，完全不用噪声
      this.tone({ type: 'sawtooth', f0: 2400 * jit, f1: 260, dur: 0.16, gain: 0.3, pan, send: 0.3, attack: 0.002 });
      this.tone({ type: 'square', f0: 1200 * jit, f1: 180, dur: 0.11, gain: 0.14, pan, send: 0.2 });
      this.noise({ f0: 5200, f1: 1400, dur: 0.05, gain: 0.16, q: 1.2, pan, bank: 0, send: 0.2 });
      return;
    }

    // 瞬态：极短的高频"啪"，这是"近"的来源
    this.noise({
      type: 'highpass', f0: tier.crack * jit, dur: 0.016,
      gain: tier.crackGain, q: 0.7, pan, bank: 0,
    });
    // 主体：带通噪声走一条下扫的滤波包络
    this.noise({
      f0: tier.body * jit, f1: tier.body * 0.42, dur: tier.bodyDur,
      gain: tier.gain, q: tier.bodyQ, pan, bank: 1, send: 0.14,
    });
    // 低频：给一点后坐力的分量
    this.tone({ f0: tier.sub * jit, f1: tier.sub * 0.5, dur: tier.subDur, gain: tier.gain * 0.5, pan });
  }

  /** 大炮开火：比爆炸紧、带一声金属机械音。 */
  cannon(pan = 0): void {
    if (!this.ready()) return;
    this.noise({ type: 'highpass', f0: 2600, dur: 0.03, gain: 0.5, pan, bank: 0 });
    this.noise({ type: 'lowpass', f0: 1400, f1: 300, dur: 0.34, gain: 0.6, pan, bank: 2, send: 0.4 });
    this.tone({ f0: 128, f1: 44, dur: 0.32, gain: 0.7, pan, send: 0.3 });
    // 炮闩的金属"当"
    this.noise({ f0: 3200, dur: 0.06, gain: 0.16, q: 7, pan, bank: 0, send: 0.25 });
  }

  /**
   * 爆炸。
   * 同一瞬间几十发炮弹落地时不是各响一次 —— 攒起来响一次更大的，
   * 否则既糊又直接把总线打爆。
   */
  explosion(pan = 0): void {
    if (!this.ready()) return;
    const now = this.ctx!.currentTime;
    if (now - this.lastBoom < 0.055) {
      this.boomSkipped++;
      return;
    }
    const swell = Math.min(1.7, 1 + this.boomSkipped * 0.11);
    this.lastBoom = now;
    this.boomSkipped = 0;
    this.boom(0.55 * swell, pan, 1);
  }

  /** 方块被打碎：一声爆炸 + 一把金属碎片。 */
  blockBreak(pan = 0): void {
    if (!this.ready()) return;
    this.boom(0.72, pan, 1.2);
    for (let i = 0; i < 5; i++) {
      const t = 0.02 + Math.random() * 0.22;
      this.noise({
        f0: 1800 + Math.random() * 3400, dur: 0.05 + Math.random() * 0.06,
        gain: 0.13, q: 9, pan: pan + (Math.random() - 0.5) * 0.5,
        bank: 0, send: 0.4, delay: t,
      });
    }
  }

  /** 打在装甲上的金属回响。 */
  blockHit(pan = 0): void {
    if (!this.ready() || Math.random() > 0.35) return;
    this.noise({ f0: 2200 + Math.random() * 1800, dur: 0.05, gain: 0.1, q: 8, pan, bank: 0, send: 0.25 });
  }

  /** 金币入袋：FM 金属 ping。连续捡的时候音高一级级往上爬。 */
  coinPickup(streak = 0, pan = 0): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const base = 880 * Math.pow(1.0595, Math.min(12, streak) * 2);

    // 真 FM：一个振荡器去调制另一个的 frequency
    const carrier = ctx.createOscillator();
    const modulator = ctx.createOscillator();
    const modGain = ctx.createGain();
    const g = ctx.createGain();
    carrier.type = 'sine';
    carrier.frequency.value = base;
    modulator.type = 'sine';
    modulator.frequency.value = base * 2.76; // 非整数比 = 金属感而不是乐音
    modGain.gain.setValueAtTime(base * 1.6, t0);
    modGain.gain.exponentialRampToValueAtTime(base * 0.05, t0 + 0.16);
    modulator.connect(modGain).connect(carrier.frequency);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.28, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
    carrier.connect(g);
    this.route(g, pan, 0.3);

    carrier.start(t0);
    modulator.start(t0);
    carrier.stop(t0 + 0.28);
    modulator.stop(t0 + 0.28);

    // 一点点亮的尖头，让它在混战里穿得出来
    this.noise({ type: 'highpass', f0: 6000, dur: 0.02, gain: 0.1, pan, bank: 0 });
  }

  /** 过门：滤波扫频的 swell，不是音阶。 */
  gate(good: boolean, pan = 0): void {
    if (!this.ready()) return;
    if (good) {
      this.noise({ f0: 400, f1: 4800, dur: 0.42, gain: 0.3, q: 3.4, pan, bank: 1, send: 0.5, attack: 0.12 });
      this.tone({ type: 'sawtooth', f0: 180, f1: 540, dur: 0.5, gain: 0.16, pan, send: 0.4, attack: 0.14 });
      this.tone({ type: 'sine', f0: 360, f1: 1080, dur: 0.5, gain: 0.1, pan, send: 0.4, attack: 0.16 });
    } else {
      this.noise({ f0: 2600, f1: 260, dur: 0.5, gain: 0.28, q: 2.6, pan, bank: 2, send: 0.5, attack: 0.05 });
      this.tone({ type: 'sawtooth', f0: 320, f1: 92, dur: 0.55, gain: 0.2, pan, send: 0.4, attack: 0.04 });
    }
  }

  /** 僵尸倒地：湿闷的一声。 */
  zombieDie(pan = 0): void {
    if (!this.ready() || Math.random() > 0.28) return;
    const j = 0.8 + Math.random() * 0.5;
    this.noise({ type: 'lowpass', f0: 900 * j, f1: 180, dur: 0.14, gain: 0.16, pan, bank: 2, send: 0.2 });
    this.tone({ f0: 160 * j, f1: 60, dur: 0.12, gain: 0.1, pan });
  }

  /** 士兵阵亡：比僵尸钝、带一点低频的"沉"。 */
  soldierDown(pan = 0): void {
    if (!this.ready()) return;
    this.noise({ type: 'lowpass', f0: 620, f1: 130, dur: 0.2, gain: 0.2, pan, bank: 2, send: 0.3 });
    this.tone({ f0: 110, f1: 48, dur: 0.24, gain: 0.16, pan, send: 0.2 });
  }

  /** 酸液落地：一声湿黏的"啪嗒"加一点嘶嘶的腐蚀声。 */
  acidSplash(pan = 0): void {
    if (!this.ready()) return;
    this.noise({ type: 'lowpass', f0: 1500, f1: 280, dur: 0.18, gain: 0.26, pan, bank: 2, send: 0.35 });
    // 嘶嘶声：高频窄带慢慢退下去
    this.noise({ f0: 5200, f1: 2600, dur: 0.5, gain: 0.12, q: 3.2, pan, bank: 0, send: 0.4, attack: 0.04 });
    this.tone({ f0: 180, f1: 70, dur: 0.16, gain: 0.14, pan });
  }

  /** 跳跃者起跳：一声短促上扬的嘶吼。 */
  leap(pan = 0): void {
    if (!this.ready() || Math.random() > 0.55) return;
    const j = 0.85 + Math.random() * 0.4;
    this.tone({ type: 'sawtooth', f0: 220 * j, f1: 640 * j, dur: 0.22, gain: 0.16, pan, send: 0.3, attack: 0.03 });
    this.noise({ f0: 900, f1: 2600, dur: 0.2, gain: 0.12, q: 2.4, pan, bank: 1, send: 0.25 });
  }

  /** 近战撞击。 */
  meleeHit(pan = 0): void {
    if (!this.ready() || Math.random() > 0.2) return;
    this.noise({ type: 'lowpass', f0: 1100, f1: 240, dur: 0.08, gain: 0.13, pan, bank: 2 });
  }

  /**
   * 技能预警的蓄力声：一条往上爬的啸叫。
   * 这条是可玩性而不只是表现 —— 之前玩家只能靠眼睛看地上的圈。
   * `dur` 要和预警时长对齐，`kind` 决定音色，和地上的配色一一对应。
   */
  telegraph(dur: number, kind: 'slam' | 'lightning' | 'charge' | 'shock', pan = 0): void {
    if (!this.ready()) return;
    const spec = {
      slam: { f0: 90, f1: 420, type: 'sawtooth' as OscillatorType, nf0: 300, nf1: 1800, gain: 0.2 },
      lightning: { f0: 620, f1: 2600, type: 'triangle' as OscillatorType, nf0: 1800, nf1: 7000, gain: 0.17 },
      charge: { f0: 140, f1: 300, type: 'square' as OscillatorType, nf0: 200, nf1: 900, gain: 0.16 },
      shock: { f0: 200, f1: 900, type: 'sawtooth' as OscillatorType, nf0: 500, nf1: 3000, gain: 0.18 },
    }[kind];
    this.tone({
      type: spec.type, f0: spec.f0, f1: spec.f1, dur,
      gain: spec.gain, pan, send: 0.35, attack: dur * 0.7,
    });
    this.noise({
      f0: spec.nf0, f1: spec.nf1, dur, gain: spec.gain * 0.7,
      q: 4, pan, bank: 1, send: 0.3, attack: dur * 0.75,
    });
  }

  /** Boss 咆哮：低频下扫 + 共振噪声，压住环境音床。 */
  bossRoar(pan = 0): void {
    if (!this.ready()) return;
    this.duck(1.1);
    this.tone({ type: 'sawtooth', f0: 190, f1: 42, dur: 1.3, gain: 0.42, pan, send: 0.6, attack: 0.07 });
    this.tone({ type: 'square', f0: 96, f1: 30, dur: 1.35, gain: 0.2, pan, send: 0.5, attack: 0.1 });
    this.noise({ type: 'bandpass', f0: 700, f1: 180, dur: 1.2, gain: 0.34, q: 2.2, pan, bank: 2, send: 0.7, attack: 0.12 });
    this.noise({ type: 'highpass', f0: 2600, f1: 700, dur: 0.5, gain: 0.14, pan, bank: 0, send: 0.5, attack: 0.06 });
  }

  /** Boss 脚步：闷的一记地面撞击。 */
  footstep(pan = 0): void {
    if (!this.ready()) return;
    this.tone({ f0: 78, f1: 34, dur: 0.24, gain: 0.34, pan, send: 0.35 });
    this.noise({ type: 'lowpass', f0: 500, f1: 110, dur: 0.16, gain: 0.16, pan, bank: 2, send: 0.3 });
  }

  /** 天降雷击：尖锐的一"啪"，紧跟一段滚下去的低频轰鸣。 */
  thunderCrack(pan = 0): void {
    if (!this.ready()) return;
    this.duck(0.8);
    this.noise({ type: 'highpass', f0: 6000, f1: 2200, dur: 0.07, gain: 0.6, pan, bank: 0, send: 0.5 });
    this.noise({ type: 'lowpass', f0: 1800, f1: 90, dur: 1.1, gain: 0.5, pan, bank: 2, send: 0.8 });
    this.tone({ type: 'sawtooth', f0: 420, f1: 38, dur: 0.6, gain: 0.3, pan, send: 0.5 });
  }

  // ── UI / 胜负 ────────────────────────────────────────────────

  win(): void {
    if (!this.ready()) return;
    this.duck(1.6);
    // 分层的和声 swell，不是琶音：每一层都是失谐锯齿过低通，慢起音
    const chord = [130.8, 196, 261.6, 392];
    chord.forEach((f, i) => {
      this.tone({ type: 'sawtooth', f0: f, dur: 1.8, gain: 0.13, send: 0.8, attack: 0.3 + i * 0.06, detune: -7 });
      this.tone({ type: 'sawtooth', f0: f, dur: 1.8, gain: 0.13, send: 0.8, attack: 0.3 + i * 0.06, detune: 7 });
    });
    this.noise({ f0: 600, f1: 5000, dur: 1.2, gain: 0.14, q: 2, bank: 1, send: 0.9, attack: 0.5 });
  }

  lose(): void {
    if (!this.ready()) return;
    this.duck(1.6);
    const chord = [110, 130.8, 155.6];
    chord.forEach((f) => {
      this.tone({ type: 'sawtooth', f0: f, f1: f * 0.5, dur: 2.2, gain: 0.16, send: 0.8, attack: 0.2, detune: -9 });
      this.tone({ type: 'sawtooth', f0: f, f1: f * 0.5, dur: 2.2, gain: 0.16, send: 0.8, attack: 0.2, detune: 9 });
    });
    this.noise({ type: 'lowpass', f0: 1400, f1: 120, dur: 2.0, gain: 0.2, bank: 2, send: 0.9, attack: 0.1 });
  }

  click(): void {
    if (!this.ready()) return;
    this.noise({ type: 'highpass', f0: 2600, dur: 0.022, gain: 0.2, bank: 0, send: 0.15 });
    this.tone({ f0: 720, f1: 520, dur: 0.05, gain: 0.1 });
  }

  // ── 环境音床 ──────────────────────────────────────────────────

  /**
   * 末日环境音床：低频嗡鸣 + 风。
   * `intensity` 0-1 按战况给（敌人数量 / Boss 是否在场），交叉淡入淡出。
   */
  setAmbience(intensity: number, dt: number): void {
    if (!this.ctx || !this.bedGain || !this.bedFilter) return;
    this.bedTarget = Math.max(0, Math.min(1, intensity));
    const g = this.bedGain.gain;
    const cur = g.value;
    // 涨得快、落得慢：战斗一起来立刻压上，安静下来慢慢退
    const k = Math.min(1, dt * (this.bedTarget > cur ? 1.6 : 0.5));
    g.value = cur + (this.bedTarget * 0.5 - cur) * k;
    // 越紧张开得越亮
    const f = 220 + this.bedTarget * 900;
    this.bedFilter.frequency.value += (f - this.bedFilter.frequency.value) * Math.min(1, dt * 1.2);
  }

  private startBed(ctx: AudioContext): void {
    const bed = ctx.createGain();
    bed.gain.value = 0;
    this.bedGain = bed;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 0.7;
    this.bedFilter = lp;
    bed.connect(lp).connect(this.ambient!);

    // 三个失谐的低频振荡器 —— 拍频本身就是"不安"的来源
    for (const [f, type, gain] of [
      [41.2, 'sawtooth', 0.5],
      [55.0, 'triangle', 0.34],
      [61.7, 'sawtooth', 0.22],
    ] as const) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 18;
      g.gain.value = gain;
      o.connect(g).connect(bed);
      o.start();
      this.bedNodes.push(o);
    }

    // 风：噪声过一个被慢 LFO 推着走的带通
    const wind = ctx.createBufferSource();
    wind.buffer = this.banks[1]!;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 480;
    wf.Q.value = 1.1;
    const wg = ctx.createGain();
    wg.gain.value = 0.5;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain).connect(wf.frequency);
    wind.connect(wf).connect(wg).connect(bed);
    wind.start();
    lfo.start();
    this.bedNodes.push(wind, lfo);
  }

  /** 大事件把音床按下去一下，让爆炸有地方站。 */
  private duck(seconds: number): void {
    if (!this.ctx || !this.ambient) return;
    const t = this.ctx.currentTime;
    const g = this.ambient.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.25, t + 0.05);
    g.linearRampToValueAtTime(1, t + seconds);
  }

  // ── 合成基元 ──────────────────────────────────────────────────

  private ready(): boolean {
    return this.ctx !== null && !this.muted && this.banks.length > 0;
  }

  /** 一次性噪声：滤波器可以扫频，这是"这一枪有质感"的主要来源。 */
  private noise(o: NoiseOpts & { delay?: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    const buf = this.banks[o.bank ?? 1]!;
    src.buffer = buf;
    src.playbackRate.value = o.rate ?? 1;

    const f = ctx.createBiquadFilter();
    f.type = o.type ?? 'bandpass';
    f.Q.value = o.q ?? 1.2;
    f.frequency.setValueAtTime(Math.max(20, o.f0), t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t0 + o.dur);
    }

    const g = ctx.createGain();
    const atk = o.attack ?? 0.002;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    src.connect(f).connect(g);
    this.route(g, o.pan ?? 0, o.send ?? 0);

    // 从随机偏移读起 —— 每次都从头播正是"复读机"感的根源
    const offset = Math.random() * Math.max(0.01, buf.duration - o.dur - 0.02);
    src.start(t0, offset, o.dur + 0.02);
    src.stop(t0 + o.dur + 0.03);
  }

  /** 一次性振荡器，可扫频。 */
  private tone(o: ToneOpts & { delay?: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    const t0 = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    if (o.detune) osc.detune.value = o.detune;
    osc.frequency.setValueAtTime(Math.max(10, o.f0), t0);
    if (o.f1 !== undefined && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.f1), t0 + o.dur);
    }

    const g = ctx.createGain();
    const atk = o.attack ?? 0.003;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    osc.connect(g);
    this.route(g, o.pan ?? 0, o.send ?? 0);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
  }

  /** 爆炸的共用配方：瞬态 + 主体 + 低频 + 混响尾。 */
  private boom(gain: number, pan: number, weight: number): void {
    const j = 0.85 + Math.random() * 0.3;
    this.duck(0.5);
    // 瞬态
    this.noise({ type: 'highpass', f0: 3800 * j, dur: 0.028, gain: gain * 0.7, pan, bank: 0 });
    // 主体：低通从开到关，这条扫频就是"爆炸"的辨识度
    this.noise({
      type: 'lowpass', f0: 2200 * j, f1: 90, dur: 0.5 * weight,
      gain: gain, pan, bank: 2, send: 0.6,
    });
    // 低频冲击，走软削波
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120 * j, t0);
    osc.frequency.exponentialRampToValueAtTime(28, t0 + 0.42 * weight);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain * 1.1, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.46 * weight);
    osc.connect(g);
    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(pan);
    g.connect(p);
    p.connect(this.crunch!);
    if (this.convolver) {
      const send = ctx.createGain();
      send.gain.value = 0.5;
      p.connect(send).connect(this.convolver);
    }
    osc.start(t0);
    osc.stop(t0 + 0.5 * weight);
  }

  /** 定位 + 混响送出。 */
  private route(node: AudioNode, pan: number, send: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    const p = ctx.createStereoPanner();
    p.pan.value = clampPan(pan);
    node.connect(p);
    p.connect(this.sfx);
    if (send > 0 && this.convolver) {
      const s = ctx.createGain();
      s.gain.value = send;
      p.connect(s).connect(this.convolver);
    }
  }

  /**
   * 程序化混响 IR：一段指数衰减的滤波噪声。
   * 这是整套里最关键的一步 —— 没有它，所有声音都干贴在耳朵上。
   */
  private renderImpulse(ctx: AudioContext): Promise<AudioBuffer> {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * REVERB_SECONDS);
    const OfflineCtor =
      window.OfflineAudioContext ??
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;
    const off = new OfflineCtor!(2, len, rate);

    const buf = off.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // 前 8ms 留一点预延迟，尾巴按 2.6 次方衰减 = 混凝土大空间
        d[i] = i < rate * 0.008 ? 0 : (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      }
    }
    const src = off.createBufferSource();
    src.buffer = buf;
    // 掐掉极低和极高，剩下的才像"废墟里的回声"而不是白噪声
    const hp = off.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    src.connect(hp).connect(lp).connect(off.destination);
    src.start();
    return off.startRendering();
  }
}

// ── 模块级工具 ──────────────────────────────────────────────────

function clampPan(p: number): number {
  return p < -1 ? -1 : p > 1 ? 1 : p;
}

/** 0 = 白噪声（亮、脆），1 = 粉噪声（中性），2 = 棕噪声（闷、重）。 */
function makeNoise(ctx: AudioContext, kind: 0 | 1 | 2): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === 0) {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (kind === 1) {
    // Paul Kellet 的粉噪声近似
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    // 棕噪声：白噪声积分 + 泄漏
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  return buf;
}

/** tanh 软削波曲线，给爆炸的低频一点撕裂感。 */
function makeSaturation(amount: number) {
  const n = 512;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}
