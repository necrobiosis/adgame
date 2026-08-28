import { BOSS, BOSS_PLANS, ENEMY_STATS, ROAD_HALF, type BossAbility, type BossKind } from '../config/balance';
import type { Rng } from '../core/Rng';
import type { EnemyPool } from './Enemies';
import type { Squad } from './Squad';
import type { Enemy, SimEvent } from './types';

type BossState =
  | 'preview'       // 开局就站在远处慢慢走过来的那只，纯观感，不打人也打不动
  | 'approach'
  | 'idle'
  | 'cast'          // 通用：正在读条（预警亮着），到点结算
  | 'recover'
  | 'chargeTelegraph'
  | 'charging'
  | 'chargeReturn'
  | 'submerged';

export type TelegraphKind = 'slam' | 'charge' | 'lightning' | 'quake' | 'breath' | 'beam';

export interface Telegraph {
  x: number;
  z: number;
  radius: number;
  /** 已经过的时间 / 总时长，1 = 落地。 */
  t: number;
  dur: number;
  kind: TelegraphKind;
  /** 矩形类（quake / breath）覆盖的 x 区间。 */
  x0?: number;
  x1?: number;
  /** 矩形类覆盖的 z 半厚。 */
  halfZ?: number;
  /** breath：安全缺口的中心 x 与半宽。 */
  gapX?: number;
  gapW?: number;
  /** beam：起止角度（弧度，0 = 正对 -z），以及当前角度。 */
  angle0?: number;
  angle1?: number;
  angle?: number;
}

/** Boss 三阶段状态机：践踏 AoE / 召唤尸潮 / 直线冲锋。 */
export class BossController {
  enemy: Enemy | null = null;
  /** 0 / 1 / 2 */
  phase = 0;
  /** 当前的地面预警圈（渲染层直接读）。 */
  telegraph: Telegraph | null = null;
  name = '';

  private state: BossState = 'approach';
  private timer = 0;
  /** 本场 Boss 战已经打了多久，用来算狂暴。 */
  private fightTime = 0;
  /** 当前狂暴伤害倍率。 */
  private rageDamage = 1;
  private kind: BossKind = 'overlord';
  /** 每个招式各自的冷却，下标对应 BOSS_PLANS[kind].abilities。 */
  private cds: number[] = [];
  /** 正在施放的那一招。 */
  private casting: BossAbility | null = null;
  /** 半场毒爆左右交替用的记号。 */
  private quakeSide = 1;
  /** 潜地期间的放怪计时。 */
  private submergeTick = 0;

  /** 潜地时无敌——渲染层也读它来把 Boss 沉到地下。 */
  get invulnerable(): boolean {
    return this.state === 'submerged';
  }

  constructor(private readonly rng: Rng) {}

  get active(): boolean {
    return this.enemy !== null && this.enemy.alive;
  }

  get hpRatio(): number {
    return this.enemy && this.enemy.maxHp > 0 ? Math.max(0, this.enemy.hp / this.enemy.maxHp) : 0;
  }

  /** 还没开打——这只 Boss 现在只是远处那个越走越近的黑影。 */
  get previewing(): boolean {
    return this.state === 'preview';
  }

  /**
   * 开局就把 Boss 放到远处。
   *
   * 以前 Boss 是走到竞技场跟前才凭空出现的，玩家一路上完全不知道自己在往
   * 什么东西身上撞。现在从第一帧起它就站在雾的边缘，慢慢往这边走——你一路
   * 推进，它一路变大，压迫感是攒了一整关攒出来的，不是最后十秒才有的。
   *
   * 预览态的它无敌、不放招、不参与索敌，纯粹是个会走路的剪影。
   */
  preview(pool: EnemyPool, kind: BossKind, scale: number, name: string, z: number): void {
    this.name = name;
    this.kind = kind;
    this.state = 'preview';
    this.phase = 0;
    this.timer = 0;
    this.fightTime = 0;
    this.telegraph = null;
    this.casting = null;
    this.enemy = pool.spawn('boss', 0, z, {
      hp: 1,
      scale: ENEMY_STATS.boss.scale * scale,
      scripted: true,
    });
    // 打不到也不吃伤害：它还不在场上
    this.enemy.invulnerable = true;
  }

  /**
   * 远处那只黑影正式入场——补上真血量，接管技能状态机。
   * 复用同一个 enemy 实例，所以模型不会闪一下再出现。
   */
  awaken(arenaZ: number, hp: number, out: SimEvent[]): void {
    const b = this.enemy;
    if (!b) return;
    const plan = BOSS_PLANS[this.kind];
    // 初始冷却错开，开场不会所有招同时就绪
    this.cds = plan.abilities.map((ab, i) => ab.cd * (0.35 + i * 0.22));
    this.casting = null;
    this.quakeSide = 1;
    b.hp = hp;
    b.maxHp = hp;
    b.invulnerable = false;
    b.z = Math.max(b.z, arenaZ);
    this.phase = 0;
    this.state = 'approach';
    this.timer = 0;
    this.fightTime = 0;
    out.push({ type: 'bossSpawn', x: 0, z: arenaZ, text: this.name, amount: hp, kind: 'boss' });
  }

  spawn(pool: EnemyPool, arenaZ: number, hp: number, scale: number, name: string, kind: BossKind, out: SimEvent[]): void {
    this.preview(pool, kind, scale, name, arenaZ + 16);
    this.awaken(arenaZ, hp, out);
  }

  update(dt: number, squad: Squad, pool: EnemyPool, out: SimEvent[]): void {
    const b = this.enemy;
    if (!b || !b.alive) {
      this.telegraph = null;
      return;
    }
    // 预览态：只走路，不做别的。位置由 World 每帧摆好（一直吊在方阵前方）。
    if (this.state === 'preview') {
      b.phase += dt * BOSS.previewStride;
      this.telegraph = null;
      return;
    }

    // 阶段推进
    const ratio = this.hpRatio;
    while (this.phase < BOSS.phaseThresholds.length && ratio <= BOSS.phaseThresholds[this.phase]!) {
      this.phase++;
      out.push({ type: 'bossPhase', amount: this.phase, x: b.x, z: b.z });
      // 换阶段立刻召唤一波，并把所有技能的冷却砍掉大半
      this.summonAdds(pool, squad, out, BOSS.summon.count + this.phase * 10);
      for (let i = 0; i < this.cds.length; i++) this.cds[i] = Math.min(this.cds[i]!, 1.2 + i * 0.8);
    }

    this.fightTime += dt;
    const overtime = Math.max(0, this.fightTime - BOSS.enrage.after);
    const rage = overtime * BOSS.enrage.rampPerSecond;
    const speedUp = Math.min(BOSS.enrage.maxSpeed, 1 + this.phase * 0.35 + rage);
    const rageDmg = Math.min(BOSS.enrage.maxDamage, 1 + rage);
    this.rageDamage = rageDmg;
    b.phase += dt * 3.4;

    for (let i = 0; i < this.cds.length; i++) this.cds[i]! -= dt * speedUp;

    const standoffZ = squad.z + BOSS.standoff;
    const plan = BOSS_PLANS[this.kind];

    switch (this.state) {
      case 'approach': {
        b.z += (standoffZ - b.z) * Math.min(1, dt * 1.6);
        b.x += (squad.x - b.x) * Math.min(1, dt * 0.8);
        if (Math.abs(b.z - standoffZ) < 1.2) this.state = 'idle';
        break;
      }
      case 'idle': {
        // 跟着方阵保持距离，横向缓慢游走
        b.z += (standoffZ - b.z) * Math.min(1, dt * 2.2);
        b.x += (squad.x - b.x) * Math.min(1, dt * 0.5);
        // 挑第一个转好的招。列表顺序即优先级——把这个 Boss 的招牌技放在最前面。
        for (let i = 0; i < plan.abilities.length; i++) {
          if (this.cds[i]! > 0) continue;
          this.begin(plan.abilities[i]!, i, squad, pool, out, rageDmg);
          break;
        }
        break;
      }
      case 'cast': {
        this.timer -= dt;
        const tg = this.telegraph;
        if (tg) {
          tg.t = 1 - Math.max(0, this.timer) / tg.dur;
          // 光束在读条期间就一路扫过去，玩家看着它逼近才有"快跑"的紧迫感
          if (tg.kind === 'beam' && tg.angle0 !== undefined && tg.angle1 !== undefined) {
            tg.angle = tg.angle0 + (tg.angle1 - tg.angle0) * tg.t;
          }
          // 火墙一边预警一边压过来
          if (tg.kind === 'breath') tg.z = tg.z + (squad.z - tg.z) * Math.min(1, dt * 1.5);
        }
        b.z += (standoffZ - b.z) * Math.min(1, dt * 2.0);
        if (this.timer <= 0) {
          this.resolve(squad, out, rageDmg);
          this.state = 'recover';
          this.timer = 0.55;
        }
        break;
      }
      case 'recover': {
        this.timer -= dt;
        b.z += (standoffZ - b.z) * Math.min(1, dt * 2.0);
        if (this.timer <= 0) this.state = 'idle';
        break;
      }
      case 'submerged': {
        b.invulnerable = true;
        // 沉到地下：无敌，同时不断往外吐尸潮。这段时间玩家打不动 Boss，
        // 只能一边清杂兵一边等它浮上来——节奏上是一段强制的"喘不过气"。
        this.timer -= dt;
        this.submergeTick -= dt;
        const ab = this.casting;
        if (ab && ab.a === 'submerge' && this.submergeTick <= 0) {
          this.submergeTick = 1;
          this.summonAdds(pool, squad, out, Math.round(ab.perSecond * rageDmg));
        }
        if (this.timer <= 0) {
          b.invulnerable = false;
          this.state = 'recover';
          this.timer = 0.6;
          this.casting = null;
          out.push({ type: 'bossEmerge', x: b.x, z: b.z });
        }
        break;
      }
      case 'chargeTelegraph': {
        this.timer -= dt;
        if (this.telegraph) {
          this.telegraph.t = 1 - Math.max(0, this.timer) / this.telegraph.dur;
          this.telegraph.z = squad.z;
        }
        if (this.timer <= 0) {
          this.telegraph = null;
          this.state = 'charging';
        }
        break;
      }
      case 'charging': {
        b.z -= BOSS.charge.speed * dt;
        // 碾过方阵：车道内的士兵被撞飞
        if (Math.abs(b.z - squad.z) < 3) {
          this.applyAoe(squad, b.x, squad.z, BOSS.charge.laneHalfWidth, BOSS.charge.damage * (1 + this.phase * 0.2) * this.rageDamage, out);
        }
        if (b.z < squad.z - squad.depth - 6) this.state = 'chargeReturn';
        break;
      }
      case 'chargeReturn': {
        b.z += BOSS.charge.speed * 0.75 * dt;
        if (b.z >= standoffZ - 1) this.state = 'idle';
        break;
      }
    }

    // 保持在路面内
    const limit = ROAD_HALF - 1.5;
    b.x = Math.max(-limit, Math.min(limit, b.x));
    if (this.state !== 'charging' && this.state !== 'chargeReturn') {
      b.z = Math.max(squad.z + 8, b.z);
    }
  }

  /** 起手一招：布置预警，切到对应状态。 */
  private begin(
    ab: BossAbility,
    index: number,
    squad: Squad,
    pool: EnemyPool,
    out: SimEvent[],
    rageDmg: number,
  ): void {
    const b = this.enemy!;
    this.cds[index] = ab.cd;
    this.casting = ab;

    switch (ab.a) {
      case 'slam': {
        this.state = 'cast';
        this.timer = BOSS.slam.telegraph;
        this.telegraph = {
          x: squad.x, z: squad.z - squad.depth * 0.3,
          radius: BOSS.slam.radius * (1 + this.phase * 0.12),
          t: 0, dur: BOSS.slam.telegraph, kind: 'slam',
        };
        out.push({ type: 'bossSlam', x: this.telegraph.x, z: this.telegraph.z, radius: this.telegraph.radius });
        break;
      }
      case 'lightning': {
        this.state = 'cast';
        this.timer = BOSS.lightning.telegraph;
        this.telegraph = {
          x: squad.x + this.rng.range(-6, 6),
          z: squad.z - squad.depth * this.rng.range(0, 0.6),
          radius: BOSS.lightning.radius, t: 0, dur: BOSS.lightning.telegraph, kind: 'lightning',
        };
        out.push({ type: 'bossLightning', x: this.telegraph.x, z: this.telegraph.z, radius: this.telegraph.radius });
        break;
      }
      case 'quake': {
        // 左右交替：读得出节奏，才能踩着拍子来回横跳
        this.quakeSide = -this.quakeSide;
        this.state = 'cast';
        this.timer = ab.telegraph;
        const x0 = this.quakeSide > 0 ? 0 : -ROAD_HALF;
        const x1 = this.quakeSide > 0 ? ROAD_HALF : 0;
        this.telegraph = {
          x: (x0 + x1) / 2, z: squad.z - squad.depth * 0.3, radius: 0,
          x0, x1, halfZ: ab.depth / 2,
          t: 0, dur: ab.telegraph, kind: 'quake',
        };
        out.push({ type: 'bossQuake', x: this.telegraph.x, z: this.telegraph.z, amount: this.quakeSide });
        break;
      }
      case 'breath': {
        this.state = 'cast';
        this.timer = ab.telegraph;
        const gapX = this.rng.range(-ROAD_HALF + ab.gapHalf, ROAD_HALF - ab.gapHalf);
        this.telegraph = {
          x: 0, z: squad.z + 24, radius: 0,
          x0: -ROAD_HALF, x1: ROAD_HALF, halfZ: 3.2,
          gapX, gapW: ab.gapHalf,
          t: 0, dur: ab.telegraph, kind: 'breath',
        };
        out.push({ type: 'bossBreath', x: gapX, z: this.telegraph.z, radius: ab.gapHalf });
        break;
      }
      case 'beam': {
        this.state = 'cast';
        this.timer = ab.telegraph;
        // 从一侧扫到另一侧，方向随机——不能靠背板，得看着它跑
        const dir = this.rng.next() < 0.5 ? 1 : -1;
        this.telegraph = {
          x: b.x, z: b.z, radius: ab.halfWidth,
          angle0: -0.95 * dir, angle1: 0.95 * dir, angle: -0.95 * dir,
          t: 0, dur: ab.telegraph, kind: 'beam',
        };
        out.push({ type: 'bossBeam', x: b.x, z: b.z });
        break;
      }
      case 'charge': {
        this.state = 'chargeTelegraph';
        this.timer = BOSS.charge.telegraph;
        b.x += (squad.x - b.x) * 0.9;
        this.telegraph = { x: b.x, z: squad.z, radius: BOSS.charge.laneHalfWidth, t: 0, dur: BOSS.charge.telegraph, kind: 'charge' };
        out.push({ type: 'bossCharge', x: b.x, z: b.z });
        break;
      }
      case 'summon': {
        this.state = 'recover';
        this.timer = 0.8;
        this.summonAdds(pool, squad, out, Math.round((ab.count + this.phase * 8) * rageDmg));
        break;
      }
      case 'submerge': {
        this.state = 'submerged';
        this.timer = ab.seconds;
        this.submergeTick = 0;
        this.telegraph = null;
        b.invulnerable = true;
        out.push({ type: 'bossSubmerge', x: b.x, z: b.z, amount: ab.seconds });
        break;
      }
    }
  }

  /** 读条结束：把这一招的伤害真正结算掉。 */
  private resolve(squad: Squad, out: SimEvent[], rageDmg: number): void {
    const tg = this.telegraph;
    const ab = this.casting;
    this.telegraph = null;
    this.casting = null;
    if (!tg || !ab) return;

    switch (ab.a) {
      case 'slam':
        this.applyAoe(squad, tg.x, tg.z, tg.radius, BOSS.slam.damage * (1 + this.phase * 0.25) * rageDmg, out);
        out.push({ type: 'bossSlamHit', x: tg.x, z: tg.z, radius: tg.radius });
        break;
      case 'lightning':
        this.applyAoe(squad, tg.x, tg.z, tg.radius, BOSS.lightning.damage * (1 + this.phase * 0.22) * rageDmg, out);
        out.push({ type: 'bossLightningHit', x: tg.x, z: tg.z, radius: tg.radius });
        break;
      case 'quake':
        this.applyRect(squad, tg.x0!, tg.x1!, tg.z - tg.halfZ!, tg.z + tg.halfZ!, ab.damage * rageDmg, out);
        out.push({ type: 'bossQuakeHit', x: tg.x, z: tg.z, radius: (tg.x1! - tg.x0!) / 2, amount: this.quakeSide });
        break;
      case 'breath':
        // 缺口以外全部烧掉
        this.applyRect(squad, -ROAD_HALF, tg.gapX! - tg.gapW!, tg.z - tg.halfZ!, tg.z + tg.halfZ!, ab.damage * rageDmg, out);
        this.applyRect(squad, tg.gapX! + tg.gapW!, ROAD_HALF, tg.z - tg.halfZ!, tg.z + tg.halfZ!, ab.damage * rageDmg, out);
        out.push({ type: 'bossBreathHit', x: tg.gapX!, z: tg.z, radius: tg.gapW! });
        break;
      case 'beam':
        this.applyBeam(squad, tg.x, tg.z, tg.angle ?? 0, tg.radius, ab.damage * rageDmg, out);
        out.push({ type: 'bossBeamHit', x: tg.x, z: tg.z, amount: tg.angle ?? 0 });
        break;
      default:
        break;
    }
  }

  /** 矩形范围伤害（半场毒爆 / 火墙）。 */
  private applyRect(
    squad: Squad, x0: number, x1: number, z0: number, z1: number, damage: number, out: SimEvent[],
  ): void {
    if (x1 <= x0) return;
    for (const u of squad.units) {
      if (!u.alive) continue;
      if (u.x < x0 || u.x > x1 || u.z < z0 || u.z > z1) continue;
      this.hurt(squad, u, damage, out);
    }
  }

  /**
   * 光束伤害：以 Boss 为原点、沿 angle 方向的一条射线，
   * 判定的是"到这条线的垂直距离"。
   */
  private applyBeam(
    squad: Squad, ox: number, oz: number, angle: number, halfWidth: number, damage: number, out: SimEvent[],
  ): void {
    // angle = 0 指向 -z（朝方阵），正角度往 +x 偏
    const dx = Math.sin(angle);
    const dz = -Math.cos(angle);
    for (const u of squad.units) {
      if (!u.alive) continue;
      const rx = u.x - ox;
      const rz = u.z - oz;
      const along = rx * dx + rz * dz;
      if (along < 0) continue; // 在 Boss 背后
      const perp = Math.abs(rx * dz - rz * dx);
      if (perp > halfWidth) continue;
      this.hurt(squad, u, damage, out);
    }
  }

  private hurt(squad: Squad, u: { x: number; z: number; hp: number; alive: boolean; flash: number }, damage: number, out: SimEvent[]): void {
    u.hp -= damage;
    u.flash = 0.2;
    if (u.hp <= 0) {
      u.alive = false;
      squad.markDirty();
      out.push({ type: 'soldierDown', x: u.x, y: 0.9, z: u.z });
    }
  }

  private summonAdds(pool: EnemyPool, squad: Squad, _out: SimEvent[], count: number): void {
    const b = this.enemy;
    if (!b) return;
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(-8, 8);
      const z = b.z + this.rng.range(-4, 10);
      pool.spawn(this.rng.next() < 0.3 ? 'runner' : 'walker', x, z);
    }
    void squad;
  }

  private applyAoe(squad: Squad, x: number, z: number, radius: number, damage: number, out: SimEvent[]): void {
    const r2 = radius * radius;
    for (const u of squad.units) {
      if (!u.alive) continue;
      const dx = u.x - x;
      const dz = u.z - z;
      if (dx * dx + dz * dz > r2) continue;
      u.hp -= damage;
      u.flash = 0.2;
      if (u.hp <= 0) {
        u.alive = false;
        squad.markDirty();
        out.push({ type: 'soldierDown', x: u.x, y: 0.9, z: u.z });
      }
    }
  }

  reset(): void {
    if (this.enemy) this.enemy.invulnerable = false;
    this.enemy = null;
    this.telegraph = null;
    this.phase = 0;
    this.state = 'approach';
    this.casting = null;
    this.cds = [];
  }
}
