import * as THREE from 'three';
import { ROAD_HALF } from '../../config/balance';
import type { LaneChoice } from '../../config/levels';
import { gateVisual } from '../../sim/Gates';
import { LANE_SIGN, type Side } from '../../sim/lanes';
import { canvasTexture } from '../env/materials';

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

    // 中间的分隔柱，让"二选一"在视觉上没有歧义
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, WALL_H + 1.4, 0.9),
      new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.5, metalness: 0.25 }),
    );
    post.position.set(0, (WALL_H + 1.4) / 2, 0);
    this.group.add(post);
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
      new THREE.PlaneGeometry(halfW * 2 * 0.92, 1.9),
      new THREE.MeshBasicMaterial({
        map: makePlateTexture(v.title, lane.hint, v.color, v.buff),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    plate.position.set(cx, WALL_H + 1.1, -0.05);
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

/** 门顶的中文铭牌。 */
function makePlateTexture(title: string, hint: string, color: number, buff: boolean): THREE.CanvasTexture {
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  return canvasTexture(512, 200, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    roundRect(ctx, 6, 6, w - 12, h - 12, 22);
    ctx.fillStyle = 'rgba(12,16,24,0.82)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = hex;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '800 64px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillStyle = buff ? '#ffffff' : '#ff9c9c';
    ctx.fillText(title, w / 2, 66);

    // 前方车道预告
    const isSwarm = hint === '蜂群';
    const badge = isSwarm ? '#7fd0ff' : hint === '安全' ? '#8effb0' : '#ff8b6a';
    ctx.font = '700 40px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.fillStyle = badge;
    ctx.fillText(`前方：${hint}`, w / 2, 140);
  }, { wrap: THREE.ClampToEdgeWrapping });
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
