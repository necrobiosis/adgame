/**
 * 曳光弹八档外观的核对：同一个机位把武器逐级切一遍，
 * 确认"升级看得见"——粗细、长度、亮度、地上那条火线的长度都在变。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":10,"damage":6,"fireRate":6,"cannon":0,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","armor"],"bestTime":{},"muted":true}';
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

for (const tier of [0, 1, 2, 3, 4, 5, 6, 7]) {
  const info = await page.evaluate((t) => {
    const w = window.__game.world;
    while (w.squad.soldierCount < 200) w.squad.addSoldiers(60);
    w.squad.weaponLevel = t;
    w.squad.x = 0;
    w.squad.layout();
    w.enemies.clear();
    // 正前方摆一条长纵队，看穿透能串多少
    for (let i = 0; i < 26; i++) {
      const e = w.enemies.spawn('walker', (Math.random() - 0.5) * 5, w.squad.z + 16 + i * 4);
      e.laneX = e.x;
      e.hp = e.maxHp = 90000;
    }
    const wt = window.__game.balance.WEAPON_TIERS[t];
    return { name: wt.name, pierce: wt.pierce, beam: wt.beam, eff: wt.falloffStart };
  }, tier);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/beam-${tier}.png`, timeout: 120000 });
  const live = await page.evaluate(() => window.__game.debug().tracers ?? -1);
  const spread = await page.evaluate(() => {
    const w = window.__game.world;
    let hit = 0, far = 0;
    for (const e of w.enemies.list) {
      if (e.maxHp - e.hp > 0) { hit++; far = Math.max(far, Math.round(e.z - w.squad.z)); }
    }
    return { hit, far };
  });
  console.log(`${tier} ${info.name.padEnd(5)} 穿透${info.pierce} 光柱${info.beam} 有效${info.eff}m → 命中${spread.hit}只 最远${spread.far}m 曳光弹在飞=${live}`);
}
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
