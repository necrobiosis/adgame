import * as THREE from 'three';

/**
 * 爆炸冲击波：一圈从爆心迅速摊开、同时变薄变淡的加色环。
 *
 * 和地上的预警圈（Telegraph.ts）刻意做得不一样：预警是"实心边框 + 缓慢填充"，
 * 表示"这里即将发生"；冲击波是"薄环 + 快速扩张"，表示"这里刚刚发生"。
 * 两者在同一块地面上同时出现时必须一眼分得开。
 */

interface W {
  x: number; z: number;
  life: number; maxLife: number;
  from: number; to: number;
  r: number; g: number; b: number;
  strength: number;
}

export class Shockwaves {
  readonly mesh: THREE.InstancedMesh;
  private readonly live: W[] = [];
  private readonly pool: W[] = [];
  private readonly progAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(readonly capacity = 24) {
    // 单位圆盘，靠实例矩阵缩放到当前半径；环本身在 fragment 里画
    const geo = new THREE.PlaneGeometry(2, 2);
    geo.rotateX(-Math.PI / 2);
    this.progAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.progAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aProg', this.progAttr);
    geo.setAttribute('aColor', this.colorAttr);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aProg;
        attribute vec3 aColor;
        varying float vProg;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          vProg = aProg; vColor = aColor; vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vProg;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          // 环越往后越薄：宽度随进度收窄，位置固定在外缘
          float w = mix(0.34, 0.05, vProg);
          float ring = smoothstep(1.0, 1.0 - w, d) * smoothstep(1.0 + w * 0.4, 1.0, d);
          float fade = (1.0 - vProg) * (1.0 - vProg);
          float a = ring * fade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.count = 0;
  }

  spawn(x: number, z: number, from: number, to: number, color: number, life = 0.5, strength = 1): void {
    if (this.live.length >= this.capacity) return;
    const w = this.pool.pop() ?? ({} as W);
    this.c.set(color);
    w.x = x; w.z = z;
    w.from = from; w.to = to;
    w.maxLife = life;
    w.life = life;
    w.r = this.c.r; w.g = this.c.g; w.b = this.c.b;
    w.strength = strength;
    this.live.push(w);
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const w = this.live[i]!;
      w.life -= dt;
      if (w.life <= 0) {
        this.live[i] = this.live[this.live.length - 1]!;
        this.live.pop();
        this.pool.push(w);
      }
    }
    const n = this.live.length;
    for (let i = 0; i < n; i++) {
      const w = this.live[i]!;
      const prog = 1 - w.life / w.maxLife;
      // 先快后慢地摊开，读起来才有"炸出去"的爆发感
      const r = w.from + (w.to - w.from) * Math.pow(prog, 0.55);
      this.v.set(w.x, 0.08, w.z);
      this.s.set(r, 1, r);
      this.m.compose(this.v, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
      this.progAttr.array[i] = prog;
      this.colorAttr.array[i * 3] = w.r * w.strength;
      this.colorAttr.array[i * 3 + 1] = w.g * w.strength;
      this.colorAttr.array[i * 3 + 2] = w.b * w.strength;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.progAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }
}
