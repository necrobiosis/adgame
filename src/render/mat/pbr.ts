import * as THREE from 'three';
import {
  SURF_FRAG,
  SURF_NORMAL_FRAG,
  SURF_PARS_FRAG,
  SURF_PARS_VERT,
  SURF_VERT,
  surfaceUniforms,
  type SurfaceOptions,
} from './triplanar';

export interface IndustrialOptions extends SurfaceOptions {
  /** 基础色。几何体自带顶点色时会与之相乘。 */
  color?: number;
  roughness?: number;
  metalness?: number;
  /** 几何体是否带顶点色（硬表面资产基本都带）。 */
  vertexColors?: boolean;
  /**
   * 额外的基础色贴图（走常规 UV，不是三平面）。
   * 留给那些"图案本身是美术内容"的表面 —— 比如路面的车道线，
   * 这种东西必须精确对位，不能交给三平面去投影。
   */
  map?: THREE.Texture;
  flatShading?: boolean;
  side?: THREE.Side;
}

let cacheKeySeq = 0;

/**
 * 工业硬表面材质。
 *
 * 在 MeshStandardMaterial 上注入三平面细节 + 烘焙 AO + 边缘磨损。
 * 项目里所有金属、混凝土、涂装件都走这个工厂，保证质感是同一套规则算出来的。
 */
export function industrial(o: IndustrialOptions = {}): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: o.map ?? null,
    color: o.color ?? 0xffffff,
    roughness: o.roughness ?? 0.62,
    metalness: o.metalness ?? 0.35,
    vertexColors: o.vertexColors ?? true,
    flatShading: o.flatShading ?? false,
    side: o.side ?? THREE.FrontSide,
  });

  const uniforms = surfaceUniforms(o);
  mat.userData.surfaceUniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SURF_PARS_VERT}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${SURF_VERT}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURF_PARS_FRAG}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SURF_NORMAL_FRAG}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SURF_FRAG}`);
  };

  // 同一套注入逻辑但 uniform 不同的材质必须各自编译，否则 three 会复用错误的 program
  const key = `industrial-${cacheKeySeq++}`;
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** 常用材质预设。数值上克制 —— 磨损要"可信"，不是"从废料场拖出来的"。 */
export const PRESET = {
  /** 涂装钢：护栏、桁架、机械外壳。 */
  paintedSteel: (color: number, wear = 0.35): IndustrialOptions => ({
    color,
    roughness: 0.52,
    metalness: 0.25,
    wear,
    grunge: 0.32,
    scratch: 0.3,
    triScale: 0.8,
    detail: 0.24,
  }),
  /** 裸钢 / 机加工件：炮管、销轴、铰链。 */
  bareSteel: (color = 0x8d949c): IndustrialOptions => ({
    color,
    roughness: 0.38,
    metalness: 0.85,
    wear: 0.4,
    grunge: 0.18,
    scratch: 0.45,
    triScale: 1.1,
    detail: 0.3,
  }),
  /** 混凝土：护栏、桥墩。 */
  concrete: (color = 0xb9b7ad): IndustrialOptions => ({
    color,
    roughness: 0.94,
    metalness: 0.02,
    wear: 0.1,
    wearColor: 0xa8a49a,
    grunge: 0.45,
    grungeColor: 0x4a453d,
    scratch: 0.08,
    triScale: 0.5,
    detail: 0.32,
  }),
  /** 沥青路面。 */
  asphalt: (color = 0x5a5c62): IndustrialOptions => ({
    color,
    roughness: 0.96,
    metalness: 0.0,
    wear: 0.06,
    grunge: 0.3,
    grungeColor: 0x3a3c40,
    scratch: 0.05,
    triScale: 0.9,
    detail: 0.2,
  }),
  /** 黄金 / 黄铜：装甲方块、金锭。 */
  gold: (color = 0xd9a326): IndustrialOptions => ({
    color,
    roughness: 0.26,
    metalness: 0.95,
    wear: 0.45,
    wearColor: 0xffe9a8,
    grunge: 0.14,
    scratch: 0.5,
    triScale: 1.0,
    detail: 0.26,
  }),
} as const;
