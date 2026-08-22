import * as THREE from 'three';

/**
 * 天空 + 光照 + 基于图像的环境光。
 *
 * 关键点：环境光不是外挂一张不相干的 HDRI，而是**把这片天空自己渲进立方图再做
 * PMREM**。金属反射到的就是玩家眼前的这片天，天色一换（第四五关的猩红天）
 * 所有金属件的反射会跟着一起变 —— 这是场景色调统一的根本。
 */

export interface SkyTheme {
  top: number;
  horizon: number;
  ground: number;
  fog: number;
  sun: number;
  ambient: number;
  /** 太阳方向（会被归一化）。 */
  sunDir: [number, number, number];
  /** 太阳本体的亮度倍率，决定金属上的高光有多硬。 */
  sunIntensity: number;
}

export const DAY: SkyTheme = {
  top: 0x2f6fb5,
  horizon: 0xbcd4e6,
  ground: 0x8fa3b0,
  fog: 0xc3d6e4,
  sun: 0xfff4de,
  ambient: 0x94b2cc,
  sunDir: [-0.45, 0.62, 0.34],
  sunIntensity: 9,
};

export const CRIMSON: SkyTheme = {
  top: 0x2a1230,
  horizon: 0xd9663a,
  ground: 0x4a2a2a,
  fog: 0xc06a44,
  sun: 0xffcb92,
  ambient: 0x9a5f6a,
  sunDir: [-0.5, 0.3, 0.4],
  sunIntensity: 7,
};

/** 天空球。太阳本体画在着色器里，这样 PMREM 之后金属上才有像样的高光。 */
export function createSky(theme: SkyTheme): THREE.Mesh {
  const dir = new THREE.Vector3(...theme.sunDir).normalize();
  const geo = new THREE.SphereGeometry(900, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(theme.top) },
      uHorizon: { value: new THREE.Color(theme.horizon) },
      uGround: { value: new THREE.Color(theme.ground) },
      uSunColor: { value: new THREE.Color(theme.sun) },
      uSunDir: { value: dir },
      uSunIntensity: { value: theme.sunIntensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop, uHorizon, uGround, uSunColor, uSunDir;
      uniform float uSunIntensity;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = d.y > 0.0
          ? mix(uHorizon, uTop, pow(clamp(d.y, 0.0, 1.0), 0.55))
          : mix(uHorizon, uGround, pow(clamp(-d.y, 0.0, 1.0), 0.4));

        // 太阳本体 + 周围的辉光。本体给硬高光，辉光给柔和的方向性环境光。
        float cd = max(0.0, dot(d, normalize(uSunDir)));
        float disc = smoothstep(0.9975, 0.9993, cd);
        float glow = pow(cd, 220.0) * 0.5 + pow(cd, 12.0) * 0.14;
        c += uSunColor * (disc * uSunIntensity + glow);

        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

export interface SceneLights {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  all: THREE.Object3D[];
}

/**
 * 场景光照。
 * 有了真正的环境光之后，直接光可以调得柔和许多 —— 补光只用来托一下背光面，
 * 剩下的交给天空。
 */
export function createLights(theme: SkyTheme, shadowMapSize: number): SceneLights {
  const dir = new THREE.Vector3(...theme.sunDir).normalize();
  const sun = new THREE.DirectionalLight(theme.sun, 2.1);
  sun.position.copy(dir).multiplyScalar(60);

  if (shadowMapSize > 0) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const cam = sun.shadow.camera;
    // 阴影相机只罩住"方阵 + 前方一段"这块真正要看的区域。
    // 之前开到 68×66，1024 的贴图摊下来一个 texel 有 6.6 厘米，
    // 路面在斜射阳光下整片自遮挡 —— 表现出来就是方阵周围一大块死黑。
    cam.near = 20;
    cam.far = 150;
    cam.left = -17;
    cam.right = 17;
    cam.top = 30;
    cam.bottom = -20;
    cam.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    // normalBias 要和 texel 的世界尺寸同量级才压得住自遮挡
    sun.shadow.normalBias = (34 / shadowMapSize) * 2.5;
  }

  const hemi = new THREE.HemisphereLight(theme.horizon, theme.ambient, 0.2);
  const fill = new THREE.DirectionalLight(theme.ambient, 0.14);
  fill.position.set(-dir.x * 40, 18, -dir.z * 40);

  return { sun, hemi, fill, all: [sun, sun.target, hemi, fill] };
}

/**
 * 把天空渲成环境贴图。
 * 用一个只装了天空球的临时场景过 PMREM —— 比手动搭立方体渲染目标干净得多。
 */
export function createSkyEnvironment(renderer: THREE.WebGLRenderer, theme: SkyTheme): THREE.WebGLRenderTarget {
  const scene = new THREE.Scene();
  const sky = createSky(theme);
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0, 1, 2000);
  pmrem.dispose();
  sky.geometry.dispose();
  (sky.material as THREE.Material).dispose();
  // 返回整个 render target 而不只是 texture —— 切关时要把它整个释放掉
  return target;
}
