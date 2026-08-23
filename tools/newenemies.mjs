/**
 * 三种新怪的实机核对：直接刷到方阵前面，截图看造型，
 * 并确认吐酸/起跳/重甲减伤在真实战斗里都跑得通。
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
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":4,"fireRate":4,"cannon":3,"armor":6,"weapon":2,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="2"]').click());
await page.waitForTimeout(600);

// 直接在方阵前方刷一批新怪
const spawned = await page.evaluate(() => {
  const w = window.__game.world;
  const z = w.squad.z;
  for (let i = 0; i < 6; i++) w.enemies.spawn('spitter', -6 + i * 2.4, z + 26);
  for (let i = 0; i < 6; i++) w.enemies.spawn('leaper', -5 + i * 2.0, z + 14);
  for (let i = 0; i < 6; i++) w.enemies.spawn('armored', -6 + i * 2.4, z + 20);
  return w.enemies.list.filter((e) => ['spitter', 'leaper', 'armored'].includes(e.kind)).length;
});
console.log('spawned', spawned);

// 实时跑几秒，观察行为
let sawFire = false, sawJump = false, sawAir = false, sawLand = false;
for (let i = 0; i < 26; i++) {
  await page.waitForTimeout(260);
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    const list = w.enemies.list.filter((e) => e.alive);
    const sp = list.filter((e) => e.kind === 'spitter');
    const lp = list.filter((e) => e.kind === 'leaper');
    const ar = list.filter((e) => e.kind === 'armored');
    return {
      spitters: sp.length,
      spitInFlight: sp.filter((e) => (e.spitT ?? 0) > 0).length,
      spitStandoff: sp.length ? Math.round(Math.min(...sp.map((e) => e.z - w.squad.z))) : -1,
      leapers: lp.length,
      airborne: lp.filter((e) => (e.airY ?? 0) > 0.1).length,
      maxAir: lp.length ? +Math.max(...lp.map((e) => e.airY ?? 0)).toFixed(1) : 0,
      behindFront: lp.filter((e) => e.z < w.squad.z).length,
      armored: ar.length,
      armoredHpFrac: ar.length ? +(ar.reduce((s, e) => s + e.hp / e.maxHp, 0) / ar.length).toFixed(2) : -1,
      drawn: window.__game.view.instanceCounts(),
    };
  });
  if (st.spitInFlight > 0) sawFire = true;
  if (st.airborne > 0) { sawAir = true; }
  if (st.behindFront > 0) sawLand = true;
  if (i === 6) await page.screenshot({ path: `${SHOTS}/new-enemies.png`, timeout: 120000 });
  if (i % 6 === 0) console.log(`t${i}`, JSON.stringify(st));
}
console.log({ sawFire, sawAir, sawLand });
await page.screenshot({ path: `${SHOTS}/new-enemies-late.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 6) : '[]');
await browser.close();
