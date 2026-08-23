/** 死法多样性：一次性放倒一批僵尸，在倒地动画中途截图，看是不是四种姿态都有。 */
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
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":2,"damage":0,"fireRate":0,"cannon":0,"armor":4,"weapon":0,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

// 在方阵正前方摆一排僵尸，然后同一帧全部打死
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 28; i++) {
    w.enemies.spawn('walker', -7.5 + (i % 8) * 2.1, w.squad.z + 9 + Math.floor(i / 8) * 2.6);
  }
});
await page.waitForTimeout(120);
const killed = await page.evaluate(() => {
  const w = window.__game.world;
  const out = [];
  let n = 0;
  for (const e of w.enemies.list) {
    if (e.alive && e.kind === 'walker') { w.enemies.damage(e, 99999, out); n++; }
  }
  const counts = [0, 0, 0, 0];
  for (const e of w.enemies.list) {
    if (e.alive || e.dying <= 0) continue;
    const v = (e.phase * 0.6180339) % 1;
    counts[v < 0.25 ? 0 : v < 0.5 ? 1 : v < 0.75 ? 2 : 3]++;
  }
  return { n, counts };
});
console.log('放倒', killed.n, '四种死法分布', JSON.stringify(killed.counts));
await page.waitForTimeout(240);
await page.screenshot({ path: `${SHOTS}/death-variety.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
