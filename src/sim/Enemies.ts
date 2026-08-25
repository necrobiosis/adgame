import { BIG_SPAWN_AHEAD, BOMBER, ENEMY_STATS, FIRE_CORRIDOR_PAD, LANE_LOCK_RANGE, LEAPER, MELEE, ROAD_HALF, SCREAMER_AURA, SIZE_JITTER, SOLDIER, SPITTER, type EnemyKind } from '../config/balance';
import type { Rng } from '../core/Rng';
import type { WaveSpec } from '../config/levels';
import type { Squad } from './Squad';
import { LANE_ORDER, LANE_WIDTH, laneCenterX } from './lanes';
import type { BlockObstacle, Enemy, SimEvent } from './types';

/** 尸体倒地动画时长。 */
const DYING_TIME = 0.55;
/** 刷怪默认提前量：留出几秒的射击窗口，尸潮才是"压过来"而不是"贴脸出现"。 */
const DEFAULT_SPAWN_AHEAD = 62;

export class EnemyPool {
  readonly list: Enemy[] = [];
  private nextId = 1;
  /** 关卡血量/体型缩放。 */
  hpScale = 1;
  /**
   * 伤害缩放（无尽模式用）。
   *
   * 只拉血量是不够的：血厚的怪只是"更难杀"，不是"更危险"——伤害没变的话，
   * 满配方阵可以一直磨下去，怪再厚也威胁不到它。真正让人扛不住的是它们
   * 咬得越来越疼。这个值和 hpScale 分开算，因为伤害缩放致命得多，
   * 爬升必须慢一档。
   */
  damageScale = 1;
  sizeScale = 1;
  /** 上一帧压在接触面上的僵尸数量（World 用它拖慢方阵前进）。 */
  contactCount = 0;

  /** 复用的排序缓冲，避免每帧分配。 */
  private readonly contactBuf: Enemy[] = [];
  /** 需要互相推开的大型敌人。 */
  private readonly bigBuf: Enemy[] = [];

  constructor(private readonly rng: Rng) {}

  get aliveCount(): number {
    let n = 0;
    for (const e of this.list) if (e.alive) n++;
    return n;
  }

  /**
   * 刷一波怪。
   *
   * 每一组怪都长在**某一排**上：要么关卡直接指定（`g.lane`），要么按组序
   * 轮着分排。这一条是新玩法的地基——子弹只打正前方，所以"这一排有什么"
   * 必须是一个玩家看得见、也能提前判断的事实，而不是一片糊在整条路上的
   * 随机噪声。排内仍然有横向抖动，尸潮不会站成一条直线。
   */
  spawnWave(wave: WaveSpec, atZ: number, squadX: number): void {
    void squadX;
    const depth = wave.depth ?? 22;
    const laneRoll = Math.floor(this.rng.next() * LANE_ORDER.length);
    let gi = -1;
    for (const g of wave.groups) {
      gi++;
      const st = ENEMY_STATS[g.kind];
      const big = st.scale >= 1.5;
      // 大块头老远就要看得见：它们走得慢，60 米外淡入等于凭空冒出来
      const ahead = wave.spawnAhead ?? (big ? BIG_SPAWN_AHEAD : DEFAULT_SPAWN_AHEAD);
      const baseZ = atZ + ahead;
      // 没指定就随机分排——固定按组序轮的话，"第一组永远在最右边"会被玩家
      // 一眼背下来，选排就退化成背板。同一波里的不同组尽量错开，
      // 免得整波怪全挤在一排上。
      const lane = g.lane ?? LANE_ORDER[(laneRoll + gi) % LANE_ORDER.length]!;
      const lx = laneCenterX(lane);
      // 排内的横向散布：留出体型的余量，大怪不会半个身子压到隔壁排
      const halfSpan = Math.max(0.6, LANE_WIDTH / 2 - st.scale * 0.9);
      for (let i = 0; i < g.count; i++) {
        const t = g.count > 1 ? i / (g.count - 1) : 0.5;
        const z = baseZ + t * depth + this.rng.range(-1.6, 1.6);
        // 杂兵中间密两边疏，堆出人潮；精英只有几只，均匀铺开
        const off = big
          ? (g.count > 1 ? -halfSpan + ((i + 0.5) / g.count) * halfSpan * 2 : 0)
          : (this.rng.range(-halfSpan, halfSpan) + this.rng.range(-halfSpan, halfSpan)) * 0.5;
        const e = this.spawn(g.kind, clamp(lx + off, -ROAD_HALF + 0.8, ROAD_HALF - 0.8), z);
        e.laneX = e.x;
      }
    }
  }

  spawn(kind: EnemyKind, x: number, z: number, opts?: { hp?: number; scale?: number; scripted?: boolean }): Enemy {
    const st = ENEMY_STATS[kind];
    const hp = opts?.hp ?? st.hp * Math.pow(this.hpScale, st.scaleExp);
    const e: Enemy = {
      id: this.nextId++,
      kind,
      x,
      z,
      hp,
      maxHp: hp,
      alive: true,
      phase: this.rng.range(0, Math.PI * 2),
      // 体型抖动：同一种怪也要有高有矮，尸潮才不像复制粘贴。
      // 显式指定 scale 的（Boss / 中 Boss）不抖，它们的体型是设计好的。
      scale: (opts?.scale ?? st.scale * this.sizeJitter(kind)) * this.sizeScale,
      attackCd: this.rng.range(0, 0.6),
      laneOffset: this.rng.range(-1, 1),
      // 默认就走自己出生的那条线；spawnWave 会按排重设
      laneX: x,
      flash: 0,
      speedMul: 1,
      damageMul: 1,
      scripted: opts?.scripted ?? false,
      dying: 0,
      abilityCd: this.rng.range(0.2, 0.9),
      leapT: 0,
      airY: 0,
    };
    this.list.push(e);
    return e;
  }

  /** 按种类给一个稳定的出生体型系数。 */
  private sizeJitter(kind: EnemyKind): number {
    const st = ENEMY_STATS[kind];
    if (kind === 'boss' || kind === 'midboss') return 1;
    const amp = st.scale >= 1.25 ? SIZE_JITTER.elite : SIZE_JITTER.trash;
    return 1 + this.rng.range(-amp, amp);
  }

  /**
   * 造成伤害。返回这一击拿到的金币（没击杀就是 0）。
   *
   * `splash` 表示这是火炮溅射——重甲尸的 bulletResist 只挡子弹，不挡溅射。
   * 这条区分是"火炮门"和"武器门"第一次有本质差别的地方。
   */
  damage(e: Enemy, amount: number, out: SimEvent[], splash = false): number {
    if (!e.alive || e.invulnerable) return 0;
    const resist = splash ? 0 : (ENEMY_STATS[e.kind].bulletResist ?? 0);
    amount *= 1 - resist;
    const dealt = Math.min(e.hp, amount);
    e.hp -= dealt;
    e.flash = 0.09;
    const st = ENEMY_STATS[e.kind];
    if (st.showHealthBar && dealt >= 1) {
      out.push({ type: 'hitBig', x: e.x, y: 1.6 * e.scale, z: e.z, amount: Math.round(dealt) });
    }
    if (e.hp <= 0) {
      e.alive = false;
      e.dying = DYING_TIME;
      out.push({ type: 'kill', x: e.x, y: 0.9 * e.scale, z: e.z, kind: e.kind, amount: st.gold });
      return st.gold;
    }
    return 0;
  }

  /**
   * 自爆：一圈范围伤害，然后自己也没了。
   *
   * 走的是 kill 事件那条路（有金币、有倒地动画），因为对玩家来说这确实是
   * 一次击杀——只是这份击杀是它自己送的，代价由方阵付。
   */
  private detonate(e: Enemy, squad: Squad, out: SimEvent[]): void {
    const dmg = BOMBER.damage * this.damageScale;
    let hits = 0;
    for (const u of squad.units) {
      if (!u.alive) continue;
      const dx = u.x - e.x;
      const dz = u.z - e.z;
      if (dx * dx + dz * dz > BOMBER.radius * BOMBER.radius) continue;
      u.hp -= dmg;
      u.flash = 0.16;
      hits++;
      if (u.hp <= 0) {
        u.alive = false;
        squad.markDirty();
        out.push({ type: 'soldierDown', x: u.x, y: 0.9, z: u.z });
      }
    }
    e.alive = false;
    e.hp = 0;
    e.dying = DYING_TIME;
    out.push({ type: 'bomberBlast', x: e.x, y: 0.6, z: e.z, radius: BOMBER.radius, amount: hits });
    out.push({ type: 'kill', x: e.x, y: 0.9 * e.scale, z: e.z, kind: e.kind, amount: 0 });
  }

  update(dt: number, squad: Squad, barrier: BlockObstacle | null, out: SimEvent[]): void {
    // 嚎叫者光环：先收集，再套用
    const screamers: Enemy[] = [];
    for (const e of this.list) {
      if (e.alive && e.kind === 'screamer') screamers.push(e);
    }

    const frontZ = squad.z + SOLDIER.contactDepth;
    const halfW = squad.halfWidth + 1.6;
    const contact = this.contactBuf;
    contact.length = 0;

    for (const e of this.list) {
      if (!e.alive) {
        if (e.dying > 0) e.dying = Math.max(0, e.dying - dt);
        continue;
      }
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);

      // 嚎叫者光环
      e.speedMul = 1;
      e.damageMul = 1;
      if (e.kind !== 'screamer') {
        for (const s of screamers) {
          const dx = s.x - e.x;
          const dz = s.z - e.z;
          if (dx * dx + dz * dz < SCREAMER_AURA.radius * SCREAMER_AURA.radius) {
            e.speedMul = SCREAMER_AURA.speedMul;
            e.damageMul = SCREAMER_AURA.damageMul;
            break;
          }
        }
      }

      if (e.scripted) continue; // Boss 由 BossController 驱动

      const st = ENEMY_STATS[e.kind];
      const speed = st.speed * e.speedMul;

      // 前面横着一堵装甲墙：不能穿过去，先挤到路肩的缝隙里再绕进来
      if (barrier && e.z > barrier.z - 1.2 && e.x > barrier.x0 - 0.5 && e.x < barrier.x1 + 0.5) {
        e.z = Math.max(e.z - speed * 0.25 * dt, barrier.z + 1.2);
        const aim = e.x >= 0 ? barrier.x1 + 1.2 : barrier.x0 - 1.2;
        const d = aim - e.x;
        e.x += Math.sign(d) * Math.min(Math.abs(d), speed * 1.7 * dt);
        e.phase += dt * 5;
        continue;
      }

      // ── 吐酸者：停在射程外抛射 ────────────────────────────
      if (e.kind === 'spitter') {
        this.updateSpitter(dt, e, squad, speed, out);
        continue;
      }
      // ── 跳跃者：滞空中不参与任何地面逻辑 ──────────────────
      if (e.kind === 'leaper' && (e.leapT ?? 0) > 0) {
        this.updateLeap(dt, e, out);
        continue;
      }
      if (e.kind === 'leaper') {
        e.abilityCd = (e.abilityCd ?? 0) - dt;
        const gap = e.z - squad.z;
        if ((e.abilityCd ?? 0) <= 0 && gap > 2 && gap < LEAPER.triggerRange) {
          this.startLeap(e, squad, out);
          continue;
        }
      }

      // ── 自爆尸：走到跟前直接炸开，不进近战队列 ────────────
      // 它没有"啃前排"这一步——所以堆再厚的前排也挡不住，
      // 唯一的解法是在它靠上来之前打掉。
      if (e.kind === 'bomber' && e.z - squad.z < BOMBER.fuseRange + e.scale) {
        this.detonate(e, squad, out);
        continue;
      }

      // 已经压到接触面上的，交给下面的排队逻辑统一处理
      const reach = frontZ + e.scale * 0.55;
      if (e.z <= reach + MELEE.queueDepth * 0.5 && Math.abs(e.x - squad.x) <= halfW + e.scale) {
        contact.push(e);
        e.phase += dt * 6;
        continue;
      }

      e.z -= speed * dt;
      // ── 排纪律 ──────────────────────────────────────────
      // 远处：老老实实沿着自己那一排往前走。玩家因此能提前看清"哪一排有
      //       什么、有多少"，选排才有信息可依。
      // 近处：开始朝方阵收拢。否则"躲进空排"就是免费通关——玩家躲开的
      //       应该只是**开火的窗口**，不是敌人本身。
      const gap = e.z - squad.z;
      const spread = Math.max(4.5, squad.halfWidth + 2.5);
      const converge = gap >= LANE_LOCK_RANGE
        ? 0
        : 1 - gap / LANE_LOCK_RANGE;
      const home = e.laneX ?? e.x;
      const aimX = clamp(
        home + (squad.x + e.laneOffset * spread - home) * converge,
        -ROAD_HALF + 0.8, ROAD_HALF - 0.8,
      );
      const dx = aimX - e.x;
      const urgency = 0.35 + converge * 0.85;
      e.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * urgency * dt);
      e.phase += dt * (3.2 + speed * 0.55);
    }

    // 跳跃者落地的范围伤害。放在这里统一结算，updateLeap 只负责抛物线。
    const nEvents = out.length;
    for (let i = 0; i < nEvents; i++) {
      const ev = out[i]!;
      if (ev.type !== 'leaperLand') continue;
      for (const u of squad.units) {
        if (!u.alive) continue;
        const dx = u.x - (ev.x ?? 0);
        const dz = u.z - (ev.z ?? 0);
        if (dx * dx + dz * dz > LEAPER.radius * LEAPER.radius) continue;
        u.hp -= LEAPER.damage;
        u.flash = 0.12;
        if (u.hp <= 0) {
          u.alive = false;
          squad.markDirty();
          out.push({ type: 'soldierDown', x: u.x, y: 0.9, z: u.z });
        }
      }
    }

    this.resolveMelee(dt, squad, contact, out);
    this.separateBig(dt);
    this.contactCount = contact.length;

    // 回收：播完倒地动画的尸体，以及被甩到方阵后面的漏网之鱼
    const cullZ = squad.z - squad.depth - MELEE.cullBehind;
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i]!;
      if (!e.alive && e.dying <= 0) continue;
      if (e.alive && !e.scripted && e.z < cullZ) continue;
      this.list[w++] = e;
    }
    this.list.length = w;
  }

  /**
   * 吐酸者：压到 standoff 距离就停下，之后原地抛射。
   * 酸液有 telegraph 秒的滞空，落点在抛出的那一刻就定死——所以玩家
   * 是在躲一个"已经飞出来的东西"，横向移动真的能躲开。
   */
  private updateSpitter(dt: number, e: Enemy, squad: Squad, speed: number, out: SimEvent[]): void {
    const gap = e.z - squad.z;
    // 飞行中的酸液
    if ((e.spitT ?? 0) > 0) {
      e.spitT = (e.spitT ?? 0) - dt;
      if ((e.spitT ?? 0) <= 0) {
        e.spitT = 0;
        const hx = e.spitX ?? e.x;
        const hz = e.spitZ ?? e.z;
        let hits = 0;
        for (const u of squad.units) {
          if (!u.alive) continue;
          const dx = u.x - hx;
          const dz = u.z - hz;
          if (dx * dx + dz * dz > SPITTER.radius * SPITTER.radius) continue;
          u.hp -= SPITTER.damage * e.damageMul;
          u.flash = 0.12;
          hits++;
          if (u.hp <= 0) {
            u.alive = false;
            squad.markDirty();
            out.push({ type: 'soldierDown', x: u.x, y: 0.9, z: u.z });
          }
        }
        out.push({ type: 'spitterHit', x: hx, y: 0.3, z: hz, radius: SPITTER.radius, amount: hits });
      }
    }

    if (gap > SPITTER.standoff) {
      // 还没到位：正常往前压。冷却在路上就开始转，否则等它站定再从头数
      // 三秒，往往还没开过一次火就已经被打死了。
      e.abilityCd = (e.abilityCd ?? 0) - dt;
      e.z -= speed * dt;
      const dx = clamp(squad.x + e.laneOffset * 5, -ROAD_HALF + 0.8, ROAD_HALF - 0.8) - e.x;
      e.x += Math.sign(dx) * Math.min(Math.abs(dx), speed * 0.5 * dt);
      e.phase += dt * (3.2 + speed * 0.55);
      return;
    }

    // 到位了：站定开火，稍微侧向游走避免叠成一堆
    e.phase += dt * 1.6;
    e.x += Math.sin(e.phase * 0.6 + e.id) * dt * 1.2;
    e.x = clamp(e.x, -ROAD_HALF + 0.8, ROAD_HALF - 0.8);
    e.abilityCd = (e.abilityCd ?? 0) - dt;
    if ((e.abilityCd ?? 0) > 0 || (e.spitT ?? 0) > 0) return;
    e.abilityCd = SPITTER.cooldown;
    e.spitT = SPITTER.telegraph;
    // 往方阵当前位置抛，带一点散布——预判量刚好让"一直站着不动"必被命中
    e.spitX = clamp(squad.x + this.rng.range(-2.2, 2.2), -ROAD_HALF + 1, ROAD_HALF - 1);
    e.spitZ = squad.z + this.rng.range(-1, squad.depth * 0.6);
    out.push({
      type: 'spitterFire', x: e.x, y: 1.2 * e.scale, z: e.z,
      tx: e.spitX, ty: 0.2, tz: e.spitZ, radius: SPITTER.radius,
    });
  }

  /** 跳跃者起跳：落点直接扎进方阵中后段，越过整个前排。 */
  private startLeap(e: Enemy, squad: Squad, out: SimEvent[]): void {
    e.leapT = LEAPER.airTime;
    e.leapFromX = e.x;
    e.leapFromZ = e.z;
    e.leapToX = clamp(squad.x + this.rng.range(-squad.halfWidth, squad.halfWidth), -ROAD_HALF + 1, ROAD_HALF - 1);
    e.leapToZ = squad.z - LEAPER.landDepth * this.rng.range(0.5, 1);
    e.abilityCd = LEAPER.cooldown;
    out.push({ type: 'leaperJump', x: e.x, y: 0.6, z: e.z, tx: e.leapToX, ty: 0, tz: e.leapToZ });
  }

  /** 滞空段：走一条抛物线，落地时对落点周围造成一次伤害。 */
  private updateLeap(dt: number, e: Enemy, out: SimEvent[]): void {
    e.leapT = Math.max(0, (e.leapT ?? 0) - dt);
    const t = 1 - (e.leapT ?? 0) / LEAPER.airTime;
    e.x = (e.leapFromX ?? e.x) + ((e.leapToX ?? e.x) - (e.leapFromX ?? e.x)) * t;
    e.z = (e.leapFromZ ?? e.z) + ((e.leapToZ ?? e.z) - (e.leapFromZ ?? e.z)) * t;
    e.airY = Math.sin(t * Math.PI) * 4.2;
    e.phase += dt * 2;
    if ((e.leapT ?? 0) > 0) return;
    e.airY = 0;
    out.push({ type: 'leaperLand', x: e.x, y: 0.2, z: e.z, radius: LEAPER.radius });
  }

  /**
   * 接触面结算。
   * 只有站在最前一层的僵尸够得着士兵；后面的按层往后堆，形成压迫感十足的尸墙。
   * 这解决了"几百只僵尸同时啃同一排士兵"导致的秒杀问题。
   */
  private resolveMelee(dt: number, squad: Squad, contact: Enemy[], out: SimEvent[]): void {
    if (contact.length === 0) return;
    // 先到先得：越靠前的越有资格站在第一层
    contact.sort((a, b) => a.z - b.z);

    const perRow = Math.max(3, Math.round(squad.cols * MELEE.frontRowFactor));
    const frontZ = squad.z + SOLDIER.contactDepth;
    const rowWidth = Math.max(3, squad.halfWidth * 2 + 1.2);

    for (let i = 0; i < contact.length; i++) {
      const e = contact[i]!;
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      // 站位：一层一层往后铺开
      const tx = squad.x - rowWidth / 2 + ((col + 0.5) / perRow) * rowWidth;
      const tz = frontZ + e.scale * 0.5 + row * MELEE.queueDepth;
      const k = Math.min(1, dt * 7);
      e.x += (tx - e.x) * k;
      e.z += (tz - e.z) * k;

      // 只有第一层能咬到人（大体型的怪伸手更远，第二层也够得着）
      const canReach = row === 0 || (row === 1 && e.scale >= 2);
      if (!canReach) continue;

      e.attackCd -= dt;
      if (e.attackCd > 0) continue;
      e.attackCd = SOLDIER.hitCooldown;

      const st = ENEMY_STATS[e.kind];
      const dmg = st.damage * e.damageMul * this.damageScale;
      for (let s = 0; s < st.sweep; s++) {
        const target = squad.pickFrontTarget(this.rng.next());
        if (!target) break;
        target.hp -= dmg;
        target.flash = 0.12;
        if (target.hp <= 0) {
          target.alive = false;
          squad.markDirty();
          out.push({ type: 'soldierDown', x: target.x, y: 0.9, z: target.z });
        }
      }
    }
  }

  /**
   * 大型敌人之间互相推开。
   * 巨怪体积大，如果任由它们朝同一个点收拢，几只泰坦会完全重叠成一团
   * 认不出形状。数量少（个位数到几十），O(n²) 完全够用。
   */
  private separateBig(dt: number): void {
    const big = this.bigBuf;
    big.length = 0;
    for (const e of this.list) {
      if (e.alive && !e.scripted && e.scale >= 1.5) big.push(e);
      if (big.length >= 80) break;
    }
    for (let i = 0; i < big.length; i++) {
      const a = big[i]!;
      for (let j = i + 1; j < big.length; j++) {
        const b = big[j]!;
        const want = (a.scale + b.scale) * 0.62;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d >= want) continue;
        if (d < 0.001) {
          dx = (a.id % 2 === 0 ? 1 : -1) * 0.05;
          dz = 0;
          d = 0.05;
        }
        const push = ((want - d) / d) * 0.5 * Math.min(1, dt * 9);
        a.x -= dx * push;
        a.z -= dz * push;
        b.x += dx * push;
        b.z += dz * push;
      }
      a.x = clamp(a.x, -ROAD_HALF + 0.8, ROAD_HALF - 0.8);
    }
  }

  /** 距离方阵最近的 n 个活着的敌人（用来做集火目标池）。 */
  /**
   * 火线上的目标 —— 枪不自瞄，子弹只往正前方飞。
   *
   * 判定是一条以方阵为中心、宽度约等于一条车道的走廊：站在哪一排，火力就
   * 只落在哪一排。以前这里是"最近的 N 只"，方阵站在最左边照样能把最右边的
   * 怪打死，走位对输出完全没有影响——那才是这个游戏没有手感的根源。
   *
   * `corridor` 传 Infinity 就退化成全场索敌，大炮走这条路：它是曲射武器，
   * 能砸到隔壁排。这也是"炮兵编制"这条升级线真正的价值所在。
   */
  forwardTargets(
    squad: Squad,
    range: number,
    limit: number,
    out: Enemy[],
    corridor = fireCorridor(squad),
  ): void {
    out.length = 0;
    for (const e of this.list) {
      if (!e.alive || e.invulnerable) continue;
      // 已经冲过方阵的不再是"正前方"
      if (e.z < squad.z - 2) continue;
      const dz = e.z - squad.z;
      if (dz > range) continue;
      // 目标自己的半宽也算数：一只 scale 6.8 的 Boss 身宽十几米，横跨整条路，
      // 站在隔壁排照样打得到——按 0.5 算的话它会在自己的身体里"闪身"，
      // Boss 战会变成"追着它换排"，一场打三分钟。
      if (Math.abs(e.x - squad.x) > corridor + e.scale) continue;
      out.push(e);
    }
    out.sort((a, b) => (a.z - squad.z) - (b.z - squad.z));
    if (out.length > limit) out.length = limit;
  }

  clear(): void {
    this.list.length = 0;
    this.contactCount = 0;
  }
}

/**
 * 步枪的火线走廊半宽 —— 正好是"你脚下那一排"。
 *
 * 一开始这里写的是"方阵半宽 + 余量"，结果满编方阵只有 6 米宽、一排却有
 * 7.3 米，站在排中央都够不到排边上的怪，和玩家看到的画面对不上。走廊至少
 * 要盖住整条车道：站在这一排，这一排的东西就都打得到，隔壁排一个都够不着。
 */
export function fireCorridor(squad: Squad): number {
  return Math.max(squad.halfWidth + FIRE_CORRIDOR_PAD, LANE_WIDTH / 2);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
