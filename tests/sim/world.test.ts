import { describe, expect, it } from 'vitest';
import { World } from '../../src/sim/World';
import type { UpgradeId } from '../../src/config/balance';

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

/** 一直贴着某一侧走。 */
const hug = (side: -1 | 1) => (w: World) => {
  const target = side * 8;
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
    const { world, seconds } = simulate(1, hug(-1));
    expect(world.phase).not.toBe('running');
    expect(seconds).toBeLessThan(400);
  });

  it('过门会实际改变编制并记录选择', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    const before = w.squad.soldierCount;
    const dt = 1 / 60;
    // 贴左走，第一组门左边是 "+10 士兵"
    while (!w.gates[0]!.taken && w.phase === 'running') {
      w.steer = -1;
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
      w.steer = 1;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.gates[0]!.chosen).toBe('right');
    expect(w.squad.weaponLevel).toBe(1);
  });

  it('全宽方块会挡住前进，打掉后放行', () => {
    const w = new World({ levelId: 2, upgrades: NO_UPGRADES, seed: 3 });
    const full = w.blocks.find((b) => b.span === 'full')!;
    const dt = 1 / 60;
    let stalled = false;
    let released = false;
    let t = 0;
    while (w.phase === 'running' && t < 300) {
      w.steer = -1;
      const z0 = w.squad.z;
      w.step(dt);
      w.drainEvents();
      if (full.alive && w.squad.z >= full.z - 6 && w.squad.z - z0 < 1e-6) stalled = true;
      if (stalled && !full.alive && w.squad.z > full.z) released = true;
      t += dt;
    }
    expect(stalled).toBe(true);
    expect(released).toBe(true);
  });

  it('升级会真实提升战斗力：满配比裸配打得更远/更快', () => {
    const maxed: Record<UpgradeId, number> = { squad: 12, damage: 12, fireRate: 10, cannon: 6, armor: 10, weapon: 3 };
    const run = (up: Record<UpgradeId, number>) => {
      const w = new World({ levelId: 3, upgrades: up, seed: 99 });
      const dt = 1 / 60;
      let t = 0;
      while (w.phase === 'running' && t < 400) {
        w.steer = -1;
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
