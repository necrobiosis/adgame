/**
 * 音效全部用 WebAudio 现场合成 —— 仓库里不放任何音频文件。
 * 枪声是过滤后的噪声脉冲，爆炸是低频噪声 + 快速衰减，
 * 过门是一串上行的正弦音，Boss 咆哮是缓慢下滑的锯齿波。
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastShot = 0;
  private shotBudget = 0;
  muted = false;

  /** 浏览器要求音频必须由用户手势启动。 */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(ctx.destination);

    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  /** 每帧重置一次开火音效预算，避免上百个士兵同时开枪把声音糊成噪音。 */
  frame(): void {
    this.shotBudget = 3;
  }

  shot(weaponLevel: number): void {
    if (!this.ctx || this.muted || this.shotBudget <= 0) return;
    const now = this.ctx.currentTime;
    if (now - this.lastShot < 0.028) return;
    this.lastShot = now;
    this.shotBudget--;
    const hi = 900 + weaponLevel * 260;
    this.noiseBurst(0.055, hi, 0.16, 'bandpass');
  }

  cannon(): void {
    this.boom(0.34, 130, 0.4);
  }

  explosion(): void {
    this.boom(0.55, 78, 0.55);
  }

  blockBreak(): void {
    this.boom(0.7, 60, 0.6);
    this.chime([880, 1320, 1760], 0.18, 0.12);
  }

  gate(good: boolean): void {
    this.chime(good ? [523, 659, 784, 1047] : [392, 330, 262], 0.5, 0.16);
  }

  bossRoar(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(48, ctx.currentTime + 1.1);
    f.type = 'lowpass';
    f.frequency.value = 900;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.42, ctx.currentTime + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.3);
    o.connect(f).connect(g).connect(this.master!);
    o.start();
    o.stop(ctx.currentTime + 1.35);
  }

  /** 天降雷击：一声尖锐的高频"啪"，紧跟一段下滑的低频轰鸣当余响。 */
  thunderCrack(): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    this.noiseBurst(0.09, 3200, 0.5, 'highpass');
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(520, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.5);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.38, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
    o.connect(g).connect(this.master!);
    o.start();
    o.stop(ctx.currentTime + 0.6);
  }

  win(): void {
    this.chime([523, 659, 784, 1047, 1319], 0.9, 0.2);
  }

  lose(): void {
    this.chime([392, 330, 262, 196], 0.9, 0.22);
  }

  click(): void {
    this.chime([660], 0.08, 0.1);
  }

  // ── 合成基元 ────────────────────────────────────────────────

  private noiseBurst(dur: number, freq: number, gain: number, type: BiquadFilterType): void {
    if (!this.ctx || !this.noise || this.muted) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start();
    src.stop(ctx.currentTime + dur);
  }

  private boom(dur: number, freq: number, gain: number): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    this.noiseBurst(dur, freq * 2.2, gain * 0.5, 'lowpass');
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(Math.max(24, freq * 0.35), ctx.currentTime + dur);
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master!);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  private chime(freqs: readonly number[], dur: number, gain: number): void {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      const t0 = ctx.currentTime + i * (dur / freqs.length) * 0.75;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.9);
      o.connect(g).connect(this.master!);
      o.start(t0);
      o.stop(t0 + dur);
    });
  }
}
