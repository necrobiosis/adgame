import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 400)); });
await page.goto('file:///home/user/adgame/dist-singlefile/index.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const hasMenu = await page.evaluate(() => !!document.querySelector('[data-level="1"]'));
console.log('hasMenu', hasMenu);
if (hasMenu) {
  await page.evaluate(() => document.querySelector('[data-level="1"]').click());
  await page.waitForTimeout(2500);
  const hasCanvas = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  console.log('canvas', JSON.stringify(hasCanvas));
  await page.screenshot({ path: '/tmp/claude-0/-home-user-adgame/f912ca40-192b-564b-bb57-4c60b49759e5/scratchpad/shots/singlefile-check.png' });
}
console.log('ERRORS', JSON.stringify(errs));
await browser.close();
