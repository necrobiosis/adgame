import * as THREE from 'three';
import { ROAD_HALF } from '../../config/balance';
import type { Rng } from '../../core/Rng';
import { canvasTexture, instancedFrom, trs } from './materials';
import { chamferBox, lathe, merge, paint, place } from '../geom/hardSurface';
import type { SkyTheme } from './Sky';

/**
 * 第一关的积木场景。
 *
 * 目标是"乐高大电影"那种画面：**高清、干净、亮**的注塑塑料件。所有精致感
 * 都来自三件事，缺一件就立刻塌成"方块游戏"：
 *
 *  1. **零件比例是真的**。一颗凸点的间距是这个世界的模数 UNIT，其余尺寸全
 *     按真实积木的比例推：砖高 1.2、板高 0.4、凸点半径 0.3、凸点高 0.225。
 *     这几个数字是这套画风的骨架——随手写的高度会立刻让人觉得"不对劲"，
 *     哪怕说不出哪里不对。
 *  2. **每条棱都有倒角**。真实积木为了脱模，每条边都断了一刀。那圈倒角在
 *     强光下会亮成一条细白线，零件的"体积感"全靠它。这也是为什么这一关
 *     不能降分辨率——倒角只有一两个像素宽，一压分辨率就没了。
 *  3. **ABS 的高光**。塑料件不是哑光的：清漆层（clearcoat）给出一层又硬又
 *     窄的高光，跟着天空环境贴图走。这是塑料和石头/金属最直接的区别。
 *
 * 场景是**用零件搭出来的**，不是"把东西做成方的"：砖、板、平滑片、斜面、
 * 圆砖各司其职。认得出零件，才认得出这是积木。
 */

/** 凸点间距。这个世界的模数，其余尺寸都是它的比例。 */
const UNIT = 0.8;
/** 一块标准砖的高度（真实比例 9.6mm / 8mm）。 */
const BRICK_H = UNIT * 1.2;
/** 一块板的高度（3.2mm / 8mm）。砖 = 三块板。 */
const PLATE_H = UNIT * 0.4;
/** 凸点半径与高度（4.8mm、1.8mm）。 */
const STUD_R = UNIT * 0.3;
const STUD_H = UNIT * 0.225;
/** 脱模倒角。小到几乎看不见，但每条棱上的那条高光全靠它。 */
const BEVEL = UNIT * 0.028;

/** 经典积木色板。饱和、明确、不带脏色——脏色交给光照去做。 */
export const BRICK = {
  red: 0xc4281c,
  yellow: 0xf5cd2f,
  blue: 0x0d6ebc,
  azure: 0x3ea9dd,
  green: 0x287f46,
  lime: 0xa5ca42,
  orange: 0xe6820e,
  tan: 0xdec69c,
  brown: 0x7c4f2b,
  grey: 0xa0a5a9,
  darkGrey: 0x545a5e,
  white: 0xf2f3f2,
  black: 0x1b2a34,
  sand: 0x9ba19d,
} as const;

/**
 * ABS 塑料。
 *
 * clearcoat 是这套材质的重点：注塑件表面有一层很薄的光泽层，高光又窄又硬，
 * 和底色几乎不混。用普通 StandardMaterial 调低粗糙度也能亮，但那是"抛光的
 * 石头"——高光会被底色染上颜色，塑料感就没了。
 *
 * 不开 flatShading：棱角交给倒角去表达。flatShading 会把凸点的侧面切成
 * 一圈生硬的小平面，正是廉价方块感的来源。
 */
export function plastic(color = 0xffffff, opts?: { rough?: number }): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    vertexColors: true,
    roughness: opts?.rough ?? 0.36,
    metalness: 0.0,
    clearcoat: 0.75,
    clearcoatRoughness: 0.16,
  });
}

/**
 * 一颗凸点。
 *
 * 侧壁 + 顶面之间断一刀小倒角——这一刀是凸点在灯光下那一圈亮边的来源。
 * 16 段：凸点是画面里最小也最密的圆形，段数低了会在近景露出多边形轮廓。
 */
function stud(segments = 16): THREE.BufferGeometry {
  const c = STUD_R * 0.12;
  return lathe([
    [0, 0],
    [STUD_R, 0],
    [STUD_R, STUD_H - c],
    [STUD_R - c, STUD_H],
    [0, STUD_H],
  ], segments);
}

export interface PartOptions {
  /** 顶面有没有凸点。平滑片（tile）没有。 */
  studs?: boolean;
  /** 凸点的圆周段数。远景件可以调低。 */
  studSegments?: number;
}

/**
 * 一个积木零件：`cols × rows` 个凸点、`plates` 块板那么高。
 *
 * 高度用"几块板"而不是米来表达，是因为积木世界里所有竖直尺寸都是板的整数倍——
 * 用米写一定会写出对不上格子的高度，堆起来就会露出缝或者穿模。
 */
export function part(
  cols: number,
  rows: number,
  plates: number,
  color: number,
  opts?: PartOptions,
): THREE.BufferGeometry {
  const w = cols * UNIT;
  const d = rows * UNIT;
  const h = plates * PLATE_H;
  const parts: THREE.BufferGeometry[] = [paint(chamferBox(w, h, d, BEVEL), color)];
  if (opts?.studs !== false) {
    const s = stud(opts?.studSegments ?? 16);
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        parts.push(paint(place(s.clone(), {
          x: (i - (cols - 1) / 2) * UNIT,
          y: h / 2,
          z: (j - (rows - 1) / 2) * UNIT,
        }), color));
      }
    }
    s.dispose();
  }
  return merge(parts);
}

/** 一块标准砖（三块板高）。 */
const brick = (cols: number, rows: number, color: number, opts?: PartOptions) =>
  part(cols, rows, 3, color, opts);

/**
 * 摞起来的一叠砖。
 *
 * 只有最上面那块有凸点——下面每一块的凸点都插在上一块的底管里，现实中
 * 一颗也看不见。这既是"对不对"的问题，也是这一关最大的一笔性能账：
 * 一颗凸点是十六段的回转体，一叠四块砖的柱子，白做的凸点占掉它四分之三
 * 的面数。桥上这种重复件成百上千，省下来的是几十万个三角形。
 */
function stack(cols: number, rows: number, count: number, segments = 12): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const top = i === count - 1;
    parts.push(place(brick(cols, rows, 0xffffff, top ? { studSegments: segments } : { studs: false }), { y: i * BRICK_H }));
  }
  return merge(parts);
}

/** 一批各自上色的实例。积木场景的颜色变化全靠它，不靠多建几种材质。 */
function coloured(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: readonly { m: THREE.Matrix4; c: number }[],
  opts?: { castShadow?: boolean; receiveShadow?: boolean },
): THREE.InstancedMesh {
  const mesh = instancedFrom(geo, mat, items.map((it) => it.m), opts);
  const col = new THREE.Color();
  for (let i = 0; i < items.length; i++) mesh.setColorAt(i, col.setHex(items[i]!.c));
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

/**
 * 积木天色。
 *
 * 亮、干净、偏冷。塑料件的高光是天空贴图直接反射出来的，天要是压暗一档，
 * 所有零件同时失去那圈亮边，整场戏就垮了。
 */
export const BRICK_SKY: SkyTheme = {
  top: 0x2f7fcc,
  horizon: 0xcfe4f2,
  ground: 0x8b968c,
  fog: 0xcfe0ec,
  sun: 0xfffaf0,
  ambient: 0xb4cbdd,
  sunDir: [-0.42, 0.6, 0.34],
  sunIntensity: 9.5,
};

// ── 桥 ────────────────────────────────────────────────────────

/**
 * 积木大桥。
 *
 * 和写实版同一套布局（路面 / 路肩 / 护栏 / 门架 / 桥墩），但每一件都是能叫出
 * 名字的零件：路面是**平滑片**（车开的地方不该有凸点，这是积木城的常识），
 * 路肩是**板**，护栏是砖，门架是砖柱加横梁。
 */
export function createBrickBridge(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const L = length + 260;
  const z0 = -120;
  const mat = plastic();

  // ── 路面：印着车道线的平滑片 ───────────────────────────────
  // 贴图画到 1024×2048：车道线的边必须是干净利落的一条直线。这一关的
  // 精致感就在这些边上，贴图糊了再高的分辨率也救不回来。
  const roadTex = canvasTexture(1024, 2048, (ctx, w, h) => {
    // 深蓝灰：积木城的路板就是这个色。底色压得住，白线才亮得起来——
    // 第一版给到 #3f4548，在这套强光下整条路泛白，车道线跟着糊掉了。
    ctx.fillStyle = '#2b3134';
    ctx.fillRect(0, 0, w, h);
    // 零件之间的接缝：路面是一片片平滑片拼出来的，缝要看得见
    ctx.strokeStyle = 'rgba(16,19,21,0.85)';
    ctx.lineWidth = 5;
    const cell = w / 12;
    for (let x = 0; x <= w; x += cell) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    for (let y = 0; y <= h; y += cell) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    // 车道分隔线：三排的边界是这个游戏每一秒都要读的信息，最亮最粗
    ctx.fillStyle = '#f4efdc';
    for (const cx of [w / 3, (w * 2) / 3]) {
      for (let y = 0; y < h; y += 300) ctx.fillRect(cx - 14, y, 28, 190);
    }
    // 路肩实线
    ctx.fillStyle = '#e2dcc4';
    ctx.fillRect(26, 0, 18, h);
    ctx.fillRect(w - 44, 0, 18, h);
  }, { repeat: [1, Math.round(L / 24)] });
  roadTex.anisotropy = 16;

  const road = new THREE.Mesh(
    chamferBox(ROAD_HALF * 2, PLATE_H * 2, L, BEVEL),
    // 路板的清漆比零件弱得多：它是整场唯一一块大面积的平面，
    // 给足高光会把整条路照成一面镜子，车道线全被冲掉
    new THREE.MeshPhysicalMaterial({
      map: roadTex, roughness: 0.62, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.3,
    }),
  );
  road.position.set(0, -PLATE_H, z0 + L / 2);
  road.receiveShadow = true;
  g.add(road);

  // 桥面底板：一整条深灰件，给路面一个厚度
  const deck = new THREE.Mesh(
    chamferBox(ROAD_HALF * 2 + 2.4, BRICK_H, L, BEVEL),
    plastic(BRICK.darkGrey),
  );
  deck.position.set(0, -PLATE_H * 2 - BRICK_H / 2, z0 + L / 2);
  g.add(deck);

  // ── 路肩：一排露着凸点的板，把"这是搭出来的"讲明白 ─────────
  const shoulderGeo = part(1, 8, 1, 0xffffff, { studSegments: 8 });
  const shoulders: { m: THREE.Matrix4; c: number }[] = [];
  for (let z = z0; z < z0 + L; z += UNIT * 8) {
    for (const sx of [-1, 1]) {
      shoulders.push({ m: trs(sx * (ROAD_HALF - UNIT / 2), PLATE_H * 0.5, z + UNIT * 4), c: BRICK.sand });
    }
  }
  g.add(coloured(shoulderGeo, mat, shoulders, { receiveShadow: true }));

  // ── 护栏：红白相间的砖，两块摞一段 ─────────────────────────
  const segLen = UNIT * 8;
  const barrierGeo = stack(1, 8, 2);
  const barriers: { m: THREE.Matrix4; c: number }[] = [];
  let seg = 0;
  for (let z = z0; z < z0 + L; z += segLen) {
    for (const sx of [-1, 1]) {
      barriers.push({
        m: trs(sx * (ROAD_HALF + UNIT * 0.6), BRICK_H / 2, z + segLen / 2),
        c: seg % 2 === 0 ? BRICK.red : BRICK.white,
      });
    }
    seg++;
  }
  g.add(coloured(barrierGeo, mat, barriers, { castShadow: true, receiveShadow: true }));

  // ── 门架：砖柱 + 横梁 ──────────────────────────────────────
  const step = (UNIT * 10) / Math.max(0.35, detail);
  const postPlates = 12; // 四块砖高
  const postGeo = stack(2, 2, 4);
  const posts: { m: THREE.Matrix4; c: number }[] = [];
  for (let z = z0; z < z0 + L; z += step) {
    for (const sx of [-1, 1]) {
      posts.push({ m: trs(sx * (ROAD_HALF + UNIT * 2), BRICK_H / 2, z), c: BRICK.yellow });
    }
  }
  g.add(coloured(postGeo, mat, posts, { castShadow: true, receiveShadow: true }));

  // 上弦：两条通长的梁。这么长的件不逐颗放凸点——只做一条带倒角的梁，
  // 凸点在这个高度上一颗也看不见，为它花的面全是浪费。
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(chamferBox(UNIT * 2, BRICK_H, L, BEVEL), plastic(BRICK.yellow));
    rail.position.set(sx * (ROAD_HALF + UNIT * 2), postPlates * PLATE_H + BRICK_H * 0.5, z0 + L / 2);
    rail.castShadow = true;
    g.add(rail);
  }

  // ── 桥墩 ───────────────────────────────────────────────────
  const pierGeo = chamferBox(UNIT * 4, 1, UNIT * 4, BEVEL);
  const capGeo = part(6, 6, 2, 0xffffff, { studSegments: 10 });
  const piers: { m: THREE.Matrix4; c: number }[] = [];
  const caps: { m: THREE.Matrix4; c: number }[] = [];
  for (let z = z0; z < z0 + L; z += 46) {
    const depth = 52 + rng.range(-8, 12);
    for (const sx of [-1, 1]) {
      piers.push({ m: trs(sx * 6.2, -depth / 2 - 2.4, z, 1, depth, 1), c: BRICK.grey });
      caps.push({ m: trs(sx * 6.2, -2.4, z), c: BRICK.darkGrey });
    }
  }
  g.add(coloured(pierGeo, mat, piers));
  g.add(coloured(capGeo, mat, caps));

  return g;
}

// ── 城市 ──────────────────────────────────────────────────────

/**
 * 积木城市。
 *
 * 每栋楼是**一摞砖**：楼层之间留得出接缝，顶上收一段带凸点的平台。
 * 一栋楼只用一个实例（整摞烘成一个几何体再按矩阵摆），所以四百多栋楼
 * 仍然是几个 draw call。
 *
 * 楼层的砖高是固定的（真实比例），楼有多高就摞多少层——不用缩放去凑高度。
 * 一缩放，凸点和倒角会跟着变形，"这是积木"的信息第一时间就没了。
 */
export function createBrickCity(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const L = length + 400;
  const z0 = -200;
  const mat = plastic();

  // 楼型按**距离**分两档，这是这一关最大的一笔性能预算。
  //
  // 一颗凸点是十六段的回转体，一栋带凸点的楼摞下来五千多面；四百栋就是
  // 两百多万面，比全场角色加起来还多。而三十米开外，一颗凸点在屏幕上
  // 连一个像素都占不满——那些面全是白花的。
  //
  // 所以：近处那一圈楼是真零件（倒角 + 凸点），远处的只留轮廓和颜色。
  // 玩家看得清的地方一点不省，看不清的地方一点不给。
  const towers = [
    towerGeo(4, 4, 9, 2, true),
    towerGeo(5, 4, 14, 3, true),
    towerGeo(4, 4, 20, 4, false),
    towerGeo(6, 5, 6, 1, false),
    towerGeo(4, 4, 12, 3, false),
  ];
  const buckets: { m: THREE.Matrix4; c: number }[][] = towers.map(() => []);

  const palette = [BRICK.red, BRICK.blue, BRICK.yellow, BRICK.green, BRICK.orange,
    BRICK.lime, BRICK.tan, BRICK.azure, BRICK.brown, BRICK.white];
  const count = Math.round(440 * THREE.MathUtils.clamp(detail, 0.4, 1));
  for (let i = 0; i < count; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const band = rng.next();
    const dist = 18 + band * 260;
    const x = side * dist + rng.range(-10, 10);
    const z = z0 + rng.next() * L;
    // 近处用带凸点的精细件，远处用只有轮廓的简化件
    const kind = band < 0.16
      ? (rng.next() < 0.5 ? 0 : 1)
      : band < 0.55 ? (rng.next() < 0.5 ? 4 : 3) : 2;
    // 世界尺度上一栋楼只有十几米高，直接摆在雾里会显得矮——整体放大，
    // 但**等比**放大，凸点和倒角的比例不变
    const s = 2.2 + band * 3.4 + rng.range(-0.3, 0.5);
    const y = -46 - rng.range(0, 14);
    buckets[kind]!.push({
      m: trs(x, y, z, s, s, s, 0, rng.next() < 0.5 ? 0 : Math.PI / 2, 0),
      c: palette[Math.floor(rng.next() * palette.length)]!,
    });
  }
  for (let i = 0; i < towers.length; i++) g.add(coloured(towers[i]!, mat, buckets[i]!));

  // ── 窗户：一格一格的自发光平滑片 ───────────────────────────
  const lit: { m: THREE.Matrix4; c: number }[] = [];
  const litCount = Math.round(420 * THREE.MathUtils.clamp(detail, 0.4, 1));
  for (let i = 0; i < litCount; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const band = rng.next() * 0.6;
    const dist = 18 + band * 260;
    const x = side * (dist - 0.7) + rng.range(-8, 8);
    const z = z0 + rng.next() * L;
    const y = -40 + rng.next() * 96;
    lit.push({
      m: trs(x, y, z, UNIT * 1.6, UNIT * 1.2, 0.25, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0),
      c: rng.next() < 0.25 ? 0xa8e6ff : 0xffe0a0,
    });
  }
  const windowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
  g.add(coloured(chamferBox(1, 1, 1, 0.06), windowMat, lit));

  // 雾的底色，避免俯视时看到虚空
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshBasicMaterial({ color: 0x76857a }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -96, z0 + L / 2);
  g.add(ground);

  return g;
}

/**
 * 一栋楼：`floors` 层砖，每隔几层收一次台，顶上盖一块带凸点的平台。
 *
 * 只有**顶上那一层**保留凸点：楼身的凸点全被上一层砖压住了，真实积木里
 * 看不见——留着不但不对，还平白多出几万个面。
 *
 * @param fine 近景件。false 时不放凸点、也不倒角——远处只读得到轮廓，
 *             那两样在屏幕上占不满一个像素。
 */
function towerGeo(cols: number, rows: number, floors: number, setbacks: number, fine: boolean): THREE.BufferGeometry {
  const stack: THREE.BufferGeometry[] = [];
  let c = cols;
  let r = rows;
  let y = 0;
  const every = Math.max(2, Math.floor(floors / (setbacks + 1)));
  for (let f = 0; f < floors; f++) {
    if (f > 0 && f % every === 0 && c > 2 && r > 2) {
      // 收台：楼层往里缩一圈，同时露出下面那层的顶——积木塔的层次就是这么来的
      stack.push(place(floor(c, r, 1, fine, fine ? 8 : 0), { y: y + PLATE_H / 2 }));
      y += PLATE_H;
      c -= 1;
      r -= 1;
    }
    stack.push(place(floor(c, r, 3, false, 0), { y: y + BRICK_H / 2 }));
    y += BRICK_H;
  }
  // 楼顶：一块带凸点的板 + 一小间机房
  stack.push(place(floor(c, r, 1, fine, 10), { y: y + PLATE_H / 2 }));
  y += PLATE_H;
  if (c >= 3) {
    stack.push(place(floor(2, 2, 3, fine, 10), { y: y + BRICK_H / 2, x: UNIT * 0.5 }));
  }
  return merge(stack);
}

/** 楼的一层。近景件走 part()，远景件退化成一个不倒角的盒子。 */
function floor(cols: number, rows: number, plates: number, studs: boolean, segments: number): THREE.BufferGeometry {
  if (studs) return part(cols, rows, plates, 0xffffff, { studSegments: segments });
  return paint(new THREE.BoxGeometry(cols * UNIT, plates * PLATE_H, rows * UNIT), 0xffffff);
}

// ── 路肩陈设 ──────────────────────────────────────────────────

/**
 * 积木版的路肩陈设：拼出来的废车和散落的零件。
 *
 * 车是能认出零件的：底盘板 + 车身砖 + 挡风斜面 + 四个圆砖轮子。
 * 认得出"这是拿什么零件搭的"，比把车做得像车重要得多。
 */
export function createBrickProps(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const mat = plastic();
  const cars: { m: THREE.Matrix4; c: number }[] = [];
  const loose: { m: THREE.Matrix4; c: number }[] = [];

  const n = Math.round((length / 100) * 18 * THREE.MathUtils.clamp(detail, 0.35, 1));
  const carPalette = [BRICK.red, BRICK.blue, BRICK.white, BRICK.yellow, BRICK.green, BRICK.orange];
  for (let i = 0; i < n; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const x = side * rng.range(ROAD_HALF - 2.2, ROAD_HALF + 2.4);
    const z = rng.range(-40, length + 40);
    if (rng.next() < 0.5) {
      cars.push({
        m: trs(x, 0, z, 1, 1, 1, 0, rng.range(-0.6, 0.6), 0),
        c: carPalette[Math.floor(rng.next() * carPalette.length)]!,
      });
    } else {
      loose.push({
        m: trs(x, PLATE_H * 1.5, z, 1, 1, 1, 0, rng.range(0, 3.14), 0),
        c: rng.next() < 0.5 ? BRICK.brown : BRICK.darkGrey,
      });
    }
  }

  g.add(coloured(carGeo(), mat, cars, { castShadow: true, receiveShadow: true }));
  g.add(coloured(brick(2, 2, 0xffffff, { studSegments: 10 }), mat, loose, { castShadow: true }));

  return g;
}

/** 一辆拼出来的小车：底盘板 + 车身 + 挡风 + 四个轮子。 */
function carGeo(): THREE.BufferGeometry {
  const wheel = lathe([[0, -UNIT * 0.22], [UNIT * 0.34, -UNIT * 0.22], [UNIT * 0.38, -UNIT * 0.16],
    [UNIT * 0.38, UNIT * 0.16], [UNIT * 0.34, UNIT * 0.22], [0, UNIT * 0.22]], 14);
  const parts: THREE.BufferGeometry[] = [
    // 底盘：一块 2×5 的板
    paint(place(part(2, 5, 1, 0xffffff, { studs: false }), { y: UNIT * 0.42 }), 0x2a3238),
    // 车身：2×3 的砖，往后坐
    place(part(2, 3, 3, 0xffffff, { studSegments: 12 }), { y: UNIT * 0.42 + PLATE_H / 2 + BRICK_H / 2, z: -UNIT * 0.6 }),
    // 挡风：一块斜着放的平滑片
    paint(place(chamferBox(UNIT * 1.7, PLATE_H, UNIT * 1.3, BEVEL),
      { y: UNIT * 1.5, z: UNIT * 0.55, rx: -0.9 }), 0x9fd8e8),
    // 四个轮子
    ...[[-1, 1], [1, 1], [-1, -1], [1, -1]].map(([sx, sz]) => paint(place(wheel.clone(), {
      x: sx! * UNIT, y: UNIT * 0.38, z: sz! * UNIT * 1.4, rz: Math.PI / 2,
    }), 0x1b1f22)),
  ];
  wheel.dispose();
  return merge(parts);
}
