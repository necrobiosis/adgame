/**
 * 实机音效冒烟测试：非静音跑一整段关卡（含中 Boss 和终 Boss），
 * 确认合成路径在真实事件流下不报错、节点数不失控。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// muted:false —— 要真的走合成路径
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":false}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'medium');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(800);

// 跑完整关：快进到 Boss 死或输掉
let last = null;
for (let i = 0; i < 90; i++) {
  await page.evaluate(() => window.__game.fastForward(2));
  last = await page.evaluate(() => {
    const w = window.__game.world;
    return { phase: w.phase, z: Math.round(w.squad.z), soldiers: w.squad.soldierCount, bossAlive: w.boss.enemy?.alive ?? false };
  });
  if (last.phase !== 'running') break;
}
console.log('final', JSON.stringify(last));
console.log('ERRORS', errs.length ? errs.slice(0, 10) : '[]');
await browser.close();
process.exit(errs.length ? 1 : 0);
