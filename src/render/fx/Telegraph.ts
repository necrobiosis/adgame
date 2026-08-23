import * as THREE from 'three';

/**
 * Boss 技能的地面预警圈。
 * 有它玩家才能"看懂"该往哪躲 —— 没有预警的 AoE 只是随机惩罚，
 * 有预警的 AoE 才是操作。
 */
export class TelegraphRing {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uProgress: { value: 0 },
        uColor: { value: new THREE.Color(0xff3b2f) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uProgress;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          if (d > 1.0) discard;
          // 外圈实线
          float ring = smoothstep(0.94, 1.0, d) * 0.95;
          // 内部随进度填充
          float fillMask = step(d, uProgress);
          float pulse = 0.22 + 0.16 * sin(uProgress * 28.0);
          float a = max(ring, fillMask * pulse) ;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  show(x: number, z: number, radius: number, progress: number, color: number): void {
    this.mesh.visible = true;
    this.mesh.position.set(x, 0.06, z);
    this.mesh.scale.set(radius * 2, radius * 2, 1);
    this.mat.uniforms.uProgress!.value = progress;
    (this.mat.uniforms.uColor!.value as THREE.Color).setHex(color);
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

/** Boss 冲锋的车道预警：一条从 Boss 指向方阵的发光带。 */
export class TelegraphLane {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor() {
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xff5a2f,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  show(x: number, z0: number, z1: number, halfWidth: number, progress: number, color = 0xff5a2f): void {
    this.mesh.visible = true;
    const len = Math.abs(z1 - z0);
    this.mesh.position.set(x, 0.05, (z0 + z1) / 2);
    this.mesh.scale.set(halfWidth * 2, len, 1);
    this.mat.opacity = 0.25 + 0.4 * progress;
    this.mat.color.setHex(color);
  }

  hide(): void {
    this.mesh.visible = false;
  }
}

/**
 * 天降雷击的预警：不是圆盘，是三道向内收缩、绕落点旋转的弧线 +
 * 收缩到最后炸开的一个亮点——第一眼就能看出这不是践踏 AoE 的红圈。
 */
export class LightningReticle {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uProgress: { value: 0 },
        uColor: { value: new THREE.Color(0x8fe0ff) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uProgress;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv - 0.5;
          float d = length(p) * 2.0;
          if (d > 1.0) discard;
          float ang = atan(p.y, p.x);
          // 半径随进度从外圈收缩到中心
          float radius = mix(1.0, 0.06, uProgress);
          float band = smoothstep(0.09, 0.0, abs(d - radius));
          // 三道弧线绕落点旋转收拢，而不是一整圈实线
          float third = 2.0943951; // 2π/3
          float aa = mod(ang + uProgress * 7.0, third);
          float arc = step(aa, third * 0.42);
          float a = band * arc;
          // 收缩到中心时冒出一个越来越亮的核心点，预示即将落雷
          float core = smoothstep(0.14, 0.0, d) * uProgress;
          a = max(a, core * 0.85);
          if (a < 0.02) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  show(x: number, z: number, radius: number, progress: number, color = 0x8fe0ff): void {
    this.mesh.visible = true;
    this.mesh.position.set(x, 0.06, z);
    this.mesh.scale.set(radius * 2, radius * 2, 1);
    this.mat.uniforms.uProgress!.value = progress;
    (this.mat.uniforms.uColor!.value as THREE.Color).setHex(color);
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
