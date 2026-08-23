import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

for (let i = 0; i < 400; i++) {
  await page.evaluate(() => window.__game.fastForward(0.4));
  const alive = await page.evaluate(() => window.__game.world?.midBoss?.enemy?.alive ?? false);
  if (alive) break;
}
const d = await page.evaluate(() => window.__game.debug());
console.log('debug', JSON.stringify(d));
const mb = await page.evaluate(() => {
  const m = window.__game.world?.midBoss;
  return m ? { alive: m.enemy?.alive, hp: m.enemy?.hp, scale: m.enemy?.scale, x: m.enemy?.x, z: m.enemy?.z } : null;
});
console.log('midboss', JSON.stringify(mb));

if (mb?.alive) {
  // inspect('enemy', ...) 抓的是 enemies.list 里第一个非脚本敌人——附近全是
  // walker 的话轮不到 midboss。验证脚本专用：把其它杂兵先筛掉，保证选中它。
  await page.evaluate(() => {
    const w = window.__game.world;
    w.enemies.list = w.enemies.list.filter((e) => e.kind === 'midboss' || e.scripted);
    window.__game.inspect('enemy', 6, 3, Math.PI + 0.1);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/midboss-wide.png`, timeout: 120000 });

  // 等它放一次技能，抓预警和命中各一张
  let sawTelegraph = false;
  for (let i = 0; i < 300; i++) {
    await page.evaluate(() => window.__game.fastForward(0.1));
    const tg = await page.evaluate(() => !!window.__game.world?.midBoss?.telegraph);
    if (tg && !sawTelegraph) {
      sawTelegraph = true;
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/midboss-telegraph.png`, timeout: 120000 });
    }
    if (sawTelegraph && !tg) break;
  }
}
console.log('ERRORS', errs);
await browser.close();
