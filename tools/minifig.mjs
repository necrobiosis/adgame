import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('adgame.save.v1', '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(800);
for (const [name, target, dist, height, yaw] of [
  ['squad', 'squad', 1.9, 1.0, 0.35],
  ['squadside', 'squad', 2.2, 1.0, 1.5],
  ['enemy', 'enemy', 2.0, 1.0, 0.5],
]) {
  await page.evaluate(() => window.__game.fastForward(9));
  await page.evaluate(([t, d, h, y]) => window.__game.inspect(t, d, h, y), [target, dist, height, yaw]);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/mf-${name}.png`, timeout: 120000 });
}
await page.evaluate(() => window.__game.inspect(null));
console.log('ERRORS', errs);
await browser.close();
