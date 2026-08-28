/**
 * 墙上的倒刺 + 硬撞穿的实机核对。
 * 走到墙那一排上撞过去，看刺长在正面、撞上去喷血、墙碎掉、速度不掉。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":0,"fireRate":0,"cannon":0,"armor":10,"weapon":0,"slots":1},"loadout":["squad","armor","damage","fireRate","weapon"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => document.querySelector('[data-level="4"]').click());
await page.waitForTimeout(700);

// 直接送到第一堵墙前面，清场，站到那一排上
const info = await page.evaluate(() => {
  const w = window.__game.world;
  w.squad.addSoldiers(200);
  const b = w.blocks[0];
  w.squad.z = b.z - 34;
  w.squad.x = (b.x0 + b.x1) / 2;
  w.squad.layout();
  w.enemies.clear();
  return { lane: b.lane, hp: b.hp, dz: +(b.z - w.squad.z).toFixed(1), soldiers: w.squad.soldierCount };
});
console.log('准备撞墙', JSON.stringify(info));
await page.waitForTimeout(900);
await page.screenshot({ path: `${SHOTS}/spikes-approach.png`, timeout: 120000 });

// 撞上去
let shot = false;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(100);
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    const b = w.blocks[0];
    return { alive: b.alive, dz: +(b.z - w.squad.z).toFixed(1), soldiers: w.squad.soldierCount };
  });
  if (!shot && st.dz < 1.2) {
    shot = true;
    await page.screenshot({ path: `${SHOTS}/spikes-impact.png`, timeout: 120000 });
  }
  if (!st.alive && st.dz < -3) {
    console.log('撞穿之后', JSON.stringify(st));
    break;
  }
}
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/spikes-after.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
