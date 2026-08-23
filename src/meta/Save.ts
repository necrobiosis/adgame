import { LEVELS } from '../config/levels';
import { LOADOUT, UPGRADES, type UpgradeId } from '../config/balance';

const KEY = 'adgame.save.v1';

export interface SaveData {
  version: 1;
  gold: number;
  /** 已解锁到第几关（1..5）。 */
  unlockedLevel: number;
  upgrades: Record<UpgradeId, number>;
  /** 每关最好成绩：通关用时（秒），没通关就没有条目。 */
  bestTime: Partial<Record<number, number>>;
  /** 无尽模式的最远推进距离（米）。 */
  bestDistance?: number;
  /**
   * 这一次出征带上场的模块。
   *
   * 买到的东西进 `upgrades`，带上场的才进这里——两者分开，"商店买满"
   * 才不等于"开局无敌"。
   */
  loadout: UpgradeId[];
  muted: boolean;
}

function emptyUpgrades(): Record<UpgradeId, number> {
  const u = {} as Record<UpgradeId, number>;
  for (const def of UPGRADES) u[def.id] = 0;
  return u;
}

export function defaultSave(): SaveData {
  return { version: 1, gold: 0, unlockedLevel: 1, upgrades: emptyUpgrades(), bestTime: {}, loadout: [], muted: false };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    const base = defaultSave();
    return {
      version: 1,
      gold: Math.max(0, Math.floor(parsed.gold ?? 0)),
      unlockedLevel: clamp(parsed.unlockedLevel ?? 1, 1, LEVELS.length),
      upgrades: { ...base.upgrades, ...(parsed.upgrades ?? {}) },
      bestTime: parsed.bestTime ?? {},
      // 老存档没有这个字段：按已买的模块自动补一套，玩家不会一进来发现
      // 自己什么都没带
      loadout: sanitizeLoadout(parsed.loadout, { ...base.upgrades, ...(parsed.upgrades ?? {}) }),
      muted: parsed.muted ?? false,
    };
  } catch {
    // 存档坏了就当新玩家，不要因此把游戏卡死
    return defaultSave();
  }
}

export function writeSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // 隐私模式下 localStorage 会抛异常，忽略即可
  }
}

/** 某个升级下一级要多少钱；已满级返回 null。 */
export function nextCost(id: UpgradeId, save: SaveData): number | null {
  const def = UPGRADES.find((u) => u.id === id)!;
  const lv = save.upgrades[id] ?? 0;
  if (lv >= def.maxLevel) return null;
  return def.cost(lv);
}

/** 这份存档现在有几个装备位。 */
export function slotCount(save: SaveData): number {
  return Math.min(LOADOUT.max, LOADOUT.base + (save.upgrades.slots ?? 0));
}

/** 装备位是否还有空。 */
export function loadoutFull(save: SaveData): boolean {
  return save.loadout.length >= slotCount(save);
}

/**
 * 装上 / 卸下一个模块。等级为 0 的模块装不上（还没买）。
 * 位子满了再装就无声失败，由 UI 负责给出提示。
 */
export function toggleLoadout(id: UpgradeId, save: SaveData): boolean {
  const def = UPGRADES.find((u) => u.id === id);
  if (!def || def.passive) return false;
  const i = save.loadout.indexOf(id);
  if (i >= 0) {
    save.loadout.splice(i, 1);
    writeSave(save);
    return true;
  }
  if ((save.upgrades[id] ?? 0) <= 0 || loadoutFull(save)) return false;
  save.loadout.push(id);
  writeSave(save);
  return true;
}

/** 清掉不合法的条目（没买的、被动的、重复的、超出位数的）。 */
function sanitizeLoadout(raw: unknown, ups: Record<UpgradeId, number>): UpgradeId[] {
  const slots = Math.min(LOADOUT.max, LOADOUT.base + (ups.slots ?? 0));
  const valid = new Set(UPGRADES.filter((u) => !u.passive).map((u) => u.id));
  const seen = new Set<UpgradeId>();
  const out: UpgradeId[] = [];
  if (Array.isArray(raw)) {
    for (const id of raw as UpgradeId[]) {
      if (!valid.has(id) || seen.has(id) || (ups[id] ?? 0) <= 0) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= slots) return out;
    }
  }
  // 补位：按商店顺序把已买的模块填进空位——老存档升上来不会"空手上场"
  if (out.length === 0) {
    for (const def of UPGRADES) {
      if (def.passive || (ups[def.id] ?? 0) <= 0 || seen.has(def.id)) continue;
      seen.add(def.id);
      out.push(def.id);
      if (out.length >= slots) break;
    }
  }
  return out;
}

export function buyUpgrade(id: UpgradeId, save: SaveData): boolean {
  const cost = nextCost(id, save);
  if (cost === null || save.gold < cost) return false;
  save.gold -= cost;
  save.upgrades[id] = (save.upgrades[id] ?? 0) + 1;
  // 第一次买到某个模块时，只要还有空位就直接帮玩家装上——
  // "买了却忘了装"是纯粹的挫败，不是策略
  const def = UPGRADES.find((u) => u.id === id)!;
  if (!def.passive && save.upgrades[id] === 1 && !loadoutFull(save)) save.loadout.push(id);
  writeSave(save);
  return true;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}
