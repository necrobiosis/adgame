import * as THREE from 'three';
import { chamferBox, lathe, merge, paint, place, plate } from '../geom/hardSurface';
import { bakeSurface } from '../geom/deform';
import { BONE, assignSkin, buildSkeleton, pivots, type Skeleton } from './skeleton';
import type { BuildQuality } from './HumanoidGeometry';

/**
 * 小人仔（minifig）。
 *
 * 积木关的角色。和写实版那套 buildHumanoid 走的是完全不同的建模思路：
 *
 *  · 写实版是**放样**出来的——沿骨线扫一条会变粗变细的截面曲线，得到有机的
 *    肌肉体积。小人仔正相反：它是**几个注塑件拼起来的**，每一件都是规规矩矩
 *    的几何体，件与件之间留得出缝。
 *  · 所以这里不 weldSmooth（会把棱磨圆）、不做腐烂抖动（小人仔是崭新的塑料件）。
 *    棱角就是它的全部性格。
 *  · 腿是**一整根**，只绑髋关节。真实小人仔没有膝盖——走路是整条腿从胯下摆，
 *    这一条比什么都更决定"看起来像不像"。
 *
 * 骨架直接复用 buildSkeleton：它算出来的肩、颈、胯位置本来就落在小人仔的
 * 比例上（肩 0.78H、颈 0.83H），所以现成的走路/攻击/进食动画一帧不用改。
 */

export interface MinifigPalette {
  /** 上衣。 */
  torso: number;
  /** 裤腿。 */
  legs: number;
  /** 手臂（多数时候同上衣，僵尸的破烂衣服会不同）。 */
  arm: number;
  /** 手和头的塑料色。 */
  skin: number;
  /** 头盔 / 头发。 */
  head: number;
  /** 印刷用的深色（腰带、拉链、五官）。 */
  print: number;
  /** 点缀色（护目镜、徽章）。 */
  accent: number;
}

export type Headgear = 'helmet' | 'cap' | 'hair' | 'none';

export interface MinifigSpec {
  height: number;
  /** 体宽倍率。小人仔本来就一个尺码，这里只给巨怪留一点余量。 */
  build?: number;
  palette: MinifigPalette;
  headgear?: Headgear;
  /** 僵尸脸：歪掉的眼睛、张开的嘴、身上少几块。 */
  undead?: boolean;
  /** 手里那把枪的档次（0 = 空手）。 */
  weapon?: number;
  /** 背后的装备。 */
  backpack?: boolean;
  /** 肩甲。 */
  pauldrons?: boolean;
  /** 怪物加成：角。 */
  horns?: boolean;
  seed?: number;
}

interface Part {
  geo: THREE.BufferGeometry;
  bones: number[];
}

/** 小人仔头顶那颗凸点。和场景零件用的是同一个比例。 */
function stud(r: number, h: number, segments: number): THREE.BufferGeometry {
  const c = r * 0.12;
  return lathe([[0, 0], [r, 0], [r, h - c], [r - c, h], [0, h]], segments);
}

export function buildMinifig(spec: MinifigSpec, q: BuildQuality): THREE.BufferGeometry {
  const H = spec.height;
  const B = spec.build ?? 1;
  const p = spec.palette;
  const skel = buildSkeleton({ height: H, build: B, hunch: 0 });
  const parts: Part[] = [];
  const add = (geo: THREE.BufferGeometry, color: number, bones: number[]) => {
    parts.push({ geo: paint(geo, color), bones });
  };
  // 圆周段数跟着画质走，但给一个下限——头和手是回转体，段数太低会露出多边形
  // 头、头盔、手都是回转体，而头几乎占了小人仔上半身的全部画面。
  // 段数低于 14 时，正面看得见明显的多边形轮廓——这是最显廉价的一处。
  const seg = Math.max(14, q.radialSegments);
  // 脱模倒角。整套零件共用一个值，看起来才像同一条产线出来的
  const bev = H * 0.008;

  const hipY = skel[BONE.PELVIS]!.head.y;
  const shoulderY = skel[BONE.ARM_L]!.head.y;
  const neckY = skel[BONE.HEAD]!.head.y;

  // 小人仔的比例是**又矮又宽**的，这几个数字直接照真件量出来的比例换算
  // （以 40mm 通高为基准）：躯干宽 16mm = 0.4H、进深 8mm = 0.2H、
  // 头直径 12.8mm = 0.32H、两条腿合起来和躯干同宽。
  //
  // 第一版这几个值只有现在的六成，结果是一队又高又细的方块人——比例对不上
  // 的时候人一眼就看得出"不像"，但说不出哪里不像，问题几乎总是在宽度上。
  // 这里比真件收了一点点（0.4 → 0.36），因为方阵是密集队形，照实做会互相穿插。
  const torsoW = H * 0.335 * B;
  const torsoD = H * 0.185 * B;
  const legW = H * 0.163 * B;
  // 头的宽高比照真件：12.8mm 直径 / 9.6mm 高 ≈ 1.33。骨架给的头段高度是
  // 0.158H，所以半径落在 0.105H——再宽就成了一块煎饼。
  const headR = H * 0.105 * B;

  // ── 腿 ──────────────────────────────────────────────────────
  // 一整根，从胯一直到地。只绑髋关节：小人仔没有膝盖。
  for (const side of [-1, 1]) {
    const thighB = side < 0 ? BONE.THIGH_L : BONE.THIGH_R;
    const legH = hipY - H * 0.02;
    add(place(chamferBox(legW, legH, torsoD * 0.92, bev), {
      x: side * legW * 0.52,
      y: hipY - legH / 2,
    }), p.legs, [thighB, BONE.PELVIS]);
    // 脚：腿前面伸出去的一小块
    add(place(chamferBox(legW, H * 0.028, torsoD * 0.5, bev), {
      x: side * legW * 0.52,
      y: H * 0.016,
      z: torsoD * 0.6,
    }), p.legs, [thighB]);
  }
  // 胯：把两条腿连起来的那块，比腿宽一点
  add(place(chamferBox(legW * 2.16, H * 0.055, torsoD * 0.95, bev), {
    y: hipY - H * 0.022,
  }), p.legs, [BONE.PELVIS]);

  // ── 躯干 ────────────────────────────────────────────────────
  // 上窄下宽的梯形：小人仔的躯干是一件带斜面的注塑件。用两块盒子叠出这个
  // 收分——一整块直筒盒子看起来是个纸箱，不是人。
  const torsoH = shoulderY - hipY + H * 0.06;
  add(place(chamferBox(torsoW, torsoH * 0.52, torsoD, bev), {
    y: hipY + torsoH * 0.26,
  }), p.torso, [BONE.PELVIS, BONE.CHEST]);
  add(place(chamferBox(torsoW * 0.9, torsoH * 0.5, torsoD * 0.94, bev), {
    y: hipY + torsoH * 0.76,
  }), p.torso, [BONE.CHEST]);
  // 腰带：一条印刷线，把上下两段分开
  add(place(chamferBox(torsoW * 1.01, H * 0.018, torsoD * 1.01, bev * 0.5), {
    y: hipY + H * 0.03,
  }), p.print, [BONE.PELVIS, BONE.CHEST]);
  // 领口
  add(place(chamferBox(torsoW * 0.42, H * 0.02, torsoD * 0.7, bev * 0.5), {
    y: neckY - H * 0.012,
  }), p.print, [BONE.CHEST]);

  // ── 手臂 ────────────────────────────────────────────────────
  // 上臂是一件带斜度的盒子，前臂再折一道，末端是那只标志性的 C 形手。
  for (const side of [-1, 1]) {
    const armB = side < 0 ? BONE.ARM_L : BONE.ARM_R;
    const foreB = side < 0 ? BONE.FORE_L : BONE.FORE_R;
    const shoulder = skel[armB]!.head;
    const elbow = skel[armB]!.tail;
    const armLen = shoulder.distanceTo(elbow);
    const armW = H * 0.092 * B;
    // 手臂必须挂在躯干**外面**。
    //
    // 骨架给的肩点在 0.115H，而躯干半宽是 0.168H——照骨架摆的话整条手臂
    // 埋在躯干里面，屏幕上只剩一只手凭空伸出来。这里按躯干宽度重新算 x，
    // 蒙皮的轴心仍然是肩关节，所以摆臂动画不受影响。
    const armX = side * (torsoW / 2 + armW * 0.42);

    // 肩头：一小块圆角，搭在躯干肩线上
    add(place(chamferBox(armW * 1.08, armW * 1.0, torsoD * 0.82, bev), {
      x: armX, y: shoulder.y - armW * 0.06, z: shoulder.z,
    }), p.arm, [armB, BONE.CHEST]);
    // 上臂：往外斜一点，小人仔的手臂不是垂直的
    add(place(chamferBox(armW, armLen * 1.05, torsoD * 0.68, bev), {
      x: armX + side * armW * 0.1,
      y: shoulder.y - armLen * 0.5,
      z: shoulder.z,
      rz: -side * 0.13,
    }), p.arm, [armB, BONE.CHEST]);
    // 前臂
    const fore = skel[foreB]!;
    const foreLen = fore.head.distanceTo(fore.tail);
    add(place(chamferBox(armW * 0.92, foreLen * 0.86, torsoD * 0.64, bev), {
      x: armX + side * armW * 0.16, y: fore.head.y - foreLen * 0.4, z: fore.head.z + foreLen * 0.16,
      rx: 0.42,
    }), p.arm, [foreB, armB]);
    // 手：一圈开口的 C 形夹。这是小人仔最好认的一个零件，
    // 用一段环 + 一个缺口做出来，不做成实心的拳头。
    const hand = fore.tail;
    const handR = armW * 0.5;
    const ring = new THREE.TorusGeometry(handR, handR * 0.38, 6, Math.max(8, seg), Math.PI * 1.55);
    add(place(ring, {
      x: armX + side * armW * 0.16, y: hand.y - handR * 0.2, z: hand.z + handR * 0.5,
      rx: Math.PI / 2, rz: -0.4,
    }), p.skin, [foreB]);
  }

  // ── 头 ──────────────────────────────────────────────────────
  // 圆柱 + 顶上一颗凸点。倒角走一圈，脱模斜度也照做。
  const headH = H - neckY - H * 0.012;
  const headY = neckY + headH / 2;
  // 脖子：一小截圆柱，头和躯干之间要看得见这一段
  add(place(lathe([[0, 0], [headR * 0.42, 0], [headR * 0.42, H * 0.02], [0, H * 0.02]], seg), {
    y: neckY - H * 0.006,
  }), p.skin, [BONE.HEAD, BONE.CHEST]);
  const c = headR * 0.14;
  add(place(lathe([
    [0, -headH / 2],
    [headR - c, -headH / 2],
    [headR, -headH / 2 + c],
    [headR, headH / 2 - c],
    [headR - c, headH / 2],
    [0, headH / 2],
  ], seg), { y: headY }), p.skin, [BONE.HEAD]);
  // 头顶那颗凸点只在**光头**时露出来——戴了头盔/帽子/头发就该被盖住。
  // 不判断的话会有一颗肉色的大凸点从头盔顶上冒出来。
  if ((spec.headgear ?? 'none') === 'none') {
    add(place(stud(headR * 0.42, headR * 0.3, seg), { y: headY + headH / 2 }), p.skin, [BONE.HEAD]);
  }

  // ── 印刷的脸 ────────────────────────────────────────────────
  // 小人仔的表情全是印上去的平面图案，不是雕出来的。所以五官一律用极薄的
  // 片贴在脸皮外面一点点——做成凸起的话，那张脸立刻变成一个橡胶面具。
  const faceZ = headR * 0.995;
  const eyeR = headR * 0.15;
  const eyeY = headY + headH * 0.08;
  for (const side of [-1, 1]) {
    if (spec.undead) {
      // 僵尸：两条交叉的印刷线，经典的 X 眼
      for (const rot of [0.7, -0.7]) {
        add(place(plate(eyeR * 2.4, eyeR * 0.5, headR * 0.02, { corner: eyeR * 0.1 }), {
          x: side * headR * 0.36, y: eyeY, z: faceZ, rz: rot,
        }), p.print, [BONE.HEAD]);
      }
    } else {
      add(place(lathe([[0, 0], [eyeR, 0], [eyeR, headR * 0.02], [0, headR * 0.02]], seg), {
        x: side * headR * 0.36, y: eyeY, z: faceZ, rx: Math.PI / 2,
      }), p.print, [BONE.HEAD]);
      // 眼白上那一点高光，小人仔的眼睛是这样印的
      add(place(lathe([[0, 0], [eyeR * 0.38, 0], [eyeR * 0.38, headR * 0.02], [0, headR * 0.02]], 8), {
        x: side * headR * 0.36 + eyeR * 0.3, y: eyeY + eyeR * 0.3, z: faceZ + headR * 0.004, rx: Math.PI / 2,
      }), 0xffffff, [BONE.HEAD]);
    }
  }
  // 嘴
  add(place(plate(headR * (spec.undead ? 0.7 : 0.56), headR * (spec.undead ? 0.42 : 0.14), headR * 0.02,
    { corner: headR * 0.05 }), {
    y: headY - headH * 0.16, z: faceZ,
  }), p.print, [BONE.HEAD]);

  // ── 头饰 ────────────────────────────────────────────────────
  const gear = spec.headgear ?? 'none';
  if (gear === 'helmet') {
    // 头盔：扣在头顶的一个**扁**壳。第一版做成了半球，读起来是顶泳帽——
    // 小人仔的头盔是贴着头皮的一层，顶多高出头顶三分之一个头。
    // 头盔是**扣在头上的一个壳**：包住头顶和两侧，前沿压到眼睛上方一点。
    // 只在头顶上方摆一片的话，读起来是顶帽子扣在脑门上，不是头盔。
    add(place(lathe([
      [0, -headH * 0.16],
      [headR * 1.07, -headH * 0.16],
      [headR * 1.07, headH * 0.3],
      [headR * 0.94, headH * 0.46],
      [headR * 0.55, headH * 0.56],
      [0, headH * 0.58],
    ], seg), { y: headY }), p.head, [BONE.HEAD]);
    // 后脑那一片护颈
    add(place(chamferBox(headR * 1.7, headR * 0.5, headR * 0.36, bev), {
      y: headY + headH * 0.06, z: -headR * 0.86,
    }), p.head, [BONE.HEAD]);
    // 护目镜：贴着脸的一条带。宽度必须小于头的直径——第一版给了 1.86R，
    // 两个角直接从圆头的两侧支出去，看着像挂了对耳朵。
    // 推到额头上，而不是压在眼睛那一行——挡住印刷的脸，小人仔就没表情了，
    // 而那张脸是它唯一的表演
    add(place(chamferBox(headR * 1.24, headR * 0.3, headR * 0.28, bev * 0.6), {
      y: eyeY + headR * 0.62, z: headR * 0.78,
    }), p.accent, [BONE.HEAD]);
  } else if (gear === 'cap') {
    add(place(lathe([
      [0, 0], [headR * 1.05, 0], [headR * 1.0, headH * 0.26], [headR * 0.58, headH * 0.38], [0, headH * 0.4],
    ], seg), { y: headY + headH * 0.14 }), p.head, [BONE.HEAD]);
    add(place(chamferBox(headR * 1.5, headR * 0.12, headR * 0.85, bev), {
      y: headY + headH * 0.22, z: headR * 0.78,
    }), p.head, [BONE.HEAD]);
  } else if (gear === 'hair') {
    // 头发：一个盖住上半个头的件，两侧垂下来一点
    add(place(lathe([
      [0, -headH * 0.1], [headR * 1.08, -headH * 0.1], [headR * 1.06, headH * 0.26],
      [headR * 0.68, headH * 0.44], [0, headH * 0.48],
    ], seg), { y: headY + headH * 0.06 }), p.head, [BONE.HEAD]);
    for (const side of [-1, 1]) {
      add(place(chamferBox(headR * 0.34, headH * 0.44, headR * 1.3, bev), {
        x: side * headR * 0.95, y: headY + headH * 0.06,
      }), p.head, [BONE.HEAD]);
    }
  }

  if (spec.horns) {
    for (const side of [-1, 1]) {
      add(place(lathe([[0, 0], [headR * 0.26, 0], [headR * 0.14, headH * 0.42], [0, headH * 0.62]], 8), {
        x: side * headR * 0.86, y: headY + headH * 0.34, rz: side * 0.42,
      }), p.print, [BONE.HEAD]);
    }
  }

  // ── 装备 ────────────────────────────────────────────────────
  if (spec.pauldrons) {
    for (const side of [-1, 1]) {
      add(place(chamferBox(H * 0.075 * B, H * 0.03, torsoD * 1.05, bev), {
        x: side * torsoW * 0.5, y: shoulderY + H * 0.012, rz: -side * 0.2,
      }), p.accent, [side < 0 ? BONE.ARM_L : BONE.ARM_R, BONE.CHEST]);
    }
  }
  if (spec.backpack) {
    add(place(chamferBox(torsoW * 0.62, torsoH * 0.42, torsoD * 0.5, bev), {
      y: hipY + torsoH * 0.62, z: -torsoD * 0.66,
    }), p.print, [BONE.CHEST]);
    // 背包上那两颗凸点——这是"它是个零件"的落款
    for (const side of [-1, 1]) {
      add(place(stud(headR * 0.3, headR * 0.22, 8), {
        x: side * torsoW * 0.16, y: hipY + torsoH * 0.83, z: -torsoD * 0.66, rx: 0,
      }), p.print, [BONE.CHEST]);
    }
  }

  // ── 手里那把枪 ──────────────────────────────────────────────
  // 也是拼出来的：一块握把 + 一根枪管 + 按档次加弹匣、枪托、第二根管。
  // 尺寸随档次长，玩家升级之后手里那把要看得出来变了。
  const w = spec.weapon ?? 0;
  if (w > 0) {
    const fore = skel[BONE.FORE_R]!;
    const hand = fore.tail;
    // 手臂被挪到躯干外面了，枪也得跟着——不然它会挂在腋下
    const handX = torsoW / 2 + H * 0.092 * B * 0.58;
    // 枪身**横着**架在手腕上，顺着 +z 指向前方——和写实版那把是同一个挂法。
    // 第一版把机匣摆在手心上方，等于让小人仔举着一根竖杆，动画一转就整根
    // 戳到脸前面去了。枪的重心必须落在腕关节上。
    const s = H * (0.05 + w * 0.009);
    const barrel = s * (1.1 + w * 0.18);
    const gunParts: THREE.BufferGeometry[] = [
      // 机匣：所有档次共用的基座
      paint(place(chamferBox(s * 0.36, s * 0.44, s * 1.0, bev), { z: s * 0.2 }), p.print),
      // 枪管
      paint(place(chamferBox(s * 0.26, s * 0.26, barrel, bev), { z: s * 0.7 + barrel / 2 }), p.print),
      // 握把：从机匣往下伸的一小截，正好落在 C 形手里
      paint(place(chamferBox(s * 0.3, s * 0.5, s * 0.3, bev), { y: -s * 0.4, z: -s * 0.05 }), p.print),
    ];
    // 弹匣
    if (w >= 2) gunParts.push(paint(place(chamferBox(s * 0.26, s * 0.62, s * 0.3, bev), { y: -s * 0.42, z: s * 0.42 }), p.accent));
    // 枪托
    if (w >= 4) gunParts.push(paint(place(chamferBox(s * 0.28, s * 0.4, s * 0.7, bev), { z: -s * 0.62 }), p.print));
    // 第二根管
    if (w >= 6) gunParts.push(paint(place(chamferBox(s * 0.22, s * 0.22, barrel * 0.8, bev), { y: s * 0.3, z: s * 0.7 + barrel * 0.4 }), p.accent));
    // 静止姿态下枪要**朝下**摆，不是朝前。
    //
    // 蒙皮是刚性的：枪跟着前臂一起转。开火姿势里大臂转 -1.32、前臂再转 -0.6，
    // 合起来约 -1.9 弧度（绕 X）。要让枪在**开火时**指向正前方，静止时它就得
    // 指在 Rx(+1.9)·(0,0,1) 那个方向上——也就是垂下来、略微朝后。
    // 按"看起来该有的样子"把它摆成朝前，一开火整根就竖到脸前面去了。
    add(place(merge(gunParts), {
      rx: 1.9,
      x: handX - s * 0.12, y: hand.y - s * 0.5, z: hand.z + s * 0.16,
    }), p.print, [BONE.FORE_R]);
  }

  // ── 合并 → 蒙皮 → 烘表面 ───────────────────────────────────
  // 注意这里**不做 weldSmooth**：写实角色靠它把放样件磨成连续的表面，
  // 而小人仔的全部性格就在那些没被磨掉的棱上。
  for (const part of parts) assignSkin(part.geo, skel, part.bones);
  let geo = merge(parts.map((x) => x.geo));
  // 网格取得比写实角色还细：小人仔身上全是大块的平滑曲面（头、头盔、手），
  // 粗网格烘出来的遮蔽在这种面上会显成一片脏斑点，而不是柔和的暗部。
  geo = bakeSurface(geo, { gridSize: 26, rays: 12, steps: 4 });
  geo.userData.pivots = pivots(skel);
  geo.userData.skeleton = skel as Skeleton;
  return geo;
}

// ── 各类角色 ──────────────────────────────────────────────────

/** 制式蓝的幸存者小队。装备档跟着武器等级走，和写实版是同一条曲线。 */
export function minifigSoldier(q: BuildQuality, weaponTier = 0): THREE.BufferGeometry {
  const heavy = weaponTier >= 5;
  const standard = weaponTier >= 2;
  return buildMinifig({
    height: 1.78,
    palette: {
      torso: heavy ? 0x1d4f8c : standard ? 0x2a6fbf : 0x3d7fd0,
      legs: 0x24303c,
      arm: heavy ? 0x1d4f8c : standard ? 0x2a6fbf : 0x3d7fd0,
      skin: 0xf5c542,
      head: heavy ? 0x2b3a48 : standard ? 0x36527a : 0x8a6a3c,
      print: 0x1b2028,
      accent: 0x7fe3ff,
    },
    headgear: standard ? 'helmet' : 'cap',
    pauldrons: heavy,
    backpack: standard,
    weapon: weaponTier + 1,
    seed: 5 + weaponTier,
  }, q);
}

export const MINIFIG_ZOMBIE_VARIANTS = 4;
export const MINIFIG_RUNNER_VARIANTS = 3;

/** 僵尸小人仔：褪色的衣服 + X 眼，头发/秃头换着来。 */
const UNDEAD_BODIES = [
  { torso: 0x6f7a5e, legs: 0x4a5340, head: 0x3a3128, gear: 'hair' as Headgear, h: 1.76 },
  { torso: 0x7d6a52, legs: 0x50453a, head: 0x2e2a22, gear: 'none' as Headgear, h: 1.64 },
  { torso: 0x5c6b6a, legs: 0x3e4746, head: 0x4a3c2e, gear: 'hair' as Headgear, h: 1.92 },
  { torso: 0x74604f, legs: 0x473b31, head: 0x33302a, gear: 'cap' as Headgear, h: 1.7 },
];

export function minifigZombie(q: BuildQuality, variant = 0): THREE.BufferGeometry {
  const b = UNDEAD_BODIES[variant % UNDEAD_BODIES.length]!;
  return buildMinifig({
    height: b.h,
    palette: {
      torso: b.torso, legs: b.legs, arm: b.torso,
      skin: 0x9fbf6a, head: b.head, print: 0x1e2a18, accent: 0x6f8f4a,
    },
    headgear: b.gear,
    undead: true,
    seed: 31 + variant * 17,
  }, q);
}

/** 疾行者：更瘦更高，配色更脏。 */
export function minifigRunner(q: BuildQuality, variant = 0): THREE.BufferGeometry {
  const h = [1.74, 1.62, 1.9][variant % 3]!;
  return buildMinifig({
    height: h,
    build: 0.92,
    palette: {
      torso: 0x8a7a55, legs: 0x5b4d36, arm: 0x8a7a55,
      skin: 0xbcc96a, head: 0x2f2a20, print: 0x24200f, accent: 0x9d8a5f,
    },
    headgear: variant === 1 ? 'none' : 'hair',
    undead: true,
    seed: 53 + variant * 19,
  }, q);
}

/**
 * 其余每一种怪各自的小人仔。
 *
 * 身高照搬写实版那一套（碰撞和动画都按那个尺度调过），变的只有零件和配色。
 * 大个子靠 build 加宽 + 肩甲 + 角撑起体量——小人仔没有肌肉可以堆，
 * 体量只能来自"它是更大的一件塑料"。
 */
const MONSTERS: Record<string, MinifigSpec> = {
  screamer: {
    height: 2.0, build: 0.9, horns: true, undead: true, headgear: 'none',
    palette: { torso: 0x7a4a6a, legs: 0x4a2c40, arm: 0x7a4a6a, skin: 0xc8d86a, head: 0x3a2030, print: 0x2a1020, accent: 0xff6ad5 },
  },
  spitter: {
    height: 1.82, build: 1.14, undead: true, headgear: 'none', backpack: true,
    palette: { torso: 0x4f7a3a, legs: 0x35502a, arm: 0x4f7a3a, skin: 0xa8d858, head: 0x2c3a20, print: 0x1c2a12, accent: 0xb6ff4a },
  },
  leaper: {
    height: 1.74, build: 0.82, undead: true, headgear: 'hair',
    palette: { torso: 0x6a5a3a, legs: 0x3f3524, arm: 0x6a5a3a, skin: 0xc2cf6a, head: 0x2a2418, print: 0x1e1a10, accent: 0xe0c060 },
  },
  armored: {
    height: 2.05, build: 1.4, undead: true, headgear: 'helmet', pauldrons: true, backpack: true,
    palette: { torso: 0x5a6068, legs: 0x3a4048, arm: 0x5a6068, skin: 0x9fbf6a, head: 0x6d757e, print: 0x22282e, accent: 0x9aa6b2 },
  },
  swarmling: {
    height: 1.12, build: 1.1, undead: true, headgear: 'none',
    palette: { torso: 0x7d6a52, legs: 0x50453a, arm: 0x7d6a52, skin: 0xa8c05a, head: 0x33302a, print: 0x1e1a14, accent: 0x8a9a4a },
  },
  bomber: {
    height: 1.68, build: 1.52, undead: true, headgear: 'none', backpack: true,
    palette: { torso: 0x8a4a2a, legs: 0x50301c, arm: 0x8a4a2a, skin: 0xc0b04a, head: 0x3a2014, print: 0x24140c, accent: 0xff8a2a },
  },
  brute: {
    height: 2.2, build: 1.5, horns: true, undead: true, headgear: 'none', pauldrons: true,
    palette: { torso: 0x5c4030, legs: 0x3a2820, arm: 0x5c4030, skin: 0x9fb060, head: 0x2c1e16, print: 0x1a1008, accent: 0xd8a050 },
  },
  titan: {
    height: 2.5, build: 1.75, horns: true, undead: true, headgear: 'none', pauldrons: true, backpack: true,
    palette: { torso: 0x4a3038, legs: 0x2e1e24, arm: 0x4a3038, skin: 0x9aa858, head: 0x241418, print: 0x140a0e, accent: 0xff6a3a },
  },
  midboss: {
    height: 2.65, build: 1.85, horns: true, undead: true, headgear: 'none', pauldrons: true, backpack: true,
    palette: { torso: 0x35502e, legs: 0x22331e, arm: 0x35502e, skin: 0x9ce85a, head: 0x1a2614, print: 0x0e1408, accent: 0x9ce85a },
  },
};

export function minifigMonster(kind: string, q: BuildQuality): THREE.BufferGeometry {
  const spec = MONSTERS[kind] ?? MONSTERS.brute!;
  return buildMinifig(spec, q);
}

/**
 * Boss 小人仔。
 *
 * 一只**巨大的**小人仔：同样的零件语言，只是大得多，还多戴一副角和肩甲。
 * 积木世界里的"最终 Boss"就该是这样——不是换一套生物建模，而是同一条
 * 产线上出来的更大一件。
 */
export function minifigBoss(q: BuildQuality): THREE.BufferGeometry {
  return buildMinifig({
    height: 2.9,
    build: 2.0,
    palette: {
      torso: 0x2a1a20, legs: 0x180e12, arm: 0x2a1a20,
      skin: 0x8a2a24, head: 0x120a0c, print: 0x0a0506, accent: 0xffb04a,
    },
    headgear: 'none',
    horns: true,
    pauldrons: true,
    backpack: true,
    undead: true,
    seed: 97,
  }, q);
}
