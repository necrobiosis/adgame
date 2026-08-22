import * as THREE from 'three';

interface Tracer {
  life: number;
}

/**
 * 曳光弹。
 * 射击本身是 hitscan（伤害在开火那一刻就结算了），这里画的纯粹是那一道光。
 * 每发是一个被拉长的实例化盒子，寿命几十毫秒，配合 bloom 就是广告里
 * 那种密集的枪线。
 */
export class Tracers {
  readonly mesh: THREE.InstancedMesh;
  private readonly items: Tracer[] = [];
  private readonly mats: THREE.Matrix4[] = [];
  private readonly colors: Float32Array;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly tmp = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();

  constructor(readonly capacity = 520) {
    const geo = new THREE.BoxGeometry(0.075, 0.075, 1);
    this.colors = new Float32Array(capacity * 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aAlpha', this.alpha);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vColor * 1.7, vAlpha); }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) this.mats.push(new THREE.Matrix4());
  }

  spawn(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    if (this.items.length >= this.capacity) return;
    this.a.set(x0, y0, z0);
    this.b.set(x1, y1, z1);
    const len = this.a.distanceTo(this.b);
    if (len < 0.001) return;
    this.mid.addVectors(this.a, this.b).multiplyScalar(0.5);
    // 让盒子的 +z 指向目标
    this.tmp.lookAt(this.a, this.b, this.up);
    const i = this.items.length;
    this.mats[i]!.copy(this.tmp);
    this.mats[i]!.setPosition(this.mid);
    this.mats[i]!.scale(new THREE.Vector3(1, 1, len));
    const c = new THREE.Color(color);
    this.colors[i * 3] = c.r;
    this.colors[i * 3 + 1] = c.g;
    this.colors[i * 3 + 2] = c.b;
    this.alpha.array[i] = 1;
    this.items.push({ life: 0.055 });
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      it.life -= dt;
      if (it.life <= 0) {
        const last = this.items.length - 1;
        if (i !== last) {
          this.items[i] = this.items[last]!;
          this.mats[i]!.copy(this.mats[last]!);
          for (let k = 0; k < 3; k++) this.colors[i * 3 + k] = this.colors[last * 3 + k]!;
          this.alpha.array[i] = this.alpha.array[last]!;
        }
        this.items.pop();
        continue;
      }
      this.alpha.array[i] = Math.min(1, it.life / 0.055);
    }
    const n = this.items.length;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this.mats[i]!);
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.alpha.needsUpdate = true;
    }
  }
}
