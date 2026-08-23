import {
  ADVANCE_SPEED,
  BLOCK,
  BOSS,
  GOLD_PICKUP,
  MELEE,
  ROAD_HALF,
  STRAFE_SPEED,
  UPGRADE_EFFECT,
  START,
  type UpgradeId,
} from '../config/balance';
import { getLevel, type Beat, type LevelDef, type WaveSpec } from '../config/levels';
import { Rng } from '../core/Rng';
import { BossController } from './Boss';
import { Combat } from './Combat';
import { EnemyPool } from './Enemies';
import { applyGate } from './Gates';
import { MidBossController } from './MidBoss';
import { Squad } from './Squad';
import { LANE_SIGN, sideAtX } from './lanes';
import type { BlockObstacle, GateGroup, GoldPickup, Phase, SimEvent } from './types';

/** 门本身的纵深（两片墙之间）。 */
const GATE_DEPTH = 5;
/** 遇到全宽方块时方阵停在它前面多远。 */
const BLOCK_STOP_GAP = 5.5;
/** 距离 Boss 竞技场多远触发 Boss。 */
const BOSS_TRIGGER_AHEAD = 46;

export interface RunOptions {
  levelId: number;
  upgrades: Readonly<Record<UpgradeId, number>>;
  seed?: number;
}

export interface RunStats {
  kills: number;
  goldEarned: number;
  peakSoldiers: number;
  gatesTaken: number;
  elapsed: number;
}

/**
 * 一整局的模拟：赛道、方阵推进、门、方块、尸潮、Boss。
 * 这一层完全不依赖 three.js，可以脱离浏览器单测。
 */
export class World {
  readonly level: LevelDef;
  readonly squad: Squad;
  readonly enemies: EnemyPool;
  readonly combat = new Combat();
  readonly boss: BossController;
  readonly midBoss: MidBossController;

  readonly gates: GateGroup[] = [];
  readonly blocks: BlockObstacle[] = [];
  readonly pickups: GoldPickup[] = [];

  /** 赛道总长（进度条用）。 */
  totalLength = 0;
  /** Boss 竞技场所在 z。 */
  arenaZ = 0;

  phase: Phase = 'running';
  gold = 0;
  stats: RunStats = { kills: 0, goldEarned: 0, peakSoldiers: 0, gatesTaken: 0, elapsed: 0 };

  /** 玩家横向输入意图 [-1, 1]。 */
  steer = 0;

  /**
   * 这一帧玩家是否主动顶在半宽墙上要打穿它。
   * 渲染层/战斗层都要看它：撞墙时方阵停下来啃，不撞就自动绕开。
   */
  ramming = false;
  /** 当前正在啃的那堵半宽墙，以及已经啃了多久（用于超时放弃）。 */
  private ramBlockId = -1;
  private ramTime = 0;

  private readonly rng: Rng;
  private readonly events: SimEvent[] = [];
  private pendingWaves: { wave: WaveSpec; z: number }[] = [];
  private pendingMidBoss: { hp: number; scale: number; name: string; z: number } | null = null;
  private bossTriggered = false;
  private bossArenaTargetZ = 0;
  private nextId = 1;

  constructor(opts: RunOptions) {
    this.level = getLevel(opts.levelId);
    this.rng = new Rng(opts.seed ?? 0x51ed5eed);
    this.enemies = new EnemyPool(this.rng);
    this.boss = new BossController(this.rng);
    this.midBoss = new MidBossController();

    const up = opts.upgrades;
    this.squad = new Squad({
      soldiers: START.soldiers + (up.squad ?? 0) * UPGRADE_EFFECT.squadPerLevel,
      cannons: START.cannons + (up.cannon ?? 0),
      weaponLevel: START.weaponLevel + (up.weapon ?? 0),
      damageMul: 1 + (up.damage ?? 0) * UPGRADE_EFFECT.damagePerLevel,
      fireRateMul: 1 + (up.fireRate ?? 0) * UPGRADE_EFFECT.fireRatePerLevel,
      hpMul: 1 + (up.armor ?? 0) * UPGRADE_EFFECT.armorPerLevel,
    }, this.rng);

    this.buildTrack();
    this.squad.layout();
    this.stats.peakSoldiers = this.squad.soldierCount;
  }

  /** 把关卡的 beats 铺成绝对 z 坐标。 */
  private buildTrack(): void {
    let z = 0;
    for (const beat of this.level.beats as readonly Beat[]) {
      switch (beat.t) {
        case 'run': {
          // 路上撒几枚金币——每隔一段距离一枚，横向位置随机偏向路肩，
          // 读起来像散落的战利品而不是精心摆放的一排
          let localZ = GOLD_PICKUP.spacing * (0.5 + this.rng.next() * 0.5);
          while (localZ < beat.len - 4) {
            const side = this.rng.next() < 0.5 ? -1 : 1;
            this.pickups.push({
              id: this.nextId++,
              x: side * this.rng.range(5.6, ROAD_HALF - 0.8),
              z: z + localZ,
              amount: Math.round(this.rng.range(GOLD_PICKUP.amountMin, GOLD_PICKUP.amountMax)),
              alive: true,
            });
            localZ += GOLD_PICKUP.spacing * (0.7 + this.rng.next() * 0.6);
          }
          z += beat.len;
          break;
        }
        case 'choice':
          this.gates.push({ id: this.nextId++, z, left: beat.left, right: beat.right, taken: false, chosen: null });
          z += GATE_DEPTH;
          break;
        case 'wave':
          this.pendingWaves.push({ wave: beat.wave, z });
          break;
        case 'block': {
          // span 说的是玩家看到的哪半边路，换算成世界 x
          const [x0, x1] =
            beat.span === 'full'
              ? [-BLOCK.fullSpanHalfWidth, BLOCK.fullSpanHalfWidth]
              : LANE_SIGN[beat.span] > 0
                ? [0, ROAD_HALF]
                : [-ROAD_HALF, 0];
          this.blocks.push({
            id: this.nextId++,
            z,
            span: beat.span,
            hp: beat.hp,
            maxHp: beat.hp,
            alive: true,
            flash: 0,
            x0,
            x1,
            bonus: beat.bonus ?? 0,
            tall: beat.tall ?? false,
          });
          z += 12;
          break;
        }
        case 'midboss':
          // 和 'wave' 一样只登记一个触发点，不占用赛道长度——中 boss
          // 不halt 方阵，没有竞技场
          this.pendingMidBoss = { hp: beat.hp, scale: beat.scale, name: beat.name, z };
          break;
        case 'boss':
          this.arenaZ = z + 24;
          z = this.arenaZ;
          break;
      }
    }
    this.totalLength = Math.max(1, z);
    this.bossArenaTargetZ = this.arenaZ - BOSS.standoff - 6;
  }

  get progress(): number {
    // Boss 一出场就把进度条推满，剩下的战斗用 Boss 血条表达
    if (this.bossTriggered) return 1;
    const goal = this.bossArenaTargetZ > 0 ? this.bossArenaTargetZ - BOSS_TRIGGER_AHEAD : this.totalLength;
    return Math.max(0, Math.min(1, this.squad.z / Math.max(1, goal)));
  }

  /**
   * 挡在方阵和尸潮之间的那堵墙。僵尸必须从两侧路肩绕过来，
   * 不能直接穿过去。
   */
  get barrier(): BlockObstacle | null {
    const b = this.activeBlock;
    return b && b.alive && b.span === 'full' && b.z > this.squad.z - 2 ? b : null;
  }

  /** 当前挡在前面的方块（渲染层与战斗层共用）。 */
  get activeBlock(): BlockObstacle | null {
    let best: BlockObstacle | null = null;
    for (const b of this.blocks) {
      if (!b.alive) continue;
      if (b.z < this.squad.z - 4) continue;
      if (!best || b.z < best.z) best = b;
    }
    return best;
  }

  drainEvents(): SimEvent[] {
    const copy = this.events.slice();
    this.events.length = 0;
    return copy;
  }

  step(dt: number): void {
    if (this.phase !== 'running') return;
    this.stats.elapsed += dt;
    const out = this.events;
    const prevZ = this.squad.z;

    // ── 横向移动 ────────────────────────────────────────────
    const margin = Math.min(ROAD_HALF - 0.6, this.squad.halfWidth + 0.4);
    let x = this.squad.x + this.steer * STRAFE_SPEED * dt;
    x = clamp(x, -(ROAD_HALF - margin), ROAD_HALF - margin);
    // 半宽方块：玩家自己不往墙上顶就自动让开，主动顶上去就啃它。
    //
    // 以前这里是**无条件**把方阵推到另一侧的，于是"打穿高墙拿奖励 / 也可以
    // 绕过去"根本不是选择——绕开是强制的，打穿只是接近过程中 DPS 恰好够不够
    // 的被动结果。现在由玩家的操舵意图决定：顶上去就停下来啃，代价是这段时间
    // 尸潮持续逼近、接触数上涨、推进阻力变大，时间本身就是成本。
    const blk = this.activeBlock;
    this.ramming = false;
    if (blk && blk.alive && blk.span !== 'full' && Math.abs(blk.z - this.squad.z) < 7) {
      const gap = this.squad.halfWidth * 0.7 + 0.6;
      const wallOnMinusX = blk.x0 <= -ROAD_HALF + 0.01;
      // 玩家正在往墙的方向推杆 = 主动选择撞穿
      if (blk.id !== this.ramBlockId) {
        this.ramBlockId = blk.id;
        this.ramTime = 0;
      }
      const gaveUp = this.ramTime >= BLOCK.ramTimeout;
      const intent = !gaveUp && (wallOnMinusX ? this.steer < -0.15 : this.steer > 0.15);
      if (intent) {
        this.ramTime += dt;
        this.ramming = true;
        // 顶到墙面前贴住，不穿模
        x = wallOnMinusX
          ? Math.max(x, blk.x1 - this.squad.halfWidth * 0.5)
          : Math.min(x, blk.x0 + this.squad.halfWidth * 0.5);
      } else {
        if (wallOnMinusX) x = Math.max(x, blk.x1 + gap);
        else x = Math.min(x, blk.x0 - gap);
      }
      x = clamp(x, -(ROAD_HALF - margin), ROAD_HALF - margin);
    }
    this.squad.x = x;

    // ── 前进 ────────────────────────────────────────────────
    let canAdvance = true;
    if (blk && blk.span === 'full' && this.squad.z >= blk.z - BLOCK_STOP_GAP) canAdvance = false;
    // 主动撞墙时和全宽方块一样停下来啃
    if (this.ramming && blk && this.squad.z >= blk.z - BLOCK_STOP_GAP) canAdvance = false;
    if (this.bossTriggered && this.squad.z >= this.bossArenaTargetZ) canAdvance = false;
    if (canAdvance) {
      // 压在接触面上的僵尸会把方阵顶住 —— 尸潮本身就是一堵会推回来的墙
      const drag = Math.max(
        MELEE.minAdvanceFactor,
        1 / (1 + this.enemies.contactCount * MELEE.advanceDrag),
      );
      this.squad.z += ADVANCE_SPEED * drag * dt;
      if (this.bossTriggered) this.squad.z = Math.min(this.squad.z, this.bossArenaTargetZ);
    }
    this.squad.layout();

    // ── 触发器 ──────────────────────────────────────────────
    this.checkGates(prevZ, out);
    this.collectPickups(out);
    this.firePendingWaves();
    if (this.pendingMidBoss && this.squad.z >= this.pendingMidBoss.z) {
      const spec = this.pendingMidBoss;
      this.pendingMidBoss = null;
      this.enemies.hpScale = this.currentHpScale();
      const mx = clamp(this.squad.x + this.rng.range(-4, 4), -ROAD_HALF + 1.5, ROAD_HALF - 1.5);
      this.midBoss.spawn(this.enemies, mx, this.squad.z + 60, spec.hp, spec.scale, spec.name, out);
    }
    if (!this.bossTriggered && this.squad.z >= this.arenaZ - BOSS_TRIGGER_AHEAD) {
      this.bossTriggered = true;
      this.enemies.hpScale = this.level.enemyHpScale;
      const beat = this.level.beats.find((b) => b.t === 'boss');
      if (beat && beat.t === 'boss') {
        this.boss.spawn(this.enemies, this.arenaZ, beat.hp, beat.scale, beat.name, out);
      }
    }

    // ── 战斗 ────────────────────────────────────────────────
    this.boss.update(dt, this.squad, this.enemies, out);
    this.midBoss.update(dt, this.squad, out);
    const gold = this.combat.update(dt, this.squad, this.enemies, this.activeBlock, this.ramming, out);
    this.enemies.update(dt, this.squad, this.barrier, out);

    for (const ev of out) if (ev.type === 'kill') this.stats.kills++;
    this.gold += gold;
    this.stats.goldEarned += gold;
    this.stats.peakSoldiers = Math.max(this.stats.peakSoldiers, this.squad.soldierCount);

    for (const b of this.blocks) if (b.flash > 0) b.flash = Math.max(0, b.flash - dt);

    // ── 胜负 ────────────────────────────────────────────────
    if (this.squad.aliveCount <= 0) {
      this.phase = 'lost';
      out.push({ type: 'lose' });
    } else if (this.bossTriggered && this.boss.enemy && !this.boss.enemy.alive) {
      this.phase = 'won';
      this.gold += this.level.clearGold;
      this.stats.goldEarned += this.level.clearGold;
      out.push({ type: 'win', amount: this.level.clearGold });
    }
  }

  /**
   * 路边的金币堆：方阵**开过去**才收得到，不是走到那条横线就自动入袋。
   *
   * 横向判定是这套东西的意义所在——金币撒在两侧，去捡就得离开当前车道，
   * 于是"要不要为这堆钱冒险"变成一个真的选择，而不是白送。
   * 已经错过（方阵尾巴都开过去了）的就直接作废，不会一直挂着。
   */
  private collectPickups(out: SimEvent[]): void {
    const reach = Math.min(this.squad.halfWidth, GOLD_PICKUP.bodyReachCap) + GOLD_PICKUP.reach;
    for (const p of this.pickups) {
      if (!p.alive) continue;
      if (this.squad.z < p.z) continue;
      // 已经开过头的：错过了就是错过了
      if (this.squad.z - p.z > this.squad.depth + 2) {
        p.alive = false;
        continue;
      }
      if (Math.abs(p.x - this.squad.x) > reach) continue;
      p.alive = false;
      this.gold += p.amount;
      this.stats.goldEarned += p.amount;
      out.push({ type: 'goldPickup', x: p.x, y: 0.6, z: p.z, amount: p.amount });
    }
  }

  private checkGates(prevZ: number, out: SimEvent[]): void {
    for (const g of this.gates) {
      if (g.taken) continue;
      if (prevZ < g.z && this.squad.z >= g.z) {
        const side = sideAtX(this.squad.x);
        const lane = side === 'left' ? g.left : g.right;
        g.taken = true;
        g.chosen = side;
        this.stats.gatesTaken++;
        const res = applyGate(this.squad, lane.gate);
        this.gold += res.gold;
        this.stats.goldEarned += res.gold;
        this.squad.layout();
        out.push({ type: 'gate', side, gate: lane.gate, text: res.text, x: this.squad.x, z: g.z });
        // 选了哪条车道，就迎接哪种怪
        this.pendingWaves.push({ wave: lane.wave, z: this.squad.z });
      }
    }
  }

  /**
   * 敌人强度在关卡内部随进度爬升，而不是整关一个固定倍率。
   * 这样每关开局都能用 12 个起始士兵打得动，越往后越硬 —— 难度曲线和
   * 玩家自己的滚雪球速度对齐。
   */
  private currentHpScale(): number {
    const t = Math.pow(Math.max(0, Math.min(1, this.squad.z / Math.max(1, this.arenaZ))), 0.85);
    return 1 + (this.level.enemyHpScale - 1) * t;
  }

  private firePendingWaves(): void {
    if (this.pendingWaves.length === 0) return;
    const remain: { wave: WaveSpec; z: number }[] = [];
    for (const p of this.pendingWaves) {
      if (this.squad.z >= p.z) {
        this.enemies.hpScale = this.currentHpScale();
        this.enemies.spawnWave(p.wave, this.squad.z, this.squad.x);
      } else {
        remain.push(p);
      }
    }
    this.pendingWaves = remain;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
