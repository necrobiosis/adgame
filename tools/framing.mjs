/** 普通行军 / Boss 战 两种取景，确认人够大又不至于框不下 Boss。 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":6,"damage":6,"fireRate":6,"cannon":2,"armor":6,"weapon":2},"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(500);
await page.evaluate(() => window.__game.fastForward(9));
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/frame-march.png`, timeout: 120000 });
// 推到 Boss
for (let i = 0; i < 60; i++) {
  const st = await page.evaluate(() => ({ b: window.__game.world.boss.enemy?.alive ?? false, p: window.__game.world.phase }));
  if (st.b || st.p !== 'running') break;
  await page.evaluate(() => window.__game.fastForward(3));
}
await page.waitForTimeout(700);
await page.screenshot({ path: `${SHOTS}/frame-boss.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
