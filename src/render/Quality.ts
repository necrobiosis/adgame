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
  /** 角色配件细节档：0 只留大件 / 1 常规 / 2 全套。 */
  readonly accessory: 0 | 1 | 2;
  /** 同屏最多画多少个士兵（性能上限）。 */
  readonly soldierInstances: number;
  /**
   * 方阵视觉呈现上限（≤ soldierInstances）。
   *
   * 以前固定给 10：那时候阵型是一条 6 米宽、上百米长的纵队，多画只会
   * 拖出一条望不到头的队伍，所以干脆只露最前排、剩下的用头顶的总数标签表示。
   *
   * 阵型改成"宽度锁死一条车道、纵深封顶、人多就压密"之后，四百人是一个
   * 7 米宽、二十几米深的密集方块——那是这个游戏最该被看见的画面，所以
   * 上限要放开。
   *
   * 但放开多少是量出来的，不是拍的：单个士兵 7268 面（比 Boss 的 5924 还重，
   * 头盔/胸挂/肩甲/腿甲/护目镜/八级武器全在上面），一口气画 200 个就是
   * 145 万面——比全场杂兵加起来还多，整个场景的三角形数直接涨四成。
   * 按"士兵总面数压在 60 万以内"倒推，高画质给 80。八十人已经是一个
   * 十一列、七八排的密集方块，人海感全在，成本只有 58 万面。
   */
  readonly soldierVisualCap: number;
  /** 同屏最多画多少门大炮（单门约 6.6k 面，是场上最重的道具）。 */
  readonly cannonInstances: number;
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
    enemyInstances: 280,
    radialSegments: 12,
    lengthDetail: 1,
    accessory: 2,
    soldierInstances: 220,
    soldierVisualCap: 80,
    cannonInstances: 32,
    shadowMap: 2048,
    // 杂兵不投影 —— 阴影通道要把所有投影体再画一遍，几百个高模杂兵直接让
    // 整帧的几何量翻倍，而它们的影子在地面上本来就糊成一片。
    // 精英、Boss、士兵、道具照常投影，画面里能读出来的影子一个不少。
    crowdShadows: false,
    /**
     * 屏幕空间 AO 默认关掉。
     *
     * 它要把整个场景的深度和法线再画一遍 —— 在这个场景里就是又一个两百多万
     * 三角形的通道，而遮蔽信息我们已经在建模期烘进每个资产的顶点里了
     * （物理推导、无屏幕空间瑕疵），接触阴影则由真实阴影贴图负责。
     * 代码路径留着，想开随时打开。
     */
    gtao: false,
    smaa: true,
    maxPixelRatio: 2,
    anisotropy: 8,
    envDetail: 1,
  },
  medium: {
    level: 'medium',
    label: '中',
    enemyInstances: 200,
    radialSegments: 9,
    lengthDetail: 0.7,
    accessory: 1,
    soldierInstances: 170,
    soldierVisualCap: 70,
    cannonInstances: 20,
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
    enemyInstances: 110,
    radialSegments: 6,
    lengthDetail: 0.4,
    accessory: 0,
    soldierInstances: 100,
    soldierVisualCap: 45,
    cannonInstances: 12,
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
