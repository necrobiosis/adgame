/** 五个 Boss 的脸：从正面拉远，比较五只的整体剪影。 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const errs = [];
for (const lvl of [1, 2, 3, 4, 5]) {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  page.on('pageerror', (e) => errs.push(`L${lvl} ` + e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
  await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const w = window.__game.world;
    w.squad.z = w.arenaZ - 50;
  });
  // 等 Boss 出场，然后把血拉满防止它被秒
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(160);
    const ok = await page.evaluate(() => {
      const b = window.__game.world.boss.enemy;
      if (!b) return false;
      b.hp = b.maxHp = 1e9;
      return true;
    });
    if (ok) break;
  }
  await page.evaluate(() => window.__game.inspect('boss', 30, 3.0, 0));
  await page.waitForTimeout(700);
  const name = await page.evaluate(() => window.__game.world.boss.name);
  await page.screenshot({ path: `${SHOTS}/body-L${lvl}.png`, timeout: 120000 });
  console.log(`L${lvl} ${name}`);
  await page.close();
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
