import { ENEMY_STATS, MELEE, ROAD_HALF, SCREAMER_AURA, SOLDIER, type EnemyKind } from '../config/balance';
import type { Rng } from '../core/Rng';
import type { WaveSpec } from '../config/levels';
import type { Squad } from './Squad';
import type { Enemy, SimEvent } from './types';

/** 尸体倒地动画时长。 */
const DYING_TIME = 0.55;
/** 刷怪默认提前量：留出几秒的射击窗口，尸潮才是"压过来"而不是"贴脸出现"。 */
const DEFAULT_SPAWN_AHEAD = 62;

export class EnemyPool {
  readonly list: Enemy[] = [];
  private nextId = 1;
  /** 关卡血量/体型缩放。 */
  hpScale = 1;
  sizeScale = 1;
  /** 上一帧压在接触面上的僵尸数量（World 用它拖慢方阵前进）。 */
  contactCount = 0;

  /** 复用的排序缓冲，避免每帧分配。 */
  private readonly contactBuf: Enemy[] = [];

  constructor(private readonly rng: Rng) {}

  get aliveCount(): number {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  spawnWave(wave: WaveSpec, atZ: number, squadX: number): void {
    const ahead = wave.spawnAhead ?? DEFAULT_SPAWN_AHEAD;
    const depth = wave.depth ?? 22;
    const baseZ = atZ + ahead;
    for (const g of wave.groups) {
      for (let i = 0; i < g.count; i++) {
        const t = g.count > 1 ? i / (g.count - 1) : 0.5;
        // 沿纵深分层铺开，横向铺满整条路 —— 还原广告里"尸潮填满路面"的密度
        const z = baseZ + t * depth + this.rng.range(-1.6, 1.6);
        const spread = ROAD_HALF - 0.8;
        const x = this.rng.range(-spread, spread) * 0.5 + this.rng.range(-spread, spread) * 0.5 + squadX * 0.15;
        this.spawn(g.kind, clamp(x, -spread, spread), z);
      }
    }
  }

  spawn(kind: EnemyKind, x: number, z: number, opts?: { hp?: number; scale?: number; scripted?: boolean }): Enemy {
    const st = ENEMY_STATS[kind];
    const hp = opts?.hp ?? st.hp * Math.pow(this.hpScale, st.scaleExp);
    const e: Enemy = {
      id: this.nextId++,
      kind,
      x,
      z,
      hp,
      maxHp: hp,
      alive: true,
      phase: this.rng.range(0, Math.PI * 2),
      scale: (opts?.scale ?? st.scale) * this.sizeScale,
      attackCd: this.rng.range(0, 0.6),
      flash: 0,
      speedMul: 1,
      damageMul: 1,
      scripted: opts?.scripted ?? false,
      dying: 0,
    };
    this.list.push(e);
    return e;
  }

  /** 造成伤害。返回真实扣血量；击杀时推入事件。 */
  damage(e: Enemy, amount: number, out: SimEvent[]): number {
    if (!e.alive) return 0;
    const dealt = Math.min(e.hp, amount);
    e.hp -= dealt;
    e.flash = 0.09;
    const st = ENEMY_STATS[e.kind];
    if (st.showHealthBar && dealt >= 1) {
      out.push({ type: 'hitBig', x: e.x, y: 1.6 * e.scale, z: e.z, amount: Math.round(dealt) });
    }
    if (e.hp <= 0) {
      e.alive = false;
      e.dying = DYING_TIME;
      out.push({ type: 'kill', x: e.x, y: 0.9 * e.scale, z: e.z, kind: e.kind, amount: st.gold });
    }
    return dealt;
  }

  update(dt: number, squad: Squad, out: SimEvent[]): void {
    // 嚎叫者光环：先收集，再套用
    const screamers: Enemy[] = [];
    for (const e of this.list) {
      if (e.alive && e.kind === 'screamer') screamers.push(e);
    }

    const frontZ = squad.z + SOLDIER.contactDepth;
    const halfW = squad.halfWidth + 1.6;
    const contact = this.contactBuf;
    contact.length = 0;

    for (const e of this.list) {
      if (!e.alive) {
        if (e.dying > 0) e.dying = Math.max(0, e.dying - dt);
        continue;
      }
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);

      // 嚎叫者光环
      e.speedMul = 1;
      e.damageMul = 1;
      if (e.kind !== 'screamer') {
        for (const s of screamers) {
          const dx = s.x - e.x;
          const dz = s.z - e.z;
          if (dx * dx + dz * dz < SCREAMER_AURA.radius * SCREAMER_AURA.radius) {
            e.speedMul = SCREAMER_AURA.speedMul;
            e.damageMul = SCREAMER_AURA.damageMul;
            break;
          }
        }
      }

      if (e.scripted) continue; // Boss 由 BossController 驱动

      const st = ENEMY_STATS[e.kind];
      const speed = st.speed * e.speedMul;

      // 已经压到接触面上的，交给下面的排队逻辑统一处理
      const reach = frontZ + e.scale * 0.55;
      if (e.z <= reach + MELEE.queueDepth * 0.5 && Math.abs(e.x - squad.x) <= halfW + e.scale) {
        contact.push(e);
        e.phase += dt * 6;
        continue;
      }

      e.z -= speed * dt;
      // 越靠近方阵，横向收拢得越急，让尸潮汇成一股压过来
      const dx = squad.x - e.x;
      const urgency = e.z - squad.z < 22 ? 1.1 : 0.4;
      e.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * urgency * dt);
      e.phase += dt * (3.2 + speed * 0.55);
    }

    this.resolveMelee(dt, squad, contact, out);
    this.contactCount = contact.length;

    // 回收：播完倒地动画的尸体，以及被甩到方阵后面的漏网之鱼
    const cullZ = squad.z - squad.depth - MELEE.cullBehind;
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!;
      if (!e.alive && e.dying <= 0) continue;
      if (e.alive && !e.scripted && e.z < cullZ) continue;
      this.list[w++] = e;
    }
    this.list.length = w;
  }

  /**
   * 接触面结算。
   * 只有站在最前一层的僵尸够得着士兵；后面的按层往后堆，形成压迫感十足的尸墙。
   * 这解决了"几百只僵尸同时啃同一排士兵"导致的秒杀问题。
   */
  private resolveMelee(dt: number, squad: Squad, contact: Enemy[], out: SimEvent[]): void {
    if (contact.length === 0) return;
    // 先到先得：越靠前的越有资格站在第一层
    contact.sort((a, b) => a.z - b.z);

    const perRow = Math.max(3, Math.round(squad.cols * MELEE.frontRowFactor));
    const frontZ = squad.z + SOLDIER.contactDepth;
    const rowWidth = Math.max(3, squad.halfWidth * 2 + 1.2);

    for (let i = 0; i < contact.length; i++) {
      const e = contact[i]!;
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // 站位：一层一层往后铺开
      const tx = squad.x - rowWidth / 2 + ((col + 0.5) / perRow) * rowWidth;
      const tz = frontZ + e.scale * 0.5 + row * MELEE.queueDepth;
      const k = Math.min(1, dt * 7);
      e.x += (tx - e.x) * k;
      e.z += (tz - e.z) * k;

      // 只有第一层能咬到人（大体型的怪伸手更远，第二层也够得着）
      const canReach = row === 0 || (row === 1 && e.scale >= 2);
      if (!canReach) continue;

      e.attackCd -= dt;
      if (e.attackCd > 0) continue;
      e.attackCd = SOLDIER.hitCooldown;

      const st = ENEMY_STATS[e.kind];
      const dmg = st.damage * e.damageMul;
      for (let s = 0; s < st.sweep; s++) {
        const target = squad.pickFrontTarget(this.rng.next());
        if (!target) break;
        target.hp -= dmg;
        target.flash = 0.12;
        if (target.hp <= 0) {
          target.alive = false;
          squad.markDirty();
          out.push({ type: 'soldierDown', x: target.x, y: 0.9, z: target.z });
        }
      }
    }
  }

  /** 距离方阵最近的 n 个活着的敌人（用来做集火目标池）。 */
  nearestTargets(squad: Squad, range: number, limit: number, out: Enemy[]): void {
    out.length = 0;
    const r2 = range * range;
    for (const e of this.list) {
      if (!e.alive) continue;
      if (e.z < squad.z - 6) continue; // 已经冲过方阵的不再优先
      const dx = e.x - squad.x;
      const dz = e.z - squad.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      out.push(e);
    }
    out.sort((a, b) => (a.z - squad.z) - (b.z - squad.z));
    if (out.length > limit) out.length = limit;
  }

  clear(): void {
    this.list.length = 0;
    this.contactCount = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
