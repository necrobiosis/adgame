/**
 * 所有可调数值集中在这里。改平衡只动这个文件。
 * 单位约定：距离 = 米，时间 = 秒，z 轴 = 前进方向。
 */

/** 路面半宽。方阵中心 x 被夹在 [-ROAD_HALF+1.2, ROAD_HALF-1.2] 之间。 */
export const ROAD_HALF = 9;

/** 方阵前进速度（战斗未被阻挡时）。 */
export const ADVANCE_SPEED = 9.5;

/** 玩家横向拖拽的最大速度。 */
export const STRAFE_SPEED = 13;

/** 方阵单位间距。 */
export const SLOT_SPACING_X = 1.05;
export const SLOT_SPACING_Z = 1.15;

/** 一排最多站几个人，超出就往后排。 */
export const FORMATION_MAX_COLS = 11;

/** 模拟层士兵上限（再多也不会更强，避免数值爆炸）。 */
export const MAX_SOLDIERS = 400;

/** 渲染层实例上限。 */
export const MAX_RENDERED_SOLDIERS = 260;
export const MAX_RENDERED_ZOMBIES = 1800;

// ─────────────────────────── 武器 ───────────────────────────

export interface WeaponTier {
  readonly name: string;
  /** 每发伤害。 */
  readonly damage: number;
  /** 每秒发数。 */
  readonly fireRate: number;
  /** 射程（米）。 */
  readonly range: number;
  /** 曳光弹颜色。 */
  readonly tracer: number;
  /** 一次开火打出几发（霰弹/连发观感）。 */
  readonly pellets: number;
}

export const WEAPON_TIERS: readonly WeaponTier[] = [
  { name: '手枪',     damage: 9,  fireRate: 3.4,  range: 26, tracer: 0xffe08a, pellets: 1 },
  { name: '冲锋枪',   damage: 11, fireRate: 6.0,  range: 28, tracer: 0xffd166, pellets: 1 },
  { name: '突击步枪', damage: 17, fireRate: 6.5,  range: 31, tracer: 0xffc14d, pellets: 1 },
  { name: '轻机枪',   damage: 24, fireRate: 8.0,  range: 33, tracer: 0xffa62b, pellets: 1 },
  { name: '加特林',   damage: 30, fireRate: 12.0, range: 35, tracer: 0xff8c1a, pellets: 1 },
  { name: '等离子枪', damage: 62, fireRate: 10.0, range: 39, tracer: 0x66e0ff, pellets: 1 },
];

export const MAX_WEAPON_LEVEL = WEAPON_TIERS.length - 1;

/** 大炮：数量少、伤害高、有溅射，打蜂群极强。 */
export const CANNON = {
  damage: 62,
  splashRadius: 4.6,
  /** 溅射边缘的伤害衰减系数（中心 1.0 → 边缘 EDGE）。 */
  splashEdge: 0.42,
  fireRate: 0.72,
  range: 44,
  /** 炮弹飞行速度。 */
  shellSpeed: 46,
  maxCannons: 40,
} as const;

/**
 * 后排火力衰减。
 * 前几排有清晰射界，再往后就只能从人缝里打 —— 每往后一排效率递减。
 * 这条规则是整个策略层的支点：**堆人头买的是生存，换武器买的才是输出**。
 * 没有它的话，"+N 士兵"同时提供血量和伤害，会完全压过"武器升级"这一侧。
 * 大炮不吃这个衰减（炮弹是抛射的，正好解释了它为什么站在最后排）。
 */
export const RANK_FIRE = {
  /** 前几排不衰减。 */
  freeRows: 3,
  /** 之后每排乘以这个系数。 */
  falloff: 0.9,
  /** 衰减下限。 */
  floor: 0.3,
} as const;

/** 士兵基础属性。 */
export const SOLDIER = {
  baseHp: 42,
  /** 僵尸贴到方阵后，每次啃咬的间隔。 */
  hitCooldown: 0.85,
  /** 方阵前沿判定：敌人 z 比前排还小这么多就算贴身。 */
  contactDepth: 1.5,
} as const;

/**
 * 贴身战模型。
 * 关键点：能同时啃到方阵的敌人数量由**接触面宽度**决定，而不是"挤过来多少只"。
 * 后面的僵尸会在前排后面排队堆叠 —— 这既是正确的战斗数学，也正好还原
 * 广告里"尸潮层层压在方阵前面"的画面。
 */
export const MELEE = {
  /** 每一排接触面能站下的僵尸数 = 方阵列数 × 这个系数。 */
  frontRowFactor: 1.25,
  /** 排队时每一层往后退多远。 */
  queueDepth: 0.95,
  /** 挤在接触面上的僵尸会拖慢方阵前进：speed / (1 + n * DRAG)。 */
  advanceDrag: 0.055,
  /** 前进速度的下限比例。 */
  minAdvanceFactor: 0.1,
  /** 跑到方阵后面这么远的僵尸直接回收。 */
  cullBehind: 16,
} as const;

// ─────────────────────────── 敌人 ───────────────────────────

export type EnemyKind = 'walker' | 'runner' | 'screamer' | 'brute' | 'titan' | 'boss';

export interface EnemyStats {
  readonly kind: EnemyKind;
  readonly label: string;
  readonly hp: number;
  readonly speed: number;
  /** 每次攻击对单个士兵造成的伤害。 */
  readonly damage: number;
  /** 视觉体型倍率。 */
  readonly scale: number;
  /** 被击杀给的金币。 */
  readonly gold: number;
  /** 基础色（顶点色的实例乘算 tint）。 */
  readonly tint: number;
  /** 是否显示独立血条。 */
  readonly showHealthBar: boolean;
  /** 一次攻击能同时啃到几个士兵（大怪横扫）。 */
  readonly sweep: number;
  /**
   * 关卡血量缩放的指数。
   * 杂兵吃满缩放（1.0），越大的怪吃得越少 —— 否则第五关的泰坦会有十几万血，
   * 精英车道会直接变成不可通过的墙。
   */
  readonly scaleExp: number;
}

export const ENEMY_STATS: Record<EnemyKind, EnemyStats> = {
  walker:   { kind: 'walker',   label: '尸群',   hp: 12,   speed: 3.2,  damage: 4,  scale: 1.0,  gold: 1,   tint: 0xb6c0a6, showHealthBar: false, sweep: 1, scaleExp: 1.0 },
  runner:   { kind: 'runner',   label: '疾行者', hp: 20,   speed: 6.6,  damage: 6,  scale: 0.95, gold: 2,   tint: 0xc6b489, showHealthBar: false, sweep: 1, scaleExp: 1.0 },
  screamer: { kind: 'screamer', label: '嚎叫者', hp: 260,  speed: 3.6,  damage: 10, scale: 1.25,  gold: 8,   tint: 0xc46a86, showHealthBar: true,  sweep: 1, scaleExp: 0.8 },
  brute:    { kind: 'brute',    label: '蛮兽',   hp: 1500, speed: 2.7,  damage: 30, scale: 1.6,  gold: 30,  tint: 0x8f5a4a, showHealthBar: true,  sweep: 3, scaleExp: 0.55 },
  // titan/boss 的 tint 曾经是"整只涂成红橙色"的旧设计遗留值。palette 已经改成
  // 炭黑甲壳 + 骨白角爪 + 熔纹发光的分层配色，tint 是在几何体自带颜色之上再乘
  // 一层——继续用那个饱和红橙会把新调色板重新糊成一片红，所以改成接近白色，
  // 让 palette 本身的颜色如实显示。
  titan:    { kind: 'titan',    label: '泰坦',   hp: 5200, speed: 2.2,  damage: 52, scale: 2.1,  gold: 70,  tint: 0xf0ece4, showHealthBar: true,  sweep: 5, scaleExp: 0.45 },
  boss:     { kind: 'boss',     label: '深渊领主', hp: 2700, speed: 2.6, damage: 68, scale: 4.4, gold: 400, tint: 0xf5f0e8, showHealthBar: true,  sweep: 8, scaleExp: 0 },
};

/** 嚎叫者光环：半径内的僵尸速度与伤害倍率。 */
export const SCREAMER_AURA = { radius: 12, speedMul: 1.45, damageMul: 1.35 } as const;

// ─────────────────────────── Boss ───────────────────────────

export const BOSS = {
  /** 血量降到这些比例时进入下一阶段。 */
  phaseThresholds: [0.66, 0.33],
  /** 践踏 AoE。 */
  slam: { telegraph: 1.15, radius: 6.4, damage: 55, cooldown: 6.5 },
  /** 召唤。 */
  summon: { count: 26, cooldown: 9.5 },
  /** 冲锋。 */
  charge: { telegraph: 1.0, speed: 26, laneHalfWidth: 3.4, damage: 40, cooldown: 11 },
  /** Boss 停在竞技场里离方阵多远。 */
  standoff: 22,
  /**
   * 狂暴。打到这个时间还没解决，Boss 的技能频率和伤害就一路往上爬。
   * 这保证 Boss 战一定会分出胜负，而不是火力不够时耗成一场僵局。
   */
  enrage: { after: 20, rampPerSecond: 0.09, maxSpeed: 4.0, maxDamage: 4.0 },
} as const;

// ─────────────────────────── 障碍方块 ───────────────────────────

export const BLOCK = {
  /** 打掉方块每 100 点血给多少金币。 */
  goldPerHundredHp: 0.9,
  height: 4.2,
  /**
   * "全宽"方块其实留了两条路肩缝。方阵挤不过去（所以必须停下来硬啃），
   * 但僵尸能从缝里挤进来 —— 这样才不会出现"尸潮直接穿模走过钢块"的画面，
   * 同时保住了"一边啃方块一边被尸潮压上来"的压迫感。
   */
  fullSpanHalfWidth: 7.2,
  /**
   * 方块是装甲的，必须凑近才打得动。
   * 没有这个限制的话，方阵会在三十米外就把它拆了，广告里那个
   * "撞上一堵写着大数字的墙、被迫停下来硬啃"的名场面就没了。
   */
  engageRange: 15,
} as const;

// ─────────────────────────── 金币 / 商店 ───────────────────────────

export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly desc: string;
  readonly maxLevel: number;
  /** 第 n 级（从 0 开始）的价格。 */
  readonly cost: (level: number) => number;
}

export type UpgradeId = 'squad' | 'damage' | 'fireRate' | 'cannon' | 'armor' | 'weapon';

export const UPGRADES: readonly UpgradeDef[] = [
  { id: 'squad',    name: '起始兵力', desc: '每级 +2 名起始士兵',       maxLevel: 12, cost: (l) => 120 + l * 95 },
  { id: 'damage',   name: '弹药强化', desc: '每级 +8% 全队伤害',        maxLevel: 12, cost: (l) => 150 + l * 120 },
  { id: 'fireRate', name: '枪械保养', desc: '每级 +6% 全队射速',        maxLevel: 10, cost: (l) => 160 + l * 130 },
  { id: 'cannon',   name: '炮兵编制', desc: '每级 +1 门起始大炮',        maxLevel: 6,  cost: (l) => 350 + l * 300 },
  { id: 'armor',    name: '防弹背心', desc: '每级 +14% 士兵生命',       maxLevel: 10, cost: (l) => 140 + l * 110 },
  // 后期关卡的硬门槛：光堆人头打不动 Boss，必须把起始火力提上来
  { id: 'weapon',   name: '制式装备', desc: '每级起始武器 +1 级',        maxLevel: 3,  cost: (l) => 900 + l * 1600 },
];

export const UPGRADE_EFFECT = {
  squadPerLevel: 2,
  damagePerLevel: 0.08,
  fireRatePerLevel: 0.06,
  armorPerLevel: 0.14,
} as const;

/** 起始配置（未买任何升级时）。 */
export const START = {
  soldiers: 12,
  weaponLevel: 0,
  cannons: 0,
} as const;
