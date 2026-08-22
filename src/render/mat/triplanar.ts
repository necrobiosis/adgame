import * as THREE from 'three';
import { detailPack } from './procTex';

/**
 * 三平面映射 + 表面属性的着色器片段。
 *
 * 为什么必须三平面：这个项目里的几何体全是程序化拼接再合并出来的，UV 是一团乱麻，
 * 展 UV 既不现实也不值得。三平面映射直接用位置坐标从三个方向投影采样，绕开展 UV 这件事 ——
 * 没有它，程序化资产根本贴不上任何细节贴图。
 *
 * 同时这里也负责消费 deform.ts 烘进 `aSurf` 的两个通道：
 *   x = AO（凹处压暗）    y = 边缘磨损（棱上掉漆露金属）
 *
 * `pbr.ts`（硬表面）和 `CrowdMaterial.ts`（角色）共用这套片段，保证两边的
 * 表面质感是同一套规则算出来的。
 */

export interface SurfaceOptions {
  /** 贴图在世界单位上的重复频率，越大纹理越细。 */
  triScale?: number;
  /**
   * 法线细节强度 0..1。
   * 这是**在真实面法线之上叠一层扰动**的权重，不是替换 —— 开太大表面就不朝向
   * 它本来该朝的方向了，太阳照不到，整块资产会发黑。0.15~0.35 是合理区间。
   */
  detail?: number;
  /** 脏污量 0..1。 */
  grunge?: number;
  /** 脏污颜色。 */
  grungeColor?: number;
  /** 划痕量 0..1。 */
  scratch?: number;
  /** 边缘磨损量 0..1（会被 aSurf.y 调制）。 */
  wear?: number;
  /** 磨损露出的金属色。 */
  wearColor?: number;
  /** 烘焙 AO 的强度 0..1。 */
  ao?: number;
}

export function surfaceUniforms(o: SurfaceOptions = {}): Record<string, THREE.IUniform> {
  const pack = detailPack();
  return {
    tNormal: { value: pack.normal },
    tGrunge: { value: pack.grunge },
    tScratch: { value: pack.scratch },
    uTriScale: { value: o.triScale ?? 0.7 },
    uDetail: { value: o.detail ?? 0.22 },
    uGrunge: { value: o.grunge ?? 0.3 },
    uGrungeColor: { value: new THREE.Color(o.grungeColor ?? 0x2b2621) },
    uScratch: { value: o.scratch ?? 0.25 },
    uWear: { value: o.wear ?? 0.3 },
    uWearColor: { value: new THREE.Color(o.wearColor ?? 0xb9bec6) },
    uAO: { value: o.ao ?? 0.85 },
  };
}

/** 顶点着色器：声明。 */
export const SURF_PARS_VERT = /* glsl */ `
attribute vec2 aSurf;
uniform float uTriScale;
varying vec3 vTriP;
varying vec3 vTriN;
varying vec2 vSurf;
`;

/**
 * 顶点着色器：算出三平面坐标与法线。
 *
 * 要点是**把实例变换算进去**：实例化的螺栓、梁、角色如果都用同一份局部坐标采样，
 * 每个实例的纹理会一模一样，成排摆开一眼就看出是复制的。带上实例位移之后
 * 每个实例落在贴图的不同位置，重复感自然消失。
 *
 * 必须插在 `<beginnormal_vertex>` 之后（此时 objectNormal 已就位）。
 */
export const SURF_VERT = /* glsl */ `
vec3 triP = position;
vec3 triN = objectNormal;
#ifdef USE_INSTANCING
  mat3 triIM = mat3(instanceMatrix);
  triN = normalize(triIM * triN);
  triP = (instanceMatrix * vec4(position, 1.0)).xyz;
#endif
vTriP = triP * uTriScale;
vTriN = triN;
vSurf = aSurf;
`;

/** 片元着色器：声明 + 三平面采样函数。 */
export const SURF_PARS_FRAG = /* glsl */ `
// three 只在顶点着色器的前缀里声明 normalMatrix，片元着色器里必须自己声明一次。
// 渲染器是按名字往 program 上传这个矩阵的，所以声明了就能拿到值。
// 少了这一行，整个材质会静默地编译失败。
uniform mat3 normalMatrix;
uniform sampler2D tNormal;
uniform sampler2D tGrunge;
uniform sampler2D tScratch;
uniform float uDetail;
uniform float uGrunge;
uniform vec3  uGrungeColor;
uniform float uScratch;
uniform float uWear;
uniform vec3  uWearColor;
uniform float uAO;
varying vec3 vTriP;
varying vec3 vTriN;
varying vec2 vSurf;

vec3 triBlend(vec3 n) {
  vec3 b = pow(abs(n), vec3(4.0));
  return b / max(1e-4, b.x + b.y + b.z);
}

float triSampleR(sampler2D t, vec3 p, vec3 b) {
  return texture2D(t, p.yz).r * b.x + texture2D(t, p.xz).r * b.y + texture2D(t, p.xy).r * b.z;
}

// whiteout 混合：把三个方向的切线空间法线叠到面法线上，接缝处不会出现硬边
vec3 triNormal(vec3 p, vec3 n, vec3 b) {
  vec3 nx = texture2D(tNormal, p.yz).xyz * 2.0 - 1.0;
  vec3 ny = texture2D(tNormal, p.xz).xyz * 2.0 - 1.0;
  vec3 nz = texture2D(tNormal, p.xy).xyz * 2.0 - 1.0;
  nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
  ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
  nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
  return normalize(nx.zyx * b.x + ny.xzy * b.y + nz.xyz * b.z);
}
`;

/**
 * 片元着色器：把表面细节作用到漫反射 / 粗糙度 / 金属度上。
 *
 * 插在 `<metalnessmap_fragment>` 之后 —— 那时 diffuseColor、roughnessFactor、
 * metalnessFactor 都已经就位，正好在这里统一调制。
 *
 * 磨损的物理依据：棱角处的漆先被磨掉，露出的金属**更亮、更光滑、金属度更高**。
 * 幅度上限压得比较克制，避免整个场景像刚从废料场拖出来。
 */
export const SURF_FRAG = /* glsl */ `
{
  vec3 triB = triBlend(normalize(vTriN));
  float ao = mix(1.0, vSurf.x, uAO);
  float wear = clamp(vSurf.y * uWear, 0.0, 1.0);

  float dirt = triSampleR(tGrunge, vTriP * 0.35, triB);
  float scr = triSampleR(tScratch, vTriP * 1.7, triB);

  // 脏污优先堆在被遮挡的凹处，这才是灰尘真实的堆积方式
  float dirtAmt = uGrunge * dirt * mix(1.0, 0.35, vSurf.x);
  diffuseColor.rgb = mix(diffuseColor.rgb, uGrungeColor, dirtAmt * 0.75);
  diffuseColor.rgb *= ao;

  // 棱上掉漆
  diffuseColor.rgb = mix(diffuseColor.rgb, uWearColor, wear * 0.55);

  roughnessFactor = clamp(
    mix(roughnessFactor, roughnessFactor * 0.42, wear) + dirtAmt * 0.22 - scr * uScratch * 0.28,
    0.04, 1.0);
  metalnessFactor = clamp(mix(metalnessFactor, 1.0, wear * 0.6) - dirtAmt * 0.15, 0.0, 1.0);
}
`;

/** 片元着色器：用三平面法线扰动几何法线。插在 `<normal_fragment_maps>` 之后。 */
export const SURF_NORMAL_FRAG = /* glsl */ `
{
  vec3 triB = triBlend(normalize(vTriN));
  vec3 pert = triNormal(vTriP, normalize(vTriN), triB);
  vec3 objN = normalize(mix(normalize(vTriN), pert, uDetail));
  normal = normalize(normalMatrix * objN);
}
`;

/**
 * 把几何体准备成能直接喂给 `industrial()` 的状态。
 *
 * 补两样东西，缺一个都会静默地把资产渲成黑的：
 *   · `aSurf` —— 缺了着色器读到 (0,0)，AO 当成全遮挡，整块变剪影
 *   · `color` —— `industrial()` 默认开 vertexColors，缺了顶点色属性时
 *     WebGL 给的默认值是 (0,0,0)，漫反射直接乘成黑色
 *
 * 这两个坑都不报错、不打日志，只是画面变黑，所以统一在这里兜住。
 */
export function ensureSurf(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  if (!geo.attributes.aSurf) {
    const arr = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      arr[i * 2] = 1; // 无遮挡
      arr[i * 2 + 1] = 0; // 无磨损
    }
    geo.setAttribute('aSurf', new THREE.BufferAttribute(arr, 2));
  }
  if (!geo.attributes.color) {
    const arr = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  return geo;
}
