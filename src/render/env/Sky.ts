import * as THREE from 'three';

/**
 * 天空 + 雾。
 * 广告里是个阳光刺眼的白天，远处城市被雾吃掉一半 —— 雾在这里不只是气氛，
 * 它还负责把远处几百个建筑体块糊成剪影，省掉大量细节。
 */
export interface SkyTheme {
  top: number;
  horizon: number;
  ground: number;
  fog: number;
  sun: number;
  ambient: number;
}

export const DAY: SkyTheme = {
  top: 0x2f6fb5,
  horizon: 0xbcd4e6,
  ground: 0x8fa3b0,
  fog: 0xc3d6e4,
  sun: 0xfff4de,
  ambient: 0x94b2cc,
};

export const CRIMSON: SkyTheme = {
  top: 0x2a1230,
  horizon: 0xd9663a,
  ground: 0x4a2a2a,
  fog: 0xc06a44,
  sun: 0xffcb92,
  ambient: 0x9a5f6a,
};

export function createSky(theme: SkyTheme): THREE.Mesh {
  const geo = new THREE.SphereGeometry(900, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(theme.top) },
      uHorizon: { value: new THREE.Color(theme.horizon) },
      uGround: { value: new THREE.Color(theme.ground) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vWorld = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uGround;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        vec3 c = h > 0.0
          ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
          : mix(uHorizon, uGround, pow(clamp(-h, 0.0, 1.0), 0.4));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

export function createLights(theme: SkyTheme): THREE.Object3D[] {
  const sun = new THREE.DirectionalLight(theme.sun, 1.85);
  sun.position.set(-42, 70, 30);
  const hemi = new THREE.HemisphereLight(theme.horizon, theme.ambient, 0.42);
  // 一点点补光，避免面朝镜头的一侧全黑
  const fill = new THREE.DirectionalLight(theme.ambient, 0.18);
  fill.position.set(30, 20, -40);
  return [sun, hemi, fill];
}
