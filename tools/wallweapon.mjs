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

const info = () => page.evaluate(() => {
  const w = window.__game.world;
  const b = w.blocks.find((x) => x.rewardWeapon !== undefined) ?? w.blocks.find((x) => x.alive);
  return b ? { gap: +(b.z - w.squad.z).toFixed(1), lane: b.lane, hp: Math.round(b.hp), alive: b.alive, rw: b.rewardWeapon } : null;
});
console.log('t0', JSON.stringify(await info()));

// 走到军械墙那一排上，冲到它跟前再截图
await page.evaluate(() => {
  const g = window.__game;
  const b = g.world.blocks.find((x) => x.rewardWeapon !== undefined);
  if (b) g.input.targetX = (b.x0 + b.x1) / 2;
});
for (let i = 0; i < 60; i++) {
  const g = await page.evaluate(() => {
    const w = window.__game.world;
    const b = w.blocks.find((x) => x.rewardWeapon !== undefined);
    return b ? b.z - w.squad.z : -1;
  });
  if (g < 0 || g < 30) break;
  await page.evaluate(() => window.__game.fastForward(0.3));
}
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/wall-approach.png`, timeout: 120000 });
console.log('approach', JSON.stringify(await info()));
console.log('ERRORS', errs);
await browser.close();
