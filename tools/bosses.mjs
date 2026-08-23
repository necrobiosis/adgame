/**
 * 五个 Boss 的实机核对：外形各不相同，招式也各不相同。
 * 每关开一个干净的页面，跳到 Boss 战实时跑一段，记录它到底放了哪些招并截图。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":3},"bestTime":{},"muted":true}';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];

for (const lvl of [1, 2, 3, 4, 5]) {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  page.on('pageerror', (e) => errs.push(`L${lvl} PAGEERROR: ` + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(`L${lvl} ` + m.text().slice(0, 200)); });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);
  await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
  await page.evaluate(() => localStorage.setItem('adgame.quality', 'medium'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);
  await page.evaluate((l) => document.querySelector(`[data-level="${l}"]`).click(), lvl);
  await page.waitForTimeout(700);

  // 送到 Boss 触发线前，并补足兵力
  await page.evaluate(() => {
    const w = window.__game.world;
    if (!w) return;
    w.squad.addSoldiers(300);
    w.squad.z = w.arenaZ - 50;
    w.squad.layout();
  });

  const seen = new Set();
  let shot = false;
  let name = '?';
  for (let i = 0; i < 70; i++) {
    await page.waitForTimeout(170);
    const st = await page.evaluate(() => {
      const w = window.__game.world;
      if (!w) return null;
      const b = w.boss;
      return { alive: b.enemy?.alive ?? false, tg: b.telegraph?.kind ?? null, inv: !!b.invulnerable, name: b.name };
    }).catch(() => null);
    if (!st) continue;
    if (st.name) name = st.name;
    if (st.tg) seen.add(st.tg);
    if (st.inv) seen.add('submerge');
    if (st.alive && st.tg && !shot) {
      shot = true;
      await page.screenshot({ path: `${SHOTS}/boss-L${lvl}.png`, timeout: 120000 }).catch(() => {});
    }
  }
  console.log(`L${lvl} ${name.padEnd(6)} 招式: ${[...seen].join(', ') || '(未抓到)'}`);
  await page.close();
}
console.log('ERRORS', errs.length ? errs.slice(0, 6) : '[]');
await browser.close();
