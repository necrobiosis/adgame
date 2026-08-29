import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","cannon","armor"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);
for (let i = 0; i < 400; i++) {
  const near = await page.evaluate(() => {
    const w = window.__game.world;
    const dz = w.squad.z + 34;
    return w.gates.some((g) => !g.taken && Math.abs(g.z - dz) < 3);
  });
  if (near) break;
  await page.evaluate(() => window.__game.fastForward(0.2));
}
const st = await page.evaluate(() => {
  const w = window.__game.world;
  const dz = w.squad.z + 34;
  return { gates: w.gates.filter(g => !g.taken).map(g => +(g.z - dz).toFixed(1)) };
});
console.log('gate offsets from door plane', JSON.stringify(st));
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/door-veil.png`, timeout: 120000 });
console.log('ERRORS', errs);
await browser.close();
