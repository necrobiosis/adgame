import { chromium } from 'playwright';
const SAVE = '{"version":1,"gold":99999,"unlockedLevel":5,"upgrades":{"squad":12,"damage":12,"fireRate":10,"cannon":6,"armor":10,"weapon":4,"slots":1},"loadout":["squad","damage","fireRate","weapon","cannon"],"bestTime":{},"muted":true}';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 460, height: 900 } });
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await p.evaluate((s) => localStorage.setItem('adgame.save.v1', s), SAVE);
await p.evaluate(() => localStorage.setItem('adgame.quality', 'high'));
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1300);
await p.evaluate(() => document.querySelector('[data-level="1"]').click());
await p.waitForTimeout(600);
await p.evaluate(() => { const w = window.__game.world; w.enemies.clear(); w.squad.addSoldiers(400); w.squad.layout(); });
await p.waitForTimeout(600);
const d = await p.evaluate(() => window.__game.debug());
console.log(`兵力 ${d.soldiers} → 实际画 ${d.drawn.soldiers} 人，全场 ${(d.tris / 1000).toFixed(0)}k 三角`);
await b.close();
