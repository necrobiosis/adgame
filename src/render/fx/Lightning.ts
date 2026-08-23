import * as THREE from 'three';

/**
 * 通用锯齿闪电：两点间生成一条折线状发光弧，供天降雷击的主雷电、
 * 冲锋轨迹的拖尾电弧、冲锋落地的电击扩散共用。
 *
 * 没有用 billboard/自定义着色器——每段用一根细长圆柱体沿线段方向摆好，
 * 从大多数角度看都足够读出"一道电弧"，而且实现和更新都简单，
 * 单场同时存在的电弧数量也就几道，性能完全不是问题。
 */
export interface LightningSpawnOptions {
  /** 折线段数（越多越曲折）。 */
  segments?: number;
  /** 每个中间点的随机偏移幅度（米）。 */
  jitter?: number;
  /** 弧的粗细（米）。 */
  thickness?: number;
  /** 存活时间（秒）。 */
  life?: number;
  color?: number;
}

interface Bolt {
  segments: THREE.Mesh[];
  life: number;
  maxLife: number;
}

export class Lightning {
  readonly group = new THREE.Group();
  private readonly pool: THREE.Mesh[] = [];
  private readonly active: Bolt[] = [];
  private readonly geo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(private readonly defaultColor = 0x8fe0ff) {
    this.group.frustumCulled = false;
  }

  private takeSegment(): THREE.Mesh {
    const existing = this.pool.pop();
    if (existing) return existing;
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  spawn(from: THREE.Vector3, to: THREE.Vector3, opts: LightningSpawnOptions = {}): void {
    const n = Math.max(2, opts.segments ?? 7);
    const jitter = opts.jitter ?? 0.8;
    const thickness = opts.thickness ?? 0.09;
    const life = opts.life ?? 0.16;
    const color = opts.color ?? this.defaultColor;

    const pts: THREE.Vector3[] = [from.clone()];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const p = from.clone().lerp(to, t);
      p.x += (Math.random() * 2 - 1) * jitter;
      p.y += (Math.random() * 2 - 1) * jitter * 0.5;
      p.z += (Math.random() * 2 - 1) * jitter;
      pts.push(p);
    }
    pts.push(to.clone());

    const segments: THREE.Mesh[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const mesh = this.takeSegment();
      const dir = b.clone().sub(a);
      const len = Math.max(0.001, dir.length());
      mesh.position.copy(a).add(b).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(this.up, dir.normalize());
      mesh.scale.set(thickness, len, thickness);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.setHex(color);
      mat.opacity = 1;
      mesh.visible = true;
      segments.push(mesh);
    }
    this.active.push({ segments, life, maxLife: life });
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const bolt = this.active[i]!;
      bolt.life -= dt;
      const t = Math.max(0, bolt.life / bolt.maxLife);
      // 闪烁而不是匀速淡出——电弧本来就是忽明忽暗的
      const flicker = 0.55 + 0.45 * Math.random();
      for (const seg of bolt.segments) (seg.material as THREE.MeshBasicMaterial).opacity = t * flicker;
      if (bolt.life <= 0) {
        for (const seg of bolt.segments) {
          seg.visible = false;
          this.pool.push(seg);
        }
        this.active[i] = this.active[this.active.length - 1]!;
        this.active.pop();
      }
    }
  }
}
