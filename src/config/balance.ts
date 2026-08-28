/**
 * 所有可调数值集中在这里。改平衡只动这个文件。
 * 单位约定：距离 = 米，时间 = 秒，z 轴 = 前进方向。
 */

/**
 * 路面半宽。
 *
 * 从 9 拉宽到 12：原来方阵最宽能铺到 14 米，而路面只有 18 米，再叠上
 * `margin` 的夹取，满编方阵的实际可移动范围只剩正负一米多——Boss 的
 * AoE 直径 12.8 米，比方阵还宽，怎么走都躲不开。路面拉宽 + 方阵收窄，
 * 两头一起改，横向闪避才第一次真的成立。
 */
export const ROAD_HALF = 11;

/** 方阵前进速度（战斗未被阻挡时）。 */
export const ADVANCE_SPEED = 9.5;

/** 玩家横向拖拽的最大速度。 */
export const STRAFE_SPEED = 13;

/** 方阵单位间距。 */
export const SLOT_SPACING_X = 1.2;
export const SLOT_SPACING_Z = 1.3;

/** 一排最多站几个人，超出就往后排。 */
/**
 * 方阵最多铺几列。
 *
 * 这个值以前形同虚设——Squad.layout() 里写的是
 * `clampInt(..., 1, Math.max(FORMATION_MAX_COLS, 22))`，实际上限是 22 列，
 * 满编方阵宽达 14 米。收到 8 列之后方阵宽度约 8.75 米，比 AoE 直径窄，
 * 整队才有可能一起挪出圈外。
 */
export const FORMATION_MAX_COLS = 5;

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
  /** 曳光弹颜色。 */
  readonly tracer: number;
  /** 一次开火打出几发（霰弹/连发观感）。 */
  readonly pellets: number;
  /**
   * 有效射程（米）。
   *
   * **射程本身是无限的**——只要在你那一排，多远都会开火、都会命中，
   * 士兵不会再站着干等。这个值是伤害开始衰减的那道坎：坎以内满伤害，
   * 越往外打得越轻。于是"打得多远"从一道硬边界变成了一条软曲线，
   * 既不会出现"敌人就在眼前却不开枪"的怪画面，又保住了"放近了再打更划算"
   * 这个节奏——也让电磁炮这种远程武器真的有远程的价值。
   */
  readonly falloffStart: number;
  /**
   * 穿透：一发子弹能串起几个目标。
   *
   * 射程改成无限之后，"打得多远"不再是区分武器的轴了——这一列接上来当新的
   * 那个轴。子弹本来就只往正前方飞，一整排怪站成一条纵队，穿透几个就是
   * 实打实的手感差别：手枪一枪一个，电磁炮一枪串穿半条街。
   */
  readonly pierce: number;
  /**
   * 曳光弹的视觉档：0 细亮的点射 → 4 一整道贯穿的光柱。
   * 升级要**看得见**，光靠伤害数字变大玩家感觉不到自己换了枪。
   */
  readonly beam: number;
}

/**
 * 射程。
 *
 * 数值上是无限的——只要在你那一排，多远都打得到。这里留一个很大的有限值
 * 纯粹是给索敌循环一个上界（也顺便挡住"朝着两百米外还没进场的怪空放"）。
 */
export const WEAPON_RANGE = 400;

/**
 * 超出有效射程之后的伤害衰减。
 * 距离每翻一倍，伤害乘 2^-EXP；再远也不会低于 FLOOR。
 */
export const FALLOFF = { exp: 1.15, floor: 0.16 } as const;

/** 给定有效射程和实际距离，算这一发打出去还剩几成伤害。 */
export function rangeFalloff(falloffStart: number, dist: number): number {
  if (dist <= falloffStart) return 1;
  return Math.max(FALLOFF.floor, Math.pow(falloffStart / dist, FALLOFF.exp));
}

/**
 * 八级武器。
 *
 * 之前六级全是 `pellets: 1`，差别只有伤害和射速在单调上涨——升级读起来
 * 就是"数字变大"，手感上没有换过枪。射程改成无限之后，区分武器的轴换成了
 * 三个看得见的东西：**一次打几发**（霰弹）、**一发串几个**（穿透）、
 * **曳光弹长什么样**（beam）。从手枪的一颗小亮点，到湮灭者的双道紫色光柱，
 * 每升一级屏幕上都得有明显的变化。
 *
 * falloffStart 是"满伤害能打多远"，不是射程上限——射程无限，只是越远越轻。
 * 电磁炮的 110 米意味着它在别的枪只能挠痒的距离上仍然是满伤害。
 */
export const WEAPON_TIERS: readonly WeaponTier[] = [
  { name: '手枪',     damage: 9,   fireRate: 3.4,  falloffStart: 24,  tracer: 0xffe08a, pellets: 1, pierce: 1, beam: 0 },
  // 霰弹枪：一次四颗弹丸，每颗还能串两个——一枪撂倒一小片
  { name: '霰弹枪',   damage: 8,   fireRate: 2.3,  falloffStart: 17,  tracer: 0xffcf7a, pellets: 4, pierce: 2, beam: 1 },
  { name: '冲锋枪',   damage: 13,  fireRate: 6.0,  falloffStart: 27,  tracer: 0xffd166, pellets: 1, pierce: 1, beam: 0 },
  { name: '突击步枪', damage: 18,  fireRate: 6.5,  falloffStart: 33,  tracer: 0xffc14d, pellets: 1, pierce: 2, beam: 1 },
  { name: '轻机枪',   damage: 25,  fireRate: 8.0,  falloffStart: 38,  tracer: 0xffa62b, pellets: 1, pierce: 3, beam: 2 },
  { name: '加特林',   damage: 28,  fireRate: 13.0, falloffStart: 40, tracer: 0xff8c1a, pellets: 1, pierce: 3, beam: 2 },
  // 电磁炮：一枪串穿整条纵队。射速慢，但打的是"一条线"而不是"一个点"
  { name: '电磁炮',   damage: 120, fireRate: 3.0,  falloffStart: 110,  tracer: 0x9fd8ff, pellets: 1, pierce: 9, beam: 4 },
  // 湮灭者：双管齐射 + 高穿透，屏幕上是两道并排的紫色光柱
  { name: '湮灭者',   damage: 52,  fireRate: 7.0,  falloffStart: 62,  tracer: 0xc9a8ff, pellets: 2, pierce: 6, beam: 3 },
];

export const MAX_WEAPON_LEVEL = WEAPON_TIERS.length - 1;

/** 大炮：数量少、伤害高、有溅射，打蜂群极强。 */
export const CANNON = {
  /**
   * 大炮的火线走廊半宽。
   *
   * 步枪只打自己那一排，大炮是曲射的，能越过整条路砸到隔壁排——
   * 这条差别把"武器等级"和"炮兵编制"彻底分成了两种东西：
   * 一个决定你这一排打得多狠，一个决定你够不够得着别的排。
   */
  corridor: ROAD_HALF,
  damage: 62,
  splashRadius: 4.6,
  /** 溅射边缘的伤害衰减系数（中心 1.0 → 边缘 EDGE）。 */
  splashEdge: 0.42,
  fireRate: 0.72,
  /**
   * 大炮的射程。
   *
   * 步枪的射程是无限的，大炮不是——炮弹有实打实的飞行时间，射程再远只会
   * 让炮弹在天上飞五六秒、落点上的怪早就走开了。这个值是"打得到而且还砸得准"
   * 的上限。
   */
  range: 90,
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
/**
 * 局内增益的封顶。
 *
 * 护甲/射速门都是**乘算**的（hpMul *= 1+pct/100）。战役一局最多吃到三五个，
 * 完全没问题；无尽模式有一百多个门，乘着乘着单兵血量能涨到一千三百万——
 * 实测跑到 6650 米时就是这个数，任何怪都打不动方阵，"无尽"直接变成散步。
 * 乘算增益必须有天花板。
 */
export const BUFF_CAP = {
  /** 护甲：单兵血量最多涨到基础值的多少倍。 */
  hpMul: 14,
  /** 射速。 */
  fireRateMul: 6,
  /** 伤害。 */
  damageMul: 8,
} as const;

/**
 * 路面被切成几排。
 *
 * 这是整个玩法的骨架：子弹只往正前方飞（枪不自瞄），所以**你站在哪一排，
 * 火力就只落在哪一排**。墙、奖励、尸群全都长在某一排上，走错排就什么都
 * 拿不到——"该去哪一排"才是这个游戏每一秒都在问玩家的问题。
 */
export const LANES = 3;

/**
 * 火线走廊的额外余量。
 * 判定宽度 = 方阵半宽 + 这个值 + 目标体型，正好略窄于一条车道——
 * 站在一排里打得到这一排的东西，打不到隔壁排。
 */
export const FIRE_CORRIDOR_PAD = 0.7;

/**
 * 敌人的"排纪律"：离方阵还有这么远时，它们老老实实沿着自己那一排往前走；
 * 进到这个距离之内才开始朝方阵收拢。
 *
 * 远处保持队形，玩家才看得出"哪一排有什么、有多少"，选排才有信息可依；
 * 近处收拢，是为了不让"躲进空排"变成免费通关——你只是把它们的死期推后了。
 */
export const LANE_LOCK_RANGE = 16;

/**
 * 大块头的远景刷新距离。
 *
 * 杂兵在 62 米外出现就够了，但泰坦、蛮兽这种慢吞吞的大家伙必须**老远就
 * 看得见**——"那边有个大东西正在慢慢走过来"这件事本身就是压迫感的来源，
 * 等它进了 60 米才淡入，玩家只会觉得它是凭空冒出来的。
 */
export const BIG_SPAWN_AHEAD = 150;

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

export type EnemyKind =
  | 'walker' | 'runner' | 'screamer' | 'brute' | 'titan' | 'midboss' | 'boss'
  // ↓ 行为上真正不同的三种。之前所有怪共用同一套"走过来打前排"的例程，
  //   疾行者和普通尸的区别只有血量和速度；这三种各自攻击当前同质化的一个轴。
  | 'spitter' | 'leaper' | 'armored'
  // ↓ 再补两种，把"尸潮"这个词真正撑起来：一种小到只能靠射速清，
  //   一种大到不能让它走到跟前。
  | 'swarmling' | 'bomber';

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
  /**
   * 对子弹的伤害减免（0~0.95）。重甲尸靠它把"纯堆武器"这条路堵死——
   * 火炮溅射不吃这个减免，于是火炮门第一次和武器门有了本质区别。
   */
  readonly bulletResist?: number;
}

export const ENEMY_STATS: Record<EnemyKind, EnemyStats> = {
  walker:   { kind: 'walker',   label: '尸群',   hp: 12,   speed: 3.2,  damage: 4,  scale: 1.0,  gold: 1,   tint: 0xb6c0a6, showHealthBar: false, sweep: 1, scaleExp: 1.0 },
  runner:   { kind: 'runner',   label: '疾行者', hp: 20,   speed: 6.6,  damage: 6,  scale: 0.95, gold: 2,   tint: 0xc6b489, showHealthBar: false, sweep: 1, scaleExp: 1.0 },
  screamer: { kind: 'screamer', label: '嚎叫者', hp: 260,  speed: 3.6,  damage: 10, scale: 1.25,  gold: 8,   tint: 0xc46a86, showHealthBar: true,  sweep: 1, scaleExp: 0.8 },
  brute:    { kind: 'brute',    label: '蛮兽',   hp: 1500, speed: 2.7,  damage: 30, scale: 1.6,  gold: 30,  tint: 0x8f5a4a, showHealthBar: true,  sweep: 3, scaleExp: 0.72 },
  // titan/boss 的 tint 曾经是"整只涂成红橙色"的旧设计遗留值。palette 已经改成
  // 炭黑甲壳 + 骨白角爪 + 熔纹发光的分层配色，tint 是在几何体自带颜色之上再乘
  // 一层——继续用那个饱和红橙会把新调色板重新糊成一片红，所以改成接近白色，
  // 让 palette 本身的颜色如实显示。
  titan:    { kind: 'titan',    label: '泰坦',   hp: 5200, speed: 2.2,  damage: 52, scale: 2.1,  gold: 70,  tint: 0xf0ece4, showHealthBar: true,  sweep: 5, scaleExp: 0.66 },
  // 中 boss：介于精英怪和终极 Boss 之间——不halt 方阵、不进竞技场，就是一只
  // 会顶着一个技能往前冲的强化精英，用普通 AI 走位（scripted:false），
  // 靠 MidBossController 挂一层"到点炸一下"的技能。hp 字段基本用不上
  // （每关在 levels.ts 的 midboss beat 里给绝对血量），留一个量级合理的默认值。
  midboss:  { kind: 'midboss',  label: '腐蚀主宰', hp: 9000, speed: 2.3, damage: 58, scale: 2.7,  gold: 150, tint: 0xeef2e0, showHealthBar: true,  sweep: 6, scaleExp: 0.4 },
  boss:     { kind: 'boss',     label: '深渊领主', hp: 2700, speed: 2.6, damage: 68, scale: 4.4, gold: 400, tint: 0xf5f0e8, showHealthBar: true,  sweep: 8, scaleExp: 0 },

  // 吐酸者：停在射程外抛酸，落点有预警圈。第一个不靠贴脸的威胁——
  // 站着不动就会被慢慢磨死，逼玩家真的用走位躲。
  spitter:  { kind: 'spitter',  label: '吐酸者', hp: 340,  speed: 2.9,  damage: 8,  scale: 1.15, gold: 9,   tint: 0x9fc27a, showHealthBar: true,  sweep: 1, scaleExp: 0.8 },
  // 跳跃者：周期性跃过前排，落进阵型中后段。前排保护对它无效，
  // 惩罚"把方阵堆得很厚然后不管后排"的打法。
  leaper:   { kind: 'leaper',   label: '跳跃者', hp: 270,  speed: 5.4,  damage: 14, scale: 1.0,  gold: 7,   tint: 0xd0a05c, showHealthBar: true,  sweep: 1, scaleExp: 0.8 },
  // 重甲尸：子弹打不动，必须靠火炮溅射。
  armored:  { kind: 'armored',  label: '重甲尸', hp: 900,  speed: 2.1,  damage: 26, scale: 1.5,  gold: 26,  tint: 0x8d99a6, showHealthBar: true,  sweep: 2, scaleExp: 0.75, bulletResist: 0.82 },
  // 幼体：只有半人高、跑得比疾行者还快、一枪一个。单只没有威胁，
  // 但它们永远是成百上千地来——这是"射速"这条线唯一真正的用武之地，
  // 也是尸潮之所以叫尸潮的原因。
  swarmling: { kind: 'swarmling', label: '幼体', hp: 6, speed: 7.8, damage: 3, scale: 0.55, gold: 1, tint: 0xa8b894, showHealthBar: false, sweep: 1, scaleExp: 1.0 },
  // 自爆尸：不打近战，走到跟前直接炸开一大片。
  // 它把"堆厚阵型然后不管"这条路彻底堵死——必须在它靠上来之前打掉，
  // 于是射程和单体伤害第一次有了不可替代的价值。
  bomber:   { kind: 'bomber',   label: '自爆尸', hp: 150,  speed: 4.4,  damage: 0,  scale: 1.2,  gold: 6,   tint: 0xd08a4a, showHealthBar: true,  sweep: 1, scaleExp: 0.75 },
};

/** 自爆尸：走到方阵跟前就炸，尸体也炸。 */
export const BOMBER = {
  /** 进入这个距离就引爆（不进近战队列）。 */
  fuseRange: 2.6,
  radius: 4.2,
  /**
   * 一发就能带走一个没升过防具的士兵（基础血 42）。
   * 这个数字是故意卡在这条线上的：不买护甲就是一炸一片，
   * 买了护甲这一招才从"团灭"降级成"疼一下"。
   */
  damage: 48,
} as const;

/** 吐酸者：远程抛射。 */
export const SPITTER = {
  /** 停在离方阵这么远的地方开火，不再往前压。 */
  standoff: 19,
  /** 落点预警时长——必须够玩家反应过来横向躲开。 */
  telegraph: 0.95,
  radius: 3.0,
  damage: 22,
  cooldown: 3.6,
} as const;

/** 跳跃者：越过前排砸进阵型中后段。 */
export const LEAPER = {
  /** 进入这个距离之内才起跳。 */
  triggerRange: 16,
  /** 滞空时间。 */
  airTime: 0.75,
  /** 落点相对方阵前沿往里扎多深。 */
  landDepth: 4.5,
  damage: 20,
  radius: 2.2,
  cooldown: 5.5,
} as const;

/**
 * 空袭：玩家唯一的主动技能，也是"左右移动"之外的第二个动词。
 *
 * 瞄准点就是方阵当前的横向位置，于是走位同时服务于四件事：躲技能、捡金币、
 * 选门、瞄空袭。一个动词承担四种决策，比再加一根摇杆更适合这个竖屏单手游戏。
 */
export const AIRSTRIKE = {
  /**
   * 一局带几发。
   *
   * 以前是一条一直在涨的充能条，打得凶就转得快——结果一局能放五六次，
   * 每一次都不值钱，玩家一攒满就随手扔掉。改成**一局就这么多发**：
   * 默认只有一发，什么时候用是这一整局最重的一个决定。想多带，
   * 去兵工厂买「空袭引导」。
   */
  baseCharges: 1,
  /** 两发之间的硬冷却——带了多发也不能一口气全倒出来。 */
  cooldown: 22,
  /** 落点在方阵前方多远。 */
  ahead: 34,
  /** 一次投几发。这一版是地毯式覆盖，不是点名。 */
  bombs: 20,
  /** 投弹沿纵深铺开的范围。 */
  spreadZ: 42,
  spreadX: 8.5,
  /** 从呼叫到第一发落地的延迟——听得到、看得见、来得及期待。 */
  delay: 1.15,
  /**
   * 整轮弹幕从第一发到最后一发铺完用多久。
   *
   * 第一版给了 1.5 秒，结果二十发摊在一秒半里，任何一帧都只有一朵烟，
   * 读起来是"噗噗噗"一串小响，不是一次覆盖。压到 0.85 秒，再让落点按
   * t^0.65 排（前半段挤得更密），第一下才炸得出那种"整条街同时腾起来"的感觉。
   */
  rollOut: 0.85,
  damage: 2200,
  radius: 8.2,
  splashEdge: 0.5,
} as const;

/**
 * 每只僵尸出生时的体型抖动范围。
 *
 * 之前同一种怪长得一模一样，一片尸潮看过去像复制粘贴。给每只一个固定的
 * 体型系数，人群里就有高有矮有壮有瘦——这是"尸潮"和"方阵"最直观的区别。
 * 精英和 Boss 抖动幅度收窄：它们的体型本身就是难度提示，不能因为随机
 * 让玩家误判这只到底是什么。
 */
export const SIZE_JITTER = {
  /** 杂兵（walker/runner/spitter/leaper）。 */
  trash: 0.3,
  /** 精英（screamer/brute/titan/armored）。 */
  elite: 0.12,
} as const;

/** 嚎叫者光环：半径内的僵尸速度与伤害倍率。 */
export const SCREAMER_AURA = { radius: 12, speedMul: 1.45, damageMul: 1.35 } as const;

// ─────────────────────────── Boss ───────────────────────────

export const BOSS = {
  /**
   * 开局预览：Boss 一直吊在方阵前方这么远的地方，慢慢走。
   *
   * 取值卡在雾里（雾从 105 米开始、420 米外全糊）：看得清是个巨大的黑影在
   * 动，但看不清细节。等真打起来它就停在竞技场，玩家自己冲上去的那段路
   * 会让它在屏幕上飞快涨大——"越走越近越大"这件事是这样兑现的。
   */
  previewAhead: 168,
  /** 预览态的走路动画频率。走得慢才有"慢慢压过来"的分量。 */
  previewStride: 1.35,
  /** 血量降到这些比例时进入下一阶段。 */
  phaseThresholds: [0.66, 0.33],
  /** 践踏 AoE。 */
  slam: { telegraph: 1.15, radius: 4.4, damage: 55, cooldown: 6.5 },
  /** 召唤。 */
  summon: { count: 26, cooldown: 9.5 },
  /** 冲锋。 */
  charge: { telegraph: 1.0, speed: 26, laneHalfWidth: 3.4, damage: 40, cooldown: 11 },
  /** 天降雷击：随机点位、收缩的准星预警、小范围高伤害。 */
  lightning: { telegraph: 1.3, radius: 4.0, damage: 60, cooldown: 10.5 },
  /** Boss 停在竞技场里离方阵多远。 */
  standoff: 22,
  /**
   * 狂暴。打到这个时间还没解决，Boss 的技能频率和伤害就一路往上爬。
   * 这保证 Boss 战一定会分出胜负，而不是火力不够时耗成一场僵局。
   */
  enrage: { after: 20, rampPerSecond: 0.09, maxSpeed: 4.0, maxDamage: 4.0 },
} as const;

// ─────────────────────────── 中 Boss ───────────────────────────

/**
 * 五个 Boss 各自的招式组合。
 *
 * 之前五关共用同一套"践踏 + 召唤 + 冲锋 + 落雷"，换的只有血量和名字——
 * 打完第一关，后面四个 Boss 就没有任何新东西要学了。现在每个 Boss 有一套
 * 自己的招式，而且每一招都在考不同的东西：
 *
 *  · overlord 深渊领主 —— 教学：一个圆圈 AoE + 召唤，学会"看地上的圈就走开"
 *  · plague   腐化巨兽 —— 半场毒爆左右交替，逼你踩着节奏来回横跳
 *  · maw      尸山之王 —— 一堵带缺口的火墙推过来，必须站进缺口里
 *  · apostle  猩红使徒 —— 一道扫过整条路的光束，得一直跑在它前面
 *  · ender    终末之主 —— 潜地无敌 + 放尸潮，浮上来之后前面几招轮着上
 */
export type BossKind = 'overlord' | 'plague' | 'maw' | 'apostle' | 'ender';

export type BossAbility =
  | { readonly a: 'slam'; readonly cd: number }
  | { readonly a: 'summon'; readonly cd: number; readonly count: number }
  | { readonly a: 'charge'; readonly cd: number }
  | { readonly a: 'lightning'; readonly cd: number }
  /** 半场毒爆：整条路的左半或右半整块爆掉，左右交替。 */
  | { readonly a: 'quake'; readonly cd: number; readonly telegraph: number; readonly damage: number; readonly depth: number }
  /** 火墙推进：一堵横贯路面的墙压过来，只有一个缺口是安全的。 */
  | { readonly a: 'breath'; readonly cd: number; readonly telegraph: number; readonly damage: number; readonly gapHalf: number }
  /** 扫射光束：从 Boss 身上甩出一道扫过整条路的光束。 */
  | { readonly a: 'beam'; readonly cd: number; readonly telegraph: number; readonly damage: number; readonly halfWidth: number }
  /** 潜地：一段时间无敌并持续放尸潮。 */
  | { readonly a: 'submerge'; readonly cd: number; readonly seconds: number; readonly perSecond: number };

export interface BossPlan {
  readonly abilities: readonly BossAbility[];
}

export const BOSS_PLANS: Record<BossKind, BossPlan> = {
  overlord: {
    abilities: [
      { a: 'slam', cd: 6.5 },
      { a: 'summon', cd: 9.5, count: 26 },
      { a: 'charge', cd: 11 },
    ],
  },
  plague: {
    abilities: [
      { a: 'quake', cd: 5.2, telegraph: 1.25, damage: 52, depth: 30 },
      { a: 'slam', cd: 8.5 },
      { a: 'summon', cd: 11, count: 30 },
    ],
  },
  maw: {
    abilities: [
      { a: 'breath', cd: 7.0, telegraph: 1.5, damage: 78, gapHalf: 3.4 },
      { a: 'summon', cd: 8.0, count: 40 },
      { a: 'slam', cd: 9.5 },
    ],
  },
  apostle: {
    abilities: [
      { a: 'beam', cd: 7.5, telegraph: 1.35, damage: 46, halfWidth: 2.6 },
      { a: 'lightning', cd: 8.5 },
      { a: 'charge', cd: 12 },
    ],
  },
  ender: {
    abilities: [
      { a: 'submerge', cd: 15, seconds: 5, perSecond: 14 },
      { a: 'beam', cd: 8.5, telegraph: 1.2, damage: 54, halfWidth: 2.8 },
      { a: 'quake', cd: 9.0, telegraph: 1.1, damage: 60, depth: 32 },
      { a: 'slam', cd: 10 },
    ],
  },
};

/**
 * 中 boss 只有一个技能：贴近方阵后周期性地放一圈以自身为中心的冲击波。
 * 没有阶段、没有狂暴——它不halt 方阵推进，就是行进路上一只格外硬、
 * 会炸人的强化精英，机制刻意比终极 Boss 简单很多。
 */
export const MIDBOSS = {
  shock: { telegraph: 1.0, radius: 3.8, damage: 45, cooldown: 8 },
} as const;

// ─────────────────────────── 障碍方块 ───────────────────────────

export const BLOCK = {
  /** 打掉方块每 100 点血给多少金币。 */
  goldPerHundredHp: 0.9,
  height: 4.2,
  /** "高墙"专用高度——打穿有额外奖励的那种，视觉上要明显比普通方块高一截。 */
  wallHeight: 10,
  /**
   * 撞墙的代价：拿命填，不是拿时间填。
   *
   * 以前撞上墙是"速度降到 16%，一点点蹭过去"——手感最差的两件事全占了：
   * 干等，以及整队人从墙里穿过去。现在墙正面焊满倒刺：撞上去的人直接被
   * 串死，方阵**不减速**地撞穿它，墙碎、人也没了一片。
   *
   * 这样"打穿 / 绕开 / 硬闯"才是三个真选择：
   *  · 在撞上之前用火力打穿 → 拿奖励，一个人不少
   *  · 换一排走            → 什么都没有，但毫发无伤
   *  · 直接撞过去          → 墙碎了，没有奖励，前排拿命换的路
   */
  spikes: {
    /** 方阵推进到离墙这么近就开始被刺穿。 */
    reach: 2.4,
    /** 每秒串死的人数 = 当前兵力 × 这个比例。 */
    rateShare: 0.9,
    /** 但每秒最多串死这么多——不然满编方阵一撞就没。 */
    maxRate: 55,
  },
  /**
   * "全宽"方块其实留了两条路肩缝。方阵挤不过去（所以只能贴着缝一点点蹭），
   * 这个值必须跟着 ROAD_HALF 走：路面从 18 米拉宽到 24 米之后还留 7.2，
   * 两侧缝子就有 4.8 米宽，方阵直接绕着走了，"全宽"名存实亡。
   * 但僵尸能从缝里挤进来 —— 这样才不会出现"尸潮直接穿模走过钢块"的画面，
   * 同时保住了"一边啃方块一边被尸潮压上来"的压迫感。
   */
  fullSpanHalfWidth: 9.2,
  /**
   * 方块是装甲的，必须凑近才打得动。
   * 没有这个限制的话，方阵会在三十米外就把它拆了，广告里那个
   * "撞上一堵写着大数字的墙、被迫停下来硬啃"的名场面就没了。
   */
  engageRange: 15,
} as const;

// ─────────────────────────── 路边金币 ───────────────────────────

/** 撒在路上、走过去就自动捡的金币堆——不需要打，纯白捡。 */
export const GOLD_PICKUP = {
  /**
   * 捡取的横向判定半径（叠加方阵自身半宽）。
   * 之前完全不判横向，走到 z 就自动入袋——散落的 x 坐标纯属装饰。
   * 现在必须真的开过去，路边的金币才第一次成为"要不要为它偏离安全车道"的决策。
   */
  reach: 2.2,
  /**
   * 方阵自身半宽计入判定时的封顶值。
   * 不封顶的话，满编方阵半宽接近 6，加上 reach 就覆盖了整条路——
   * 走正中间也能把两侧的金币全扫进来，横向判定等于没做。
   */
  bodyReachCap: 2.4,
  /** 平均间隔（米），实际按这个乘一个 0.7~1.3 的随机系数。 */
  spacing: 16,
  amountMin: 8,
  amountMax: 22,
} as const;

// ─────────────────────────── 金币 / 商店 ───────────────────────────

export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly desc: string;
  readonly maxLevel: number;
  /** 第 n 级（从 0 开始）的价格。 */
  readonly cost: (level: number) => number;
  /** 代价：专精模块的负面效果，商店里要和收益并排显示。 */
  readonly drawback?: string;
  /** 不占装备位（目前只有"装备位"本身）。 */
  readonly passive?: boolean;
}

export type UpgradeId =
  | 'squad' | 'damage' | 'fireRate' | 'cannon' | 'armor' | 'weapon'
  // 装备位本身：唯一不占位的升级
  | 'slots'
  // 专精模块：每一个都带一条真实的代价，不存在"全买了就无敌"
  | 'heavyGuns' | 'horde' | 'scavenger' | 'strikeSpec' | 'vanguard';

/**
 * 出征装备位。
 *
 * 这是整个 meta 层最重要的一条规则：**商店买满 ≠ 全部生效**。
 * 之前十几个升级全买满以后，每一局开场就已经赢了——岔路口选什么都无所谓，
 * 关卡设计的所有取舍瞬间失效，游戏变成看一段动画。改成买到的东西是"你拥有
 * 的模块库"，每一局只能带 3~5 个上场，于是：
 *  · 满配玩家依然要在开局前做一次真实的取舍；
 *  · 局内的随机岔路开始和你带的 build 互动（带了火炮就想走尸潮车道）；
 *  · 继续买升级仍然有意义——买的是**更多的可能性**，不是更高的数字。
 */
export const LOADOUT = {
  /**
   * 一开始就有的装备位数量。
   *
   * 4 是实测出来的：3 个位子会让中期存档卡在第一关过不去（连"兵力 + 伤害 +
   * 武器 + 射速"这套最基本的组合都凑不齐），6 个位子又能把六个基础模块全带上，
   * 等于没加这套系统。4 起步、花钱升到 5，正好卡在"每一局都得砍掉点什么"。
   */
  base: 4,
  /** 买满 slots 之后的上限。 */
  max: 5,
} as const;

export const UPGRADES: readonly UpgradeDef[] = [
  // ── 装备位：唯一不占位的升级，买的是"能同时带几个模块" ──
  { id: 'slots',    name: '出征编制', desc: '+1 个出征装备位（4 → 5）',   maxLevel: 1,  cost: () => 2600, passive: true },

  // ── 基础模块：稳、没有代价，但每个都要占一个位 ──
  { id: 'squad',    name: '起始兵力', desc: '每级 +2 名起始士兵',       maxLevel: 12, cost: (l) => 120 + l * 95 },
  { id: 'damage',   name: '弹药强化', desc: '每级 +8% 全队伤害',        maxLevel: 12, cost: (l) => 150 + l * 120 },
  { id: 'fireRate', name: '枪械保养', desc: '每级 +6% 全队射速',        maxLevel: 10, cost: (l) => 160 + l * 130 },
  { id: 'cannon',   name: '炮兵编制', desc: '每级 +1 门起始大炮',        maxLevel: 6,  cost: (l) => 350 + l * 300 },
  { id: 'armor',    name: '防弹背心', desc: '每级 +14% 士兵生命',       maxLevel: 10, cost: (l) => 140 + l * 110 },
  // 后期关卡的硬门槛：光堆人头打不动 Boss，必须把起始火力提上来
  // 八级武器表里插进了霰弹枪，等级整体后移了一格——上限跟着提到 4，
  // 顶配起手仍然是轻机枪，和加霰弹枪之前保持一致
  { id: 'weapon',   name: '制式装备', desc: '每级起始武器 +1 级',        maxLevel: 4,  cost: (l) => 900 + l * 1450 },

  // ── 专精模块：收益更高，但每一个都在别的地方挖一个坑 ──
  // 带代价的模块才是构筑的骨架：没有代价的东西只有"够不够强"，
  // 有代价的东西才有"配不配得上我这一套"。
  { id: 'heavyGuns',  name: '重炮编队', desc: '每级 +2 门起始大炮',   drawback: '每级 −12% 起始兵力', maxLevel: 3, cost: (l) => 600 + l * 520 },
  { id: 'horde',      name: '人海战术', desc: '每级 +8 名起始士兵',   drawback: '每级 −7% 全队伤害',  maxLevel: 4, cost: (l) => 420 + l * 380 },
  { id: 'vanguard',   name: '轻装突击', desc: '每级 +9% 推进速度',     drawback: '每级 −10% 士兵生命', maxLevel: 3, cost: (l) => 500 + l * 460 },
  { id: 'scavenger',  name: '拾荒专精', desc: '每级 +22% 局内金币',    drawback: '不提供任何战斗力',   maxLevel: 3, cost: (l) => 480 + l * 420 },
  { id: 'strikeSpec', name: '空袭引导', desc: '每级本局 +1 发空袭、+10% 范围', drawback: '不提供任何被动战力', maxLevel: 3, cost: (l) => 560 + l * 500 },
];

export const UPGRADE_EFFECT = {
  squadPerLevel: 2,
  damagePerLevel: 0.08,
  fireRatePerLevel: 0.06,
  armorPerLevel: 0.14,

  // 专精模块：正面 + 代价成对出现
  heavyGunsCannon: 2,
  heavyGunsSoldierPenalty: 0.12,
  hordeSoldiers: 8,
  hordeDamagePenalty: 0.07,
  vanguardSpeed: 0.09,
  vanguardHpPenalty: 0.10,
  scavengerGold: 0.22,
  /** 空袭引导每级多带一发。 */
  strikeCharges: 1,
  strikeRadius: 0.10,
} as const;

/** 起始配置（未买任何升级时）。 */
export const START = {
  soldiers: 12,
  weaponLevel: 0,
  cannons: 0,
} as const;
