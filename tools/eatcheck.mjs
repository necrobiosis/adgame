/**
 * 啃食 + 喷血 + 士兵辨识度的核对。
 * 每一关都把僵尸压到方阵脸上，截一张：既看啃食姿态和血，也看士兵在这一关
 * 的背景里跳不跳得出来。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":2,"fireRate":2,"cannon":0,"armor":10,"weapon":4,"slots":1},"loadout":["squad","armor","weapon","damage","fireRate"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
for (const lvl of [1, 3, 5]) {
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
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const w = window.__game.world;
    w.squad.addSoldiers(60);
    w.squad.x = 0;
    w.squad.layout();
    w.enemies.clear();
    // 直接把一群僵尸摆到方阵脸上，血拉厚让它们站得住、能一直啃
    for (let i = 0; i < 30; i++) {
      const e = w.enemies.spawn(i % 5 === 0 ? 'brute' : 'walker',
        (Math.random() - 0.5) * 7, w.squad.z + 1.6 + Math.random() * 3);
      e.laneX = e.x;
      e.hp = e.maxHp = 5e6;
    }
  });
  // 方阵每秒推进 9.5 米，比僵尸走得快——不按住就直接把它们甩在身后了。
  // 这里每 120 毫秒把僵尸重新贴回方阵跟前，模拟"被尸潮死死咬住"的状态。
  for (let k = 0; k < 24; k++) {
    await page.evaluate(() => {
      const w = window.__game.world;
      for (const e of w.enemies.list) {
        if (!e.alive) continue;
        e.z = w.squad.z + 1.4 + Math.random() * 1.8;
        e.hp = e.maxHp;
      }
    });
    await page.waitForTimeout(120);
  }
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    const eating = w.enemies.list.filter((e) => e.alive && e.eating > 0).length;
    return { eating, soldiers: w.squad.soldierCount };
  });
  await page.screenshot({ path: `${SHOTS}/eat-L${lvl}.png`, timeout: 120000 });
  // 再来一张贴脸的：看得清啃食姿态和血
  await page.evaluate(() => window.__game.inspect('squad', 7, 1.4, 3.0));
  for (let k = 0; k < 8; k++) {
    await page.evaluate(() => {
      const w = window.__game.world;
      for (const e of w.enemies.list) {
        if (!e.alive) continue;
        e.z = w.squad.z + 1.4 + Math.random() * 1.6;
        e.hp = e.maxHp;
      }
    });
    await page.waitForTimeout(120);
  }
  await page.screenshot({ path: `${SHOTS}/eat-close-L${lvl}.png`, timeout: 120000 });
  await page.evaluate(() => window.__game.inspect(null));
  console.log(`L${lvl} 正在啃食的僵尸=${st.eating} 剩余士兵=${st.soldiers}`);
  await page.close();
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
