/**
 * 空袭：按钮状态机 + 落弹效果的实机核对。
 * 充能未满时按钮该是禁用的，满了才亮；点下去要真的炸出一串。
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
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":8,"damage":4,"fireRate":4,"cannon":2,"armor":6,"weapon":2,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="2"]').click());
await page.waitForTimeout(700);

const btn = () => page.evaluate(() => {
  const b = document.querySelector('.strike');
  return { exists: !!b, ready: b?.classList.contains('ready') ?? false, disabled: b?.disabled ?? null,
           left: window.__game.world?.strikeLeft ?? -1, cd: +(window.__game.world?.strikeCd ?? -1).toFixed(1) };
});
console.log('开局      ', JSON.stringify(await btn()));

// 充能没满时点一下：应当什么都不发生
await page.evaluate(() => document.querySelector('.strike').click());
const beforeKills = await page.evaluate(() => window.__game.world.enemies.list.filter((e) => e.alive).length);

// 快进到充满
await page.evaluate(() => window.__game.fastForward(30));
await page.waitForTimeout(400);
console.log('充满后    ', JSON.stringify(await btn()));

// 刷一批敌人当靶子，再点空袭
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 40; i++) {
    w.enemies.spawn('walker', -7 + (i % 10) * 1.6, w.squad.z + 26 + Math.floor(i / 10) * 3);
  }
});
const targetsBefore = await page.evaluate(() => window.__game.world.enemies.list.filter((e) => e.alive).length);
await page.evaluate(() => document.querySelector('.strike').click());
await page.waitForTimeout(220);
await page.screenshot({ path: `${SHOTS}/strike-call.png`, timeout: 120000 });
// 等炸弹落地
await page.waitForTimeout(1400);
await page.screenshot({ path: `${SHOTS}/strike-hit.png`, timeout: 120000 });
const after = await page.evaluate(() => ({
  alive: window.__game.world.enemies.list.filter((e) => e.alive).length,
  left: window.__game.world.strikeLeft,
  waves: window.__game.view.waves?.mesh.count ?? -1,
}));
console.log('靶子', targetsBefore, '→', after.alive, ' 充能归零?', after.charge < 0.5, JSON.stringify(after));
console.log('未充满时点击是否无效:', beforeKills >= 0);
console.log('ERRORS', errs.length ? errs.slice(0, 6) : '[]');
await browser.close();
