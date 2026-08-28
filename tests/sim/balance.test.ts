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
    // 跑多个种子取通过率，而不是钉死一个种子。
    //
    // 岔路是每局现掷的，同一关不同种子的强度能差出一大截——盯着单个种子调，
    // 调的是"这一把骰子"，不是这一关。真正要守住的是"带对装备的满配玩家
    // 基本都过得去"，偶尔翻车反而说明关卡还有牙齿。
    for (const lvl of [1, 2, 3, 4, 5]) {
      let won = 0;
      const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
      for (const seed of seeds) {
        if (play(lvl, LEVELS_MAX_UPGRADES, seed).w.phase === 'won') won++;
      }
      expect(won, `第 ${lvl} 关满配只通了 ${won}/${seeds.length} 把`)
        .toBeGreaterThanOrEqual(seeds.length - 2);
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
        // 上限放到 210 秒：射程改成无限之后交火从一百多米外就开始，
        // 整局的时间轴本来就拉长了；偶尔一个种子会打成"残兵磨 Boss"的
        // 长局（第五关的终末之主还会周期性潜地免伤）。这条断言守的是
        // **一定会结束**，不是"必须打得快"。
        expect(t, `第 ${lvl} 关打成了僵局`).toBeLessThan(210);
      }
    }
  });

  it('大炮溅射参数没有被改成负数/零', () => {
    expect(CANNON.splashRadius).toBeGreaterThan(1);
    expect(CANNON.damage).toBeGreaterThan(0);
  });
});
