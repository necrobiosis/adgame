import * as THREE from 'three';
import { ENEMY_STATS, ROAD_HALF } from '../../config/balance';
import type { LaneChoice } from '../../config/levels';
import { gateVisual } from '../../sim/Gates';
import { LANE_SIGN, type Side } from '../../sim/lanes';
import { canvasTexture } from '../env/materials';
import { boltRing, chamferBox, iBeam, lathe, merge, paint, pipe, place, plate } from '../geom/hardSurface';
import { bakeSurface, weldSmooth } from '../geom/deform';
import { PRESET, industrial } from '../mat/pbr';

const WALL_H = 5.4;
const RUNWAY_LEN = 22;

/**
 * 门。
 *
 * 广告里最标志性的画面就是那两面"由无数个 +1 / +99 堆起来、还在往上流动的
 * 发光墙"。这里的做法是：把字形画进一张会平铺的 canvas 贴图，贴在墙面上，
 * 每帧滚动 texture.offset.y —— 一张贴图 + 两个面片就还原了整个效果。
 *
 * 每组门由四块构成：
 *   · 两片横跨车道的判定墙（走进哪一片就吃哪一边的增益）
 *   · 两条沿路面延伸的引导墙（广告里那种一路铺过来的数字长廊）
 * 外加顶部的中文铭牌，写清增益内容和这条车道前方的怪物类型。
 */
export class GateWall {
  readonly group = new THREE.Group();
  private readonly scrolls: THREE.Texture[] = [];

  constructor(z: number, left: LaneChoice, right: LaneChoice) {
    this.group.position.z = z;
    this.build(left, 'left');
    this.build(right, 'right');

    // 承载发光面板的金属门架。没有它，那两片发光墙是凭空浮在路上的。
    const frame = new THREE.Mesh(buildGateFrame(), industrial(PRESET.paintedSteel(0xb8bec8, 0.4)));
    frame.castShadow = true;
    frame.receiveShadow = true;
    this.group.add(frame);
  }

  private build(lane: LaneChoice, side: Side): void {
    const sx = LANE_SIGN[side];
    const v = gateVisual(lane.gate);
    const color = new THREE.Color(v.color);
    const halfW = (ROAD_HALF - 0.5) / 2;
    const cx = sx * (halfW + 0.5);

    const glyphTex = makeGlyphTexture(v.glyph);
    glyphTex.repeat.set(Math.max(2, Math.round(halfW * 2 / 2.6)), Math.round(WALL_H / 1.5));
    this.scrolls.push(glyphTex);

    const wallMat = new THREE.MeshBasicMaterial({
      map: glyphTex,
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    // 判定墙
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(halfW * 2, WALL_H), wallMat);
    wall.position.set(cx, WALL_H / 2, 0);
    // 面朝迎面走来的方阵（-z）。转 180° 之后局部 +x 落在世界 -x，
    // 而世界 -x 正好是屏幕右侧，于是字形是从左往右读的。
    wall.rotation.y = Math.PI;
    wall.renderOrder = 5;
    this.group.add(wall);

    // 引导墙：沿着路边往回延伸的一长条
    const runTex = makeGlyphTexture(v.glyph);
    // 两侧引导墙的朝向相反，其中一侧的字形读向会反过来，用负的 repeat 把 UV 翻回来
    runTex.repeat.set(sx * Math.round(RUNWAY_LEN / 2.6), Math.round(WALL_H / 1.5));
    this.scrolls.push(runTex);
    const runMat = wallMat.clone();
    runMat.map = runTex;
    const runway = new THREE.Mesh(new THREE.PlaneGeometry(RUNWAY_LEN, WALL_H), runMat);
    runway.rotation.y = sx * -Math.PI / 2;
    runway.position.set(sx * (ROAD_HALF - 0.55), WALL_H / 2, -RUNWAY_LEN / 2);
    runway.renderOrder = 5;
    this.group.add(runway);

    // 顶部铭牌
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2 * 0.92, 2.45),
      new THREE.MeshBasicMaterial({
        map: makePlateTexture(v.title, lane, v.color, v.buff),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    plate.position.set(cx, WALL_H + 1.02, -0.05);
    plate.rotation.y = Math.PI;
    plate.renderOrder = 6;
    this.group.add(plate);

    // 地面光带，提示"这里是一道门"
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2, 1.6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }),
    );
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(cx, 0.03, 0);
    this.group.add(strip);
  }

  update(dt: number): void {
    for (const t of this.scrolls) {
      t.offset.y = (t.offset.y - dt * 0.42) % 1;
    }
  }

  /** 通过之后把门熄掉，避免视野里一直挂着已经用过的墙。 */
  fade(k: number): void {
    if (!this.group.visible) return;
    let maxOpacity = 0;
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (m && 'opacity' in m) {
        const mm = m as THREE.MeshBasicMaterial;
        mm.transparent = true;
        mm.opacity = Math.max(0, mm.opacity * k);
        maxOpacity = Math.max(maxOpacity, mm.opacity);
      }
    });
    if (maxOpacity < 0.02) this.group.visible = false;
  }
}

/** 一张平铺的"字形墙"贴图：半透明底 + 亮白字形。 */
function makeGlyphTexture(glyph: string): THREE.CanvasTexture {
  return canvasTexture(256, 160, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    // 底：偏暗，让字形在乘算之后明显更亮
    ctx.fillStyle = 'rgba(150,160,175,0.55)';
    ctx.fillRect(0, 0, w, h);
    // 分格线
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
    // 字形
    const fs = glyph.length <= 3 ? 96 : glyph.length <= 4 ? 72 : 56;
    ctx.font = `900 ${fs}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.98)';
    ctx.fillText(glyph, w / 2, h / 2 + 2);
  });
}

/**
 * 前方那波怪的实际构成，例如 "泰坦×3  重甲×8"。
 *
 * 之前铭牌上只有蜂群/精英/安全三个标签，玩家从来看不到真实数量——
 * 于是"选哪条"更接近抛硬币而不是决策。参考同类游戏的结论很一致：
 * 这类游戏的深度全部来自**看得见的取舍**，信息不给足，门再多也没用。
 */
function waveSummary(wave: LaneChoice['wave']): string {
  const parts = [...wave.groups]
    .filter((g) => g.count > 0)
    .sort((a, b) => ENEMY_STATS[b.kind].gold * b.count - ENEMY_STATS[a.kind].gold * a.count)
    .slice(0, 3)
    .map((g) => `${ENEMY_STATS[g.kind].label}×${g.count}`);
  return parts.join('  ');
}

/** 门顶的中文铭牌：增益 + 标价 + 前方怪物构成。 */
function makePlateTexture(title: string, lane: LaneChoice, color: number, buff: boolean): THREE.CanvasTexture {
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  const cost = lane.gate.cost ?? 0;
  return canvasTexture(512, 260, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    roundRect(ctx, 6, 6, w - 12, h - 12, 22);
    ctx.fillStyle = 'rgba(12,16,24,0.84)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = hex;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 60px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillStyle = buff ? '#ffffff' : '#ff9c9c';
    ctx.fillText(title, w / 2, 58);

    // 标价（免费车道就不占这一行）
    if (cost > 0) {
      ctx.font = '800 44px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
      ctx.fillStyle = '#ffd44d';
      ctx.fillText(`💰 ${cost}`, w / 2, 124);
    }

    // 前方那波怪的真实构成
    const isSwarm = lane.hint === '蜂群';
    const badge = isSwarm ? '#7fd0ff' : lane.hint === '安全' ? '#8effb0' : '#ff8b6a';
    ctx.font = '700 36px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillStyle = badge;
    ctx.fillText(lane.hint, w / 2, cost > 0 ? 176 : 138);
    ctx.font = '600 32px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillStyle = 'rgba(226,232,240,0.86)';
    ctx.fillText(waveSummary(lane.wave), w / 2, cost > 0 ? 220 : 190);
  }, { wrap: THREE.ClampToEdgeWrapping });
}

/**
 * 门架：两侧立柱 + 中央分隔柱 + 顶横梁 + 投影仪外壳 + 线缆。
 * 结构件用工字钢和带倒角的板，和桥上的桁架是同一套语言。
 */
function buildGateFrame(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, c: number) => parts.push(paint(g, c));
  const H = WALL_H + 1.5;
  const colX = ROAD_HALF + 0.55;

  for (const sx of [-1, 0, 1]) {
    const x = sx * colX;
    const wide = sx === 0;
    add(place(iBeam(H, wide
      ? { height: 0.46, width: 0.4, web: 0.075, flange: 0.08 }
      : { height: 0.56, width: 0.46, web: 0.085, flange: 0.09 },
    ), { x, y: H / 2 }), 0xffffff);
    // 柱脚：底板 + 螺栓圈
    add(place(plate(0.9, 0.9, 0.09, { corner: 0.08 }), { x, y: 0.05, rx: Math.PI / 2 }), 0xdfe3e9);
    add(place(boltRing(6, 0.32, 0.045, 0.05), { x, y: 0.1 }), 0x8b929b);
    // 柱头
    add(place(plate(0.8, 0.8, 0.08, { corner: 0.07 }), { x, y: H - 0.04, rx: Math.PI / 2 }), 0xdfe3e9);
  }

  // 顶横梁：抬到铭牌上方，截面收细
  add(place(iBeam(colX * 2 + 0.6, { height: 0.26, width: 0.22, web: 0.045, flange: 0.05 }), { y: H + 0.72, rz: Math.PI / 2 }), 0xf2f4f7);
  // 横梁下的斜撑，让门架不是两根光杆加一根横杠
  for (const sx of [-1, 1]) {
    add(place(chamferBox(0.14, 1.5, 0.1, 0.03), { x: sx * (colX - 0.55), y: H + 0.32, z: 0, rz: sx * 0.72 }), 0xe2e6ec);
  }
  // 走线：细管而不是一整条槽
  for (const dz of [-0.16, 0.16]) {
    add(place(pipe([
      new THREE.Vector3(-colX, H + 0.86, dz), new THREE.Vector3(0, H + 0.79, dz), new THREE.Vector3(colX, H + 0.86, dz),
    ], 0.035, 5), {}), 0x3a3e45);
  }

  // 投影仪外壳：每片面板上下各一个，把发光面"装"进硬件里
  for (const sx of [-1, 1]) {
    const cx = sx * (ROAD_HALF - 0.5) / 2 * 2 * 0.5;
    for (const sy of [0, 1]) {
      const y = sy === 0 ? 0.34 : WALL_H - 0.2;
      add(place(lathe([
        [0.0, 0], [0.16, 0.02], [0.19, 0.07], [0.19, 0.4], [0.15, 0.46], [0.0, 0.48],
      ], 10), { x: cx, y, z: 0.26, rx: sy === 0 ? -Math.PI / 2 : Math.PI / 2 }), 0x4d545d);
      add(place(chamferBox(0.5, 0.22, 0.3, 0.05), { x: cx, y: y + (sy === 0 ? -0.16 : 0.16), z: 0.26 }), 0x6f767f);
    }
    // 从柱子接到外壳的线缆
    add(place(pipe([
      new THREE.Vector3(sx * colX * 0.98, H + 0.42, -0.16),
      new THREE.Vector3(cx + sx * 0.6, WALL_H + 0.5, 0.12),
      new THREE.Vector3(cx, WALL_H + 0.05, 0.26),
    ], 0.05, 5), {}), 0x2a2d33);
  }

  return bakeSurface(weldSmooth(merge(parts), 38), { gridSize: 26, rays: 10, steps: 4 });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
