/**
 * 三排玩法的实机核对：
 *  · 火线走廊画在地上，宽度和判定一致
 *  · 站在一排里只打得到这一排的怪，隔壁排一枪都吃不到
 *  · 墙只占一排，走别的排完全碰不到它
 *  · 大怪从一百五十米外就看得见
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":0,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","armor"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => document.querySelector('[data-level="3"]').click());
await page.waitForTimeout(700);

// 三排各放一堆怪，方阵站中间那一排
const setup = await page.evaluate(() => {
  const w = window.__game.world;
  w.squad.addSoldiers(160);
  w.squad.x = 0;
  w.squad.layout();
  w.enemies.clear();
  const mk = (lx, n, kind) => {
    for (let i = 0; i < n; i++) {
      const e = w.enemies.spawn(kind, lx + (Math.random() - 0.5) * 4, w.squad.z + 22 + Math.random() * 14);
      e.laneX = e.x;
      e.hp = e.maxHp = 4000;
    }
  };
  mk(-7.33, 40, 'walker');
  mk(0, 40, 'walker');
  mk(7.33, 40, 'walker');
  return { soldiers: w.squad.soldierCount };
});
await page.waitForTimeout(2200);
await page.screenshot({ path: `${SHOTS}/lane-fire.png`, timeout: 120000 });
const dmg = await page.evaluate(() => {
  const w = window.__game.world;
  const out = { left: 0, mid: 0, right: 0 };
  for (const e of w.enemies.list) {
    const l = e.x > 3.67 ? 'left' : e.x < -3.67 ? 'right' : 'mid';
    out[l] += e.maxHp - e.hp;
  }
  return out;
});
console.log('满编', setup.soldiers, '各排累计吃到的伤害', JSON.stringify(dmg));
console.log(dmg.mid > 0 && dmg.left === 0 && dmg.right === 0
  ? '✅ 只打得到自己那一排'
  : '⚠️ 火力溢出到了隔壁排');

// 远景：一百五十米外放三只泰坦，看能不能画出来
await page.evaluate(() => {
  const w = window.__game.world;
  w.enemies.clear();
  for (let i = 0; i < 3; i++) {
    const e = w.enemies.spawn('titan', -7.33 + i * 7.33, w.squad.z + 150);
    e.laneX = e.x;
  }
});
await page.waitForTimeout(700);
const drawn = await page.evaluate(() => window.__game.debug().drawn.titan);
await page.screenshot({ path: `${SHOTS}/lane-farview.png`, timeout: 120000 });
console.log('一百五十米外画出来的泰坦数:', drawn);

// 墙：走别的排碰不到
await page.evaluate(() => {
  const w = window.__game.world;
  w.enemies.clear();
  const b = w.blocks.find((x) => x.alive);
  if (b) { w.squad.z = b.z - 26; w.squad.layout(); }
});
await page.waitForTimeout(300);
const wall = await page.evaluate(() => {
  const w = window.__game.world;
  const b = w.blocks.find((x) => x.alive);
  return b ? { lane: b.lane, x0: +b.x0.toFixed(1), x1: +b.x1.toFixed(1), hp: b.hp } : null;
});
console.log('前方的墙', JSON.stringify(wall));
await page.evaluate(() => window.__game.fastForward(0));
await page.waitForTimeout(6500);
await page.screenshot({ path: `${SHOTS}/lane-wall.png`, timeout: 120000 });
const after = await page.evaluate(() => {
  const w = window.__game.world;
  const b = w.blocks.find((x) => x.z > w.squad.z - 40);
  return b ? {
    hp: Math.round(b.hp), alive: b.alive, dz: +(b.z - w.squad.z).toFixed(1),
    active: w.activeBlock ? w.activeBlock.id === b.id : false,
    squadLane: w.squad.x > 3.67 ? 'left' : w.squad.x < -3.67 ? 'right' : 'mid',
  } : null;
});
console.log('六秒后', JSON.stringify(after));
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
