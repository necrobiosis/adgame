import { describe, expect, it } from 'vitest';
import { BEST_LOADOUT, CANNON, LEVELS_MAX_UPGRADES, NO_UPGRADES, playSmart, type UpgradeId } from './fixtures';

/**
 * 难度曲线回归测试。
 * 这些断言锁住的是"游戏值不值得玩"：裸配打不过，满配打得过，
 * 而且每一关都必须能被打通。改 balance.ts / levels.ts 时这里会第一时间报警。
 */

const NONE = NO_UPGRADES;

/** 满配 + 一套通用的好装备，跑一整局。 */
function play(
  levelId: number,
  upgrades: Record<UpgradeId, number>,
  seed = 3,
  loadout: readonly UpgradeId[] = BEST_LOADOUT,
) {
  return playSmart(levelId, upgrades, loadout, seed);
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
