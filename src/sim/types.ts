import type { Lane } from './lanes';
import type { EnemyKind } from '../config/balance';
import type { GateSpec, LaneChoice, WaveSpec } from '../config/levels';

/** 方阵里的一个单位。大炮和步兵共用同一个结构。 */
export interface Unit {
  /** 稳定 id，渲染层用它做实例复用与死亡动画。 */
  id: number;
  /** 世界坐标（每帧由 Squad.layout 推导）。 */
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  isCannon: boolean;
  /** 开火冷却剩余秒数。 */
  cooldown: number;
  /** 阵型槽位（行、列），渲染层用来做整齐的行进动画。 */
  row: number;
  col: number;
  /**
   * 火力衰减用的"名次"——前面挡着多少人，换算成排。
   *
   * 和 row 分开是因为 row 会随队形压密而变（人多了列数变多、排数变少），
   * 直接拿 row 算衰减的话，一压密全队 DPS 就凭空暴涨。
   */
  rank: number;
  /** 受击闪白剩余秒数。 */
  flash: number;
}

export interface Enemy {
  id: number;
  kind: EnemyKind;
  x: number;
  z: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  /** 行走动画相位。 */
  phase: number;
  /** 体型倍率（含关卡缩放）。 */
  scale: number;
  /** 攻击冷却。 */
  attackCd: number;
  /** 受击闪白剩余秒数。 */
  flash: number;
  /**
   * 出生时定下的横向站位偏好（-1..1）。
   * 所有僵尸如果都径直朝方阵中心收拢，就会挤成一条单列纵队；
   * 给每只一个固定的偏移，尸潮才会像广告里那样铺满整个路面压过来。
   */
  laneOffset: number;
  /**
   * 出生时定下的那一排的中心线（世界 x）。
   *
   * 敌人在远处沿着它笔直往前走，进到 LANE_LOCK_RANGE 之内才开始朝方阵
   * 收拢。有了这条线，"第二排有三只泰坦"才是玩家在四十米外就读得到的信息。
   */
  laneX: number;
  /** 被嚎叫者加成的倍率，每帧重算。 */
  speedMul: number;
  damageMul: number;
  /** true = 由脚本（Boss）驱动移动，跳过默认 AI。 */
  scripted: boolean;
  /**
   * 免疫一切伤害（终末之主潜地期间）。
   * 集火目标池也会跳过它，否则方阵会对着一个打不动的目标空放整段火力。
   */
  invulnerable?: boolean;
  /** 死亡后的倒地动画剩余时间；> 0 时仍需渲染。 */
  dying: number;

  // ── 行为专用状态（只有对应种类会用到）────────────────────────
  /** 吐酸者/跳跃者的技能冷却。 */
  abilityCd?: number;
  /** 已抛出但还没落地的酸液：剩余飞行时间 + 落点。 */
  spitT?: number;
  spitX?: number;
  spitZ?: number;
  /** 跳跃者的滞空进度（0 = 在地面），以及起跳点与落点。 */
  leapT?: number;
  leapFromX?: number;
  leapFromZ?: number;
  leapToX?: number;
  leapToZ?: number;
  /** 跳跃者当前的离地高度，渲染层直接读它。 */
  airY?: number;
  /**
   * 进食倒计时。
   *
   * 咬中士兵的那一刻置为 EAT_TIME，之后逐帧递减；大于 0 时渲染层切进
   * 「啃食」姿态（弓身、低头、双手往回扒、快频率的咀嚼点头）。
   * 之前僵尸贴上来只是站着挥手，看不出它在干什么。
   */
  eating: number;
}

export interface Shell {
  id: number;
  x: number;
  y: number;
  z: number;
  /** 目标点。 */
  tx: number;
  tz: number;
  /** 飞行进度 0..1。 */
  t: number;
  /** 总飞行时间。 */
  dur: number;
  /** 抛物线顶点高度。 */
  arc: number;
}

export interface BlockObstacle {
  id: number;
  z: number;
  /** 这堵墙占的那一排。永远只有一排——没有全宽墙。 */
  lane: Lane;
  hp: number;
  maxHp: number;
  alive: boolean;
  flash: number;
  /** x 范围（含）。 */
  x0: number;
  x1: number;
  /** 打穿后除了常规按血量换算的金币，额外再给这么多——"奖励墙"用。 */
  bonus: number;
  /** 高墙：视觉上比普通方块高出一截（渲染层用，不影响碰撞判定）。 */
  tall: boolean;
  /**
   * 军械门：门上印着一把武器的图案，打穿了这把武器就归你。
   *
   * 值 = WEAPON_TIERS 的下标。和金币奖励墙是两种东西：
   *  · 金币墙焊满倒刺，硬撞过去要拿命填，拿到的是钱；
   *  · 军械门没有刺，撞上去也不死人——它只是你**打不开就进不去**的一扇门，
   *    没打开就被挤到旁边那一排去。赌的是"我的火力够不够在撞上之前打穿它"，
   *    赌赢了直接换一把更好的枪。
   */
  rewardWeapon?: number;
}

/** 路边可以直接走过去捡的金币堆。 */
export interface GoldPickup {
  id: number;
  x: number;
  z: number;
  amount: number;
  alive: boolean;
}

export interface GateGroup {
  id: number;
  z: number;
  left: LaneChoice;
  right: LaneChoice;
  /** 已经通过则不再触发。 */
  taken: boolean;
  /** 玩家选了哪边（通过后才有值）。 */
  chosen: 'left' | 'right' | null;
}

export interface PendingWave {
  wave: WaveSpec;
  /** 触发 z。 */
  z: number;
  fired: boolean;
}

export type SimEventType =
  | 'shot'          // 步枪开火（含曳光弹端点）
  | 'cannonFire'    // 大炮开火
  | 'shellImpact'   // 炮弹落地爆炸
  | 'kill'          // 敌人死亡
  | 'hitBig'        // 大型敌人受伤（用来飘伤害数字）
  | 'soldierDown'   // 士兵阵亡
  | 'gate'          // 通过门
  | 'blockHit'
  | 'blockDestroyed'
  | 'gold'          // 掉落金币
  | 'bossSpawn'
  | 'bossPhase'
  | 'bossSlam'      // AoE 预警出现
  | 'bossSlamHit'
  | 'bossCharge'
  | 'bossLightning'    // 雷击预警出现
  | 'bossLightningHit' // 落雷
  | 'bossQuake'        // 半场毒爆预警
  | 'bossQuakeHit'
  | 'bossBreath'       // 火墙预警（x 是安全缺口的中心）
  | 'bossBreathHit'
  | 'bossBeam'         // 扫射光束起手
  | 'bossBeamHit'
  | 'bossSubmerge'     // Boss 潜地（无敌 + 持续放尸潮）
  | 'bossEmerge'       // Boss 浮出
  | 'midbossSpawn'
  | 'midbossAbility'    // 冲击波预警出现
  | 'midbossAbilityHit' // 冲击波命中
  | 'goldPickup'        // 走过路边的金币堆
  | 'spitterFire'       // 吐酸者抛射（落点预警出现）
  | 'spitterHit'        // 酸液落地
  | 'leaperJump'        // 跳跃者起跳
  | 'leaperLand'        // 跳跃者落进阵型
  | 'bite'              // 僵尸咬中士兵（喷血 + 湿闷的撕咬声）
  | 'impaled'           // 士兵被墙上的倒刺串死
  | 'weaponPickup'      // 打穿军械门，换上门上印的那把枪
  | 'armoryLost'        // Boss 到了，军械门还没打掉——机会作废
  | 'blockSmashed'      // 方阵硬撞穿了一堵没打掉的墙（没有奖励）
  | 'bomberBlast'       // 自爆尸在方阵里炸开
  | 'strikeCall'        // 呼叫空袭
  | 'strikeImpact'      // 空袭落弹
  | 'win'
  | 'lose';

export interface SimEvent {
  type: SimEventType;
  x?: number;
  y?: number;
  z?: number;
  /** 目标点（曳光弹终点 / 冲锋方向）。 */
  tx?: number;
  ty?: number;
  tz?: number;
  amount?: number;
  text?: string;
  color?: number;
  kind?: EnemyKind;
  gate?: GateSpec;
  side?: 'left' | 'right';
  radius?: number;
}

export type Phase = 'running' | 'won' | 'lost';
