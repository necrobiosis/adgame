/**
 * 新特效词汇的实机截图核对：贴花 / 动态光 / 冲击波 / 拉伸火星。
 * 打到尸潮最密的一段和 Boss 战各截一张，确认地面真的留痕、爆炸真的照亮周围。
 */
import { chromium } from 'playwright';
const SHOTS = process.env.SHOTS_DIR ?? './shots';

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const save = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":8,"fireRate":8,"cannon":4,"armor":8,"weapon":3},"bestTime":{},"muted":true}';
await page.evaluate((s) => localStorage.setItem('adgame.save.v1', s), save);
await page.evaluate((q) => localStorage.setItem('adgame.quality', q), 'high');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelector('[data-level="1"]').click());
await page.waitForTimeout(600);

const counts = () => page.evaluate(() => {
  const v = window.__game.view;
  return {
    decals: v.decals?.mesh.count ?? -1,
    waves: v.waves?.mesh.count ?? -1,
    sparks: v.sparks?.mesh.count ?? -1,
    lightsOn: v.flashes ? v.flashes.group.children.filter((l) => l.intensity > 0).length : -1,
  };
});

// 打一段尸潮，让地面积累尸液和血迹
await page.evaluate(() => window.__game.fastForward(28));
await page.waitForTimeout(500);
console.log('after horde', JSON.stringify(await counts()));
await page.screenshot({ path: `${SHOTS}/fx-horde.png`, timeout: 120000 });

// 贴近地面看留痕
await page.evaluate(() => window.__game.inspect('squad', 14, 5.5, 0));
await page.waitForTimeout(400);
await page.screenshot({ path: `${SHOTS}/fx-decals.png`, timeout: 120000 });
await page.evaluate(() => window.__game.inspect(null));

// 推到 Boss 战，抓爆炸/冲击波/动态光
for (let i = 0; i < 60; i++) {
  const st = await page.evaluate(() => {
    const w = window.__game.world;
    return { boss: w.boss.enemy?.alive ?? false, phase: w.phase };
  });
  if (st.boss || st.phase !== 'running') break;
  await page.evaluate(() => window.__game.fastForward(3));
}
await page.waitForTimeout(300);
// 让 boss 技能真的打出来：连续跑几秒实时帧
for (let i = 0; i < 14; i++) {
  await page.waitForTimeout(420);
  const c = await counts();
  if (c.waves > 0 || c.lightsOn > 0) {
    console.log('boss fx caught', JSON.stringify(c));
    await page.screenshot({ path: `${SHOTS}/fx-boss.png`, timeout: 120000 });
    break;
  }
}
console.log('final', JSON.stringify(await counts()));
console.log('ERRORS', errs.length ? errs.slice(0, 6) : '[]');
await browser.close();
