import type { GateSpec } from '../config/levels';
import type { Squad } from './Squad';

export interface GateVisual {
  /** 门墙上重复堆叠的短字形（还原广告里那面 "+1" / "+99" 流动数字墙）。 */
  glyph: string;
  /** 门顶铭牌上的完整说明。 */
  title: string;
  /** 主色。 */
  color: number;
  /** 是增益还是惩罚（决定发光色调与音效）。 */
  buff: boolean;
}

export function gateVisual(g: GateSpec): GateVisual {
  switch (g.type) {
    case 'add':
      return { glyph: `+${g.value}`, title: `士兵 +${g.value}`, color: 0x2f9bff, buff: true };
    case 'mul':
      return { glyph: `×${g.value}`, title: `士兵 ×${g.value}`, color: 0x2f9bff, buff: true };
    case 'sub':
      return { glyph: `-${g.value}`, title: `士兵 -${g.value}`, color: 0xff3b3b, buff: false };
    case 'div':
      return { glyph: `÷${g.value}`, title: `士兵 ÷${g.value}`, color: 0xff3b3b, buff: false };
    case 'weapon':
      return { glyph: `武器+${g.value}`, title: `武器升级 +${g.value} 级`, color: 0xff8a1f, buff: true };
    case 'cannon':
      return { glyph: `炮+${g.value}`, title: `后排改装 ${g.value} 门大炮`, color: 0xa45cff, buff: true };
    case 'gold':
      return { glyph: `+${g.value}`, title: `金币 +${g.value}`, color: 0xffc42e, buff: true };
    case 'armor':
      return { glyph: `甲+${g.value}`, title: `护甲 +${g.value}%`, color: 0x35d67a, buff: true };
    case 'firerate':
      return { glyph: `速+${g.value}`, title: `射速 +${g.value}%`, color: 0x25d8d8, buff: true };
  }
}

export interface GateResult {
  /** 屏幕上飘的结算文字。 */
  text: string;
  /** 金币变化。 */
  gold: number;
}

/** 把门的效果作用到方阵上。 */
export function applyGate(squad: Squad, g: GateSpec): GateResult {
  switch (g.type) {
    case 'add': {
      const n = squad.addSoldiers(g.value);
      return { text: `+${n} 士兵`, gold: 0 };
    }
    case 'mul': {
      const n = squad.multiplySoldiers(g.value);
      return { text: `×${g.value}  (+${n})`, gold: 0 };
    }
    case 'sub': {
      const n = squad.removeSoldiers(g.value);
      return { text: `-${n} 士兵`, gold: 0 };
    }
    case 'div': {
      const n = squad.divideSoldiers(g.value);
      return { text: `÷${g.value}  (-${n})`, gold: 0 };
    }
    case 'weapon': {
      const n = squad.upgradeWeapon(g.value);
      return { text: n > 0 ? `${squad.weapon.name}!` : '武器已满级', gold: 0 };
    }
    case 'cannon': {
      const n = squad.convertToCannons(g.value);
      return { text: `+${n} 门大炮`, gold: 0 };
    }
    case 'gold':
      return { text: `+${g.value} 金币`, gold: g.value };
    case 'armor': {
      squad.addArmorPercent(g.value);
      return { text: `护甲 +${g.value}%`, gold: 0 };
    }
    case 'firerate': {
      squad.addFireRatePercent(g.value);
      return { text: `射速 +${g.value}%`, gold: 0 };
    }
  }
}
