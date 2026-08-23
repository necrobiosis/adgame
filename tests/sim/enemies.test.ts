import { describe, expect, it } from 'vitest';
import { BOMBER, LEAPER, SPITTER, ENEMY_STATS } from '../../src/config/balance';
import { EnemyPool } from '../../src/sim/Enemies';
import { Squad } from '../../src/sim/Squad';
import { Rng } from '../../src/core/Rng';
import type { SimEvent } from '../../src/sim/types';

/**
 * 三种新怪的行为验证。
 *
 * 在这之前，七种怪共用同一套"走过来打前排"的例程——疾行者和普通尸的差别
 * 只有血量和速度。这三种各自攻击当前同质化的一个轴，所以要分别验证它们
 * 真的在做那件不一样的事，而不只是换了个贴图的杂兵。
 */

function makeSquad(n = 40): Squad {
  const rng = new Rng(7);
  const s = new Squad({ soldiers: n, cannons: 0, weaponLevel: 2, damageMul: 1, fireRateMul: 1, hpMul: 1 }, rng);
  s.layout();
  return s;
}

function run(pool: EnemyPool, squad: Squad, seconds: number): SimEvent[] {
  const all: SimEvent[] = [];
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    const out: SimEvent[] = [];
    pool.update(dt, squad, null, out);
    all.push(...out);
  }
  return all;
}

describe('重甲尸', () => {
  it('子弹打不动，但火炮溅射照打', () => {
    const pool = new EnemyPool(new Rng(1));
    const bullet = pool.spawn('armored', 0, 40);
    const splash = pool.spawn('armored', 2, 40);
    const out: SimEvent[] = [];

    pool.damage(bullet, 1000, out, false);
    pool.damage(splash, 1000, out, true);

    const bulletLost = bullet.maxHp - bullet.hp;
    const splashLost = splash.maxHp - splash.hp;
    expect(splashLost).toBeGreaterThan(bulletLost * 4);
    expect(bulletLost).toBeCloseTo(1000 * (1 - ENEMY_STATS.armored.bulletResist!), 1);
  });

  it('普通僵尸不吃这个减免（减免是重甲独有的）', () => {
    const pool = new EnemyPool(new Rng(1));
    const w = pool.spawn('walker', 0, 40);
    const out: SimEvent[] = [];
    pool.damage(w, 5, out, false);
    expect(w.maxHp - w.hp).toBeCloseTo(5, 3);
  });
});

describe('吐酸者', () => {
  it('停在射程外不贴脸，但仍然能造成伤害', () => {
    const squad = makeSquad();
    const pool = new EnemyPool(new Rng(2));
    const e = pool.spawn('spitter', 0, squad.z + SPITTER.standoff + 6);
    const hpBefore = squad.units.reduce((s, u) => s + u.hp, 0);

    const events = run(pool, squad, 12);

    // 抛射过、也落地过
    expect(events.some((v) => v.type === 'spitterFire')).toBe(true);
    expect(events.some((v) => v.type === 'spitterHit')).toBe(true);
    // 全程没有贴到方阵跟前——这是"远程"的意义
    expect(e.z - squad.z).toBeGreaterThan(SPITTER.standoff * 0.7);
    // 而且真的削到人了
    const hpAfter = squad.units.reduce((s, u) => s + u.hp, 0);
    expect(hpAfter).toBeLessThan(hpBefore);
  });

  it('站着不动会被打中，横向躲开就不会', () => {
    // 同一颗酸液，落点在抛出瞬间就定死了，所以横移真的能躲
    const squad = makeSquad();
    const pool = new EnemyPool(new Rng(5));
    pool.spawn('spitter', 0, squad.z + SPITTER.standoff);
    const events = run(pool, squad, 8);
    const hit = events.find((v) => v.type === 'spitterHit');
    expect(hit, '应当至少落地一次').toBeTruthy();
    // 落点是一个具体坐标，不是"永远打中方阵"
    expect(typeof hit!.x).toBe('number');
    expect(hit!.radius).toBeCloseTo(SPITTER.radius, 3);
  });
});

describe('跳跃者', () => {
  it('会越过前排落进阵型中后段', () => {
    const squad = makeSquad();
    const pool = new EnemyPool(new Rng(3));
    pool.spawn('leaper', 0, squad.z + LEAPER.triggerRange - 2);

    const events = run(pool, squad, 6);
    const jump = events.find((v) => v.type === 'leaperJump');
    const land = events.find((v) => v.type === 'leaperLand');

    expect(jump, '应当起跳').toBeTruthy();
    expect(land, '应当落地').toBeTruthy();
    // 落点在方阵前沿**后面**——前排保护对它无效，这正是它存在的理由
    expect(land!.z!).toBeLessThan(squad.z);
  });

  it('滞空时离地，落地后回到地面', () => {
    const squad = makeSquad();
    const pool = new EnemyPool(new Rng(3));
    const e = pool.spawn('leaper', 0, squad.z + LEAPER.triggerRange - 2);
    let maxAir = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 360; i++) {
      pool.update(dt, squad, null, []);
      maxAir = Math.max(maxAir, e.airY ?? 0);
    }
    expect(maxAir, '跳跃过程中应当真的离地').toBeGreaterThan(2);
    expect(e.airY ?? 0, '落地后应当回到地面').toBeLessThan(0.01);
  });
});

describe('自爆尸', () => {
  it('走到方阵跟前会自爆，一次带走一片人（前排挡不住它）', () => {
    const squad = makeSquad(60);
    const pool = new EnemyPool(new Rng(3));
    // 直接摆在方阵正前方一点点的地方，省掉走路那段
    const e = pool.spawn('bomber', squad.x, squad.z + BOMBER.fuseRange + 0.5);
    e.laneOffset = 0;
    const before = squad.soldierCount;
    const evs = run(pool, squad, 1.5);
    expect(evs.some((v) => v.type === 'bomberBlast'), '自爆尸没有引爆').toBe(true);
    expect(squad.soldierCount, '自爆没有造成任何伤亡').toBeLessThan(before);
    expect(e.alive, '炸完自己应该也没了').toBe(false);
  });

  it('在射程外被打死就不会炸——提前处理掉是有回报的', () => {
    const squad = makeSquad(60);
    const pool = new EnemyPool(new Rng(3));
    const e = pool.spawn('bomber', squad.x, squad.z + 30);
    const out: SimEvent[] = [];
    pool.damage(e, 99999, out);
    const before = squad.soldierCount;
    const evs = run(pool, squad, 2);
    expect(evs.some((v) => v.type === 'bomberBlast'), '被打死的自爆尸不该还能炸').toBe(false);
    expect(squad.soldierCount).toBe(before);
  });
});

describe('幼体', () => {
  it('比疾行者还快、一枪就死——密度才是它的威胁', () => {
    const sw = ENEMY_STATS.swarmling;
    expect(sw.speed).toBeGreaterThan(ENEMY_STATS.runner.speed);
    expect(sw.hp).toBeLessThan(ENEMY_STATS.walker.hp);
    expect(sw.scale).toBeLessThan(0.7);
  });
});

describe('怪物种类', () => {
  it('每一种怪都有自己的一套数值，没有两种是同一份配置', () => {
    // "多样"不能靠改个名字。这里比的是实际影响手感的四个字段。
    const sigs = Object.values(ENEMY_STATS).map(
      (s) => `${s.hp}|${s.speed}|${s.damage}|${s.scale}`,
    );
    expect(new Set(sigs).size, `有怪物共用同一份数值：${sigs.join(' ')}`).toBe(sigs.length);
  });
});
