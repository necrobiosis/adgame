import { chromium } from 'playwright';

const SHOTS = process.env.SHOTS_DIR ?? './shots';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${SHOTS}/01-menu.png` });

// 进第一关
await page.click('[data-level="1"]');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${SHOTS}/02-start.png` });

const steps = Number(process.argv[2] ?? 6);
for (let i = 0; i < steps; i++) {
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${SHOTS}/03-run-${String(i).padStart(2, '0')}.png` });
}

const fps = await page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res((n / (performance.now() - t0)) * 1000); };
  requestAnimationFrame(tick);
}));
console.log('FPS(swiftshader) ~', fps.toFixed(1));
console.log('ERRORS:', errors.length ? errors.slice(0, 12) : 'none');
await browser.close();
