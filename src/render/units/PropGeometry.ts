import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function colored(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/**
 * 大炮。
 * 方阵后排改装出来的家伙：底座 + 两个轮子 + 一根上扬的炮管。
 * 面朝 +z，原点在地面。
 */
export function cannonGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const base = new THREE.BoxGeometry(1.15, 0.42, 1.5);
  base.translate(0, 0.44, -0.1);
  parts.push(colored(base, 0x2f3a4d));

  const plate = new THREE.BoxGeometry(1.4, 0.7, 0.22);
  plate.translate(0, 0.72, 0.42);
  parts.push(colored(plate, 0x3d4a60));

  for (const sx of [-1, 1]) {
    const wheel = new THREE.CylinderGeometry(0.44, 0.44, 0.2, 12);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(sx * 0.66, 0.44, -0.16);
    parts.push(colored(wheel, 0x1b2029));
  }

  const barrel = new THREE.CylinderGeometry(0.19, 0.24, 2.0, 12);
  barrel.rotateX(Math.PI / 2 - 0.42);
  barrel.translate(0, 1.16, 0.62);
  parts.push(colored(barrel, 0x4a5568));

  const muzzle = new THREE.CylinderGeometry(0.28, 0.24, 0.3, 12);
  muzzle.rotateX(Math.PI / 2 - 0.42);
  muzzle.translate(0, 1.62, 1.66);
  parts.push(colored(muzzle, 0x6b7688));

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('大炮几何体合并失败');
  for (const p of parts) p.dispose();
  return merged;
}

/** 炮弹。 */
export function shellGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.17, 8, 6);
  g.scale(1, 1, 1.6);
  return g;
}
