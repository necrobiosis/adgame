/** 士兵射击姿势 + 掉人暗角 + 残肢碎块的核对。 */
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
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":3,"damage":2,"fireRate":2,"cannon":0,"armor":6,"weapon":2,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(500);

// 在正前方摆一排怪，逼士兵进入交火姿势，然后从正面近距离看
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 12; i++) w.enemies.spawn('walker', -6 + i * 1.1, w.squad.z + 20);
});
await page.evaluate(() => window.__game.inspect('squad', 7, 1.5, 0));
await page.waitForTimeout(500);
// 补一批，保证按快门那一刻士兵确实在交火（aState=1）
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 16; i++) w.enemies.spawn('walker', -6 + i * 0.9, w.squad.z + 18);
});
await page.waitForTimeout(140);
const st = await page.evaluate(() => ({
  soldierState: window.__game.view.instanceCounts().soldiers,
  enemies: window.__game.world.enemies.list.filter((e) => e.alive).length,
}));
console.log('交火中', JSON.stringify(st));
await page.screenshot({ path: `${SHOTS}/pose-firing.png`, timeout: 120000 });

// 碎块 + 暗角：放一群大怪然后一次性打死
await page.evaluate(() => window.__game.inspect(null));
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 8; i++) w.enemies.spawn('brute', -6 + i * 1.7, w.squad.z + 16);
});
// 直接调 damage() 的话 kill 事件进了局部数组、渲染层根本看不到，
// 所以把血压到 1 让方阵自己补最后一枪，事件才会正常流出去
await page.evaluate(() => {
  for (const e of window.__game.world.enemies.list) if (e.alive && e.kind === 'brute') e.hp = 1;
});
let gibPeak = 0;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(140);
  const c = await page.evaluate(() => window.__game.view.gibs?.mesh.count ?? -1);
  if (c > gibPeak) gibPeak = c;
}
console.log('碎块峰值', gibPeak);
const gib = await page.evaluate(() => {
  const el = document.querySelector('.damage-vignette');
  return {
    gibs: window.__game.view.gibs?.mesh.count ?? -1,
    vignetteEl: !!el,
    vignetteFired: el ? el.classList.contains('go') : false,
  };
});
console.log('碎块/暗角', JSON.stringify(gib));
await page.screenshot({ path: `${SHOTS}/pose-gibs.png`, timeout: 120000 });

// 让一群大怪贴脸打，确认掉人时暗角真的会亮
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 14; i++) w.enemies.spawn('brute', -7 + i * 1.1, w.squad.z + 3.5);
});
let fired = false, shot = false;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(150);
  const r = await page.evaluate(() => {
    const el = document.querySelector('.damage-vignette');
    return { on: el ? el.classList.contains('go') : false, soldiers: window.__game.world.squad.soldierCount };
  });
  if (r.on && !shot) {
    shot = true;
    await page.screenshot({ path: `${SHOTS}/pose-vignette.png`, timeout: 120000 });
  }
  if (r.on) fired = true;
  if (r.soldiers <= 1) break;
}
console.log('掉人暗角触发:', fired);
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
