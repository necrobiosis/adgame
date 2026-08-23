import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

for (let i = 0; i < 400; i++) {
  await page.evaluate(() => window.__game.fastForward(0.4));
  const alive = await page.evaluate(() => window.__game.world?.boss?.enemy?.alive ?? false);
  if (alive) break;
}
await page.evaluate(() => window.__game.inspect('boss', 9, 1.5, Math.PI + 0.1));
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/face-boss2.png`, timeout: 120000 });
// 头部特写：cy 已经是眼睛高度，只拉近距离，不要再加高度偏移
await page.evaluate(() => window.__game.inspect('boss', 4, 0.3, Math.PI + 0.05));
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/face-boss-head.png`, timeout: 120000 });
console.log('debug', JSON.stringify(await page.evaluate(() => window.__game.debug())));
console.log('ERRORS', errs);
await browser.close();
