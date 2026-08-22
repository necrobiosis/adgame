import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 程序化低模人形。
 *
 * 整个项目不下载任何模型/贴图资源 —— 所有角色都是这里用盒子拼出来再合并成
 * 一个 BufferGeometry 的。除了标准的 position/normal/uv 之外，每个顶点还带：
 *   · aPart  —— 属于哪个身体部位（0 躯干 1 头 2 左臂 3 右臂 4 左腿 5 右腿）
 *   · aPivot —— 该部位的旋转轴心（肩关节 / 髋关节）
 *   · color  —— 顶点色
 * 有了这三样，走路动画就可以完全在 vertex shader 里做，一次 draw call
 * 画出上千只僵尸。见 CrowdMaterial.ts。
 */

export const PART = {
  TORSO: 0,
  HEAD: 1,
  ARM_L: 2,
  ARM_R: 3,
  LEG_L: 4,
  LEG_R: 5,
} as const;

interface PieceOpts {
  /** 尺寸。 */
  size: [number, number, number];
  /** 中心位置。 */
  at: [number, number, number];
  part: number;
  /** 旋转轴心；不给就用 at。 */
  pivot?: [number, number, number];
  color: number;
  /** 绕 X 轴预旋转（弧度），用来做前倾/垂臂的静态姿态。 */
  tilt?: number;
  /** 绕 Z 轴预旋转。 */
  roll?: number;
  /** 顶部缩窄比例，用来做锥形（爪子、犄角）。 */
  taper?: number;
}

function piece(o: PieceOpts): THREE.BufferGeometry {
  const [w, h, d] = o.size;
  const g = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
  if (o.taper !== undefined && o.taper !== 1) {
    // 把上表面的四个顶点往中心收，做出锥形
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) {
        pos.setX(i, pos.getX(i) * o.taper);
        pos.setZ(i, pos.getZ(i) * o.taper);
      }
    }
    g.computeVertexNormals();
  }
  const pivot = o.pivot ?? o.at;
  if (o.tilt) {
    g.translate(0, -(o.at[1] - pivot[1]), -(o.at[2] - pivot[2]));
    g.rotateX(o.tilt);
    g.translate(0, o.at[1] - pivot[1], o.at[2] - pivot[2]);
  }
  if (o.roll) g.rotateZ(o.roll);
  g.translate(o.at[0], o.at[1], o.at[2]);

  const n = g.attributes.position.count;
  const parts = new Float32Array(n);
  const pivots = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const c = new THREE.Color(o.color);
  for (let i = 0; i < n; i++) {
    parts[i] = o.part;
    pivots[i * 3] = pivot[0];
    pivots[i * 3 + 1] = pivot[1];
    pivots[i * 3 + 2] = pivot[2];
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
  g.setAttribute('aPivot', new THREE.BufferAttribute(pivots, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function assemble(pieces: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(pieces, false);
  if (!merged) throw new Error('人形几何体合并失败');
  for (const p of pieces) p.dispose();
  merged.computeBoundingSphere();
  return merged;
}

export interface BodyPalette {
  skin: number;
  cloth: number;
  dark: number;
  accent: number;
}

export interface HumanoidOptions {
  /** 总身高（世界单位）。 */
  height?: number;
  /** 体宽倍率。 */
  build?: number;
  /** 躯干前倾弧度（僵尸驼背）。 */
  hunch?: number;
  /** 手臂静态前伸弧度（僵尸伸手）。 */
  reach?: number;
  palette: BodyPalette;
  /** 头盔。 */
  helmet?: boolean;
  /** 背包。 */
  backpack?: boolean;
  /** 手里的枪（跟着右臂动）。 */
  gun?: boolean;
  /** 头顶犄角（大型怪）。 */
  horns?: boolean;
  /** 手臂末端的爪子（大型怪）。 */
  claws?: boolean;
  /** 肩甲/背刺，让剪影更狰狞。 */
  spikes?: boolean;
}

/**
 * 造一个人形。
 * 坐标原点在脚底，面朝 +z。
 */
export function buildHumanoid(o: HumanoidOptions): THREE.BufferGeometry {
  const H = o.height ?? 1.78;
  const B = o.build ?? 1;
  const p = o.palette;
  const hunch = o.hunch ?? 0;
  const reach = o.reach ?? 0;

  // 身体各段的高度分配
  const legH = H * 0.46;
  const torsoH = H * 0.34;
  const headH = H * 0.16;
  const shoulderY = legH + torsoH * 0.86;
  const hipY = legH;

  const legW = H * 0.1 * B;
  const torsoW = H * 0.26 * B;
  const torsoD = H * 0.15 * B;
  const armW = H * 0.075 * B;
  const armH = torsoH * 1.02;

  const pieces: THREE.BufferGeometry[] = [];

  // 腿
  for (const [sign, part] of [[-1, PART.LEG_L], [1, PART.LEG_R]] as const) {
    pieces.push(piece({
      size: [legW, legH, legW * 1.15],
      at: [sign * legW * 0.62, legH / 2, 0],
      pivot: [sign * legW * 0.62, hipY, 0],
      part,
      color: p.dark,
    }));
    // 鞋
    pieces.push(piece({
      size: [legW * 1.12, H * 0.045, legW * 1.7],
      at: [sign * legW * 0.62, H * 0.022, legW * 0.28],
      pivot: [sign * legW * 0.62, hipY, 0],
      part,
      color: 0x24262b,
    }));
  }

  // 躯干（骨盆 + 胸腔，胸腔略宽）
  pieces.push(piece({
    size: [torsoW * 0.88, torsoH * 0.46, torsoD],
    at: [0, hipY + torsoH * 0.23, 0],
    pivot: [0, hipY, 0],
    part: PART.TORSO,
    tilt: hunch * 0.5,
    color: p.cloth,
  }));
  pieces.push(piece({
    size: [torsoW, torsoH * 0.58, torsoD * 1.08],
    at: [0, hipY + torsoH * 0.7, 0],
    pivot: [0, hipY, 0],
    part: PART.TORSO,
    tilt: hunch,
    color: p.cloth,
  }));

  if (o.backpack) {
    pieces.push(piece({
      size: [torsoW * 0.72, torsoH * 0.5, torsoD * 0.6],
      at: [0, hipY + torsoH * 0.72, -torsoD * 0.75],
      pivot: [0, hipY, 0],
      part: PART.TORSO,
      tilt: hunch,
      color: p.accent,
    }));
  }
  if (o.spikes) {
    for (let i = 0; i < 3; i++) {
      pieces.push(piece({
        size: [H * 0.05 * B, H * 0.13 * B, H * 0.05 * B],
        at: [(i - 1) * torsoW * 0.3, hipY + torsoH * (0.95 + i * 0.02), -torsoD * 0.5],
        pivot: [0, hipY, 0],
        part: PART.TORSO,
        tilt: hunch - 0.5,
        taper: 0.05,
        color: p.dark,
      }));
    }
  }

  // 头（跟着躯干的前倾走，所以位置也要往前挪一点）
  const headZ = Math.sin(hunch) * torsoH * 0.8;
  const headY = shoulderY + headH * 0.42 - (1 - Math.cos(hunch)) * torsoH * 0.6;
  pieces.push(piece({
    size: [headH * 0.78, headH * 0.86, headH * 0.82],
    at: [0, headY, headZ],
    pivot: [0, headY - headH * 0.45, headZ],
    part: PART.HEAD,
    color: p.skin,
  }));
  if (o.helmet) {
    pieces.push(piece({
      size: [headH * 0.92, headH * 0.42, headH * 0.98],
      at: [0, headY + headH * 0.34, headZ - headH * 0.03],
      pivot: [0, headY - headH * 0.45, headZ],
      part: PART.HEAD,
      color: p.accent,
    }));
  }
  if (o.horns) {
    for (const sign of [-1, 1]) {
      pieces.push(piece({
        size: [headH * 0.16, headH * 0.6, headH * 0.16],
        at: [sign * headH * 0.34, headY + headH * 0.55, headZ],
        pivot: [0, headY - headH * 0.45, headZ],
        part: PART.HEAD,
        roll: sign * 0.42,
        taper: 0.06,
        color: p.dark,
      }));
    }
  }

  // 手臂
  for (const [sign, part] of [[-1, PART.ARM_L], [1, PART.ARM_R]] as const) {
    const sx = sign * (torsoW / 2 + armW * 0.42);
    pieces.push(piece({
      size: [armW, armH, armW],
      at: [sx, shoulderY - armH / 2, 0],
      pivot: [sx, shoulderY, 0],
      part,
      tilt: reach,
      color: p.cloth,
    }));
    // 手
    pieces.push(piece({
      size: [armW * 1.05, armW * 1.1, armW * 1.05],
      at: [sx, shoulderY - armH - armW * 0.3, 0],
      pivot: [sx, shoulderY, 0],
      part,
      tilt: reach,
      color: p.skin,
    }));
    if (o.claws) {
      for (let i = 0; i < 3; i++) {
        pieces.push(piece({
          size: [armW * 0.22, armW * 1.3, armW * 0.22],
          at: [sx + (i - 1) * armW * 0.34, shoulderY - armH - armW * 1.2, armW * 0.2],
          pivot: [sx, shoulderY, 0],
          part,
          tilt: reach + 0.3,
          taper: 0.05,
          color: 0xe8e2d2,
        }));
      }
    }
  }

  // 枪（挂在右臂上，跟着右臂摆）
  if (o.gun) {
    const sx = torsoW / 2 + armW * 0.42;
    const gunZ = armH * 0.55;
    pieces.push(piece({
      size: [armW * 0.5, armW * 0.5, armH * 1.1],
      at: [sx - armW * 0.1, shoulderY - armH * 0.72, gunZ],
      pivot: [sx, shoulderY, 0],
      part: PART.ARM_R,
      tilt: reach,
      color: 0x2b2f36,
    }));
    pieces.push(piece({
      size: [armW * 0.7, armW * 0.85, armW * 0.7],
      at: [sx - armW * 0.1, shoulderY - armH * 0.9, gunZ - armH * 0.42],
      pivot: [sx, shoulderY, 0],
      part: PART.ARM_R,
      tilt: reach,
      color: 0x3a4049,
    }));
  }

  return assemble(pieces);
}

// ── 现成的角色 ────────────────────────────────────────────────

/** 普通尸群：驼背、伸手、灰败。 */
export function zombieGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.76,
    build: 0.95,
    hunch: 0.34,
    reach: -1.15,
    palette: { skin: 0xb8c3a6, cloth: 0x7d8070, dark: 0x55584d, accent: 0x8a8272 },
  });
}

/** 疾行者：更瘦、前倾更狠。 */
export function runnerGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.72,
    build: 0.82,
    hunch: 0.55,
    reach: -1.45,
    palette: { skin: 0xc9bd96, cloth: 0x8a7a55, dark: 0x5b4d36, accent: 0x9d8a5f },
  });
}

/** 嚎叫者：细长、张着嘴、带角。 */
export function screamerGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.0,
    build: 0.86,
    hunch: 0.2,
    reach: -0.5,
    horns: true,
    claws: true,
    palette: { skin: 0xd08ea0, cloth: 0x7a3f52, dark: 0x4a2130, accent: 0x9c4f66 },
  });
}

/** 蛮兽：厚重、宽肩、背刺。 */
export function bruteGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.2,
    build: 1.45,
    hunch: 0.4,
    reach: -0.85,
    claws: true,
    spikes: true,
    palette: { skin: 0xb08068, cloth: 0x6f4636, dark: 0x40281f, accent: 0x8a5540 },
  });
}

/** 泰坦：巨大、猩红、犄角 + 利爪 + 背刺。 */
export function titanGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.5,
    build: 1.7,
    hunch: 0.3,
    reach: -0.7,
    horns: true,
    claws: true,
    spikes: true,
    palette: { skin: 0xd6604c, cloth: 0x8c2f24, dark: 0x4b1512, accent: 0xb03a2c },
  });
}

/** Boss：泰坦的放大加强版，剪影更夸张。 */
export function bossGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.9,
    build: 1.95,
    hunch: 0.22,
    reach: -0.6,
    horns: true,
    claws: true,
    spikes: true,
    palette: { skin: 0xe8563c, cloth: 0x7a1c16, dark: 0x2e0b09, accent: 0xff7a3c },
  });
}

/** 士兵：挺拔、头盔、背包、端枪。 */
export function soldierGeometry(): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.8,
    build: 1.02,
    hunch: 0.06,
    reach: -0.28,
    helmet: true,
    backpack: true,
    gun: true,
    palette: { skin: 0xd9a684, cloth: 0x2f4d8f, dark: 0x1d2f5c, accent: 0x24407a },
  });
}
