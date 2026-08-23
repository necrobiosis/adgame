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

for (const [lvl, name] of [[1, 'apoc-l1'], [4, 'apoc-l4']]) {
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__game.fastForward(1.0));
  // 不用 inspect——default 追尾镜头，多等几秒真实帧让飞龙的 CPU 端计时器走起来
  await page.waitForTimeout(3500);
  console.log(name, JSON.stringify(await page.evaluate(() => window.__game.debug())));
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 });
  await page.evaluate(() => window.__game.debugMenu());
  await page.waitForTimeout(400);
}
console.log('ERRORS', errs);
await browser.close();
