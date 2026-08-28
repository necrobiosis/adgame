import {
  ADVANCE_SPEED,
  AIRSTRIKE,
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
import { applyGate, deniedResult } from './Gates';
import { rollChoice } from './GateRoll';
import { MidBossController } from './MidBoss';
import { Squad } from './Squad';
import { laneAtX, laneBounds, sideAtX } from './lanes';
import type { BlockObstacle, GateGroup, GoldPickup, Phase, SimEvent } from './types';

/** 门本身的纵深（两片墙之间）。 */
const GATE_DEPTH = 5;
/** 遇到全宽方块时方阵停在它前面多远。 */
/** 距离 Boss 竞技场多远触发 Boss。 */
const BOSS_TRIGGER_AHEAD = 46;
/** 无尽模式：进度条每这么多米走满一格（纯视觉分段）。 */
const ENDLESS_RAMP = 220;
/** 无尽模式：血量缩放的距离基准。越大爬得越慢。 */
const ENDLESS_HP_RAMP = 500;

export interface RunOptions {
  levelId: number;
  upgrades: Readonly<Record<UpgradeId, number>>;
  /**
   * 这一局实际带上场的模块。
   *
   * 商店里买到的是"拥有"，这里列的才是"生效"。不传就当全部生效——
   * 测试和老存档走这条路，行为和加装备位之前完全一致。
   */
  loadout?: readonly UpgradeId[];
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

  /** 空袭充能 0..1。满了才能呼叫。 */
  strikeCharge = 0;
  /** 已呼叫、还在飞行途中的炸弹。 */
  private pendingBombs: { t: number; x: number; z: number }[] = [];
  /** 当前正在啃的那堵半宽墙，以及已经啃了多久（用于超时放弃）。 */

  private readonly rng: Rng;
  private readonly events: SimEvent[] = [];
  private pendingWaves: { wave: WaveSpec; z: number }[] = [];
  /** 已触发、正在按节拍往外吐的尸潮涌现。 */
  private surges: { wave: WaveSpec; left: number; interval: number; timer: number }[] = [];
  private pendingSurges: { z: number; seconds: number; pulses: number; wave: WaveSpec }[] = [];
  /**
   * 待触发的中 Boss。
   * 以前是单个槽位，多写几个 midboss beat 只有最后一个生效——无尽模式要靠
   * 一轮比一轮硬的中 Boss 撑起节奏，必须能同时排队。
   */
  private pendingMidBosses: { hp: number; scale: number; name: string; z: number }[] = [];
  /** 出征模块换算出来的四个局内系数（见构造函数）。 */
  private readonly advanceMul: number;
  private readonly goldMul: number;
  private readonly strikeChargeMul: number;
  private readonly strikeRadiusMul: number;

  /** 倒刺攒下的不满一人的伤亡零头。 */
  private spikeDebt = 0;

  private bossTriggered = false;
  private bossArenaTargetZ = 0;
  private nextId = 1;

  constructor(opts: RunOptions) {
    this.level = getLevel(opts.levelId);
    this.rng = new Rng(opts.seed ?? 0x51ed5eed);
    this.enemies = new EnemyPool(this.rng);
    this.boss = new BossController(this.rng);
    this.midBoss = new MidBossController();

    // 只有带上场的模块算数。'slots' 是元升级，永远不进这个表。
    const equipped = opts.loadout
      ? new Set(opts.loadout.filter((id) => id !== 'slots'))
      : null;
    const up0 = opts.upgrades;
    /** 某个模块这一局的实际等级：没带上场就是 0。 */
    const lv = (id: Exclude<UpgradeId, 'slots'>): number =>
      (equipped && !equipped.has(id) ? 0 : (up0[id] ?? 0));

    const E = UPGRADE_EFFECT;
    // 专精模块的代价在这里一次性结算：正面加在自己的轴上，负面乘在别人的轴上。
    // 兵力不能被减到 1 以下——"带了三级重炮结果开局没人"不是取舍，是 bug。
    const soldierPenalty = Math.max(0.3, 1 - lv('heavyGuns') * E.heavyGunsSoldierPenalty);
    const soldiers = Math.max(
      3,
      Math.round(
        (START.soldiers + lv('squad') * E.squadPerLevel + lv('horde') * E.hordeSoldiers) * soldierPenalty,
      ),
    );
    const damageMul = (1 + lv('damage') * E.damagePerLevel)
      * Math.max(0.4, 1 - lv('horde') * E.hordeDamagePenalty);
    const hpMul = (1 + lv('armor') * E.armorPerLevel)
      * Math.max(0.4, 1 - lv('vanguard') * E.vanguardHpPenalty);

    this.advanceMul = 1 + lv('vanguard') * E.vanguardSpeed;
    this.goldMul = 1 + lv('scavenger') * E.scavengerGold;
    this.strikeChargeMul = 1 + lv('strikeSpec') * E.strikeCharge;
    this.strikeRadiusMul = 1 + lv('strikeSpec') * E.strikeRadius;

    this.squad = new Squad({
      soldiers,
      cannons: START.cannons + lv('cannon') + lv('heavyGuns') * E.heavyGunsCannon,
      weaponLevel: START.weaponLevel + lv('weapon'),
      damageMul,
      fireRateMul: 1 + lv('fireRate') * E.fireRatePerLevel,
      hpMul,
    }, this.rng);

    this.buildTrack();
    // 开局就把 Boss 摆到远处：整关都看得见它在雾里慢慢走过来
    const bossBeat = this.level.beats.find((b) => b.t === 'boss');
    if (!this.level.endless && bossBeat && bossBeat.t === 'boss') {
      this.boss.preview(
        this.enemies, bossBeat.kind, bossBeat.scale, bossBeat.name,
        Math.min(this.arenaZ, this.squad.z + BOSS.previewAhead),
      );
    }
    this.squad.layout();
    this.stats.peakSoldiers = this.squad.soldierCount;
  }

  /** 把关卡的 beats 铺成绝对 z 坐标。 */
  private buildTrack(): void {
    let z = 0;
    const totalChoices = this.level.beats.filter((b) => b.t === 'choice').length;
    let choiceIndex = 0;
    let sinceBodies = 0;
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
        case 'choice': {
          // 没写死 left/right 的岔路每局现掷 —— roguelike 的随机性在这里产生。
          // 定价参考"走到这个门时手里大概有多少钱"：太贵是死路，太便宜没取舍。
          // 无尽模式的关卡号是 99，直接喂给掷门器会把强度算成 99 级——
          // 波次规模和标价全部爆掉。改成按"第几个岔路"折算出一个虚拟关卡等级。
          // 同样封顶：不封的话第 80 个岔路会按 32 级去掷，一波就是上千只怪
          const rollLevel = this.level.endless
            ? 1 + Math.min(choiceIndex, 18) * 0.4
            : this.level.id;
          const rolled = beat.left && beat.right
            ? { left: beat.left, right: beat.right }
            : rollChoice(
                this.rng,
                { levelId: rollLevel, index: choiceIndex, total: totalChoices, sinceBodies },
                // 实测的金币曲线：第三关三个门依次约 170 / 580 / 1500。
                // 定价必须贴着它走，标高了就是一条永远走不了的死路。
                110 * rollLevel * (0.5 + choiceIndex),
              );
          choiceIndex++;
          const gaveBodies = [rolled.left, rolled.right].some(
            (l) => l.gate.type === 'add' || l.gate.type === 'mul',
          );
          sinceBodies = gaveBodies ? 0 : sinceBodies + 1;
          this.gates.push({ id: this.nextId++, z, left: rolled.left, right: rolled.right, taken: false, chosen: null });
          z += GATE_DEPTH;
          break;
        }
        case 'wave':
          this.pendingWaves.push({ wave: beat.wave, z });
          break;
        case 'surge':
          // 和 'wave' 一样只登记触发点，不占赛道长度
          this.pendingSurges.push({ z, seconds: beat.seconds, pulses: beat.pulses, wave: beat.wave });
          break;
        case 'block': {
          // 墙永远只占三排里的一排。没有全宽墙——挡死整条路的墙不构成选择，
          // 只是一段强制的等待。走到它那一排上才打得到、才拿得到奖励。
          const [x0, x1] = laneBounds(beat.lane);
          this.blocks.push({
            id: this.nextId++,
            z,
            lane: beat.lane,
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
          this.pendingMidBosses.push({ hp: beat.hp, scale: beat.scale, name: beat.name, z });
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

  /** 无尽模式已经推进了多少米（成绩就是这个）。 */
  get distance(): number {
    return Math.max(0, this.squad.z);
  }

  get progress(): number {
    // 无尽模式没有终点：进度条改成一段一段循环填充，读起来像"又推进了一波"
    if (this.level.endless) return (this.squad.z % ENDLESS_RAMP) / ENDLESS_RAMP;
    // Boss 一出场就把进度条推满，剩下的战斗用 Boss 血条表达
    if (this.bossTriggered) return 1;
    const goal = this.bossArenaTargetZ > 0 ? this.bossArenaTargetZ - BOSS_TRIGGER_AHEAD : this.totalLength;
    return Math.max(0, Math.min(1, this.squad.z / Math.max(1, goal)));
  }

  /**
   * 挡在方阵和尸潮之间的那堵墙。僵尸必须从两侧路肩绕过来，
   * 不能直接穿过去。
   */
  /**
   * 挡住僵尸去路的那堵墙。
   *
   * 墙对尸潮也是墙：它那一排的怪必须从两边绕过来。打穿它等于替自己开了一条
   * 路，不打就等于用一堵墙把那一排的怪拦在外面——两边都说得通，所以两个
   * 选择都成立。
   */
  get barrier(): BlockObstacle | null {
    const b = this.activeBlock;
    return b && b.alive && b.z > this.squad.z - 2 ? b : null;
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
    // 墙不再把方阵推开，也不再需要"主动顶上去"的判定：墙只占一排，
    // 你走进那一排就是在打它，走别的排就是放弃它。位置本身就是意图。
    this.squad.x = x;

    // ── 撞墙：拿命填，不减速 ────────────────────────────────
    // 墙正面焊满倒刺。走到它那一排上又没能在撞上之前打穿，前排就直接被串死，
    // 方阵不减速地撞穿过去——墙碎了，但这条路是拿人命换的，也拿不到奖励。
    // 以前是"速度降到 16% 一点点蹭过去"，干等 + 整队人从墙里穿模，两样最差的
    // 手感全占了。
    const blk = this.activeBlock;
    if (blk && blk.alive && laneAtX(this.squad.x) === blk.lane
        && this.squad.z > blk.z - BLOCK.spikes.reach) {
      this.impale(dt, blk, out);
      if (this.squad.z >= blk.z + 0.6) {
        blk.alive = false;
        blk.flash = 0.2;
        out.push({ type: 'blockSmashed', x: (blk.x0 + blk.x1) / 2, y: 1.6, z: blk.z });
      }
    }

    const advanceFactor = 1;
    let canAdvance = true;
    if (this.bossTriggered && this.squad.z >= this.bossArenaTargetZ) canAdvance = false;
    if (canAdvance) {
      // 压在接触面上的僵尸会把方阵顶住 —— 尸潮本身就是一堵会推回来的墙
      const drag = Math.max(
        MELEE.minAdvanceFactor,
        1 / (1 + this.enemies.contactCount * MELEE.advanceDrag),
      );
      this.squad.z += ADVANCE_SPEED * this.advanceMul * drag * advanceFactor * dt;
      if (this.bossTriggered) this.squad.z = Math.min(this.squad.z, this.bossArenaTargetZ);
    }
    this.squad.layout();

    // ── 触发器 ──────────────────────────────────────────────
    this.checkGates(prevZ, out);
    this.collectPickups(out);
    this.firePendingWaves();
    this.updateSurges(dt);
    for (let i = this.pendingMidBosses.length - 1; i >= 0; i--) {
      const spec = this.pendingMidBosses[i]!;
      if (this.squad.z < spec.z) continue;
      this.pendingMidBosses.splice(i, 1);
      this.enemies.hpScale = this.currentHpScale();
      const mx = clamp(this.squad.x + this.rng.range(-4, 4), -ROAD_HALF + 1.5, ROAD_HALF - 1.5);
      this.midBoss.spawn(this.enemies, mx, this.squad.z + 60, spec.hp, spec.scale, spec.name, out);
    }
    // 无尽模式没有 boss beat，arenaZ 会停在 0——不挡住的话开局第一帧就会
    // "触发 Boss"：进度条瞬间满、bossArenaTargetZ 变成负数，方阵直接被钉死
    if (!this.level.endless && !this.bossTriggered && this.squad.z >= this.arenaZ - BOSS_TRIGGER_AHEAD) {
      this.bossTriggered = true;
      this.enemies.hpScale = this.level.enemyHpScale;
      const beat = this.level.beats.find((b) => b.t === 'boss');
      if (beat && beat.t === 'boss') {
        // 远处那只黑影直接接管，不再重新生成一只——模型不会闪一下再出现
        if (this.boss.previewing) this.boss.awaken(this.arenaZ, beat.hp, out);
        else this.boss.spawn(this.enemies, this.arenaZ, beat.hp, beat.scale, beat.name, beat.kind, out);
      }
    }

    // 预览态的 Boss：一直吊在方阵正前方那么远的地方慢慢走，直到竞技场为止。
    // 到了竞技场它就停在那儿不动，剩下的距离由玩家自己冲——那一段路它会在
    // 屏幕上飞快涨大，"越走越近越大"就是这样来的。
    const pv = this.boss.previewing ? this.boss.enemy : null;
    if (pv) {
      pv.x = 0;
      // min 而不是 max：竞技场在几百米开外，取 max 的话它会一直钉在终点，
      // 整关都糊在雾里看不见。取 min = 一路吊在方阵前方 168 米，
      // 直到方阵逼近竞技场，它才停在那儿等你冲上来。
      pv.z = Math.min(this.arenaZ, this.squad.z + BOSS.previewAhead);
    }

    // ── 战斗 ────────────────────────────────────────────────
    this.enemies.damageScale = this.currentDamageScale();
    this.boss.update(dt, this.squad, this.enemies, out);
    this.midBoss.update(dt, this.squad, out);
    const gold = this.combat.update(dt, this.squad, this.enemies, this.activeBlock, out);
    this.enemies.update(dt, this.squad, this.barrier, out);

    for (const ev of out) {
      if (ev.type !== 'kill') continue;
      this.stats.kills++;
      // 打得越凶技能来得越快，鼓励主动接战而不是龟着等冷却
      if (this.strikeCharge < 1) {
        this.strikeCharge = Math.min(1, this.strikeCharge + this.strikeChargeMul * AIRSTRIKE.chargePerKill / AIRSTRIKE.chargeSeconds);
      }
    }
    // 拾荒专精只影响局内进账，不影响关卡结算奖励——否则它会变成
    // "反正最后都能赚回来"的无脑必带
    const earned = Math.round(gold * this.goldMul);
    this.gold += earned;
    this.stats.goldEarned += earned;
    this.stats.peakSoldiers = Math.max(this.stats.peakSoldiers, this.squad.soldierCount);

    // ── 空袭 ────────────────────────────────────────────────
    if (this.strikeCharge < 1) {
      this.strikeCharge = Math.min(1, this.strikeCharge + this.strikeChargeMul * dt / AIRSTRIKE.chargeSeconds);
    }
    this.updateBombs(dt, out);

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
   * 被墙上的倒刺串死。
   *
   * 按兵力比例算每秒死多少人，再压一个上限——比例保证小队伍撞墙是重伤、
   * 大队伍也不是白撞，上限保证满编方阵不会一头撞没。攒不满一个人的部分
   * 记在 spikeDebt 里，低帧率下不会因为取整而白赚。
   */
  private impale(dt: number, blk: BlockObstacle, out: SimEvent[]): void {
    const S = BLOCK.spikes;
    this.spikeDebt += Math.min(S.maxRate, this.squad.aliveCount * S.rateShare) * dt;
    while (this.spikeDebt >= 1) {
      this.spikeDebt -= 1;
      const u = this.squad.pickFrontTarget(this.rng.next());
      if (!u) break;
      u.alive = false;
      this.squad.markDirty();
      out.push({ type: 'impaled', x: u.x, y: 1.1, z: blk.z - 0.9 });
    }
  }

  /**
   * 呼叫空袭。充能没满就什么都不做（返回 false，让 UI 能给出反馈）。
   * 落点锚在呼叫瞬间方阵的横向位置——所以"瞄准"就是走位本身。
   */
  callAirstrike(): boolean {
    if (this.strikeCharge < 1 || this.phase !== 'running') return false;
    this.strikeCharge = 0;
    const cx = this.squad.x;
    const cz = this.squad.z + AIRSTRIKE.ahead;
    for (let i = 0; i < AIRSTRIKE.bombs; i++) {
      const t = AIRSTRIKE.bombs > 1 ? i / (AIRSTRIKE.bombs - 1) : 0.5;
      this.pendingBombs.push({
        // 沿纵深一路铺过去，读起来像一串炸弹连着炸，而不是一发大的
        t: AIRSTRIKE.delay + t * 0.55,
        x: clamp(cx + this.rng.range(-AIRSTRIKE.spreadX, AIRSTRIKE.spreadX), -ROAD_HALF, ROAD_HALF),
        z: cz + (t - 0.5) * AIRSTRIKE.spreadZ + this.rng.range(-2, 2),
      });
    }
    this.events.push({ type: 'strikeCall', x: cx, y: 0, z: cz });
    return true;
  }

  private updateBombs(dt: number, out: SimEvent[]): void {
    if (this.pendingBombs.length === 0) return;
    const radius = AIRSTRIKE.radius * this.strikeRadiusMul;
    const r2 = radius * radius;
    for (let i = this.pendingBombs.length - 1; i >= 0; i--) {
      const b = this.pendingBombs[i]!;
      b.t -= dt;
      if (b.t > 0) continue;
      this.pendingBombs.splice(i, 1);
      let gold = 0;
      for (const e of this.enemies.list) {
        if (!e.alive) continue;
        const dx = e.x - b.x;
        const dz = e.z - b.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const falloff = 1 - (1 - AIRSTRIKE.splashEdge) * Math.sqrt(d2 / r2);
        // 算溅射伤害，所以重甲的子弹减免挡不住空袭
        gold += this.enemies.damage(e, AIRSTRIKE.damage * falloff, out, true);
      }
      this.gold += Math.round(gold * this.goldMul);
      this.stats.goldEarned += gold;
      out.push({ type: 'strikeImpact', x: b.x, y: 0.3, z: b.z, radius });
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
      this.gold += Math.round(p.amount * this.goldMul);
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
        // 标价车道：钱不够就照常过去，但吃不到增益
        const cost = lane.gate.cost ?? 0;
        let res;
        if (cost > 0 && this.gold < cost) {
          res = deniedResult(cost);
        } else {
          if (cost > 0) this.gold -= cost;
          res = applyGate(this.squad, lane.gate);
        }
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
  /**
   * 当前刷出来的怪吃多少血量倍率。
   *
   * 战役关是"从 1 涨到本关上限"的一条封顶曲线；无尽模式没有上限——
   * 每往前推进 ENDLESS_RAMP 米就再乘一档，越往后越硬，直到你顶不住为止。
   */
  /** 无尽模式：敌人伤害随距离爬升。比血量爬得慢，因为伤害致命得多。 */
  private currentDamageScale(): number {
    if (!this.level.endless) return 1;
    // 爬得必须够陡：方阵收窄到 5 列之后，同一时刻只有 6 只怪够得着前排，
    // 而岔路又在源源不断地补员——伤害爬慢一点，满配方阵就是杀不死的，
    // "无尽"会变成"无聊地一直走"。
    return 1 + Math.pow(Math.max(0, this.squad.z) / ENDLESS_HP_RAMP, 1.15) * 1.7;
  }

  private currentHpScale(): number {
    if (this.level.endless) {
      return 1 + Math.pow(Math.max(0, this.squad.z) / ENDLESS_HP_RAMP, 1.15) * this.level.enemyHpScale;
    }
    const t = Math.pow(Math.max(0, Math.min(1, this.squad.z / Math.max(1, this.arenaZ))), 0.85);
    return 1 + (this.level.enemyHpScale - 1) * t;
  }

  /**
   * 尸潮涌现：到达触发点后，把整波拆成 `pulses` 份，在 `seconds` 秒里
   * 一份一份地放出来。每一份都按当前进度重算血量缩放，所以越往后涌出来的
   * 越硬——尸潮是"越来越顶不住"，而不是一次性一堵墙。
   */
  private updateSurges(dt: number): void {
    for (let i = this.pendingSurges.length - 1; i >= 0; i--) {
      const p = this.pendingSurges[i]!;
      if (this.squad.z < p.z) continue;
      this.pendingSurges.splice(i, 1);
      this.surges.push({
        wave: p.wave,
        left: p.pulses,
        interval: p.seconds / Math.max(1, p.pulses),
        timer: 0,
      });
    }
    for (let i = this.surges.length - 1; i >= 0; i--) {
      const s = this.surges[i]!;
      s.timer -= dt;
      if (s.timer > 0) continue;
      s.timer = s.interval;
      s.left--;
      this.enemies.hpScale = this.currentHpScale();
      // 每一拨往前推一点点距离，读起来像"后面还有一层正在压上来"
      this.enemies.spawnWave(s.wave, this.squad.z, this.squad.x);
      if (s.left <= 0) this.surges.splice(i, 1);
    }
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
