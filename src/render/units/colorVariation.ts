import * as THREE from 'three';

/**
 * 每实例的颜色抖动。
 *
 * `CrowdMaterial` 的 `aTint` 管线本来就支持每实例独立颜色（用来做受击闪白之类
 * 的事），但调用方（`GameView`）一直给同一种敌人的所有实例传同一个
 * `THREE.Color` —— 结果就是一整波尸潮、一整队士兵全是像素级相同的一个颜色，
 * 像同一个模型复制粘贴。
 *
 * 这里不引入任何贴图（仓库的美术管线是纯程序化生成，不依赖外部图片资源），
 * 而是用实例 id 生成一个**稳定**的伪随机数（同一个 id 每帧算出来必须是同一个
 * 值，否则颜色会在每帧之间跳动），把基础色转到 HSL 空间后在色相/饱和度/明度
 * 上分别做小幅抖动，再转回 RGB。
 */

/** 从整数 id 出发的稳定哈希，映射到 [0, 1)。 */
function hash(id: number, salt: number): number {
  let h = (id * 2654435761 + salt * 374761393) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface JitterOptions {
  /** 色相抖动幅度（0..1，围绕基础色相双向抖动）。 */
  hue?: number;
  /** 饱和度抖动幅度。 */
  saturation?: number;
  /** 明度抖动幅度。 */
  lightness?: number;
}

/**
 * 各类敌人的默认抖动幅度。
 * 越"杂兵"抖动越大（同一波尸潮里明显能看出个体差异），越"精英"抖动越小
 * （体型本身已经足够有辨识度，颜色应该更沉稳统一）；Boss 只有一个实例，
 * 抖动没有意义，颜色单调的问题要靠调色板本身解决，不是靠这个函数。
 */
export const ENEMY_JITTER: Record<string, JitterOptions> = {
  walker:   { hue: 0.055, saturation: 0.20, lightness: 0.15 },
  runner:   { hue: 0.045, saturation: 0.17, lightness: 0.13 },
  screamer: { hue: 0.030, saturation: 0.13, lightness: 0.10 },
  brute:    { hue: 0.025, saturation: 0.11, lightness: 0.09 },
  titan:    { hue: 0.020, saturation: 0.09, lightness: 0.08 },
  spitter:  { hue: 0.035, saturation: 0.15, lightness: 0.12 },
  leaper:   { hue: 0.040, saturation: 0.16, lightness: 0.13 },
  // 重甲是制式装备，不该五颜六色——只留一点点金属色差
  armored:  { hue: 0.012, saturation: 0.06, lightness: 0.09 },
  midboss:  { hue: 0, saturation: 0, lightness: 0 },
  boss:     { hue: 0, saturation: 0, lightness: 0 },
};

/** 士兵：军装该统一，只留肤色和轻微磨损色的差异。抖动围绕纯白（无额外染色）展开。 */
export const SOLDIER_JITTER: JitterOptions = { hue: 0.4, saturation: 0.09, lightness: 0.07 };

/** 士兵 tint 的基准色——纯白，代表"不额外染色，就是几何体本身烘的军装色"。 */
export const WHITE = new THREE.Color(1, 1, 1);

const scratchHsl = { h: 0, s: 0, l: 0 };
const scratch = new THREE.Color();

/**
 * 围绕基础色做稳定抖动，返回一个**复用的**临时 `THREE.Color`。
 * 调用方要立刻把结果拷贝走（`CrowdBatch.add()` 就是把 r/g/b 直接写进
 * instanced buffer，不持有引用），不能跨帧保存这个返回值。
 *
 * 灰色/白色基底（饱和度接近 0）是个退化情况：HSL 的色相在那里没有意义，
 * 单纯抖动一个未定义的色相不会产生任何看得见的效果。所以饱和度很低时，
 * 改用 id 派生出的一个稳定"合成色相"来抖动——这样纯白的士兵军装也能带上
 * 一丝极轻的个体差异，而不是所有人像素级一致。
 */
export function jitterTint(base: THREE.Color, id: number, opts: JitterOptions = {}): THREE.Color {
  const hueAmt = opts.hue ?? 0.03;
  const satAmt = opts.saturation ?? 0.12;
  const lightAmt = opts.lightness ?? 0.1;
  if (hueAmt === 0 && satAmt === 0 && lightAmt === 0) return scratch.copy(base);

  base.getHSL(scratchHsl);
  const desaturated = scratchHsl.s < 0.04;
  const baseHue = desaturated ? hash(id, 0) : scratchHsl.h;
  const dh = (hash(id, 1) * 2 - 1) * hueAmt;
  const ds = (hash(id, 2) * 2 - 1) * satAmt + (desaturated ? satAmt * 0.55 : 0);
  const dl = (hash(id, 3) * 2 - 1) * lightAmt;

  scratch.setHSL(
    THREE.MathUtils.euclideanModulo(baseHue + dh, 1),
    THREE.MathUtils.clamp(scratchHsl.s + ds, 0, 1),
    THREE.MathUtils.clamp(scratchHsl.l + dl, 0.03, 0.97),
  );
  return scratch;
}
