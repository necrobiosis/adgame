/** 远景：清空一段路，把三只泰坦摆在一百五十米外，看玩家能不能提前看见。 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":0,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","armor"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => document.querySelector('[data-level="4"]').click());
await page.waitForTimeout(700);
const info = await page.evaluate(() => {
  const w = window.__game.world;
  w.squad.addSoldiers(120);
  // 找一段前方 200 米内没有门也没有墙的直路
  let z = w.squad.z;
  for (let i = 0; i < 400; i++) {
    const clash = w.gates.some((g) => g.z > z && g.z < z + 200)
      || w.blocks.some((b) => b.z > z && b.z < z + 200);
    if (!clash) break;
    z += 20;
  }
  w.squad.z = z;
  w.squad.x = 0;
  w.squad.layout();
  w.enemies.clear();
  for (let i = 0; i < 3; i++) {
    const e = w.enemies.spawn('titan', -7.33 + i * 7.33, z + 150);
    e.laneX = e.x;
  }
  for (let i = 0; i < 40; i++) {
    const e = w.enemies.spawn('walker', -7.33 + Math.random() * 3, z + 40 + Math.random() * 30);
    e.laneX = e.x;
  }
  return { z: Math.round(z) };
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${SHOTS}/farview.png`, timeout: 120000 });
const d = await page.evaluate(() => window.__game.debug().drawn);
console.log('起点 z =', info.z, '画出来的 titan =', d.titan, 'walker =', d.walker);
console.log('ERRORS', errs.length ? errs.slice(0, 4) : '[]');
await browser.close();
