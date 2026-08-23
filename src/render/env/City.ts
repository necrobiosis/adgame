import * as THREE from 'three';
import type { Rng } from '../../core/Rng';
import { instancedFrom, trs } from './materials';
import { chamferBox, lathe, merge, paint, pipe, place } from '../geom/hardSurface';
import { bakeSurface, weldSmooth } from '../geom/deform';
import { PRESET, industrial } from '../mat/pbr';
import { ensureSurf } from '../mat/triplanar';

/**
 * 桥下的城市。
 *
 * 按距离分三套模件：近处的楼有退台、女儿墙、屋顶设备和天线，中景只留女儿墙，
 * 远景是纯剪影。加上雾，远处自然糊成层次 —— 这正是广告里"站在高架上俯瞰一整座
 * 死城"的观感，而近处的那几十栋才真的花三角形。
 */
export function createCity(length: number, rng: Rng, detail = 1): THREE.Group {
  const g = new THREE.Group();
  const L = length + 400;
  const z0 = -200;

  const near: THREE.Matrix4[] = [];
  const mid: THREE.Matrix4[] = [];
  const far: THREE.Matrix4[] = [];

  const count = Math.round(620 * THREE.MathUtils.clamp(detail, 0.4, 1));
  for (let i = 0; i < count; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    const band = rng.next();
    const dist = 18 + band * 260;
    const x = side * dist + rng.range(-10, 10);
    const z = z0 + rng.next() * L;
    const h = 18 + rng.next() * (26 + band * 150);
    const w = 8 + rng.next() * (10 + band * 22);
    const d = 8 + rng.next() * (10 + band * 22);
    const y = -46 + h / 2 - rng.range(0, 16);
    // 模件本身是单位尺寸，靠实例矩阵缩放
    const m = trs(x, y, z, w, h, d, 0, rng.range(-0.25, 0.25), 0);
    if (band < 0.10) near.push(m);
    else if (band < 0.42) mid.push(m);
    else far.push(m);
  }

  // 末日基调：灰蓝混凝土换成烟熏灰/锈蚀色，整座城市先从配色上垮掉
  const concrete = industrial(PRESET.concrete(0x4a463e));
  const steel = industrial(PRESET.bareSteel(0x5c4a3a));

  g.add(instancedFrom(nearBlock(), concrete, near, { receiveShadow: false }));
  g.add(instancedFrom(midBlock(), concrete, mid));
  g.add(instancedFrom(ensureSurf(chamferBox(1, 1, 1, 0.05)), industrial(PRESET.concrete(0x5c5850)), far));
  void steel;

  // 雾的底色，避免俯视时看到虚空
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshBasicMaterial({ color: 0x3a3630 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -96, z0 + L / 2);
  g.add(ground);

  return g;
}

/** 近景楼：退台 + 女儿墙 + 屋顶设备 + 天线。单位尺寸，靠实例矩阵缩放。 */
function nearBlock(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (x: THREE.BufferGeometry, c: number) => parts.push(paint(x, c));
  add(chamferBox(1, 1, 1, 0.035), 0xffffff);
  // 退台
  add(place(chamferBox(0.72, 0.18, 0.72, 0.03), { y: 0.56 }), 0xf0f0ee);
  // 女儿墙
  add(place(chamferBox(1.04, 0.05, 1.04, 0.014), { y: 0.5 }), 0xe4e4e0);
  add(place(chamferBox(0.76, 0.045, 0.76, 0.012), { y: 0.66 }), 0xe4e4e0);
  // 屋顶设备：冷却塔 + 机房
  add(place(lathe([[0.0, 0], [0.09, 0], [0.09, 0.1], [0.075, 0.12], [0.0, 0.12]], 8), { x: 0.2, y: 0.66, z: -0.16 }), 0xb9bec6);
  add(place(chamferBox(0.2, 0.1, 0.16, 0.02), { x: -0.2, y: 0.7, z: 0.14 }), 0xc8ccd2);
  // 天线
  add(place(pipe([
    new THREE.Vector3(-0.02, 0.66, -0.24), new THREE.Vector3(0, 0.95, -0.24), new THREE.Vector3(0.01, 1.15, -0.24),
  ], 0.012, 4), {}), 0x8b9199);
  return bakeSurface(weldSmooth(merge(parts), 40), { gridSize: 18, rays: 8, steps: 3 });
}

/** 中景楼：只保留女儿墙这一条能读出来的轮廓线。 */
function midBlock(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  parts.push(paint(chamferBox(1, 1, 1, 0.04), 0xffffff));
  parts.push(paint(place(chamferBox(1.05, 0.045, 1.05, 0.012), { y: 0.5 }), 0xe6e6e2));
  return bakeSurface(weldSmooth(merge(parts), 40), { gridSize: 12, rays: 6, steps: 3 });
}
