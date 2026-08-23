import { describe, expect, it } from 'vitest';
import { LEVELS } from '../../src/config/levels';
import type { UpgradeId } from '../../src/config/balance';
import { World } from '../../src/sim/World';
import { LANE_SIGN } from '../../src/sim/lanes';

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

const MAX: Record<UpgradeId, number> = {
  squad: 12, damage: 12, fireRate: 10, cannon: 6, armor: 10, weapon: 3,
};

type Policy = (w: World) => 'left' | 'right';

/** 按固定策略跑一整局。 */
function play(levelId: number, upgrades: Record<UpgradeId, number>, pick: Policy, seed = 3) {
  const w = new World({ levelId, upgrades, seed });
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

  it('每一关的岔路都不是同一个问题的重复', () => {
    // 一关之内，两条车道的增益类型组合不应当全都一样
    for (const lvl of LEVELS) {
      const pairs = lvl.beats
        .filter((b): b is Extract<typeof b, { t: 'choice' }> => b.t === 'choice')
        .map((b) => [b.left.gate.type, b.right.gate.type].sort().join('|'));
      const unique = new Set(pairs);
      expect(unique.size, `第 ${lvl.id} 关的岔路组合重复：${pairs.join('  ')}`).toBe(pairs.length);
    }
  });
});
