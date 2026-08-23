import * as THREE from 'three';
import { ROAD_HALF } from '../../config/balance';
import { canvasTexture, instancedFrom, trs } from './materials';
import { PRESET, industrial } from '../mat/pbr';
import { ensureSurf } from '../mat/triplanar';
import { bakeSurface, weldSmooth } from '../geom/deform';
import { boltRing, chamferBox, iBeam, lathe, merge, paint, pipe, place, plate, roundedBox } from '../geom/hardSurface';
import type { Rng } from '../../core/Rng';

/**
 * 高架桥。
 *
 * 还原广告的取景：铺满车道线的沥青路面、两侧分段混凝土护栏 + 橙色钢桁架，
 * 桥面悬在城市上空几十米，桥墩一路插下去。
 *
 * 所有结构件都是带倒角的型材而不是方棍：立柱是工字钢，节点有角撑板和螺栓圈，
 * 护栏是一段段带滴水槽和伸缩缝的预制件。桁架密度受画质档 `envDetail` 控制。
 */
export function createBridge(length: number, rng: Rng, envDetail = 1): THREE.Group {
  const g = new THREE.Group();
  const L = length + 260;
  const z0 = -120;

  // ── 路面 ───────────────────────────────────────────────────
  const roadTex = canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#6f7178';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = 0.55 + Math.random() * 0.5;
      ctx.fillStyle = `rgba(${Math.round(140 * v)},${Math.round(142 * v)},${Math.round(148 * v)},0.5)`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    ctx.fillStyle = '#cdcabf';
    for (const cx of [w * 0.33, w * 0.67]) {
      for (let y = 0; y < h; y += 96) ctx.fillRect(cx - 4, y, 8, 54);
    }
    ctx.fillStyle = '#c4c1b6';
    ctx.fillRect(10, 0, 6, h);
    ctx.fillRect(w - 16, 0, 6, h);
    // 沥青补丁：真实路面从来不是一块均匀的灰
    ctx.globalAlpha = 0.22;
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 ? '#4d4f55' : '#83858c';
      ctx.beginPath();
      ctx.ellipse(Math.random() * w, Math.random() * h, 18 + Math.random() * 40, 26 + Math.random() * 70, Math.random() * 3, 0, 6.3);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, { repeat: [1, Math.round(L / 16)] });

  const road = new THREE.Mesh(
    ensureSurf(new THREE.BoxGeometry(ROAD_HALF * 2, 0.7, L)),
    industrial({ ...PRESET.asphalt(), map: roadTex }),
  );
  road.position.set(0, -0.35, z0 + L / 2);
  road.receiveShadow = true;
  g.add(road);

  const concrete = industrial(PRESET.concrete(0xb9b7ad));
  const steel = industrial(PRESET.bareSteel(0x8d949c));
  const trussMat = industrial(PRESET.paintedSteel(0xd9622b, 0.45));

  // 桥面底板
  const deck = new THREE.Mesh(
    ensureSurf(new THREE.BoxGeometry(ROAD_HALF * 2 + 2.6, 1.1, L)),
    concrete,
  );
  deck.position.set(0, -1.2, z0 + L / 2);
  deck.receiveShadow = true;
  g.add(deck);

  // 路缘石：路面和护栏之间的过渡，没有它路面像是直接怼在墙上
  for (const sx of [-1, 1]) {
    const curb = new THREE.Mesh(ensureSurf(chamferBox(0.42, 0.26, L, 0.05)), concrete);
    curb.position.set(sx * (ROAD_HALF - 0.2), 0.11, z0 + L / 2);
    curb.receiveShadow = true;
    g.add(curb);
  }

  // ── 分段混凝土护栏 ─────────────────────────────────────────
  // 一段段预制件，之间留伸缩缝；正面开滴水槽
  const segLen = 6.2;
  const barrierPart = (() => {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(paint(chamferBox(0.62, 1.02, segLen - 0.12, 0.07), 0xffffff));
    // 顶帽
    parts.push(paint(place(chamferBox(0.74, 0.14, segLen - 0.12, 0.045), { y: 0.56 }), 0xf0eee6));
    // 滴水槽
    parts.push(paint(place(chamferBox(0.05, 0.07, segLen - 0.4, 0.012), { x: -0.3, y: 0.2 }), 0x9c9a92));
    parts.push(paint(place(chamferBox(0.05, 0.07, segLen - 0.4, 0.012), { x: 0.3, y: 0.2 }), 0x9c9a92));
    return bakeSurface(weldSmooth(merge(parts), 40), { gridSize: 22, rays: 8, steps: 4 });
  })();

  const barriers: THREE.Matrix4[] = [];
  for (let z = z0; z < z0 + L; z += segLen) {
    for (const sx of [-1, 1]) barriers.push(trs(sx * (ROAD_HALF + 0.32), 0.51, z + segLen / 2));
  }
  g.add(instancedFrom(barrierPart, concrete, barriers, { castShadow: true, receiveShadow: true }));

  // ── 橙色钢桁架 ─────────────────────────────────────────────
  const step = 5.5 / Math.max(0.35, envDetail);
  const postH = 3.4;

  // 立柱：工字钢 + 底座法兰 + 螺栓圈
  const postPart = (() => {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(paint(place(iBeam(postH, { height: 0.30, width: 0.24, web: 0.05, flange: 0.055 }), { y: postH / 2 }), 0xffffff));
    parts.push(paint(place(plate(0.44, 0.44, 0.05, { corner: 0.05 }), { y: 0.03, rx: Math.PI / 2 }), 0xe8e6e2));
    parts.push(paint(place(boltRing(4, 0.15, 0.026, 0.03), { y: 0.06 }), 0x9aa0a8));
    parts.push(paint(place(plate(0.4, 0.4, 0.045, { corner: 0.05 }), { y: postH - 0.02, rx: Math.PI / 2 }), 0xe8e6e2));
    return bakeSurface(weldSmooth(merge(parts), 36), { gridSize: 24, rays: 8, steps: 4 });
  })();

  // 斜撑：扁钢，两端各有一块角撑板
  const bracePart = (() => {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(paint(chamferBox(0.16, 1, 0.09, 0.022), 0xffffff));
    return bakeSurface(weldSmooth(merge(parts), 36), { gridSize: 16, rays: 6, steps: 3 });
  })();

  // 节点角撑板
  const gussetPart = (() => {
    const s = new THREE.Shape();
    s.moveTo(-0.22, -0.22); s.lineTo(0.22, -0.22); s.lineTo(0.22, 0.06);
    s.quadraticCurveTo(0.2, 0.2, 0.06, 0.22); s.lineTo(-0.22, 0.22); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 1, curveSegments: 3 });
    return bakeSurface(weldSmooth(paint(geo, 0xffffff), 36), { gridSize: 14, rays: 6, steps: 3 });
  })();

  const posts: THREE.Matrix4[] = [];
  const braces: THREE.Matrix4[] = [];
  const gussets: THREE.Matrix4[] = [];
  for (let z = z0; z < z0 + L; z += step) {
    for (const sx of [-1, 1]) {
      const x = sx * (ROAD_HALF + 1.15);
      posts.push(trs(x, 0.2, z));
      const diag = Math.hypot(step, postH * 0.72);
      const ang = Math.atan2(step, postH * 0.72);
      braces.push(trs(x, postH * 0.55, z + step / 2, 1, diag, 1, ang, 0, 0));
      braces.push(trs(x, postH * 0.55, z + step / 2, 1, diag, 1, -ang, 0, 0));
      gussets.push(trs(x + sx * 0.12, 0.42, z, 1, 1, 1, 0, sx * Math.PI / 2, 0));
      gussets.push(trs(x + sx * 0.12, postH - 0.2, z, 1, 1, 1, 0, sx * Math.PI / 2, Math.PI));
    }
  }
  // 上弦杆：一根通长的工字钢
  const railPart = paint(place(iBeam(L, { height: 0.26, width: 0.30, web: 0.05, flange: 0.05 }), { rz: Math.PI / 2 }), 0xffffff);
  for (const sx of [-1, 1]) {
    const rail = new THREE.Mesh(ensureSurf(railPart.clone()), trussMat);
    rail.position.set(sx * (ROAD_HALF + 1.15), postH + 0.24, z0 + L / 2);
    rail.rotation.y = Math.PI / 2;
    rail.castShadow = true;
    g.add(rail);
  }
  railPart.dispose();

  g.add(instancedFrom(postPart, trussMat, posts, { castShadow: true, receiveShadow: true }));
  g.add(instancedFrom(bracePart, trussMat, braces, { castShadow: true }));
  g.add(instancedFrom(gussetPart, trussMat, gussets));

  // ── 桥墩 ───────────────────────────────────────────────────
  const piers: THREE.Matrix4[] = [];
  const caps: THREE.Matrix4[] = [];
  const pierGeo = ensureSurf(chamferBox(3.2, 1, 3.2, 0.14));
  const capGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    parts.push(paint(chamferBox(4.0, 0.5, 4.0, 0.1), 0xffffff));
    parts.push(paint(place(chamferBox(3.4, 0.4, 3.4, 0.08), { y: -0.42 }), 0xe6e4dc));
    return bakeSurface(weldSmooth(merge(parts), 40), { gridSize: 16, rays: 6, steps: 3 });
  })();
  for (let z = z0; z < z0 + L; z += 46) {
    const depth = 52 + rng.range(-8, 12);
    for (const sx of [-1, 1]) {
      piers.push(trs(sx * 6.2, -depth / 2 - 1.9, z, 1, depth, 1));
      caps.push(trs(sx * 6.2, -2.2, z));
    }
  }
  g.add(instancedFrom(pierGeo, concrete, piers));
  g.add(instancedFrom(capGeo, concrete, caps));

  // ── 桥面下的纵梁与横隔板 ───────────────────────────────────
  const girderPart = paint(place(iBeam(L, { height: 1.4, width: 0.7, web: 0.11, flange: 0.13 }), { rz: Math.PI / 2 }), 0xffffff);
  for (const sx of [-1, 1]) {
    const gg = new THREE.Mesh(ensureSurf(girderPart.clone()), steel);
    gg.position.set(sx * 6.2, -2.4, z0 + L / 2);
    gg.rotation.y = Math.PI / 2;
    g.add(gg);
  }
  girderPart.dispose();

  const diaphragms: THREE.Matrix4[] = [];
  const diaGeo = ensureSurf(chamferBox(ROAD_HALF * 2 - 6.4, 0.9, 0.18, 0.04));
  for (let z = z0; z < z0 + L; z += 11) diaphragms.push(trs(0, -2.4, z));
  g.add(instancedFrom(diaGeo, steel, diaphragms));

  // 线缆桥架：沿桥底走的一束管线，剪影上多一层信息
  for (const sx of [-1, 1]) {
    const tray = new THREE.Mesh(ensureSurf(chamferBox(0.36, 0.18, L, 0.03)), steel);
    tray.position.set(sx * 8.4, -1.95, z0 + L / 2);
    g.add(tray);
    for (let i = 0; i < 3; i++) {
      const cable = new THREE.Mesh(
        ensureSurf(pipe([new THREE.Vector3(0, 0, z0), new THREE.Vector3(0, -0.02, z0 + L / 2), new THREE.Vector3(0, 0, z0 + L)], 0.045, 5, 24)),
        industrial({ color: 0x23262b, roughness: 0.8, metalness: 0.1, wear: 0.1, grunge: 0.4 }),
      );
      cable.position.set(sx * 8.4 + (i - 1) * 0.1, -1.9, 0);
      g.add(cable);
    }
  }

  // ── 路面细节：伸缩缝、井盖、雨水口 ─────────────────────────
  const joints: THREE.Matrix4[] = [];
  const jointGeo = ensureSurf(chamferBox(ROAD_HALF * 2, 0.06, 0.26, 0.02));
  for (let z = z0; z < z0 + L; z += 46) joints.push(trs(0, 0.02, z));
  g.add(instancedFrom(jointGeo, steel, joints));

  const covers: THREE.Matrix4[] = [];
  const coverGeo = bakeSurface(weldSmooth(paint(lathe([
    [0.0, 0.03], [0.34, 0.03], [0.38, 0.012], [0.38, -0.012], [0.0, -0.012],
  ], 14), 0xffffff), 40), { gridSize: 12, rays: 6, steps: 3 });
  const drainGeo = ensureSurf(roundedBox(0.5, 0.06, 0.34, 0.02, 2));
  const drains: THREE.Matrix4[] = [];
  for (let z = z0 + 8; z < z0 + L; z += 23) {
    covers.push(trs(rng.range(-6, 6), 0.03, z));
    for (const sx of [-1, 1]) drains.push(trs(sx * (ROAD_HALF - 0.6), 0.03, z + 6));
  }
  g.add(instancedFrom(coverGeo, steel, covers));
  g.add(instancedFrom(drainGeo, steel, drains));

  return g;
}
