import * as THREE from 'three';
import { chamferBox, lathe, merge, paint, pipe, place, plate, sweep, type SweepSection } from '../geom/hardSurface';
import { bakeSurface, jitter, weldSmooth } from '../geom/deform';
import { BONE, assignSkin, buildSkeleton, pivots, type Skeleton } from './skeleton';
import { Rng } from '../../core/Rng';

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

  // ── 躯干 ────────────────────────────────────────────────────
  // 骨盆 → 胸腔 → 颈根。胸腔最宽，腰部收进去，颈根再收 —— 这条曲线是
  // "人形"读起来对不对的关键。
  const hip = skel[BONE.PELVIS]!.head;
  const neck = skel[BONE.HEAD]!.head;
  // 比例照真人来（以 1.8 米为基准）：肩宽 0.46、腰宽 0.32、胯宽 0.36。
  // 之前四肢比真人粗了将近一倍，整个人读起来是一团肉球。
  const torsoCtrl = densify([
    { t: -0.10, w: H * 0.100 * B, h: H * 0.062 * B, round: 0.62 },
    { t: 0.14, w: H * 0.092 * B, h: H * 0.057 * B, round: 0.66 },
    { t: 0.44, w: H * 0.089 * B, h: H * 0.055 * B, round: 0.62 },
    { t: 0.74, w: H * 0.118 * B, h: H * 0.066 * B, round: 0.5 },
    { t: 0.92, w: H * 0.128 * B, h: H * 0.068 * B, round: 0.45 },
    { t: 1.02, w: H * 0.088 * B, h: H * 0.058 * B, round: 0.62 },
    { t: 1.10, w: H * 0.036 * B, h: H * 0.036 * B, round: 0.95 },
  ], q);
  add(limb(hip, neck, torsoCtrl, q), p.cloth, [BONE.PELVIS, BONE.CHEST]);

  // ── 头 ──────────────────────────────────────────────────────
  const headTop = skel[BONE.HEAD]!.tail;
  // 憔悴：下颌+颧骨一起收窄，脸从"圆润"变"凹陷"——不改动脖子/颅顶，
  // 侧影读起来是同一个人瘦下去了，不是换了一颗头。
  const gauntK = spec.gaunt ? 0.82 : 1;
  const headCtrl = densify([
    { t: 0.02, w: H * 0.030, h: H * 0.030, round: 0.95 },  // 脖子
    { t: 0.22, w: H * 0.033, h: H * 0.033, round: 0.95 },
    { t: 0.42, w: H * 0.045 * gauntK, h: H * 0.048 * gauntK, round: 0.9 },   // 下颌
    { t: 0.66, w: H * 0.048 * gauntK, h: H * 0.052 * gauntK, round: 0.92 }, // 颧骨
    { t: 0.88, w: H * 0.045, h: H * 0.048, round: 1 },     // 颅顶
    { t: 1.0, w: H * 0.026, h: H * 0.03, round: 1 },
  ], q);
  add(limb(neck, headTop, headCtrl, q), p.skin, [BONE.HEAD, BONE.CHEST]);

  // 头部的解剖学地标，全部按"颈根到颅顶"这段长度取比例
  const headLen = headTop.y - neck.y;
  const chinY = neck.y + headLen * 0.30;
  const mouthY = neck.y + headLen * 0.40;
  const noseY = neck.y + headLen * 0.49;
  const eyeY = neck.y + headLen * 0.58;
  const browY = neck.y + headLen * 0.64;
  const faceZ = neck.z + headLen * 0.22;
  void chinY;

  // 鼻子：往前突出一小块，侧影才不是一颗光球
  add(place(accBox(H * 0.03, H * 0.024, H * 0.024, H * 0.01), {
    x: 0, y: noseY, z: faceZ,
  }), p.skin, [BONE.HEAD]);

  // ── 眼睛 ────────────────────────────────────────────────────
  const eyeX = H * 0.021;
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
        [H * 0.009, 0], [H * 0.006, H * 0.012], [0.0004, H * 0.024],
      ], Math.max(5, Math.round(q.radialSegments * 0.5))), {
        x: sx * eyeX, y: eyeY, z: faceZ + headLen * 0.03, rx: -1.15,
      }), eyeColor, [BONE.HEAD]);
    }
  }

  // ── 眉骨 ────────────────────────────────────────────────────
  if (minor) {
    add(place(accBox(H * 0.05, H * 0.01, H * 0.014, H * 0.004), {
      x: 0, y: browY, z: faceZ + headLen * 0.02, rx: -0.15,
    }), p.dark, [BONE.HEAD]);
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

    // 肩甲：让肩部有真正的转折，而不是一根圆管直接插进躯干
    if (spec.helmet) {
      add(place(lathe([
        [H * 0.001, 0], [H * 0.036 * B, H * 0.006], [H * 0.049 * B, H * 0.022],
        [H * 0.050 * B, H * 0.044], [H * 0.044 * B, H * 0.062], [H * 0.030 * B, H * 0.07],
      ], Math.max(8, q.radialSegments)), {
        x: shoulder.x * 1.02, y: shoulder.y + H * 0.03, z: shoulder.z,
        rz: side * 0.3, s: [1, -1, 1],
      }), p.accent, [armB, BONE.CHEST]);
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
    if (spec.helmet && minor) {
      // 护膝
      add(place(accBox(H * 0.042 * B, H * 0.044, H * 0.03, H * 0.012), {
        x: knee.x, y: knee.y + H * 0.008, z: knee.z + H * 0.028 * B,
      }), p.dark, [thighB, shinB]);
    }
  }

  // ── 装备与特征 ──────────────────────────────────────────────
  const chest = skel[BONE.CHEST]!;

  if (spec.helmet) {
    // 盔壳用放样做出前低后高的形状，再压一条帽檐
    // 盔壳用车削件：轮廓自己控制，收口是圆的而不是尖的。
    // 从眉骨往上罩住整个颅顶，脸留在外面。
    const seg = Math.max(8, Math.round(q.radialSegments * 1.2));
    const helmH = headLen * 0.62;
    add(place(lathe([
      [H * 0.053, 0], [H * 0.057, helmH * 0.1], [H * 0.056, helmH * 0.36],
      [H * 0.050, helmH * 0.6], [H * 0.038, helmH * 0.84], [H * 0.02, helmH * 0.97], [0.0006, helmH],
    ], seg), { x: 0, y: browY, z: neck.z + headLen * 0.02 }), p.accent, [BONE.HEAD]);
    // 帽檐
    add(place(plate(H * 0.096, H * 0.034, H * 0.008, { corner: H * 0.013 }), {
      x: 0, y: browY + headLen * 0.04, z: faceZ + headLen * 0.09, rx: -0.5,
    }), p.accent, [BONE.HEAD]);
    // 耳罩
    if (minor) {
      for (const sx of [-1, 1]) {
        add(place(accBox(H * 0.013, H * 0.04, H * 0.036, H * 0.005), {
          x: sx * H * 0.05, y: eyeY, z: neck.z,
        }), p.dark, [BONE.HEAD]);
      }
    }
    // 夜视仪基座 —— 剪影上的一个识别点
    if (minor) {
      add(place(chamferBox(H * 0.024, H * 0.018, H * 0.016, H * 0.004), {
        x: 0, y: browY + headLen * 0.16, z: faceZ + headLen * 0.06,
      }), p.dark, [BONE.HEAD]);
    }
    // 护目镜：推到额头上的一条暗带，脸立刻有了焦点，又不会挡住眼睛下面
    // 新加的五官——士兵也要看得出五官，不能被一条黑杠糊住脸
    add(place(accBox(H * 0.084, H * 0.02, H * 0.018, H * 0.007), {
      x: 0, y: browY, z: faceZ - headLen * 0.02,
    }), 0x14171d, [BONE.HEAD]);
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
    // 胸甲本体
    add(place(plate(H * 0.13 * B, H * 0.13, H * 0.016, { corner: H * 0.026 }), {
      x: 0, y: chest.head.y + H * 0.055, z: chest.head.z + H * 0.056 * B, rx: 0.08,
    }), p.cloth, [BONE.CHEST]);
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
      // 冲锋枪：短枪管 + 一根斜出去的折叠托
      add(place(lathe([
        [H * 0.01, 0], [H * 0.01, H * 0.07], [H * 0.007, H * 0.073], [0.0004, H * 0.09],
      ], 8), { x: gx, y: gy + H * 0.01, z: gz + H * 0.1, rx: Math.PI / 2 }), 0x3a4049, [BONE.FORE_R]);
      add(place(chamferBox(H * 0.015, H * 0.06, H * 0.026, H * 0.006), { x: gx, y: gy - H * 0.04, z: gz + H * 0.01, rx: 0.22 }), 0x2b2f36, [BONE.FORE_R]);
      add(place(pipe([
        new THREE.Vector3(gx, gy, gz - H * 0.02),
        new THREE.Vector3(gx, gy - H * 0.022, gz - H * 0.058),
      ], H * 0.006, 5), {}), 0x353a42, [BONE.FORE_R]);
    } else if (tier === 3) {
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
    } else if (tier === 4) {
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
    } else if (tier === 5) {
      // 等离子炮：整把枪已经不像枪了——粗大的能量管、三圈线圈、
      // 尾部的能量核心、喇叭口的炮口。终极武器就该夸张到离谱。
      add(place(lathe([
        [H * 0.022, 0], [H * 0.022, H * 0.2], [H * 0.03, H * 0.21],
        [H * 0.024, H * 0.24], [H * 0.05, H * 0.3], [H * 0.046, H * 0.32], [0.0006, H * 0.328],
      ], 10), { x: gx, y: gy + H * 0.014, z: gz + H * 0.1, rx: Math.PI / 2 }), 0x66e0ff, [BONE.FORE_R]);
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
      ], 10), { x: gx, y: gy + H * 0.006, z: gz - H * 0.05, rx: Math.PI / 2 }), 0x66e0ff, [BONE.FORE_R]);
      // 散热片
      if (minor) for (const sx of [-1, 1] as const) {
        add(place(chamferBox(H * 0.008, H * 0.05, H * 0.09, H * 0.004), {
          x: gx + sx * H * 0.03, y: gy + H * 0.03, z: gz + H * 0.06, rz: sx * 0.2,
        }), 0x22262c, [BONE.FORE_R]);
      }
      add(place(chamferBox(H * 0.024, H * 0.075, H * 0.034, H * 0.008), { x: gx, y: gy - H * 0.055, z: gz + H * 0.01, rx: 0.15 }), 0x2b2f36, [BONE.FORE_R]);
      addStock();
      addSight();
    } else {
      // tier 2（突击步枪）——居中的默认档
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

export function zombieGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.76, build: 0.95, hunch: 0.34, reach: -1.15, decayed: true, gaunt: true,
    eyes: 'zombie', mouth: 'open', seed: 11,
    palette: { skin: 0xb8c3a6, cloth: 0x7d8070, dark: 0x55584d, accent: 0x8a8272, bone: 0xd8d2bd },
  }, q);
}

export function runnerGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.72, build: 0.82, hunch: 0.55, reach: -1.45, decayed: true, claws: true, gaunt: true,
    eyes: 'zombie', mouth: 'open', seed: 23,
    palette: { skin: 0xc9bd96, cloth: 0x8a7a55, dark: 0x5b4d36, accent: 0x9d8a5f, bone: 0xe0d8bf },
  }, q);
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

export function bossGeometry(q: BuildQuality): THREE.BufferGeometry {
  return buildHumanoid({
    height: 2.9, build: 1.95, hunch: 0.22, reach: -0.6, horns: true, claws: true, spikes: true, decayed: true,
    eyes: 'glow', mouth: 'fanged', seed: 97,
    // 近黑的炭化甲壳 + 骨白角爪的强对比；"亮色"不再来自皮肤本身，而是
    // CrowdMaterial 里叠加在磨损棱线上的熔纹自发光（见 GameView 的 crackGlow）
    palette: { skin: 0x231210, cloth: 0x160b09, dark: 0x0d0503, accent: 0xf5e8d0, bone: 0xffeede },
  }, q);
}

export function soldierGeometry(q: BuildQuality, weaponTier: number): THREE.BufferGeometry {
  return buildHumanoid({
    height: 1.8, build: 1.02, hunch: 0.06, reach: -0.28, helmet: true, backpack: true, weaponTier,
    eyes: 'soldier', mouth: 'closed', seed: 5,
    palette: { skin: 0xd9a684, cloth: 0x2f4d8f, dark: 0x1d2f5c, accent: 0x24407a, bone: 0xf0e6d8 },
  }, q);
}
