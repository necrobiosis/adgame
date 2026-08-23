/**
 * 士兵三档装备的实机核对。
 * 同一个视角把 8 级武器逐级切一遍，看轻装 / 制式 / 重装是不是真的一眼分得出。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":0,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 560, height: 760 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(700);

for (const tier of [0, 1, 2, 3, 4, 5, 6, 7]) {
  const info = await page.evaluate((t) => {
    const g = window.__game;
    g.world.squad.weaponLevel = t;
    g.view.inspect = { target: 'squad', dist: 3.4, height: 0.35, yaw: 0.55 };
    return { name: g.balance.WEAPON_TIERS[t].name };
  }, tier);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/gear-${tier}.png`, timeout: 120000 });
  const tris = await page.evaluate(() => window.__game.debug?.().tris ?? 0);
  console.log(`tier ${tier} ${info.name.padEnd(5)} tris=${tris}`);
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
