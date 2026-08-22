/**
 * 车道左右 ↔ 世界 x 的映射。
 *
 * 镜头是站在方阵后面、沿 +z 方向往前看的。在这种取景下，世界坐标的 **+x
 * 会出现在屏幕左侧**（相机基向量 x_cam = -x_world）。关卡数据里写的 left /
 * right 指的是玩家在屏幕上看到的左右，所以两者之间必须过这一层换算 ——
 * 否则玩家往左拖，吃到的却是右边那道门的增益和右边车道的怪。
 *
 * 所有"屏幕左右 → 世界 x"的转换都只走这里，不要在别处再写一遍符号。
 */

export type Side = 'left' | 'right';

/** 屏幕上的这一侧，对应世界 x 的正负。 */
export const LANE_SIGN: Record<Side, 1 | -1> = { left: 1, right: -1 };

/** 方阵在这个 x 上，算站在屏幕的哪一侧。 */
export function sideAtX(x: number): Side {
  return x >= 0 ? 'left' : 'right';
}

/** 玩家往屏幕右边拖 d 像素当量时，世界 x 应该怎么变。 */
export function screenDeltaToWorldX(d: number): number {
  return -d;
}
