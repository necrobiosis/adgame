import * as THREE from 'three';

/**
 * 程序化贴图。
 *
 * 仓库里不放任何图片资源，所有表面细节都在这里用 canvas 现算。
 *
 * 做法上刻意只生成**一套共享的细节贴图**（高度 / 法线 / 脏污 / 划痕），
 * 各种材质之间的差异靠 uniform（缩放、对比度、颜色、磨损量）拉开，而不是各生成一套 ——
 * 512² 的噪声在 JS 里算一张就要几十毫秒，一材质一套的话开局会明显卡一下。
 */

const SIZE = 256;

export interface DetailPack {
  /** 表面起伏，用来推法线。 */
  height: THREE.CanvasTexture;
  /** 由高度图 Sobel 推出的法线图。 */
  normal: THREE.CanvasTexture;
  /** 脏污 / 锈斑，低频。 */
  grunge: THREE.CanvasTexture;
  /** 细划痕，高频各向异性。 */
  scratch: THREE.CanvasTexture;
}

let cached: DetailPack | null = null;

/** 全局共享的一套细节贴图，第一次调用时生成。 */
export function detailPack(): DetailPack {
  if (cached) return cached;
  const height = canvasFrom(SIZE, (data, w, h) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 多倍频噪声 + 一点各向异性的拉丝
        const n = fbm(x / 18, y / 18, 4) * 0.62 + fbm(x / 5, y / 5, 2) * 0.24 + fbm(x / 2.2, y / 90, 2) * 0.14;
        const v = Math.round(THREE.MathUtils.clamp(n, 0, 1) * 255);
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
  });

  const grunge = canvasFrom(SIZE, (data, w, h) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 大块的斑驳，边缘用 smoothstep 收一下，避免糊成一团灰
        let n = fbm(x / 42, y / 42, 5);
        n = THREE.MathUtils.smoothstep(n, 0.32, 0.78);
        const v = Math.round(n * 255);
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
  });

  const scratch = canvasFrom(SIZE, (data, w, h) => {
    data.fill(0);
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    // 随机方向的细长划痕
    for (let s = 0; s < 260; s++) {
      const x0 = Math.random() * w;
      const y0 = Math.random() * h;
      const a = Math.random() * Math.PI * 2;
      const len = 4 + Math.random() * 46;
      const bright = 90 + Math.random() * 165;
      for (let t = 0; t < len; t++) {
        const x = Math.round(x0 + Math.cos(a) * t) & (w - 1);
        const y = Math.round(y0 + Math.sin(a) * t) & (h - 1);
        const i = (y * w + x) * 4;
        const fade = 1 - t / len;
        const v = Math.round(bright * fade);
        data[i] = Math.max(data[i]!, v);
        data[i + 1] = Math.max(data[i + 1]!, v);
        data[i + 2] = Math.max(data[i + 2]!, v);
      }
    }
  });

  const normal = heightToNormal(height.image as HTMLCanvasElement, 1.0);

  cached = { height, normal, grunge, scratch };
  return cached;
}

/** Sobel 算子把高度图转成切线空间法线图。 */
export function heightToNormal(src: HTMLCanvasElement, strength = 2): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const sctx = src.getContext('2d')!;
  const sd = sctx.getImageData(0, 0, w, h).data;
  const at = (x: number, y: number) => sd[(((y + h) % h) * w + ((x + w) % w)) * 4]! / 255;

  return canvasFrom(w, (data) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
        const l = at(x - 1, y), r = at(x + 1, y);
        const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
        const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
        const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
        const nx = -dx * strength;
        const ny = -dy * strength;
        const len = Math.hypot(nx, ny, 1);
        const i = (y * w + x) * 4;
        data[i] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
        data[i + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
        data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
        data[i + 3] = 255;
      }
    }
  }, false);
}

// ── 噪声 ──────────────────────────────────────────────────────

const PERM = (() => {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  // 固定种子的洗牌，保证每次运行的贴图一致
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i]!;
  return p;
})();

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 值噪声，周期 256，保证可平铺。 */
function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x) & 255;
  const yi = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const u = fade(xf);
  const v = fade(yf);
  const h = (a: number, b: number) => PERM[(PERM[a]! + b) & 511]! / 255;
  const n00 = h(xi, yi);
  const n10 = h((xi + 1) & 255, yi);
  const n01 = h(xi, (yi + 1) & 255);
  const n11 = h((xi + 1) & 255, (yi + 1) & 255);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(n00, n10, u), THREE.MathUtils.lerp(n01, n11, u), v);
}

function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

function canvasFrom(
  size: number,
  draw: (data: Uint8ClampedArray, w: number, h: number) => void,
  srgb = true,
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  draw(img.data, size, size);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
