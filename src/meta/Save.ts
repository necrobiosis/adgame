import { LEVELS } from '../config/levels';
import { UPGRADES, type UpgradeId } from '../config/balance';

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
  muted: boolean;
}

function emptyUpgrades(): Record<UpgradeId, number> {
  const u = {} as Record<UpgradeId, number>;
  for (const def of UPGRADES) u[def.id] = 0;
  return u;
}

export function defaultSave(): SaveData {
  return { version: 1, gold: 0, unlockedLevel: 1, upgrades: emptyUpgrades(), bestTime: {}, muted: false };
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

export function buyUpgrade(id: UpgradeId, save: SaveData): boolean {
  const cost = nextCost(id, save);
  if (cost === null || save.gold < cost) return false;
  save.gold -= cost;
  save.upgrades[id] = (save.upgrades[id] ?? 0) + 1;
  writeSave(save);
  return true;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}
