import type { GateSpec, LaneChoice, WaveGroup, WaveSpec } from '../config/levels';
import type { Rng } from '../core/Rng';

/**
 * 岔路口的随机生成。
 *
 * 之前 15 个岔路是写死在关卡里的常量——同一关玩第二遍，看到的是一模一样的
 * 两个选项，第三遍就变成背答案了。改成每一局按种子现掷：给什么增益、多少、
 * 标不标价、哪一侧、后面跟哪种怪，全都在开局那一刻才定下来。
 *
 * 但"随机"不等于"乱给"，这里有三条硬规则：
 *  1. **两侧必须是不同类别的增益**——都给兵力的两个门不构成选择。
 *  2. **增益和它那条车道的怪是绑定的**：给火炮/兵力的一侧配尸潮，给武器/射速
 *     的一侧配精英。玩家学到的克制关系必须一直成立，否则随机就变成了抛硬币。
 *  3. **左右随机对调**——不这么做的话，"永远走右边"依然是一条能通吃的策略。
 */

/** 增益类别。同一次岔路的两侧必须来自不同类别。 */
type Category = 'bodies' | 'firepower' | 'artillery' | 'armor';

/** 这条车道后面跟的是尸潮还是精英——决定用哪种怪，也决定牌子上的提示词。 */
type LaneFlavour = 'swarm' | 'elite';

interface Offer {
  gate: GateSpec;
  /** 这个增益天然对应哪种战场。 */
  flavour: LaneFlavour;
}

/** 每个类别对应的车道性质：拿人海/火炮就去趟尸潮，拿单体火力就去趟精英。 */
const FLAVOUR: Record<Category, LaneFlavour> = {
  bodies: 'swarm',
  artillery: 'swarm',
  firepower: 'elite',
  armor: 'elite',
};

/**
 * 掷一个增益。
 * `power` 综合了关卡和这是本关第几个门，用来缩放数值。
 */
function rollOffer(rng: Rng, cat: Category, power: number): Offer {
  const jitter = (v: number, amp = 0.22) => Math.max(1, Math.round(v * (1 - amp + rng.next() * amp * 2)));
  let gate: GateSpec;
  switch (cat) {
    case 'bodies':
      gate = rng.next() < 0.4
        ? { type: 'mul', value: power >= 4 ? 3 : 2 }
        : { type: 'add', value: jitter(16 * power) };
      break;
    case 'firepower':
      gate = rng.next() < 0.55
        ? { type: 'weapon', value: power >= 4.5 ? 2 : 1 }
        : { type: 'firerate', value: jitter(34 + power * 7) };
      break;
    case 'artillery':
      gate = { type: 'cannon', value: jitter(1.6 + power * 0.85) };
      break;
    case 'armor':
      gate = { type: 'armor', value: jitter(28 + power * 9) };
      break;
  }
  return { gate, flavour: FLAVOUR[cat] };
}

/** 按车道性质和强度掷一波怪。 */
function rollWave(rng: Rng, flavour: LaneFlavour, power: number, heavy: boolean): WaveSpec {
  const k = heavy ? 1.45 : 1;
  if (flavour === 'swarm') {
    const walkers = Math.round((60 + power * 52) * k * (0.85 + rng.next() * 0.4));
    const runners = Math.round(walkers * (0.08 + rng.next() * 0.12));
    const groups: WaveGroup[] = [{ kind: 'walker', count: walkers }, { kind: 'runner', count: runners }];
    // 幼体：尸潮车道的主要密度来源。数量大到只能靠射速和溅射清，
    // 单只却弱到不构成威胁——"多"本身才是这条车道的问题。
    groups.push({ kind: 'swarmling', count: Math.round(walkers * (0.22 + power * 0.05)) });
    // 后期尸潮里混一点会跳的，逼玩家不能只顾前排
    if (power >= 3 && rng.next() < 0.5) {
      groups.push({ kind: 'leaper', count: Math.round(4 + power * 2) });
    }
    // 自爆尸：混在人堆里走过来，看漏了就是一片人没了
    if (power >= 2.5 && rng.next() < 0.55) {
      groups.push({ kind: 'bomber', count: Math.round(1 + power * 0.7) });
    }
    return { groups, depth: 26 + power * 2 };
  }
  // 精英车道：种类随强度解锁，越往后越杂
  const groups: WaveGroup[] = [];
  const heavies = Math.round((1.4 + power * 0.7) * k);
  if (power >= 3.5) groups.push({ kind: 'titan', count: Math.max(1, Math.round(heavies * 0.5)) });
  groups.push({ kind: 'brute', count: Math.max(1, heavies) });
  const flavourRoll = rng.next();
  if (power >= 2 && flavourRoll < 0.34) {
    groups.push({ kind: 'armored', count: Math.round(3 + power * 1.8) });
  } else if (power >= 2 && flavourRoll < 0.67) {
    groups.push({ kind: 'spitter', count: Math.round(3 + power * 1.6) });
  } else {
    groups.push({ kind: 'screamer', count: Math.round(2 + power * 0.9) });
  }
  // 精英车道也要有一个"必须提前处理"的目标，否则它就只是一堵血墙
  if (power >= 3 && rng.next() < 0.45) {
    groups.push({ kind: 'bomber', count: Math.round(1 + power * 0.6) });
  }
  return { groups, depth: 16 + power };
}

/** 惩罚门 + 一条几乎没怪的安全通道。 */
function rollSafeLane(rng: Rng, power: number): LaneChoice {
  const gate: GateSpec = rng.next() < 0.5
    ? { type: 'div', value: 2 }
    : { type: 'sub', value: Math.round(14 * power) };
  return {
    gate,
    wave: { groups: [{ kind: 'walker', count: Math.round(20 + power * 8) }], depth: 20 },
    hint: '安全',
  };
}

export interface RollContext {
  /** 关卡号 1..5。 */
  levelId: number;
  /** 这是本关第几个岔路（0 起）。 */
  index: number;
  /** 本关一共几个岔路。 */
  total: number;
  /**
   * 距离上一次"有得加兵"的岔路过了几个了。
   *
   * 兵力就是这个游戏的血条：没有补员手段，方阵只会一路掉到零。随机如果
   * 连着几个门都不给加兵的选项，这一局从掷骰子那一刻就已经输了——roguelike
   * 的随机应该是"这把走哪条 build"，不是"这把抽到了必死的牌"。
   */
  sinceBodies: number;
}

/**
 * 掷一整个岔路口。
 *
 * `gold` 是"预计玩家走到这里时大概有多少钱"，用来给标价车道定价——
 * 标得太高就是一条永远走不了的死路，太低就失去了取舍的意义。
 */
export function rollChoice(rng: Rng, ctx: RollContext, expectedGold: number): { left: LaneChoice; right: LaneChoice } {
  const progress = ctx.total > 1 ? ctx.index / (ctx.total - 1) : 0.5;
  const power = ctx.levelId + progress * 1.2;

  // 每关最后一个岔路之外，偶尔来一次"弃车保帅"：一半兵力换一段太平路
  if (ctx.index > 0 && ctx.index < ctx.total - 1 && rng.next() < 0.22) {
    const safe = rollSafeLane(rng, power);
    const strong = rollOffer(rng, rng.next() < 0.5 ? 'firepower' : 'armor', power + 0.8);
    const risky: LaneChoice = {
      gate: strong.gate,
      wave: rollWave(rng, strong.flavour, power, true),
      hint: '精英',
    };
    return rng.next() < 0.5 ? { left: safe, right: risky } : { left: risky, right: safe };
  }

  // 常规：一侧是尸潮性质（人海/火炮），另一侧是精英性质（武器/护甲）。
  // 尸潮那一侧优先给"加兵"——隔太久没出现过就直接强制，保证这一局有得补员。
  const swarmSide: Category =
    ctx.sinceBodies >= 1 || rng.next() < 0.65 ? 'bodies' : 'artillery';
  const eliteSide: Category = rng.next() < 0.5 ? 'firepower' : 'armor';
  const a = swarmSide;
  const b = eliteSide;

  const offerA = rollOffer(rng, a, power);
  const offerB = rollOffer(rng, b, power);

  // 其中一侧有机会标价：付钱买更强的那一档
  const priceSide = rng.next();
  const withPrice = (o: Offer, on: boolean): GateSpec => {
    if (!on || ctx.levelId === 1 && ctx.index === 0) return o.gate;
    const cost = Math.round(expectedGold * (0.3 + rng.next() * 0.25));
    return cost >= 40 ? { ...o.gate, value: Math.round(o.gate.value * 1.5), cost } : o.gate;
  };

  const laneA: LaneChoice = {
    gate: withPrice(offerA, priceSide < 0.3),
    wave: rollWave(rng, offerA.flavour, power, false),
    hint: offerA.flavour === 'swarm' ? '蜂群' : '精英',
  };
  const laneB: LaneChoice = {
    gate: withPrice(offerB, priceSide >= 0.7),
    wave: rollWave(rng, offerB.flavour, power, false),
    hint: offerB.flavour === 'swarm' ? '蜂群' : '精英',
  };

  // 左右随机对调——否则"永远走右边"又会变成一条通吃策略
  return rng.next() < 0.5 ? { left: laneA, right: laneB } : { left: laneB, right: laneA };
}
