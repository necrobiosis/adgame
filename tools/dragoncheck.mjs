import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(3000);
const pos = await page.evaluate(() => {
  const d = window.__game.view.dragon;
  return d ? { x: d.group.position.x, y: d.group.position.y, z: d.group.position.z, visible: d.group.visible } : null;
});
console.log('dragon', JSON.stringify(pos));
await browser.close();
