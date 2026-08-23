import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

// 快进到有一波尸潮在场上，方便近距离看僵尸脸
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.__game.fastForward(0.4));
  const d = await page.evaluate(() => window.__game.debug());
  if (d.drawn.walker > 3) break;
}

const shots = [
  // 士兵渲染时 rotY=0（局部 +z 就是世界 +z），yaw≈0 的镜头正对着脸。
  ['squad', 1.3, 0.55, 0.2, 'face-soldier-close'],
  // 僵尸/精英/Boss 渲染时都被转了 180°（局部 +z → 世界 -z，配合它们朝 -z
  // 走的方向），镜头要站到 yaw≈π 才能看到脸，不然拍到的是后脑勺。
  ['enemy', 1.1, 0.45, Math.PI + 0.15, 'face-walker-close'],
];
for (const [target, dist, height, yaw, name] of shots) {
  await page.evaluate(([t, d, h, y]) => window.__game.inspect(t, d, h, y), [target, dist, height, yaw]);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 120000 });
}

// 快进到 Boss 出现，近距离看发光眼+獠牙
for (let i = 0; i < 400; i++) {
  await page.evaluate(() => window.__game.fastForward(0.4));
  const alive = await page.evaluate(() => window.__game.world?.boss?.enemy?.alive ?? false);
  if (alive) break;
}
// Boss 真实站高逼近 12 米，dist/height 都要按这个量级给，不然离得太近
// 只看到膝盖，或者像之前一样飘在半空看天
await page.evaluate(() => window.__game.inspect('boss', 9, 1.5, Math.PI + 0.1));
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/face-boss.png`, timeout: 120000 });

console.log('debug', JSON.stringify(await page.evaluate(() => window.__game.debug())));
console.log('ERRORS', errs);
await browser.close();
