import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = process.argv[3] ?? '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":8,"fireRate":6,"cannon":4,"armor":6,"weapon":2},"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

for (const [level, cond, name] of JSON.parse(process.argv[2])) {
  await page.click(`[data-level="${level}"]`);
  await page.waitForTimeout(600);
  let d = null;
  for (let i = 0; i < 140; i++) {
    await page.evaluate(() => window.__game.fastForward(0.5));
    d = await page.evaluate(() => window.__game.debug());
    if (d.simPhase !== 'running') break;
    if (eval(cond)) break;
  }
  await page.waitForTimeout(800);
  console.log(name, JSON.stringify(await page.evaluate(() => window.__game.debug())));
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  await page.evaluate(() => window.__game.debugMenu());
  await page.waitForTimeout(400);
}
console.log('ERRORS', errs);
await browser.close();
