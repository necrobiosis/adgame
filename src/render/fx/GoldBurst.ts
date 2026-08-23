import * as THREE from 'three';

interface Ingot {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  spin: number;
  life: number;
}

/**
 * 金锭。广告第一张图里满地翻滚的金块就是这个。
 * 弹道 + 自旋 + 落地反弹，用实例化盒子画。
 */
export class GoldBurst {
  readonly mesh: THREE.InstancedMesh;
  private readonly live: Ingot[] = [];
  private readonly pool: Ingot[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3(1, 1, 1);

  /**
   * 默认是金锭。传 `debris` 就换成暗色不反光的碎块——大型敌人炸开时抛出来的
   * 残肢，弹道/弹跳/自旋完全复用同一套已经调好的物理。
   */
  constructor(readonly capacity = 260, opts?: { size?: [number, number, number]; color?: number; debris?: boolean }) {
    const size = opts?.size ?? [0.44, 0.26, 0.68];
    const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
    const debris = opts?.debris ?? false;
    const mat = new THREE.MeshStandardMaterial({
      color: opts?.color ?? 0xf5c22b,
      roughness: debris ? 0.9 : 0.22,
      metalness: debris ? 0.05 : 0.95,
      emissive: new THREE.Color(debris ? 0x000000 : 0x6b4a00),
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  burst(x: number, y: number, z: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.live.length >= this.capacity) return;
      const g = this.pool.pop() ?? ({} as Ingot);
      const a = Math.random() * Math.PI * 2;
      const sp = 2.5 + Math.random() * 7;
      g.x = x; g.y = y + 0.4; g.z = z;
      g.vx = Math.cos(a) * sp;
      g.vz = Math.sin(a) * sp * 0.7;
      g.vy = 4.5 + Math.random() * 5;
      g.rx = Math.random() * 6.28;
      g.ry = Math.random() * 6.28;
      g.rz = Math.random() * 6.28;
      g.spin = 5 + Math.random() * 9;
      g.life = 3.4 + Math.random() * 1.6;
      this.live.push(g);
    }
  }

  update(dt: number, groundY = 0.14): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const g = this.live[i]!;
      g.life -= dt;
      if (g.life <= 0) {
        this.live[i] = this.live[this.live.length - 1]!;
        this.live.pop();
        this.pool.push(g);
        continue;
      }
      g.vy -= 22 * dt;
      g.x += g.vx * dt;
      g.y += g.vy * dt;
      g.z += g.vz * dt;
      if (g.y < groundY) {
        g.y = groundY;
        g.vy *= -0.32;
        g.vx *= 0.62;
        g.vz *= 0.62;
        g.spin *= 0.55;
      }
      g.rx += g.spin * dt;
      g.ry += g.spin * 0.7 * dt;
      g.rz += g.spin * 0.4 * dt;
    }

    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const g = this.live[i]!;
      this.v.set(g.x, g.y, g.z);
      this.e.set(g.rx, g.ry, g.rz);
      this.q.setFromEuler(this.e);
      const fade = Math.min(1, g.life);
      this.s.setScalar(fade);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = n;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
