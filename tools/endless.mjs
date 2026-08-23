/** 无尽模式：菜单入口能进、跑得起来、HUD 报的是距离而不是百分比。 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 250)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":10,"damage":8,"fireRate":6,"cannon":4,"armor":8,"weapon":2},"bestTime":{},"muted":true}'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
const hasBtn = await page.evaluate(() => !!document.querySelector('[data-endless]'));
console.log('菜单有无尽入口:', hasBtn);
await page.screenshot({ path: `${SHOTS}/endless-menu.png`, timeout: 120000 });
await page.evaluate(() => document.querySelector('[data-endless]').click());
await page.waitForTimeout(700);
const s0 = await page.evaluate(() => ({
  level: window.__game.world?.level.name,
  endless: window.__game.world?.level.endless,
  progress: +(window.__game.world?.progress ?? -1).toFixed(2),
  pct: document.querySelector('.lpct')?.textContent,
  z: Math.round(window.__game.world?.squad.z ?? -1),
}));
console.log('开局', JSON.stringify(s0));
await page.evaluate(() => window.__game.fastForward(40));
await page.waitForTimeout(600);
const s1 = await page.evaluate(() => ({
  z: Math.round(window.__game.world.squad.z),
  pct: document.querySelector('.lpct')?.textContent,
  hpScale: +window.__game.world.enemies.hpScale.toFixed(1),
  dmgScale: +window.__game.world.enemies.damageScale.toFixed(1),
  enemies: window.__game.world.enemies.aliveCount,
  phase: window.__game.world.phase,
}));
console.log('跑了40秒', JSON.stringify(s1));
await page.screenshot({ path: `${SHOTS}/endless-run.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
