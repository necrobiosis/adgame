import * as THREE from 'three';
import { ROAD_HALF } from '../../config/balance';
import type { Rng } from '../../core/Rng';
import { chamferBox, lathe, merge, paint, pipe, place, plate, roundedBox } from '../geom/hardSurface';
import { bakeSurface, weldSmooth } from '../geom/deform';
import { PRESET, industrial } from '../mat/pbr';
import { instancedFrom, trs } from './materials';

/**
 * 路肩上的场景陈设：废弃车辆、沙袋工事、尸堆、坍塌的混凝土块。
 *
 * 五关之前除了天色以外几乎一模一样——同一座桥、同一片城市，只有随机种子
 * 不同。天色和天气解决了"远景"，这一层解决"近景"：玩家眼睛一直盯着路面，
 * 路肩上摆什么，决定了这一关看起来像哪里。
 *
 * 全部沿用仓库的零外部资源规矩：程序化几何 + 构建期烘 AO，运行期是几个
 * InstancedMesh，零成本。摆放严格限制在 |x| > 车道范围之外，绝不挡住玩法。
 */

export type PropKind = 'wreck' | 'sandbag' | 'corpse' | 'rubble';

/** 每一关的陈设配方：各类道具的相对权重 + 总密度。 */
export interface PropMix {
  readonly weights: Readonly<Record<PropKind, number>>;
  /** 每 100 米大约摆几件。 */
  readonly perHundred: number;
}

export const LEVEL_PROPS: readonly PropMix[] = [
  // 一 · 跨海大桥：堵在桥上的车流，灾难刚发生不久
  { weights: { wreck: 6, sandbag: 2, corpse: 1, rubble: 1 }, perHundred: 7 },
  // 二 · 高架断层：桥面塌了，到处是混凝土块和临时工事
  { weights: { wreck: 3, sandbag: 3, corpse: 1, rubble: 6 }, perHundred: 9 },
  // 三 · 尸山阶梯：名副其实，路肩全是尸堆
  { weights: { wreck: 2, sandbag: 1, corpse: 8, rubble: 2 }, perHundred: 11 },
  // 四 · 猩红黎明：军方设过防线，然后失守了
  { weights: { wreck: 4, sandbag: 6, corpse: 4, rubble: 3 }, perHundred: 10 },
  // 五 · 世界终点：什么都碎了
  { weights: { wreck: 3, sandbag: 2, corpse: 6, rubble: 8 }, perHundred: 12 },
];

export function propsForLevel(id: number): PropMix {
  return LEVEL_PROPS[Math.max(0, Math.min(LEVEL_PROPS.length - 1, id - 1))]!;
}

/**
 * 沿路肩撒一批陈设。
 * `length` 是赛道总长；只往 |x| ∈ [laneEdge, ROAD_HALF+3] 的两条路肩上摆。
 */
export function createProps(length: number, rng: Rng, mix: PropMix, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const buckets: Record<PropKind, THREE.Matrix4[]> = { wreck: [], sandbag: [], corpse: [], rubble: [] };

  const kinds = Object.keys(buckets) as PropKind[];
  const total = kinds.reduce((s, k) => s + mix.weights[k], 0);
  const n = Math.round((length / 100) * mix.perHundred * THREE.MathUtils.clamp(detail, 0.35, 1));

  for (let i = 0; i < n; i++) {
    // 按权重抽一种
    let r = rng.next() * total;
    let kind: PropKind = kinds[0]!;
    for (const k of kinds) {
      r -= mix.weights[k];
      if (r <= 0) { kind = k; break; }
    }
    const side = rng.next() < 0.5 ? -1 : 1;
    // 摆在护栏内侧的路肩上：再往外就被护栏挡住看不见了，再往里会压到车道。
    const x = side * rng.range(ROAD_HALF - 2.6, ROAD_HALF - 0.4);
    const z = rng.range(12, Math.max(20, length - 12));
    // 尸堆和碎石本身是团状的，高度正好卡在护栏那条线上，不放大一点就整个
    // 被挡住了；车和沙袋本来就够高，保持原尺寸
    const bulk = kind === 'corpse' || kind === 'rubble' ? 1.45 : 1;
    const s = rng.range(0.85, 1.15) * bulk;
    // 车必须大致顺着桥面停 —— 车身有四米多长，随便转个角度就会横过来伸进车道。
    // 其他几种是团状的，转多少都不占地方。
    const ry = kind === 'wreck'
      ? (rng.next() < 0.5 ? 0 : Math.PI) + rng.range(-0.28, 0.28)
      : rng.range(0, Math.PI * 2);
    buckets[kind].push(trs(x, 0, z, s, s, s, 0, ry, 0));
  }

  const add = (kind: PropKind, geo: THREE.BufferGeometry, mat: THREE.Material) => {
    if (buckets[kind].length === 0) {
      geo.dispose();
      mat.dispose();
      return;
    }
    g.add(instancedFrom(geo, mat, buckets[kind], { castShadow: true, receiveShadow: true }));
  };

  add('wreck', wreckGeometry(), industrial({ ...PRESET.paintedSteel(0xffffff, 0.7), color: 0xffffff }));
  add('sandbag', sandbagGeometry(), industrial(PRESET.concrete(0x8a7f63)));
  add('corpse', corpsePileGeometry(), industrial({ ...PRESET.concrete(0xffffff), roughness: 0.86, metalness: 0.02 }));
  add('rubble', rubbleGeometry(), industrial(PRESET.concrete(0x8d8880)));

  return g;
}

/** 烧毁的轿车：车身 + 塌掉的车顶 + 四个瘪轮胎 + 敞开的引擎盖。 */
function wreckGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (geo: THREE.BufferGeometry, c: number) => parts.push(paint(geo, c));
  const BURNT = 0x2e2a27;
  const RUST = 0x6b4a34;
  const GLASS = 0x1a1f24;

  // 车身：前后略收，读起来像车而不是砖
  add(place(roundedBox(1.85, 0.62, 4.3, 0.22, 2), { y: 0.62 }), BURNT);
  add(place(roundedBox(1.7, 0.34, 2.0, 0.18, 2), { y: 1.02, z: -0.2 }), RUST);
  // 车顶塌了一半
  add(place(chamferBox(1.55, 0.08, 1.7, 0.04), { y: 1.2, z: -0.3, rx: 0.12, rz: 0.09 }), BURNT);
  // 窗框
  for (const sz of [-1, 1]) {
    add(place(plate(1.4, 0.3, 0.05, { corner: 0.05 }), { y: 1.0, z: -0.2 + sz * 1.0, rx: sz * 0.2 }), GLASS);
  }
  // 敞开的引擎盖
  add(place(plate(1.5, 1.1, 0.06, { corner: 0.06 }), { y: 1.06, z: 1.5, rx: -1.0 }), RUST);
  // 轮胎：瘪的，所以压扁一点
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(place(lathe([[0.12, -0.16], [0.3, -0.15], [0.34, 0], [0.3, 0.15], [0.12, 0.16]], 9), {
        x: sx * 0.86, y: 0.3, z: sz * 1.42, rz: Math.PI / 2, s: [1, 1, 0.72],
      }), 0x17191c);
    }
  }
  // 保险杠 + 排气
  add(place(chamferBox(1.8, 0.16, 0.14, 0.04), { y: 0.42, z: 2.16 }), RUST);
  add(place(chamferBox(1.8, 0.16, 0.14, 0.04), { y: 0.42, z: -2.16 }), RUST);

  let geo = merge(parts);
  geo = weldSmooth(geo, 40);
  return bakeSurface(geo, { gridSize: 20, rays: 8, steps: 3 });
}

/** 沙袋工事：三层错缝码放的袋子 + 两根支撑木。 */
function sandbagGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const rows = 3;
  for (let r = 0; r < rows; r++) {
    const count = 5 - r;
    const y = 0.17 + r * 0.3;
    for (let i = 0; i < count; i++) {
      const x = (i - (count - 1) / 2) * 0.62 + (r % 2 === 0 ? 0 : 0.3);
      // 袋子用压扁的球状 lathe，读起来是软的
      parts.push(paint(place(lathe([
        [0.0, -0.16], [0.24, -0.13], [0.3, 0], [0.24, 0.13], [0.0, 0.16],
      ], 8), { x, y, z: 0, rz: Math.PI / 2, ry: (i * 0.4) % 1, s: [1, 1.25, 1] }),
        r % 2 === 0 ? 0x8a7f63 : 0x776b52));
    }
  }
  // 支撑木桩
  for (const sx of [-1, 1]) {
    parts.push(paint(place(chamferBox(0.12, 1.3, 0.12, 0.02), { x: sx * 1.5, y: 0.65, rz: sx * 0.12 }), 0x4a3a26));
  }
  let geo = merge(parts);
  geo = weldSmooth(geo, 45);
  return bakeSurface(geo, { gridSize: 18, rays: 8, steps: 3 });
}

/**
 * 尸堆：几具叠在一起的躯体。
 * 不走骨骼蒙皮那套 —— 这是纯静态陈设，用几个 lathe 团出躯干和四肢的轮廓就够，
 * 远看是"一堆尸体"，近看也不至于穿帮成几何体。
 */
function corpsePileGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const SKIN = 0x9aa585;
  const CLOTH = 0x5c5748;
  const DARK = 0x3a3830;

  const body = (x: number, y: number, z: number, ry: number, rz: number, s: number, c: number) => {
    // 躯干
    parts.push(paint(place(lathe([
      [0.0, -0.52], [0.19, -0.44], [0.24, -0.1], [0.22, 0.22], [0.15, 0.44], [0.0, 0.5],
    ], 8), { x, y, z, ry, rz: rz + Math.PI / 2, s: [s, s, s * 0.8] }), c));
    // 头
    parts.push(paint(place(lathe([[0.0, -0.11], [0.1, -0.07], [0.12, 0.02], [0.09, 0.1], [0.0, 0.12]], 7),
      { x: x + Math.cos(ry) * 0.55 * s, y: y + 0.06, z: z + Math.sin(ry) * 0.55 * s, s: [s, s, s] }), SKIN));
    // 一条搭出来的腿
    parts.push(paint(place(lathe([[0.0, -0.34], [0.09, -0.28], [0.1, 0.2], [0.0, 0.3]], 6),
      { x: x - Math.cos(ry) * 0.6 * s, y: y - 0.04, z: z - Math.sin(ry) * 0.6 * s, ry, rz: rz + 1.3, s: [s, s, s] }), c));
  };

  body(0, 0.24, 0, 0.3, 0.1, 1.0, CLOTH);
  body(0.38, 0.26, -0.42, 2.1, -0.15, 0.95, DARK);
  body(-0.34, 0.25, 0.36, 4.0, 0.2, 0.9, CLOTH);
  body(0.1, 0.62, -0.05, 1.2, 0.35, 0.88, DARK);
  // 散落的一只手臂
  parts.push(paint(place(lathe([[0.0, -0.28], [0.075, -0.22], [0.08, 0.18], [0.0, 0.26]], 6),
    { x: -0.7, y: 0.1, z: -0.3, rz: 1.5, ry: 0.7 }), SKIN));

  let geo = merge(parts);
  geo = weldSmooth(geo, 50);
  return bakeSurface(geo, { gridSize: 18, rays: 8, steps: 3 });
}

/** 坍塌的混凝土块：碎块 + 露出来的钢筋。 */
function rubbleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const CONCRETE = 0x8d8880;
  const REBAR = 0x6e4a30;

  const chunks: [number, number, number, number, number, number, number][] = [
    [0, 0.28, 0, 1.15, 0.56, 0.9, 0.4],
    [0.78, 0.2, -0.42, 0.7, 0.4, 0.62, 1.7],
    [-0.6, 0.18, 0.5, 0.62, 0.36, 0.7, 2.6],
    [0.2, 0.66, 0.1, 0.66, 0.34, 0.56, 0.9],
  ];
  for (const [x, y, z, w, h, d, ry] of chunks) {
    parts.push(paint(place(chamferBox(w, h, d, 0.05), { x, y, z, ry, rx: 0.12, rz: -0.08 }), CONCRETE));
  }
  // 钢筋：从断面里翘出来几根
  for (let i = 0; i < 5; i++) {
    const a = i * 1.1;
    const x = Math.cos(a) * 0.4;
    const z = Math.sin(a) * 0.35;
    parts.push(paint(pipe([
      new THREE.Vector3(x, 0.4, z),
      new THREE.Vector3(x * 1.5, 0.85, z * 1.4),
      new THREE.Vector3(x * 1.9 + 0.12, 1.05, z * 1.8 - 0.1),
    ], 0.026, 5), REBAR));
  }

  let geo = merge(parts);
  geo = weldSmooth(geo, 40);
  return bakeSurface(geo, { gridSize: 18, rays: 8, steps: 3 });
}
