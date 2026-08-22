import { describe, expect, it } from 'vitest';
import { World } from '../../src/sim/World';
import { CANNON, LEVELS_MAX_UPGRADES, type UpgradeId } from './fixtures';
import type { GateSpec, WaveSpec } from '../../src/config/levels';
import { LANE_SIGN } from '../../src/sim/lanes';

/**
 * 难度曲线回归测试。
 * 这些断言锁住的是"游戏值不值得玩"：裸配打不过，满配打得过，
 * 而且每一关都必须能被打通。改 balance.ts / levels.ts 时这里会第一时间报警。
 */

const NONE: Record<UpgradeId, number> = { squad: 0, damage: 0, fireRate: 0, cannon: 0, armor: 0, weapon: 0 };

function laneProfile(w: WaveSpec) {
  let count = 0;
  let big = 0;
  for (const g of w.groups) {
    count += g.count;
    if (g.kind === 'brute' || g.kind === 'titan') big += g.count;
  }
  return { count, big, swarm: big === 0 };
}

/**
 * 一个"会玩的人"的策略，也是这个游戏想教会玩家的那条线：
 *   前期堆人头（人少的时候，兵力既是输出也是血条），
 *   兵力上来之后转去堆火力（后排火力衰减让堆人头收益递减），
 *   同分时让增益去克制它自己那条车道的怪。
 */
function scoreLane(gate: GateSpec, wave: WaveSpec, n: number): number {
  const p = laneProfile(wave);
  const wantBodies = n < 90;
  let s = 0;
  switch (gate.type) {
    case 'add': s = wantBodies ? 20 + gate.value / 60 : 6; break;
    case 'mul': s = wantBodies ? 22 + gate.value : 7; break;
    case 'weapon': s = wantBodies ? 8 : 20 + gate.value * 2; break;
    case 'cannon': s = (wantBodies ? 6 : 14) + (p.swarm ? 3 : 0); break;
    case 'firerate': s = wantBodies ? 6 : 12; break;
    case 'armor': s = 5; break;
    case 'gold': s = 2; break;
    case 'sub': s = -2 - gate.value / 20; break;
    case 'div': s = -4; break;
  }
  return s - p.count / 400 - p.big * 0.3;
}

function play(levelId: number, upgrades: Record<UpgradeId, number>, seed = 3) {
  const w = new World({ levelId, upgrades, seed });
  const dt = 1 / 60;
  let t = 0;
  while (w.phase === 'running' && t < 240) {
    const next = w.gates.find((g) => !g.taken && g.z > w.squad.z);
    let want = LANE_SIGN.left * 6;
    if (next) {
      const n = w.squad.soldierCount;
      const side = scoreLane(next.left.gate, next.left.wave, n) >= scoreLane(next.right.gate, next.right.wave, n) ? 'left' : 'right';
      want = LANE_SIGN[side] * 6;
    }
    w.steer = Math.abs(want - w.squad.x) > 0.3 ? Math.sign(want - w.squad.x) : 0;
    w.step(dt);
    w.drainEvents();
    t += dt;
  }
  return { w, t };
}

describe('难度曲线', () => {
  it('每一关在满配下都能打通', () => {
    for (const lvl of [1, 2, 3, 4, 5]) {
      const { w } = play(lvl, LEVELS_MAX_UPGRADES);
      expect(w.phase, `第 ${lvl} 关满配应当能通关`).toBe('won');
    }
  });

  it('裸配打不过后面的关卡（否则升级系统就没有意义）', () => {
    for (const lvl of [3, 4, 5]) {
      const { w } = play(lvl, NONE);
      expect(w.phase, `第 ${lvl} 关裸配不应当通关`).toBe('lost');
    }
  });

  it('每一局都会在合理时间内结束，不会打成僵局', () => {
    for (const lvl of [1, 3, 5]) {
      for (const up of [NONE, LEVELS_MAX_UPGRADES]) {
        const { w, t } = play(lvl, up);
        expect(w.phase).not.toBe('running');
        expect(t, `第 ${lvl} 关不应当超过 150 秒`).toBeLessThan(150);
      }
    }
  });

  it('大炮溅射参数没有被改成负数/零', () => {
    expect(CANNON.splashRadius).toBeGreaterThan(1);
    expect(CANNON.damage).toBeGreaterThan(0);
  });
});
