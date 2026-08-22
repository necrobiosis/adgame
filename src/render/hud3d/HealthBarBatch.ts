import * as THREE from 'three';

/**
 * 精英怪头顶的血条。
 * 用一个 InstancedMesh 画所有血条，在 vertex shader 里做面向镜头的 billboard，
 * 每个实例带一个填充比例 aFill。几十条血条也只是一次 draw call。
 */
export class HealthBarBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly fill: THREE.InstancedBufferAttribute;
  private readonly width: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3(1, 1, 1);
  private n = 0;

  constructor(readonly capacity: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const fill = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const width = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    fill.setUsage(THREE.DynamicDrawUsage);
    width.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aFill', fill);
    geo.setAttribute('aWidth', width);
    this.fill = fill;
    this.width = width;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      uniforms: { uHeight: { value: 0.26 } },
      vertexShader: /* glsl */ `
        attribute float aFill;
        attribute float aWidth;
        uniform float uHeight;
        varying vec2 vUv;
        varying float vFill;
        void main() {
          vUv = uv;
          vFill = aFill;
          // billboard：实例位置进相机空间，再在屏幕平面上展开四边形
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * vec2(aWidth, uHeight);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vFill;
        void main() {
          // 外框
          float edge = min(min(vUv.x, 1.0 - vUv.x) * 26.0, min(vUv.y, 1.0 - vUv.y) * 7.0);
          if (edge < 0.35) { gl_FragColor = vec4(0.05, 0.06, 0.08, 0.92); return; }
          if (vUv.x <= vFill) {
            // 血量越低越偏黄/红，还原广告里那种分段血条
            vec3 c = mix(vec3(1.0, 0.72, 0.12), vec3(0.88, 0.12, 0.10), 1.0 - vFill);
            // 分段刻痕
            float seg = step(0.16, fract(vUv.x * 12.0));
            gl_FragColor = vec4(c * mix(0.75, 1.0, seg), 0.98);
          } else {
            gl_FragColor = vec4(0.16, 0.06, 0.07, 0.82);
          }
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.count = 0;
  }

  begin(): void {
    this.n = 0;
  }

  add(x: number, y: number, z: number, fill: number, width: number): void {
    const i = this.n;
    if (i >= this.capacity) return;
    this.v.set(x, y, z);
    this.m.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m);
    this.fill.array[i] = Math.max(0, Math.min(1, fill));
    this.width.array[i] = width;
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.fill.needsUpdate = true;
    this.width.needsUpdate = true;
  }
}
