import * as THREE from 'three';

/**
 * 人群材质。
 *
 * 走路动画整个在 vertex shader 里做：每个顶点知道自己属于哪个部位（aPart）
 * 和该部位的关节轴心（aPivot），每个实例带一个相位（aPhase）。于是上千只
 * 僵尸可以共用一个 InstancedMesh、一次 draw call 画完，而且每只的步伐都
 * 不同步 —— 这是能还原广告里"尸潮铺满整条桥"密度的关键。
 *
 * 每实例还带：
 *   aAnimSpeed 步频      aState 0=行走 1=攻击
 *   aDeath     0..1 倒地  aFlash 受击闪白      aTint 体色
 */
export function createCrowdMaterial(opts?: { roughness?: number; metalness?: number; emissive?: number }): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: opts?.roughness ?? 0.86,
    metalness: opts?.metalness ?? 0.04,
    emissive: new THREE.Color(opts?.emissive ?? 0x000000),
  });

  mat.userData.uniforms = { uTime: { value: 0 } };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = mat.userData.uniforms.uTime;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        attribute float aPart;
        attribute vec3  aPivot;
        attribute float aPhase;
        attribute float aAnimSpeed;
        attribute float aState;
        attribute float aDeath;
        attribute float aFlash;
        attribute vec3  aTint;
        varying float vFlash;
        varying vec3  vTint;

        vec3 rotX(vec3 v, float a) {
          float c = cos(a), s = sin(a);
          return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
        }

        // 该顶点所属部位这一刻的摆动角度
        float limbAngle(float part, float ph) {
          float sw = sin(ph);
          float a = 0.0;
          if (part > 3.5) {
            a = (part < 4.5 ? sw : -sw) * 0.78;          // 腿：左右反相
          } else if (part > 1.5) {
            a = (part < 2.5 ? -sw : sw) * 0.5;           // 臂：与同侧腿反相
          }
          // 攻击时双臂改成前后猛挥
          if (aState > 0.5 && part > 1.5 && part < 3.5) {
            a = -1.15 + sin(ph * 3.0) * 0.75;
          }
          return a;
        }
        `,
      )
      .replace(
        '#include <beginnormal_vertex>',
        /* glsl */ `
        #include <beginnormal_vertex>
        float aPh = aPhase + uTime * aAnimSpeed;
        float aAng = limbAngle(aPart, aPh);
        objectNormal = rotX(objectNormal, aAng);
        if (aDeath > 0.0) objectNormal = rotX(objectNormal, -1.45 * aDeath);
        `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        #include <begin_vertex>
        // 四肢绕关节摆动
        vec3 rel = transformed - aPivot;
        transformed = aPivot + rotX(rel, aAng);
        // 躯干和头随步伐上下起伏
        if (aPart < 1.5) {
          transformed.y += abs(sin(aPh)) * 0.035;
          transformed.z += sin(aPh * 2.0) * 0.012;
        }
        // 倒地：整个身体绕脚底往前翻
        if (aDeath > 0.0) {
          transformed = rotX(transformed, -1.45 * aDeath);
          transformed.y -= aDeath * 0.12;
        }
        vFlash = aFlash;
        vTint = aTint;
        `,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying float vFlash;\nvarying vec3 vTint;',
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        diffuseColor.rgb *= vTint;
        // 受击提亮。注意大型敌人会被持续命中（vFlash 常驻 1），
        // 所以这里必须是"保持色相地提亮"，而不是往纯白插值 —— 否则 Boss 会糊成一团白。
        vec3 hit = clamp(diffuseColor.rgb * 2.6 + 0.16, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, hit, vFlash * 0.55);
        `,
      );
  };

  // 让 three 认得这是不同的 program
  mat.customProgramCacheKey = () => 'crowd-v1';
  return mat;
}

export function updateCrowdTime(mat: THREE.MeshStandardMaterial, t: number): void {
  const u = mat.userData.uniforms as { uTime: { value: number } } | undefined;
  if (u) u.uTime.value = t;
}
