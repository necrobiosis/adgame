import type { EnemyKind } from './balance';

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
}

export interface WaveGroup {
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

export type BlockSpan = 'left' | 'right' | 'full';

export type Beat =
  | { readonly t: 'run'; readonly len: number }
  | { readonly t: 'choice'; readonly left: LaneChoice; readonly right: LaneChoice }
  | { readonly t: 'wave'; readonly wave: WaveSpec }
  | {
      readonly t: 'block';
      readonly hp: number;
      readonly span: BlockSpan;
      /** 打穿后额外再给这么多金币——"奖励墙"用，不给就是普通挡路方块。 */
      readonly bonus?: number;
      /** 高墙：视觉上明显更高（配合 span 'left'/'right' 用——只挡半条路，可以绕过去）。 */
      readonly tall?: boolean;
    }
  | { readonly t: 'midboss'; readonly hp: number; readonly scale: number; readonly name: string }
  | { readonly t: 'boss'; readonly hp: number; readonly scale: number; readonly name: string };

export interface LevelDef {
  readonly id: number;
  readonly name: string;
  readonly subtitle: string;
  readonly beats: readonly Beat[];
  /** 通关奖励金币。 */
  readonly clearGold: number;
  /** 本关所有普通敌人的血量倍率（配合玩家逐关变强的火力曲线）。 */
  readonly enemyHpScale: number;
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
  enemyHpScale: 2.6,
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
    // 高墙只挡半条路——硬啃能拿一笔额外奖励，也可以直接绕开
    { t: 'block', hp: 2400, span: 'left', bonus: 80, tall: true },
    { t: 'run', len: 44 },
    {
      t: 'choice',
      left:  { gate: { type: 'cannon', value: 3 }, wave: swarm(180, 16), hint: '蜂群' },
      right: { gate: { type: 'armor', value: 40 }, wave: elite([{ kind: 'brute', count: 3 }, { kind: 'walker', count: 40 }]), hint: '精英' },
    },
    { t: 'run', len: 73 },
    { t: 'midboss', hp: 2200, scale: 1.0, name: '锈蚀行者' },
    {
      t: 'choice',
      left:  { gate: { type: 'add', value: 55 }, wave: swarm(230, 24), hint: '蜂群' },
      right: { gate: { type: 'firerate', value: 45 }, wave: elite([{ kind: 'brute', count: 3 }, { kind: 'screamer', count: 3 }, { kind: 'leaper', count: 4 }]), hint: '精英' },
    },
    { t: 'run', len: 70 },
    { t: 'wave', wave: swarm(200, 20) },
    { t: 'run', len: 58 },
    { t: 'boss', hp: 36000, scale: 1.0, name: '深渊领主' },
  ],
};

const LEVEL_2: LevelDef = {
  id: 2,
  name: '第二关 · 高架断层',
  subtitle: '它们学会了跑',
  clearGold: 420,
  enemyHpScale: 5,
  beats: [
    { t: 'run', len: 44 },
    { t: 'wave', wave: swarm(70, 10) },
    { t: 'run', len: 52 },
    {
      t: 'choice',
      left:  { gate: { type: 'mul', value: 2 }, wave: swarm(200, 24), hint: '蜂群' },
      right: { gate: { type: 'weapon', value: 1 }, wave: elite([{ kind: 'brute', count: 3 }, { kind: 'screamer', count: 3 }]), hint: '精英' },
    },
    { t: 'run', len: 67 },
    { t: 'block', hp: 9000, span: 'full' },
    { t: 'run', len: 38 },
    {
      t: 'choice',
      left:  { gate: { type: 'cannon', value: 4 }, wave: swarm(280, 34), hint: '蜂群' },
      right: { gate: { type: 'armor', value: 55 }, wave: elite([{ kind: 'brute', count: 4 }, { kind: 'titan', count: 1 }, { kind: 'spitter', count: 5 }]), hint: '精英' },
    },
    { t: 'run', len: 73 },
    // 高墙只挡半条路——硬啃能拿一笔额外奖励，也可以直接绕开
    { t: 'block', hp: 7500, span: 'right', bonus: 130, tall: true },
    { t: 'run', len: 16 },
    { t: 'midboss', hp: 5500, scale: 1.08, name: '疫化魁首' },
    {
      t: 'choice',
      // 安全通道 vs 火力飞跃
      left:  { gate: { type: 'div', value: 2 }, wave: swarm(40), hint: '安全' },
      right: { gate: { type: 'weapon', value: 2 }, wave: elite([{ kind: 'titan', count: 2 }, { kind: 'brute', count: 3 }, { kind: 'armored', count: 5 }]), hint: '精英' },
    },
    { t: 'run', len: 64 },
    { t: 'wave', wave: swarm(300, 40) },
    { t: 'run', len: 58 },
    { t: 'boss', hp: 95000, scale: 1.1, name: '腐化巨兽' },
  ],
};

const LEVEL_3: LevelDef = {
  id: 3,
  name: '第三关 · 尸山阶梯',
  subtitle: '整座桥都在动',
  clearGold: 640,
  enemyHpScale: 8.5,
  beats: [
    { t: 'run', len: 41 },
    { t: 'wave', wave: swarm(120, 18) },
    { t: 'run', len: 46 },
    {
      t: 'choice',
      left:  { gate: { type: 'add', value: 60 }, wave: swarm(260, 36), hint: '蜂群' },
      right: { gate: { type: 'firerate', value: 55 }, wave: elite([{ kind: 'brute', count: 3 }, { kind: 'titan', count: 1 }, { kind: 'leaper', count: 8 }]), hint: '精英' },
    },
    { t: 'run', len: 58 },
    { t: 'block', hp: 26000, span: 'full' },
    { t: 'run', len: 35 },
    {
      t: 'choice',
      left:  { gate: { type: 'cannon', value: 6 }, wave: swarm(340, 44), hint: '蜂群' },
      right: { gate: { type: 'weapon', value: 1 }, wave: elite([{ kind: 'titan', count: 2 }, { kind: 'screamer', count: 4 }, { kind: 'armored', count: 8 }]), hint: '精英' },
    },
    { t: 'run', len: 67 },
    // 高墙只挡半条路——硬啃能拿一笔额外奖励，也可以直接绕开
    { t: 'block', hp: 18000, span: 'right', bonus: 200, tall: true },
    { t: 'run', len: 32 },
    { t: 'midboss', hp: 9500, scale: 1.15, name: '尸潮领班' },
    {
      t: 'choice',
      left:  { gate: { type: 'mul', value: 2 }, wave: swarm(380, 50), hint: '蜂群' },
      right: { gate: { type: 'armor', value: 70 }, wave: elite([{ kind: 'titan', count: 3 }, { kind: 'spitter', count: 9 }]), hint: '精英' },
    },
    { t: 'run', len: 61 },
    { t: 'wave', wave: swarm(360, 48) },
    { t: 'run', len: 55 },
    { t: 'boss', hp: 160000, scale: 1.2, name: '尸山之王' },
  ],
};

const LEVEL_4: LevelDef = {
  id: 4,
  name: '第四关 · 猩红黎明',
  subtitle: '泰坦成群出现',
  clearGold: 880,
  enemyHpScale: 14,
  beats: [
    { t: 'run', len: 38 },
    { t: 'wave', wave: swarm(150, 22) },
    { t: 'run', len: 44 },
    {
      t: 'choice',
      left:  { gate: { type: 'mul', value: 3 }, wave: swarm(320, 46), hint: '蜂群' },
      right: { gate: { type: 'weapon', value: 2 }, wave: elite([{ kind: 'brute', count: 4 }, { kind: 'titan', count: 2 }, { kind: 'spitter', count: 10 }]), hint: '精英' },
    },
    { t: 'run', len: 55 },
    { t: 'block', hp: 62000, span: 'full' },
    { t: 'run', len: 32 },
    {
      t: 'choice',
      left:  { gate: { type: 'cannon', value: 8 }, wave: swarm(420, 64), hint: '蜂群' },
      right: { gate: { type: 'armor', value: 80 }, wave: elite([{ kind: 'titan', count: 3 }, { kind: 'brute', count: 5 }, { kind: 'armored', count: 12 }]), hint: '精英' },
    },
    { t: 'run', len: 48 },
    // 高墙只挡半条路——硬啃能拿一笔额外奖励，也可以直接绕开
    { t: 'block', hp: 48000, span: 'left', bonus: 260, tall: true },
    { t: 'run', len: 16 },
    { t: 'midboss', hp: 15000, scale: 1.25, name: '赤红囚徒' },
    {
      t: 'choice',
      left:  { gate: { type: 'sub', value: 40 }, wave: swarm(60), hint: '安全' },
      right: { gate: { type: 'weapon', value: 1 }, wave: elite([{ kind: 'titan', count: 5 }, { kind: 'screamer', count: 5 }, { kind: 'leaper', count: 14 }]), hint: '精英' },
    },
    { t: 'run', len: 58 },
    { t: 'wave', wave: swarm(420, 70) },
    { t: 'run', len: 52 },
    { t: 'boss', hp: 260000, scale: 1.35, name: '猩红使徒' },
  ],
};

const LEVEL_5: LevelDef = {
  id: 5,
  name: '第五关 · 世界终点',
  subtitle: '最后一座桥',
  clearGold: 1400,
  enemyHpScale: 22,
  beats: [
    { t: 'run', len: 35 },
    { t: 'wave', wave: swarm(200, 30) },
    { t: 'run', len: 38 },
    {
      t: 'choice',
      left:  { gate: { type: 'firerate', value: 70 }, wave: swarm(400, 70), hint: '蜂群' },
      right: { gate: { type: 'weapon', value: 2 }, wave: elite([{ kind: 'titan', count: 3 }, { kind: 'brute', count: 6 }, { kind: 'armored', count: 14 }]), hint: '精英' },
    },
    { t: 'run', len: 49 },
    { t: 'block', hp: 140000, span: 'full' },
    { t: 'run', len: 29 },
    {
      t: 'choice',
      left:  { gate: { type: 'add', value: 190 }, wave: swarm(520, 90), hint: '蜂群' },
      right: { gate: { type: 'armor', value: 90 }, wave: elite([{ kind: 'titan', count: 5 }, { kind: 'spitter', count: 14 }]), hint: '精英' },
    },
    { t: 'run', len: 58 },
    // 高墙只挡半条路——硬啃能拿一笔额外奖励，也可以直接绕开
    { t: 'block', hp: 90000, span: 'left', bonus: 420, tall: true },
    { t: 'run', len: 29 },
    { t: 'midboss', hp: 24000, scale: 1.35, name: '深渊先驱' },
    {
      t: 'choice',
      left:  { gate: { type: 'cannon', value: 10 }, wave: swarm(600, 110), hint: '蜂群' },
      right: { gate: { type: 'weapon', value: 1 }, wave: elite([{ kind: 'titan', count: 7 }, { kind: 'leaper', count: 18 }, { kind: 'armored', count: 8 }]), hint: '精英' },
    },
    { t: 'run', len: 67 },
    { t: 'wave', wave: elite([{ kind: 'titan', count: 5 }, { kind: 'brute', count: 10 }, { kind: 'walker', count: 260 }], 30) },
    { t: 'run', len: 55 },
    { t: 'boss', hp: 420000, scale: 1.55, name: '终末之主' },
  ],
};

export const LEVELS: readonly LevelDef[] = [LEVEL_1, LEVEL_2, LEVEL_3, LEVEL_4, LEVEL_5];

export function getLevel(id: number): LevelDef {
  return LEVELS[Math.max(0, Math.min(LEVELS.length - 1, id - 1))]!;
}
