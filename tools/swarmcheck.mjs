/**
 * 新怪的实机核对：幼体（贴地涌来的小东西）和自爆尸（走到跟前炸一片），
 * 外加尸群的四套体型是不是真的混在一起了。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
await page.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1300);
await page.evaluate(() => document.querySelector('[data-level="3"]').click());
await page.waitForTimeout(700);

await page.evaluate(() => {
  const w = window.__game.world;
  w.squad.addSoldiers(200);
  w.squad.layout();
  for (let i = 0; i < 140; i++) {
    w.enemies.spawn('swarmling', (Math.random() - 0.5) * 18, w.squad.z + 14 + Math.random() * 26);
  }
  for (let i = 0; i < 40; i++) {
    w.enemies.spawn('walker', (Math.random() - 0.5) * 18, w.squad.z + 16 + Math.random() * 24);
  }
});
await page.waitForTimeout(1600);
await page.screenshot({ path: `${SHOTS}/swarmlings.png`, timeout: 120000 });
const counts = await page.evaluate(() => window.__game.debug().batches ?? window.__game.debug());
console.log('批次:', JSON.stringify(counts).slice(0, 400));

// 自爆尸：直接摆到脸上，看爆炸特效
await page.evaluate(() => {
  const w = window.__game.world;
  for (let i = 0; i < 8; i++) w.enemies.spawn('bomber', (i - 4) * 2.2, w.squad.z + 5);
});
await page.waitForTimeout(900);
await page.screenshot({ path: `${SHOTS}/bombers.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
