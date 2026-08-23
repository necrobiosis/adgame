import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

// L1's tall bonus wall/block info + pickups list right after start
const info0 = await page.evaluate(() => {
  const w = window.__game.world;
  return {
    pickups: w.pickups.map(p => ({ x: p.x, z: p.z, amount: p.amount, alive: p.alive })),
    blocks: w.blocks ? w.blocks.map(b => ({ z: b.z, span: b.span, tall: b.tall, bonus: b.bonus, hp: b.hp })) : null,
    gold: w.gold,
  };
});
console.log('L1 initial pickups/blocks', JSON.stringify(info0, null, 0));

// fast-forward a bit without rendering to approach the first pickup/wall
await page.evaluate(() => window.__game.fastForward(3));
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/gw-early.png`, timeout: 120000 });

// step forward in small increments checking pickup collection + gold change
let prevGold = info0.gold;
for (let i = 0; i < 20; i++) {
  await page.evaluate(() => window.__game.fastForward(1));
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    return { z: w.squad.z.toFixed(1), gold: w.gold, alivePickups: w.pickups.filter(p => p.alive).length, totalPickups: w.pickups.length };
  });
  if (st.gold !== prevGold) {
    console.log(`step ${i}: gold changed ${prevGold} -> ${st.gold} at z=${st.z}, alivePickups=${st.alivePickups}/${st.totalPickups}`);
    prevGold = st.gold;
  }
}
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/gw-after-run.png`, timeout: 120000 });

// find and inspect the tall wall block up close
const wallInfo = await page.evaluate(() => {
  const w = window.__game.world;
  const b = w.blocks.find(bl => bl.tall);
  return b ? { x0: b.x0, x1: b.x1, z: b.z, tall: b.tall, bonus: b.bonus, hp: b.hp, alive: b.alive } : null;
});
console.log('tall wall', JSON.stringify(wallInfo));

if (wallInfo) {
  // teleport squad near wall to look at it (dev-only direct manipulation for a screenshot, not gameplay-affecting check)
  await page.evaluate((z) => { window.__game.world.squad.z = Math.max(window.__game.world.squad.z, z - 20); }, wallInfo.z);
  await page.evaluate(() => window.__game.inspect(null));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__game.fastForward(0.1));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/gw-wall.png`, timeout: 120000 });
}

const finalDebug = await page.evaluate(() => window.__game.debug());
console.log('final debug', JSON.stringify(finalDebug));
console.log('ERRORS', errs);
await browser.close();
