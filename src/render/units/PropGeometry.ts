import * as THREE from 'three';
import {
  boltRing,
  boltRow,
  chamferBox,
  flange,
  hexBolt,
  lathe,
  merge,
  paint,
  pipe,
  place,
  plate,
  roundedBox,
} from '../geom/hardSurface';
import { bakeSurface, weldSmooth } from '../geom/deform';

/**
 * 场上的机械道具。
 *
 * 这些是离镜头最近、最经得起细看的资产，所以细节给足：倒角、法兰、螺栓、
 * 铆钉、面板缝、提把、液压缸一样不少。整个几何体在构建期烘一次 AO 和边缘
 * 磨损，运行时零成本。
 */

const STEEL = 0x767d87;
const DARK_STEEL = 0x3d434c;
const PAINT = 0x35506e;
const PAINT_DARK = 0x24354a;
const BRASS = 0x9a7b3f;
const RUBBER = 0x1e2126;

/**
 * 大炮：方阵后排改装出来的火炮。
 *
 * 结构照真实牵引式榴弹炮走：炮身（药室 → 身管 → 炮口制退器）、摇架、
 * 两根驻退复进筒、带辐条的车轮、分开的大架与驻锄、铆接防盾、高低机手轮、
 * 弹药箱。面朝 +z，原点在地面。
 */
export function cannonGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, c: number) => parts.push(paint(g, c));

  const axleY = 0.46;

  // ── 车轮 ───────────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    const x = sx * 0.62;
    // 轮胎：断面是圆的，不是一个平板圆柱
    add(place(lathe([
      [0.30, -0.09], [0.38, -0.085], [0.44, -0.045], [0.455, 0],
      [0.44, 0.045], [0.38, 0.085], [0.30, 0.09],
    ], 14), { x, y: axleY, z: 0, rz: Math.PI / 2 }), RUBBER);
    // 轮辋
    add(place(lathe([
      [0.16, -0.055], [0.30, -0.06], [0.32, -0.03], [0.32, 0.03], [0.30, 0.06], [0.16, 0.055],
    ], 12), { x, y: axleY, z: 0, rz: Math.PI / 2 }), STEEL);
    // 轮辐：六根，带一点厚度
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(place(chamferBox(0.055, 0.30, 0.038, 0.012), {
        x, y: axleY + Math.cos(a) * 0.155, z: Math.sin(a) * 0.155,
        rx: -a, s: [1, 1, 1],
      }), STEEL);
    }
    // 轮毂 + 一圈螺栓
    add(place(lathe([[0.0, 0.075], [0.09, 0.075], [0.115, 0.05], [0.115, -0.05], [0.09, -0.075], [0.0, -0.075]], 10),
      { x: x + sx * 0.02, y: axleY, z: 0, rz: Math.PI / 2 }), DARK_STEEL);
    add(place(boltRing(4, 0.07, 0.019, 0.022), { x: x + sx * 0.095, y: axleY, z: 0, rz: sx * Math.PI / 2 }), DARK_STEEL);
  }
  // 车轴
  add(place(lathe([[0.055, -0.62], [0.055, 0.62]], 10), { y: axleY, rz: Math.PI / 2 }), DARK_STEEL);

  // ── 大架与驻锄 ─────────────────────────────────────────────
  for (const sx of [-1, 1]) {
    const g = chamferBox(0.11, 0.15, 1.15, 0.03);
    add(place(g, { x: sx * 0.26, y: axleY - 0.13, z: -0.62, rx: 0.1, ry: sx * 0.16 }), PAINT);
    // 驻锄
    add(place(plate(0.16, 0.26, 0.05, { corner: 0.03 }), {
      x: sx * 0.4, y: axleY - 0.3, z: -1.18, rx: 1.15, ry: sx * 0.16,
    }), DARK_STEEL);
    // 提把
    add(place(pipe([
      new THREE.Vector3(sx * 0.2, axleY - 0.02, -0.95),
      new THREE.Vector3(sx * 0.33, axleY + 0.06, -1.02),
      new THREE.Vector3(sx * 0.2, axleY - 0.02, -1.09),
    ], 0.018, 6), {}), DARK_STEEL);
  }
  // 大架横撑
  add(place(chamferBox(0.62, 0.07, 0.09, 0.02), { y: axleY - 0.16, z: -0.72 }), PAINT_DARK);

  // ── 摇架 ───────────────────────────────────────────────────
  add(place(roundedBox(0.44, 0.30, 0.72, 0.055, 3), { y: axleY + 0.24, z: 0.08 }), PAINT);
  // 摇架上的面板缝：一条浅浅的凹槽
  add(place(chamferBox(0.46, 0.02, 0.5, 0.006), { y: axleY + 0.34, z: 0.08 }), PAINT_DARK);
  // 耳轴
  for (const sx of [-1, 1]) {
    add(place(lathe([[0.0, 0.05], [0.06, 0.05], [0.075, 0.02], [0.075, -0.05], [0.0, -0.05]], 9),
      { x: sx * 0.25, y: axleY + 0.24, z: 0.04, rz: Math.PI / 2 }), DARK_STEEL);
  }

  // ── 驻退复进筒 ─────────────────────────────────────────────
  for (const sy of [-1, 1]) {
    add(place(lathe([
      [0.055, 0], [0.062, 0.04], [0.062, 0.62], [0.05, 0.66], [0.05, 0.78],
    ], 9), { y: axleY + 0.28 + sy * 0.13, z: 0.16, rx: Math.PI / 2 }), STEEL);
    add(place(flange(0.05, 0.082, 0.035), { y: axleY + 0.28 + sy * 0.13, z: 0.2, rx: Math.PI / 2 }), DARK_STEEL);
  }

  // ── 炮身 ───────────────────────────────────────────────────
  // 药室 → 身管：口径明显收一次，中间有一道加强环
  add(place(lathe([
    [0.145, -0.30], [0.155, -0.26], [0.155, -0.10], [0.135, -0.06],
    [0.105, 0.0], [0.098, 0.55], [0.104, 0.60], [0.098, 0.65], [0.09, 1.28],
  ], 12), { y: axleY + 0.28, z: 0.1, rx: Math.PI / 2 }), STEEL);
  // 炮口制退器：带侧向排气口
  add(place(lathe([
    [0.09, 0], [0.135, 0.02], [0.14, 0.10], [0.125, 0.12], [0.125, 0.20], [0.14, 0.22], [0.135, 0.28], [0.09, 0.30],
  ], 10), { y: axleY + 0.28, z: 1.38, rx: Math.PI / 2 }), DARK_STEEL);
  for (const sx of [-1, 1]) {
    add(place(chamferBox(0.06, 0.05, 0.055, 0.012), { x: sx * 0.11, y: axleY + 0.28, z: 1.45 }), 0x14171b);
  }
  // 炮闩 + 操作手柄
  add(place(chamferBox(0.20, 0.22, 0.16, 0.035), { y: axleY + 0.28, z: -0.24 }), DARK_STEEL);
  add(place(pipe([
    new THREE.Vector3(0.10, axleY + 0.30, -0.26),
    new THREE.Vector3(0.22, axleY + 0.26, -0.30),
    new THREE.Vector3(0.24, axleY + 0.14, -0.30),
  ], 0.017, 6), {}), BRASS);

  // ── 防盾 ───────────────────────────────────────────────────
  const shield = plate(1.06, 0.62, 0.028, { corner: 0.09 });
  add(place(shield, { y: axleY + 0.36, z: 0.44, rx: -0.20 }), PAINT);
  // 铆钉排
  add(place(boltRow(5, new THREE.Vector3(-0.46, 0, 0), new THREE.Vector3(0.46, 0, 0), 0.017, 0.018), {
    y: axleY + 0.66, z: 0.40, rx: -0.20 + Math.PI / 2,
  }), DARK_STEEL);
  add(place(boltRow(5, new THREE.Vector3(-0.46, 0, 0), new THREE.Vector3(0.46, 0, 0), 0.017, 0.018), {
    y: axleY + 0.08, z: 0.52, rx: -0.20 + Math.PI / 2,
  }), DARK_STEEL);
  // 观察窗的翻板
  add(place(plate(0.26, 0.10, 0.022, { corner: 0.02 }), { x: -0.26, y: axleY + 0.54, z: 0.415, rx: -0.20 }), DARK_STEEL);

  // ── 高低机手轮 ─────────────────────────────────────────────
  add(place(lathe([[0.0, 0.02], [0.10, 0.02], [0.115, 0.008], [0.115, -0.008], [0.10, -0.02], [0.0, -0.02]], 10),
    { x: 0.30, y: axleY + 0.14, z: -0.08, rz: Math.PI / 2 }), DARK_STEEL);
  add(place(hexBolt(0.03, 0.05), { x: 0.36, y: axleY + 0.14, z: -0.08, rz: -Math.PI / 2 }), BRASS);

  // ── 弹药箱 ─────────────────────────────────────────────────
  add(place(roundedBox(0.34, 0.20, 0.46, 0.035, 2), { x: -0.34, y: axleY - 0.16, z: -0.6, ry: 0.16 }), PAINT_DARK);
  add(place(chamferBox(0.30, 0.03, 0.42, 0.008), { x: -0.34, y: axleY - 0.05, z: -0.6, ry: 0.16 }), BRASS);

  let geo = merge(parts);
  geo = weldSmooth(geo, 38);
  geo = bakeSurface(geo, { gridSize: 30, rays: 12, steps: 5 });
  return geo;
}

/** 炮弹：尖卵形弹头 + 弹带。 */
export function shellGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(lathe([
    [0.0, -0.26], [0.06, -0.25], [0.072, -0.18], [0.075, 0.04],
    [0.06, 0.16], [0.035, 0.24], [0.0, 0.27],
  ], 10), 0x4a4136));
  parts.push(paint(place(lathe([[0.075, -0.02], [0.083, -0.01], [0.083, 0.01], [0.075, 0.02]], 10), { y: -0.16 }), BRASS));
  let geo = merge(parts);
  geo = weldSmooth(geo, 45);
  geo.rotateX(Math.PI / 2);
  return geo;
}
