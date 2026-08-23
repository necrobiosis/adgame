import { describe, expect, it } from 'vitest';
import { BOSS_PLANS, ROAD_HALF, type BossKind } from '../../src/config/balance';
import { LEVELS } from '../../src/config/levels';
import { BossController } from '../../src/sim/Boss';
import { EnemyPool } from '../../src/sim/Enemies';
import { Squad } from '../../src/sim/Squad';
import { Rng } from '../../src/core/Rng';
import type { SimEvent } from '../../src/sim/types';

/**
 * 五个 Boss 的招式验证。
 *
 * 之前五关共用同一套技能，换的只有血量和名字。这里验的是两件事：
 *  1. 每个 Boss 真的只用自己那套招（不会串味）
 *  2. 每一招都**躲得掉**——预警亮起时位置就锁定了，走开就不该挨打。
 *     一招如果躲不掉，那它就不是机制，只是每隔几秒扣一次血。
 */

function setup(kind: BossKind, hp = 1e9) {
  const rng = new Rng(11);
  const squad = new Squad(
    { soldiers: 120, cannons: 0, weaponLevel: 3, damageMul: 1, fireRateMul: 1, hpMul: 1 },
    rng,
  );
  squad.layout();
  const pool = new EnemyPool(rng);
  const boss = new BossController(new Rng(23));
  const out: SimEvent[] = [];
  boss.spawn(pool, squad.z + 40, hp, 1, '测试', kind, out);
  return { squad, pool, boss, out };
}

/** 跑到指定的预警出现为止，返回那一刻的预警快照。 */
function runUntilTelegraph(
  kind: BossKind,
  want: string,
  seconds = 60,
): { boss: BossController; squad: Squad; pool: EnemyPool; out: SimEvent[] } | null {
  const s = setup(kind);
  const dt = 1 / 60;
  for (let i = 0; i < seconds / dt; i++) {
    s.boss.update(dt, s.squad, s.pool, s.out);
    if (s.boss.telegraph?.kind === want) return s;
  }
  return null;
}

describe('每个 Boss 只用自己那套招', () => {
  it('招式表里没有互相串味的技能', () => {
    // 五个 Boss 的招式组合两两不同，否则"每关不一样"就是空话
    const sigs = (Object.keys(BOSS_PLANS) as BossKind[]).map((k) =>
      BOSS_PLANS[k].abilities.map((a) => a.a).sort().join('+'),
    );
    expect(new Set(sigs).size, `招式组合有重复：${sigs.join(' | ')}`).toBe(sigs.length);
  });

  it('五关分别绑了五个不同的 Boss', () => {
    const kinds = LEVELS.map((l) => {
      const b = l.beats.find((x) => x.t === 'boss');
      return b && b.t === 'boss' ? b.kind : null;
    });
    expect(kinds.every((k) => k !== null)).toBe(true);
    expect(new Set(kinds).size, `五关的 Boss 种类重复：${kinds.join(',')}`).toBe(5);
  });
});

describe('每个 Boss 都会放出自己的招牌技', () => {
  // 实机录像里第一关抓不到预警——满配方阵会在开场冷却转完之前就把 36000 血的
  // 深渊领主打死。这里给它一条打不完的血，确认招式本身是会放的。
  const SIGNATURE: Record<BossKind, string> = {
    overlord: 'slam',
    plague: 'quake',
    maw: 'breath',
    apostle: 'beam',
    ender: 'slam',
  };
  for (const kind of Object.keys(SIGNATURE) as BossKind[]) {
    it(`${kind} 会放出 ${SIGNATURE[kind]}`, () => {
      const s = runUntilTelegraph(kind, SIGNATURE[kind], 90);
      expect(s, `${kind} 在 90 秒里一次都没放出 ${SIGNATURE[kind]}`).toBeTruthy();
    });
  }

  it('终末之主会潜地', () => {
    const s = setup('ender');
    const dt = 1 / 60;
    let sub = false;
    for (let i = 0; i < 90 / dt && !sub; i++) {
      s.boss.update(dt, s.squad, s.pool, s.out);
      if (s.boss.invulnerable) sub = true;
    }
    expect(sub).toBe(true);
  });
});

describe('新招式都躲得掉', () => {
  it('半场毒爆：站到另外半边就完全不挨打', () => {
    const s = runUntilTelegraph('plague', 'quake');
    expect(s, '应当放出半场毒爆').toBeTruthy();
    const tg = s!.boss.telegraph!;
    // 毒爆覆盖的是 [x0, x1] 这半条路；把整支方阵挪到另外半边
    const safeX = tg.x0! < 0 ? ROAD_HALF - 4 : -ROAD_HALF + 4;
    for (const u of s!.squad.units) u.x = safeX;
    const before = s!.squad.soldierCount;
    const dt = 1 / 60;
    for (let i = 0; i < 200 && s!.boss.telegraph; i++) s!.boss.update(dt, s!.squad, s!.pool, s!.out);
    expect(s!.squad.soldierCount, '躲到安全半场却仍然掉人').toBe(before);
  });

  it('火墙：站进缺口里就完全不挨打', () => {
    const s = runUntilTelegraph('maw', 'breath');
    expect(s, '应当放出火墙').toBeTruthy();
    const tg = s!.boss.telegraph!;
    for (const u of s!.squad.units) u.x = tg.gapX!;
    const before = s!.squad.soldierCount;
    const dt = 1 / 60;
    for (let i = 0; i < 300 && s!.boss.telegraph; i++) s!.boss.update(dt, s!.squad, s!.pool, s!.out);
    expect(s!.squad.soldierCount, '站在缺口里却仍然被烧到').toBe(before);
  });

  it('火墙：站在缺口外面一定挨打（否则这一招等于没有）', () => {
    const s = runUntilTelegraph('maw', 'breath');
    const tg = s!.boss.telegraph!;
    // 挪到缺口正对面的另一侧边缘
    const badX = tg.gapX! > 0 ? -ROAD_HALF + 1 : ROAD_HALF - 1;
    // 只挪横向：火墙的 z 在读条期间会一路压到方阵跟前，
    // 把士兵钉到预警刚出现时的 z 反而会让他们躲开
    for (const u of s!.squad.units) u.x = badX;
    const before = s!.squad.soldierCount;
    const dt = 1 / 60;
    for (let i = 0; i < 300 && s!.boss.telegraph; i++) s!.boss.update(dt, s!.squad, s!.pool, s!.out);
    expect(s!.squad.soldierCount, '站在火墙正下方却毫发无伤').toBeLessThan(before);
  });

  it('终末之主潜地时免疫伤害，浮上来就恢复', () => {
    const s = setup('ender', 5000);
    const dt = 1 / 60;
    let sawInvuln = false;
    let recovered = false;
    for (let i = 0; i < 60 / dt; i++) {
      s.boss.update(dt, s.squad, s.pool, s.out);
      if (s.boss.invulnerable) {
        sawInvuln = true;
        // 潜地期间打它一下，血不该掉
        const hp = s.boss.enemy!.hp;
        s.pool.damage(s.boss.enemy!, 1000, s.out);
        expect(s.boss.enemy!.hp, '潜地期间仍然掉血').toBe(hp);
      } else if (sawInvuln) {
        const hp = s.boss.enemy!.hp;
        s.pool.damage(s.boss.enemy!, 100, s.out);
        if (s.boss.enemy!.hp < hp) recovered = true;
        break;
      }
    }
    expect(sawInvuln, '终末之主应当会潜地').toBe(true);
    expect(recovered, '浮上来之后应当重新能被打').toBe(true);
  });
});
