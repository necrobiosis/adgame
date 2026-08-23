import * as THREE from 'three';
import { chamferBox, lathe, merge, paint, pipe, place, plate, sweep, type SweepSection } from '../geom/hardSurface';
import { bakeSurface, jitter, weldSmooth } from '../geom/deform';
import { BONE, assignSkin, buildSkeleton, pivots, type Skeleton } from './skeleton';
import { Rng } from '../../core/Rng';
import type { BossKind } from '../../config/balance';

/**
 * 角色几何体。
 *
 * 不再是盒子拼装：躯干和四肢都用变截面放样扫出来，截面从"圆角矩形"连续过渡到
 * "椭圆"，肩肘膝有真实的体积转折。所有暴露的硬边（护甲片、头盔、枪械、靴子）
 * 都带倒角。
 *
 * 结构上刻意让四肢的根部**埋进躯干内部**：胳膊抬起来时根部始终在胸腔里，
 * 不会露出接缝。这样就不需要一张拓扑连续的整体网格 —— 那玩意儿程序化生成
 * 极难做对，而埋进去的做法在平滑着色 + AO 下读起来是一体的。
 */

export interface BuildQuality {
  /** 截面的径向分段数。直接决定面数。 */
  radialSegments: number;
  /** 沿身体轴向的分段密度倍率。 */
  lengthDetail: number;
  /**
   * 配件细节档：0 = 只留大件，1 = 常规，2 = 全套。
   *
   * 身体本身的面数随 radialSegments 缩放，但护具、枪械、绑带这些小件是**固定
   * 成本**，一个圆角盒动辄几百个三角形。不按档砍它们的话，低画质档根本降不下来 ——
   * 实测低档角色仍有近三千面，配件占了七成。
   */
  accessory: 0 | 1 | 2;
}

export interface BodyPalette {
  skin: number;
  cloth: number;
  dark: number;
  accent: number;
  /** 露出的骨头 / 利爪。 */
  bone: number;
}

export interface HumanoidSpec {
  height: number;
  build: number;
  hunch: number;
  palette: BodyPalette;
  /** 手臂的静止前伸角度（僵尸伸手）。 */
  reach: number;
  helmet?: boolean;
  backpack?: boolean;
  /** 士兵武器外观：0 手枪 / 1 冲锋枪 / 2 突击步枪 / 3 轻机枪 / 4 加特林 / 5 等离子枪。 */
  weaponTier?: number;
  horns?: boolean;
  claws?: boolean;
  spikes?: boolean;
  /** 破损的衣料、外露的肋骨、不对称的伤口。 */
  decayed?: boolean;
  /**
   * 眼睛变体：'soldier' 正常巩膜+瞳孔，'zombie' 凹陷发暗的眼窝，
   * 'glow' 尖锐凸起、会被 CrowdMaterial 的裂纹发光按顶点凸度自动点亮
   * （精英/Boss 专用，复用现成机制，不需要新的着色器分支）。
   */
  eyes?: 'soldier' | 'zombie' | 'glow';
  /** 嘴部变体：'closed' 抿嘴，'open' 张开的嘴缝露牙，'fanged' 獠牙外露。 */
  mouth?: 'closed' | 'open' | 'fanged';
  /** 收窄下颌/颧骨，脸更凹陷憔悴——小型僵尸用来和"缩小版士兵"拉开区别。 */
  gaunt?: boolean;
  /**
   * 头部整体放大倍率。
   *
   * Boss 按正常人体比例长出来的头，在实际游戏视距下只有几个像素——五官画得
   * 再细也看不见。把头按怪物的比例放大（1.2~1.6），脸才成为剪影的一部分，
   * "每只 Boss 长得不一样"这件事才真的成立。
   */
  headScale?: number;
  /** 眼睛放大倍率。发光眼是 Boss 最先被看见的特征，通常要比人类比例大得多。 */
  eyeScale?: number;
  /** 眼睛排数：2 = 额头上再加一对更小的，读起来非人。 */
  eyeRows?: number;
  /** 下颌特征：獠牙 / 裂开的双瓣颚。 */
  jaw?: 'none' | 'tusks' | 'split';
  /**
   * 剪影档 —— 每只 Boss 的**身体**要不一样，不能只靠换头换色。
   *
   * 这一档同时改两件事：躯干放样曲线的胯/腰/肩比例，以及一整组大体积的
   * 附加结构（肩冠、脓包、脊椎、光环、背刃）。玩家在实际视距下先看到的
   * 是轮廓，五官是走近了才读得到的第二层信息。
   */
  silhouette?: 'brute' | 'bloat' | 'gaunt' | 'priest' | 'titan';
  /**
   * 士兵的装备档：0 轻装 / 1 制式 / 2 重装。
   *
   * 只换手上的枪是不够的——玩家升级之后想看到"我的部队变强了"，而不是
   * "我的枪管变长了"。装备档跟着武器等级走，肩甲、胸甲、面罩、护膝
   * 一档一档加上去，隔着老远看剪影就知道这支队伍到哪个阶段了。
   */
  gear?: 0 | 1 | 2;
  /** 随机种子，用来做个体差异。 */
  seed?: number;
}

interface Part {
  geo: THREE.BufferGeometry;
  /** 允许绑定的骨骼。限定候选集才不会出现"手垂在腿边被腿拽走"。 */
  bones: number[];
}

/** 沿一条骨线扫出一段肢体，截面按给定的粗细曲线变化。 */
function limb(
  from: THREE.Vector3,
  to: THREE.Vector3,
  radii: readonly { t: number; w: number; h: number; round?: number }[],
  q: BuildQuality,
  extend = 0,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(to, from).normalize();
  const sections: SweepSection[] = radii.map((r) => ({
    at: new THREE.Vector3().lerpVectors(from, to, r.t).addScaledVector(dir, -extend * (1 - r.t)),
    w: r.w,
    h: r.h,
    round: r.round ?? 0.65,
  }));
  return sweep(sections, q.radialSegments, true);
}

/**
 * 按质量档在控制截面之间插值。
 *
 * 刻意插得很保守：沿着一条笔直的肢体再加几圈截面，对剪影毫无帮助，纯粹是
 * 白花三角形 —— 决定肢体轮廓的是**截面曲线本身**。所以最高档也只在每段之间
 * 补一圈，用来软化肌肉起伏的转折。
 */
function densify(
  ctrl: readonly { t: number; w: number; h: number; round?: number }[],
  q: BuildQuality,
): { t: number; w: number; h: number; round?: number }[] {
  const extra = q.lengthDetail >= 0.95 ? 1 : 0;
  if (extra <= 0) return [...ctrl];
  const out: { t: number; w: number; h: number; round?: number }[] = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const a = ctrl[i]!;
    const b = ctrl[i + 1]!;
    out.push(a);
    for (let k = 1; k <= extra; k++) {
      const f = k / (extra + 1);
      out.push({
        t: THREE.MathUtils.lerp(a.t, b.t, f),
        w: THREE.MathUtils.lerp(a.w, b.w, f),
        h: THREE.MathUtils.lerp(a.h, b.h, f),
        round: THREE.MathUtils.lerp(a.round ?? 0.65, b.round ?? 0.65, f),
      });
    }
  }
  out.push(ctrl[ctrl.length - 1]!);
  return out;
}

/**
 * 剪影档 → 躯干的 [胯, 腰, 肩] 缩放。
 * 'none' 是人类比例，其余五档分别对应五只 Boss。
 */
const SIL_TORSO: Record<string, [number, number, number]> = {
  none: [1, 1, 1],
  brute: [0.92, 0.88, 1.34],   // 倒三角：肩比胯宽出一大截
  bloat: [1.22, 1.5, 0.9],     // 梨形：腰腹是全身最宽的地方
  gaunt: [0.82, 0.72, 0.94],   // 竹竿：整条躯干收细，肋骨顶出来
  priest: [0.84, 0.82, 1.04],  // 修长：几乎不收腰，重心很高
  titan: [1.04, 1.0, 1.16],    // 山：肩背铺得开，但不能宽到把头挤成一个点
};

export function buildHumanoid(spec: HumanoidSpec, q: BuildQuality): THREE.BufferGeometry {
  const H = spec.height;
  const B = spec.build;
  const p = spec.palette;
  const rng = new Rng(spec.seed ?? 7);
  const skel = buildSkeleton({ height: H, build: B, hunch: spec.hunch });
  const parts: Part[] = [];

  const add = (geo: THREE.BufferGeometry, color: number, bones: number[]) => {
    parts.push({ geo: paint(geo, color), bones });
  };
  /** 配件用的圆角盒：分段数随配件档走。 */
  const accBox = (w: number, h: number, d: number, r: number) => chamferBox(w, h, d, r);
  /** 次要配件在低档直接不生成。 */
  const minor = q.accessory >= 1;
  /**
   * 装备档。没显式给的按有没有头盔推：僵尸一律 0，士兵默认制式档。
   * 0 轻装（只有软帽和护目镜）/ 1 制式（肩甲、护膝、耳罩）/ 2 重装（面罩、
   * 胸板、大肩甲、腿甲、背后的气瓶）。
   */
  const gear = spec.gear ?? (spec.helmet ? 1 : 0);

  // ── 躯干 ────────────────────────────────────────────────────
  // 骨盆 → 胸腔 → 颈根。胸腔最宽，腰部收进去，颈根再收 —— 这条曲线是
  // "人形"读起来对不对的关键。
  const hip = skel[BONE.PELVIS]!.head;
  const neck = skel[BONE.HEAD]!.head;
  // 比例照真人来（以 1.8 米为基准）：肩宽 0.46、腰宽 0.32、胯宽 0.36。
  // 之前四肢比真人粗了将近一倍，整个人读起来是一团肉球。
  // 剪影档缩放胯/腰/肩三段。倒三角的暴君、梨形的脓包、竹竿似的长颈、
  // 修长的祭司、山一样的终末——躯干曲线本身就该把它们分开。
  const [kHip, kWaist, kSh] = SIL_TORSO[spec.silhouette ?? 'none']!;
  const torsoCtrl = densify([
    { t: -0.10, w: H * 0.100 * B * kHip, h: H * 0.062 * B * kHip, round: 0.62 },
    { t: 0.14, w: H * 0.092 * B * kHip, h: H * 0.057 * B * kHip, round: 0.66 },
    { t: 0.44, w: H * 0.089 * B * kWaist, h: H * 0.055 * B * kWaist, round: 0.62 },
    { t: 0.74, w: H * 0.118 * B * kSh, h: H * 0.066 * B * kSh, round: 0.5 },
    { t: 0.92, w: H * 0.128 * B * kSh, h: H * 0.068 * B * kSh, round: 0.45 },
    { t: 1.02, w: H * 0.088 * B, h: H * 0.058 * B, round: 0.62 },
    { t: 1.10, w: H * 0.036 * B, h: H * 0.036 * B, round: 0.95 },
  ], q);
  add(limb(hip, neck, torsoCtrl, q), p.cloth, [BONE.PELVIS, BONE.CHEST]);

  // ── 头 ──────────────────────────────────────────────────────
  const headTop = skel[BONE.HEAD]!.tail;
  // 憔悴：下颌+颧骨一起收窄，脸从"圆润"变"凹陷"——不改动脖子/颅顶，
  // 侧影读起来是同一个人瘦下去了，不是换了一颗头。
  const gauntK = spec.gaunt ? 0.82 : 1;
  // 头整体放大：脖子那一节保持原样，只把下颌以上撑开，
  // 否则脖子会跟着变粗、看起来像肿了一圈而不是"头大"
  const hs = spec.headScale ?? 1;
  const headCtrl = densify([
    { t: 0.02, w: H * 0.030, h: H * 0.030, round: 0.95 },  // 脖子
    { t: 0.22, w: H * 0.033 * (1 + (hs - 1) * 0.4), h: H * 0.033 * (1 + (hs - 1) * 0.4), round: 0.95 },
    { t: 0.42, w: H * 0.045 * gauntK * hs, h: H * 0.048 * gauntK * hs, round: 0.9 },   // 下颌
    { t: 0.66, w: H * 0.048 * gauntK * hs, h: H * 0.052 * gauntK * hs, round: 0.92 }, // 颧骨
    { t: 0.88, w: H * 0.045 * hs, h: H * 0.048 * hs, round: 1 },     // 颅顶
    { t: 1.0, w: H * 0.026 * hs, h: H * 0.03 * hs, round: 1 },
  ], q);
  add(limb(neck, headTop, headCtrl, q), p.skin, [BONE.HEAD, BONE.CHEST]);

  // 头部的解剖学地标，全部按"颈根到颅顶"这段长度取比例
  const headLen = headTop.y - neck.y;
  const chinY = neck.y + headLen * 0.30;
  const mouthY = neck.y + headLen * 0.40;
  const noseY = neck.y + headLen * 0.49;
  const eyeY = neck.y + headLen * 0.58;
  const browY = neck.y + headLen * 0.64;
  const faceZ = neck.z + headLen * 0.22 * (spec.headScale ?? 1);
  void chinY;

  // 鼻子：往前突出一小块，侧影才不是一颗光球
  add(place(accBox(H * 0.03 * hs, H * 0.024 * hs, H * 0.024 * hs, H * 0.01), {
    x: 0, y: noseY, z: faceZ,
  }), p.skin, [BONE.HEAD]);

  // ── 眼睛 ────────────────────────────────────────────────────
  const es = spec.eyeScale ?? 1;
  const eyeX = H * 0.021 * hs * (es > 1.6 ? 1.15 : 1);
  const eyesVariant = spec.eyes ?? 'zombie';
  if (eyesVariant === 'soldier') {
    for (const sx of [-1, 1] as const) {
      // 巩膜：嵌进眼窝的白色小方块
      add(place(accBox(H * 0.014, H * 0.009, H * 0.006, H * 0.003), {
        x: sx * eyeX, y: eyeY, z: faceZ + headLen * 0.015,
      }), 0xece4d4, [BONE.HEAD]);
      // 瞳孔：更暗更小，贴在巩膜前面一点
      add(place(accBox(H * 0.006, H * 0.006, H * 0.004, H * 0.002), {
        x: sx * eyeX, y: eyeY, z: faceZ + headLen * 0.03,
      }), 0x1c1712, [BONE.HEAD]);
    }
  } else {
    // 'zombie' / 'glow'：眼睛做成一个尖锐的小凸起，而不是挖一个凹坑——
    // 凹坑在这套"放样+平滑法线"的管线里很难看清楚，凸起涂暗色照样读作
    // "眼窝里的窟窿"，涂骨色还会被 CrowdMaterial 按顶点凸度点亮的裂纹
    // 发光自动选中（复用现成机制，不用为"发光眼"另开一条着色器分支）。
    const eyeColor = eyesVariant === 'glow' ? p.bone : 0x0c0a08;
    for (const sx of [-1, 1] as const) {
      add(place(lathe([
        [H * 0.013 * es, 0], [H * 0.009 * es, H * 0.018 * es], [0.0005, H * 0.034 * es],
      ], Math.max(5, Math.round(q.radialSegments * 0.5))), {
        x: sx * eyeX, y: eyeY, z: faceZ + headLen * 0.03 * hs, rx: -1.15,
      }), eyeColor, [BONE.HEAD]);
    }
    // 第二排眼睛：额头上再来一对更小的，一眼读出"这不是人"
    if ((spec.eyeRows ?? 1) >= 2) {
      for (const sx of [-1, 1] as const) {
        add(place(lathe([
          [H * 0.006 * es, 0], [H * 0.004 * es, H * 0.008 * es], [0.0004, H * 0.016 * es],
        ], Math.max(5, Math.round(q.radialSegments * 0.5))), {
          x: sx * eyeX * 1.75, y: browY + headLen * 0.06, z: faceZ + headLen * 0.02 * hs, rx: -1.0,
        }), eyeColor, [BONE.HEAD]);
      }
    }
  }

  // ── 眉骨 ────────────────────────────────────────────────────
  if (minor) {
    add(place(accBox(H * 0.05 * hs, H * 0.01 * hs, H * 0.014, H * 0.004), {
      x: 0, y: browY, z: faceZ + headLen * 0.02 * hs, rx: -0.15,
    }), p.dark, [BONE.HEAD]);
  }

  // ── 下颌特征 ────────────────────────────────────────────────
  const jaw = spec.jaw ?? 'none';
  if (jaw === 'tusks') {
    // 从下颌两侧往上翘的一对獠牙
    for (const sx of [-1, 1] as const) {
      add(place(lathe([
        [H * 0.011 * hs, 0], [H * 0.008 * hs, H * 0.03], [0.0005, H * 0.07 * hs],
      ], Math.max(5, Math.round(q.radialSegments * 0.5))), {
        x: sx * H * 0.03 * hs, y: mouthY - headLen * 0.04, z: faceZ,
        rz: sx * 0.28, rx: -0.35,
      }), p.bone, [BONE.HEAD]);
    }
  } else if (jaw === 'split') {
    // 裂成两瓣的下颚，中间张开一道竖缝——喷吐类 Boss 的招牌
    for (const sx of [-1, 1] as const) {
      add(place(accBox(H * 0.022 * hs, H * 0.05 * hs, H * 0.03 * hs, H * 0.006), {
        x: sx * H * 0.022 * hs, y: mouthY - headLen * 0.06, z: faceZ - headLen * 0.02,
        rz: sx * 0.34,
      }), p.skin, [BONE.HEAD]);
      // 每瓣内侧一排牙
      for (let i = 0; i < 3; i++) {
        add(place(lathe([[H * 0.006 * hs, 0], [0.0004, H * 0.022 * hs]], 5), {
          x: sx * (H * 0.014 * hs + i * H * 0.011 * hs),
          y: mouthY - headLen * 0.02, z: faceZ + headLen * 0.01,
          rx: Math.PI * 0.92, rz: sx * 0.2,
        }), p.bone, [BONE.HEAD]);
      }
    }
  }

  // ── 嘴 ──────────────────────────────────────────────────────
  const mouthVariant = spec.mouth ?? 'closed';
  if (mouthVariant === 'fanged') {
    // 嘴裂：一条扁的暗色缝
    add(place(accBox(H * 0.046, H * 0.014, H * 0.024, H * 0.006), {
      x: 0, y: mouthY, z: faceZ,
    }), 0x140b0a, [BONE.HEAD]);
    // 獠牙：上颚两颗，尖端朝下
    for (const sx of [-1, 1] as const) {
      add(place(lathe([[H * 0.008, 0], [H * 0.005, H * 0.012], [0.0004, H * 0.026]], 5), {
        x: sx * H * 0.016, y: mouthY + H * 0.008, z: faceZ + headLen * 0.008, rx: Math.PI,
      }), p.bone, [BONE.HEAD]);
    }
  } else if (mouthVariant === 'open') {
    // 张开的嘴缝，露出参差的牙——僵尸的标志性表情
    add(place(accBox(H * 0.05, H * 0.02, H * 0.026, H * 0.008), {
      x: 0, y: mouthY - H * 0.006, z: faceZ,
    }), 0x1a100d, [BONE.HEAD]);
    for (let i = -1; i <= 1; i++) {
      add(place(chamferBox(H * 0.009, H * 0.008, H * 0.006, H * 0.002), {
        x: i * H * 0.014, y: mouthY + H * 0.004, z: faceZ + headLen * 0.006,
      }), p.bone, [BONE.HEAD]);
    }
  } else {
    // 抿嘴：一小块凸起，士兵用这个显得正常
    add(place(accBox(H * 0.042, H * 0.014, H * 0.024, H * 0.01), {
      x: 0, y: mouthY, z: faceZ,
    }), p.skin, [BONE.HEAD]);
  }

  // ── 四肢 ────────────────────────────────────────────────────
  const armCtrl = densify([
    // 起点埋进胸腔里，抬手时根部不会露缝
    { t: -0.30, w: H * 0.040 * B, h: H * 0.040 * B, round: 0.95 },
    { t: -0.05, w: H * 0.034 * B, h: H * 0.034 * B, round: 0.95 },  // 三角肌
    { t: 0.35, w: H * 0.028 * B, h: H * 0.028 * B, round: 0.9 },
    { t: 0.78, w: H * 0.024 * B, h: H * 0.025 * B, round: 0.85 },
    { t: 1.05, w: H * 0.023 * B, h: H * 0.024 * B, round: 0.85 },   // 肘
  ], q);
  const foreCtrl = densify([
    { t: -0.10, w: H * 0.024 * B, h: H * 0.025 * B, round: 0.85 },
    { t: 0.28, w: H * 0.023 * B, h: H * 0.024 * B, round: 0.85 },
    { t: 0.72, w: H * 0.018 * B, h: H * 0.019 * B, round: 0.9 },
    { t: 1.0, w: H * 0.016 * B, h: H * 0.017 * B, round: 0.9 },
  ], q);
  const thighCtrl = densify([
    { t: -0.16, w: H * 0.052 * B, h: H * 0.053 * B, round: 0.8 },
    { t: 0.25, w: H * 0.045 * B, h: H * 0.047 * B, round: 0.75 },
    { t: 0.70, w: H * 0.036 * B, h: H * 0.038 * B, round: 0.75 },
    { t: 1.04, w: H * 0.031 * B, h: H * 0.033 * B, round: 0.8 },    // 膝
  ], q);
  const shinCtrl = densify([
    { t: -0.06, w: H * 0.030 * B, h: H * 0.032 * B, round: 0.8 },
    { t: 0.28, w: H * 0.031 * B, h: H * 0.034 * B, round: 0.75 },   // 小腿肚
    { t: 0.70, w: H * 0.022 * B, h: H * 0.024 * B, round: 0.8 },
    { t: 1.0, w: H * 0.018 * B, h: H * 0.021 * B, round: 0.85 },    // 踝
  ], q);

  for (const side of [-1, 1] as const) {
    const armB = side < 0 ? BONE.ARM_L : BONE.ARM_R;
    const foreB = side < 0 ? BONE.FORE_L : BONE.FORE_R;
    const thighB = side < 0 ? BONE.THIGH_L : BONE.THIGH_R;
    const shinB = side < 0 ? BONE.SHIN_L : BONE.SHIN_R;

    // 个体差异：左右不完全对称，一群人站一起才不像复制粘贴
    const asym = spec.decayed ? rng.range(0.92, 1.08) : rng.range(0.98, 1.02);

    const shoulder = skel[armB]!.head;
    const elbow = skel[armB]!.tail;
    const wrist = skel[foreB]!.tail;
    add(limb(shoulder, elbow, armCtrl.map((c) => ({ ...c, w: c.w * asym, h: c.h * asym })), q), p.cloth, [armB, BONE.CHEST]);
    add(limb(elbow, wrist, foreCtrl, q), spec.decayed ? p.skin : p.cloth, [foreB, armB]);
    // 手
    add(place(accBox(H * 0.032 * B, H * 0.042 * B, H * 0.028 * B, H * 0.011), {
      x: wrist.x, y: wrist.y - H * 0.018, z: wrist.z,
    }), p.skin, [foreB]);

    // 肩甲：让肩部有真正的转折，而不是一根圆管直接插进躯干。
    // 重装档整块放大，肩线直接把剪影撑宽——远看就知道这队升过级
    if (gear >= 1) {
      const sg = gear >= 2 ? 1.34 : 1;
      add(place(lathe([
        [H * 0.001, 0], [H * 0.036 * B * sg, H * 0.006], [H * 0.049 * B * sg, H * 0.022],
        [H * 0.050 * B * sg, H * 0.044 * sg], [H * 0.044 * B * sg, H * 0.062 * sg], [H * 0.030 * B * sg, H * 0.07 * sg],
      ], Math.max(8, q.radialSegments)), {
        x: shoulder.x * 1.02, y: shoulder.y + H * 0.03, z: shoulder.z,
        rz: side * 0.3, s: [1, -1, 1],
      }), p.accent, [armB, BONE.CHEST]);
      // 重装：肩甲上再钉一层加强板，边缘用暗色勾出来
      if (gear >= 2 && minor) {
        add(place(plate(H * 0.052 * B, H * 0.03, H * 0.012, { corner: H * 0.01 }), {
          x: shoulder.x * 1.16, y: shoulder.y + H * 0.052, z: shoulder.z,
          rz: side * 0.44,
        }), p.dark, [armB, BONE.CHEST]);
      }
      // 重装：护臂
      if (gear >= 2) {
        add(place(accBox(H * 0.038 * B, H * 0.056, H * 0.04, H * 0.01), {
          x: (elbow.x + wrist.x) / 2, y: (elbow.y + wrist.y) / 2, z: (elbow.z + wrist.z) / 2,
        }), p.dark, [foreB, armB]);
      }
    }

    if (spec.claws) {
      for (let c = 0; c < (q.accessory >= 2 ? 3 : 2); c++) {
        const cx = wrist.x + (c - 1) * H * 0.018 * B;
        add(place(lathe([[H * 0.009 * B, 0], [H * 0.006 * B, H * 0.03], [0.0005, H * 0.058]], 5), {
          x: cx, y: wrist.y - H * 0.05, z: wrist.z + H * 0.012, rx: 0.5,
        }), p.bone, [foreB]);
      }
    }

    const hipJ = skel[thighB]!.head;
    const knee = skel[thighB]!.tail;
    const ankle = skel[shinB]!.tail;
    add(limb(hipJ, knee, thighCtrl, q), p.dark, [thighB, BONE.PELVIS]);
    add(limb(knee, ankle, shinCtrl, q), p.dark, [shinB, thighB]);
    // 靴子：带倒角的方块 + 一点鞋头的圆润
    add(place(accBox(H * 0.046 * B, H * 0.038, H * 0.085, H * 0.014), {
      x: ankle.x, y: H * 0.02, z: ankle.z + H * 0.016,
    }), 0x24262b, [shinB]);
    if (gear >= 1 && minor) {
      // 护膝
      add(place(accBox(H * 0.042 * B, H * 0.044, H * 0.03, H * 0.012), {
        x: knee.x, y: knee.y + H * 0.008, z: knee.z + H * 0.028 * B,
      }), p.dark, [thighB, shinB]);
    }
    if (gear >= 2) {
      // 重装：大腿外侧的挂甲，走路时跟着大腿摆，剪影下半身也变宽
      add(place(plate(H * 0.05 * B, H * 0.11, H * 0.014, { corner: H * 0.014 }), {
        x: hipJ.x * 1.12, y: (hipJ.y + knee.y) / 2, z: hipJ.z + H * 0.028 * B, rz: side * 0.12,
      }), p.accent, [thighB, BONE.PELVIS]);
    }
  }

  // ── 装备与特征 ──────────────────────────────────────────────
  const chest = skel[BONE.CHEST]!;

  if (spec.helmet) {
    // 盔壳用放样做出前低后高的形状，再压一条帽檐
    // 盔壳用车削件：轮廓自己控制，收口是圆的而不是尖的。
    // 从眉骨往上罩住整个颅顶，脸留在外面。
    const seg = Math.max(8, Math.round(q.radialSegments * 1.2));
    // 重装档的盔壳更高更厚，罩得更下来
    const helmH = headLen * (gear >= 2 ? 0.78 : gear >= 1 ? 0.62 : 0.5);
    add(place(lathe([
      [H * 0.053, 0], [H * 0.057, helmH * 0.1], [H * 0.056, helmH * 0.36],
      [H * 0.050, helmH * 0.6], [H * 0.038, helmH * 0.84], [H * 0.02, helmH * 0.97], [0.0006, helmH],
    ], seg), { x: 0, y: browY, z: neck.z + headLen * 0.02 }), p.accent, [BONE.HEAD]);
    // 帽檐
    add(place(plate(H * 0.096, H * 0.034, H * 0.008, { corner: H * 0.013 }), {
      x: 0, y: browY + headLen * 0.04, z: faceZ + headLen * 0.09, rx: -0.5,
    }), p.accent, [BONE.HEAD]);
    // 耳罩：制式档才有
    if (minor && gear >= 1) {
      for (const sx of [-1, 1]) {
        add(place(accBox(H * 0.013, H * 0.04, H * 0.036, H * 0.005), {
          x: sx * H * 0.05, y: eyeY, z: neck.z,
        }), p.dark, [BONE.HEAD]);
      }
    }
    // 夜视仪基座 —— 剪影上的一个识别点，重装档专属
    if (minor && gear >= 2) {
      add(place(chamferBox(H * 0.024, H * 0.018, H * 0.016, H * 0.004), {
        x: 0, y: browY + headLen * 0.16, z: faceZ + headLen * 0.06,
      }), p.dark, [BONE.HEAD]);
    }
    if (gear >= 2) {
      // 重装：整块下拉的面罩，只在眼位留一条发光的视窗。
      // 这是三档里最强的一个识别点——脸没了，剩一条冷光缝
      add(place(plate(H * 0.088, H * 0.072, H * 0.014, { corner: H * 0.02 }), {
        x: 0, y: eyeY - headLen * 0.02, z: faceZ + headLen * 0.03, rx: 0.1,
      }), p.dark, [BONE.HEAD]);
      add(place(accBox(H * 0.062, H * 0.014, H * 0.01, H * 0.004), {
        x: 0, y: eyeY + headLen * 0.01, z: faceZ + headLen * 0.06,
      }), 0x7fe3ff, [BONE.HEAD]);
      // 面罩两侧的呼吸滤罐
      if (minor) for (const sx of [-1, 1]) {
        add(place(lathe([[0.0005, 0], [H * 0.014, H * 0.005], [H * 0.014, H * 0.03], [0.0005, H * 0.034]], 8), {
          x: sx * H * 0.042, y: eyeY - headLen * 0.12, z: faceZ, rz: Math.PI / 2,
        }), 0x22262c, [BONE.HEAD]);
      }
    } else {
      // 护目镜：推到额头上的一条暗带，脸立刻有了焦点，又不会挡住眼睛下面
      // 新加的五官——士兵也要看得出五官，不能被一条黑杠糊住脸
      add(place(accBox(H * 0.084, H * 0.02, H * 0.018, H * 0.007), {
        x: 0, y: browY, z: faceZ - headLen * 0.02,
      }), 0x14171d, [BONE.HEAD]);
    }
    // 下巴带
    add(place(pipe([
      new THREE.Vector3(-H * 0.046, neck.y + H * 0.2, neck.z),
      new THREE.Vector3(-H * 0.036, neck.y + H * 0.115, neck.z + H * 0.022),
      new THREE.Vector3(H * 0.036, neck.y + H * 0.115, neck.z + H * 0.022),
      new THREE.Vector3(H * 0.046, neck.y + H * 0.2, neck.z),
    ], H * 0.005, 5), {}), p.dark, [BONE.HEAD]);
  }

  if (spec.backpack) {
    const bz = chest.head.z - H * 0.075 * B;
    add(place(accBox(H * 0.13 * B, H * 0.15, H * 0.07, H * 0.022), {
      x: 0, y: chest.head.y + H * 0.05, z: bz,
    }), p.accent, [BONE.CHEST]);
    // 卷起来的睡袋 + 背带
    if (minor) add(place(lathe([[H * 0.026, 0], [H * 0.03, H * 0.02], [H * 0.03, H * 0.1], [H * 0.026, H * 0.12]], 8), {
      x: 0, y: chest.head.y + H * 0.055, z: bz - H * 0.05, rz: Math.PI / 2,
    }), p.dark, [BONE.CHEST]);
    if (minor) for (const sx of [-1, 1]) {
      add(place(pipe([
        new THREE.Vector3(sx * H * 0.05, chest.head.y + H * 0.11, bz + H * 0.03),
        new THREE.Vector3(sx * H * 0.06, chest.head.y + H * 0.06, chest.head.z + H * 0.05),
        new THREE.Vector3(sx * H * 0.045, chest.head.y - H * 0.02, chest.head.z + H * 0.05),
      ], H * 0.008, 5), {}), p.dark, [BONE.CHEST]);
    }
    // 胸挂：弹匣包，明显凸出于胸甲之外
    for (let i = 0; i < (q.accessory >= 2 ? 3 : 1); i++) {
      add(place(accBox(H * 0.032 * B, H * 0.05, H * 0.026, H * 0.008), {
        x: (i - 1) * H * 0.036 * B,
        y: chest.head.y + H * 0.022,
        z: chest.head.z + H * 0.062 * B,
        rx: 0.06,
      }), p.dark, [BONE.CHEST]);
    }
    // 胸甲本体：重装档换成一整块带脊线的厚板，颜色也从布色转成金属色
    add(place(plate(
      H * (gear >= 2 ? 0.152 : 0.13) * B,
      H * (gear >= 2 ? 0.155 : 0.13),
      H * (gear >= 2 ? 0.026 : 0.016),
      { corner: H * 0.026 },
    ), {
      x: 0, y: chest.head.y + H * 0.055, z: chest.head.z + H * 0.056 * B, rx: 0.08,
    }), gear >= 2 ? p.accent : p.cloth, [BONE.CHEST]);
    if (gear >= 2) {
      // 胸口正中的加强脊，配上背后的两只气瓶——重装档的正反两面
      add(place(chamferBox(H * 0.022, H * 0.13, H * 0.018, H * 0.006), {
        x: 0, y: chest.head.y + H * 0.055, z: chest.head.z + H * 0.076 * B, rx: 0.08,
      }), p.dark, [BONE.CHEST]);
      if (minor) for (const sx of [-1, 1]) {
        add(place(lathe([
          [0.0005, 0], [H * 0.026, H * 0.008], [H * 0.026, H * 0.14], [0.0005, H * 0.15],
        ], 9), { x: sx * H * 0.05 * B, y: chest.head.y - H * 0.02, z: bz - H * 0.03 }), 0x4a5560, [BONE.CHEST]);
      }
    }
  }

  if (spec.weaponTier !== undefined) {
    // 武器挂在右前臂上，跟着手一起摆。机匣是所有等级共用的基座，
    // 六个等级的差异全部体现在枪管/弹匣/枪托这些看一眼就能分的部件上——
    // 而不是只换曳光弹颜色。
    const wrist = skel[BONE.FORE_R]!.tail;
    const gx = wrist.x - H * 0.012;
    const gy = wrist.y - H * 0.01;
    const gz = wrist.z + H * 0.02;
    const tier = spec.weaponTier;
    // 机匣随等级变粗：越往上枪越是"扛"着而不是"端"着
    const bulk = 1 + tier * 0.22;
    add(place(accBox(H * 0.026 * bulk, H * 0.04 * bulk, H * 0.13 * bulk, H * 0.007), {
      x: gx, y: gy, z: gz + H * 0.02,
    }), 0x2b2f36, [BONE.FORE_R]);
    const addStock = () => add(place(accBox(H * 0.024 * bulk, H * 0.05 * bulk, H * 0.09, H * 0.012), {
      x: gx, y: gy - H * 0.004, z: gz - H * 0.075,
    }), 0x353a42, [BONE.FORE_R]);
    const addSight = () => {
      if (minor) add(place(chamferBox(H * 0.014, H * 0.018 * bulk, H * 0.05, H * 0.005), {
        x: gx, y: gy + H * 0.032 * bulk, z: gz + H * 0.02,
      }), 0x22262c, [BONE.FORE_R]);
    };

    if (tier === 0) {
      // 手枪：短小一截，没有枪托
      add(place(lathe([
        [H * 0.009, 0], [H * 0.009, H * 0.05], [H * 0.006, H * 0.052], [0.0004, H * 0.062],
      ], 8), { x: gx, y: gy + H * 0.008, z: gz + H * 0.09, rx: Math.PI / 2 }), 0x3a4049, [BONE.FORE_R]);
      add(place(chamferBox(H * 0.014, H * 0.05, H * 0.022, H * 0.005), { x: gx, y: gy - H * 0.03, z: gz + H * 0.03, rx: 0.3 }), 0x2b2f36, [BONE.FORE_R]);
    } else if (tier === 1) {
      // 霰弹枪：并排两根粗短的枪管 + 一截泵动前护木。
      // 剪影上比手枪宽一倍，"这把打散弹"一眼就看得出来
      for (const sx of [-1, 1] as const) {
        add(place(lathe([
          [H * 0.014, 0], [H * 0.014, H * 0.115], [H * 0.017, H * 0.12], [H * 0.016, H * 0.128], [0.0005, H * 0.132],
        ], 8), { x: gx + sx * H * 0.014, y: gy + H * 0.012, z: gz + H * 0.09, rx: Math.PI / 2 }), 0x3a4049, [BONE.FORE_R]);
      }
      // 泵动前护木
      add(place(accBox(H * 0.042, H * 0.026, H * 0.06, H * 0.008), {
        x: gx, y: gy - H * 0.014, z: gz + H * 0.11,
      }), 0x5a4630, [BONE.FORE_R]);
      // 木质枪托：比制式枪托更厚更斜
      add(place(accBox(H * 0.026, H * 0.056, H * 0.1, H * 0.014), {
        x: gx, y: gy - H * 0.014, z: gz - H * 0.08, rx: -0.1,
      }), 0x5a4630, [BONE.FORE_R]);
      if (minor) add(place(chamferBox(H * 0.016, H * 0.046, H * 0.024, H * 0.005), {
        x: gx, y: gy - H * 0.038, z: gz + H * 0.01, rx: 0.25,
      }), 0x2b2f36, [BONE.FORE_R]);
    } else if (tier === 2) {
      // 冲锋枪：短枪管 + 一根斜出去的折叠托
      add(place(lathe([
        [H * 0.01, 0], [H * 0.01, H * 0.07], [H * 0.007, H * 0.073], [0.0004, H * 0.09],
      ], 8), { x: gx, y: gy + H * 0.01, z: gz + H * 0.1, rx: Math.PI / 2 }), 0x3a4049, [BONE.FORE_R]);
      add(place(chamferBox(H * 0.015, H * 0.06, H * 0.026, H * 0.006), { x: gx, y: gy - H * 0.04, z: gz + H * 0.01, rx: 0.22 }), 0x2b2f36, [BONE.FORE_R]);
      add(place(pipe([
        new THREE.Vector3(gx, gy, gz - H * 0.02),
        new THREE.Vector3(gx, gy - H * 0.022, gz - H * 0.058),
      ], H * 0.006, 5), {}), 0x353a42, [BONE.FORE_R]);
    } else if (tier === 4) {
      // 轻机枪：加长枪管 + 大弹鼓 + 提把 + 两脚架，明显比步枪"重"了一档
      add(place(lathe([
        [H * 0.015, 0], [H * 0.015, H * 0.19], [H * 0.011, H * 0.196],
        [H * 0.011, H * 0.26], [H * 0.019, H * 0.268], [0.0005, H * 0.28],
      ], 9), { x: gx, y: gy + H * 0.012, z: gz + H * 0.13, rx: Math.PI / 2 }), 0x3a4049, [BONE.FORE_R]);
      // 弹鼓
      add(place(lathe([
        [0.0005, 0], [H * 0.046, H * 0.008], [H * 0.046, H * 0.062], [0.0005, H * 0.07],
      ], 12), { x: gx, y: gy - H * 0.058, z: gz + H * 0.01, rz: Math.PI / 2 }), 0x2b2f36, [BONE.FORE_R]);
      // 提把
      if (minor) add(place(pipe([
        new THREE.Vector3(gx, gy + H * 0.042, gz + H * 0.02),
        new THREE.Vector3(gx, gy + H * 0.056, gz + H * 0.06),
        new THREE.Vector3(gx, gy + H * 0.042, gz + H * 0.1),
      ], H * 0.006, 5), {}), 0x22262c, [BONE.FORE_R]);
      addStock();
      addSight();
      if (minor) for (const sx of [-1, 1] as const) {
        add(place(pipe([
          new THREE.Vector3(gx, gy - H * 0.01, gz + H * 0.24),
          new THREE.Vector3(gx + sx * H * 0.04, gy - H * 0.07, gz + H * 0.27),
        ], H * 0.005, 4), {}), 0x22262c, [BONE.FORE_R]);
      }
    } else if (tier === 5) {
      // 加特林：六根枪管 + 旋转机头 + 背后的弹箱和供弹带。
      // 到这一档，枪的体积已经接近半个人——一眼就知道升级到位了。
      const n = 6;
      const R = H * 0.026;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        add(place(lathe([[H * 0.006, 0], [H * 0.006, H * 0.26], [0.0003, H * 0.268]], 6), {
          x: gx + Math.cos(a) * R, y: gy + Math.sin(a) * R + H * 0.012, z: gz + H * 0.12, rx: Math.PI / 2,
        }), 0x3a4049, [BONE.FORE_R]);
      }
      // 枪管束前后的固定盘
      for (const zz of [H * 0.12, H * 0.34]) {
        add(place(lathe([[0.0005, 0], [R * 1.25, 0], [R * 1.25, H * 0.014], [0.0005, H * 0.014]], 12), {
          x: gx, y: gy + H * 0.012, z: gz + zz, rx: Math.PI / 2,
        }), 0x22262c, [BONE.FORE_R]);
      }
      // 旋转机头
      add(place(lathe([[H * 0.034, 0], [H * 0.034, H * 0.07], [H * 0.026, H * 0.078]], 10), {
        x: gx, y: gy + H * 0.012, z: gz + H * 0.03, rx: Math.PI / 2,
      }), 0x2b2f36, [BONE.FORE_R]);
      // 弹箱 + 供弹带
      add(place(accBox(H * 0.05, H * 0.058, H * 0.07, H * 0.008), {
        x: gx - H * 0.05, y: gy - H * 0.03, z: gz - H * 0.02,
      }), 0x353a42, [BONE.FORE_R]);
      if (minor) add(place(pipe([
        new THREE.Vector3(gx - H * 0.04, gy - H * 0.012, gz + H * 0.0),
        new THREE.Vector3(gx - H * 0.02, gy - H * 0.004, gz + H * 0.02),
        new THREE.Vector3(gx, gy + H * 0.004, gz + H * 0.03),
      ], H * 0.008, 5), {}), 0x8a6a2a, [BONE.FORE_R]);
      addStock();
    } else if (tier === 6) {
      // 电磁炮：两根平行的导轨 + 中间一条外露的能量槽 + 尾部的电容组。
      // 没有枪管，只有加速段——形状本身就在说"这不是火药武器"
      for (const sx of [-1, 1] as const) {
        add(place(chamferBox(H * 0.014, H * 0.03, H * 0.34, H * 0.005), {
          x: gx + sx * H * 0.026, y: gy + H * 0.018, z: gz + H * 0.13,
        }), 0x2b2f36, [BONE.FORE_R]);
      }
      // 导轨之间的能量槽（发光色，会被裂纹发光挑出来）
      add(place(chamferBox(H * 0.016, H * 0.012, H * 0.3, H * 0.004), {
        x: gx, y: gy + H * 0.018, z: gz + H * 0.13,
      }), 0x9fd8ff, [BONE.FORE_R]);
      // 加速环：四道，间距均匀，越靠前越大
      for (let i = 0; i < 4; i++) {
        const rr = H * (0.034 + i * 0.004);
        add(place(lathe([[rr, 0], [rr * 1.2, H * 0.005], [rr * 1.2, H * 0.018], [rr, H * 0.023]], 10), {
          x: gx, y: gy + H * 0.018, z: gz + H * (0.06 + i * 0.075), rx: Math.PI / 2,
        }), 0x22262c, [BONE.FORE_R]);
      }
      // 尾部电容组：三个圆柱并排
      for (let i = -1; i <= 1; i++) {
        add(place(lathe([[0.0005, 0], [H * 0.018, H * 0.006], [H * 0.018, H * 0.072], [0.0005, H * 0.078]], 9), {
          x: gx + i * H * 0.02, y: gy - H * 0.004, z: gz - H * 0.09, rx: Math.PI / 2,
        }), 0x353a42, [BONE.FORE_R]);
      }
      add(place(chamferBox(H * 0.022, H * 0.07, H * 0.032, H * 0.008), {
        x: gx, y: gy - H * 0.05, z: gz + H * 0.01, rx: 0.18,
      }), 0x2b2f36, [BONE.FORE_R]);
      addSight();
    } else if (tier === 7) {
      // 湮灭者：整把枪已经不像枪了——上下两根能量管、三圈线圈、
      // 尾部的能量核心、喇叭口的炮口。终极武器就该夸张到离谱。
      add(place(lathe([
        [H * 0.022, 0], [H * 0.022, H * 0.2], [H * 0.03, H * 0.21],
        [H * 0.024, H * 0.24], [H * 0.05, H * 0.3], [H * 0.046, H * 0.32], [0.0006, H * 0.328],
      ], 10), { x: gx, y: gy + H * 0.014, z: gz + H * 0.1, rx: Math.PI / 2 }), 0xc9a8ff, [BONE.FORE_R]);
      // 线圈：三圈，越往前越大
      for (let i = 0; i < 3; i++) {
        const zz = H * (0.14 + i * 0.07);
        const rr = H * (0.03 + i * 0.005);
        add(place(lathe([[rr, 0], [rr * 1.28, H * 0.006], [rr * 1.28, H * 0.02], [rr, H * 0.026]], 10), {
          x: gx, y: gy + H * 0.014, z: gz + zz, rx: Math.PI / 2,
        }), 0x2b2f36, [BONE.FORE_R]);
      }
      // 尾部能量核心
      add(place(lathe([
        [0.0005, 0], [H * 0.036, H * 0.012], [H * 0.04, H * 0.045], [H * 0.03, H * 0.07], [0.0005, H * 0.078],
      ], 10), { x: gx, y: gy + H * 0.006, z: gz - H * 0.05, rx: Math.PI / 2 }), 0xc9a8ff, [BONE.FORE_R]);
      // 散热片
      if (minor) for (const sx of [-1, 1] as const) {
        add(place(chamferBox(H * 0.008, H * 0.05, H * 0.09, H * 0.004), {
          x: gx + sx * H * 0.03, y: gy + H * 0.03, z: gz + H * 0.06, rz: sx * 0.2,
        }), 0x22262c, [BONE.FORE_R]);
      }
      add(place(chamferBox(H * 0.024, H * 0.075, H * 0.034, H * 0.008), { x: gx, y: gy - H * 0.055, z: gz + H * 0.01, rx: 0.15 }), 0x2b2f36, [BONE.FORE_R]);
      addStock();
      addSight();
      // 副管：坐在主管下方，卖出"一次打两发"这件事
      add(place(lathe([
        [H * 0.014, 0], [H * 0.014, H * 0.17], [H * 0.02, H * 0.185], [0.0006, H * 0.192],
      ], 9), { x: gx, y: gy - H * 0.03, z: gz + H * 0.1, rx: Math.PI / 2 }), 0xc9a8ff, [BONE.FORE_R]);
    } else {
      // tier 3（突击步枪）——居中的默认档
      add(place(lathe([
        [H * 0.011, 0], [H * 0.011, H * 0.11], [H * 0.008, H * 0.115],
        [H * 0.008, H * 0.17], [H * 0.014, H * 0.175], [H * 0.013, H * 0.2], [0.0005, H * 0.202],
      ], 8), { x: gx, y: gy + H * 0.012, z: gz + H * 0.11, rx: Math.PI / 2 }), 0x3a4049, [BONE.FORE_R]);
      add(place(chamferBox(H * 0.016, H * 0.07, H * 0.03, H * 0.006), { x: gx, y: gy - H * 0.05, z: gz + H * 0.01, rx: 0.22 }), 0x2b2f36, [BONE.FORE_R]);
      addStock();
      addSight();
    }
  }

  if (spec.horns) {
    for (const sx of [-1, 1]) {
      add(place(lathe([
        [H * 0.016 * B, 0], [H * 0.013 * B, H * 0.03], [H * 0.008 * B, H * 0.075], [0.0008, H * 0.11],
      ], 6), {
        x: sx * H * 0.045 * B, y: headTop.y - H * 0.03, z: headTop.z - H * 0.01,
        rz: sx * 0.55, rx: -0.3,
      }), p.bone, [BONE.HEAD]);
    }
  }

  if (spec.spikes && minor) {
    // 背刺：大小不一、间距不均，刻意不做成整齐的一排
    const n = 4;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const scale = 0.7 + rng.next() * 0.6;
      add(place(lathe([
        [H * 0.014 * B * scale, 0], [H * 0.01 * B * scale, H * 0.03], [0.0008, H * 0.085 * scale],
      ], 5), {
        x: rng.range(-1, 1) * H * 0.02 * B,
        y: chest.head.y + H * (0.02 + t * 0.11),
        z: chest.head.z - H * 0.075 * B,
        rx: -1.1 + rng.range(-0.2, 0.2),
      }), p.dark, [BONE.CHEST]);
    }
  }

  if (spec.decayed && minor) {
    // 外露的肋骨 —— 只在一侧，制造不对称
    const side = rng.next() < 0.5 ? -1 : 1;
    for (let i = 0; i < 3; i++) {
      add(place(pipe([
        new THREE.Vector3(side * H * 0.01, chest.head.y + H * (0.02 + i * 0.028), chest.head.z + H * 0.07 * B),
        new THREE.Vector3(side * H * 0.055 * B, chest.head.y + H * (0.028 + i * 0.028), chest.head.z + H * 0.05 * B),
        new THREE.Vector3(side * H * 0.07 * B, chest.head.y + H * (0.02 + i * 0.028), chest.head.z),
      ], H * 0.006, 4), {}), p.bone, [BONE.CHEST]);
    }
    // 破烂的衣摆
    for (let i = 0; i < 4; i++) {
      const a = rng.range(0, Math.PI * 2);
      add(place(plate(H * 0.05, H * 0.09, H * 0.006, { corner: H * 0.01 }), {
        x: Math.cos(a) * H * 0.1 * B,
        y: hip.y - H * 0.02 + rng.range(-0.02, 0.02) * H,
        z: Math.sin(a) * H * 0.06 * B,
        ry: -a,
        rx: rng.range(-0.2, 0.2),
      }), p.cloth, [BONE.PELVIS]);
    }
  }

  // ── 剪影结构：每只 Boss 的大体积特征 ────────────────────────
  // 这一段才是"长得不一样"真正生效的地方。前面的头/眼/颚只有走近才看得清，
  // 而这些结构直接改变远处那个黑影的形状。
  if (spec.silhouette) {
    const sil = spec.silhouette;
    const shL = skel[BONE.ARM_L]!.head;
    const shR = skel[BONE.ARM_R]!.head;

    if (sil === 'brute') {
      // 肩冠：两坨盖过整个肩头的甲壳，每坨上面钉三根外翻的尖刺。
      // 深渊领主的正面轮廓就是一个被撑到极限的倒三角。
      for (const [i, sh] of [shL, shR].entries()) {
        const sx = i === 0 ? -1 : 1;
        add(place(lathe([
          [H * 0.02 * B, 0], [H * 0.075 * B, H * 0.02], [H * 0.088 * B, H * 0.055],
          [H * 0.078 * B, H * 0.09], [H * 0.05 * B, H * 0.115], [0.0008, H * 0.125],
        ], Math.max(9, q.radialSegments)), {
          x: sh.x * 1.14, y: sh.y + H * 0.015, z: sh.z, rz: sx * 0.34,
        }), p.cloth, [i === 0 ? BONE.ARM_L : BONE.ARM_R, BONE.CHEST]);
        for (let k = 0; k < 3; k++) {
          add(place(lathe([
            [H * 0.016 * B, 0], [H * 0.011 * B, H * 0.04], [0.0006, H * 0.115],
          ], 6), {
            x: sh.x * (1.1 + k * 0.14), y: sh.y + H * (0.075 - k * 0.012), z: sh.z + (k - 1) * H * 0.045 * B,
            rz: sx * (0.6 + k * 0.22), rx: -0.2,
          }), p.bone, [i === 0 ? BONE.ARM_L : BONE.ARM_R, BONE.CHEST]);
        }
      }
      // 腰甲：一圈厚重的板带，把下半身也压宽
      add(place(lathe([
        [H * 0.115 * B, 0], [H * 0.135 * B, H * 0.02], [H * 0.132 * B, H * 0.06], [H * 0.105 * B, H * 0.075],
      ], Math.max(10, q.radialSegments)), { x: 0, y: hip.y + H * 0.02, z: hip.z }), p.dark, [BONE.PELVIS]);

    } else if (sil === 'bloat') {
      // 脓包：背上和腹侧长出一串大小不一的囊肿，轮廓变得凹凸不平。
      // 腐化巨兽读起来就该是"一个随时会炸开的东西"，而不是一个胖子。
      const bulbs = q.accessory >= 2 ? 9 : 6;
      for (let i = 0; i < bulbs; i++) {
        const a = rng.range(0, Math.PI * 2);
        const t = rng.range(0.0, 1.0);
        const r = H * rng.range(0.03, 0.062) * B;
        add(place(lathe([
          [0.0006, 0], [r * 0.8, r * 0.35], [r, r], [r * 0.72, r * 1.6], [0.0006, r * 1.85],
        ], Math.max(8, Math.round(q.radialSegments * 0.7))), {
          x: Math.cos(a) * H * 0.115 * B,
          y: hip.y + (chest.head.y - hip.y) * t + H * 0.04,
          z: Math.sin(a) * H * 0.075 * B,
          rx: Math.PI / 2 - Math.sin(a) * 0.8, rz: Math.cos(a) * 0.8,
        }), rng.next() < 0.35 ? p.accent : p.skin, [BONE.CHEST, BONE.PELVIS]);
      }
      // 下垂的赘肉：从腰腹往下坠一圈，走路时跟着骨盆晃
      add(place(lathe([
        [H * 0.13 * B, 0], [H * 0.148 * B, H * 0.05], [H * 0.12 * B, H * 0.11], [H * 0.07 * B, H * 0.14],
      ], Math.max(10, q.radialSegments)), { x: 0, y: hip.y - H * 0.04, z: hip.z + H * 0.01 }), p.skin, [BONE.PELVIS]);

    } else if (sil === 'gaunt') {
      // 外露脊柱：从骨盆一路串到后脑，一节一节顶出皮肤。
      // 尸山之王是"一条会走路的脊椎"，不是一个瘦子。
      const nSeg = q.accessory >= 2 ? 11 : 7;
      for (let i = 0; i < nSeg; i++) {
        const t = i / (nSeg - 1);
        const y = hip.y + (neck.y - hip.y) * t;
        const r = H * (0.019 - t * 0.006) * B;
        add(place(lathe([[0.0006, 0], [r, r * 0.5], [r * 0.85, r * 1.3], [0.0006, r * 1.7]], 7), {
          x: 0, y, z: chest.head.z - H * (0.055 + t * 0.03) * B, rx: -1.35,
        }), p.bone, [BONE.CHEST, BONE.PELVIS]);
      }
      // 肋弓：两侧各三道大幅外张的骨环，胸腔像被撑开的笼子
      for (const sx of [-1, 1] as const) {
        for (let i = 0; i < 3; i++) {
          const y = chest.head.y + H * (0.0 + i * 0.042);
          add(place(pipe([
            new THREE.Vector3(sx * H * 0.012, y, chest.head.z - H * 0.05 * B),
            new THREE.Vector3(sx * H * 0.095 * B, y + H * 0.012, chest.head.z),
            new THREE.Vector3(sx * H * 0.078 * B, y - H * 0.01, chest.head.z + H * 0.06 * B),
            new THREE.Vector3(sx * H * 0.02, y - H * 0.022, chest.head.z + H * 0.075 * B),
          ], H * 0.008 * B, 5), {}), p.bone, [BONE.CHEST]);
        }
      }

    } else if (sil === 'priest') {
      // 光环：脑后一圈悬浮的骨环 + 六根放射状的钉。
      // 猩红使徒是全场唯一一个"有几何对称图案"的剪影，一眼就分得出来。
      const R = H * 0.13;
      const ring: THREE.Vector3[] = [];
      const rseg = q.accessory >= 2 ? 16 : 10;
      for (let i = 0; i <= rseg; i++) {
        const a = (i / rseg) * Math.PI * 2;
        ring.push(new THREE.Vector3(Math.cos(a) * R, headTop.y - H * 0.02 + Math.sin(a) * R, neck.z - H * 0.08));
      }
      add(place(pipe(ring, H * 0.011, 5), {}), p.accent, [BONE.HEAD]);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.26;
        add(place(lathe([[H * 0.012, 0], [H * 0.008, H * 0.03], [0.0005, H * 0.075]], 5), {
          x: Math.cos(a) * R, y: headTop.y - H * 0.02 + Math.sin(a) * R, z: neck.z - H * 0.08,
          rz: a - Math.PI / 2, rx: 0,
        }), p.bone, [BONE.HEAD]);
      }
      // 长袍：从胯部一路罩到脚踝，腿完全被吞掉——下半身没有"两条腿"的读法
      const ankleY = H * 0.03;
      // profile 自下而上：下摆最宽、腰口收紧，才是一件袍子而不是一个漏斗
      add(place(lathe([
        [H * 0.172 * B, 0], [H * 0.158 * B, H * 0.08], [H * 0.134 * B, H * 0.3],
        [H * 0.115 * B, H * 0.48], [H * 0.104 * B, H * 0.56],
      ], Math.max(12, q.radialSegments)), { x: 0, y: ankleY, z: hip.z }), p.cloth, [BONE.PELVIS]);
      // 肩上悬着的两片碎骨
      for (const sh of [shL, shR]) {
        add(place(plate(H * 0.045, H * 0.1, H * 0.012, { corner: H * 0.012 }), {
          x: sh.x * 1.35, y: sh.y + H * 0.07, z: sh.z, rz: Math.sign(sh.x) * 0.3,
        }), p.bone, [BONE.CHEST]);
      }

    } else if (sil === 'titan') {
      // 背刃：五片从背后立起来的巨刃，越往中间越高，展开成一把扇子。
      // 终末之主的剪影比它本人还大一圈——这就是"最后一只"该有的存在感。
      // 尺寸是调过的：第一版每片有大半个身子高，正面看整片糊成一块屋顶，
      // 把 Boss 自己的头和身体全挡住了。缩到肩宽这个量级、往两侧扇开，
      // 才是"背后立着一排刃"而不是"背了一块板"。
      const blades = q.accessory >= 2 ? 5 : 3;
      for (let i = 0; i < blades; i++) {
        const t = i / (blades - 1) * 2 - 1;              // -1 → 1
        const hgt = H * (0.52 - Math.abs(t) * 0.17);
        add(place(plate(H * 0.042 * B, hgt, H * 0.016, { corner: H * 0.014 }), {
          x: t * H * 0.085 * B,
          y: chest.head.y + hgt * 0.52,
          z: chest.head.z - H * (0.075 + Math.abs(t) * 0.012) * B,
          rz: t * 0.62, rx: -0.3,
        }), p.cloth, [BONE.CHEST]);
        // 刃口用骨色勾一条边，远处才看得出这是"刃"不是"板"
        add(place(plate(H * 0.012 * B, hgt * 0.9, H * 0.022, { corner: H * 0.006 }), {
          x: t * H * 0.085 * B + Math.sin(t * 0.62) * H * 0.022,
          y: chest.head.y + hgt * 0.56,
          z: chest.head.z - H * (0.075 + Math.abs(t) * 0.012) * B,
          rz: t * 0.62, rx: -0.3,
        }), p.accent, [BONE.CHEST]);
      }
      // 护手：两只离谱的大铁拳，垂到膝盖边上
      for (const [i, b] of [BONE.FORE_L, BONE.FORE_R].entries()) {
        const w = skel[b]!.tail;
        add(place(accBox(H * 0.056 * B, H * 0.066, H * 0.056 * B, H * 0.014), {
          x: w.x * 1.05, y: w.y - H * 0.03, z: w.z,
        }), p.dark, [b]);
        void i;
      }
      // 腰后的一圈残破披挂。
      // 这里原本是一整块盖住胸腔的裹尸布——但几何体是面朝 +z 建的、实例又转了
      // 180°，"背后"在镜头里其实是**正前方**，那块板把整只 Boss 的身体和脸
      // 全糊住了。改成挂在腰线以下的几片，既保留破布的读法，又不挡住上半身。
      for (let i = 0; i < 4; i++) {
        const t = (i / 3) * 2 - 1;
        add(place(plate(H * 0.05 * B, H * 0.22, H * 0.01, { corner: H * 0.02 }), {
          x: t * H * 0.085 * B,
          y: hip.y - H * 0.06,
          z: hip.z - H * 0.055 * B,
          rz: t * 0.22, rx: -0.1,
        }), p.dark, [BONE.PELVIS]);
      }
    }
  }

  // ── 合并 → 蒙皮 → 平滑 → 烘表面 ────────────────────────────
  for (const part of parts) assignSkin(part.geo, skel, part.bones);
  let geo = merge(parts.map((x) => x.geo));

  // 极轻微的顶点抖动：完全对称的躯体看起来像塑料模型
  if (spec.decayed) jitter(geo, H * 0.0035, spec.seed ?? 3);

  geo = weldSmooth(geo, 46);
  // 角色也要烘 AO。不烘的话 aSurf.x 恒为 1，着色器里的脏污项会被压到几乎为零，
  // 整个人就是一块平涂的色块 —— 腋下、裆部、头盔底下这些该暗的地方全是亮的。
  // 网格取得比硬表面粗一档，一个角色三十几毫秒，开局总共几百毫秒可以接受。
  geo = bakeSurface(geo, { gridSize: 20, rays: 10, steps: 4 });
  geo.userData.pivots = pivots(skel);
  geo.userData.skeleton = skel;
  return geo;
}

/** 取几何体上附带的骨骼轴心，交给材质。 */
export function geometryPivots(geo: THREE.BufferGeometry): Float32Array {
  return geo.userData.pivots as Float32Array;
}

export function geometrySkeleton(geo: THREE.BufferGeometry): Skeleton {
  return geo.userData.skeleton as Skeleton;
}

// ── 各类角色 ──────────────────────────────────────────────────

/**
 * 杂兵的体型变体。
 *
 * 之前整片尸潮共用同一具模型，只靠随机缩放和 tint 抖动区分——远看是一片
 * 会呼吸的地毯，近看每一只都一模一样。这里给尸群和疾行者各准备几套**不同
 * 骨架比例**的模型（高矮胖瘦、佝偻程度、有没有爪子、衣服什么颜色），
 * 渲染层按实例 id 分批，成本只是多几个 InstancedMesh。
 */
export const ZOMBIE_VARIANTS = 4;
export const RUNNER_VARIANTS = 3;

const ZOMBIE_BODIES = [
  // 0 标准腐尸
  { height: 1.76, build: 0.95, hunch: 0.34, reach: -1.15, gaunt: true, mouth: 'open' as const, claws: false,
    palette: { skin: 0xb8c3a6, cloth: 0x7d8070, dark: 0x55584d, accent: 0x8a8272, bone: 0xd8d2bd } },
  // 1 肿胀尸：矮、圆、脸浮肿，混在人群里是那个"一坨"的
  { height: 1.62, build: 1.32, hunch: 0.18, reach: -0.95, gaunt: false, mouth: 'fanged' as const, claws: false,
    palette: { skin: 0xa9b591, cloth: 0x5c6b52, dark: 0x3b4534, accent: 0x76855f, bone: 0xcfd0b4 } },
  // 2 枯瘦长人：最高最细，佝偻得厉害，剪影像一根折了的杆子
  { height: 1.98, build: 0.7, hunch: 0.52, reach: -1.4, gaunt: true, mouth: 'open' as const, claws: true,
    palette: { skin: 0xc4c0a2, cloth: 0x6d6552, dark: 0x453f33, accent: 0x8d8168, bone: 0xe2dcc4 } },
  // 3 残破工装尸：中等身材但衣服颜色完全不同，人群里的"另一群人"
  { height: 1.7, build: 1.05, hunch: 0.4, reach: -1.2, gaunt: false, mouth: 'open' as const, claws: false,
    palette: { skin: 0xb0b79b, cloth: 0x8a5f3a, dark: 0x53392a, accent: 0xa07446, bone: 0xd6cfb8 } },
] as const;

const RUNNER_BODIES = [
  { height: 1.72, build: 0.82, hunch: 0.55, reach: -1.45,
    palette: { skin: 0xc9bd96, cloth: 0x8a7a55, dark: 0x5b4d36, accent: 0x9d8a5f, bone: 0xe0d8bf } },
  // 四足化：压得极低、手臂前伸——冲过来的时候读起来像野兽
  { height: 1.6, build: 0.74, hunch: 0.82, reach: -1.7,
    palette: { skin: 0xd0ab7c, cloth: 0x7a5e3c, dark: 0x4b3823, accent: 0x93703f, bone: 0xead9b6 } },
  // 长腿型：高、直、步幅大
  { height: 1.9, build: 0.78, hunch: 0.34, reach: -1.3,
    palette: { skin: 0xbfb489, cloth: 0x6f6a4a, dark: 0x453f2c, accent: 0x8b8055, bone: 0xdcd2b2 } },
] as const;

export function zombieVariantGeometry(q: BuildQuality, variant: number): THREE.BufferGeometry {
  const b = ZOMBIE_BODIES[variant % ZOMBIE_VARIANTS]!;
  return buildHumanoid({
    height: b.height, build: b.build, hunch: b.hunch, reach: b.reach,
    decayed: true, gaunt: b.gaunt, claws: b.claws,
    eyes: 'zombie', mouth: b.mouth, seed: 11 + variant * 37,
    palette: { ...b.palette },
  }, q);
}

export function runnerVariantGeometry(q: BuildQuality, variant: number): THREE.BufferGeometry {
  const b = RUNNER_BODIES[variant % RUNNER_VARIANTS]!;
  return buildHumanoid({
    height: b.height, build: b.build, hunch: b.hunch, reach: b.reach,
    decayed: true, claws: true, gaunt: true,
    eyes: 'zombie', mouth: 'open', seed: 23 + variant * 41,
    palette: { ...b.palette },
  }, q);
}

export function zombieGeometry(q: BuildQuality): THREE.BufferGeometry {
  return zombieVariantGeometry(q, 0);
}

export function runnerGeometry(q: BuildQuality): THREE.BufferGeometry {
  return runnerVariantGeometry(q, 0);
}

export function screamerGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.0, build: 0.86, hunch: 0.2, reach: -0.5, horns: true, claws: true, decayed: true,
    eyes: 'zombie', mouth: 'fanged', seed: 37,
    palette: { skin: 0xd08ea0, cloth: 0x7a3f52, dark: 0x4a2130, accent: 0x9c4f66, bone: 0xf0e2d6 },
  }, q);
}

/**
 * 吐酸者：鼓胀的躯干 + 前倾的长脖子，一眼读得出"这只会吐东西"。
 * 病态的黄绿配色和普通尸的灰绿拉开距离。
 */
export function spitterGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.82, build: 1.12, hunch: 0.62, reach: -0.6, decayed: true, gaunt: false,
    eyes: 'zombie', mouth: 'open', seed: 83,
    palette: { skin: 0x9fc27a, cloth: 0x5e6b3a, dark: 0x333c1e, accent: 0x7d8f45, bone: 0xdfe6c0 },
  }, q);
}

/**
 * 跳跃者：瘦长、重心高、爪子夸张——侧影就要读出"这只会扑过来"。
 * 前倾角比疾行者还大。
 */
export function leaperGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.74, build: 0.78, hunch: 0.72, reach: -1.0, claws: true, decayed: true, gaunt: true,
    eyes: 'zombie', mouth: 'fanged', seed: 91,
    palette: { skin: 0xd0a05c, cloth: 0x7a5a2a, dark: 0x453016, accent: 0x9c7434, bone: 0xf0e0b8 },
  }, q);
}

/**
 * 重甲尸：厚重的板甲外壳 + 头盔，站姿最直。
 * 复用士兵那套 helmet/backpack 配件来堆装甲感，配色压成冷灰钢，
 * 让玩家一眼看出"这只不是用枪能啃动的"。
 */
export function armoredGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.05, build: 1.38, hunch: 0.14, reach: -0.4, helmet: true, backpack: true, decayed: true,
    eyes: 'glow', mouth: 'closed', seed: 67,
    palette: { skin: 0x6d7681, cloth: 0x4a535e, dark: 0x272d35, accent: 0x8d99a6, bone: 0xb9c4cf },
  }, q);
}

/**
 * 幼体：半人高、四肢短、几乎趴着跑。
 * 关键是它必须一眼就和普通尸群区分开——不是"缩小的僵尸"，
 * 而是一团贴着地面涌过来的东西。
 */
export function swarmlingGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.12, build: 1.08, hunch: 0.95, reach: -1.6, decayed: true, claws: true, gaunt: true,
    eyes: 'zombie', mouth: 'fanged', headScale: 1.25, seed: 143,
    palette: { skin: 0xa8b894, cloth: 0x62705a, dark: 0x39422f, accent: 0x7f8a63, bone: 0xd2d8bc },
  }, q);
}

/**
 * 自爆尸：脓包剪影 + 胸腹一整块发光的核。
 * 它的长相就是它的警告——玩家必须在它走到跟前之前认出来并打掉。
 */
export function bomberGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.68, build: 1.5, hunch: 0.28, reach: -1.0, decayed: true, spikes: true,
    eyes: 'glow', mouth: 'open', headScale: 0.9, eyeScale: 1.3, silhouette: 'bloat', seed: 157,
    palette: { skin: 0x7a5a34, cloth: 0x4c3a22, dark: 0x2a2012, accent: 0xff8a2a, bone: 0xffd9a0 },
  }, q);
}

export function bruteGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.2, build: 1.45, hunch: 0.4, reach: -0.85, claws: true, spikes: true, decayed: true,
    eyes: 'zombie', mouth: 'fanged', seed: 53,
    palette: { skin: 0xb08068, cloth: 0x6f4636, dark: 0x40281f, accent: 0x8a5540, bone: 0xe8ddc8 },
  }, q);
}

export function titanGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.5, build: 1.7, hunch: 0.3, reach: -0.7, horns: true, claws: true, spikes: true, decayed: true,
    eyes: 'glow', mouth: 'fanged', seed: 71,
    // 炭化甲壳压暗，把"亮"完全让给骨白的角爪——不再是红橙一个色系糊在一起
    palette: { skin: 0x4a2e28, cloth: 0x241512, dark: 0x150a08, accent: 0xe8dcc4, bone: 0xf2e6d2 },
  }, q);
}

export function midBossGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.65, build: 1.8, hunch: 0.32, reach: -0.72, horns: true, claws: true, spikes: true, decayed: true,
    eyes: 'glow', mouth: 'fanged', seed: 61,
    // 病态的暗绿腐蚀色，和 titan 的暖褐、boss 的近黑拉开——一眼能认出
    // "这是介于精英和终极 Boss 之间的另一种强化怪"，不是缩小版 boss
    palette: { skin: 0x263420, cloth: 0x171f13, dark: 0x0e130b, accent: 0xd8e0b8, bone: 0xe6ecc8 },
  }, q);
}

/**
 * 五个 Boss 各自的外形。
 *
 * 之前五关共用同一个模型，只有体型倍率不同——玩家看到第五关的"终末之主"，
 * 认出来的其实还是第一关那只。现在每一只的剪影、配色和配件都不一样，
 * 而且和它的招式对得上：会喷火墙的嘴上有獠牙，会扫光束的眼睛在发光，
 * 会潜地的通体漆黑长满骨刺。
 */
export function bossGeometry(q: BuildQuality, kind: BossKind = 'overlord'): THREE.BufferGeometry {
  switch (kind) {
    // 深渊领主：教学关的门面。魁梧、对称、一眼认得出是"Boss"。
    case 'overlord':
      return buildHumanoid({
        height: 2.9, build: 1.95, hunch: 0.22, reach: -0.6, horns: true, claws: true, spikes: true, decayed: true,
        silhouette: 'brute',
        // 方脸阔颌 + 一对上翘的獠牙，最"标准"的一张怪物脸
        eyes: 'glow', mouth: 'fanged', headScale: 1.4, eyeScale: 1.7, jaw: 'tusks', seed: 97,
        // 近黑的炭化甲壳 + 骨白角爪的强对比；"亮色"不再来自皮肤本身，而是
        // CrowdMaterial 里叠加在磨损棱线上的熔纹自发光（见 GameView 的 crackGlow）
        palette: { skin: 0x231210, cloth: 0x160b09, dark: 0x0d0503, accent: 0xf5e8d0, bone: 0xffeede },
      }, q);

    // 腐化巨兽：肿胀、佝偻、病态的黄绿——半场毒爆的施法者，
    // 体型比领主更臃肿，读起来像一个随时会炸开的脓包。
    case 'plague':
      return buildHumanoid({
        height: 2.75, build: 2.35, hunch: 0.55, reach: -0.5, claws: true, spikes: true, decayed: true,
        silhouette: 'bloat',
        // 肿胀的大头 + 额外一排小眼睛，读起来是"病变到不像人"
        eyes: 'glow', mouth: 'open', gaunt: false,
        headScale: 1.55, eyeScale: 1.3, eyeRows: 2, seed: 131,
        palette: { skin: 0x2c3a1c, cloth: 0x1d2612, dark: 0x0e1408, accent: 0xc8e070, bone: 0xdfe8b0 },
      }, q);

    // 尸山之王：最高最瘦，长角、獠牙外露——喷火墙的那张嘴要一眼看得见。
    case 'maw':
      return buildHumanoid({
        height: 3.35, build: 1.62, hunch: 0.16, reach: -0.75, horns: true, claws: true, decayed: true,
        silhouette: 'gaunt',
        // 裂成两瓣的下颚——火墙就是从这张嘴里喷出来的，招式和长相要对得上
        eyes: 'glow', mouth: 'fanged', gaunt: true,
        headScale: 1.45, eyeScale: 1.25, jaw: 'split', seed: 173,
        palette: { skin: 0x3a2318, cloth: 0x24140d, dark: 0x120906, accent: 0xff9a3c, bone: 0xffd9a0 },
      }, q);

    // 猩红使徒：直立、修长、几乎不佝偻——发光的眼睛是光束的来源，
    // 全身猩红配骨白，和前面几只的土色系彻底拉开。
    case 'apostle':
      return buildHumanoid({
        height: 3.05, build: 1.7, hunch: 0.06, reach: -0.4, horns: true, spikes: true, decayed: true,
        silhouette: 'priest',
        // 小脸、巨眼、抿着的嘴——光束的来源就是那对眼睛，其它五官全部让位
        eyes: 'glow', mouth: 'closed', headScale: 1.15, eyeScale: 2.6, seed: 211,
        palette: { skin: 0x5a1418, cloth: 0x360b0e, dark: 0x1a0405, accent: 0xff4a52, bone: 0xffe0d8 },
      }, q);

    // 终末之主：最大的一只，通体漆黑长满骨刺，紫白的裂纹。
    case 'ender':
      return buildHumanoid({
        height: 3.5, build: 2.15, hunch: 0.3, reach: -0.7, horns: true, claws: true, spikes: true, decayed: true,
        silhouette: 'titan',
        // 终局：最大的头、四只眼、獠牙，前面几只的特征全堆在一张脸上
        eyes: 'glow', mouth: 'fanged',
        headScale: 1.65, eyeScale: 1.6, eyeRows: 2, jaw: 'tusks', seed: 251,
        palette: { skin: 0x1a1424, cloth: 0x0f0a17, dark: 0x06040a, accent: 0xc9a8ff, bone: 0xeadcff },
      }, q);
  }
}


/**
 * 武器等级 → 装备档。八级武器分成三段，每段换一身行头：
 * 0-1 手枪/霰弹（民兵）、2-4 冲锋枪~轻机枪（制式）、5-7 加特林~湮灭者（重装）。
 */
export function gearForWeapon(tier: number): 0 | 1 | 2 {
  if (tier <= 1) return 0;
  if (tier <= 4) return 1;
  return 2;
}

/**
 * 三档配色。升级除了加甲还要换色——远处看不清几何细节的时候，
 * 颜色是第一层"我的部队变强了"的信号：
 * 民兵的土黄 → 制式的军蓝 → 重装的深钢青。
 */
const GEAR_PALETTES = [
  { skin: 0xd9a684, cloth: 0x6b6244, dark: 0x3d3a2b, accent: 0x55503a, bone: 0xf0e6d8 },
  { skin: 0xd9a684, cloth: 0x2f4d8f, dark: 0x1d2f5c, accent: 0x24407a, bone: 0xf0e6d8 },
  { skin: 0xd9a684, cloth: 0x24333f, dark: 0x161f27, accent: 0x3c6070, bone: 0xf0e6d8 },
] as const;

export function soldierGeometry(q: BuildQuality, weaponTier: number): THREE.BufferGeometry {
  const gear = gearForWeapon(weaponTier);
  // 重装档的人整体壮一圈：甲厚了，体型也该跟上
  const build = 1.02 + gear * 0.05;
  return buildHumanoid({
    height: 1.8 + gear * 0.03, build, hunch: 0.06 - gear * 0.02, reach: -0.28,
    helmet: true, backpack: true, weaponTier, gear,
    eyes: 'soldier', mouth: 'closed', seed: 5,
    palette: { ...GEAR_PALETTES[gear]! },
  }, q);
}
