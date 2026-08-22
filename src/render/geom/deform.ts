import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Rng } from '../../core/Rng';

/**
 * 顶点级修形。
 *
 * 硬表面资产光有倒角还不够 —— 真实的工业件有制造公差、有磨圆的棱、有被遮挡处的积灰。
 * 这里的几个函数都在**构建期**跑一次，把这些信息烘进几何体，运行时零成本。
 */

/**
 * 焊接重复顶点并按折角阈值重算法线。
 *
 * 这是让倒角"看起来是倒角"的关键一步：倒角面之间要平滑过渡（否则圆角会露出
 * 一圈一圈的多边形台阶），但面板缝隙、切边这些真正的硬边必须保住。
 * 折角大于阈值的边保持硬边，小于的平滑。
 */
export function weldSmooth(geo: THREE.BufferGeometry, creaseDeg = 42): THREE.BufferGeometry {
  const welded = mergeVertices(geo, 1e-4);
  const out = toCreasedNormals(welded, (creaseDeg * Math.PI) / 180);
  if (welded !== out) welded.dispose();
  return out;
}

/** 沿某根轴做锥化：坐标越靠近轴的正端，横截面缩得越小。 */
export function taper(
  geo: THREE.BufferGeometry,
  axis: 'x' | 'y' | 'z',
  from: number,
  to: number,
  scaleAtFrom: number,
  scaleAtTo: number,
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const other = axis === 'y' ? (['x', 'z'] as const) : axis === 'x' ? (['y', 'z'] as const) : (['x', 'y'] as const);
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getComponent(i, AXIS[axis]) - from) / (to - from || 1), 0, 1);
    const s = THREE.MathUtils.lerp(scaleAtFrom, scaleAtTo, t);
    for (const o of other) pos.setComponent(i, AXIS[o], pos.getComponent(i, AXIS[o]) * s);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** 轻微打乱顶点位置：制造公差、磕碰、非完美对称。幅度要小，大了就变成融化。 */
export function jitter(geo: THREE.BufferGeometry, amount: number, seed = 1): THREE.BufferGeometry {
  const rng = new Rng(seed);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + rng.range(-amount, amount),
      pos.getY(i) + rng.range(-amount, amount),
      pos.getZ(i) + rng.range(-amount, amount),
    );
  }
  pos.needsUpdate = true;
  return geo;
}

const AXIS = { x: 0, y: 1, z: 2 } as const;

// ── 表面属性烘焙 ──────────────────────────────────────────────

/**
 * 把环境光遮蔽和边缘磨损烘进一个 vec2 顶点属性 `aSurf`（x = AO，y = 磨损）。
 *
 * 为什么不用顶点色：`color` 已经被基础色占了。分开存意味着着色器可以同时拿到
 * "这块是什么颜色"和"这块被挡住了多少 / 磨得多亮"。
 *
 * AO 用体素近似：先把网格splat进一张粗糙的占据网格，再从每个顶点沿法线半球
 * 步进采样。比逐三角形求交快几个数量级，而在硬表面资产上效果足够 ——
 * 法兰底下、轮罩内侧、面板夹缝这些地方会自然变暗。
 *
 * 磨损用顶点凸度：顶点相对邻居质心沿法线方向凸出得越多，说明它越处在棱上，
 * 越容易被磨亮。这是物理正确的边缘磨损，不需要烘曲率贴图。
 */
export function bakeSurface(
  geo: THREE.BufferGeometry,
  opts?: { gridSize?: number; rays?: number; steps?: number; aoRadius?: number; ao?: boolean },
): THREE.BufferGeometry {
  const g = geo.index ? geo : mergeVertices(geo, 1e-4);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const n = pos.count;
  const surf = new Float32Array(n * 2);

  // AO 是这里最贵的一步（每个资产几十毫秒）。硬表面件值得烘，
  // 角色是有机形体、又要按画质档生成多份，靠实时阴影就够了。
  const ao = opts?.ao === false ? null : computeVoxelAO(g, opts);
  const wear = computeConvexity(g);
  for (let i = 0; i < n; i++) {
    surf[i * 2] = ao ? ao[i]! : 1;
    surf[i * 2 + 1] = wear[i]!;
  }
  g.setAttribute('aSurf', new THREE.BufferAttribute(surf, 2));
  void nrm;
  return g;
}

/** 体素化 + 半球步进的 AO 近似。返回每顶点 0（全黑）..1（完全开阔）。 */
function computeVoxelAO(
  g: THREE.BufferGeometry,
  opts?: { gridSize?: number; rays?: number; steps?: number; aoRadius?: number },
): Float32Array {
  const N = opts?.gridSize ?? 28;
  const RAYS = opts?.rays ?? 12;
  const STEPS = opts?.steps ?? 5;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const count = pos.count;

  g.computeBoundingBox();
  const bb = g.boundingBox!;
  const size = new THREE.Vector3().subVectors(bb.max, bb.min);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  // 留一圈边界，避免表面顶点落在网格外
  const pad = maxDim * 0.06;
  const origin = new THREE.Vector3(bb.min.x - pad, bb.min.y - pad, bb.min.z - pad);
  const extent = maxDim + pad * 2;
  const cell = extent / N;

  const occ = new Uint8Array(N * N * N);
  const idx = (x: number, y: number, z: number) => (z * N + y) * N + x;
  const mark = (p: THREE.Vector3) => {
    const x = Math.floor((p.x - origin.x) / cell);
    const y = Math.floor((p.y - origin.y) / cell);
    const z = Math.floor((p.z - origin.z) / cell);
    if (x < 0 || y < 0 || z < 0 || x >= N || y >= N || z >= N) return;
    occ[idx(x, y, z)] = 1;
  };

  // 用顶点 + 三角形重心和边中点做 splat：对这个精度的 AO 足够，
  // 比完整的三角形体素化快得多
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const t = new THREE.Vector3();
  const index = g.index!;
  for (let i = 0; i < index.count; i += 3) {
    a.fromBufferAttribute(pos, index.getX(i));
    b.fromBufferAttribute(pos, index.getX(i + 1));
    c.fromBufferAttribute(pos, index.getX(i + 2));
    mark(a); mark(b); mark(c);
    mark(t.addVectors(a, b).addVectors(t, c).multiplyScalar(1 / 3));
    mark(t.addVectors(a, b).multiplyScalar(0.5));
    mark(t.addVectors(b, c).multiplyScalar(0.5));
    mark(t.addVectors(c, a).multiplyScalar(0.5));
  }

  const dirs = hemisphereDirs(RAYS);
  const out = new Float32Array(count);
  const p = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const sample = new THREE.Vector3();
  const radius = opts?.aoRadius ?? maxDim * 0.22;

  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(pos, i);
    nv.fromBufferAttribute(nrm, i).normalize();
    makeBasis(nv, tangent, bitangent);
    let open = 0;
    for (const d of dirs) {
      dir.set(0, 0, 0)
        .addScaledVector(tangent, d.x)
        .addScaledVector(bitangent, d.y)
        .addScaledVector(nv, d.z)
        .normalize();
      let blocked = 0;
      for (let s = 1; s <= STEPS; s++) {
        const dist = (s / STEPS) * radius;
        sample.copy(p).addScaledVector(nv, cell * 0.9).addScaledVector(dir, dist);
        const x = Math.floor((sample.x - origin.x) / cell);
        const y = Math.floor((sample.y - origin.y) / cell);
        const z = Math.floor((sample.z - origin.z) / cell);
        if (x < 0 || y < 0 || z < 0 || x >= N || y >= N || z >= N) break;
        if (occ[idx(x, y, z)]) {
          // 越近的遮挡越重
          blocked = 1 - (s - 1) / STEPS;
          break;
        }
      }
      open += 1 - blocked;
    }
    out[i] = THREE.MathUtils.clamp(open / dirs.length, 0, 1);
  }
  return out;
}

/** 顶点凸度 → 边缘磨损强度 0..1。 */
function computeConvexity(g: THREE.BufferGeometry): Float32Array {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const index = g.index!;
  const count = pos.count;
  const sum = new Float32Array(count * 3);
  const deg = new Uint16Array(count);

  const add = (from: number, to: number) => {
    sum[from * 3] += pos.getX(to);
    sum[from * 3 + 1] += pos.getY(to);
    sum[from * 3 + 2] += pos.getZ(to);
    deg[from]!++;
  };
  for (let i = 0; i < index.count; i += 3) {
    const i0 = index.getX(i);
    const i1 = index.getX(i + 1);
    const i2 = index.getX(i + 2);
    add(i0, i1); add(i0, i2);
    add(i1, i0); add(i1, i2);
    add(i2, i0); add(i2, i1);
  }

  g.computeBoundingSphere();
  const scale = g.boundingSphere?.radius ?? 1;
  const out = new Float32Array(count);
  const p = new THREE.Vector3();
  const nv = new THREE.Vector3();
  const mean = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const d = deg[i]!;
    if (d === 0) continue;
    p.fromBufferAttribute(pos, i);
    nv.fromBufferAttribute(nrm, i).normalize();
    mean.set(sum[i * 3]! / d, sum[i * 3 + 1]! / d, sum[i * 3 + 2]! / d);
    mean.subVectors(p, mean);
    // 沿法线的凸出量，按资产尺度归一化
    const convex = mean.dot(nv) / (scale * 0.04);
    out[i] = THREE.MathUtils.clamp(convex, 0, 1);
  }
  return out;
}

/** 法线半球上的一组余弦加权方向（局部坐标，z 为法线方向）。 */
function hemisphereDirs(n: number): { x: number; y: number; z: number }[] {
  const dirs: { x: number; y: number; z: number }[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    // 余弦加权：靠近法线的方向更密
    const r = Math.sqrt((i + 0.5) / n);
    const theta = i * golden;
    const x = r * Math.cos(theta);
    const y = r * Math.sin(theta);
    dirs.push({ x, y, z: Math.sqrt(Math.max(0, 1 - x * x - y * y)) });
  }
  return dirs;
}

/** 由法线构造一组正交基。 */
function makeBasis(n: THREE.Vector3, t: THREE.Vector3, b: THREE.Vector3): void {
  if (Math.abs(n.z) < 0.9) t.set(0, 0, 1);
  else t.set(1, 0, 0);
  t.cross(n).normalize();
  b.crossVectors(n, t).normalize();
}
