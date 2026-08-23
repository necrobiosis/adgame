import { BOSS, ENEMY_STATS } from '../config/balance';
import type { Rng } from '../core/Rng';
import type { EnemyPool } from './Enemies';
import type { Squad } from './Squad';
import type { Enemy, SimEvent } from './types';

type BossState =
  | 'approach'
  | 'idle'
  | 'slamTelegraph'
  | 'slamRecover'
  | 'chargeTelegraph'
  | 'charging'
  | 'chargeReturn'
  | 'summon'
  | 'lightningTelegraph';

export interface Telegraph {
  x: number;
  z: number;
  radius: number;
  /** 已经过的时间 / 总时长，1 = 落地。 */
  t: number;
  dur: number;
  kind: 'slam' | 'charge' | 'lightning';
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
  private slamCd = 3.5;
  private summonCd = 6;
  private chargeCd = 8;
  private lightningCd = 5;

  constructor(private readonly rng: Rng) {}

  get active(): boolean {
    return this.enemy !== null && this.enemy.alive;
  }

  get hpRatio(): number {
    return this.enemy && this.enemy.maxHp > 0 ? Math.max(0, this.enemy.hp / this.enemy.maxHp) : 0;
  }

  spawn(pool: EnemyPool, arenaZ: number, hp: number, scale: number, name: string, out: SimEvent[]): void {
    this.name = name;
    this.enemy = pool.spawn('boss', 0, arenaZ + 16, {
      hp,
      scale: ENEMY_STATS.boss.scale * scale,
      scripted: true,
    });
    this.phase = 0;
    this.state = 'approach';
    this.timer = 0;
    this.fightTime = 0;
    out.push({ type: 'bossSpawn', x: 0, z: arenaZ, text: name, amount: hp });
  }

  update(dt: number, squad: Squad, pool: EnemyPool, out: SimEvent[]): void {
    const b = this.enemy;
    if (!b || !b.alive) {
      this.telegraph = null;
      return;
    }

    // 阶段推进
    const ratio = this.hpRatio;
    while (this.phase < BOSS.phaseThresholds.length && ratio <= BOSS.phaseThresholds[this.phase]!) {
      this.phase++;
      out.push({ type: 'bossPhase', amount: this.phase, x: b.x, z: b.z });
      // 换阶段立刻召唤一波，并加速后续技能
      this.summonAdds(pool, squad, out, BOSS.summon.count + this.phase * 10);
      this.slamCd = 1.2;
      this.chargeCd = 3.0;
      this.lightningCd = 2.0;
    }

    this.fightTime += dt;
    const overtime = Math.max(0, this.fightTime - BOSS.enrage.after);
    const rage = overtime * BOSS.enrage.rampPerSecond;
    const speedUp = Math.min(BOSS.enrage.maxSpeed, 1 + this.phase * 0.35 + rage);
    const rageDmg = Math.min(BOSS.enrage.maxDamage, 1 + rage);
    this.rageDamage = rageDmg;
    b.phase += dt * 3.4;

    this.slamCd -= dt * speedUp;
    this.summonCd -= dt * speedUp;
    this.chargeCd -= dt * speedUp;
    this.lightningCd -= dt * speedUp;

    const standoffZ = squad.z + BOSS.standoff;

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
        if (this.slamCd <= 0) {
          this.state = 'slamTelegraph';
          this.timer = BOSS.slam.telegraph;
          this.telegraph = {
            x: squad.x,
            z: squad.z - squad.depth * 0.3,
            radius: BOSS.slam.radius * (1 + this.phase * 0.12),
            t: 0,
            dur: BOSS.slam.telegraph,
            kind: 'slam',
          };
          out.push({ type: 'bossSlam', x: this.telegraph.x, z: this.telegraph.z, radius: this.telegraph.radius });
        } else if (this.chargeCd <= 0) {
          this.state = 'chargeTelegraph';
          this.timer = BOSS.charge.telegraph;
          b.x += (squad.x - b.x) * 0.9;
          this.telegraph = { x: b.x, z: squad.z, radius: BOSS.charge.laneHalfWidth, t: 0, dur: BOSS.charge.telegraph, kind: 'charge' };
          out.push({ type: 'bossCharge', x: b.x, z: b.z });
        } else if (this.lightningCd <= 0) {
          this.state = 'lightningTelegraph';
          this.timer = BOSS.lightning.telegraph;
          const lx = squad.x + this.rng.range(-6, 6);
          const lz = squad.z - squad.depth * this.rng.range(0, 0.6);
          this.telegraph = { x: lx, z: lz, radius: BOSS.lightning.radius, t: 0, dur: BOSS.lightning.telegraph, kind: 'lightning' };
          out.push({ type: 'bossLightning', x: lx, z: lz, radius: this.telegraph.radius });
        } else if (this.summonCd <= 0) {
          this.state = 'summon';
          this.timer = 0.8;
          this.summonCd = BOSS.summon.cooldown;
          this.summonAdds(pool, squad, out, Math.round((BOSS.summon.count + this.phase * 8) * rageDmg));
        }
        break;
      }
      case 'slamTelegraph': {
        this.timer -= dt;
        if (this.telegraph) this.telegraph.t = 1 - Math.max(0, this.timer) / this.telegraph.dur;
        b.z += (standoffZ - b.z) * Math.min(1, dt * 2.0);
        if (this.timer <= 0) {
          const tg = this.telegraph!;
          this.applyAoe(squad, tg.x, tg.z, tg.radius, BOSS.slam.damage * (1 + this.phase * 0.25) * rageDmg, out);
          out.push({ type: 'bossSlamHit', x: tg.x, z: tg.z, radius: tg.radius });
          this.telegraph = null;
          this.slamCd = BOSS.slam.cooldown;
          this.state = 'slamRecover';
          this.timer = 0.6;
        }
        break;
      }
      case 'lightningTelegraph': {
        this.timer -= dt;
        if (this.telegraph) this.telegraph.t = 1 - Math.max(0, this.timer) / this.telegraph.dur;
        b.z += (standoffZ - b.z) * Math.min(1, dt * 2.0);
        if (this.timer <= 0) {
          const tg = this.telegraph!;
          this.applyAoe(squad, tg.x, tg.z, tg.radius, BOSS.lightning.damage * (1 + this.phase * 0.22) * rageDmg, out);
          out.push({ type: 'bossLightningHit', x: tg.x, z: tg.z, radius: tg.radius });
          this.telegraph = null;
          this.lightningCd = BOSS.lightning.cooldown;
          this.state = 'slamRecover';
          this.timer = 0.5;
        }
        break;
      }
      case 'slamRecover':
      case 'summon': {
        this.timer -= dt;
        b.z += (standoffZ - b.z) * Math.min(1, dt * 2.0);
        if (this.timer <= 0) this.state = 'idle';
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
        if (b.z < squad.z - squad.depth - 6) {
          this.state = 'chargeReturn';
          this.chargeCd = BOSS.charge.cooldown;
        }
        break;
      }
      case 'chargeReturn': {
        b.z += BOSS.charge.speed * 0.75 * dt;
        if (b.z >= standoffZ - 1) this.state = 'idle';
        break;
      }
    }

    // 保持在路面内
    b.x = Math.max(-7.5, Math.min(7.5, b.x));
    if (this.state !== 'charging' && this.state !== 'chargeReturn') {
      b.z = Math.max(squad.z + 8, b.z);
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
    this.enemy = null;
    this.telegraph = null;
    this.phase = 0;
    this.state = 'approach';
  }
}
