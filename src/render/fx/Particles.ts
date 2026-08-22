import * as THREE from 'three';

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number; grow: number;
  r: number; g: number; b: number;
  gravity: number;
  drag: number;
}

export interface BurstOptions {
  count: number;
  color: number;
  /** 初速度大小范围。 */
  speed: [number, number];
  size: [number, number];
  life: [number, number];
  gravity?: number;
  drag?: number;
  /** 尺寸随时间的变化率（正 = 扩散的冲击波，负 = 收缩的火星）。 */
  grow?: number;
  /** 向上的额外初速。 */
  lift?: number;
}

/**
 * 通用粒子池：血雾、枪口火焰、爆炸、冲击波都用它。
 * 一个实例化四边形 + 加色混合，billboard 在 shader 里做。
 */
export class Particles {
  readonly mesh: THREE.InstancedMesh;
  private readonly pool: P[] = [];
  private readonly live: P[] = [];
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly sizeAttr: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(1, 1, 1);

  constructor(readonly capacity = 900, additive = true) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.sizeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.colorAttr, this.alphaAttr, this.sizeAttr]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aSize', this.sizeAttr);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSize;
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vColor = aColor; vAlpha = aAlpha; vUv = uv;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * aSize;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.15, d) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  burst(x: number, y: number, z: number, o: BurstOptions): void {
    const c = new THREE.Color(o.color);
    for (let i = 0; i < o.count; i++) {
      if (this.live.length >= this.capacity) return;
      const p = this.pool.pop() ?? ({} as P);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = o.speed[0] + Math.random() * (o.speed[1] - o.speed[0]);
      p.x = x; p.y = y; p.z = z;
      p.vx = Math.sin(phi) * Math.cos(theta) * sp;
      p.vy = Math.cos(phi) * sp + (o.lift ?? 0);
      p.vz = Math.sin(phi) * Math.sin(theta) * sp;
      p.maxLife = o.life[0] + Math.random() * (o.life[1] - o.life[0]);
      p.life = p.maxLife;
      p.size = o.size[0] + Math.random() * (o.size[1] - o.size[0]);
      p.grow = o.grow ?? 0;
      p.gravity = o.gravity ?? 0;
      p.drag = o.drag ?? 0;
      p.r = c.r; p.g = c.g; p.b = c.b;
      this.live.push(p);
    }
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.live[i] = this.live[this.live.length - 1]!;
        this.live.pop();
        this.pool.push(p);
        continue;
      }
      p.vy -= p.gravity * dt;
      if (p.drag > 0) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k; p.vy *= k; p.vz *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.size = Math.max(0.01, p.size + p.grow * dt);
    }

    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const p = this.live[i]!;
      this.v.set(p.x, p.y, p.z);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      const t = p.life / p.maxLife;
      this.colorAttr.array[i * 3] = p.r;
      this.colorAttr.array[i * 3 + 1] = p.g;
      this.colorAttr.array[i * 3 + 2] = p.b;
      this.alphaAttr.array[i] = t * t;
      this.sizeAttr.array[i] = p.size;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
  }
}
