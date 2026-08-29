import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","cannon","armor"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1600);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

const door = () => page.evaluate(() => {
  const w = window.__game.world;
  const d = w.armoryDoor;
  return d ? { z: +(d.z - w.squad.z).toFixed(2), lane: d.lane, hp: Math.round(d.hp), max: d.maxHp, sq: +w.squad.z.toFixed(1), sx: +w.squad.x.toFixed(2) } : null;
});
console.log('t0', JSON.stringify(await door()));
await page.evaluate(() => window.__game.fastForward(6));
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/door-far.png`, timeout: 120000 });
console.log('t6', JSON.stringify(await door()));

// park the squad in the door lane (via the real input target) and shoot it
await page.evaluate(() => {
  const g = window.__game;
  const d = g.world.armoryDoor;
  if (d) g.input.targetX = (d.x0 + d.x1) / 2;
});
for (let i = 0; i < 12; i++) await page.evaluate(() => window.__game.fastForward(1.5));
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/door-shooting.png`, timeout: 120000 });
console.log('after camping', JSON.stringify(await door()));
console.log('ERRORS', errs);
await browser.close();
