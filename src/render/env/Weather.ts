import * as THREE from 'three';

/**
 * 天气：跟着镜头走的一片落下物。
 *
 * 末日基调之前完全没有天气——天上什么都不落，静得不像灾后。这里用一个
 * 实例化的四边形场，粒子在一个绕着镜头的盒子里循环：飘出盒子就从对面绕
 * 回来，所以永远只需要几百个实例就能填满整个视野，不用按赛道长度铺。
 *
 * 三种形态共用同一套几何和着色器，只是参数不同：
 *  - ash    落灰：慢、飘、灰白，横向摆动明显
 *  - ember  火星：慢、上下乱窜、橙红自发光，加色混合
 *  - rain   雨：快、笔直、拉成细长条
 */

export type WeatherKind = 'ash' | 'ember' | 'rain' | 'none';

interface WeatherSpec {
  count: number;
  color: number;
  /** 下落速度范围。 */
  fall: [number, number];
  size: [number, number];
  /** 纵向拉伸倍率（雨滴拉成条）。 */
  stretch: number;
  /** 横向飘摆幅度。 */
  sway: number;
  opacity: number;
  additive: boolean;
  /** 负数 = 往上飘（火星）。 */
  rise: number;
}

const SPECS: Record<Exclude<WeatherKind, 'none'>, WeatherSpec> = {
  ash:   { count: 520, color: 0xbdb6a6, fall: [1.4, 3.2], size: [0.05, 0.13], stretch: 1.6, sway: 1.5, opacity: 0.5,  additive: false, rise: 0 },
  ember: { count: 300, color: 0xff8c3a, fall: [0.5, 1.6], size: [0.05, 0.12], stretch: 2.4, sway: 1.1, opacity: 0.95, additive: true,  rise: 1.4 },
  rain:  { count: 700, color: 0x9fb4c4, fall: [22, 34],   size: [0.03, 0.06], stretch: 16,  sway: 0.2, opacity: 0.34, additive: false, rise: 0 },
};

/** 粒子循环的盒子（以镜头焦点为中心）。 */
const BOX_X = 60;
const BOX_Y = 34;
const BOX_Z = 120;

export class Weather {
  readonly mesh: THREE.InstancedMesh;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vy: Float32Array;
  private readonly ph: Float32Array;
  /** 每个实例固定的尺寸，直接烘进缩放里，不需要额外的实例属性。 */
  private readonly sizes: Float32Array;
  private readonly spec: WeatherSpec;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private t = 0;

  constructor(kind: Exclude<WeatherKind, 'none'>, detail = 1) {
    const spec = SPECS[kind];
    this.spec = spec;
    const n = Math.max(40, Math.round(spec.count * detail));

    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      color: spec.color,
      transparent: true,
      opacity: spec.opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: spec.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: !spec.additive,
      fog: true,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;

    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.ph = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.px[i] = (Math.random() - 0.5) * BOX_X;
      this.py[i] = Math.random() * BOX_Y;
      this.pz[i] = (Math.random() - 0.5) * BOX_Z;
      this.vy[i] = spec.fall[0] + Math.random() * (spec.fall[1] - spec.fall[0]);
      this.ph[i] = Math.random() * Math.PI * 2;
    }
    this.sizes = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.sizes[i] = spec.size[0] + Math.random() * (spec.size[1] - spec.size[0]);
    }
  }

  /**
   * cx/cz 是镜头的关注点（方阵位置）。粒子盒随它平移，
   * 所以不管跑多远，视野里始终有天气，而实例数恒定。
   */
  update(dt: number, cx: number, cz: number): void {
    this.t += dt;
    const spec = this.spec;
    const n = this.mesh.count = this.px.length;
    const halfX = BOX_X / 2;
    const halfZ = BOX_Z / 2;

    for (let i = 0; i < n; i++) {
      this.py[i] -= (this.vy[i] - spec.rise) * dt;
      // 掉出盒底就从顶上绕回来
      if (this.py[i] < -2) {
        this.py[i] += BOX_Y + 2;
        this.px[i] = (Math.random() - 0.5) * BOX_X;
        this.pz[i] = (Math.random() - 0.5) * BOX_Z;
      } else if (this.py[i] > BOX_Y) {
        this.py[i] -= BOX_Y + 2;
      }

      const sway = spec.sway > 0 ? Math.sin(this.t * 0.8 + this.ph[i]) * spec.sway : 0;
      const size = this.sizes[i]!;
      this.v.set(cx + this.px[i]! + sway, this.py[i]!, cz + this.pz[i]!);
      this.s.set(size, size * spec.stretch, 1);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);

      // 保持粒子始终在镜头附近的盒子里
      if (this.px[i]! > halfX) this.px[i] -= BOX_X;
      else if (this.px[i]! < -halfX) this.px[i] += BOX_X;
      if (this.pz[i]! > halfZ) this.pz[i] -= BOX_Z;
      else if (this.pz[i]! < -halfZ) this.pz[i] += BOX_Z;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
