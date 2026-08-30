import { describe, expect, it } from 'vitest';
import { ENDLESS_ID } from '../../src/config/levels';
import { World } from '../../src/sim/World';
import type { BlockObstacle, SimEvent } from '../../src/sim/types';
import { AIRSTRIKE, BOSS, BUFF_CAP, FORMATION_MAX_ROWS, ROAD_HALF, SLOT_SPACING_Z, SOLDIER, WEAPON_TIERS, rangeFalloff, type UpgradeId } from '../../src/config/balance';
import { rankFireMul } from '../../src/sim/Combat';
import { LANE_ORDER, LANE_SIGN, LANE_WIDTH, laneBounds, laneCenterX } from '../../src/sim/lanes';
import { LEVELS_MAX_UPGRADES, NO_UPGRADES, upgrades as mkUpgrades } from './fixtures';



/** 用固定的操控策略把一整局跑完，返回结果。 */
function simulate(levelId: number, steer: (w: World, t: number) => number, maxSeconds = 400) {
  const w = new World({ levelId, upgrades: NO_UPGRADES, seed: 12345 });
  const dt = 1 / 60;
  let t = 0;
  while (w.phase === 'running' && t < maxSeconds) {
    w.steer = steer(w, t);
    w.step(dt);
    w.drainEvents();
    t += dt;
  }
  return { world: w, seconds: t };
}

/** 一直贴着屏幕上的某一侧走。 */
const hug = (side: 'left' | 'right') => (w: World) => {
  const target = LANE_SIGN[side] * 8;
  return Math.sign(target - w.squad.x) * (Math.abs(target - w.squad.x) > 0.2 ? 1 : 0);
};

describe('World', () => {
  it('赛道按 beats 铺开，总长度和竞技场位置合理', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES });
    expect(w.totalLength).toBeGreaterThan(200);
    expect(w.arenaZ).toBe(w.totalLength);
    expect(w.gates.length).toBe(3);
    expect(w.blocks.length).toBe(1);
    expect(w.gates[0]!.z).toBeLessThan(w.gates[1]!.z);
  });

  it('一局能在有限时间内分出胜负，不会卡死', () => {
    const { world, seconds } = simulate(1, hug('left'));
    expect(world.phase).not.toBe('running');
    expect(seconds).toBeLessThan(400);
  });

  it('过门会实际改变编制并记录选择', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    const before = w.squad.soldierCount;
    const dt = 1 / 60;
    // 贴屏幕左侧走，第一组门左边是 "+26 士兵"
    while (!w.gates[0]!.taken && w.phase === 'running') {
      w.steer = LANE_SIGN.left;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.gates[0]!.chosen).toBe('left');
    expect(w.squad.soldierCount).toBe(before + 26);
  });

  it('走右侧会拿到武器升级而不是加人', () => {
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    const dt = 1 / 60;
    while (!w.gates[0]!.taken && w.phase === 'running') {
      w.steer = LANE_SIGN.right;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.gates[0]!.chosen).toBe('right');
    expect(w.squad.weaponLevel).toBe(1);
  });

  it('墙只占三排里的一排，站到那一排上才打得到它', () => {
    // 这是新玩法的核心决策点：墙不再挡路，也不再"顺路擦过去就拆了"。
    // 走到它那一排 = 火力砸在墙上、拿走奖励；走别的排 = 完全碰不到它。
    // "错过就没有奖励"必须是真的，否则这个选择不成立。
    const kitted = mkUpgrades({ squad: 10, damage: 8, fireRate: 6, cannon: 0, armor: 8, weapon: 2 });
    const run = (follow: boolean) => {
      const w = new World({ levelId: 2, upgrades: kitted, seed: 3 });
      const wall = w.blocks[0]!;
      const [x0, x1] = laneBounds(wall.lane);
      const wallX = (x0 + x1) / 2;
      // follow：一路待在墙那一排；否则一路待在最远的那一排
      const wantX = follow ? wallX : (wallX > 0 ? -ROAD_HALF + 2 : ROAD_HALF - 2);
      const dt = 1 / 60;
      let t = 0;
      while (w.phase === 'running' && t < 300 && w.squad.z < wall.z + 10) {
        w.steer = Math.abs(wantX - w.squad.x) > 0.3 ? Math.sign(wantX - w.squad.x) : 0;
        w.step(dt);
        w.drainEvents();
        t += dt;
      }
      return { hp: wall.hp, maxHp: wall.maxHp };
    };
    // 墙确实只占一排，不是全宽
    const probe = new World({ levelId: 2, upgrades: kitted, seed: 3 });
    const wall = probe.blocks[0]!;
    expect(wall.x1 - wall.x0).toBeLessThan(ROAD_HALF * 2 * 0.5);

    expect(run(false).hp, '走别的排却把墙打掉了——那"错过"就没有代价').toBe(wall.maxHp);
    expect(run(true).hp, '走到墙那一排上却一点都没打到它').toBeLessThan(wall.maxHp);
  });

  it('升级会真实提升战斗力：满配比裸配打得更远/更快', () => {
    const maxed = LEVELS_MAX_UPGRADES;
    const run = (up: Record<UpgradeId, number>) => {
      const w = new World({ levelId: 3, upgrades: up, seed: 99 });
      const dt = 1 / 60;
      let t = 0;
      while (w.phase === 'running' && t < 400) {
        w.steer = LANE_SIGN.left;
        w.step(dt);
        w.drainEvents();
        t += dt;
      }
      return w;
    };
    const weak = run(NO_UPGRADES);
    const strong = run(maxed);
    expect(strong.progress).toBeGreaterThanOrEqual(weak.progress);
    expect(strong.stats.kills).toBeGreaterThan(weak.stats.kills);
  });
});

describe('无尽模式', () => {
  const kitted = mkUpgrades({ squad: 10, damage: 8, fireRate: 6, cannon: 4, armor: 8, weapon: 2 });

  it('开局不会被"Boss 触发"卡死（没有 boss beat，arenaZ 是 0）', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const dt = 1 / 60;
    for (let i = 0; i < 180; i++) {
      w.steer = 0;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.squad.z, '三秒过去方阵应当明显往前走了').toBeGreaterThan(10);
    expect(w.progress, '进度条不应当一开局就是满的').toBeLessThan(1);
  });

  it('怪越往后越硬，而且没有上限', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const scaleAt = (z: number) => {
      w.squad.z = z;
      // currentHpScale 是私有的，通过刷一波怪回读它的实际血量
      w.enemies.clear();
      w.enemies.hpScale = (w as unknown as { currentHpScale(): number }).currentHpScale();
      return w.enemies.hpScale;
    };
    const a = scaleAt(200);
    const b = scaleAt(1000);
    const c = scaleAt(3000);
    expect(b).toBeGreaterThan(a * 1.5);
    expect(c).toBeGreaterThan(b * 1.5);
  });

  it('中 Boss 会反复出现（不是只刷最后一个）', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const dt = 1 / 60;
    let spawns = 0;
    for (let i = 0; i < 240 / dt && w.phase === 'running'; i++) {
      w.steer = 0;
      w.step(dt);
      for (const e of w.drainEvents()) if (e.type === 'midbossSpawn') spawns++;
    }
    expect(spawns, '无尽模式里中 Boss 应当一轮一轮反复出现').toBeGreaterThan(1);
  });

  it('乘算增益有天花板（否则无尽模式会把方阵堆成无敌）', () => {
    // 护甲/射速门都是乘算的。战役一局只吃到三五个没问题，无尽模式有一百多个门，
    // 乘下来单兵血量实测能到一千三百万——任何怪都打不动，"无尽"变成散步。
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    for (let i = 0; i < 200; i++) {
      w.squad.addArmorPercent(60);
      w.squad.addFireRatePercent(50);
    }
    expect(w.squad.unitMaxHp).toBeLessThan(SOLDIER.baseHp * BUFF_CAP.hpMul * 1.01);
    expect(w.squad.fireRateMul).toBeLessThanOrEqual(BUFF_CAP.fireRateMul + 1e-6);
  });

  it('满配也会被无尽模式打死（怪确实越来越强）', () => {
    const maxed = LEVELS_MAX_UPGRADES;
    const w = new World({ levelId: ENDLESS_ID, upgrades: maxed, seed: 5 });
    const dt = 1 / 60;
    let t = 0;
    while (w.phase === 'running' && t < 1500) {
      w.steer = 0;
      w.step(dt);
      w.drainEvents();
      t += dt;
    }
    expect(w.phase, '满配在 1500 秒里都没被打死，说明强度爬得太慢').toBe('lost');
    expect(w.squad.z, '满配应当能推进相当一段距离才倒下').toBeGreaterThan(1500);
  });

  it('永远不会"通关"，只会打到全灭', () => {
    const w = new World({ levelId: ENDLESS_ID, upgrades: kitted, seed: 5 });
    const dt = 1 / 60;
    for (let i = 0; i < 400 / dt && w.phase === 'running'; i++) {
      w.steer = 0;
      w.step(dt);
      w.drainEvents();
    }
    expect(w.phase).not.toBe('won');
  });
});

describe('三排 · 枪不自瞄', () => {
  it('只打得到自己那一排，隔壁排一枪都吃不到', () => {
    // 这是新玩法的地基。判定必须干脆：站在中间那一排，左右两排的怪
    // 一点伤害都不该吃到——否则"该站哪一排"就不是一个真问题。
    const w = new World({ levelId: 1, upgrades: mkUpgrades({ squad: 8, weapon: 3 }), seed: 5 });
    w.enemies.clear();
    w.squad.x = laneCenterX('mid');
    w.squad.layout();
    const put = (lane: 'left' | 'mid' | 'right') => {
      const e = w.enemies.spawn('walker', laneCenterX(lane), w.squad.z + 18);
      e.laneX = e.x;
      e.hp = e.maxHp = 1e6;
      return e;
    };
    const [l, m, r] = [put('left'), put('mid'), put('right')];
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      w.step(dt);
      w.drainEvents();
    }
    expect(m.hp, '正前方那一排完全没挨打').toBeLessThan(m.maxHp);
    expect(l.hp, '隔壁排不该吃到子弹').toBe(l.maxHp);
    expect(r.hp, '隔壁排不该吃到子弹').toBe(r.maxHp);
  });

  it('大炮是曲射的，砸得到隔壁排', () => {
    // 步枪只管自己那一排，火炮能越排——"炮兵编制"这条升级线的全部价值
    // 就在这一条上，它和"武器等级"从此不是同一个东西。
    const w = new World({ levelId: 1, upgrades: mkUpgrades({ squad: 8, cannon: 4, weapon: 3 }), seed: 5 });
    w.enemies.clear();
    w.squad.x = laneCenterX('mid');
    w.squad.layout();
    const far = w.enemies.spawn('walker', laneCenterX('left'), w.squad.z + 20);
    far.laneX = far.x;
    far.hp = far.maxHp = 1e6;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 6; i++) {
      w.step(dt);
      w.drainEvents();
    }
    expect(far.hp, '隔壁排的怪一点炮火都没吃到').toBeLessThan(far.maxHp);
  });

  it('远处的敌人守着自己那一排走，不会一出生就朝方阵聚过来', () => {
    // "看得见哪一排有什么"是选排的前提。敌人如果一出生就朝方阵收拢，
    // 三排就只是画在地上的线。
    const w = new World({ levelId: 1, upgrades: mkUpgrades(), seed: 5 });
    w.enemies.clear();
    w.squad.x = laneCenterX('right');
    w.squad.layout();
    const e = w.enemies.spawn('walker', laneCenterX('left'), w.squad.z + 70);
    e.laneX = e.x;
    const x0 = e.x;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 3; i++) {
      w.step(dt);
      w.drainEvents();
    }
    expect(Math.abs(e.x - x0), '还隔着几十米就已经开始横向抄过来了').toBeLessThan(1.5);
    expect(e.z).toBeLessThan(w.squad.z + 70);
  });
});

describe('奖励墙', () => {
  it('满配玩家走进那一排时，墙是真的打得穿的', () => {
    // "错过就没有奖励"要成立，前提是**没错过的时候真的拿得到**。
    // 一堵谁也打不穿的墙不是决策点，是个陷阱：玩家付了慢速的代价，
    // 什么都没换到。
    const w = new World({
      levelId: 2,
      upgrades: LEVELS_MAX_UPGRADES,
      loadout: ['squad', 'damage', 'fireRate', 'weapon', 'cannon'],
      seed: 3,
    });
    const wall = w.blocks.find((b) => b.bonus > 0)!;
    const wantX = laneCenterX(wall.lane);
    const dt = 1 / 60;
    let t = 0;
    let shot = false;
    while (w.phase === 'running' && t < 120 && w.squad.z < wall.z + 12) {
      w.steer = Math.abs(wantX - w.squad.x) > 0.3 ? Math.sign(wantX - w.squad.x) : 0;
      w.step(dt);
      for (const ev of w.drainEvents()) if (ev.type === 'blockDestroyed') shot = true;
      t += dt;
    }
    // 注意这里要的是"被火力打掉"（blockDestroyed），不是"被撞碎"
    // （blockSmashed）。撞碎不给奖励，也拿命填——它不算"打得穿"。
    expect(shot, `满配走进墙那一排，${wall.maxHp} 血的墙也没能用火力打穿`).toBe(true);
  });
});

describe('射程无限 · 穿透', () => {
  it('多远都开火，只是越远打得越轻', () => {
    // "射程无限"的字面意思：一百米外的怪照样吃子弹，士兵不会站着干等。
    // 但超出有效射程之后伤害会衰减，所以放近了打仍然更划算。
    const near = rangeFalloff(30, 20);
    const at = rangeFalloff(30, 30);
    const far = rangeFalloff(30, 120);
    expect(near).toBe(1);
    expect(at).toBe(1);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(0.4);

    const w = new World({ levelId: 1, upgrades: mkUpgrades({ squad: 8, weapon: 3 }), seed: 5 });
    w.enemies.clear();
    w.squad.x = laneCenterX('mid');
    w.squad.layout();
    // 一百二十米外——远远超过任何一把枪的有效射程
    const e = w.enemies.spawn('walker', laneCenterX('mid'), w.squad.z + 120);
    e.laneX = e.x;
    e.hp = e.maxHp = 1e7;
    const dt = 1 / 60;
    for (let i = 0; i < 60; i++) {
      w.step(dt);
      w.drainEvents();
    }
    expect(e.hp, '一百二十米外的怪一枪都没挨到').toBeLessThan(e.maxHp);
  });

  it('穿透高的枪一发能串起一整条纵队', () => {
    // 子弹只往正前方飞，一排怪自然站成纵队——穿透就是这个玩法下最自然的
    // 一条区分轴，也是射程不再是轴之后接上来的那一个。
    const tiers = WEAPON_TIERS;
    expect(tiers[0]!.pierce, '手枪应该是一枪一个').toBe(1);
    expect(tiers[6]!.pierce, '电磁炮应该串得最多').toBeGreaterThan(5);
    // 八级武器的"外观档"要真的拉开，不能全挤在一两档上
    expect(new Set(tiers.map((t) => t.beam)).size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...tiers.map((t) => t.beam))).toBeGreaterThanOrEqual(4);
  });
});

describe('墙上的倒刺', () => {
  /** 把方阵直接送到指定的墙前面，省掉"能不能活着走到那儿"这件无关的事。 */
  function atWall(lane: 'follow' | 'away') {
    const w = new World({ levelId: 4, upgrades: mkUpgrades({ squad: 12, armor: 6 }), seed: 3 });
    // 挑最厚的那堵**带刺的**墙——军械门不长刺，是另一套规则
    const wall = w.blocks
      .filter((b) => b.rewardWeapon === undefined)
      .reduce((a, b) => (b.maxHp > a.maxHp ? b : a));
    w.squad.addSoldiers(200);
    w.squad.z = wall.z - 20;
    const wallX = laneCenterX(wall.lane);
    w.squad.x = lane === 'follow' ? wallX : (wallX > 0 ? -ROAD_HALF + 2 : ROAD_HALF - 2);
    w.squad.layout();
    w.enemies.clear();
    return { w, wall, wantX: w.squad.x };
  }

  it('撞上没打掉的墙会被串死一片，但方阵不减速也不卡住', () => {
    // 以前撞墙是"速度降到 16% 一点点蹭过去"，干等 + 整队人从墙里穿模。
    // 现在墙正面焊满倒刺：撞上去拿命填，方阵不减速地撞穿，墙碎、没有奖励。
    const { w, wall, wantX } = atWall('follow');
    const dt = 1 / 60;
    let t = 0;
    let impaled = 0;
    let smashed = false;
    let crawl = Infinity;
    while (w.phase === 'running' && t < 20 && w.squad.z < wall.z + 8) {
      w.steer = Math.abs(wantX - w.squad.x) > 0.3 ? Math.sign(wantX - w.squad.x) : 0;
      const z0 = w.squad.z;
      w.step(dt);
      for (const ev of w.drainEvents()) {
        if (ev.type === 'impaled') impaled++;
        if (ev.type === 'blockSmashed') smashed = true;
      }
      if (Math.abs(w.squad.z - wall.z) < 3) crawl = Math.min(crawl, (w.squad.z - z0) / dt);
      t += dt;
    }
    expect(impaled, '撞上倒刺却一个人都没死').toBeGreaterThan(0);
    expect(smashed, '硬撞过去之后墙应当碎掉，不能让人从墙里穿过去').toBe(true);
    expect(wall.alive).toBe(false);
    // 贴着墙的那一段仍然在正常速度推进（这里清了场，没有尸潮的拖拽）
    expect(crawl, '撞墙时被拖慢了——这一版不该再有"蹭过去"的手感').toBeGreaterThan(4);
  });

  it('走别的排既不会被刺，也不会把墙撞碎', () => {
    const { w, wall, wantX } = atWall('away');
    const dt = 1 / 60;
    let t = 0;
    let impaled = 0;
    while (w.phase === 'running' && t < 20 && w.squad.z < wall.z + 8) {
      w.steer = Math.abs(wantX - w.squad.x) > 0.3 ? Math.sign(wantX - w.squad.x) : 0;
      w.step(dt);
      for (const ev of w.drainEvents()) if (ev.type === 'impaled') impaled++;
      t += dt;
    }
    expect(impaled, '走别的排也被刺到了').toBe(0);
    expect(wall.alive, '走别的排却把墙撞碎了').toBe(true);
  });
});

describe('开局就看得见的 Boss', () => {
  it('第一帧起 Boss 就在远处，而且一路吊在方阵前方', () => {
    // 以前 Boss 是走到竞技场跟前才凭空出现的，玩家一路上完全不知道自己
    // 在往什么东西身上撞。现在它从第一帧就在雾的边缘慢慢走。
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 4 });
    expect(w.boss.enemy, '开局就应该有一只远处的 Boss').toBeTruthy();
    expect(w.boss.previewing).toBe(true);
    const gap0 = w.boss.enemy!.z - w.squad.z;
    expect(gap0).toBeGreaterThan(100);

    const dt = 1 / 60;
    for (let i = 0; i < 60 * 8; i++) {
      w.step(dt);
      w.drainEvents();
      if (w.phase !== 'running') break;
    }
    // 一路推进，它一直在前面（还没到竞技场之前距离基本不变）
    expect(w.boss.enemy!.z - w.squad.z).toBeGreaterThan(100);
    expect(w.boss.previewing, '还没走到竞技场就提前开打了').toBe(true);
  });

  it('预览态打不到也打不动：它还不在场上', () => {
    const w = new World({ levelId: 1, upgrades: LEVELS_MAX_UPGRADES, loadout: ['squad', 'damage', 'fireRate', 'weapon'], seed: 4 });
    const b = w.boss.enemy!;
    expect(b.invulnerable).toBe(true);
    const hp = b.hp;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 5; i++) {
      w.step(dt);
      w.drainEvents();
    }
    expect(b.hp, '远处那只黑影被打掉血了').toBe(hp);
  });

  it('走到竞技场时是同一只醒过来，不是重新生成一只', () => {
    const w = new World({ levelId: 1, upgrades: LEVELS_MAX_UPGRADES, loadout: ['squad', 'damage', 'fireRate', 'weapon'], seed: 4 });
    const before = w.boss.enemy!;
    const dt = 1 / 60;
    let woke = false;
    for (let i = 0; i < 60 * 120 && !woke; i++) {
      w.step(dt);
      for (const ev of w.drainEvents()) if (ev.type === 'bossSpawn') woke = true;
      if (w.phase !== 'running') break;
    }
    expect(woke, '一直没走到 Boss 战').toBe(true);
    expect(w.boss.enemy, '入场时换了一只新的实例，模型会闪一下').toBe(before);
    expect(w.boss.previewing).toBe(false);
    expect(before.invulnerable).toBe(false);
    expect(before.maxHp).toBeGreaterThan(1);
  });
});

describe('空袭：一局几发', () => {
  it('默认一局只有一发，用掉就没了', () => {
    // 以前是一条会自己长回来的充能条，一局能放五六次，每一次都不值钱。
    // 现在一局就这么多发，"什么时候用"才成了一个真的决定。
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    expect(w.strikeLeft).toBe(AIRSTRIKE.baseCharges);
    expect(w.callAirstrike()).toBe(true);
    expect(w.strikeLeft).toBe(0);
    expect(w.callAirstrike(), '没发了还能放').toBe(false);
    // 干等也不会长回来
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 40; i++) {
      w.step(dt);
      w.drainEvents();
      if (w.phase !== 'running') break;
    }
    expect(w.strikeLeft, '空袭不该自己长回来').toBe(0);
  });

  it('带多发也不能一口气全倒出来：中间有硬冷却', () => {
    const w = new World({
      levelId: 1,
      upgrades: LEVELS_MAX_UPGRADES,
      loadout: ['squad', 'damage', 'weapon', 'strikeSpec'],
      seed: 7,
    });
    expect(w.strikeLeft, '空袭引导满级应该多带 3 发').toBe(AIRSTRIKE.baseCharges + 3);
    expect(w.callAirstrike()).toBe(true);
    expect(w.callAirstrike(), '冷却里还能连着放第二发').toBe(false);
    expect(w.strikeCd).toBeGreaterThan(0);
    const dt = 1 / 60;
    for (let i = 0; i < Math.ceil(AIRSTRIKE.cooldown / dt) + 10; i++) {
      w.step(dt);
      w.drainEvents();
      if (w.phase !== 'running') break;
    }
    if (w.phase === 'running') {
      expect(w.strikeCd).toBe(0);
      expect(w.callAirstrike(), '冷却转完了却放不出来').toBe(true);
    }
  });

  it('落地前有一整块地面预警，炸完就消失', () => {
    // 一发能抹掉半条街，落地前必须先把"要炸哪儿"摊在地上给玩家看清楚
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 7 });
    expect(w.strikeZone).toBeNull();
    w.callAirstrike();
    expect(w.strikeZone, '呼叫之后应当有预警区').toBeTruthy();
    expect(w.strikeZone!.halfZ).toBeGreaterThan(10);
    const dt = 1 / 60;
    let impacts = 0;
    for (let i = 0; i < 60 * 6; i++) {
      w.step(dt);
      for (const ev of w.drainEvents()) if (ev.type === 'strikeImpact') impacts++;
      if (w.phase !== 'running') break;
    }
    expect(impacts, '弹幕该有的发数没落全').toBe(AIRSTRIKE.bombs);
    expect(w.strikeZone, '炸完了预警区还挂在地上').toBeNull();
  });
});

describe('人多不再等于无敌', () => {
  /** 数一下以方阵中心为圆心、半径 r 的圆里站了多少人。 */
  function inBlast(w: World, r: number): number {
    let n = 0;
    for (const u of w.squad.units) {
      if (!u.alive) continue;
      const dx = u.x - w.squad.x;
      const dz = u.z - w.squad.z;
      if (dx * dx + dz * dz <= r * r) n++;
    }
    return n;
  }

  it('方阵纵深封顶：人再多也不会拉成一条长队', () => {
    // 以前列数封顶 5、排数不封顶，三百人就是一条七十八米长的纵队——
    // 只有最前三排够得着被咬，后面全是碰不到的血库。
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 3 });
    w.squad.addSoldiers(400);
    w.squad.layout();
    // 不封顶的话四百人排成 5 列 = 104 米长的纵队；封顶之后应当压在
    // 目标纵深的一点几倍以内（挤到下限之后还是会略微超出一点）
    expect(w.squad.depth, `四百人的方阵纵深 ${w.squad.depth.toFixed(0)} 米，还是一条长队`)
      .toBeLessThan(FORMATION_MAX_ROWS * SLOT_SPACING_Z * 1.35);
    // 而且宽度要真的铺满一条车道，不是缩成一条细线
    expect(w.squad.halfWidth * 2).toBeGreaterThan(LANE_WIDTH * 0.8);
    // 而且要真的挤起来，不是靠砍人数
    expect(w.squad.soldierCount).toBeGreaterThan(380);
  });

  it('AoE 杀的是比例不是固定人数：队伍越大，一发炸到的人越多', () => {
    // 这是"堆兵力就无敌"的根：AoE 覆盖固定几排的话，杀的人数和队伍大小无关，
    // 三百人的队伍挨一发践踏和六十人的队伍掉一样多的人。
    const small = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 3 });
    small.squad.addSoldiers(60 - small.squad.soldierCount);
    small.squad.layout();
    const big = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 3 });
    big.squad.addSoldiers(360 - big.squad.soldierCount);
    big.squad.layout();

    const R = BOSS.slam.radius;
    const hitSmall = inBlast(small, R);
    const hitBig = inBlast(big, R);
    expect(hitBig, `六十人炸到 ${hitSmall}，三百六十人只炸到 ${hitBig}`)
      .toBeGreaterThan(hitSmall * 1.8);
  });

  it('压密不会让全队火力凭空暴涨', () => {
    // 衰减看的是"前面挡着多少人"，跟摆成几列无关。用 row 算的话，
    // 一压密所有人都挤进前排，DPS 会白涨一大截。
    const w = new World({ levelId: 1, upgrades: NO_UPGRADES, seed: 3 });
    w.squad.addSoldiers(400);
    w.squad.layout();
    let total = 0;
    for (const u of w.squad.units) if (u.alive) total += rankFireMul(u.rank);
    // 400 人按参考宽度 5 列算 = 80 排，衰减到下限之后每人 0.3——
    // 有效火力应当远低于人数，和压密之前是同一条曲线
    expect(total).toBeLessThan(w.squad.soldierCount * 0.55);
    expect(total).toBeGreaterThan(w.squad.soldierCount * 0.25);
  });
});

describe('军械墙', () => {
  /** 把方阵直接送到第一关那堵军械墙前面，站在它那一排上。 */
  function atWall(upgrades: Record<UpgradeId, number>, loadout?: readonly UpgradeId[], troops = 160) {
    const w = new World({ levelId: 1, upgrades, loadout, seed: 3 });
    const wall = w.blocks.find((b) => b.rewardWeapon !== undefined)!;
    if (troops > 0) w.squad.addSoldiers(troops);
    w.squad.z = wall.z - 26;
    w.squad.x = laneCenterX(wall.lane);
    w.squad.layout();
    w.enemies.clear();
    return { w, wall };
  }

  /** 一路冲到墙那边，清掉僵尸只留人和墙。返回这一段里发生的事件。 */
  function charge(w: World, wall: BlockObstacle, lane: number | null): SimEvent[] {
    const dt = 1 / 60;
    const log: SimEvent[] = [];
    for (let t = 0; t < 20 && w.phase === 'running' && w.squad.z < wall.z + 8; t += dt) {
      if (lane !== null) w.steer = Math.abs(lane - w.squad.x) > 0.3 ? Math.sign(lane - w.squad.x) : 0;
      w.step(dt);
      log.push(...w.drainEvents());
      w.enemies.clear();
    }
    return log;
  }

  it('墙跟着路往后走，不会自己钉在方阵前面', () => {
    // 这一条守的是"军械墙就是一堵普通的墙"：它在赛道上有个固定的位置，
    // 方阵走过去就是走过去了，不会永远吊在正前方那么远。
    const { w, wall } = atWall(NO_UPGRADES, undefined, 0);
    const z0 = wall.z;
    const gap0 = wall.z - w.squad.z;
    charge(w, wall, null);
    expect(wall.z, '墙自己动了').toBe(z0);
    expect(wall.z - w.squad.z, '方阵没能逼近这堵墙').toBeLessThan(gap0 - 10);
  });

  it('墙上印的是一把枪，在撞上之前打穿了就换上它', () => {
    const { w, wall } = atWall(LEVELS_MAX_UPGRADES, ['squad', 'damage', 'fireRate', 'cannon']);
    const want = wall.rewardWeapon!;
    // 手里这把要比墙上那把差，才谈得上"换"
    expect(w.squad.weaponLevel).toBeLessThan(want);
    const log = charge(w, wall, laneCenterX(wall.lane));
    expect(wall.alive, '满配打不穿第一关那堵 2400 血的墙').toBe(false);
    expect(log.some((ev) => ev.type === 'blockSmashed'), '是被撞碎的，不是打穿的').toBe(false);
    expect(w.squad.weaponLevel, '打穿了却没换枪').toBe(want);
    expect(log.some((ev) => ev.type === 'weaponPickup'), '没有发出换枪事件').toBe(true);
  });

  it('打不穿硬撞过去：墙上有刺，人死一片，枪也拿不到', () => {
    // 军械墙和金币墙是同一套规则：撞碎的墙不给奖励。
    // 不然"硬撞"就成了不用付火力的白嫖，这道选择题直接塌掉。
    const { w, wall } = atWall(NO_UPGRADES, undefined, 120);
    const before = w.squad.weaponLevel;
    expect(wall.rewardWeapon, '这堵墙本来是有枪的').toBeGreaterThan(before);
    // 把血量拉到这点火力绝对啃不动的地步：这一条要测的是"撞"，不是"打"
    wall.hp = wall.maxHp = 200000;
    const n0 = w.squad.soldierCount;
    const log = charge(w, wall, laneCenterX(wall.lane));
    expect(wall.alive, '硬撞应当把墙撞碎').toBe(false);
    expect(log.some((ev) => ev.type === 'blockSmashed'), '没有走撞碎那条路').toBe(true);
    expect(log.some((ev) => ev.type === 'impaled'), '墙上的刺没扎人').toBe(true);
    expect(w.squad.soldierCount, '撞墙应当拿命填').toBeLessThan(n0);
    expect(log.some((ev) => ev.type === 'weaponPickup'), '撞碎的墙不该给枪').toBe(false);
    expect(w.squad.weaponLevel, '撞碎的墙不该给枪').toBe(before);
  });

  it('换一排走：不扎人，也拿不到枪', () => {
    const { w, wall } = atWall(NO_UPGRADES, undefined, 120);
    const before = w.squad.weaponLevel;
    const other = LANE_ORDER.find((l) => l !== wall.lane)!;
    const n0 = w.squad.soldierCount;
    const log = charge(w, wall, laneCenterX(other));
    expect(wall.alive, '走别的排不该把墙碰碎').toBe(true);
    expect(log.some((ev) => ev.type === 'impaled'), '走别的排还被扎了').toBe(false);
    expect(w.squad.soldierCount, '走别的排不该死人').toBe(n0);
    expect(w.squad.weaponLevel, '走别的排不该白拿枪').toBe(before);
  });

  it('墙上的枪比手里的差就不会把人降级', () => {
    const { w, wall } = atWall(LEVELS_MAX_UPGRADES, ['squad', 'damage', 'fireRate', 'weapon']);
    // 满级制式装备起手就比第一关墙上那把好
    expect(w.squad.weaponLevel).toBeGreaterThan(wall.rewardWeapon!);
    const before = w.squad.weaponLevel;
    charge(w, wall, laneCenterX(wall.lane));
    expect(wall.alive).toBe(false);
    expect(w.squad.weaponLevel, '打穿墙反而把枪换差了').toBe(before);
  });
});
