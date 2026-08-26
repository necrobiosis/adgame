import * as THREE from 'three';

interface Tracer {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  age: number;
  dur: number;
  color: number;
  /** 光柱粗细倍率。 */
  w: number;
  /** 拖尾长度（米）。 */
  streak: number;
  /** 亮度倍率。 */
  glow: number;
}

/**
 * 曳光弹的五档外观。
 *
 * 升级必须**看得见**。只改伤害数字的话，玩家换了枪也感觉不到自己变强了——
 * 从手枪的一颗小亮点，到轻机枪的粗光条，再到电磁炮那道一闪即达、贯穿到底
 * 的蓝白光柱，每一档在屏幕上都得是另一种东西。
 *
 * 注意：镜头是从方阵背后顺着弹道往前看的，子弹几乎是**朝着镜头的反方向**飞——
 * 再长的拖尾投影到屏幕上也只有一小段。所以这几档的预算全压在"粗"和"亮"上，
 * 长度只是锦上添花。
 *
 *  w      粗细倍率
 *  streak 拖尾长度（Infinity = 从枪口一直连到目标，读作"一道光柱"）
 *  speed  视觉弹速，越高越接近瞬间到达
 *  glow   亮度倍率
 *  life   最短存在时间，保证高速档也留得住一帧
 */
const BEAM_STYLE = [
  { w: 1.0, streak: 1.2, speed: 95, glow: 1.2, life: 0.025 },
  { w: 1.6, streak: 2.2, speed: 120, glow: 1.5, life: 0.03 },
  { w: 2.4, streak: 4.5, speed: 170, glow: 1.9, life: 0.04 },
  { w: 3.6, streak: 11, speed: 260, glow: 2.5, life: 0.055 },
  { w: 5.4, streak: Infinity, speed: 900, glow: 3.4, life: 0.09 },
] as const;

export interface Impact {
  x: number; y: number; z: number; color: number;
}

/** 单发飞行时间的上限——太远别飞太久。 */
const MAX_DUR = 0.12;

/**
 * 曳光弹。
 *
 * 伤害仍然是 hitscan（在开火那一刻就结算），这里画的是"子弹飞过去"这段
 * 纯视觉过程：每发从枪口出发，用固定弹速飞向目标，只画一小段拖尾，
 * 位置逐帧插值前移。配合高射速，读出来是一串连续的子弹而不是一条常驻激光。
 */
export class Tracers {
  readonly mesh: THREE.InstancedMesh;
  private readonly items: Tracer[] = [];
  private readonly mats: THREE.Matrix4[] = [];
  private readonly colors: Float32Array;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly glow: THREE.InstancedBufferAttribute;
  private readonly tmp = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly tail = new THREE.Vector3();
  private readonly mid = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();

  constructor(readonly capacity = 900) {
    const geo = new THREE.BoxGeometry(0.16, 0.16, 1);
    this.colors = new Float32Array(capacity * 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    this.glow.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aAlpha', this.alpha);
    geo.setAttribute('aGlow', this.glow);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aAlpha;
        attribute float aGlow;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          // 亮度乘在**颜色**上，不能乘在 alpha 上：加色混合里 alpha 会被钳到
          // 1，高档武器的 glow 全被吃掉，八级武器的曳光弹看起来一模一样。
          vColor = aColor * aGlow;
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

  /** 这一帧刚好飞抵目标的那些落点，update() 结束后可读，供 GameView 生成落点火花。 */
  readonly impacts: Impact[] = [];

  spawn(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    color: number, beam = 0,
  ): void {
    if (this.items.length >= this.capacity) return;
    const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (dist < 0.001) return;
    const st = BEAM_STYLE[Math.max(0, Math.min(BEAM_STYLE.length - 1, beam))]!;
    const dur = THREE.MathUtils.clamp(dist / st.speed, st.life, MAX_DUR);
    const i = this.items.length;
    const c = new THREE.Color(color);
    this.colors[i * 3] = c.r;
    this.colors[i * 3 + 1] = c.g;
    this.colors[i * 3 + 2] = c.b;
    this.alpha.array[i] = 1;
    this.glow.array[i] = st.glow;
    this.items.push({ x0, y0, z0, x1, y1, z1, age: 0, dur, color, w: st.w, streak: st.streak, glow: st.glow });
  }

  update(dt: number): void {
    this.impacts.length = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]!;
      it.age += dt;
      if (it.age >= it.dur) {
        this.impacts.push({ x: it.x1, y: it.y1, z: it.z1, color: it.color });
        const last = this.items.length - 1;
        if (i !== last) {
          this.items[i] = this.items[last]!;
          for (let k = 0; k < 3; k++) this.colors[i * 3 + k] = this.colors[last * 3 + k]!;
          this.alpha.array[i] = this.alpha.array[last]!;
          this.glow.array[i] = this.glow.array[last]!;
        }
        this.items.pop();
        continue;
      }

      const it2 = this.items[i]!;
      const t = it2.age / it2.dur;
      this.a.set(it2.x0, it2.y0, it2.z0);
      this.b.set(it2.x1, it2.y1, it2.z1);
      const total = this.a.distanceTo(this.b);
      // 子弹头部沿路径前移；拖尾长度固定，不随总距离拉伸
      this.head.lerpVectors(this.a, this.b, t);
      const tailT = Math.max(0, t - Math.min(it2.streak, total) / Math.max(total, 0.001));
      this.tail.lerpVectors(this.a, this.b, tailT);
      const len = this.head.distanceTo(this.tail);
      this.mid.addVectors(this.head, this.tail).multiplyScalar(0.5);

      if (len < 0.02) {
        this.tmp.lookAt(this.a, this.b, this.up);
      } else {
        this.tmp.lookAt(this.tail, this.head, this.up);
      }
      this.mats[i]!.copy(this.tmp);
      this.mats[i]!.setPosition(this.mid);
      this.mats[i]!.scale(this.scl.set(it2.w, it2.w, Math.max(len, 0.05)));
      // 头部亮尾部暗，读起来更像一发正在飞的子弹
      this.alpha.array[i] = 0.35 + 0.65 * (1 - Math.abs(t - 1) * 0.3);
      this.glow.array[i] = it2.glow;
    }
    const n = this.items.length;
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, this.mats[i]!);
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.alpha.needsUpdate = true;
      this.glow.needsUpdate = true;
    }
  }

}
