/**
 * 开局就看得见的 Boss：从第一帧起截几张，确认它在远处、在走、而且越来越大。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
for (const lvl of [1, 5]) {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  page.on('pageerror', (e) => errs.push(`L${lvl} ` + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`L${lvl} ` + m.text().slice(0, 180)); });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
  await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(600);

  // 开局：Boss 应该已经在远处了
  const a = await page.evaluate(() => {
    const w = window.__game.world;
    w.enemies.list.length = 1; // 只留 Boss，别让尸潮挡镜头
    const b = w.boss.enemy;
    return { preview: w.boss.previewing, gap: +(b.z - w.squad.z).toFixed(0), bz: +b.z.toFixed(0), sz: +w.squad.z.toFixed(0), arena: +w.arenaZ.toFixed(0), drawn: window.__game.debug().drawn.boss };
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/loom-L${lvl}-start.png`, timeout: 120000 });
  console.log(`L${lvl} 开局 预览态=${a.preview} 距离=${a.gap}m bz=${a.bz} sz=${a.sz} arena=${a.arena} 画出来=${a.drawn}`);

  // 快进到 Boss 战跟前，看它涨到多大
  await page.evaluate(() => {
    const w = window.__game.world;
    w.squad.z = w.arenaZ - 70;
    w.squad.layout();
    w.enemies.list.length = 1;
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/loom-L${lvl}-near.png`, timeout: 120000 });
  const b = await page.evaluate(() => {
    const w = window.__game.world;
    return { preview: w.boss.previewing, gap: +(w.boss.enemy.z - w.squad.z).toFixed(0) };
  });
  console.log(`L${lvl} 逼近 预览态=${b.preview} 距离=${b.gap}m`);
  await page.close();
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
