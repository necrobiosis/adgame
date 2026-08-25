import { LANES, ROAD_HALF } from '../config/balance';

/**
 * 车道 ↔ 世界 x 的映射。
 *
 * 镜头是站在方阵后面、沿 +z 方向往前看的。在这种取景下，世界坐标的 **+x
 * 会出现在屏幕左侧**（相机基向量 x_cam = -x_world）。关卡数据里写的 left /
 * mid / right 指的是玩家在屏幕上看到的位置，所以两者之间必须过这一层换算 ——
 * 否则玩家往左拖，吃到的却是右边那道门的增益和右边车道的怪。
 *
 * 所有"屏幕位置 → 世界 x"的转换都只走这里，不要在别处再写一遍符号。
 */

export type Side = 'left' | 'right';

/** 三条车道。整条路被切成等宽的三排，一切东西都长在某一排上。 */
export type Lane = 'left' | 'mid' | 'right';

/** 屏幕上的这一侧，对应世界 x 的正负。 */
export const LANE_SIGN: Record<Side, 1 | -1> = { left: 1, right: -1 };

/** 一条车道有多宽。 */
export const LANE_WIDTH = (ROAD_HALF * 2) / LANES;

/** 按世界 x 从小到大排的三条车道（屏幕上从右往左）。 */
export const LANE_ORDER: readonly Lane[] = ['right', 'mid', 'left'];

/** 这条车道的中心线在世界 x 的哪里。 */
export function laneCenterX(lane: Lane): number {
  if (lane === 'mid') return 0;
  return LANE_SIGN[lane] * LANE_WIDTH;
}

/** 这条车道占据的世界 x 区间。 */
export function laneBounds(lane: Lane): [number, number] {
  const c = laneCenterX(lane);
  return [c - LANE_WIDTH / 2, c + LANE_WIDTH / 2];
}

/** 这个 x 落在哪条车道上。 */
export function laneAtX(x: number): Lane {
  if (x > LANE_WIDTH / 2) return 'left';
  if (x < -LANE_WIDTH / 2) return 'right';
  return 'mid';
}

/** 方阵在这个 x 上，算站在屏幕的哪一侧。 */
export function sideAtX(x: number): Side {
  return x >= 0 ? 'left' : 'right';
}

/** 玩家往屏幕右边拖 d 像素当量时，世界 x 应该怎么变。 */
export function screenDeltaToWorldX(d: number): number {
  return -d;
}
