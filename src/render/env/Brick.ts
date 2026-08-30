import * as THREE from 'three';
import { ROAD_HALF } from '../../config/balance';
import type { Rng } from '../../core/Rng';
import { canvasTexture, instancedFrom, trs } from './materials';
import { chamferBox, lathe, merge, paint, place } from '../geom/hardSurface';
import type { SkyTheme } from './Sky';

/**
 * 第一关的积木场景。
 *
 * 别的关是"末日写实"：三平面细节、边缘磨损、烘焙 AO、倒角型材。这一关整套
 * 换掉——所有东西都是**塑料积木块**：一个盒子，顶上一排凸点，平涂的鲜艳颜色，
 * 平面着色。再配上后期那一趟像素化，读起来就是"用积木搭出来的像素游戏"。
 *
 * 两条规则贯穿这个文件：
 *  · 不用倒角、不用磨损、不用三平面噪声。所有让表面"像真材料"的手段在这里
 *    都是反效果——积木要的就是干净的塑料面。
 *  · 尺寸按一个统一的模数 UNIT 走。积木好看的根源是所有零件都对得上格子，
 *    随手写的数字会立刻露馅。
 */

/** 积木模数：一颗凸点的间距。所有尺寸都是它的整数倍。 */
const UNIT = 0.8;

/** 经典积木色板。饱和、明确、不带脏色——脏色交给光照和雾去做。 */
export const BRICK = {
  red: 0xc4281c,
  yellow: 0xf2cd37,
  blue: 0x1b6dc1,
  green: 0x2f8f4e,
  lime: 0x9ac93a,
  orange: 0xe8761f,
  tan: 0xd8c48c,
  brown: 0x7c4f2b,
  grey: 0x9aa19c,
  darkGrey: 0x50565a,
  white: 0xeeeeec,
  black: 0x1e2124,
} as const;

/**
 * 积木塑料材质。
 *
 * flatShading 是这套画风的关键一环：塑料件的每个面都该是一块均匀的色，
 * 顶点法线插值出来的柔和过渡会让它重新变回"有机的"表面。
 */
export function plastic(color = 0xffffff, opts?: { rough?: number }): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    vertexColors: true,
    flatShading: true,
    roughness: opts?.rough ?? 0.46,
    metalness: 0.0,
  });
}

/** 一颗凸点。段数给 8——再多在像素化之后完全看不出来，纯浪费三角形。 */
function stud(): THREE.BufferGeometry {
  const r = UNIT * 0.31;
  const h = UNIT * 0.19;
  return lathe([[0, 0], [r, 0], [r, h * 0.8], [r * 0.86, h], [0, h]], 8);
}

/**
 * 一块积木：盒子 + 顶面的凸点阵列。
 *
 * @param cols 横向几颗凸点，`rows` 纵向几颗。给 0 就是没有凸点的平板件。
 */
export function brick(
  cols: number,
  rows: number,
  height: number,
  color: number,
  opts?: { studs?: boolean },
): THREE.BufferGeometry {
  const w = cols * UNIT;
  const d = rows * UNIT;
  const parts: THREE.BufferGeometry[] = [paint(chamferBox(w, height, d, UNIT * 0.045), color)];
  if (opts?.studs !== false) {
    const s = stud();
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        parts.push(paint(place(s.clone(), {
          x: (i - (cols - 1) / 2) * UNIT,
          y: height / 2,
          z: (j - (rows - 1) / 2) * UNIT,
        }), color));
      }
    }
    s.dispose();
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
 * 比末日那几套亮得多也干净得多：积木的颜色只有在明亮的光下才立得住，
 * 压暗一档就全糊成灰。雾色跟着天色走，远处的城市自然褪成一片浅色剪影。
 */
export const BRICK_SKY: SkyTheme = {
  top: 0x3f86cc,
  horizon: 0xbcd8ea,
  ground: 0x7d8a80,
  fog: 0xbfd4e2,
  sun: 0xfff6e0,
  ambient: 0xa8c2d6,
  sunDir: [-0.42, 0.58, 0.36],
  sunIntensity: 8.5,
};

// ── 桥 ────────────────────────────────────────────────────────

/**
 * 积木大桥。
 *
 * 和写实版同一套布局（路面 / 路缘 / 护栏 / 门架 / 桥墩），但每一件都换成
 * 积木：没有工字钢、没有斜撑、没有线缆，全部是方块加凸点。
 *
 * 路面贴图故意画得很小（64×128）再用 NearestFilter 放大——像素画的颗粒
 * 必须来自贴图本身，交给后期那一趟像素化去"糊"是不够的，那样只会把
 * 一张高清贴图糊成一团。
 */
export function createBrickBridge(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const L = length + 260;
  const z0 = -120;
  const mat = plastic();

  // ── 路面 ───────────────────────────────────────────────────
  const roadTex = canvasTexture(64, 128, (ctx, w, h) => {
    // 沥青底色 + 一层粗颗粒的深浅格子。格子是整块整块填的，不是噪点——
    // 像素画里的"质感"是几块颜色拼出来的，不是随机点撒出来的。
    ctx.fillStyle = '#4b5157';
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 4) {
      for (let x = 0; x < w; x += 4) {
        if (Math.random() < 0.34) {
          ctx.fillStyle = Math.random() < 0.5 ? '#545a61' : '#43484e';
          ctx.fillRect(x, y, 4, 4);
        }
      }
    }
    // 车道分隔线：三排的边界是这个游戏每一秒都要读的信息，必须最亮最粗
    ctx.fillStyle = '#f2e9c8';
    for (const cx of [w / 3, (w * 2) / 3]) {
      for (let y = 0; y < h; y += 24) ctx.fillRect(Math.round(cx) - 2, y, 4, 16);
    }
    // 路肩边线
    ctx.fillStyle = '#d8cfae';
    ctx.fillRect(2, 0, 3, h);
    ctx.fillRect(w - 5, 0, 3, h);
  }, { repeat: [1, Math.round(L / 14)] });
  roadTex.magFilter = THREE.NearestFilter;
  roadTex.minFilter = THREE.NearestMipmapNearestFilter;
  roadTex.anisotropy = 1;

  const road = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_HALF * 2, 0.7, L),
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.72, metalness: 0 }),
  );
  road.position.set(0, -0.35, z0 + L / 2);
  road.receiveShadow = true;
  g.add(road);

  // 桥面底板：一整条深灰板件
  const deck = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 2.6, 1.1, L), plastic(BRICK.darkGrey));
  deck.position.set(0, -1.2, z0 + L / 2);
  g.add(deck);

  // ── 护栏：一段段红白相间的积木 ─────────────────────────────
  const segLen = UNIT * 8;
  const barrierGeo = brick(1, 8, UNIT * 1.5, 0xffffff);
  const barriers: { m: THREE.Matrix4; c: number }[] = [];
  let i = 0;
  for (let z = z0; z < z0 + L; z += segLen) {
    for (const sx of [-1, 1]) {
      barriers.push({
        m: trs(sx * (ROAD_HALF + 0.4), UNIT * 0.75, z + segLen / 2),
        c: i % 2 === 0 ? BRICK.red : BRICK.white,
      });
    }
    i++;
  }
  g.add(coloured(barrierGeo, mat, barriers, { castShadow: true, receiveShadow: true }));

  // ── 门架：黄色方柱 + 横梁，代替原来的橙色钢桁架 ────────────
  const step = (UNIT * 8) / Math.max(0.35, detail);
  const postH = 3.6;
  const postGeo = brick(2, 2, postH, 0xffffff);
  const posts: { m: THREE.Matrix4; c: number }[] = [];
  for (let z = z0; z < z0 + L; z += step) {
    for (const sx of [-1, 1]) posts.push({ m: trs(sx * (ROAD_HALF + 1.5), postH / 2, z), c: BRICK.yellow });
  }
  g.add(coloured(postGeo, mat, posts, { castShadow: true }));

  // 上弦：两条通长的横梁。积木件不做通长挤出，直接用一个长盒子——
  // 凸点在这个高度上根本看不见，为它多花几千个面不值。
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(UNIT * 2, UNIT * 1.2, L), plastic(BRICK.yellow));
    rail.position.set(sx * (ROAD_HALF + 1.5), postH + UNIT * 0.6, z0 + L / 2);
    rail.castShadow = true;
    g.add(rail);
  }

  // ── 桥墩 ───────────────────────────────────────────────────
  const pierGeo = brick(4, 4, 1, 0xffffff, { studs: false });
  const capGeo = brick(5, 5, UNIT * 0.6, 0xffffff);
  const piers: { m: THREE.Matrix4; c: number }[] = [];
  const caps: { m: THREE.Matrix4; c: number }[] = [];
  for (let z = z0; z < z0 + L; z += 46) {
    const depth = 52 + rng.range(-8, 12);
    for (const sx of [-1, 1]) {
      piers.push({ m: trs(sx * 6.2, -depth / 2 - 1.9, z, 1, depth, 1), c: BRICK.grey });
      caps.push({ m: trs(sx * 6.2, -2.2, z), c: BRICK.darkGrey });
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
 * 写实版按距离分三套模件（近景带退台天线、中景只留女儿墙、远景纯剪影）。
 * 积木版不需要这套：一块带凸点的方块本身就是全部信息，远近只差颜色和大小。
 * 楼是**堆出来的**——每栋两三段，段与段之间收一收，才有积木塔的层次。
 */
export function createBrickCity(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const L = length + 400;
  const z0 = -200;
  const mat = plastic();

  // 只用饱和色。灰和白在雾里会直接褪成背景，一整片楼看着像没上色——
  // 积木城的看点就是那一排明确的色块。
  const palette = [BRICK.red, BRICK.blue, BRICK.yellow, BRICK.green, BRICK.orange, BRICK.lime, BRICK.tan, BRICK.brown];
  const blocks: { m: THREE.Matrix4; c: number }[] = [];
  const count = Math.round(420 * THREE.MathUtils.clamp(detail, 0.4, 1));
  for (let i = 0; i < count; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const band = rng.next();
    const dist = 18 + band * 260;
    const x = side * dist + rng.range(-10, 10);
    const z = z0 + rng.next() * L;
    const w = 8 + rng.next() * (10 + band * 20);
    const d = 8 + rng.next() * (10 + band * 20);
    const total = 18 + rng.next() * (26 + band * 150);
    const base = -46 - rng.range(0, 16);
    const colour = palette[Math.floor(rng.next() * palette.length)]!;
    // 一栋楼堆两三段，每往上一段收窄一点
    const tiers = 2 + Math.floor(rng.next() * 2);
    let y = base;
    for (let t = 0; t < tiers; t++) {
      const hSeg = (total / tiers) * (1 + (t === 0 ? 0.2 : -0.1));
      const shrink = 1 - t * 0.16;
      blocks.push({
        m: trs(x, y + hSeg / 2, z, w * shrink, hSeg, d * shrink, 0, rng.range(-0.2, 0.2), 0),
        c: colour,
      });
      y += hSeg;
    }
  }
  // 单位方块 + 一颗大凸点：实例矩阵一缩放，凸点跟着变成"楼顶那个圆台"，
  // 远看正好是积木塔的顶。给每栋楼真的铺一格一格的凸点是做不到的——
  // 凸点会跟着非等比缩放一起被拉扁。
  g.add(coloured(brick(1, 1, 1, 0xffffff), mat, blocks, { receiveShadow: false }));

  // ── 窗户：一格一格的自发光小方片 ───────────────────────────
  const lit: { m: THREE.Matrix4; c: number }[] = [];
  const litCount = Math.round(300 * THREE.MathUtils.clamp(detail, 0.4, 1));
  for (let i = 0; i < litCount; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const band = rng.next() * 0.55;
    const dist = 18 + band * 260;
    const x = side * (dist - 0.6) + rng.range(-8, 8);
    const z = z0 + rng.next() * L;
    const y = -40 + rng.next() * 90;
    lit.push({
      m: trs(x, y, z, UNIT, UNIT, 0.2, 0, side > 0 ? -Math.PI / 2 : Math.PI / 2, 0),
      c: rng.next() < 0.25 ? 0x9fe0ff : 0xffd98a,
    });
  }
  const windowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: true });
  g.add(coloured(chamferBox(1, 1, 1, 0.02), windowMat, lit));

  // 雾的底色，避免俯视时看到虚空
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshBasicMaterial({ color: 0x6d7a6f }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -96, z0 + L / 2);
  g.add(ground);

  return g;
}

// ── 路肩陈设 ──────────────────────────────────────────────────

/**
 * 积木版的路肩陈设。
 *
 * 写实版那套（废车、沙袋、尸堆、瓦砾）在这里换成"用积木拼的同一批东西"：
 * 车是三块摞起来的方块，沙袋是一小堆棕色砖，瓦砾是散落的碎砖。形不重要，
 * 剪影和颜色对得上就够了——像素化之后能读到的本来就只有这两样。
 */
export function createBrickProps(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const mat = plastic();
  const items: { m: THREE.Matrix4; c: number }[] = [];
  const cars: { m: THREE.Matrix4; c: number }[] = [];

  const n = Math.round((length / 100) * 16 * THREE.MathUtils.clamp(detail, 0.35, 1));
  const carPalette = [BRICK.red, BRICK.blue, BRICK.white, BRICK.yellow, BRICK.green];
  for (let i = 0; i < n; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const x = side * rng.range(ROAD_HALF - 2.4, ROAD_HALF + 2.6);
    const z = rng.range(-40, length + 40);
    if (rng.next() < 0.45) {
      cars.push({
        m: trs(x, UNIT * 0.75, z, 1, 1, 1, 0, rng.range(-0.5, 0.5), 0),
        c: carPalette[Math.floor(rng.next() * carPalette.length)]!,
      });
    } else {
      const s = rng.range(0.6, 1.3);
      items.push({
        m: trs(x, UNIT * 0.3 * s, z, s, s, s, 0, rng.range(0, 3.14), 0),
        c: rng.next() < 0.5 ? BRICK.brown : BRICK.darkGrey,
      });
    }
  }

  // 废车：底盘 + 车厢 + 车窗，三块积木摞出一个能读的剪影
  const carGeo = merge([
    paint(place(chamferBox(UNIT * 2, UNIT * 0.7, UNIT * 4, 0.03), { y: -UNIT * 0.35 }), 0xffffff),
    paint(place(chamferBox(UNIT * 1.8, UNIT * 0.8, UNIT * 2.2, 0.03), { y: UNIT * 0.4, z: -UNIT * 0.3 }), 0xffffff),
    paint(place(chamferBox(UNIT * 1.5, UNIT * 0.5, UNIT * 1.6, 0.02), { y: UNIT * 0.95, z: -UNIT * 0.3 }), 0x2a3238),
  ]);
  g.add(coloured(carGeo, mat, cars, { castShadow: true }));
  g.add(coloured(brick(2, 2, UNIT * 0.6, 0xffffff), mat, items, { castShadow: true }));

  return g;
}
