/**
 * 核对两处改造是不是真的成立：
 *  1. 金币必须开过去才捡得到（不再是走到 z 就自动入袋）
 *  2. 高墙是主动选择：不推杆就自动绕开，推杆就停下来啃
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const run = async (label, steerFn) => {
  await page.evaluate(() => { if (window.__game.world) window.__game.debugMenu(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-level="1"]').click());
  await page.waitForTimeout(400);
  return page.evaluate(async (src) => {
    const g = window.__game;
    const w = g.world;
    const steer = eval(src);
    const dt = 1 / 60;
    let t = 0, ramFrames = 0, picked = 0, pickGold = 0;
    const wall = w.blocks.find((b) => b.tall);
    const wallHp0 = wall ? wall.hp : 0;
    while (w.phase === 'running' && t < 42) {
      w.steer = steer(w, t);
      w.step(dt);
      for (const e of w.drainEvents()) {
        if (e.type === 'goldPickup') { picked++; pickGold += e.amount ?? 0; }
      }
      if (w.ramming) ramFrames++;
      t += dt;
    }
    return {
      gold: w.gold,
      picked,
      pickGold,
      pickupsTotal: w.pickups.length,
      ramFrames,
      wallHp0,
      wallHp: wall ? Math.round(wall.hp) : -1,
      wallDead: wall ? !wall.alive : false,
      z: Math.round(w.squad.z),
    };
  }, steerFn);
};

// A: 全程走正中间，不主动去捡任何东西
console.log('中间直行  ', JSON.stringify(await run('mid', '(w,t)=> -Math.sign(w.squad.x)*(Math.abs(w.squad.x)>0.3?1:0)')));
// B: 主动追着金币走
console.log('追金币    ', JSON.stringify(await run('greedy', `(w,t)=>{
  const p = w.pickups.filter(p=>p.alive && p.z > w.squad.z).sort((a,b)=>a.z-b.z)[0];
  if(!p) return 0;
  const d = p.x - w.squad.x;
  return Math.abs(d) > 0.4 ? Math.sign(d) : 0;
}`)));
// C: 主动顶墙（墙在哪边就往哪边推）
console.log('主动撞墙  ', JSON.stringify(await run('ram', `(w,t)=>{
  const b = w.activeBlock;
  if(b && b.span !== 'full' && Math.abs(b.z - w.squad.z) < 12){
    return b.x0 <= -8.99 ? -1 : 1;
  }
  return -Math.sign(w.squad.x)*(Math.abs(w.squad.x)>0.3?1:0);
}`)));

console.log('主动避墙  ', JSON.stringify(await run('avoid', `(w,t)=>{
  const b = w.activeBlock;
  if(b && b.span !== 'full' && Math.abs(b.z - w.squad.z) < 16){
    return b.x0 <= -8.99 ? 1 : -1;
  }
  return -Math.sign(w.squad.x)*(Math.abs(w.squad.x)>0.3?1:0);
}`)));
console.log('ERRORS', errs.length ? errs.slice(0, 5) : '[]');
await browser.close();
