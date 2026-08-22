import * as THREE from 'three';
import type { Rng } from '../../core/Rng';
import { instancedFrom, trs } from './materials';

/**
 * 桥下的城市。
 * 只用实例化的盒子 + 雾，远处自然糊成剪影 —— 这正是广告里那种
 * "站在高架上俯瞰一整座死城"的观感，成本却几乎为零。
 */
export function createCity(length: number, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const L = length + 400;
  const z0 = -200;

  const near: THREE.Matrix4[] = [];
  const far: THREE.Matrix4[] = [];

  for (let i = 0; i < 620; i++) {
    const side = rng.next() < 0.5 ? -1 : 1;
    // 离桥越远的越高越大，形成层次
    const band = rng.next();
    const dist = 18 + band * 260;
    const x = side * dist + rng.range(-10, 10);
    const z = z0 + rng.next() * L;
    const h = 18 + rng.next() * (26 + band * 150);
    const w = 8 + rng.next() * (10 + band * 22);
    const d = 8 + rng.next() * (10 + band * 22);
    const y = -46 + h / 2 - rng.range(0, 16);
    const m = trs(x, y, z, w, h, d);
    (band < 0.35 ? near : far).push(m);
  }

  const nearMat = new THREE.MeshStandardMaterial({ color: 0x8d949c, roughness: 0.92 });
  const farMat = new THREE.MeshStandardMaterial({ color: 0xa3adb8, roughness: 0.95 });
  g.add(instancedFrom(new THREE.BoxGeometry(1, 1, 1), nearMat, near));
  g.add(instancedFrom(new THREE.BoxGeometry(1, 1, 1), farMat, far));

  // 地面（雾的底色，避免看到虚空）
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1600, 1600),
    new THREE.MeshBasicMaterial({ color: 0x8fa0ac }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -96, z0 + L / 2);
  g.add(ground);

  return g;
}
