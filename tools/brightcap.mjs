import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);
await page.evaluate(() => window.__game.fastForward(0.5));
console.log('bright-debug', JSON.stringify(await page.evaluate(() => window.__game.debug())));
await page.screenshot({ path: `${SHOTS}/bright-l1.png`, timeout: 120000 });

// 加满人再看方阵是不是只画 10 个
await page.evaluate(() => window.__game.world.squad.addSoldiers(200));
await page.waitForTimeout(200);
const d = await page.evaluate(() => window.__game.debug());
console.log('squad-cap-debug', JSON.stringify(d));
const badge = await page.evaluate(() => {
  const el = document.querySelector('.squad-badge');
  return el ? { on: el.classList.contains('on'), text: el.textContent } : null;
});
console.log('badge', JSON.stringify(badge));
await page.waitForTimeout(300);
await page.screenshot({ path: `${SHOTS}/squad-cap10.png`, timeout: 120000 });

console.log('ERRORS', errs);
await browser.close();
