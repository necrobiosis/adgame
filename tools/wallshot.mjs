import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

const wallZ = await page.evaluate(() => window.__game.world.blocks.find(b => b.tall).z);
console.log('wallZ', wallZ);
// bump the wall's hp sky-high purely so it survives long enough to screenshot while intact
await page.evaluate(() => {
  const b = window.__game.world.blocks.find(x => x.tall);
  b.hp = 5_000_000;
  b.maxHp = 5_000_000;
});

// Fast-forward until squad is close but not yet at the wall
for (let i = 0; i < 40; i++) {
  const z = await page.evaluate(() => window.__game.world.squad.z);
  if (z > wallZ - 25) break;
  await page.evaluate(() => window.__game.fastForward(1));
}
const st1 = await page.evaluate(() => {
  const w = window.__game.world;
  const b = w.blocks.find(x => x.tall);
  return { z: w.squad.z, blockHp: b.hp, blockAlive: b.alive, blockMaxHp: b.maxHp };
});
console.log('approach state', JSON.stringify(st1));

// screenshot immediately (real-time loop keeps running so don't linger)
await page.screenshot({ path: `${SHOTS}/wall-tall.png`, timeout: 120000 });

// also grab a normal (non-tall, non-bonus) block for visual contrast if within reach later, else just log
const finalState = await page.evaluate(() => {
  const w = window.__game.world;
  return w.blocks.map(b => ({ z: b.z, tall: b.tall, bonus: b.bonus, alive: b.alive, hp: b.hp }));
});
console.log('blocks state', JSON.stringify(finalState));
console.log('ERRORS', errs);
await browser.close();
