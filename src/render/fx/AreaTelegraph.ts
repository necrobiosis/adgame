import * as THREE from 'three';

/**
 * 矩形/条状的地面预警。
 *
 * 圆形预警（TelegraphRing）够用了很久，直到 Boss 开始放"半场毒爆"、
 * "带缺口的火墙"和"扫过整条路的光束"——这三种都不是圆的。这里用一个
 * 可复用的地面四边形池覆盖全部三种：给一个中心、尺寸、旋转和进度就行。
 *
 * 视觉语言和圆形预警保持一致：**边框先亮，填充随进度推满**，玩家一眼就知道
 * "填满 = 要炸了"，不需要为每种新形状重新学一遍。
 */
export class AreaTelegraph {
  readonly mesh: THREE.InstancedMesh;
  private readonly progAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private n = 0;

  constructor(readonly capacity = 6) {
    const geo = new THREE.PlaneGeometry(1, 1);
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
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
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
          // 边框：贴着四条边的一圈亮线
          vec2 d = min(vUv, 1.0 - vUv);
          float edge = 1.0 - smoothstep(0.0, 0.035, min(d.x, d.y));
          // 填充：从中间往外涨，涨满就是命中的那一刻
          float fill = step(abs(vUv.y - 0.5) * 2.0, vProg) * (0.2 + 0.22 * sin(vProg * 26.0));
          float a = clamp(edge * 0.95 + fill, 0.0, 1.0);
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

  /** 每帧先清空，再把这一帧要显示的块逐个 push 进来。 */
  begin(): void {
    this.n = 0;
  }

  /** 一块地面预警。`rotY` 让光束那种斜着扫的条也能用同一套。 */
  push(x: number, z: number, width: number, depth: number, progress: number, color: number, rotY = 0): void {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.v.set(x, 0.07, z);
    this.e.set(0, rotY, 0);
    this.q.setFromEuler(this.e);
    this.s.set(Math.max(0.01, width), 1, Math.max(0.01, depth));
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.progAttr.array[i] = progress;
    this.c.set(color);
    this.colorAttr.array[i * 3] = this.c.r;
    this.colorAttr.array[i * 3 + 1] = this.c.g;
    this.colorAttr.array[i * 3 + 2] = this.c.b;
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.progAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
    }
  }
}
