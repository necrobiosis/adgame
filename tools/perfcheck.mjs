/**
 * 性能核对：方阵视觉上限从 10 放开到 200 之后，最坏情况还跑不跑得动。
 *
 * 最坏情况 = 满编方阵 + 满屏尸潮 + 高画质。三档画质各测一遍，量的是
 * 实际帧时间（swiftshader 软渲染，绝对值没意义，看的是相对开销和三角形数）。
 */
import { chromium } from 'playwright';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const errs = [];
for (const q of ['high', 'medium', 'low']) {
  const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
  page.on('pageerror', (e) => errs.push(`${q} ` + e.message));
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
  await page.evaluate((qq) => localStorage.setItem('adgame.quality', qq), q);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1300);
  await page.evaluate(() => document.querySelector('[data-level="5"]').click());
  await page.waitForTimeout(600);

  // 最坏情况：满编方阵 + 三排全是怪
  await page.evaluate(() => {
    const w = window.__game.world;
    w.squad.addSoldiers(400);
    w.squad.layout();
    for (let i = 0; i < 420; i++) {
      const e = w.enemies.spawn(i % 14 === 0 ? 'brute' : i % 5 === 0 ? 'runner' : 'walker',
        (Math.random() - 0.5) * 21, w.squad.z + 8 + Math.random() * 70);
      e.laneX = e.x;
      e.hp = e.maxHp = 1e6;
    }
  });
  await page.waitForTimeout(1200);

  // 量 90 帧的帧时间
  const perf = await page.evaluate(() => new Promise((res) => {
    const ts = [];
    let last = performance.now();
    let n = 0;
    const tick = () => {
      const now = performance.now();
      ts.push(now - last);
      last = now;
      if (++n < 90) requestAnimationFrame(tick);
      else {
        ts.sort((a, b) => a - b);
        res({ median: +ts[45].toFixed(1), p90: +ts[81].toFixed(1) });
      }
    };
    requestAnimationFrame(tick);
  }));
  const d = await page.evaluate(() => window.__game.debug());
  const drawnSoldiers = d.drawn.soldiers;
  console.log(`${q.padEnd(6)} 帧时间 中位 ${perf.median}ms / p90 ${perf.p90}ms | 士兵 ${drawnSoldiers} 三角 ${(d.tris / 1000).toFixed(0)}k drawcall ${d.calls}`);
  await page.close();
}
console.log('ERRORS', errs.length ? errs.slice(0, 4) : '[]');
await browser.close();
