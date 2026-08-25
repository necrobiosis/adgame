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
import { laneAtX, laneCenterX, type Lane } from '../../src/sim/lanes';
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

/**
 * 用上面那套策略把一整局跑完。
 *
 * 机器人要模拟的是"一个会玩的人"，而路被切成三排之后，走位同时要服务三件
 * 互相冲突的事：站到门的那一侧、站进怪最多的那一排、站到奖励墙那一排上。
 * 一个只会追着门跑的机器人会一路站在空排里眼睁睁看着尸潮从隔壁走过来——
 * 那测出来的是"机器人不会玩"，不是"这一关难不难"。
 *
 * 优先级按"来不及了没"排：门快到了先去门口（错过就没得选），其次是够得着的
 * 奖励墙，平时就待在怪最多的那一排开火。
 */
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
    w.steer = Math.sign(steerTarget(w) - w.squad.x);
    if (Math.abs(steerTarget(w) - w.squad.x) <= 0.3) w.steer = 0;
    w.step(dt);
    w.drainEvents();
    t += dt;
  }
  return { w, t };
}

/** 这一帧想站到哪个 x。 */
function steerTarget(w: World): number {
  const gate = w.gates.find((g) => !g.taken && g.z > w.squad.z);
  // 门口 40 米内：先把位置站对，错过就没得选了
  if (gate && gate.z - w.squad.z < 40) {
    const n = w.squad.soldierCount;
    const side = scoreLane(gate.left.gate, gate.left.wave, n, w.gold)
      >= scoreLane(gate.right.gate, gate.right.wave, n, w.gold) ? 'left' : 'right';
    return laneCenterX(side);
  }
  // 够得着的奖励墙：兵力够厚才值得进去挨那一段慢速
  const wall = w.blocks.find((b) => b.alive && b.bonus > 0 && b.z > w.squad.z && b.z - w.squad.z < 46);
  if (wall && w.squad.soldierCount >= 120) return laneCenterX(wall.lane);
  // 平时：站到怪最多的那一排上，火力才有地方去
  const count: Record<Lane, number> = { left: 0, mid: 0, right: 0 };
  for (const e of w.enemies.list) {
    if (!e.alive) continue;
    const dz = e.z - w.squad.z;
    if (dz < -2 || dz > 46) continue;
    count[laneAtX(e.x)]++;
  }
  let best: Lane = 'mid';
  for (const l of ['left', 'mid', 'right'] as const) if (count[l] > count[best]) best = l;
  return laneCenterX(best);
}
