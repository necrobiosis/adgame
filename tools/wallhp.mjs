/** 墙上的血量数字为什么不显示：探一下 label 和铭牌凹槽的实际位置。 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.evaluate(() => localStorage.setItem('adgame.save.v1',
  '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":6,"damage":4,"fireRate":4,"cannon":2,"armor":6,"weapon":2,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1400);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(500);
const info = await page.evaluate(() => {
  const v = window.__game.view;
  const bm = v.blockMeshes?.[0];
  if (!bm) return { err: 'no blockMesh' };
  const b = bm.block;
  // group 里第 0 个是本体，第 1 个是数字面片
  const body = bm.group.children[0];
  const label = bm.group.children[1];
  const tex = label.material.map;
  const cv = tex.image;
  // 数一下画布上有多少非透明像素——0 就说明根本没画上去
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) opaque++;
  return {
    blockZ: b.z, hp: b.hp, span: b.span, tall: b.tall,
    x0: b.x0, x1: b.x1,
    bodyZ: body.position.z,
    labelPos: { x: +label.position.x.toFixed(2), y: +label.position.y.toFixed(2), z: +label.position.z.toFixed(2) },
    labelRotY: +label.rotation.y.toFixed(2),
    labelVisible: label.visible,
    canvas: { w: cv.width, h: cv.height, opaquePixels: opaque },
    texNeedsUpdate: tex.needsUpdate,
  };
});
console.log(JSON.stringify(info, null, 1));
console.log('ERRORS', errs);
await browser.close();
