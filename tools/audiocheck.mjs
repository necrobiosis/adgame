/**
 * 音效离线渲染自检。
 *
 * 把 Audio 类接到一个 OfflineAudioContext 上，每次渲一个音效，
 * 回读波形算峰值/RMS/时长/立体声差，确认：
 *  - 真的有信号（不是哑的）
 *  - 没有削波（峰值 < 1.0）
 *  - 有混响尾（信号在主体结束后仍然延续）
 *  - 立体声定位真的在起作用
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });

const rows = await page.evaluate(async () => {
  const { Audio } = await import('/src/core/Audio.ts');
  const RATE = 44100;
  const SECS = 3;

  const analyse = async (name, fire, pan = 0) => {
    const offline = new OfflineAudioContext(2, RATE * SECS, RATE);
    const realAC = window.AudioContext;
    window.AudioContext = function () { return offline; };
    const a = new Audio();
    a.unlock();
    window.AudioContext = realAC;
    // 等异步渲染出来的混响 IR 落位
    await new Promise((r) => setTimeout(r, 250));
    a.frame(); // 补上每帧的开火预算，否则 shot() 会被预算判定直接吃掉
    fire(a, pan);
    const buf = await offline.startRendering();
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    let peak = 0, sumSq = 0, lastLoud = 0, sumL = 0, sumR = 0, bad = 0;
    for (let i = 0; i < L.length; i++) {
      const l = L[i], r = R[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) { bad++; continue; }
      const m = Math.max(Math.abs(l), Math.abs(r));
      if (m > peak) peak = m;
      sumSq += m * m;
      if (m > 0.002) lastLoud = i;
      sumL += Math.abs(l);
      sumR += Math.abs(r);
    }
    const bias = sumL + sumR > 0 ? (sumR - sumL) / (sumR + sumL) : 0;
    return {
      name,
      peak: +peak.toFixed(3),
      rms: +Math.sqrt(sumSq / L.length).toFixed(4),
      tailSec: +(lastLoud / RATE).toFixed(2),
      panBias: +bias.toFixed(2),
      nan: bad,
    };
  };

  const out = [];
  out.push(await analyse('shot t0 手枪', (a, p) => a.shot(0, p), -0.6));
  out.push(await analyse('shot t3 轻机枪', (a, p) => a.shot(3, p), 0));
  out.push(await analyse('shot t5 等离子', (a, p) => a.shot(5, p), 0.6));
  out.push(await analyse('cannon L', (a, p) => a.cannon(p), -0.8));
  out.push(await analyse('explosion R', (a, p) => a.explosion(p), 0.8));
  out.push(await analyse('blockBreak', (a, p) => a.blockBreak(p)));
  out.push(await analyse('coinPickup', (a, p) => a.coinPickup(0, p)));
  out.push(await analyse('coinPickup streak8', (a, p) => a.coinPickup(8, p)));
  out.push(await analyse('gate good', (a, p) => a.gate(true, p)));
  out.push(await analyse('gate bad', (a, p) => a.gate(false, p)));
  out.push(await analyse('zombieDie', (a, p) => { for (let i = 0; i < 12; i++) a.zombieDie(p); }));
  out.push(await analyse('soldierDown', (a, p) => a.soldierDown(p)));
  out.push(await analyse('telegraph slam', (a, p) => a.telegraph(1.15, 'slam', p)));
  out.push(await analyse('telegraph lightning', (a, p) => a.telegraph(1.3, 'lightning', p)));
  out.push(await analyse('bossRoar', (a, p) => a.bossRoar(p)));
  out.push(await analyse('footstep', (a, p) => a.footstep(p)));
  out.push(await analyse('thunderCrack', (a, p) => a.thunderCrack(p)));
  out.push(await analyse('win', (a) => a.win()));
  out.push(await analyse('lose', (a) => a.lose()));
  out.push(await analyse('click', (a) => a.click()));
  return out;
});

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('sound', 22), pad('peak', 7), pad('rms', 8), pad('tail(s)', 9), pad('pan', 6), 'nan');
console.log('-'.repeat(62));
let fails = 0;
for (const r of rows) {
  const silent = r.rms < 0.0004;
  const clipped = r.peak > 0.999;
  const flag = r.nan > 0 ? ' ✗NaN' : silent ? ' ✗SILENT' : clipped ? ' ✗CLIP' : '';
  if (flag) fails++;
  console.log(pad(r.name, 22), pad(r.peak, 7), pad(r.rms, 8), pad(r.tailSec, 9), pad(r.panBias, 6), r.nan + flag);
}
console.log('-'.repeat(62));
console.log(fails === 0 ? 'ALL OK' : `${fails} PROBLEM(S)`);
console.log('ERRORS', errs);
await browser.close();
