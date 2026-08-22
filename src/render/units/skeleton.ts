import * as THREE from 'three';

/**
 * 角色骨架。
 *
 * 旧版动画是按"部位 id"做刚性旋转：一个顶点整个属于大臂或整个属于躯干，
 * 关节处直接是两块几何体硬碰硬。方块角色看不出问题，一旦形体变成圆滑的
 * 放样体，肩、肘、膝就会当场撕开一道缝。
 *
 * 这里换成每顶点 2 根骨骼的权重混合：关节附近的顶点同时受父子两根骨骼影响，
 * 弯曲时表面连续过渡。代价只是多两个顶点属性，仍然是一次 draw call。
 */

export const BONE = {
  PELVIS: 0,
  CHEST: 1,
  HEAD: 2,
  ARM_L: 3,
  FORE_L: 4,
  ARM_R: 5,
  FORE_R: 6,
  THIGH_L: 7,
  SHIN_L: 8,
  THIGH_R: 9,
  SHIN_R: 10,
} as const;

export const BONE_COUNT = 11;

/** 父骨骼索引，-1 表示根。 */
export const BONE_PARENT: readonly number[] = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9];

/** 一根骨骼在静止姿态下的线段（关节点 → 末端）。 */
export interface BoneSegment {
  head: THREE.Vector3;
  tail: THREE.Vector3;
}

export type Skeleton = BoneSegment[];

export interface Proportions {
  /** 总身高。 */
  height: number;
  /** 体宽倍率。 */
  build: number;
  /** 躯干前倾（驼背）。 */
  hunch: number;
}

/**
 * 按身材比例算出静止姿态的骨架。
 * 几何体和着色器都从这里取轴心，两边必须是同一份数据，否则蒙皮会错位。
 */
export function buildSkeleton(p: Proportions): Skeleton {
  const H = p.height;
  const B = p.build;
  const hipY = H * 0.47;
  const chestY = hipY + H * 0.17;
  const shoulderY = hipY + H * 0.31;
  const neckY = hipY + H * 0.36;
  const headTop = H;
  const legX = H * 0.062 * B;
  const shoulderX = H * 0.115 * B;
  const kneeY = hipY * 0.5;
  const elbowY = shoulderY - H * 0.16;
  const handY = shoulderY - H * 0.32;
  // 驼背让胸腔和头往前挪
  const lean = Math.sin(p.hunch);

  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const s: Skeleton = [];
  s[BONE.PELVIS] = { head: v(0, hipY, 0), tail: v(0, chestY, lean * H * 0.04) };
  s[BONE.CHEST] = { head: v(0, chestY, lean * H * 0.04), tail: v(0, neckY, lean * H * 0.1) };
  s[BONE.HEAD] = { head: v(0, neckY, lean * H * 0.1), tail: v(0, headTop, lean * H * 0.12) };
  s[BONE.ARM_L] = { head: v(-shoulderX, shoulderY, lean * H * 0.07), tail: v(-shoulderX, elbowY, lean * H * 0.07) };
  s[BONE.FORE_L] = { head: v(-shoulderX, elbowY, lean * H * 0.07), tail: v(-shoulderX, handY, lean * H * 0.07) };
  s[BONE.ARM_R] = { head: v(shoulderX, shoulderY, lean * H * 0.07), tail: v(shoulderX, elbowY, lean * H * 0.07) };
  s[BONE.FORE_R] = { head: v(shoulderX, elbowY, lean * H * 0.07), tail: v(shoulderX, handY, lean * H * 0.07) };
  s[BONE.THIGH_L] = { head: v(-legX, hipY, 0), tail: v(-legX, kneeY, 0) };
  s[BONE.SHIN_L] = { head: v(-legX, kneeY, 0), tail: v(-legX, 0, 0) };
  s[BONE.THIGH_R] = { head: v(legX, hipY, 0), tail: v(legX, kneeY, 0) };
  s[BONE.SHIN_R] = { head: v(legX, kneeY, 0), tail: v(legX, 0, 0) };
  return s;
}

/** 骨骼的旋转轴心 = 它的关节点。着色器按这个数组做层级变换。 */
export function pivots(skel: Skeleton): Float32Array {
  const out = new Float32Array(BONE_COUNT * 3);
  for (let i = 0; i < BONE_COUNT; i++) {
    out[i * 3] = skel[i]!.head.x;
    out[i * 3 + 1] = skel[i]!.head.y;
    out[i * 3 + 2] = skel[i]!.head.z;
  }
  return out;
}

/**
 * 按距离自动绑定蒙皮权重。
 *
 * 对每个顶点，在**候选骨骼**里找最近的两根线段，按距离反比分配权重。
 * 候选集是建模时给的（比如头盔只可能绑到头和胸），这样就不会出现
 * "手垂在大腿边上于是被大腿拽着走"这种经典穿帮。
 */
export function assignSkin(
  geo: THREE.BufferGeometry,
  skel: Skeleton,
  candidates: readonly number[],
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const skin = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  const list = candidates.length > 0 ? candidates : Array.from({ length: BONE_COUNT }, (_, i) => i);

  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    let bestA = list[0]!;
    let bestB = list[0]!;
    let dA = Infinity;
    let dB = Infinity;
    for (const b of list) {
      const d = distanceToSegment(p, skel[b]!.head, skel[b]!.tail);
      if (d < dA) {
        dB = dA; bestB = bestA;
        dA = d; bestA = b;
      } else if (d < dB) {
        dB = d; bestB = b;
      }
    }
    // 反距离权重。加一个小常数避免贴着骨线的顶点权重爆掉，
    // 也让关节附近有一段真正的混合区而不是硬切换。
    const eps = 1e-3;
    const wA = 1 / (dA + eps);
    const wB = list.length > 1 && Number.isFinite(dB) ? 1 / (dB + eps) : 0;
    const sum = wA + wB;
    skin[i * 4] = bestA;
    skin[i * 4 + 1] = bestB;
    skin[i * 4 + 2] = wA / sum;
    skin[i * 4 + 3] = wB / sum;
  }
  geo.setAttribute('aSkin', new THREE.BufferAttribute(skin, 4));
  return geo;
}

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 1e-12 ? THREE.MathUtils.clamp((apx * abx + apy * aby + apz * abz) / len2, 0, 1) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 骨架求值的 GLSL。
 *
 * 每根骨骼只绕自己的 X 轴转（前后摆），层级关系靠"从叶子往根逐级施加旋转"
 * 来实现 —— 先绕自己的轴心转，再绕父骨骼的轴心转，以此类推。这等价于矩阵
 * 链乘，但不需要真的在着色器里乘矩阵。
 */
export const SKELETON_GLSL = /* glsl */ `
uniform vec3 uPivot[${BONE_COUNT}];

const int BONE_PELVIS = 0;
const int BONE_CHEST = 1;
const int BONE_HEAD = 2;
const int BONE_ARM_L = 3;
const int BONE_FORE_L = 4;
const int BONE_ARM_R = 5;
const int BONE_FORE_R = 6;
const int BONE_THIGH_L = 7;
const int BONE_SHIN_L = 8;
const int BONE_THIGH_R = 9;
const int BONE_SHIN_R = 10;

int boneParent(int b) {
  if (b == BONE_CHEST || b == BONE_THIGH_L || b == BONE_THIGH_R) return BONE_PELVIS;
  if (b == BONE_HEAD || b == BONE_ARM_L || b == BONE_ARM_R) return BONE_CHEST;
  if (b == BONE_FORE_L) return BONE_ARM_L;
  if (b == BONE_FORE_R) return BONE_ARM_R;
  if (b == BONE_SHIN_L) return BONE_THIGH_L;
  if (b == BONE_SHIN_R) return BONE_THIGH_R;
  return -1;
}

// state: 0 = 行走，1 = 攻击
float boneAngle(int b, float ph, float state) {
  float sw = sin(ph);
  if (b == BONE_THIGH_L) return sw * 0.72;
  if (b == BONE_THIGH_R) return -sw * 0.72;
  // 膝盖只能往一个方向弯
  if (b == BONE_SHIN_L)  return -max(0.0, -sin(ph + 0.9)) * 1.05;
  if (b == BONE_SHIN_R)  return -max(0.0,  sin(ph + 0.9)) * 1.05;
  if (b == BONE_ARM_L)   return mix(-sw * 0.42, -1.05 + sin(ph * 3.0) * 0.45, state);
  if (b == BONE_ARM_R)   return mix( sw * 0.42, -1.05 + sin(ph * 3.0 + 1.7) * 0.45, state);
  if (b == BONE_FORE_L)  return -0.3 - max(0.0,  sw) * 0.32 - state * 0.35;
  if (b == BONE_FORE_R)  return -0.3 - max(0.0, -sw) * 0.32 - state * 0.35;
  if (b == BONE_CHEST)   return sin(ph * 2.0) * 0.04;
  if (b == BONE_HEAD)    return -sin(ph * 2.0) * 0.055;
  return 0.0;
}

mat3 rotX(float a) {
  float c = cos(a), s = sin(a);
  return mat3(1.0, 0.0, 0.0,
              0.0,   c,   s,
              0.0,  -s,   c);
}

/** 把顶点按骨骼 b 所在的整条链变换到当前姿态。 */
vec3 boneApply(int b, vec3 p, float ph, float state) {
  int cur = b;
  // 链最深是 3 级（骨盆 → 大臂 → 小臂），循环上限给 4 保险
  for (int i = 0; i < 4; i++) {
    if (cur < 0) break;
    vec3 pv = uPivot[cur];
    p = pv + rotX(boneAngle(cur, ph, state)) * (p - pv);
    cur = boneParent(cur);
  }
  return p;
}
`;
