/** 站在真正做决定的距离上（门前约 30 米）看铭牌读不读得清。 */
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
for (const [lvl, tag] of [[1, 'free'], [3, 'priced']]) {
  await page.evaluate(() => { if (window.__game.world) window.__game.debugMenu(); });
  await page.waitForTimeout(320);
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(420);
  await page.evaluate(() => {
    const w = window.__game.world;
    const g = w.gates.find((x) => (x.left.gate.cost ?? 0) > 0 || (x.right.gate.cost ?? 0) > 0) ?? w.gates[0];
    w.squad.z = g.z - 30;
    w.gold = 900;
  });
  await page.evaluate(() => window.__game.fastForward(0.1));
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/gateread-${tag}.png`, timeout: 120000 });
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
