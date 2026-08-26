import * as THREE from 'three';

/**
 * 火线指示：地面上一条跟着方阵走的亮带。
 *
 * 枪不自瞄，子弹只往正前方飞——所以"我的火力落在哪"是玩家必须一眼看见的
 * 信息，否则"站错排"这件事只能靠打不死怪来事后察觉，学不会。这条带子把
 * 抽象的判定条件直接画在地上：带子里面的东西打得到，外面的打不到。
 *
 * 做法是一张加色的长条，用竖直方向的渐变把远端收掉——既标出射程，又不会
 * 在远处糊成一块实心色板。
 */
export class FireLane {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor() {
    const tex = makeGradient();
    this.mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.36,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
  }

  /** 每帧跟上方阵：宽度 = 走廊宽，长度 = 射程。 */
  update(x: number, z: number, halfWidth: number, range: number, tracer: number): void {
    this.mesh.scale.set(halfWidth * 2, range, 1);
    this.mesh.position.set(x, 0.035, z + range / 2);
    this.mat.color.setHex(tracer);
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.map?.dispose();
    this.mat.dispose();
  }
}

/** 近端亮、远端淡到零的一维渐变，两侧再压一条更亮的边。 */
function makeGradient(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0, c.height, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  // 两侧的边线：让"走廊有多宽"这件事有一条明确的界
  ctx.globalCompositeOperation = 'lighter';
  const edge = ctx.createLinearGradient(0, c.height, 0, 0);
  edge.addColorStop(0, 'rgba(255,255,255,0.85)');
  edge.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, 4, c.height);
  ctx.fillRect(c.width - 4, 0, 4, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
