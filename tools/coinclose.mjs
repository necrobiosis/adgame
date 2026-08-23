import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

const firstZ = await page.evaluate(() => window.__game.world.pickups[0].z);
console.log('firstPickupZ', firstZ);
// stop the squad right before the first pickup, freeze via inspect at that point
for (let i = 0; i < 40; i++) {
  const z = await page.evaluate(() => window.__game.world.squad.z);
  if (z > firstZ - 6) break;
  await page.evaluate(() => window.__game.fastForward(1));
}
await page.evaluate(() => window.__game.inspect('squad', 6, 1.4, 0));
await page.waitForTimeout(200);
await page.screenshot({ path: `${SHOTS}/coin-close.png`, timeout: 120000 });
console.log('ERRORS', errs);
await browser.close();
