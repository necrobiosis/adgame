import * as THREE from 'three';

interface P {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number; grow: number;
  /** 起始色。 */
  r: number; g: number; b: number;
  /** 终止色 —— 生命期内插值过去。 */
  r2: number; g2: number; b2: number;
  gravity: number;
  drag: number;
  stretch: number;
  fadeIn: number;
}

export interface BurstOptions {
  count: number;
  color: number;
  /** 生命末期的颜色。给了就做渐变（火焰 亮黄→暗红），不给就恒定。 */
  color2?: number;
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
  /** 沿速度方向拉长的倍数。0 = 圆点，>0 = 拖成条状的火星。 */
  stretch?: number;
  /** 淡入所占生命比例。烟雾用它避免"啪"地凭空出现。 */
  fadeIn?: number;
}

/**
 * 通用粒子池：血雾、枪口火焰、爆炸、冲击波都用它。
 * 一个实例化四边形 + 加色混合，billboard 在 shader 里做。
 *
 * 三个让它不再像"一堆圆点"的东西：生命期颜色渐变（CPU 端算，反正每帧本来
 * 就要写一次颜色属性）、沿速度方向的拉伸（在 shader 里把速度转到视图空间
 * 取角度）、以及可选的淡入。
 */
export class Particles {
  readonly mesh: THREE.InstancedMesh;
  private readonly pool: P[] = [];
  private readonly live: P[] = [];
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly sizeAttr: THREE.InstancedBufferAttribute;
  private readonly velAttr: THREE.InstancedBufferAttribute;
  private readonly stretchAttr: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly c1 = new THREE.Color();
  private readonly c2 = new THREE.Color();

  constructor(readonly capacity = 900, additive = true) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.sizeAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.velAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.stretchAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    for (const a of [this.colorAttr, this.alphaAttr, this.sizeAttr, this.velAttr, this.stretchAttr]) {
      a.setUsage(THREE.DynamicDrawUsage);
    }
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    geo.setAttribute('aVel', this.velAttr);
    geo.setAttribute('aStretch', this.stretchAttr);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aSize;
        attribute vec3 aVel;
        attribute float aStretch;
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vColor = aColor; vAlpha = aAlpha; vUv = uv;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          // 速度转到视图空间，用它的屏幕投影方向当拉伸轴 —— 火星就沿着自己
          // 飞出去的方向拖成条，而不是永远是个正圆
          vec3 vv = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
          float len = length(vv.xy);
          vec2 dir = len > 1e-4 ? vv.xy / len : vec2(1.0, 0.0);
          vec2 p = vec2(position.x * aSize * (1.0 + aStretch), position.y * aSize);
          mv.xy += vec2(p.x * dir.x - p.y * dir.y, p.x * dir.y + p.y * dir.x);
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
    this.c1.set(o.color);
    this.c2.set(o.color2 ?? o.color);
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
      p.stretch = o.stretch ?? 0;
      p.fadeIn = o.fadeIn ?? 0;
      p.r = this.c1.r; p.g = this.c1.g; p.b = this.c1.b;
      p.r2 = this.c2.r; p.g2 = this.c2.g; p.b2 = this.c2.b;
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
      // t: 1 → 0 随生命耗尽
      const t = p.life / p.maxLife;
      const age = 1 - t;
      // 颜色沿生命期插值：火焰从亮黄烧成暗红烟
      this.colorAttr.array[i * 3] = p.r + (p.r2 - p.r) * age;
      this.colorAttr.array[i * 3 + 1] = p.g + (p.g2 - p.g) * age;
      this.colorAttr.array[i * 3 + 2] = p.b + (p.b2 - p.b) * age;
      const fade = p.fadeIn > 0 ? Math.min(1, age / p.fadeIn) : 1;
      this.alphaAttr.array[i] = t * t * fade;
      this.sizeAttr.array[i] = p.size;
      this.velAttr.array[i * 3] = p.vx;
      this.velAttr.array[i * 3 + 1] = p.vy;
      this.velAttr.array[i * 3 + 2] = p.vz;
      this.stretchAttr.array[i] = p.stretch;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.alphaAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.velAttr.needsUpdate = true;
      this.stretchAttr.needsUpdate = true;
    }
  }
}
