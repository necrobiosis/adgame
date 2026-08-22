import * as THREE from 'three';
import { ROAD_HALF } from '../../config/balance';
import { canvasTexture, instancedFrom, trs } from './materials';
import type { Rng } from '../../core/Rng';

/**
 * 高架桥。
 * 还原广告的取景：一条铺满车道线的沥青路面，两侧混凝土护栏 + 橙色钢桁架，
 * 桥面悬在城市上空几十米，桥墩一路插下去。
 */
export function createBridge(length: number, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const L = length + 260;
  const z0 = -120;

  // ── 路面 ───────────────────────────────────────────────────
  const roadTex = canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#54565c';
    ctx.fillRect(0, 0, w, h);
    // 沥青颗粒
    for (let i = 0; i < 2600; i++) {
      const v = 0.5 + Math.random() * 0.5;
      ctx.fillStyle = `rgba(${Math.round(120 * v)},${Math.round(122 * v)},${Math.round(128 * v)},0.5)`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // 中央虚线（两道）
    ctx.fillStyle = '#cdcabf';
    for (const cx of [w * 0.33, w * 0.67]) {
      for (let y = 0; y < h; y += 96) ctx.fillRect(cx - 4, y, 8, 54);
    }
    // 边线
    ctx.fillStyle = '#c4c1b6';
    ctx.fillRect(10, 0, 6, h);
    ctx.fillRect(w - 16, 0, 6, h);
  }, { repeat: [1, Math.round(L / 16)] });

  const road = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_HALF * 2, 0.7, L),
    new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.94, metalness: 0.02 }),
  );
  road.position.set(0, -0.35, z0 + L / 2);
  road.receiveShadow = true;
  g.add(road);

  // 桥面底板（从下面看的厚度）
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(ROAD_HALF * 2 + 2.6, 1.1, L),
    new THREE.MeshStandardMaterial({ color: 0x8d8f94, roughness: 0.9 }),
  );
  deck.position.set(0, -1.2, z0 + L / 2);
  g.add(deck);

  // ── 混凝土护栏 ─────────────────────────────────────────────
  const barrierMat = new THREE.MeshStandardMaterial({ color: 0xc8c6bd, roughness: 0.88 });
  for (const sx of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.75, 1.25, L), barrierMat);
    b.position.set(sx * (ROAD_HALF + 0.3), 0.62, z0 + L / 2);
    b.castShadow = true;
    b.receiveShadow = true;
    g.add(b);
  }

  // ── 橙色钢桁架 ─────────────────────────────────────────────
  const trussMat = new THREE.MeshStandardMaterial({ color: 0xd9622b, roughness: 0.6, metalness: 0.35 });
  const postGeo = new THREE.BoxGeometry(0.34, 1, 0.34);
  const braceGeo = new THREE.BoxGeometry(0.24, 1, 0.24);
  const posts: THREE.Matrix4[] = [];
  const braces: THREE.Matrix4[] = [];
  const step = 5.5;
  const postH = 3.4;
  for (let z = z0; z < z0 + L; z += step) {
    for (const sx of [-1, 1]) {
      const x = sx * (ROAD_HALF + 1.15);
      posts.push(trs(x, postH / 2 + 0.2, z, 1, postH, 1));
      // 交叉斜撑
      const diag = Math.hypot(step, postH * 0.72);
      const ang = Math.atan2(step, postH * 0.72);
      braces.push(trs(x, postH * 0.55, z + step / 2, 1, diag, 1, ang, 0, 0));
      braces.push(trs(x, postH * 0.55, z + step / 2, 1, diag, 1, -ang, 0, 0));
    }
  }
  // 上弦杆
  for (const sx of [-1, 1]) {
    posts.push(trs(sx * (ROAD_HALF + 1.15), postH + 0.2, z0 + L / 2, 1.25, L, 1.25, Math.PI / 2, 0, 0));
  }
  g.add(instancedFrom(postGeo, trussMat, posts, { castShadow: true }));
  g.add(instancedFrom(braceGeo, trussMat, braces));

  // ── 桥墩 ───────────────────────────────────────────────────
  const pierMat = new THREE.MeshStandardMaterial({ color: 0x9a9c9f, roughness: 0.92 });
  const pierGeo = new THREE.BoxGeometry(3.2, 1, 3.2);
  const piers: THREE.Matrix4[] = [];
  const beams: THREE.Matrix4[] = [];
  for (let z = z0; z < z0 + L; z += 46) {
    const depth = 52 + rng.range(-8, 12);
    for (const sx of [-1, 1]) {
      piers.push(trs(sx * 6.2, -depth / 2 - 1.6, z, 1, depth, 1));
    }
    beams.push(trs(0, -2.6, z, 5.4, 1.0, 1.2));
  }
  g.add(instancedFrom(pierGeo, pierMat, piers));
  g.add(instancedFrom(new THREE.BoxGeometry(3.2, 1, 3.2), pierMat, beams));

  // 桥面纵梁
  const girder = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.5, L),
    new THREE.MeshStandardMaterial({ color: 0x7e8186, roughness: 0.85, metalness: 0.2 }),
  );
  for (const sx of [-1, 1]) {
    const gg = girder.clone();
    gg.position.set(sx * 6.2, -2.3, z0 + L / 2);
    g.add(gg);
  }

  return g;
}
