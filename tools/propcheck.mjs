/** 把镜头压到路肩上，近距离看四种陈设的造型。 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":4,"damage":4,"fireRate":4,"cannon":1,"armor":6,"weapon":2},"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

for (const lvl of [1, 3, 5]) {
  await page.evaluate(() => { if (window.__game.world) window.__game.debugMenu(); });
  await page.waitForTimeout(320);
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(420);
  // 把相机钉到路肩高度，贴近看
  const n = await page.evaluate(() => {
    const v = window.__game.view;
    let count = 0;
    v.levelRoot?.traverse?.((o) => { if (o.isInstancedMesh) count += o.count; });
    // 相机压低、贴到右侧路肩
    window.__game.inspect('squad', 16, 2.2, 1.35);
    return count;
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__game.fastForward(6));
  await page.waitForTimeout(400);
  console.log(`L${lvl} instanced total=${n}`);
  await page.screenshot({ path: `${SHOTS}/props-${lvl}.png`, timeout: 120000 });
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
