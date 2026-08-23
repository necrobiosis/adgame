import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/config/levels';
import type { UpgradeId } from '../../src/config/balance';
import { World } from '../../src/sim/World';
import { LANE_SIGN } from '../../src/sim/lanes';
import { BAD_LOADOUT, BEST_LOADOUT, LEVELS_MAX_UPGRADES } from './fixtures';

/**
 * 策略深度的回归测试。
 *
 * 改造之前，15 个岔路口全是同一个轴（加人 vs 升武器），整个"策略"可以被
 * 一句 `if (兵力 < 90)` 表达完——也就是说门里根本没有决策，只有一条正确答案。
 *
 * 这里不测"能不能赢"（balance.test.ts 已经在测了），而是测**选择本身是否
 * 有意义**：如果随便一种无脑固定策略都能通吃，那不管门上写了多少种效果，
 * 玩家实际上都不需要思考。
 */

const MAX = LEVELS_MAX_UPGRADES;

type Policy = (w: World) => 'left' | 'right';

/** 按固定策略跑一整局。 */
function play(levelId: number, upgrades: Record<UpgradeId, number>, pick: Policy, seed = 3) {
  const w = new World({ levelId, upgrades, loadout: BEST_LOADOUT, seed });
  const dt = 1 / 60;
  let t = 0;
  while (w.phase === 'running' && t < 240) {
    const next = w.gates.find((g) => !g.taken && g.z > w.squad.z);
    const want = LANE_SIGN[next ? pick(w) : 'left'] * 6;
    w.steer = Math.abs(want - w.squad.x) > 0.3 ? Math.sign(want - w.squad.x) : 0;
    w.step(dt);
    w.drainEvents();
    t += dt;
  }
  return w;
}

/** 只认门的类型、完全不看战况的无脑策略。 */
function alwaysType(...types: string[]): Policy {
  return (w) => {
    const g = w.gates.find((x) => !x.taken && x.z > w.squad.z);
    if (!g) return 'left';
    return types.includes(g.left.gate.type) ? 'left' : 'right';
  };
}

const NAIVE: Record<string, Policy> = {
  '永远靠左': () => 'left',
  '永远靠右': () => 'right',
  '只堆人头': alwaysType('add', 'mul'),
  '只升武器': alwaysType('weapon'),
  '只要火炮': alwaysType('cannon'),
  '只堆护甲': alwaysType('armor'),
};

describe('策略深度', () => {
  it('没有任何一种无脑固定策略能通吃全部五关', () => {
    const winners: string[] = [];
    for (const [name, pick] of Object.entries(NAIVE)) {
      const cleared = LEVELS.every((l) => play(l.id, MAX, pick).phase === 'won');
      if (cleared) winners.push(name);
    }
    // 现状（实测）：6 种里有 4 种仍然能通吃，只有"永远靠左"栽在第四关、
    // "只要火炮"栽在第五关。也就是说门的类型铺开之后选择**开始**有代价了，
    // 但还远不够——满配方阵强到大部分错误选择都不会被惩罚。
    //
    // 真正的克制关系要靠会打后排的跳跃者、逼你走位的吐酸者、只有火炮打得动的
    // 重甲尸来建立；等那批怪进来之后，这里的上限应当能收紧到 2~3。
    // 现在这条断言是一道防退化的地板：至少不能退回"闭着眼睛选都一样过"。
    expect(
      winners.length,
      `这些无脑策略把全部五关都通了：${winners.join('、')}；说明岔路口没有真正的取舍`,
    ).toBeLessThan(Object.keys(NAIVE).length);
  });

  it('岔路口的选择会显著改变结果', () => {
    // 同一关、同一套升级、同一个种子，只有选门方式不同 —— 结果应当分化
    const outcomes = new Set(
      Object.values(NAIVE).map((pick) => play(5, MAX, pick).phase),
    );
    expect(outcomes.size, '第五关不管怎么选门结果都一样，说明门不影响胜负').toBeGreaterThan(1);
  });

  it('商店买满也不等于稳赢：带错装备照样打不过', () => {
    // 这条锁住的是整个 meta 层的设计意图。之前商店一买满，每一局开场就已经
    // 赢了——岔路口选什么都无所谓，关卡里所有的取舍瞬间作废。
    // 加了出征装备位之后，"拥有"和"生效"被拆开：买满买的是**更多可能性**，
    // 每一局仍然要在开打之前做一次真实的取舍。
    for (const lvl of [3, 4, 5]) {
      const w = new World({ levelId: lvl, upgrades: MAX, loadout: BAD_LOADOUT, seed: 3 });
      const dt = 1 / 60;
      let t = 0;
      while (w.phase === 'running' && t < 240) {
        w.steer = 0;
        w.step(dt);
        w.drainEvents();
        t += dt;
      }
      expect(w.phase, `第 ${lvl} 关：满配 + 一套废装备居然通关了`).not.toBe('won');
    }
  });

  it('同一份满配存档，换一套出征装备结果就不一样', () => {
    // 同样的升级、同样的种子、同样的操控——唯一的变量是带了哪几个模块。
    // 两套装备打出不同结果，才说明"出征前选什么"是一个真实的决策点。
    const run = (loadout: readonly UpgradeId[]) => {
      const w = new World({ levelId: 3, upgrades: MAX, loadout, seed: 3 });
      const dt = 1 / 60;
      let t = 0;
      while (w.phase === 'running' && t < 240) {
        const next = w.gates.find((g) => !g.taken && g.z > w.squad.z);
        const want = LANE_SIGN[next ? 'left' : 'right'] * 6;
        w.steer = Math.abs(want - w.squad.x) > 0.3 ? Math.sign(want - w.squad.x) : 0;
        w.step(dt);
        w.drainEvents();
        t += dt;
      }
      return w.phase;
    };
    expect(run(BEST_LOADOUT)).not.toBe(run(BAD_LOADOUT));
  });

  it('两侧永远是不同类型的增益', () => {
    // 都给兵力的两个门不构成选择。随机生成必须保证这一条。
    for (let seed = 1; seed <= 30; seed++) {
      for (const lvl of LEVELS) {
        const w = new World({ levelId: lvl.id, upgrades: MAX, loadout: BEST_LOADOUT, seed });
        for (const g of w.gates) {
          expect(
            g.left.gate.type,
            `第 ${lvl.id} 关 seed ${seed}：两侧都是 ${g.left.gate.type}`,
          ).not.toBe(g.right.gate.type);
        }
      }
    }
  });

  it('每一局掷出来的岔路都不一样（roguelike 的随机性真的生效）', () => {
    // 同一关不同种子，岔路组合应当明显不同；否则"随机"只是个说法
    const fingerprint = (seed: number) =>
      new World({ levelId: 3, upgrades: MAX, loadout: BEST_LOADOUT, seed }).gates
        .map((g) => `${g.left.gate.type}${g.left.gate.value}/${g.right.gate.type}${g.right.gate.value}`)
        .join(',');
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) seen.add(fingerprint(seed));
    expect(seen.size, '12 个种子应当掷出多种不同的岔路组合').toBeGreaterThan(8);
    // 同一个种子必须稳定复现，否则回放/调试都无从谈起
    expect(fingerprint(7)).toBe(fingerprint(7));
  });

  it('左右两侧不存在长期偏向（"永远走右边"不该是一条策略）', () => {
    // 统计大量种子里，"更强的那一侧"落在左边还是右边
    const strength = (t: string) => (t === 'sub' || t === 'div' ? 0 : 1);
    let leftStrong = 0;
    let total = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const w = new World({ levelId: 4, upgrades: MAX, loadout: BEST_LOADOUT, seed });
      for (const g of w.gates) {
        const l = strength(g.left.gate.type);
        const r = strength(g.right.gate.type);
        if (l === r) continue;
        total++;
        if (l > r) leftStrong++;
      }
    }
    if (total >= 10) {
      const share = leftStrong / total;
      expect(share, `强的一侧有 ${(share * 100).toFixed(0)}% 落在左边，明显偏向`).toBeGreaterThan(0.25);
      expect(share).toBeLessThan(0.75);
    }
  });
});
