import * as THREE from 'three';
import { BONE_COUNT, SKELETON_GLSL } from './skeleton';
import {
  SURF_FRAG,
  SURF_NORMAL_FRAG,
  SURF_PARS_FRAG,
  surfaceUniforms,
  type SurfaceOptions,
} from '../mat/triplanar';

/**
 * 人群材质。
 *
 * 动画全部在顶点着色器里做：每顶点带两根骨骼与权重（`aSkin`），每实例带
 * 相位、状态、倒地进度等（实例属性）。于是几百个角色可以共用一个
 * InstancedMesh、一次 draw call 画完，而且每个的步伐互不同步 ——
 * 这是尸潮密度的技术前提。
 *
 * 表面质感复用 mat/triplanar 的那套片段，和硬表面资产是同一套规则：
 * 三平面细节法线 + 边缘磨损。三平面坐标用**静止姿态**的位置，
 * 所以纹理是长在皮肤上的，不会随着动作在身上流动。
 */

/** 顶点着色器公共声明。 */
const SKIN_PARS = /* glsl */ `
${SKELETON_GLSL}
uniform float uTime;
attribute vec4 aSkin;
attribute float aPhase;
attribute float aAnimSpeed;
attribute float aState;
attribute float aDeath;
`;

/** 只把顶点蒙皮到当前姿态 —— 深度通道要的全部内容。 */
const SKIN_POSITION = /* glsl */ `
  float phase = aPhase + uTime * aAnimSpeed;
  vec3 skinned = boneApply(int(aSkin.x + 0.5), position, phase, aState) * aSkin.z
               + boneApply(int(aSkin.y + 0.5), position, phase, aState) * aSkin.w;
  skinned.y += abs(sin(phase)) * 0.028;
  if (aDeath > 0.0) {
    skinned = rotX(-1.45 * aDeath) * skinned;
    skinned.y -= aDeath * 0.12;
  }
`;

const VERT_PARS = /* glsl */ `
${SKELETON_GLSL}
uniform float uTime;
attribute vec4 aSkin;      // x,y = 骨骼索引  z,w = 权重
attribute vec2 aSurf;
attribute float aPhase;
attribute float aAnimSpeed;
attribute float aState;    // 0 = 行走, 1 = 攻击
attribute float aDeath;    // 0..1 倒地进度
attribute float aFlash;
attribute vec3  aTint;
uniform float uTriScale;
varying vec3 vTriP;
varying vec3 vTriN;
varying vec2 vSurf;
varying float vFlash;
varying vec3  vTint;
`;

/**
 * 顶点变换主体（主材质用）。
 *
 * 法线的处理是关键：用**偏移法**求蒙皮后的法线 —— 把"顶点"和"顶点沿法线
 * 偏移一点"各自过一遍蒙皮，两者之差就是变形后的法线方向。这样不用在着色器里
 * 求逆转置矩阵，对纯旋转的骨骼完全准确。
 *
 * 注意：这一整套**不能**照搬进深度着色器。阴影通道只需要位置，把法线求解和
 * 一堆用不上的 varying 一起塞进去，会让整个阴影贴图算错 —— 表现为方阵周围
 * 一大片死黑。深度通道用上面精简的 SKIN_POSITION。
 */
const VERT_BODY = /* glsl */ `
  float phase = aPhase + uTime * aAnimSpeed;
  int bA = int(aSkin.x + 0.5);
  int bB = int(aSkin.y + 0.5);

  vec3 skinned = boneApply(bA, position, phase, aState) * aSkin.z
               + boneApply(bB, position, phase, aState) * aSkin.w;

  vec3 offset = position + objectNormal * 0.02;
  vec3 skinnedOff = boneApply(bA, offset, phase, aState) * aSkin.z
                  + boneApply(bB, offset, phase, aState) * aSkin.w;
  vec3 skinNormal = normalize(skinnedOff - skinned);

  // 行走时整体上下起伏
  skinned.y += abs(sin(phase)) * 0.028;

  // 倒地：整个身体绕脚底往前翻
  if (aDeath > 0.0) {
    float a = -1.45 * aDeath;
    mat3 r = rotX(a);
    skinned = r * skinned;
    skinNormal = r * skinNormal;
    skinned.y -= aDeath * 0.12;
  }

  // 三平面坐标用静止姿态的位置，纹理才不会随动作在身上流动；
  // 法线必须用蒙皮之后的，否则四肢转起来光照不跟着走
  vTriP = position * uTriScale;
  vTriN = skinNormal;
  vSurf = aSurf;
  vFlash = aFlash;
  vTint = aTint;
`;

export interface CrowdMaterialOptions extends SurfaceOptions {
  roughness?: number;
  metalness?: number;
  emissive?: number;
  /**
   * 熔纹发光：精英/Boss 专用。复用已经烘进 `aSurf.y` 的边缘凸度数据——凸起的
   * 棱线（角、爪、背刺、盔甲接缝，本来就是磨损集中的地方）叠加一层脉动的
   * 自发光，读起来像"皮肤裂开露出熔岩纹路"。不需要新顶点属性或新烘焙步骤。
   */
  crackGlow?: boolean;
  /** 裂纹发光的颜色。 */
  crackColor?: number;
  /** 裂纹发光的强度。 */
  crackStrength?: number;
}

export interface CrowdMaterialSet {
  /** 主材质。 */
  material: THREE.MeshStandardMaterial;
  /** 阴影专用的深度材质 —— 没有它，投影会是静止姿态的剪影。 */
  depthMaterial: THREE.MeshDepthMaterial;
  /** 骨骼轴心，几何体换了要跟着更新。 */
  setPivots(pivots: Float32Array): void;
  setTime(t: number): void;
}

let seq = 0;

export function createCrowdMaterial(opts: CrowdMaterialOptions = {}): CrowdMaterialSet {
  const shared = {
    uTime: { value: 0 },
    uPivot: { value: makePivotArray() },
  };
  const surf = surfaceUniforms({
    triScale: opts.triScale ?? 1.6,
    detail: opts.detail ?? 0.25,
    grunge: opts.grunge ?? 0.35,
    grungeColor: opts.grungeColor ?? 0x2a2620,
    scratch: opts.scratch ?? 0.2,
    wear: opts.wear ?? 0.22,
    wearColor: opts.wearColor ?? 0xc8c2b4,
    ao: opts.ao ?? 0.5,
  });

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts.roughness ?? 0.82,
    metalness: opts.metalness ?? 0.06,
    emissive: new THREE.Color(opts.emissive ?? 0x000000),
  });

  const crackUniforms = opts.crackGlow
    ? {
        uCrackColor: { value: new THREE.Color(opts.crackColor ?? 0xff5a1a) },
        uCrackStrength: { value: opts.crackStrength ?? 1.4 },
      }
    : null;

  const key = `crowd-${seq++}${opts.crackGlow ? '-crack' : ''}`;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared, surf);
    if (crackUniforms) Object.assign(shader.uniforms, crackUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERT_BODY}\n  objectNormal = skinNormal;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = skinned;');

    // 注意：每个 chunk 标记在模板里只出现一次，字符串替换一旦命中就"消耗"掉
    // 那个标记——同一个 chunk 不能在两条独立的 .replace() 链里各命中一次，
    // 后一条会找不到目标、静默不生效。裂纹发光需要的 uniform 声明必须和
    // SURF_PARS_FRAG 一起塞进同一次对 `#include <common>` 的替换里。
    const crackDecl = crackUniforms
      ? '\nuniform vec3 uCrackColor;\nuniform float uCrackStrength;\nuniform float uTime;'
      : '';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${SURF_PARS_FRAG}\nvarying float vFlash;\nvarying vec3 vTint;${crackDecl}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${SURF_NORMAL_FRAG}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SURF_FRAG}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        diffuseColor.rgb *= vTint;
        // 受击提亮。大型敌人会被持续命中（vFlash 常驻 1），所以这里必须是
        // "保持色相地提亮"而不是往纯白插值 —— 否则 Boss 会糊成一团白。
        vec3 hit = clamp(diffuseColor.rgb * 1.9 + 0.08, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, hit, vFlash * 0.45);
        `,
      );

    if (crackUniforms) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `
        #include <emissivemap_fragment>
        {
          // 只在磨损/凸起集中的棱线上发光：vSurf.y 越接近 1 越是棱角
          float crack = pow(clamp(vSurf.y, 0.0, 1.0), 2.4);
          float pulse = 0.65 + 0.35 * sin(uTime * 2.4 + vSurf.x * 6.0);
          totalEmissiveRadiance += uCrackColor * crack * uCrackStrength * pulse;
        }
        `,
      );
    }
  };
  material.customProgramCacheKey = () => key;

  // 阴影用的深度材质必须跑同一套顶点变换，否则投在地上的是静止姿态的影子
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depthMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIN_PARS}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SKIN_POSITION}\n  transformed = skinned;`);
  };
  depthMaterial.customProgramCacheKey = () => `${key}-depth`;

  return {
    material,
    depthMaterial,
    setPivots(p) {
      shared.uPivot.value = toVectors(p);
    },
    setTime(t) {
      shared.uTime.value = t;
    },
  };
}

function makePivotArray(): THREE.Vector3[] {
  return Array.from({ length: BONE_COUNT }, () => new THREE.Vector3());
}

function toVectors(p: Float32Array): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < BONE_COUNT; i++) out.push(new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]));
  return out;
}
