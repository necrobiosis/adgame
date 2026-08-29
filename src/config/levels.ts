import type { Lane } from '../sim/lanes';
import type { BossKind, EnemyKind } from './balance';

/** 门的效果类型。 */
export type GateType =
  | 'add'       // +N 士兵
  | 'mul'       // ×N 士兵
  | 'sub'       // -N 士兵（惩罚门）
  | 'div'       // ÷N 士兵（惩罚门）
  | 'weapon'    // 武器 +N 级
  | 'cannon'    // 大炮 +N 门
  | 'gold'      // +N 金币
  | 'armor'     // 护甲 +N%
  | 'firerate'; // 射速 +N%

export interface GateSpec {
  readonly type: GateType;
  readonly value: number;
  /**
   * 过这个门要付的金币。0 / 不填 = 免费。
   *
   * 金币在这之前**完全没有局内用途**，只是结算时入账的分数。标价车道让它
   * 第一次成为可以花掉的资源：付费买当下的战力，代价是结算时进兵工厂的钱
   * 变少——路边捡的每一枚金币、打穿高墙拿的每一份奖励，从此都要在
   * "现在变强"和"以后变强"之间做取舍。
   *
   * 钱不够就走不了这条车道（照常前进，但拿不到增益），所以它同时也是一道
   * 软门槛：想吃那条更强的线，就得先去把路边的钱捡够。
   */
  readonly cost?: number;
}

export interface WaveGroup {
  /**
   * 这一组怪长在哪一排。不写就按组序轮着分排。
   *
   * 指定它才能做出"左边一排全是泰坦、右边一排全是杂兵"这种可读的战场；
   * 玩家在远处看一眼就知道该往哪走，而不是等它们糊到脸上才发现。
   */
  readonly lane?: Lane;
  readonly kind: EnemyKind;
  readonly count: number;
}

export interface WaveSpec {
  /** 这一波的构成。 */
  readonly groups: readonly WaveGroup[];
  /** 从触发点往前多远开始刷（米）。 */
  readonly spawnAhead?: number;
  /** 刷怪铺开的纵深（米），越大越像"一整片坡道上的尸潮"。 */
  readonly depth?: number;
}

/** 一侧车道：过这个门 → 吃这个增益 + 遇到这波怪。 */
export interface LaneChoice {
  readonly gate: GateSpec;
  readonly wave: WaveSpec;
  /** 门前的车道预告，例如 "蜂群" / "精英"。 */
  readonly hint: string;
}


export type Beat =
  | { readonly t: 'run'; readonly len: number }
  /**
   * 尸潮涌现：同一批怪在 `seconds` 秒里分 `pulses` 波连续涌出来，
   * 而不是一次性刷完。
   *
   * 一次性刷 500 只的结果是它们排成一堵墙一起推过来，打完就没了；
   * 拆成十几秒的连续涌现，压迫感完全不同——你永远看得到后面还有一层，
   * 前排刚清掉下一层就压上来了。后面几关靠它撑起"尸潮"的体感。
   */
  | { readonly t: 'surge'; readonly seconds: number; readonly pulses: number; readonly wave: WaveSpec }
  /**
   * 岔路口。
   *
   * 不给 left/right 就是**每局现掷**（见 sim/GateRoll.ts）——给什么增益、
   * 多少、标不标价、在哪一侧、后面跟哪种怪，全按本局种子随机。同一关玩两遍
   * 看到的岔路不一样，才有 roguelike 那种"这把开出了什么"的感觉。
   * 显式写死 left/right 仍然支持，用来钉住教学关的头几个门。
   */
  | { readonly t: 'choice'; readonly left?: LaneChoice; readonly right?: LaneChoice }
  | { readonly t: 'wave'; readonly wave: WaveSpec }
  | {
      readonly t: 'block';
      readonly hp: number;
      /** 这堵墙长在哪一排。没有全宽墙——挡死整条路的墙不是选择。 */
      readonly lane: Lane;
      /** 打穿后额外再给这么多金币——"奖励墙"用，不给就是普通挡路方块。 */
      readonly bonus?: number;
      /** 高墙：视觉上明显更高。 */
      readonly tall?: boolean;
      /**
       * 军械门：门上印着这把武器（WEAPON_TIERS 下标），打穿了就换上它。
       * 带这个字段的门不长倒刺——它不扎人，只是打不开就进不去。
       */
      readonly weapon?: number;
    }
  | { readonly t: 'midboss'; readonly hp: number; readonly scale: number; readonly name: string }
  | { readonly t: 'boss'; readonly hp: number; readonly scale: number; readonly name: string; readonly kind: BossKind };

export interface LevelDef {
  readonly id: number;
  readonly name: string;
  readonly subtitle: string;
  readonly beats: readonly Beat[];
  /** 通关奖励金币。 */
  readonly clearGold: number;
  /** 本关所有普通敌人的血量倍率（配合玩家逐关变强的火力曲线）。 */
  /**
   * 杂兵血量的关卡缩放。
   *
   * 这一列跟着两次玩法改动来回调过：
   *  · 路切成三排、枪不自瞄 → 火力一次只覆盖一排，先下调过一档；
   *  · 射程改成无限、加上穿透 → 怪从一百多米外就开始挨打，命中时间翻了几倍，
   *    于是又整体上调回来并且拉得更开。难度要来自"你站错排了"和"这一排的怪
   *    厚得你削不完"，不是"你根本够不着"。
   */
  readonly enemyHpScale: number;
  /**
   * 无尽模式：没有终点也没有 Boss 战，怪一路变强直到你顶不住。
   * 打开之后血量缩放改成"按推进距离无上限地涨"，胜利条件也不再存在。
   */
  readonly endless?: boolean;
}

// 常用波次的简写构造器 ────────────────────────────────────────────

const swarm = (walkers: number, runners = 0, depth = 26): WaveSpec => ({
  groups: runners > 0
    ? [{ kind: 'walker', count: walkers }, { kind: 'runner', count: runners }]
    : [{ kind: 'walker', count: walkers }],
  depth,
});

const elite = (groups: readonly WaveGroup[], depth = 16): WaveSpec => ({ groups, depth });

// ─────────────────────────────────────────────────────────────
// 5 关。
//
// 设计节奏：开场小波 → 门 A → 方块 → 门 B → 中段大潮 → 门 C → 终波 → Boss
//
// 每组门都是「数量 vs 质量」，而且**门后那条车道的怪物品质和门给的增益是绑定的**：
//   · 蜂群车道：几百只小僵尸 → 需要溅射（大炮）或纯人海去扛
//   · 精英车道：几只巨怪    → 需要单体高伤（武器等级）
// 拿错工具走错路会滚雪球式崩盘，这就是这个游戏真正的策略层。
//
// 惩罚门（-N / ÷N）永远配一条"几乎没怪的安全通道"：
// 用一半兵力换一段太平路，还是硬吃强化去打泰坦，这是个真实的取舍。
// ─────────────────────────────────────────────────────────────

const LEVEL_1: LevelDef = {
  id: 1,
  name: '第一关 · 跨海大桥',
  subtitle: '尸潮初现',
  clearGold: 260,
  enemyHpScale: 3,
  beats: [
    { t: 'run', len: 49 },
    { t: 'wave', wave: swarm(46) },
    { t: 'run', len: 58 },
    {
      t: 'choice',
      left:  { gate: { type: 'add', value: 26 }, wave: swarm(110, 8), hint: '蜂群' },
      right: { gate: { type: 'weapon', value: 1 }, wave: elite([{ kind: 'screamer', count: 3 }, { kind: 'walker', count: 30 }]), hint: '精英' },
    },
    { t: 'run', len: 75 },
    // 军械门：门上印着一把冲锋枪。在撞上它之前打穿，枪就归你；
    // 打不开就被挤到旁边那一排，什么都没有。第一关就把这条规则教掉。
    { t: 'block', hp: 350000, lane: 'left', weapon: 2, tall: true },
    { t: 'run', len: 44 },
    { t: 'choice' },
    { t: 'run', len: 73 },
    { t: 'midboss', hp: 2200, scale: 1.0, name: '锈蚀行者' },
    { t: 'choice' },
    { t: 'run', len: 70 },
    { t: 'wave', wave: swarm(200, 20) },
    { t: 'run', len: 58 },
    { t: 'boss', hp: 36000, scale: 1.0, name: '深渊领主', kind: 'overlord' },
  ],
};

const LEVEL_2: LevelDef = {
  id: 2,
  name: '第二关 · 高架断层',
  subtitle: '它们学会了跑',
  clearGold: 420,
  enemyHpScale: 5.6,
  beats: [
    { t: 'run', len: 44 },
    { t: 'wave', wave: swarm(70, 10) },
    { t: 'run', len: 52 },
    { t: 'choice' },
    { t: 'run', len: 67 },
    { t: 'block', hp: 4200, lane: 'mid', bonus: 150, tall: true },
    { t: 'run', len: 38 },
    { t: 'choice' },
    { t: 'run', len: 73 },
    // 军械门：走到它那一排上，在撞上之前打穿就换一把新枪；
    // 打不开就被挤到旁边那一排去——赌的是"我的火力够不够"。
    { t: 'block', hp: 400000, lane: 'right', weapon: 3, tall: true },
    { t: 'run', len: 16 },
    { t: 'midboss', hp: 5500, scale: 1.08, name: '疫化魁首' },
    { t: 'choice' },
    { t: 'run', len: 64 },
    { t: 'wave', wave: swarm(300, 40) },
    { t: 'run', len: 58 },
    { t: 'boss', hp: 95000, scale: 1.1, name: '腐化巨兽', kind: 'plague' },
  ],
};

const LEVEL_3: LevelDef = {
  id: 3,
  name: '第三关 · 尸山阶梯',
  subtitle: '整座桥都在动',
  clearGold: 640,
  enemyHpScale: 9.5,
  beats: [
    { t: 'run', len: 41 },
    { t: 'wave', wave: swarm(120, 18) },
    { t: 'run', len: 46 },
    { t: 'choice' },
    { t: 'run', len: 58 },
    { t: 'block', hp: 11000, lane: 'mid', bonus: 220, tall: true },
    { t: 'run', len: 35 },
    { t: 'choice' },
    { t: 'run', len: 67 },
    // 军械门：走到它那一排上，在撞上之前打穿就换一把新枪；
    // 打不开就被挤到旁边那一排去——赌的是"我的火力够不够"。
    { t: 'block', hp: 300000, lane: 'right', weapon: 4, tall: true },
    { t: 'run', len: 32 },
    { t: 'midboss', hp: 9500, scale: 1.15, name: '尸潮领班' },
    { t: 'choice' },
    { t: 'run', len: 61 },
    { t: 'surge', seconds: 13, pulses: 5, wave: swarm(48, 6, 30) },
    { t: 'run', len: 55 },
    { t: 'boss', hp: 160000, scale: 1.2, name: '尸山之王', kind: 'maw' },
  ],
};

const LEVEL_4: LevelDef = {
  id: 4,
  name: '第四关 · 猩红黎明',
  subtitle: '泰坦成群出现',
  clearGold: 880,
  enemyHpScale: 17,
  beats: [
    { t: 'run', len: 38 },
    { t: 'wave', wave: swarm(210, 32) },
    { t: 'run', len: 44 },
    { t: 'choice' },
    { t: 'run', len: 55 },
    { t: 'block', hp: 24000, lane: 'mid', bonus: 300, tall: true },
    { t: 'run', len: 32 },
    { t: 'choice' },
    { t: 'run', len: 48 },
    // 军械门：走到它那一排上，在撞上之前打穿就换一把新枪；
    // 打不开就被挤到旁边那一排去——赌的是"我的火力够不够"。
    { t: 'block', hp: 320000, lane: 'left', weapon: 5, tall: true },
    { t: 'run', len: 16 },
    { t: 'midboss', hp: 15000, scale: 1.25, name: '赤红囚徒' },
    { t: 'choice' },
    { t: 'run', len: 58 },
    { t: 'surge', seconds: 20, pulses: 11, wave: swarm(64, 12, 32) },
    { t: 'run', len: 52 },
    { t: 'boss', hp: 260000, scale: 1.35, name: '猩红使徒', kind: 'apostle' },
  ],
};

const LEVEL_5: LevelDef = {
  id: 5,
  name: '第五关 · 世界终点',
  subtitle: '最后一座桥',
  clearGold: 1400,
  enemyHpScale: 28,
  beats: [
    { t: 'run', len: 35 },
    { t: 'wave', wave: swarm(280, 44) },
    { t: 'run', len: 38 },
    { t: 'choice' },
    { t: 'run', len: 49 },
    { t: 'block', hp: 46000, lane: 'mid', bonus: 460, tall: true },
    { t: 'run', len: 29 },
    { t: 'choice' },
    { t: 'run', len: 58 },
    // 军械门：走到它那一排上，在撞上之前打穿就换一把新枪；
    // 打不开就被挤到旁边那一排去——赌的是"我的火力够不够"。
    // 最后一扇门上印的是湮灭者。九万血——满配也未必打得开，
    // 这是全场最贵的一次赌。
    { t: 'block', hp: 300000, lane: 'left', weapon: 7, tall: true },
    { t: 'run', len: 29 },
    { t: 'midboss', hp: 24000, scale: 1.35, name: '深渊先驱' },
    { t: 'choice' },
    { t: 'run', len: 67 },
    { t: 'surge', seconds: 22, pulses: 12, wave: elite([{ kind: 'brute', count: 2 }, { kind: 'walker', count: 38 }, { kind: 'runner', count: 9 }], 32) },
    { t: 'run', len: 55 },
    // 1.55 的体型在竖屏里根本框不下——镜头只能拍到胸口，头、背刃、破布
    // 全在画面外，"长得不一样"这件事等于白做。1.35 仍然是全场最大的一只
    // （建模身高 3.5 米，比前面几只高出一截），但整个剪影进得了画。
    { t: 'boss', hp: 420000, scale: 1.35, name: '终末之主', kind: 'ender' },
  ],
};

export const LEVELS: readonly LevelDef[] = [LEVEL_1, LEVEL_2, LEVEL_3, LEVEL_4, LEVEL_5];

/** 无尽模式的关卡号。故意取一个战役用不到的值。 */
export const ENDLESS_ID = 99;

/**
 * 无尽模式的赛道。
 *
 * 一段固定的节奏循环重复很多轮，每一轮的怪都更多更硬：
 *   跑 → 尸潮 → 岔路 → 高墙 → 连续涌现 → 中 Boss → 岔路
 *
 * 没有终点、没有终极 Boss。怪的血量由 World 按推进距离无上限地拉，
 * 中 Boss 的血量和体型也一轮比一轮大——玩到死为止，成绩就是你走了多远。
 * 岔路本身仍然是每局现掷的，所以两把无尽不会长一个样。
 */
const ENDLESS_CYCLES = 80;

function buildEndless(): LevelDef {
  const beats: Beat[] = [];
  for (let c = 0; c < ENDLESS_CYCLES; c++) {
    const p = c + 1;
    /**
     * 数量封顶、强度不封顶。
     *
     * 一直堆数量的话，几百轮之后一波就是上千只——渲染扛不住，而且屏幕上
     * 糊成一片反而没有压迫感。所以刷怪量爬到第 16 轮就不再涨，之后"越来越强"
     * 全部由血量缩放承担（World.currentHpScale 按距离无上限地拉）。
     */
    const q = Math.min(p, 16);
    beats.push({ t: 'run', len: 46 });
    beats.push({ t: 'wave', wave: swarm(50 + q * 22, 6 + q * 4) });
    beats.push({ t: 'run', len: 42 });
    beats.push({ t: 'choice' });
    beats.push({ t: 'run', len: 40 });
    // 每隔一轮来一堵奖励高墙，给"要不要停下来啃"一个反复出现的决策点
    if (c % 2 === 1) {
      beats.push({
        t: 'block', hp: 1800 * p, lane: c % 3 === 1 ? 'left' : c % 3 === 2 ? 'mid' : 'right',
        bonus: 60 * p, tall: true,
      });
      beats.push({ t: 'run', len: 30 });
    }
    beats.push({ t: 'surge', seconds: 9 + q * 0.6, pulses: 5 + Math.floor(q / 3), wave: swarm(26 + q * 7, 3 + q * 2, 30) });
    beats.push({ t: 'run', len: 44 });
    beats.push({ t: 'midboss', hp: 1800 + p * 1500, scale: 1 + p * 0.045, name: '腐蚀主宰' });
    beats.push({ t: 'choice' });
  }
  beats.push({ t: 'run', len: 60 });
  return {
    id: ENDLESS_ID,
    name: '无尽模式',
    subtitle: '撑到你撑不住为止',
    clearGold: 0,
    // 无尽模式里这个值是血量爬升的斜率，不是上限
    enemyHpScale: 3,
    endless: true,
    beats,
  };
}

const ENDLESS = buildEndless();

export function getLevel(id: number): LevelDef {
  if (id === ENDLESS_ID) return ENDLESS;
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, id - 1))]!;
}
