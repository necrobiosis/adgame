/**
 * 商店 + 主菜单的出征装备位核对。
 * 买满之后仍然只能带 N 个上场——这一层必须在界面上一眼看得见，
 * 否则玩家根本不知道自己漏了什么。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":4,"slots":1,"heavyGuns":3,"horde":4,"scavenger":3,"strikeSpec":3,"vanguard":3},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
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
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1300);

await page.screenshot({ path: `${SHOTS}/menu-loadout.png`, timeout: 120000 });
const strip = await page.$$eval('.loadout-strip .chip', (ns) => ns.map((n) => n.textContent.trim()));
console.log('菜单装备条:', JSON.stringify(strip));

await page.click('[data-shop]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/shop-top.png`, timeout: 120000 });
const bar = await page.$eval('.slots-bar .note', (n) => n.textContent.trim());
console.log('商店装备位:', bar);

// 卸下一个再装另一个，确认按钮真的联动
const before = await page.$$eval('.equip.on', (ns) => ns.length);
await page.click('[data-equip="cannon"]');
await page.waitForTimeout(200);
const mid = await page.$$eval('.equip.on', (ns) => ns.length);
await page.click('[data-equip="heavyGuns"]');
await page.waitForTimeout(200);
const after = await page.$$eval('.equip.on', (ns) => ns.length);
const equipped = await page.evaluate(() => JSON.parse(localStorage.getItem('adgame.save.v1')).loadout);
console.log(`装备数 ${before} → 卸下 ${mid} → 换装 ${after}；存档 = ${JSON.stringify(equipped)}`);

// 滚到底截一张专精模块
await page.evaluate(() => { document.querySelector('.items').scrollIntoView(false); window.scrollTo(0, 99999); const s = document.querySelector('.screen'); if (s) s.scrollTop = s.scrollHeight; });
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/shop-specialists.png`, timeout: 120000 });
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
