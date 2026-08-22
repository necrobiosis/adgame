import { BLOCK, CANNON, RANK_FIRE } from '../config/balance';
import type { EnemyPool } from './Enemies';
import type { Squad } from './Squad';
import type { BlockObstacle, Enemy, Shell, SimEvent } from './types';

/** 枪口相对单位原点的高度。 */
const MUZZLE_Y = 1.15;
const CANNON_MUZZLE_Y = 1.0;

/** 有敌人逼近到这个距离内时，部分火力必须回防而不是砸方块。 */
const THREAT_RANGE = 17;

export class Combat {
  readonly shells: Shell[] = [];
  private nextShellId = 1;
  private readonly targetPool: Enemy[] = [];

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
    pool.nearestTargets(squad, weapon.range, focus, this.targetPool);
    const targets = this.targetPool;

    // 方块是否挡住去路，且在射程内
    const blockTargetable =
      block !== null &&
      block.alive &&
      block.z > squad.z - 2 &&
      block.z - squad.z < Math.min(weapon.range, BLOCK.engageRange) &&
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
        const aim = pickCannonAim(targets, squad, blockTargetable ? block : null);
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

      const rankMul = rankFireMul(u.row);
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
          const gold = Math.round((block.maxHp / 100) * BLOCK.goldPerHundredHp);
          goldEarned += gold;
          out.push({ type: 'blockDestroyed', x: (block.x0 + block.x1) / 2, y: 1.6, z: block.z, amount: gold });
        } else {
          out.push({ type: 'blockHit', x: clamp(u.x, block.x0, block.x1), y: 1.4, z: block.z });
        }
        continue;
      }

      if (targets.length === 0) continue;
      const target = targets[idx % targets.length]!;
      if (!target.alive) continue;
      u.cooldown = interval;
      goldEarned += pool.damage(target, dmg * weapon.pellets * rankMul, out);
      out.push({
        type: 'shot',
        x: u.x, y: MUZZLE_Y, z: u.z,
        tx: target.x, ty: 1.1 * target.scale, tz: target.z,
        color: weapon.tracer,
      });
    }

    goldEarned += this.updateShells(dt, pool, block, out);
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
        gold += pool.damage(e, splashDmg * falloff, out);
      }
      if (block && block.alive && Math.abs(block.z - s.tz) < CANNON.splashRadius && s.tx >= block.x0 - 2 && s.tx <= block.x1 + 2) {
        block.hp -= splashDmg;
        block.flash = 0.1;
        if (block.hp <= 0) {
          block.alive = false;
          const g = Math.round((block.maxHp / 100) * BLOCK.goldPerHundredHp);
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

function obstructs(block: BlockObstacle, squad: Squad): boolean {
  if (block.span === 'full') return true;
  return squad.x + squad.halfWidth > block.x0 && squad.x - squad.halfWidth < block.x1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
