/**
 * 画质档位。
 *
 * 高模角色 + 阴影 + GTAO 在手机上跑不动，在桌面上又不该浪费。
 * 开局按硬件线索猜一档，跑一秒实测帧时再修正，玩家也可以在菜单里手动改。
 */

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualitySettings {
  readonly level: QualityLevel;
  readonly label: string;
  /** 同屏最多画多少个敌人（按离方阵的距离取最近的这些）。 */
  readonly enemyInstances: number;
  /** 角色放样的径向分段数 —— 直接决定角色面数。 */
  readonly radialSegments: number;
  /** 角色沿身体轴向的分段密度倍率。 */
  readonly lengthDetail: number;
  /** 阴影贴图边长；0 = 关闭阴影。 */
  readonly shadowMap: number;
  /** 杂兵是否投影（精英和 Boss 永远投影）。 */
  readonly crowdShadows: boolean;
  /** 是否开启屏幕空间 AO。 */
  readonly gtao: boolean;
  /** 是否开启 SMAA。 */
  readonly smaa: boolean;
  /** 设备像素比上限。 */
  readonly maxPixelRatio: number;
  /** 各向异性过滤级别。 */
  readonly anisotropy: number;
  /** 桥面桁架等静态细节的密度倍率。 */
  readonly envDetail: number;
}

export const QUALITY: Record<QualityLevel, QualitySettings> = {
  high: {
    level: 'high',
    label: '高',
    enemyInstances: 320,
    radialSegments: 14,
    lengthDetail: 1,
    shadowMap: 2048,
    crowdShadows: true,
    gtao: true,
    smaa: true,
    maxPixelRatio: 2,
    anisotropy: 8,
    envDetail: 1,
  },
  medium: {
    level: 'medium',
    label: '中',
    enemyInstances: 220,
    radialSegments: 10,
    lengthDetail: 0.7,
    shadowMap: 1024,
    crowdShadows: false,
    gtao: false,
    smaa: true,
    maxPixelRatio: 1.75,
    anisotropy: 4,
    envDetail: 0.7,
  },
  low: {
    level: 'low',
    label: '低',
    enemyInstances: 140,
    radialSegments: 7,
    lengthDetail: 0.5,
    shadowMap: 0,
    crowdShadows: false,
    gtao: false,
    smaa: false,
    maxPixelRatio: 1.4,
    anisotropy: 2,
    envDetail: 0.45,
  },
};

const KEY = 'adgame.quality';

/** 读玩家手动选过的档位；没选过返回 null。 */
export function storedQuality(): QualityLevel | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'low' || v === 'medium' || v === 'high' ? v : null;
  } catch {
    return null;
  }
}

export function storeQuality(level: QualityLevel): void {
  try {
    localStorage.setItem(KEY, level);
  } catch {
    // 隐私模式下写不进去，忽略
  }
}

/** 开局的粗略猜测：核心数少、内存小、或者是移动端就先往低了猜。 */
export function guessQuality(): QualityLevel {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile && (cores <= 6 || mem <= 4)) return 'low';
  if (mobile) return 'medium';
  if (cores <= 4 || mem <= 4) return 'medium';
  return 'high';
}

/**
 * 实测帧时并在必要时降档。
 * 只降不升 —— 升档要重建几何体，为了一次误判去做这件事不划算。
 */
export class QualityProbe {
  private frames = 0;
  private accum = 0;
  private done = false;

  constructor(private readonly warmupFrames = 45, private readonly sampleFrames = 75) {}

  /** 返回建议降到的档位；不需要调整时返回 null。 */
  sample(dt: number, current: QualityLevel): QualityLevel | null {
    if (this.done) return null;
    this.frames++;
    if (this.frames <= this.warmupFrames) return null;
    this.accum += dt;
    if (this.frames < this.warmupFrames + this.sampleFrames) return null;

    this.done = true;
    const avgMs = (this.accum / this.sampleFrames) * 1000;
    // 25ms/帧 ≈ 40fps：还能接受。超过 34ms（<30fps）就必须降档。
    if (avgMs > 34 && current !== 'low') return current === 'high' ? 'medium' : 'low';
    if (avgMs > 25 && current === 'high') return 'medium';
    return null;
  }

  reset(): void {
    this.frames = 0;
    this.accum = 0;
    this.done = false;
  }
}
