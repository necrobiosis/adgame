import * as THREE from 'three';
import { BOMBER, BOSS, LOADOUT, MIDBOSS, ROAD_HALF, SPITTER, WEAPON_TIERS } from '../config/balance';
import { LEVELS } from '../config/levels';
import { GameView } from '../render/GameView';
import { Renderer } from '../render/Renderer';
import { QUALITY, QualityProbe, guessQuality, storeQuality, storedQuality, type QualityLevel } from '../render/Quality';
import { World } from '../sim/World';
import type { SimEvent } from '../sim/types';
import { loadSave, writeSave, type SaveData } from '../meta/Save';
import { FloatingLayer, HUD } from '../ui/HUD';
import { Screens } from '../ui/Screens';
import { Audio } from './Audio';
import { Input } from './Input';

type Phase = 'menu' | 'shop' | 'playing' | 'result';

/** 固定步长，保证不同帧率下的模拟结果一致。 */
const STEP = 1 / 60;
const MAX_STEPS = 5;

export class Game {
  private readonly renderer: Renderer;
  private readonly view: GameView;
  private readonly input: Input;
  private readonly audio = new Audio();
  private readonly hud: HUD;
  private readonly floats: FloatingLayer;
  private readonly screens: Screens;
  private readonly save: SaveData;

  /**
   * 开发期调试用：把平衡常量摊出来给自检脚本读。
   * 脚本里写死这些数字的话，改一次配置就会悄悄失真——之前闪避自检就是
   * 因为写死了半径，路面调窄之后还在拿旧数字算，结论完全不对。
   */
  readonly balance = { BOMBER, BOSS, LOADOUT, MIDBOSS, ROAD_HALF, SPITTER, WEAPON_TIERS };

  /** 开发期调试用：读当前局的模拟状态与渲染实例数。 */
  debug(): Record<string, unknown> {
    const w = this.world;
    return {
      phase: this.phase,
      simPhase: w?.phase,
      z: w?.squad.z.toFixed(1),
      soldiers: w?.squad.soldierCount,
      enemiesAlive: w?.enemies.aliveCount,
      enemiesTotal: w?.enemies.list.length,
      nearest: w ? Math.round(w.enemies.list.reduce((m, e) => (e.alive ? Math.min(m, e.z - w.squad.z) : m), 999)) : null,
      contact: w?.enemies.contactCount,
      bossAlive: w?.boss.enemy?.alive ?? false,
      bossTelegraph: w?.boss.telegraph?.kind ?? null,
      drawn: this.view.instanceCounts(),
      tracers: this.view.tracerCount,
      fog: !!this.renderer.scene.fog,
      quality: this.renderer.quality.level,
      tris: this.renderer.triangles,
      calls: this.renderer.renderer.info.render.calls,
    };
  }

  /**
   * 开发期调试：不渲染地快进 n 秒模拟。
   * 用来在浏览器里直接跳到尸潮最密的那一段或者 Boss 战，
   * 不用干等 —— 也方便截图核对画面。
   */
  /** 开发期调试：把镜头钉到某个目标近处看资产细节。 */
  inspect(target: 'squad' | 'boss' | 'enemy' | 'cannon' | null, dist = 4, height = 1.2, yaw = 0.6): void {
    this.view.inspect = target ? { target, dist, height, yaw } : null;
  }

  /** 开发期调试：直接回主菜单。 */
  debugMenu(): void {
    this.openMenu();
  }

  fastForward(seconds: number): void {
    const w = this.world;
    if (!w || this.phase !== 'playing') return;
    const n = Math.min(20000, Math.round(seconds / STEP));
    for (let i = 0; i < n && w.phase === 'running'; i++) {
      w.steer = this.input.steerFor(w.squad.x);
      w.step(STEP);
      w.drainEvents();
    }
  }

  private world: World | null = null;
  private phase: Phase = 'menu';
  private acc = 0;
  private last = 0;
  /** 结算界面延迟一点再弹，让最后一击的特效播完。 */
  private resultDelay = 0;
  private pendingResult: { won: boolean; levelId: number; goldBefore: number } | null = null;

  private readonly probe = new QualityProbe();
  /** 玩家手动选过档位之后就不再自动降档。 */
  private qualityLocked = storedQuality() !== null;

  private readonly projOut = { x: 0, y: 0, visible: false };
  private readonly projVec = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, overlay: HTMLElement) {
    this.save = loadSave();
    this.renderer = new Renderer(canvas, storedQuality() ?? guessQuality());
    this.view = new GameView(this.renderer);
    this.input = new Input(canvas, () => this.renderer.viewWidth);
    this.audio.setMuted(this.save.muted);

    this.floats = new FloatingLayer(overlay);
    this.hud = new HUD(overlay);
    this.hud.setVisible(false);
    this.hud.onStrike(() => {
      this.audio.unlock();
      if (this.world && this.world.callAirstrike()) this.hud.flashStrike();
      else this.audio.click();
    });
    this.screens = new Screens(overlay, this.save, {
      startLevel: (id) => this.startLevel(id),
      openShop: () => this.openShop(),
      openMenu: () => this.openMenu(),
      retry: () => this.startLevel(this.world?.level.id ?? 1),
      nextLevel: () => this.startLevel(Math.min(LEVELS.length, (this.world?.level.id ?? 1) + 1)),
      cycleQuality: () => {
        const order: QualityLevel[] = ['low', 'medium', 'high'];
        const i = order.indexOf(this.renderer.quality.level);
        this.setQuality(order[(i + 1) % order.length]!);
      },
      qualityLabel: () => this.qualityLabel,
      toggleMute: () => {
        this.save.muted = !this.save.muted;
        this.audio.setMuted(this.save.muted);
        writeSave(this.save);
      },
      click: () => {
        this.audio.unlock();
        this.audio.click();
      },
    });

    this.syncOverlay();
    window.addEventListener('resize', () => this.onResize());
    // 第一次触摸时解锁音频
    canvas.addEventListener('pointerdown', () => this.audio.unlock(), { once: true });

    if (import.meta.env.DEV) {
      (window as unknown as { __game: Game }).__game = this;
    }

    this.openMenu();
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  private onResize(): void {
    this.renderer.resize();
    this.syncOverlay();
  }

  /** 让 DOM 覆盖层和竖屏画布严格对齐。 */
  private syncOverlay(): void {
    const overlay = document.getElementById('overlay')!;
    overlay.style.width = `${this.renderer.viewWidth}px`;
    overlay.style.height = `${this.renderer.viewHeight}px`;
  }

  // ── 状态切换 ────────────────────────────────────────────────

  private openMenu(): void {
    this.phase = 'menu';
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.floats.clear();
    this.screens.showMenu();
  }

  private openShop(): void {
    this.phase = 'shop';
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.screens.showShop();
  }

  private startLevel(id: number): void {
    this.audio.unlock();
    this.screens.hide();
    this.floats.clear();
    const world = new World({
      levelId: id,
      upgrades: this.save.upgrades,
      loadout: this.save.loadout,
      seed: (Date.now() & 0xffff) || 1,
    });
    this.world = world;
    this.view.buildLevel(world);
    this.input.reset(0);
    this.input.setEnabled(true);
    this.hud.setVisible(true);
    this.hud.update(world);
    this.phase = 'playing';
    this.acc = 0;
    this.resultDelay = 0;
    this.pendingResult = null;
  }

  private finish(won: boolean, goldEarned: number): void {
    const world = this.world!;
    this.save.gold += goldEarned;
    if (world.level.endless) {
      // 无尽模式没有"通关"，成绩是推进距离
      this.save.bestDistance = Math.max(this.save.bestDistance ?? 0, world.distance);
    } else if (won) {
      this.save.unlockedLevel = Math.max(this.save.unlockedLevel, Math.min(LEVELS.length, world.level.id + 1));
      const prev = this.save.bestTime[world.level.id];
      if (prev === undefined || world.stats.elapsed < prev) {
        this.save.bestTime[world.level.id] = world.stats.elapsed;
      }
    }
    writeSave(this.save);

    this.phase = 'result';
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.screens.showResult({
      won,
      levelId: world.level.id,
      stats: world.stats,
      goldEarned,
      hasNext: !world.level.endless && world.level.id < LEVELS.length,
      endless: world.level.endless,
      distance: world.distance,
    });
  }

  // ── 主循环 ──────────────────────────────────────────────────

  private readonly frame = (now: number): void => {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.audio.frame();

    if (this.phase === 'playing' && this.world) {
      this.checkQuality(dt);
      this.stepWorld(this.world, dt);
    } else if (this.world) {
      // 结算/菜单时场景继续渲染，但不再推进模拟
      this.view.update(this.world, dt, []);
    }

    this.renderer.render();
    requestAnimationFrame(this.frame);
  };

  /**
   * 开局实测帧时，跟不上就降一档。
   * 只降不升 —— 升档要重建全部角色几何体，为一次误判做这件事不划算。
   */
  private checkQuality(dt: number): void {
    if (this.qualityLocked) return;
    const next = this.probe.sample(dt, this.renderer.quality.level);
    if (!next) return;
    this.setQuality(next, false);
  }

  /** 切换画质档。角色几何体是按档生成的，所以要整个重建视图。 */
  setQuality(level: QualityLevel, manual = true): void {
    if (level === this.renderer.quality.level) return;
    this.renderer.applyQuality(level);
    this.view.rebuild();
    if (this.world) this.view.buildLevel(this.world);
    this.syncOverlay();
    if (manual) {
      this.qualityLocked = true;
      storeQuality(level);
    }
  }

  get quality(): QualityLevel {
    return this.renderer.quality.level;
  }

  get qualityLabel(): string {
    return QUALITY[this.renderer.quality.level].label;
  }

  /**
   * 命中顿帧：重击的那一瞬间把模拟时间压慢一小段。
   * 研究结论很明确 —— 40~80ms 的微停顿比任何动画都更能卖出"打击感"。
   * 用减速而不是硬冻结，操作不会有"卡住了"的手感。
   */
  private hitstop = 0;

  private stepWorld(world: World, dt: number): void {
    this.input.tick(dt);
    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - dt);
      dt *= 0.22;
    }
    this.acc += dt;
    let steps = 0;
    const events: SimEvent[] = [];
    while (this.acc >= STEP && steps < MAX_STEPS) {
      world.steer = this.input.steerFor(world.squad.x);
      world.step(STEP);
      for (const e of world.drainEvents()) events.push(e);
      this.acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS) this.acc = 0;

    this.playAudio(events, world);
    this.view.update(world, dt, events);
    this.emitFloats();
    this.emitSquadBadge();
    this.hud.update(world);

    if (world.phase !== 'running' && !this.pendingResult) {
      this.pendingResult = { won: world.phase === 'won', levelId: world.level.id, goldBefore: world.gold };
      this.resultDelay = world.phase === 'won' ? 1.5 : 1.1;
      if (world.phase === 'won') this.audio.win();
      else this.audio.lose();
      this.input.setEnabled(false);
    }
    if (this.pendingResult) {
      this.resultDelay -= dt;
      if (this.resultDelay <= 0) {
        const r = this.pendingResult;
        this.pendingResult = null;
        this.finish(r.won, r.goldBefore);
      }
    }
  }

  /** 连续捡金币时音高一级级往上爬；隔太久就断掉重来。 */
  private coinStreak = 0;
  private coinStreakAt = 0;

  private playAudio(events: readonly SimEvent[], world: World): void {
    // 事件坐标 → 立体声位置。以方阵为中心，越靠边偏得越多。
    const pan = (x: number | undefined): number =>
      x === undefined ? 0 : Math.max(-1, Math.min(1, (x - world.squad.x) / ROAD_HALF)) * 0.75;

    for (const ev of events) {
      switch (ev.type) {
        case 'shot': this.audio.shot(world.squad.weaponLevel, pan(ev.x)); break;
        case 'cannonFire': this.audio.cannon(pan(ev.x)); break;
        case 'shellImpact': this.audio.explosion(pan(ev.x)); break;
        case 'blockHit': this.audio.blockHit(pan(ev.x)); break;
        case 'blockDestroyed': this.audio.blockBreak(pan(ev.x)); break;
        case 'kill': this.audio.zombieDie(pan(ev.x)); break;
        case 'soldierDown':
          this.audio.soldierDown(pan(ev.x));
          this.floats.damage();
          break;
        case 'goldPickup': {
          const t = world.stats.elapsed;
          this.coinStreak = t - this.coinStreakAt < 2.2 ? this.coinStreak + 1 : 0;
          this.coinStreakAt = t;
          this.audio.coinPickup(this.coinStreak, pan(ev.x));
          break;
        }
        case 'gate': this.audio.gate(ev.gate ? ev.gate.type !== 'sub' && ev.gate.type !== 'div' : true, pan(ev.x)); break;
        case 'bossSpawn':
        case 'bossPhase':
        case 'midbossSpawn': this.audio.bossRoar(pan(ev.x)); break;
        // 技能预警的蓄力声。之前这几个事件完全是哑的 —— 玩家只能靠眼睛
        // 看地上的圈，听觉上没有任何"要来了"的提示。
        case 'bossSlam': this.audio.telegraph(BOSS.slam.telegraph, 'slam', pan(ev.x)); break;
        case 'bossCharge': this.audio.telegraph(BOSS.charge.telegraph, 'charge', pan(ev.x)); break;
        case 'bossLightning': this.audio.telegraph(BOSS.lightning.telegraph, 'lightning', pan(ev.x)); break;
        // 三种新招各有各的蓄力声，闭着眼睛也能分出来是哪一招
        case 'bossQuake': this.audio.telegraph(1.25, 'shock', pan(ev.x)); break;
        case 'bossBreath': this.audio.telegraph(1.5, 'slam', pan(ev.x)); break;
        case 'bossBeam': this.audio.telegraph(1.35, 'lightning', pan(ev.x)); break;
        case 'bossQuakeHit':
        case 'bossBreathHit':
        case 'bossBeamHit': this.audio.explosion(pan(ev.x)); break;
        case 'bossSubmerge': this.audio.bossRoar(pan(ev.x)); break;
        case 'bossEmerge':
          this.audio.bossRoar(pan(ev.x));
          this.floats.flash('#e6d8ff');
          break;
        case 'midbossAbility': this.audio.telegraph(MIDBOSS.shock.telegraph, 'shock', pan(ev.x)); break;
        case 'bossSlamHit':
        case 'midbossAbilityHit': this.audio.explosion(pan(ev.x)); break;
        // 酸液抛射：飞行时长就是预警时长，听觉上和地上的圈同步
        case 'spitterFire': this.audio.telegraph(SPITTER.telegraph, 'shock', pan(ev.tx)); break;
        case 'bite': this.audio.bite(pan(ev.x)); break;
        case 'impaled': this.audio.bite(pan(ev.x)); break;
        case 'blockSmashed': this.audio.explosion(pan(ev.x)); break;
        case 'spitterHit': this.audio.acidSplash(pan(ev.x)); break;
        case 'bomberBlast': this.audio.explosion(pan(ev.x)); break;
        case 'leaperJump': this.audio.leap(pan(ev.x)); break;
        case 'leaperLand': this.audio.footstep(pan(ev.x)); break;
        case 'strikeCall': this.audio.strikeCall(); break;
        case 'strikeImpact':
          this.audio.explosion(pan(ev.x));
          // 第一发落地时全屏过曝一下
          if (ev.amount === 1) this.floats.flash('#ffd9a0');
          break;
        case 'bossLightningHit':
          this.audio.thunderCrack(pan(ev.x));
          this.floats.flash();
          break;
        default: break;
      }
    }

    // 重击顿帧。取最大值而不是累加，连续爆炸不会把游戏拖成慢动作。
    for (const ev of events) {
      switch (ev.type) {
        case 'bossSlamHit':
        case 'bossLightningHit': this.hitstop = Math.max(this.hitstop, 0.075); break;
        case 'blockDestroyed': this.hitstop = Math.max(this.hitstop, 0.06); break;
        // 空袭一局只有一两发，第一发落地那一下值得一次明显的时间冻结。
        // 只认第一发：十六发每发都冻一次，整轮就变成一段卡顿的慢动作。
        case 'strikeImpact':
          if (ev.amount === 1) this.hitstop = Math.max(this.hitstop, 0.11);
          break;
        case 'midbossAbilityHit': this.hitstop = Math.max(this.hitstop, 0.05); break;
        case 'bossQuakeHit':
        case 'bossBreathHit':
        case 'bossBeamHit': this.hitstop = Math.max(this.hitstop, 0.07); break;
        case 'bossEmerge': this.hitstop = Math.max(this.hitstop, 0.08); break;
        default: break;
      }
    }

    // 环境音床强度：贴身的敌人数 + Boss 在场时直接顶满
    const threat = Math.min(1, world.enemies.contactCount / 28);
    const bossOn = world.boss.enemy?.alive || world.midBoss.enemy?.alive ? 1 : 0;
    this.audio.setAmbience(Math.max(threat, bossOn * 0.85, 0.25), STEP);
  }

  /** 把 GameView 收集到的世界坐标飘字投影到屏幕上。 */
  private emitFloats(): void {
    for (const f of this.view.floats) {
      this.projVec.set(f.x, f.y, f.z);
      this.renderer.project(this.projVec, this.projOut);
      if (!this.projOut.visible) continue;
      this.floats.spawn(f.text, f.color, this.projOut.x, this.projOut.y, f.big ?? false);
    }
  }

  /** 把 GameView 算出的方阵溢出总数标签投影到屏幕上，交给 HUD 常驻显示。 */
  private emitSquadBadge(): void {
    const overflow = this.view.squadOverflow;
    if (!overflow) {
      this.hud.updateSquadBadge(null);
      return;
    }
    this.projVec.set(overflow.x, overflow.y, overflow.z);
    this.renderer.project(this.projVec, this.projOut);
    this.hud.updateSquadBadge({
      x: this.projOut.x,
      y: this.projOut.y,
      visible: this.projOut.visible,
      total: overflow.total,
    });
  }
}
