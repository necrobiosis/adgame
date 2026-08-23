import {
  FORMATION_MAX_COLS,
  MAX_SOLDIERS,
  MAX_WEAPON_LEVEL,
  ROAD_HALF,
  SLOT_SPACING_X,
  SLOT_SPACING_Z,
  SOLDIER,
  WEAPON_TIERS,
  CANNON,
  type WeaponTier,
} from '../config/balance';
import type { Rng } from '../core/Rng';
import type { Unit } from './types';

export interface SquadInit {
  soldiers: number;
  cannons: number;
  weaponLevel: number;
  damageMul: number;
  fireRateMul: number;
  hpMul: number;
}

/**
 * 方阵：兵力、阵型、武器等级、大炮。
 * 前排是步兵，大炮永远排在最后面（还原广告里"后面变大炮"的观感）。
 */
export class Squad {
  readonly units: Unit[] = [];
  /** 方阵中心 x。 */
  x = 0;
  /** 方阵前沿 z（第 0 排所在位置）。 */
  z = 0;

  weaponLevel: number;
  damageMul: number;
  fireRateMul: number;
  hpMul: number;

  /** 阵型缓存，供渲染层读取。 */
  cols = 1;
  rows = 1;
  spacingX = SLOT_SPACING_X;

  private nextId = 1;
  private dirty = true;

  constructor(init: SquadInit, private readonly rng: Rng) {
    this.weaponLevel = clampInt(init.weaponLevel, 0, MAX_WEAPON_LEVEL);
    this.damageMul = init.damageMul;
    this.fireRateMul = init.fireRateMul;
    this.hpMul = init.hpMul;
    this.addSoldiers(init.soldiers);
    this.addCannons(init.cannons);
  }

  get soldierCount(): number {
    let n = 0;
    for (const u of this.units) if (u.alive && !u.isCannon) n++;
    return n;
  }

  get cannonCount(): number {
    let n = 0;
    for (const u of this.units) if (u.alive && u.isCannon) n++;
    return n;
  }

  get aliveCount(): number {
    let n = 0;
    for (const u of this.units) if (u.alive) n++;
    return n;
  }

  get weapon(): WeaponTier {
    return WEAPON_TIERS[this.weaponLevel]!;
  }

  get unitMaxHp(): number {
    return SOLDIER.baseHp * this.hpMul;
  }

  /** 方阵横向半宽（用于接触判定与镜头取景）。 */
  get halfWidth(): number {
    return (this.cols * this.spacingX) / 2;
  }

  /** 方阵纵深。 */
  get depth(): number {
    return this.rows * SLOT_SPACING_Z;
  }

  // ── 编制变更 ────────────────────────────────────────────────

  /**
   * 加兵。返回实际加进来的人数。
   * 撞到 MAX_SOLDIERS 上限时多出来的那部分由调用方折算成金币退回去
   * （见 overflowOf），后期的 "×3" / "+190" 才不会变成白拿的空门。
   */
  addSoldiers(n: number): number {
    const room = MAX_SOLDIERS - this.aliveCount;
    const add = Math.max(0, Math.min(Math.floor(n), room));
    for (let i = 0; i < add; i++) this.units.push(this.makeUnit(false));
    if (add > 0) this.dirty = true;
    return add;
  }

  /** 想加 want 人、实际只加进 got 人时，被上限吃掉的溢出量。 */
  static overflowOf(want: number, got: number): number {
    return Math.max(0, Math.floor(want) - got);
  }

  addCannons(n: number): number {
    const room = CANNON.maxCannons - this.cannonCount;
    const add = Math.max(0, Math.min(Math.floor(n), room));
    for (let i = 0; i < add; i++) this.units.push(this.makeUnit(true));
    if (add > 0) this.dirty = true;
    return add;
  }

  /**
   * 把后排的 n 名步兵变成大炮。步兵不够时补新的大炮单位。
   * 返回实际增加的大炮数。
   */
  convertToCannons(n: number): number {
    const want = Math.max(0, Math.floor(n));
    const room = CANNON.maxCannons - this.cannonCount;
    const target = Math.min(want, room);
    let made = 0;
    // 从数组末尾往前找步兵 —— 末尾正是阵型的后排。
    for (let i = this.units.length - 1; i >= 0 && made < target; i--) {
      const u = this.units[i]!;
      if (u.alive && !u.isCannon) {
        u.isCannon = true;
        u.cooldown = 0;
        made++;
      }
    }
    // 步兵不够，直接补大炮
    if (made < target) made += this.addCannons(target - made);
    if (made > 0) this.dirty = true;
    return made;
  }

  /** 移除 n 名步兵（惩罚门）。至少保留 1 个单位，避免"过个门直接暴毙"。 */
  removeSoldiers(n: number): number {
    let removed = 0;
    const want = Math.floor(n);
    for (let i = this.units.length - 1; i >= 0 && removed < want; i--) {
      const u = this.units[i]!;
      if (u.alive && !u.isCannon && this.aliveCount > 1) {
        u.alive = false;
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /** 乘法门。返回 [实际加进来的人数, 想加的人数]，差额由调用方折金。 */
  multiplySoldiers(k: number): [added: number, wanted: number] {
    const before = this.soldierCount;
    const wanted = Math.max(0, Math.floor(before * k) - before);
    return [this.addSoldiers(wanted), wanted];
  }

  divideSoldiers(k: number): number {
    const before = this.soldierCount;
    const target = Math.max(1, Math.floor(before / k));
    return this.removeSoldiers(before - target);
  }

  upgradeWeapon(levels: number): number {
    const before = this.weaponLevel;
    this.weaponLevel = clampInt(this.weaponLevel + levels, 0, MAX_WEAPON_LEVEL);
    return this.weaponLevel - before;
  }

  /** 全队加护甲：同时提高上限并按比例回血。 */
  addArmorPercent(pct: number): void {
    const k = 1 + pct / 100;
    this.hpMul *= k;
    const max = this.unitMaxHp;
    for (const u of this.units) {
      if (!u.alive) continue;
      const ratio = u.maxHp > 0 ? u.hp / u.maxHp : 1;
      u.maxHp = max;
      u.hp = Math.min(max, max * ratio + max * (k - 1));
    }
  }

  addFireRatePercent(pct: number): void {
    this.fireRateMul *= 1 + pct / 100;
  }

  // ── 每帧 ────────────────────────────────────────────────────

  /** 清掉阵亡单位，必要时重排阵型。 */
  compact(): void {
    if (!this.dirty) return;
    let w = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i]!;
      if (u.alive) this.units[w++] = u;
    }
    this.units.length = w;
    // 大炮沉底，保证渲染时永远在后排
    this.units.sort((a, b) => Number(a.isCannon) - Number(b.isCannon));
    this.dirty = false;
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** 重算每个单位的世界坐标。 */
  layout(): void {
    this.compact();
    const n = this.units.length;
    if (n === 0) {
      this.cols = 1;
      this.rows = 0;
      return;
    }
    // 人越多方阵越宽（但不超出路面），保持一个紧凑的方块而不是长队。
    const cols = clampInt(Math.ceil(Math.sqrt(n * 2.2)), 1, Math.max(FORMATION_MAX_COLS, 22));
    const spacing = Math.min(SLOT_SPACING_X, (ROAD_HALF * 2 - 3) / Math.max(1, cols));
    this.cols = cols;
    this.rows = Math.ceil(n / cols);
    this.spacingX = spacing;

    for (let i = 0; i < n; i++) {
      const u = this.units[i]!;
      const row = Math.floor(i / cols);
      const col = i % cols;
      const inRow = Math.min(cols, n - row * cols);
      const rowWidth = (inRow - 1) * spacing;
      u.row = row;
      u.col = col;
      u.x = this.x - rowWidth / 2 + col * spacing;
      u.z = this.z - row * SLOT_SPACING_Z;
    }
  }

  /** 给敌人挑一个可啃的前排单位。 */
  pickFrontTarget(rand: number): Unit | null {
    // 前 3 排里随机挑一个活着的
    const frontCount = Math.min(this.units.length, this.cols * 3);
    if (frontCount === 0) return null;
    const start = Math.floor(rand * frontCount);
    for (let k = 0; k < frontCount; k++) {
      const u = this.units[(start + k) % frontCount]!;
      if (u.alive) return u;
    }
    for (const u of this.units) if (u.alive) return u;
    return null;
  }

  private makeUnit(isCannon: boolean): Unit {
    const max = this.unitMaxHp;
    return {
      id: this.nextId++,
      x: this.x,
      z: this.z,
      hp: max,
      maxHp: max,
      alive: true,
      isCannon,
      cooldown: this.rng.next() * 0.4,
      row: 0,
      col: 0,
      flash: 0,
    };
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}
