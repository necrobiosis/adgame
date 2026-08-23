export { CANNON } from '../../src/config/balance';
export type { UpgradeId } from '../../src/config/balance';
import { UPGRADES, type UpgradeId } from '../../src/config/balance';

/**
 * 造一份升级表：没写的补 0。
 *
 * 加了专精模块之后手写字面量每次都要补齐十几个字段，改一次配置所有测试
 * 一起编译不过——这里统一收口。
 */
export function upgrades(partial: Partial<Record<UpgradeId, number>> = {}): Record<UpgradeId, number> {
  const u = {} as Record<UpgradeId, number>;
  for (const def of UPGRADES) u[def.id] = partial[def.id] ?? 0;
  return u;
}

/** 什么都没买。 */
export const NO_UPGRADES: Record<UpgradeId, number> = upgrades();

/** 商店全满时的升级等级。 */
export const LEVELS_MAX_UPGRADES: Record<UpgradeId, number> = (() => {
  const u = {} as Record<UpgradeId, number>;
  for (const def of UPGRADES) u[def.id] = def.maxLevel;
  return u;
})();

/**
 * 满配玩家的标准出征装备（五个位子，能带的最强的一套通用 build）。
 *
 * 商店买满 ≠ 全部生效——加了装备位之后，"满配"必须连同带哪五个模块一起说，
 * 否则这句话没有意义。
 */
export const BEST_LOADOUT: readonly UpgradeId[] = ['squad', 'damage', 'fireRate', 'weapon', 'cannon'];

/**
 * 一套"买满了但带错了"的装备。
 *
 * 全是不提供直接战力的模块 + 带负面的专精。它必须打不过——这是"商店买满
 * 就无敌"这个问题的回归守卫：如果这套也能通关，说明装备位没有真正约束住
 * meta 成长。
 */
export const BAD_LOADOUT: readonly UpgradeId[] = ['scavenger', 'strikeSpec', 'vanguard', 'horde', 'heavyGuns'];

// ── 会玩的人：共用的操控机器人 ────────────────────────────────

import { World } from '../../src/sim/World';
import { LANE_SIGN } from '../../src/sim/lanes';
import type { GateSpec, WaveSpec } from '../../src/config/levels';

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
 * 一个"会玩的人"的选门策略，也是这个游戏想教会玩家的那条线：
 *   前期堆人头（人少的时候，兵力既是输出也是血条），
 *   兵力上来之后转去堆火力（后排火力衰减让堆人头收益递减），
 *   同分时让增益去克制它自己那条车道的怪。
 */
export function scoreLane(gate: GateSpec, wave: WaveSpec, n: number, gold = Infinity): number {
  // 买不起就等于这条车道什么都不给——牌子上写着价钱，真人不会往上撞
  if ((gate.cost ?? 0) > gold) return -99;
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

/** 用上面那套策略把一整局跑完。 */
export function playSmart(
  levelId: number,
  ups: Record<UpgradeId, number>,
  loadout: readonly UpgradeId[] = BEST_LOADOUT,
  seed = 3,
): { w: World; t: number } {
  const w = new World({ levelId, upgrades: ups, loadout, seed });
  const dt = 1 / 60;
  let t = 0;
  while (w.phase === 'running' && t < 240) {
    const next = w.gates.find((g) => !g.taken && g.z > w.squad.z);
    let want = LANE_SIGN.left * 6;
    if (next) {
      const n = w.squad.soldierCount;
      const side = scoreLane(next.left.gate, next.left.wave, n, w.gold)
        >= scoreLane(next.right.gate, next.right.wave, n, w.gold) ? 'left' : 'right';
      want = LANE_SIGN[side] * 6;
    }
    w.steer = Math.abs(want - w.squad.x) > 0.3 ? Math.sign(want - w.squad.x) : 0;
    w.step(dt);
    w.drainEvents();
    t += dt;
  }
  return { w, t };
}
