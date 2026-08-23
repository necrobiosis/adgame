/**
 * 标价车道核对：
 *  - 钱够 → 扣钱 + 吃到增益
 *  - 钱不够 → 照常过去但拿不到增益，且不会扣成负数
 * 顺便截一张新铭牌（增益 / 标价 / 前方怪物构成）。
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
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":5,"fireRate":5,"cannon":3,"armor":6,"weapon":1},"bestTime":{},"muted":true}'));
await page.evaluate(() => localStorage.setItem('adgame.quality', 'medium'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 找出第一关里标价的那条车道
const run = async (label, startGold) => {
  await page.evaluate(() => { if (window.__game.world) window.__game.debugMenu(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-level="1"]').click());
  await page.waitForTimeout(400);
  return page.evaluate((gold) => {
    const w = window.__game.world;
    w.gold = gold;
    const priced = w.gates
      .map((g, i) => ({ i, g, side: (g.left.gate.cost ?? 0) > 0 ? 'left' : (g.right.gate.cost ?? 0) > 0 ? 'right' : null }))
      .find((e) => e.side);
    if (!priced) return { err: '第一关没有标价车道' };
    const lane = priced.g[priced.side];
    const cost = lane.gate.cost;
    const before = { gold: w.gold, weapon: w.squad.weaponLevel, cannons: w.squad.cannonCount };
    // 一路把方阵开到标价的那一侧
    const dt = 1 / 60;
    let t = 0, text = null;
    while (w.phase === 'running' && t < 60 && !priced.g.taken) {
      w.steer = priced.side === 'left' ? 1 : -1;
      // 穷的那一趟要一直摁住钱包，否则一路上打怪赚的钱足够把门费付掉，
      // 就测不到"买不起"这条分支了
      if (gold < cost) w.gold = gold;
      w.step(dt);
      for (const e of w.drainEvents()) if (e.type === 'gate') text = e.text;
      t += dt;
    }
    return {
      cost, chosen: priced.g.chosen, text,
      before, after: { gold: w.gold, weapon: w.squad.weaponLevel, cannons: w.squad.cannonCount },
    };
  }, startGold);
};

console.log('钱够  ', JSON.stringify(await run('rich', 5000)));
console.log('钱不够', JSON.stringify(await run('poor', 5)));

// 截一张新铭牌
await page.evaluate(() => { if (window.__game.world) window.__game.debugMenu(); });
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('[data-level="3"]').click());
await page.waitForTimeout(400);
await page.evaluate(() => {
  const w = window.__game.world;
  const g = w.gates.find((x) => (x.left.gate.cost ?? 0) > 0 || (x.right.gate.cost ?? 0) > 0) ?? w.gates[0];
  w.squad.z = g.z - 34;
  w.gold = 800;
});
await page.evaluate(() => window.__game.fastForward(0.1));
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/gate-plate.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
