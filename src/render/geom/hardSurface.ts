import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { LoftGeometry } from 'three/examples/jsm/geometries/LoftGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 硬表面几何原语。
 *
 * 整个项目不下载任何模型资源，所有可见物体都在这里拼出来。原则：
 *   · 不直接使用裸的 BoxGeometry / CylinderGeometry 作为最终可见资产
 *   · 所有暴露在外的硬边都要有倒角或圆角 —— 现实里没有绝对锐利的 90° 棱
 *   · 只在能改善剪影的地方加分段，平面上不浪费三角形
 */

/** 所有原语统一带这套属性，才能安全 merge。 */
const REQUIRED = ['position', 'normal', 'uv'] as const;

/** 圆角盒。替代裸 BoxGeometry —— 这是本项目里最常用的一块砖。 */
export function roundedBox(w: number, h: number, d: number, radius?: number, segments = 3): THREE.BufferGeometry {
  const r = radius ?? Math.min(w, h, d) * 0.12;
  return new RoundedBoxGeometry(w, h, d, segments, Math.min(r, Math.min(w, h, d) * 0.49));
}

/** 机加工切角盒：单段倒角，读起来是"铣掉一刀"而不是"磨圆了"。 */
export function chamferBox(w: number, h: number, d: number, chamfer?: number): THREE.BufferGeometry {
  const c = chamfer ?? Math.min(w, h, d) * 0.08;
  return new RoundedBoxGeometry(w, h, d, 1, Math.min(c, Math.min(w, h, d) * 0.49));
}

/** 圆角矩形轮廓，挤出类零件的通用截面。 */
export function roundedRectShape(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const rr = Math.min(r, Math.min(w, h) / 2);
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

/** 带倒角的钢板。沿 z 挤出，居中。 */
export function plate(w: number, h: number, t: number, opts?: { corner?: number; bevel?: number }): THREE.BufferGeometry {
  const bevel = opts?.bevel ?? Math.min(t * 0.3, 0.03);
  const g = new THREE.ExtrudeGeometry(roundedRectShape(w, h, opts?.corner ?? Math.min(w, h) * 0.1), {
    depth: Math.max(0.001, t - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 6,
  });
  g.translate(0, 0, -(t - bevel * 2) / 2);
  return g;
}

/**
 * 工字钢。挤出 I 字截面并倒角，腹板与翼缘的交界带圆角 —— 真实的轧制型材
 * 就是这个样子，和用方棍充数完全是两种观感。沿 y 轴延伸。
 */
export function iBeam(length: number, opts?: { height?: number; width?: number; web?: number; flange?: number }): THREE.BufferGeometry {
  const H = opts?.height ?? 0.34;
  const W = opts?.width ?? 0.26;
  const web = opts?.web ?? 0.055;
  const fl = opts?.flange ?? 0.06;
  const fillet = Math.min(web, fl) * 0.7;

  const s = new THREE.Shape();
  const hw = W / 2;
  const hh = H / 2;
  const hweb = web / 2;
  s.moveTo(-hw, -hh);
  s.lineTo(hw, -hh);
  s.lineTo(hw, -hh + fl);
  s.lineTo(hweb + fillet, -hh + fl);
  s.quadraticCurveTo(hweb, -hh + fl, hweb, -hh + fl + fillet);
  s.lineTo(hweb, hh - fl - fillet);
  s.quadraticCurveTo(hweb, hh - fl, hweb + fillet, hh - fl);
  s.lineTo(hw, hh - fl);
  s.lineTo(hw, hh);
  s.lineTo(-hw, hh);
  s.lineTo(-hw, hh - fl);
  s.lineTo(-hweb - fillet, hh - fl);
  s.quadraticCurveTo(-hweb, hh - fl, -hweb, hh - fl - fillet);
  s.lineTo(-hweb, -hh + fl + fillet);
  s.quadraticCurveTo(-hweb, -hh + fl, -hweb - fillet, -hh + fl);
  s.lineTo(-hw, -hh + fl);
  s.closePath();

  const bevel = Math.min(0.012, fl * 0.25);
  const g = new THREE.ExtrudeGeometry(s, {
    depth: length - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 3,
  });
  // 挤出方向默认是 +z，转成沿 y 延伸并居中
  g.translate(0, 0, -(length - bevel * 2) / 2);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** 六角螺栓：带倒角的六角头 + 一小段柱身。密集复用，面数刻意压得很低。 */
export function hexBolt(r: number, h: number): THREE.BufferGeometry {
  const head = new THREE.CylinderGeometry(r, r * 0.96, h, 6, 1);
  head.translate(0, h / 2, 0);
  // 顶面倒角，避免六角头是一块生硬的平板
  const cap = new THREE.CylinderGeometry(r * 0.72, r * 0.99, h * 0.22, 6, 1);
  cap.translate(0, h * 0.94, 0);
  const shank = new THREE.CylinderGeometry(r * 0.55, r * 0.55, h * 0.7, 6, 1);
  shank.translate(0, -h * 0.3, 0);
  return merge([head, cap, shank]);
}

/** 沿一圈排布螺栓。 */
export function boltRing(count: number, radius: number, boltR: number, boltH: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const b = hexBolt(boltR, boltH);
    b.rotateY(a);
    b.translate(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    parts.push(b);
  }
  return merge(parts);
}

/** 沿一条直线排布螺栓。 */
export function boltRow(count: number, from: THREE.Vector3, to: THREE.Vector3, boltR: number, boltH: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const p = new THREE.Vector3().lerpVectors(from, to, t);
    const b = hexBolt(boltR, boltH);
    b.rotateY(i * 0.7);
    b.translate(p.x, p.y, p.z);
    parts.push(b);
  }
  return merge(parts);
}

/** 法兰盘：带圆角过渡的环形凸缘。 */
export function flange(innerR: number, outerR: number, thickness: number): THREE.BufferGeometry {
  const t = thickness;
  const pts: THREE.Vector2[] = [
    new THREE.Vector2(innerR, 0),
    new THREE.Vector2(outerR - t * 0.35, 0),
    new THREE.Vector2(outerR, t * 0.35),
    new THREE.Vector2(outerR, t * 0.65),
    new THREE.Vector2(outerR - t * 0.35, t),
    new THREE.Vector2(innerR, t),
  ];
  return new THREE.LatheGeometry(pts, 20);
}

/** 车削件：给一条侧轮廓，绕 y 轴旋成回转体。炮管、液压缸、灯罩都靠它。 */
export function lathe(profile: readonly [number, number][], segments = 20): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)), segments);
}

/** 沿路径扫出的管子：线缆、液压管、扶手。 */
export function pipe(points: readonly THREE.Vector3[], radius: number, radialSegments = 8, tubular?: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => p.clone()));
  return new THREE.TubeGeometry(curve, tubular ?? Math.max(8, points.length * 4), radius, radialSegments, false);
}

/** 百叶散热口：一排带角度的叶片，嵌在一个凹槽里。 */
export function vent(w: number, h: number, blades: number, depth = 0.04): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const frame = plate(w, h, depth * 0.5, { corner: Math.min(w, h) * 0.12 });
  parts.push(frame);
  const bh = h / (blades + 0.5);
  for (let i = 0; i < blades; i++) {
    const b = chamferBox(w * 0.86, bh * 0.55, depth, bh * 0.12);
    b.rotateX(-0.5);
    b.translate(0, h / 2 - bh * (i + 0.75), depth * 0.55);
    parts.push(b);
  }
  return merge(parts);
}

// ── 变截面放样 ────────────────────────────────────────────────

export interface SweepSection {
  /** 截面中心。 */
  at: THREE.Vector3;
  /** 半宽（局部 x）。 */
  w: number;
  /** 半高（局部 y）。 */
  h: number;
  /**
   * 截面形状：0 = 接近圆角矩形，1 = 椭圆。
   * 靠它做"方管平滑过渡成圆管"这类转折 —— 这是最能拉开档次的一招。
   */
  round?: number;
  /** 绕扫掠方向自转（弧度）。 */
  roll?: number;
}

/**
 * 变截面放样。
 *
 * 截面用超椭圆参数化：|x/w|^n + |y/h|^n = 1。
 * n = 2 是标准椭圆，n 越大越接近圆角矩形。于是 `round` 一个参数就能在
 * "圆角方管"和"圆管"之间连续过渡，而且过渡处永远是光滑的。
 *
 * 帧用平行传输构造，避免路径拐弯时截面突然翻转。
 */
export function sweep(sections: readonly SweepSection[], radialSegments = 16, caps = true): THREE.BufferGeometry {
  if (sections.length < 2) throw new Error('放样至少需要两个截面');

  // 每个截面的切线
  const tangents: THREE.Vector3[] = sections.map((_, i) => {
    const prev = sections[Math.max(0, i - 1)]!;
    const next = sections[Math.min(sections.length - 1, i + 1)]!;
    const t = new THREE.Vector3().subVectors(next.at, prev.at);
    if (t.lengthSq() < 1e-10) t.set(0, 1, 0);
    return t.normalize();
  });

  // 平行传输：从一个稳定的初始法线出发，逐段最小旋转地带过去
  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let n = new THREE.Vector3(1, 0, 0);
  if (Math.abs(n.dot(tangents[0]!)) > 0.9) n.set(0, 0, 1);
  n.projectOnPlane(tangents[0]!).normalize();
  for (let i = 0; i < sections.length; i++) {
    if (i > 0) {
      const t0 = tangents[i - 1]!;
      const t1 = tangents[i]!;
      const axis = new THREE.Vector3().crossVectors(t0, t1);
      if (axis.lengthSq() > 1e-12) {
        const angle = Math.acos(THREE.MathUtils.clamp(t0.dot(t1), -1, 1));
        n = n.clone().applyAxisAngle(axis.normalize(), angle);
      } else {
        n = n.clone();
      }
      n.projectOnPlane(t1).normalize();
    }
    normals.push(n.clone());
    binormals.push(new THREE.Vector3().crossVectors(tangents[i]!, n).normalize());
  }

  const rings: THREE.Vector3[][] = sections.map((sec, i) => {
    const round = THREE.MathUtils.clamp(sec.round ?? 0.4, 0, 1);
    // round 0 → n=6（圆角矩形），round 1 → n=2（椭圆）
    const power = THREE.MathUtils.lerp(6, 2, round);
    const e = 2 / power;
    const roll = sec.roll ?? 0;
    const nx = normals[i]!;
    const bz = binormals[i]!;
    const ring: THREE.Vector3[] = [];
    for (let j = 0; j < radialSegments; j++) {
      const a = (j / radialSegments) * Math.PI * 2 + roll;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const x = Math.sign(ca) * Math.pow(Math.abs(ca), e) * sec.w;
      const y = Math.sign(sa) * Math.pow(Math.abs(sa), e) * sec.h;
      ring.push(new THREE.Vector3().copy(sec.at).addScaledVector(nx, x).addScaledVector(bz, y));
    }
    return ring;
  });

  return new LoftGeometry(rings, { closed: true, capStart: caps, capEnd: caps });
}

// ── 组装辅助 ──────────────────────────────────────────────────

/** 给几何体刷上顶点色。merge 之前必须每块都刷过，属性集才一致。 */
export function paint(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** 就地摆放：缩放 → 旋转 → 平移。 */
export function place(
  geo: THREE.BufferGeometry,
  o: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; s?: number | [number, number, number] },
): THREE.BufferGeometry {
  if (o.s !== undefined) {
    const s = typeof o.s === 'number' ? [o.s, o.s, o.s] : o.s;
    geo.scale(s[0], s[1], s[2]);
  }
  if (o.rx) geo.rotateX(o.rx);
  if (o.ry) geo.rotateY(o.ry);
  if (o.rz) geo.rotateZ(o.rz);
  if (o.x || o.y || o.z) geo.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  return geo;
}

/** 合并零件。会先补齐缺失的属性，避免 mergeGeometries 因属性集不一致而失败。 */
export function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error('没有可合并的零件');
  if (parts.length === 1) return parts[0]!;
  const hasColor = parts.some((p) => p.attributes.color);
  for (const p of parts) {
    for (const name of REQUIRED) {
      if (!p.attributes[name]) {
        const count = p.attributes.position.count;
        const size = name === 'uv' ? 2 : 3;
        p.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * size), size));
      }
    }
    if (hasColor && !p.attributes.color) paint(p, 0xffffff);
    // 有的原语带 index 有的不带，统一成带 index 才能合并
    if (!p.index) {
      const count = p.attributes.position.count;
      const idx = new Uint32Array(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      p.setIndex(new THREE.BufferAttribute(idx, 1));
    }
  }
  const out = mergeGeometries(parts as THREE.BufferGeometry[], false);
  if (!out) throw new Error('几何体合并失败：各零件的属性集不一致');
  for (const p of parts) p.dispose();
  return out;
}
