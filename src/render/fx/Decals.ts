import * as THREE from 'three';

/**
 * 地面贴花：血迹、焦痕、弹着点。
 *
 * 之前打完一场仗地面是干干净净的 —— 没有任何"这里刚死过两百只僵尸"的痕迹。
 * 一张程序化的斑块贴图 + 实例化四边形平铺在路面上，按实例给颜色/大小/旋转/
 * 透明度，池满了就顶掉最老的一张。
 *
 * 全部走 NormalBlending + depthWrite:false + polygonOffset，避免和路面 z-fighting。
 */

interface D {
  life: number;
  maxLife: number;
  /** 淡出前保持满不透明的时间。血迹要留很久才有"战场"的感觉。 */
  hold: number;
  alpha: number;
}

export type DecalKind = 'blood' | 'scorch' | 'ichor';

const TINT: Record<DecalKind, number> = {
  blood: 0x4a0d0d,
  ichor: 0x2f3d12,
  scorch: 0x201b16,
};

export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private readonly slots: D[] = [];
  private next = 0;
  private readonly alphaAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private readonly e = new THREE.Euler();
  private readonly c = new THREE.Color();

  constructor(readonly capacity = 160) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alphaAttr);
    geo.setAttribute('aColor', this.colorAttr);

    const tex = splatTexture();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: { tSplat: { value: tex } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          vAlpha = aAlpha; vColor = aColor; vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSplat;
        varying float vAlpha;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          float m = texture2D(tSplat, vUv).r;
          float a = m * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.slots.push({ life: 0, maxLife: 1, hold: 0, alpha: 0 });
  }

  /**
   * 拍一张贴花在 (x, z) 的地面上。
   * `size` 是直径；`life` 给 0 表示用该类型的默认存续时间。
   */
  add(kind: DecalKind, x: number, z: number, size: number, alpha = 0.85): void {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    const d = this.slots[i]!;
    d.maxLife = kind === 'scorch' ? 26 : 34;
    d.hold = d.maxLife * 0.55;
    d.life = d.maxLife;
    d.alpha = alpha;

    this.v.set(x, 0.03 + (i % 6) * 0.004, z); // 微小的高度错开，避免同层闪烁
    this.e.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    this.q.setFromEuler(this.e);
    const sx = size * (0.8 + Math.random() * 0.5);
    this.s.set(sx, size * (0.8 + Math.random() * 0.5), 1);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);

    this.c.set(TINT[kind]);
    this.colorAttr.array[i * 3] = this.c.r;
    this.colorAttr.array[i * 3 + 1] = this.c.g;
    this.colorAttr.array[i * 3 + 2] = this.c.b;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    if (this.mesh.count < this.capacity) this.mesh.count = Math.max(this.mesh.count, i + 1);
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const d = this.slots[i]!;
      if (d.life <= 0) continue;
      d.life -= dt;
      // 先保持，再线性淡出
      const a = d.life > d.hold ? d.alpha : Math.max(0, (d.life / d.hold) * d.alpha);
      this.alphaAttr.array[i] = a;
      dirty = true;
    }
    if (dirty) this.alphaAttr.needsUpdate = true;
  }

  clear(): void {
    for (const d of this.slots) d.life = 0;
    this.alphaAttr.array.fill(0);
    this.alphaAttr.needsUpdate = true;
    this.mesh.count = 0;
    this.next = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const mat = this.mesh.material as THREE.ShaderMaterial;
    (mat.uniforms.tSplat!.value as THREE.Texture).dispose();
    mat.dispose();
  }
}

/**
 * 程序化斑块贴图：一簇不规则的圆点叠出来的溅射形状。
 * 单通道存在 R 里，颜色靠实例属性给，所以血/焦痕/尸液共用同一张。
 */
function splatTexture(): THREE.CanvasTexture {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, S, S);

  // 主斑 + 一圈卫星点，边缘用径向渐变收掉
  const blob = (cx: number, cy: number, r: number, a: number) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.55, `rgba(255,255,255,${a * 0.8})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  ctx.globalCompositeOperation = 'lighter';
  blob(S * 0.5, S * 0.5, S * 0.3, 0.95);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random();
    const d = S * (0.16 + Math.random() * 0.26);
    blob(S * 0.5 + Math.cos(a) * d, S * 0.5 + Math.sin(a) * d, S * (0.04 + Math.random() * 0.1), 0.5 + Math.random() * 0.4);
  }
  // 几粒飞得更远的小点
  for (let i = 0; i < 20; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = S * (0.3 + Math.random() * 0.16);
    blob(S * 0.5 + Math.cos(a) * d, S * 0.5 + Math.sin(a) * d, S * (0.012 + Math.random() * 0.03), 0.6);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
