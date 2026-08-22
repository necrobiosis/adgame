import * as THREE from 'three';
import { BLOCK } from '../../config/balance';
import type { BlockObstacle } from '../../sim/types';

/**
 * 挡路的装甲方块，正面顶着一个白色大数字 —— 就是广告里那块写着 944 的金块。
 * 数字用一张 canvas 贴图，只有显示值真正变了才重画。
 */
export class BlockMesh {
  readonly group = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly baseEmissive: number;
  private readonly numberTex: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private shown = -1;

  constructor(readonly block: BlockObstacle) {
    const w = block.x1 - block.x0;
    const h = BLOCK.height;
    const gold = block.span === 'full';

    this.baseEmissive = gold ? 0x3a2600 : 0x0d1116;
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: gold ? 0xe0a92a : 0x9aa2ac,
      roughness: gold ? 0.28 : 0.55,
      metalness: gold ? 0.85 : 0.6,
      emissive: new THREE.Color(gold ? 0x3a2600 : 0x0d1116),
    });
    this.body = new THREE.Mesh(new THREE.BoxGeometry(w, h, 2.6), this.bodyMat);
    this.body.position.set((block.x0 + block.x1) / 2, h / 2, block.z);
    this.body.castShadow = true;
    this.group.add(this.body);

    // 棱边高光，让金属块的剪影更硬
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.body.geometry),
      new THREE.LineBasicMaterial({ color: gold ? 0xfff0b0 : 0xdfe6ee, transparent: true, opacity: 0.75 }),
    );
    edges.position.copy(this.body.position);
    this.group.add(edges);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    this.ctx = canvas.getContext('2d')!;
    this.numberTex = new THREE.CanvasTexture(canvas);
    this.numberTex.colorSpace = THREE.SRGBColorSpace;

    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(Math.min(w * 0.55, 5.4), Math.min(w * 0.55, 5.4) / 2),
      new THREE.MeshBasicMaterial({ map: this.numberTex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    label.position.set((block.x0 + block.x1) / 2, h * 0.6, block.z - 1.34);
    label.rotation.y = Math.PI;
    label.renderOrder = 4;
    this.group.add(label);

    this.redraw(block.hp);
  }

  update(): void {
    const b = this.block;
    if (!b.alive) {
      this.group.visible = false;
      return;
    }
    const v = Math.max(0, Math.ceil(b.hp));
    if (v !== this.shown) this.redraw(v);
    // 受击提亮。被上百个士兵持续点射时 flash 会一直是满的，
    // 所以这里的幅度必须压得很小，否则整块会烧成一团白光、把泛光也带炸。
    const f = b.flash > 0 ? b.flash / 0.1 : 0;
    this.bodyMat.emissive.setHex(this.baseEmissive).addScalar(f * 0.1);
  }

  private redraw(hp: number): void {
    this.shown = Math.max(0, Math.ceil(hp));
    const ctx = this.ctx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const text = formatHp(this.shown);
    ctx.font = `900 ${text.length > 5 ? 132 : 168}px system-ui,-apple-system,"PingFang SC",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 16;
    ctx.strokeStyle = 'rgba(20,24,32,0.9)';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, w / 2, h / 2);
    this.numberTex.needsUpdate = true;
  }

  dispose(): void {
    this.numberTex.dispose();
  }
}

export function formatHp(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  return String(v);
}
