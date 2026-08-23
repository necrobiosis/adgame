import { MIDBOSS } from '../config/balance';
import type { EnemyPool } from './Enemies';
import type { Squad } from './Squad';
import type { Enemy, SimEvent } from './types';

export interface MidBossTelegraph {
  x: number;
  z: number;
  radius: number;
  /** 已经过的时间 / 总时长，1 = 命中。 */
  t: number;
  dur: number;
}

/**
 * 中 boss：一只会走会打的强化精英，用普通 AI 走位（scripted: false），
 * 这个控制器只管一件事——到点在它自己脚下炸一圈冲击波。没有阶段、没有
 * 狂暴、不会让方阵停下来，机制上刻意比终极 Boss 简单很多。
 */
export class MidBossController {
  enemy: Enemy | null = null;
  telegraph: MidBossTelegraph | null = null;
  name = '';

  private cd = 0;
  private timer = 0;
  private telegraphing = false;

  get active(): boolean {
    return this.enemy !== null && this.enemy.alive;
  }

  spawn(pool: EnemyPool, x: number, z: number, hp: number, scale: number, name: string, out: SimEvent[]): void {
    this.name = name;
    this.enemy = pool.spawn('midboss', x, z, { hp, scale, scripted: false });
    // 出场不用等满一个完整冷却就先亮一次技能，不然玩家可能在它死之前都看不到
    this.cd = MIDBOSS.shock.cooldown * 0.5;
    this.telegraph = null;
    this.telegraphing = false;
    out.push({ type: 'midbossSpawn', x, z, text: name, amount: hp });
  }

  update(dt: number, squad: Squad, out: SimEvent[]): void {
    const e = this.enemy;
    if (!e || !e.alive) {
      this.telegraph = null;
      this.telegraphing = false;
      return;
    }

    if (this.telegraphing) {
      this.timer -= dt;
      if (this.telegraph) {
        // 预警圈跟着它的脚走——它没有停下来，冲击波是"边走边炸"
        this.telegraph.x = e.x;
        this.telegraph.z = e.z;
        this.telegraph.t = 1 - Math.max(0, this.timer) / this.telegraph.dur;
      }
      if (this.timer <= 0) {
        const tg = this.telegraph!;
        this.applyAoe(squad, tg.x, tg.z, tg.radius, MIDBOSS.shock.damage, out);
        out.push({ type: 'midbossAbilityHit', x: tg.x, z: tg.z, radius: tg.radius });
        this.telegraph = null;
        this.telegraphing = false;
        this.cd = MIDBOSS.shock.cooldown;
      }
      return;
    }

    this.cd -= dt;
    // 贴近方阵才放技能——它还在半路上时冒出一圈预警说不通
    if (this.cd <= 0 && e.z - squad.z < 26) {
      this.telegraphing = true;
      this.timer = MIDBOSS.shock.telegraph;
      this.telegraph = { x: e.x, z: e.z, radius: MIDBOSS.shock.radius, t: 0, dur: MIDBOSS.shock.telegraph };
      out.push({ type: 'midbossAbility', x: e.x, z: e.z, radius: MIDBOSS.shock.radius });
    }
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
    this.telegraphing = false;
  }
}
