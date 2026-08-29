/**
 * 闪避可行性：方阵能不能真的走出 Boss 的 AoE 圈。
 * 量三件事——方阵实际宽度、可横移范围、以及"预警亮起后全力横移能不能全身而退"。
 */
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
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(500);

// 先把人堆满，量满编方阵的尺寸和可移动范围
const geo = await page.evaluate(() => {
  const w = window.__game.world;
  w.squad.addSoldiers(400);
  w.squad.layout();
  const dt = 1 / 60;
  // 全力往一边推，看能到多远
  for (let i = 0; i < 240; i++) { w.steer = 1; w.step(dt); w.drainEvents(); }
  const maxLeft = w.squad.x;
  for (let i = 0; i < 480; i++) { w.steer = -1; w.step(dt); w.drainEvents(); }
  const maxRight = w.squad.x;
  return {
    soldiers: w.squad.soldierCount,
    cols: w.squad.cols,
    rows: w.squad.rows,
    formationWidth: +(w.squad.halfWidth * 2).toFixed(2),
    travel: +(maxLeft - maxRight).toFixed(2),
    maxLeft: +maxLeft.toFixed(2), maxRight: +maxRight.toFixed(2),
  };
});
console.log('满编方阵', JSON.stringify(geo));

/**
 * 实测闪避：同一发 slam，一次站着不动、一次全力横移，比伤亡人数。
 * 直接照搬 Boss.applyAoe 的判定（圆心在预警亮起那一刻锁定）。
 */
const trial = async (dodge) => page.evaluate((doDodge) => {
  const w = window.__game.world;
  // 重置一支满编队伍
  while (w.squad.soldierCount < 380) w.squad.addSoldiers(50);
  w.squad.x = 0;
  w.squad.layout();
  const R = window.__game.balance.BOSS.slam.radius;
  const TELEGRAPH = window.__game.balance.BOSS.slam.telegraph;
  const cx = w.squad.x;          // 预警锁定的圆心
  const cz = w.squad.z + 2;
  const before = w.squad.soldierCount;
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(TELEGRAPH / dt); i++) {
    w.steer = doDodge ? 1 : 0;
    w.step(dt);
    w.drainEvents();
  }
  // 落点判定
  let hit = 0;
  for (const u of w.squad.units) {
    if (!u.alive) continue;
    const dx = u.x - cx, dz = u.z - cz;
    if (dx * dx + dz * dz <= R * R) hit++;
  }
  return { before, moved: +(w.squad.x - cx).toFixed(2), inCircle: hit };
}, dodge);

const stand = await trial(false);
const dodged = await trial(true);
console.log('站着不动', JSON.stringify(stand));
console.log('全力横移', JSON.stringify(dodged));
console.log(dodged.inCircle === 0
  ? `✅ 可以完全躲开（横移 ${dodged.moved}m，圈内 0 人）`
  : `⚠️ 仍有 ${dodged.inCircle} 人在圈内（站着不动是 ${stand.inCircle} 人）`);

// 截一张满编方阵的图看观感
await page.evaluate(() => window.__game.fastForward(4));
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/wide-squad.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
