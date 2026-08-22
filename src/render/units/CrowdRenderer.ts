import * as THREE from 'three';

const IDENTITY_TINT = new THREE.Color(1, 1, 1);

/**
 * 一批共用同一个几何体的人形实例。
 * 每帧 begin() → 若干次 add() → end()，把模拟层的状态刷进 GPU 缓冲。
 */
export class CrowdBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly phase: THREE.InstancedBufferAttribute;
  private readonly animSpeed: THREE.InstancedBufferAttribute;
  private readonly state: THREE.InstancedBufferAttribute;
  private readonly death: THREE.InstancedBufferAttribute;
  private readonly flash: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3(0, 1, 0);
  private n = 0;

  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, readonly capacity: number) {
    const g = geometry;
    const f1 = (len: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(len), 1);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.phase = f1(capacity);
    this.animSpeed = f1(capacity);
    this.state = f1(capacity);
    this.death = f1(capacity);
    this.flash = f1(capacity);
    const tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    tint.setUsage(THREE.DynamicDrawUsage);
    this.tint = tint;

    g.setAttribute('aPhase', this.phase);
    g.setAttribute('aAnimSpeed', this.animSpeed);
    g.setAttribute('aState', this.state);
    g.setAttribute('aDeath', this.death);
    g.setAttribute('aFlash', this.flash);
    g.setAttribute('aTint', this.tint);

    this.mesh = new THREE.InstancedMesh(g, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  begin(): void {
    this.n = 0;
  }

  get used(): number {
    return this.n;
  }

  add(
    x: number, y: number, z: number,
    rotY: number, scale: number,
    phase: number, animSpeed: number,
    state: number, death: number, flash: number,
    tint: THREE.Color = IDENTITY_TINT,
  ): void {
    const i = this.n;
    if (i >= this.capacity) return;
    this.pos.set(x, y, z);
    this.q.setFromAxisAngle(this.axisY, rotY);
    this.scl.set(scale, scale, scale);
    this.m.compose(this.pos, this.q, this.scl);
    this.mesh.setMatrixAt(i, this.m);
    this.phase.array[i] = phase;
    this.animSpeed.array[i] = animSpeed;
    this.state.array[i] = state;
    this.death.array[i] = death;
    this.flash.array[i] = flash;
    this.tint.array[i * 3] = tint.r;
    this.tint.array[i * 3 + 1] = tint.g;
    this.tint.array[i * 3 + 2] = tint.b;
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    if (this.n === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
    for (const a of [this.phase, this.animSpeed, this.state, this.death, this.flash]) {
      a.needsUpdate = true;
      a.addUpdateRange(0, this.n);
    }
    this.tint.needsUpdate = true;
    this.tint.addUpdateRange(0, this.n * 3);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
