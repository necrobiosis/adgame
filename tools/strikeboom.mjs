/**
 * 空袭重做的核对：一局几发、冷却、地面预警、以及落地那一下够不够炸。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const mk = (spec) => `{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":0,"armor":10,"weapon":4,"slots":1,"strikeSpec":${spec}},"loadout":["squad","damage","weapon","armor","strikeSpec"],"bestTime":{},"muted":true}`;
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
for (const spec of [0, 3]) {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  page.on('pageerror', (e) => errs.push(`spec${spec} ` + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`spec${spec} ` + m.text().slice(0, 180)); });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), mk(spec));
  await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => document.querySelector('[data-level="3"]').click());
  await page.waitForTimeout(700);

  await page.evaluate(() => {
    const g = window.__game;
    window.__impacts = 0;
    window.__killed = 0;
    const orig = g.world.drainEvents.bind(g.world);
    g.world.drainEvents = () => {
      const evs = orig();
      for (const e of evs) {
        if (e.type === 'strikeImpact') window.__impacts++;
        if (e.type === 'kill') window.__killed++;
      }
      return evs;
    };
  });
  const start = await page.evaluate(() => {
    const w = window.__game.world;
    w.enemies.clear();
    for (let i = 0; i < 160; i++) {
      const e = w.enemies.spawn(i % 12 === 0 ? 'brute' : 'walker',
        (Math.random() - 0.5) * 20, w.squad.z + 24 + Math.random() * 46);
      e.laneX = e.x;
    }
    return { left: w.strikeLeft, badge: document.querySelector('.strike .count')?.textContent };
  });
  console.log(`空袭引导 Lv.${spec} → 开局 ${start.left} 发，按钮显示 "${start.badge}"`);

  // 按下去
  await page.click('.strike', { force: true });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/strike-warn-${spec}.png`, timeout: 120000 });
  const warn = await page.evaluate(() => {
    const w = window.__game.world;
    return { zone: w.strikeZone ? { halfW: +w.strikeZone.halfW.toFixed(1), halfZ: +w.strikeZone.halfZ.toFixed(1) } : null, left: w.strikeLeft, cd: +w.strikeCd.toFixed(0) };
  });
  console.log(`  呼叫后：剩 ${warn.left} 发，冷却 ${warn.cd}s，预警区 ${JSON.stringify(warn.zone)}`);

  // 落地：连拍几帧，挑爆得最凶的那一张
  for (let k = 0; k < 6; k++) {
    await page.waitForTimeout(180);
    await page.screenshot({ path: `${SHOTS}/strike-boom-${spec}-${k}.png`, timeout: 120000 });
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/strike-after-${spec}.png`, timeout: 120000 });
  const after = await page.evaluate(() => {
    const w = window.__game.world;
    return {
      alive: w.enemies.list.filter((e) => e.alive).length,
      impacts: window.__impacts, killed: window.__killed,
      hp: Math.round(w.enemies.list.find((e) => e.alive)?.maxHp ?? -1),
      ready: !document.querySelector('.strike').disabled,
    };
  });
  console.log(`  炸完：还剩 ${after.alive} 只（原本 160），落弹 ${after.impacts} 发，累计击杀 ${after.killed}，杂兵血量 ${after.hp}`);
  await page.close();
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
