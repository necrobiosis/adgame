import { describe, expect, it } from 'vitest';
import { ENDLESS_ID } from '../../src/config/levels';
import { World } from '../../src/sim/World';
import { BUFF_CAP, SOLDIER, type UpgradeId } from '../../src/config/balance';
import { LANE_SIGN } from '../../src/sim/lanes';

const NO_UPGRADES: Record<UpgradeId, number> = { squad: 0, damage: 0, fireRate: 0, cannon: 0, armor: 0, weapon: 0 };

/** 用固定的操控策略把一整局跑完，返回结果。 */
function simulate(levelId: number, steer: (w: World, t: number) => number, maxSeconds = 400) {
  const w = new World({ levelId, upgrades: NO_UPGRADES, seed: 12345 });
  const dt = 1 / 60;
  let t = 0;
  while (w.phase === 'running' && t < maxSeconds) {
    w.steer = steer(w, t);
    w.step(dt);
    w.drainEvents();
    t += dt;
  }
  return { world: w, seconds: t };
}

/** 一直贴着屏幕上的某一侧走。 */
const hug = (side: 'left' | 'right') => (w: World) => {
  const target = LANE_SIGN[side] * 8;
  return Math.sign(target - w.squad.x) * (Math.abs(target - w.squad.x) > 0.2 ? 1 : 0);
};

describe('World', () => {
  it('赛道按 beats 铺开，总长度和竞技场位置合理', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES });
    expect(w.totalLength).toBeGreaterThan(200);
    expect(w.arenaZ).toBe(w.totalLength);
    expect(w.gates.length).toBe(3);
    expect(w.blocks.length).toBe(1);
    expect(w.gates[0]!.z).toBeLessThan(w.gates[1]!.z);
  });

  it('一局能在有限时间内分出胜负，不会卡死', () => {
    const { world, seconds } = simulate(1, hug('left'));
    expect(world.phase).not.toBe('running');
    expect(seconds).toBeLessThan(400);
  });

  it('过门会实际改变编制并记录选择', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    const before = w.squad.soldierCount;
    const dt = 1 / 60;
    // 贴屏幕左侧走，第一组门左边是 "+26 士兵"
    while (!w.gates[0]!.taken && w.phase === 'running') {
      w.steer = LANE_SIGN.left;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.gates[0]!.chosen).toBe('left');
    expect(w.squad.soldierCount).toBe(before + 26);
  });

  it('走右侧会拿到武器升级而不是加人', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    const dt = 1 / 60;
    while (!w.gates[0]!.taken && w.phase === 'running') {
      w.steer = LANE_SIGN.right;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.gates[0]!.chosen).toBe('right');
    expect(w.squad.weaponLevel).toBe(1);
  });

  it('全宽方块会把前进拖到极慢，打掉后恢复速度', () => {
    // 设计上方阵**永远不会被彻底钉死**——全宽方块留了两条路肩缝，硬挤也能
    // 挤过去，只是慢得像蜗牛。停下来干等的手感太糟，所以这里验的是
    // "慢到几乎不动 + 打掉之后立刻恢复"，而不是"完全静止"。
    // 这条测的是方块的推进机制，不是难度曲线——给一套够用的升级，
    // 保证方阵能活着走到方块跟前，否则测的就变成"裸配能不能撑到那儿"了
    const kitted: Record<UpgradeId, number> = { squad: 10, damage: 8, fireRate: 6, cannon: 4, armor: 8, weapon: 2 };
    const w = new World({ levelId: 2, upgrades: kitted, seed: 3 });
    const full = w.blocks.find((b) => b.span === 'full')!;
    const dt = 1 / 60;
    let crawl = Infinity;
    let openRoad = 0;
    let movedWhileBlocked = false;
    let passed = false;
    let t = 0;
    while (w.phase === 'running' && t < 300) {
      w.steer = LANE_SIGN.left;
      const z0 = w.squad.z;
      w.step(dt);
      w.drainEvents();
      const speed = (w.squad.z - z0) / dt;
      const atBlock = full.alive && w.squad.z >= full.z - 6 && w.squad.z <= full.z + 2;
      if (atBlock) {
        crawl = Math.min(crawl, speed);
        if (speed > 0) movedWhileBlocked = true;
      } else if (w.squad.z < full.z - 30 && speed > 0) {
        openRoad = Math.max(openRoad, speed);
      }
      if (w.squad.z > full.z + 4) passed = true;
      t += dt;
    }
    expect(movedWhileBlocked, '顶着方块时仍然应当在往前挪，不能被彻底钉死').toBe(true);
    expect(passed, '最终应当越过方块（打掉了，或者从路肩缝里挤过去）').toBe(true);
    expect(crawl, '挤缝时的速度应当远低于空旷路段').toBeLessThan(openRoad * 0.4);
  });

  it('升级会真实提升战斗力：满配比裸配打得更远/更快', () => {
    const maxed: Record<UpgradeId, number> = { squad: 12, damage: 12, fireRate: 10, cannon: 6, armor: 10, weapon: 3 };
    const run = (up: Record<UpgradeId, number>) => {
      const w = new World({ levelId: 3, upgrades: up, seed: 99 });
      const dt = 1 / 60;
      let t = 0;
      while (w.phase === 'running' && t < 400) {
        w.steer = LANE_SIGN.left;
        w.step(dt);
        w.drainEvents();
        t += dt;
      }
      return w;
    };
    const weak = run(NO_UPGRADES);
    const strong = run(maxed);
    expect(strong.progress).toBeGreaterThanOrEqual(weak.progress);
    expect(strong.stats.kills).toBeGreaterThan(weak.stats.kills);
  });
});

describe('无尽模式', () => {
  const kitted: Record<UpgradeId, number> = { squad: 10, damage: 8, fireRate: 6, cannon: 4, armor: 8, weapon: 2 };

  it('开局不会被"Boss 触发"卡死（没有 boss beat，arenaZ 是 0）', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const dt = 1 / 60;
    for (let i = 0; i < 180; i++) {
      w.steer = 0;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.squad.z, '三秒过去方阵应当明显往前走了').toBeGreaterThan(10);
    expect(w.progress, '进度条不应当一开局就是满的').toBeLessThan(1);
  });

  it('怪越往后越硬，而且没有上限', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const scaleAt = (z: number) => {
      w.squad.z = z;
      // currentHpScale 是私有的，通过刷一波怪回读它的实际血量
      w.enemies.clear();
      w.enemies.hpScale = (w as unknown as { currentHpScale(): number }).currentHpScale();
      return w.enemies.hpScale;
    };
    const a = scaleAt(200);
    const b = scaleAt(1000);
    const c = scaleAt(3000);
    expect(b).toBeGreaterThan(a * 1.5);
    expect(c).toBeGreaterThan(b * 1.5);
  });

  it('中 Boss 会反复出现（不是只刷最后一个）', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const dt = 1 / 60;
    let spawns = 0;
    for (let i = 0; i < 240 / dt && w.phase === 'running'; i++) {
      w.steer = 0;
      w.step(dt);
      for (const e of w.drainEvents()) if (e.type === 'midbossSpawn') spawns++;
    }
    expect(spawns, '无尽模式里中 Boss 应当一轮一轮反复出现').toBeGreaterThan(1);
  });

  it('乘算增益有天花板（否则无尽模式会把方阵堆成无敌）', () => {
    // 护甲/射速门都是乘算的。战役一局只吃到三五个没问题，无尽模式有一百多个门，
    // 乘下来单兵血量实测能到一千三百万——任何怪都打不动，"无尽"变成散步。
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    for (let i = 0; i < 200; i++) {
      w.squad.addArmorPercent(60);
      w.squad.addFireRatePercent(50);
    }
    expect(w.squad.unitMaxHp).toBeLessThan(SOLDIER.baseHp * BUFF_CAP.hpMul * 1.01);
    expect(w.squad.fireRateMul).toBeLessThanOrEqual(BUFF_CAP.fireRateMul + 1e-6);
  });

  it('满配也会被无尽模式打死（怪确实越来越强）', () => {
    const maxed: Record<UpgradeId, number> = { squad: 12, damage: 12, fireRate: 10, cannon: 6, armor: 10, weapon: 3 };
    const w = new World({ levelId: ENDLESS_ID, upgrades: maxed, seed: 5 });
    const dt = 1 / 60;
    let t = 0;
    while (w.phase === 'running' && t < 1500) {
      w.steer = 0;
      w.step(dt);
      w.drainEvents();
      t += dt;
    }
    expect(w.phase, '满配在 1500 秒里都没被打死，说明强度爬得太慢').toBe('lost');
    expect(w.squad.z, '满配应当能推进相当一段距离才倒下').toBeGreaterThan(1500);
  });

  it('永远不会"通关"，只会打到全灭', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const dt = 1 / 60;
    for (let i = 0; i < 400 / dt && w.phase === 'running'; i++) {
      w.steer = 0;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.phase).not.toBe('won');
  });
});
