/** 五关各截一张，确认现在能一眼看出是不同的关卡。 */
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
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":10,"damage":6,"fireRate":6,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

for (const lvl of [1, 2, 3, 4, 5]) {
  await page.evaluate(() => { if (window.__game.world) window.__game.debugMenu(); });
  await page.waitForTimeout(350);
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__game.fastForward(14));
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => ({
    weather: window.__game.view.weather ? window.__game.view.weather.mesh.count : 0,
    fog: window.__game.renderer?.scene?.fog
      ? [Math.round(window.__game.renderer.scene.fog.near), Math.round(window.__game.renderer.scene.fog.far)]
      : null,
    tris: window.__game.debug().tris,
  }));
  console.log(`L${lvl}`, JSON.stringify(info));
  await page.screenshot({ path: `${SHOTS}/level-${lvl}.png`, timeout: 120000 });
}
console.log('ERRORS', errs.length ? errs.slice(0, 6) : '[]');
await browser.close();
