import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","cannon","armor"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);

for (const lvl of [1, 2]) {
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/brick-L${lvl}-start.png`, timeout: 120000 });
  await page.evaluate(() => window.__game.fastForward(12));
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${SHOTS}/brick-L${lvl}-mid.png`, timeout: 120000 });
  const tri = await page.evaluate(() => window.__game.debug());
  console.log(`L${lvl}`, JSON.stringify(tri));
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => { location.reload(); });
  await page.waitForTimeout(2200);
}
console.log('ERRORS', errs);
await browser.close();
