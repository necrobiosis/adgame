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

/**
 * 末日基调：灰烬天空、烟霾滤过的暗橙太阳、压暗的地平线。
 * 前三关的默认天色，比 DAY 更"废土"，后两关的 CRIMSON 顺势成为
 * 更浓烈的末日——整局基调递进而不是割裂。
 */
export const APOCALYPSE: SkyTheme = {
  // 玩家反馈整体太暗——保留末日的暖灰/焦土色相，把明度整体提一档，
  // 太阳强度也从 5 提到 7.5，场景细节和角色要看得清楚，不只是"很阴沉"
  top: 0x4a4438,
  horizon: 0xa8875f,
  ground: 0x554c3f,
  fog: 0x8a7a5e,
  sun: 0xffc27a,
  ambient: 0x7a6f56,
  sunDir: [-0.4, 0.5, 0.38],
  sunIntensity: 7.5,
};

/**
 * 后两关的血色黄昏。
 *
 * 天空自己就是环境光源，所以这套配色只要一饱和，整个场景（桥、路面、士兵）
 * 都会被染成一片橘红，什么都分不出来。地平线色往灰里压、天顶留住冷色、
 * 环境光补一点中性蓝 —— 气氛还在，但物体各自的颜色读得出来。
 */
export const CRIMSON: SkyTheme = {
  top: 0x3a2a48,
  horizon: 0xc0785a,
  ground: 0x5a4442,
  fog: 0xa8806c,
  sun: 0xffd6ad,
  ambient: 0x7a8496,
  sunDir: [-0.5, 0.34, 0.4],
  sunIntensity: 6,
};

/**
 * 第二关 · 高架断层：钴蓝的病态晨雾，太阳被烟埋掉大半。
 * 比第一关更冷更沉，读起来像"天还没亮透就已经不对劲了"。
 */
export const FAULTLINE: SkyTheme = {
  top: 0x2f3a44,
  horizon: 0x7e8b86,
  ground: 0x40484a,
  fog: 0x6d7a76,
  sun: 0xd8d0a8,
  ambient: 0x6a7680,
  sunDir: [-0.34, 0.42, 0.42],
  sunIntensity: 5.5,
};

/**
 * 第三关 · 尸山阶梯：病态的黄绿腐气，天光被尸潮蒸腾的雾滤过。
 * 和这一关满地的尸液贴花是同一套色相。
 */
export const MIASMA: SkyTheme = {
  top: 0x3d4230,
  horizon: 0xa8a05c,
  ground: 0x4e4f38,
  fog: 0x86855a,
  sun: 0xe8dc8a,
  ambient: 0x6f7a52,
  sunDir: [-0.44, 0.46, 0.3],
  sunIntensity: 6.4,
};

/**
 * 第五关 · 世界终点：天被撕开，只剩冷紫的余光和一颗惨白的太阳。
 * 全局最暗、最不像"白天"的一关，但主光仍然够硬，角色轮廓不能糊掉。
 */
export const VOID_END: SkyTheme = {
  top: 0x241c33,
  horizon: 0x6b4a6e,
  ground: 0x38303f,
  fog: 0x5c4a63,
  sun: 0xf0e2ff,
  ambient: 0x6a5f84,
  sunDir: [-0.55, 0.3, 0.36],
  sunIntensity: 7,
};

/**
 * 五关各自的天色。
 *
 * 之前只有两套（1-3 一套、4-5 一套），五关看起来几乎一模一样——关卡名
 * 承诺了跨海大桥/高架断层/尸山阶梯/猩红黎明/世界终点，渲染层一个都没兑现。
 * 天空同时也是环境光源（PMREM），所以换一套天色，金属反射、雾、整体色调
 * 会一起变——这是拉开五关差距性价比最高的一处。
 */
export const LEVEL_SKIES: readonly SkyTheme[] = [APOCALYPSE, FAULTLINE, MIASMA, CRIMSON, VOID_END];

export function skyForLevel(id: number): SkyTheme {
  return LEVEL_SKIES[Math.max(0, Math.min(LEVEL_SKIES.length - 1, id - 1))]!;
}

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

  // 玩家反馈整体太暗——这两个是所有主题共用的基础环境光，调亮后 CRIMSON
  // 也跟着一起受益，不用每个主题各调一遍
  const hemi = new THREE.HemisphereLight(theme.horizon, theme.ambient, 0.32);
  const fill = new THREE.DirectionalLight(theme.ambient, 0.22);
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
