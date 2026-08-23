/**
 * 触摸/鼠标拖拽能不能真的操控方阵。
 * 直接在画布上模拟一次横向拖拽，看 input.targetX 有没有动。
 */
import { chromium, devices } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const ctx = await browser.newContext({ ...devices['Pixel 7'], hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":4,"damage":3,"fireRate":3,"cannon":1,"armor":5,"weapon":2},"bestTime":{},"muted":true}'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(700);

// 画布正中间是什么元素在最上层？
const hit = await page.evaluate(() => {
  const c = document.getElementById('game');
  const r = c.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const el = document.elementFromPoint(cx, cy);
  const hud = document.querySelector('.hud');
  return {
    topElement: el ? `${el.tagName}.${el.className || '(no class)'}` : null,
    hudPointerEvents: hud ? getComputedStyle(hud).pointerEvents : null,
    canvasRect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
  };
});
console.log('画布中心的最上层元素:', JSON.stringify(hit));

const before = await page.evaluate(() => ({ targetX: window.__game.input.targetX, x: window.__game.world.squad.x }));

// 触摸拖拽：从中间往右划
const r = hit.canvasRect;
const cy = r.y + r.h * 0.6;
await page.touchscreen.tap(r.x + r.w / 2, cy);
await page.waitForTimeout(120);
// Playwright 的 touchscreen 只有 tap，用 CDP 手动派发一串 touch 事件
const client = await page.context().newCDPSession(page);
const sx = r.x + r.w * 0.3;
await client.send('Input.dispatchTouchEvent', {
  type: 'touchStart', touchPoints: [{ x: sx, y: cy, id: 1 }],
});
for (let i = 1; i <= 10; i++) {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ x: sx + i * (r.w * 0.045), y: cy, id: 1 }],
  });
  await page.waitForTimeout(24);
}
await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(260);

const after = await page.evaluate(() => ({ targetX: window.__game.input.targetX, x: window.__game.world.squad.x }));
console.log('拖拽前', JSON.stringify(before), '→ 拖拽后', JSON.stringify(after));
console.log(Math.abs(after.targetX - before.targetX) > 0.5 ? '✅ 触摸可操作' : '❌ 触摸无效');
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
