import * as THREE from 'three';
import { BLOCK } from '../../config/balance';
import type { BlockObstacle } from '../../sim/types';
import { boltRow, chamferBox, merge, paint, place, plate, roundedBox } from '../geom/hardSurface';
import { bakeSurface, weldSmooth } from '../geom/deform';
import { PRESET, industrial } from '../mat/pbr';

/**
 * 挡路的装甲方块 —— 广告里那块写着 944 的金块。
 *
 * 不再是一个裸盒子加描边：主体是带倒角的箱体，竖棱包了角铁，正面开凹槽装铭牌，
 * 上下有加强肋和成排铆钉，底部有裙板。正面顶着一个白色大数字，只有显示值真正
 * 变了才重画那张 canvas。
 */
export class BlockMesh {
  readonly group = new THREE.Group();
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly baseEmissive: number;
  private readonly numberTex: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private shown = -1;

  constructor(readonly block: BlockObstacle) {
    const w = block.x1 - block.x0;
    const h = block.tall ? BLOCK.wallHeight : BLOCK.height;
    const d = 2.8;
    // 全宽方块本来就是"停下来硬啃"的名场面，天然按金块风格画；半宽的墙
    // 只有带了额外奖励才值得画成金块——这是玩家一眼分辨"这堵墙有没有
    // 奖励"的唯一线索，没有奖励的半宽墙照旧是朴素的钢铁挡板
    const gold = block.span === 'full' || block.bonus > 0;
    const cx = (block.x0 + block.x1) / 2;

    this.baseEmissive = gold ? 0x2c1c00 : 0x0b0e12;
    this.bodyMat = industrial(gold
      ? { ...PRESET.gold(), color: 0xffffff }
      : { ...PRESET.bareSteel(), color: 0xffffff, metalness: 0.55, roughness: 0.46 });
    this.bodyMat.emissive = new THREE.Color(this.baseEmissive);

    const body = new THREE.Mesh(buildArmoredBlock(w, h, d, gold), this.bodyMat);
    body.position.set(cx, h / 2, block.z);
    body.castShadow = true;
    body.receiveShadow = true;
    this.group.add(body);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    this.ctx = canvas.getContext('2d')!;
    this.numberTex = new THREE.CanvasTexture(canvas);
    this.numberTex.colorSpace = THREE.SRGBColorSpace;

    // 数字面片要比铭牌凹槽再往外挪一点。凹槽本身有 0.1 的厚度、中心就在
    // -d/2-0.03，它的前表面比原来的 label 位置还靠近镜头 0.05——数字被自己
    // 那块底板挡在后面，画布上明明画好了，屏幕上一个字都看不见。
    const labelZ = block.z - d / 2 - 0.14;
    const labelW = Math.min(w * 0.62, 6.2);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(labelW, labelW / 2),
      new THREE.MeshBasicMaterial({ map: this.numberTex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    label.position.set(cx, h * 0.58, labelZ);
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
    // 受击提亮。被上百个士兵持续点射时 flash 会一直是满的，所以幅度必须压得很小，
    // 否则整块会烧成一团白光、把泛光也带炸。
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
    ctx.strokeStyle = 'rgba(16,20,28,0.92)';
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, w / 2, h / 2);
    this.numberTex.needsUpdate = true;
  }

  dispose(): void {
    this.numberTex.dispose();
  }
}

/** 装甲箱体：主体 + 角铁 + 加强肋 + 铆钉 + 铭牌凹槽 + 底裙。 */
function buildArmoredBlock(w: number, h: number, d: number, gold: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const base = gold ? 0xd9a326 : 0x9aa2ac;
  const trim = gold ? 0x8d6a15 : 0x5b636d;
  const rivet = gold ? 0xf0d488 : 0xc3cad3;
  const add = (g: THREE.BufferGeometry, c: number) => parts.push(paint(g, c));

  add(roundedBox(w, h, d, Math.min(0.24, h * 0.09), 2), base);

  // 竖棱包角铁：四条棱各两片，读起来是"包边"而不是"倒角"
  const cw = Math.min(0.42, w * 0.12);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(place(chamferBox(cw, h * 0.98, 0.14, 0.04), { x: sx * (w / 2 - cw / 2), z: sz * (d / 2 + 0.02) }), trim);
      add(place(chamferBox(0.14, h * 0.98, cw, 0.04), { x: sx * (w / 2 + 0.02), z: sz * (d / 2 - cw / 2) }), trim);
    }
  }

  // 上下加强肋 + 铆钉排
  const ribCount = Math.max(4, Math.round(w / 1.5));
  for (const sy of [-1, 1]) {
    const y = sy * h * 0.36;
    add(place(chamferBox(w * 0.94, 0.2, d + 0.08, 0.05), { y }), trim);
    for (const sz of [-1, 1]) {
      add(place(
        boltRow(ribCount, new THREE.Vector3(-w * 0.42, 0, 0), new THREE.Vector3(w * 0.42, 0, 0), 0.05, 0.05),
        { y, z: sz * (d / 2 + 0.06), rx: sz * Math.PI / 2 },
      ), rivet);
    }
  }

  // 正面的铭牌凹槽：大数字就贴在这块凹进去的板上
  const plateW = Math.min(w * 0.62, 6);
  add(place(plate(plateW, h * 0.4, 0.1, { corner: 0.12 }), { y: h * 0.08, z: -d / 2 - 0.03 }), trim);

  // 底裙
  add(place(chamferBox(w + 0.16, 0.34, d + 0.16, 0.07), { y: -h / 2 + 0.1 }), trim);

  let geo = merge(parts);
  geo = weldSmooth(geo, 38);
  return bakeSurface(geo, { gridSize: 26, rays: 10, steps: 4 });
}

export function formatHp(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  return String(v);
}
