import * as THREE from 'three';
import { BLOCK, WEAPON_TIERS } from '../../config/balance';
import type { BlockObstacle } from '../../sim/types';
import { boltRow, chamferBox, lathe, merge, paint, place, plate, roundedBox } from '../geom/hardSurface';
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
  private shownKey = '';

  constructor(readonly block: BlockObstacle) {
    const w = block.x1 - block.x0;
    const h = block.tall ? BLOCK.wallHeight : BLOCK.height;
    const d = 2.8;
    // 三种墙要在三十米外就分得开。规则是同一套——都长着倒刺、都跟着路
    // 往后走、都只占一排——区别只在墙上写着什么：
    //  · 金币墙 = 金块，打穿给钱
    //  · 军械墙 = 冷色装甲板 + 一把发光的枪，打穿直接换上那把枪
    //  · 纯挡路 = 朴素钢板，什么都不给
    const armory = block.rewardWeapon !== undefined;
    const gold = !armory && block.bonus > 0;
    const cx = (block.x0 + block.x1) / 2;

    this.baseEmissive = gold ? 0x2c1c00 : armory ? 0x081826 : 0x0b0e12;
    this.bodyMat = industrial(gold
      ? { ...PRESET.gold(), color: 0xffffff }
      : { ...PRESET.bareSteel(), color: armory ? 0x8fb6d8 : 0xffffff, metalness: armory ? 0.75 : 0.55, roughness: armory ? 0.34 : 0.46 });
    this.bodyMat.emissive = new THREE.Color(this.baseEmissive);

    const body = new THREE.Mesh(buildArmoredBlock(w, h, d, gold, armory), this.bodyMat);
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
    // 军械墙的画面主角就是墙上那把枪，牌子要占掉大半堵墙；
    // 普通墙上只有一个血量数字，小一点更耐看
    const labelW = armory ? Math.min(w * 0.9, 8.6) : Math.min(w * 0.62, 6.2);
    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(labelW, labelW * (armory ? 0.58 : 0.5)),
      new THREE.MeshBasicMaterial({ map: this.numberTex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    label.position.set(cx, h * 0.58, labelZ);
    label.rotation.y = Math.PI;
    label.renderOrder = 4;
    this.group.add(label);

    this.shownKey = armory ? `${formatHp(Math.ceil(block.hp))}|220` : formatHp(Math.ceil(block.hp));
    this.redraw(block.hp);
  }

  update(): void {
    const b = this.block;
    if (!b.alive) {
      this.group.visible = false;
      return;
    }
    const v = Math.max(0, Math.ceil(b.hp));
    // 军械墙的牌面上有血条，数字没变但血条掉了一格也要重画——
    // formatHp 只精确到 "18K" 那一档，光比数字的话血条会一格一格地跳。
    const key = this.block.rewardWeapon !== undefined
      ? `${formatHp(v)}|${Math.round((v / b.maxHp) * 220)}`
      : formatHp(v);
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.redraw(v);
    }
    // 受击提亮。被上百个士兵持续点射时 flash 会一直是满的，所以幅度必须压得很小，
    // 否则整块会烧成一团白光、把泛光也带炸。
    const f = b.flash > 0 ? b.flash / 0.1 : 0;
    this.bodyMat.emissive.setHex(this.baseEmissive).addScalar(f * 0.1);
  }

  private redraw(hp: number): void {
    const ctx = this.ctx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const text = formatHp(Math.max(0, Math.ceil(hp)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const reward = this.block.rewardWeapon;
    if (reward === undefined) {
      // 普通墙 / 金币墙：一个大血量数字，完事
      ctx.font = `900 ${text.length > 5 ? 132 : 168}px system-ui,-apple-system,"PingFang SC",sans-serif`;
      ctx.lineWidth = 16;
      ctx.strokeStyle = 'rgba(16,20,28,0.92)';
      ctx.strokeText(text, w / 2, h / 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, w / 2, h / 2);
      this.numberTex.needsUpdate = true;
      return;
    }

    // 军械墙：墙上印的是枪，不是数字。玩家在几十米外要读到的第一件事是
    // "那堵墙上有把好枪"，血量只是次要信息，所以枪的图案占大头、数字缩到下面。
    const tier = WEAPON_TIERS[Math.min(reward, WEAPON_TIERS.length - 1)]!;
    drawWeaponGlyph(ctx, w / 2, h * 0.42, w * 0.78, reward, tier.tracer);
    ctx.font = `900 46px system-ui,-apple-system,"PingFang SC",sans-serif`;
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(16,20,28,0.92)';
    ctx.strokeText(`${tier.name}  ${text}`, w / 2, h * 0.86);
    ctx.fillStyle = '#ffe9b8';
    ctx.fillText(`${tier.name}  ${text}`, w / 2, h * 0.86);
    // 血条：数字只精确到 "18K" 那一档，冲刺途中光看数字读不出还剩多少
    const frac = Math.max(0, Math.min(1, this.block.maxHp > 0 ? hp / this.block.maxHp : 0));
    const bw = w * 0.72;
    const bx = (w - bw) / 2;
    const by = h * 0.955;
    ctx.fillStyle = 'rgba(10,14,20,0.85)';
    ctx.fillRect(bx - 4, by - 11, bw + 8, 22);
    ctx.fillStyle = '#ffb43c';
    ctx.fillRect(bx, by - 7, bw * frac, 14);
    this.numberTex.needsUpdate = true;
  }

  dispose(): void {
    this.numberTex.dispose();
  }
}

/** 装甲箱体：主体 + 角铁 + 加强肋 + 铆钉 + 铭牌凹槽 + 底裙。 */
function buildArmoredBlock(
  w: number, h: number, d: number,
  gold: boolean,
  /** 军械墙：正面那块铭牌要占掉大半堵墙，枪的图案才看得清。 */
  armory: boolean,
): THREE.BufferGeometry {
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
  // 军械墙上的凹槽要大：墙上那把枪是它唯一要讲的事
  const plateW = armory ? Math.min(w * 0.9, 8.4) : Math.min(w * 0.62, 6);
  add(place(plate(plateW, h * (armory ? 0.52 : 0.4), 0.1, { corner: 0.12 }), { y: h * 0.08, z: -d / 2 - 0.03 }), trim);

  // 底裙
  add(place(chamferBox(w + 0.16, 0.34, d + 0.16, 0.07), { y: -h / 2 + 0.1 }), trim);

  // ── 倒刺 ────────────────────────────────────────────────────
  // 撞上这堵墙的人是被这排刺串死的，所以刺必须真的长在朝着玩家的那一面上。
  //
  // 但镜头几乎是顺着 z 轴正对着墙看的，正面那些刺投影下来只剩一个个小圆点，
  // 光靠它们读不出"扎人"。真正撑起"这堵墙有刺"的是**轮廓**：顶边一排朝前
  // 上方翘起的长刺（衬在天空上）和两侧竖边朝外的刺（衬在路面上）。
  // 正面的那层照做，负责近距离和撞上去那一瞬间的观感。
  const spikeLen = Math.min(1.35, d * 0.55);
  const spike = (r0: number, len: number) => lathe([
    [r0, 0], [r0 * 0.78, len * 0.3], [r0 * 0.4, len * 0.68], [0.005, len],
  ], 6);

  // 正面：交错排布的钉板，铭牌那一圈留空
  const cols = Math.max(3, Math.round(w / 1.15));
  const rows = Math.max(2, Math.round(h / 1.7));
  const plateTop = h * 0.08 + h * 0.2;
  const plateBottom = h * 0.08 - h * 0.2;
  for (let r = 0; r < rows; r++) {
    const y = -h / 2 + ((r + 0.5) / rows) * h;
    for (let c = 0; c < cols; c++) {
      const x = -w / 2 + ((c + 0.5) / cols) * w;
      if (y > plateBottom && y < plateTop && Math.abs(x) < plateW / 2 + 0.2) continue;
      const jx = (r % 2) * (w / cols) * 0.5;
      const px = Math.max(-w / 2 + 0.2, Math.min(w / 2 - 0.2, x + jx));
      // rx = -90°：车削件沿 +Y 长出来，绕 X 负转九十度才把尖头指到 -Z，
      // 也就是玩家那一侧。转 +90° 的话刺全部扎进墙里，一根都看不见。
      add(place(spike(0.24, spikeLen), { x: px, y, z: -d / 2 + 0.06, rx: -Math.PI / 2 }), rivet);
    }
  }

  // 顶边：一排朝前上方翘起的长刺。这一排是衬在天空上的，
  // 也是玩家在三十米外唯一真正读得到"有刺"的东西
  const topN = Math.max(4, Math.round(w / 0.95));
  for (let i = 0; i < topN; i++) {
    const x = -w / 2 + ((i + 0.5) / topN) * w;
    add(place(spike(0.2, spikeLen * 1.5), {
      x, y: h / 2 - 0.1, z: -d / 2 + 0.35, rx: -1.05,
    }), rivet);
  }

  // 两侧竖边：朝外斜出去的刺，衬在路面上，把轮廓再撑宽一圈
  const sideN = Math.max(2, Math.round(h / 1.5));
  for (const sx of [-1, 1]) {
    for (let i = 0; i < sideN; i++) {
      const y = -h / 2 + ((i + 0.5) / sideN) * h;
      add(place(spike(0.18, spikeLen * 1.2), {
        x: sx * (w / 2 - 0.05), y, z: -d / 4, rz: sx * Math.PI / 2,
      }), rivet);
    }
  }

  let geo = merge(parts);
  geo = weldSmooth(geo, 38);
  return bakeSurface(geo, { gridSize: 26, rays: 10, steps: 4 });
}

/**
 * 门上那把枪的剪影。
 *
 * 不去做八套精确的枪械插画——在三十米外的一块铁板上，玩家读到的只有轮廓：
 * 枪管有多长、下面挂没挂弹鼓、前面有没有多出来的管子。所以按等级堆几个
 * 矩形就够了，等级越高越夸张，配上那把枪的曳光弹颜色做描边。
 */
function drawWeaponGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, width: number,
  tier: number, tint: number,
): void {
  const u = width / 100;
  const col = `#${tint.toString(16).padStart(6, '0')}`;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(12,15,20,0.95)';
  const box = (x: number, y: number, bw: number, bh: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.rect(x * u, y * u, bw * u, bh * u);
    ctx.fill();
    ctx.stroke();
  };
  const steel = '#cdd4dc';
  // 机匣：所有等级共用的底座，越往上越粗
  const bulk = 1 + tier * 0.16;
  box(-26, -6 * bulk, 40, 12 * bulk, steel);
  // 枪管：长度和等级挂钩
  box(14, -4 * bulk, 12 + tier * 7, 8 * bulk, steel);
  // 枪托
  if (tier !== 1) box(-44, -5, 18, 11, '#8a7050');
  else box(-48, -7, 22, 15, '#8a7050');
  // 弹匣 / 弹鼓
  if (tier >= 4) {
    ctx.fillStyle = steel;
    ctx.beginPath();
    ctx.arc(-6 * u, 16 * u, 15 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    box(-8, 5, 12, 18 + tier * 2, steel);
  }
  // 高等级的附加件：多出来的管子 / 线圈 / 发光的能量槽
  if (tier === 1) {
    box(14, 4 * bulk, 12 + tier * 7, 7, steel); // 霰弹的第二根管
  }
  if (tier >= 5) {
    for (let i = 0; i < 3; i++) box(20 + i * 14, -9 * bulk, 6, 18 * bulk, '#8e98a4');
  }
  if (tier >= 6) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.rect(16 * u, -2 * u, (16 + tier * 6) * u, 4 * u);
    ctx.fill();
  }
  ctx.restore();
  // 整体再描一圈这把枪的曳光弹颜色，远处一眼就看得出是"好东西"
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.shadowColor = col;
  ctx.shadowBlur = 26;
  ctx.strokeStyle = col;
  ctx.lineWidth = 4;
  ctx.strokeRect(cx - width / 2, cy - width * 0.24, width, width * 0.48);
  ctx.restore();
}

export function formatHp(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  return String(v);
}
