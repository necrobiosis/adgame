import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const save = JSON.stringify({ version: 1, gold: 99999, unlockedLevel: 5, upgrades: { squad: 8, damage: 8, fireRate: 8, cannon: 4, armor: 8, weapon: 0 }, bestTime: {}, muted: true });
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(500);

// upgrades.weapon 上限只到 3（轻机枪），5 级等离子枪只能靠关内拾取——
// 直接改模拟层字段来强制切等级，纯粹是渲染层验证用，不代表真实数值路径
for (const tier of [0, 2, 5]) {
  await page.evaluate((t) => { window.__game.world.squad.weaponLevel = t; }, tier);
  await page.evaluate(() => window.__game.fastForward(0.4));
  const actualTier = await page.evaluate(() => window.__game.world?.squad?.weaponLevel);
  await page.evaluate(() => window.__game.inspect('squad', 1.0, 0.35, 0.25));
  await page.waitForTimeout(500);
  console.log('tier', tier, 'actual', actualTier);
  await page.screenshot({ path: `${SHOTS}/weapon-tier${tier}.png`, timeout: 120000 });
}
console.log('ERRORS', errs);
await browser.close();
