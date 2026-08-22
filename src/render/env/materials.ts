import * as THREE from 'three';

/** 把一组静态变换塞进一个 InstancedMesh，省 draw call。 */
export function instancedFrom(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  transforms: readonly THREE.Matrix4[],
  opts?: { castShadow?: boolean; receiveShadow?: boolean },
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, transforms.length));
  for (let i = 0; i < transforms.length; i++) mesh.setMatrixAt(i, transforms[i]!);
  mesh.count = transforms.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = opts?.castShadow ?? false;
  mesh.receiveShadow = opts?.receiveShadow ?? false;
  return mesh;
}

export function trs(
  x: number, y: number, z: number,
  sx = 1, sy = 1, sz = 1,
  rx = 0, ry = 0, rz = 0,
): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
  return m;
}

/** 画一张贴图：给一个 canvas 2d 上下文，回一个 THREE.Texture。 */
export function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts?: { repeat?: [number, number]; wrap?: THREE.Wrapping; srgb?: boolean },
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(c);
  const wrap = opts?.wrap ?? THREE.RepeatWrapping;
  tex.wrapS = wrap;
  tex.wrapT = wrap;
  if (opts?.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  if (opts?.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
