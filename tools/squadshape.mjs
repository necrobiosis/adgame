import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":0,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);
await page.evaluate(() => window.__game.fastForward(0.2));

for (const [target, name, yaw, dist, height] of [
  [15, 'shape-15', 0.3, 5.5, 4.0],
  [236, 'shape-236', 0.3, 5.5, 4.0],
]) {
  const before = await page.evaluate(() => window.__game.world.squad.soldierCount);
  await page.evaluate((n) => window.__game.world.squad.addSoldiers(n - window.__game.world.squad.soldierCount), target);
  await page.waitForTimeout(150);
  await page.evaluate(() => window.__game.inspect('squad', 5.5, 4.0, 0.3));
  await page.waitForTimeout(400);
  console.log(name, 'before', before, JSON.stringify(await page.evaluate(() => window.__game.debug())));
  const rows = await page.evaluate(() => {
    const units = window.__game.world.squad.units.filter((u) => u.alive && !u.isCannon);
    return { totalRows: new Set(units.map((u) => u.row)).size, cols: window.__game.world.squad.cols };
  });
  console.log(name, 'formation', JSON.stringify(rows));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 });
}
console.log('ERRORS', errs);
await browser.close();
