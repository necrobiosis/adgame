import { describe, expect, it } from 'vitest';
import { ENDLESS_ID } from '../../src/config/levels';
import { World } from '../../src/sim/World';
import { BUFF_CAP, ROAD_HALF, SOLDIER, WEAPON_TIERS, rangeFalloff, type UpgradeId } from '../../src/config/balance';
import { LANE_SIGN, laneBounds, laneCenterX } from '../../src/sim/lanes';
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
  it('撞上没打掉的墙会被串死一片，但方阵不减速也不卡住', () => {
    // 以前撞墙是"速度降到 16% 一点点蹭过去"，干等 + 整队人从墙里穿模。
    // 现在墙正面焊满倒刺：撞上去拿命填，方阵不减速地撞穿，墙碎、没有奖励。
    const w = new World({ levelId: 5, upgrades: mkUpgrades({ squad: 12, armor: 6 }), seed: 3 });
    // 挑一堵这支队伍绝对打不穿的厚墙
    const wall = w.blocks.reduce((a, b) => (b.maxHp > a.maxHp ? b : a));
    const wantX = laneCenterX(wall.lane);
    const dt = 1 / 60;
    let t = 0;
    let impaled = 0;
    let smashed = false;
    let crawl = Infinity;
    // 先跑到墙跟前，量"贴着墙那一段"的推进速度
    while (w.phase === 'running' && t < 200 && w.squad.z < wall.z + 8) {
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
    // 贴着墙的那一段仍然在正常速度推进（尸潮的拖拽另算，这里没怪）
    expect(crawl, '撞墙时被拖慢了——这一版不该再有"蹭过去"的手感').toBeGreaterThan(4);
  });

  it('走别的排既不会被刺，也不会把墙撞碎', () => {
    const w = new World({ levelId: 5, upgrades: mkUpgrades({ squad: 12, armor: 6 }), seed: 3 });
    const wall = w.blocks.reduce((a, b) => (b.maxHp > a.maxHp ? b : a));
    const away = laneCenterX(wall.lane) > 0 ? -ROAD_HALF + 2 : ROAD_HALF - 2;
    const dt = 1 / 60;
    let t = 0;
    let impaled = 0;
    while (w.phase === 'running' && t < 200 && w.squad.z < wall.z + 8) {
      w.steer = Math.abs(away - w.squad.x) > 0.3 ? Math.sign(away - w.squad.x) : 0;
      w.step(dt);
      for (const ev of w.drainEvents()) if (ev.type === 'impaled') impaled++;
      t += dt;
    }
    expect(impaled, '走别的排也被刺到了').toBe(0);
    expect(wall.alive, '走别的排却把墙撞碎了').toBe(true);
  });
});
