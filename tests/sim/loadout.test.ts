import { describe, expect, it } from 'vitest';
import { LOADOUT, UPGRADES, type UpgradeId } from '../../src/config/balance';
import { World } from '../../src/sim/World';
import { LEVELS_MAX_UPGRADES, playSmart } from './fixtures';

/**
 * 出征装备位的回归测试。
 *
 * 用户的原话是"商店的东西一旦买完就太厉害了，没什么意思了"——这确实是当时的
 * 事实：六个升级全买满之后，每一局在开打之前就已经赢了，关卡里所有的取舍
 * 都失效。装备位把"拥有"和"生效"拆开之后，这里要守住三件事：
 *
 *  1. 满配 + 一套好装备能通关（不能因为加了限制就变成打不过）；
 *  2. 满配 + 一套坏装备打不过（买满不等于无敌）；
 *  3. **不止一套**能赢的组合（否则只是把唯一解从"全买"换成了"背板"）。
 */

/** 用共用的选门机器人把一局跑完，返回结局。 */
function play(levelId: number, loadout: readonly UpgradeId[], seed = 3): string {
  return playSmart(levelId, LEVELS_MAX_UPGRADES, loadout, seed).w.phase;
}

/** 几套写死的构筑，覆盖"基础流"和三条专精流。 */
const BUILDS: Record<string, UpgradeId[]> = {
  正规军: ['squad', 'damage', 'fireRate', 'weapon', 'cannon'],
  重炮流: ['heavyGuns', 'cannon', 'damage', 'armor', 'weapon'],
  人海流: ['horde', 'squad', 'armor', 'fireRate', 'weapon'],
  突击流: ['vanguard', 'damage', 'weapon', 'fireRate', 'squad'],
  摸鱼流: ['scavenger', 'strikeSpec', 'vanguard', 'horde', 'heavyGuns'],
};

describe('出征装备位', () => {
  it('装备位数量是有限的，而且比模块总数少得多', () => {
    const equippable = UPGRADES.filter((u) => !u.passive).length;
    expect(LOADOUT.max).toBeLessThan(equippable);
    expect(LOADOUT.base).toBeGreaterThanOrEqual(3);
    expect(LOADOUT.max).toBeGreaterThanOrEqual(LOADOUT.base);
  });

  it('每一个专精模块都带一条真实的代价', () => {
    // 没有代价的"专精"只是更大的数字，构筑就退化成"挑最大的几个"
    const specialists = UPGRADES.filter((u) => u.drawback);
    expect(specialists.length, '一个带代价的模块都没有').toBeGreaterThanOrEqual(4);
    for (const def of specialists) expect(def.drawback!.length).toBeGreaterThan(0);
  });

  it('至少三套不同的构筑能打通第五关，而废构筑打不过', () => {
    const results = Object.fromEntries(
      Object.entries(BUILDS).map(([k, v]) => [k, play(5, v)]),
    );
    const winners = Object.entries(results).filter(([, r]) => r === 'won').map(([k]) => k);
    expect(winners.length, `能赢的构筑只有 ${winners.join('、') || '零'} 套`).toBeGreaterThanOrEqual(3);
    expect(results['摸鱼流'], '一套全是辅助模块的装备居然通关了').not.toBe('won');
  });

  it('满配也会因为带错装备而输——买满不等于无敌', () => {
    for (const lvl of [3, 4, 5]) {
      expect(play(lvl, BUILDS['摸鱼流']!), `第 ${lvl} 关：废装备居然赢了`).not.toBe('won');
    }
  });

  it('没带上场的模块一点用都没有', () => {
    // 同一份满配存档，一个带满、一个空手，起始兵力必须差出一大截
    const full = new World({ levelId: 1, upgrades: LEVELS_MAX_UPGRADES, loadout: ['squad'], seed: 1 });
    const empty = new World({ levelId: 1, upgrades: LEVELS_MAX_UPGRADES, loadout: [], seed: 1 });
    expect(full.squad.soldierCount).toBeGreaterThan(empty.squad.soldierCount);
  });
});
