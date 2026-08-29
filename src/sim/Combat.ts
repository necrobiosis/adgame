import { BLOCK, CANNON, RANK_FIRE, WEAPON_RANGE, rangeFalloff } from '../config/balance';
import type { EnemyPool } from './Enemies';
import type { Squad } from './Squad';
import { laneAtX } from './lanes';
import type { BlockObstacle, Enemy, Shell, SimEvent } from './types';

/** 穿透衰减：串到第 k 个目标时伤害乘这么多的 k 次方。 */
const PIERCE_FALLOFF = 0.72;

/** 枪口相对单位原点的高度。 */
const MUZZLE_Y = 1.15;
const CANNON_MUZZLE_Y = 1.0;

/** 有敌人逼近到这个距离内时，部分火力必须回防而不是砸方块。 */
const THREAT_RANGE = 17;

export class Combat {
  readonly shells: Shell[] = [];
  private nextShellId = 1;
  private readonly targetPool: Enemy[] = [];
  /** 大炮的目标池：走廊比步枪宽得多，所以要单独算一份。 */
  private readonly cannonPool: Enemy[] = [];

  update(
    dt: number,
    squad: Squad,
    pool: EnemyPool,
    block: BlockObstacle | null,
    out: SimEvent[],
  ): number {
    let goldEarned = 0;
    const weapon = squad.weapon;
    const dmg = weapon.damage * squad.damageMul;
    const rate = Math.max(0.2, weapon.fireRate * squad.fireRateMul);
    const interval = 1 / rate;

    // 集火宽度随兵力增长：人少时死死咬住最前面几只，人多时才铺开火力。
    // 不这么做的话，小队伍会把伤害均摊到几十个目标上，谁都打不死。
    const focus = clamp(Math.round(squad.aliveCount / 3), 1, 60);
    // 枪不自瞄：只打正前方那一条走廊里的东西。
    pool.forwardTargets(squad, WEAPON_RANGE, focus, this.targetPool);
    const targets = this.targetPool;
    // 大炮是曲射的，能越排砸——这才是"炮兵编制"和"武器等级"的本质区别：
    // 武器决定你这一排打得多狠，火炮决定你够不够得到隔壁排。
    pool.forwardTargets(squad, CANNON.range, 40, this.cannonPool, CANNON.corridor);
    const cannonTargets = this.cannonPool;

    // 方块是否挡住去路，且在射程内
    const blockTargetable =
      block !== null &&
      block.alive &&
      block.z > squad.z - 2 &&
      block.z - squad.z < BLOCK.engageRange &&
      obstructs(block, squad);

    // 有威胁逼近时留一部分火力回防
    let closeThreats = 0;
    for (const e of targets) {
      if (e.z - squad.z < THREAT_RANGE) closeThreats++;
    }

    const blockShare = blockTargetable ? (closeThreats > 0 ? 0.55 : 1) : 0;

    let idx = -1;
    for (const u of squad.units) {
      if (!u.alive) continue;
      idx++;
      u.cooldown -= dt;
      if (u.flash > 0) u.flash = Math.max(0, u.flash - dt);

      if (u.isCannon) {
        if (u.cooldown > 0) continue;
        const aim = pickCannonAim(cannonTargets, squad, blockTargetable ? block : null);
        if (!aim) continue;
        u.cooldown = 1 / Math.max(0.05, CANNON.fireRate * squad.fireRateMul);
        const dist = Math.hypot(aim.x - u.x, aim.z - u.z);
        const dur = Math.max(0.25, dist / CANNON.shellSpeed);
        this.shells.push({
          id: this.nextShellId++,
          x: u.x,
          y: CANNON_MUZZLE_Y,
          z: u.z,
          tx: aim.x,
          tz: aim.z,
          t: 0,
          dur,
          arc: 2.2 + dist * 0.16,
        });
        out.push({ type: 'cannonFire', x: u.x, y: CANNON_MUZZLE_Y, z: u.z, tx: aim.x, tz: aim.z });
        continue;
      }

      if (u.cooldown > 0) continue;

      const rankMul = rankFireMul(u.rank);
      const useBlock = blockTargetable && (idx % 100) / 100 < blockShare;
      if (useBlock && block) {
        u.cooldown = interval;
        const dealt = Math.min(block.hp, dmg * weapon.pellets * rankMul);
        block.hp -= dealt;
        block.flash = 0.08;
        out.push({
          type: 'shot',
          x: u.x, y: MUZZLE_Y, z: u.z,
          tx: clamp(u.x, block.x0, block.x1), ty: 1.6, tz: block.z,
          color: weapon.tracer,
        });
        if (block.hp <= 0 && block.alive) {
          block.alive = false;
          const gold = Math.round((block.maxHp / 100) * BLOCK.goldPerHundredHp) + block.bonus;
          goldEarned += gold;
          out.push({ type: 'blockDestroyed', x: (block.x0 + block.x1) / 2, y: 1.6, z: block.z, amount: gold });
        } else {
          out.push({ type: 'blockHit', x: clamp(u.x, block.x0, block.x1), y: 1.4, z: block.z });
        }
        continue;
      }

      if (targets.length === 0) continue;
      const first = idx % targets.length;
      const target = targets[first]!;
      if (!target.alive) continue;
      u.cooldown = interval;
      const perShot = dmg * weapon.pellets * rankMul;
      // 穿透：子弹本来就只往正前方飞，一整排怪站成一条纵队，
      // 高穿透的枪一发能把它们串起来——这是射程无限之后新的区分轴。
      let last = target;
      let hit = 0;
      for (let k = 0; k < weapon.pierce && hit < weapon.pierce; k++) {
        const t = targets[(first + k) % targets.length];
        if (!t || !t.alive) continue;
        // 两层衰减叠在一起：
        //  · 距离——射程无限，但超出有效射程越远打得越轻
        //  · 穿透——越往后串伤害越低，否则高穿透等于白送一个大倍率
        const atk = perShot
          * rangeFalloff(weapon.falloffStart, t.z - u.z)
          * Math.pow(PIERCE_FALLOFF, k);
        goldEarned += pool.damage(t, atk, out);
        last = t;
        hit++;
      }
      out.push({
        type: 'shot',
        x: u.x, y: MUZZLE_Y, z: u.z,
        // 曳光弹画到**最后一个**被串到的目标：穿透几个，光柱就有多长
        tx: last.x, ty: 1.1 * last.scale, tz: last.z,
        color: weapon.tracer,
        amount: weapon.beam,
      });
    }

    goldEarned += this.updateShells(dt, pool, blockTargetable ? block : null, out);
    return goldEarned;
  }

  private updateShells(dt: number, pool: EnemyPool, block: BlockObstacle | null, out: SimEvent[]): number {
    let gold = 0;
    const splashDmg = CANNON.damage;
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i]!;
      s.t += dt / s.dur;
      if (s.t < 1) continue;

      // 落地：溅射
      const r2 = CANNON.splashRadius * CANNON.splashRadius;
      for (const e of pool.list) {
        if (!e.alive) continue;
        const dx = e.x - s.tx;
        const dz = e.z - s.tz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const falloff = 1 - (1 - CANNON.splashEdge) * Math.sqrt(d2 / r2);
        gold += pool.damage(e, splashDmg * falloff, out, true);
      }
      if (block && block.alive && Math.abs(block.z - s.tz) < CANNON.splashRadius && s.tx >= block.x0 - 2 && s.tx <= block.x1 + 2) {
        block.hp -= splashDmg;
        block.flash = 0.1;
        if (block.hp <= 0) {
          block.alive = false;
          const g = Math.round((block.maxHp / 100) * BLOCK.goldPerHundredHp) + block.bonus;
          gold += g;
          out.push({ type: 'blockDestroyed', x: (block.x0 + block.x1) / 2, y: 1.6, z: block.z, amount: g });
        }
      }
      out.push({ type: 'shellImpact', x: s.tx, y: 0.2, z: s.tz, radius: CANNON.splashRadius });
      this.shells.splice(i, 1);
    }
    return gold;
  }

  clear(): void {
    this.shells.length = 0;
  }
}

/** 大炮瞄准：优先砸最密集的一团，其次砸血最厚的目标。 */
function pickCannonAim(targets: readonly Enemy[], squad: Squad, block: BlockObstacle | null): { x: number; z: number } | null {
  if (targets.length === 0) {
    if (block) return { x: (block.x0 + block.x1) / 2, z: block.z };
    return null;
  }
  const r2 = CANNON.splashRadius * CANNON.splashRadius;
  let best = targets[0]!;
  let bestScore = -1;
  const sample = Math.min(targets.length, 24);
  for (let i = 0; i < sample; i++) {
    const c = targets[i]!;
    if (c.z - squad.z > CANNON.range) continue;
    let score = 0;
    for (let j = 0; j < sample; j++) {
      const o = targets[j]!;
      const dx = o.x - c.x;
      const dz = o.z - c.z;
      if (dx * dx + dz * dz <= r2) score += 1 + Math.min(4, o.maxHp / 200);
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { x: best.x, z: best.z };
}

/** 第 row 排士兵的火力效率。 */
export function rankFireMul(row: number): number {
  if (row <= RANK_FIRE.freeRows) return 1;
  return Math.max(RANK_FIRE.floor, Math.pow(RANK_FIRE.falloff, row - RANK_FIRE.freeRows));
}

/**
 * 这堵墙现在该不该挨打。
 *
 * 只有一条规则：**你站在它那一排上**。
 *
 * 墙永远只占三排里的一排，没有全宽墙。站过去就打得到、打穿了拿奖励，
 * 代价是这段时间你的火力全砸在墙上、那一排的尸潮一路走到你脸上；
 * 走别的排就什么都没有——错过就是错过。这个"错过就没有奖励"才是决策点，
 * 顺路擦过去白拿不是。
 */
function obstructs(block: BlockObstacle, squad: Squad): boolean {
  // 判的是**方阵中心**在不在这一排，不是边缘有没有蹭到。
  // 用边缘相交的话，站在隔壁排的方阵只要擦到一点边就开始砸墙、还会被拖慢，
  // 玩家完全不知道自己什么时候"算进去了"——这条线必须干脆利落。
  return laneAtX(squad.x) === block.lane;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
