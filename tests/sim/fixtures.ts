export { CANNON } from '../../src/config/balance';
export type { UpgradeId } from '../../src/config/balance';
import type { UpgradeId } from '../../src/config/balance';

/** 商店全满时的升级等级。 */
export const LEVELS_MAX_UPGRADES: Record<UpgradeId, number> = {
  squad: 12,
  damage: 12,
  fireRate: 10,
  cannon: 6,
  armor: 10,
  weapon: 3,
};
