import { formatHp } from '../render/hud3d/BlockMesh';
import type { World } from '../sim/World';

const h = (html: string): HTMLElement => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild as HTMLElement;
};

/** 游戏中的抬头显示：兵力、金币、装备、进度条、Boss 血条。 */
export class HUD {
  readonly root: HTMLElement;
  private readonly squadVal: HTMLElement;
  private readonly goldVal: HTMLElement;
  private readonly weaponChip: HTMLElement;
  private readonly cannonChip: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly progressName: HTMLElement;
  private readonly progressPct: HTMLElement;
  private readonly bossBar: HTMLElement;
  private readonly bossName: HTMLElement;
  private readonly bossHp: HTMLElement;
  private readonly bossFill: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = h(`
      <div class="hud">
        <div class="hud-top">
          <div class="stat squad"><div class="dot">兵</div><div class="val">0</div></div>
          <div class="stat gold"><div class="dot">$</div><div class="val">0</div></div>
        </div>
        <div class="hud-loadout">
          <div class="chip">武器 <b>手枪</b></div>
          <div class="chip">大炮 <b>0</b></div>
        </div>
        <div class="boss-bar">
          <div class="name">深渊领主</div>
          <div class="hp">0</div>
          <div class="track"><div class="fill" style="width:100%"></div></div>
        </div>
        <div class="hud-bottom">
          <div class="progress-label"><span class="lname">第一关</span><span class="lpct">0%</span></div>
          <div class="progress"><div class="fill" style="width:0%"></div></div>
        </div>
      </div>
    `);
    parent.appendChild(this.root);

    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    this.squadVal = q('.stat.squad .val');
    this.goldVal = q('.stat.gold .val');
    const chips = this.root.querySelectorAll('.hud-loadout .chip b');
    this.weaponChip = chips[0] as HTMLElement;
    this.cannonChip = chips[1] as HTMLElement;
    this.progressFill = q('.progress .fill');
    this.progressName = q('.lname');
    this.progressPct = q('.lpct');
    this.bossBar = q('.boss-bar');
    this.bossName = q('.boss-bar .name');
    this.bossHp = q('.boss-bar .hp');
    this.bossFill = q('.boss-bar .fill');
  }

  setVisible(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }

  update(world: World): void {
    this.squadVal.textContent = String(world.squad.soldierCount);
    this.goldVal.textContent = String(world.gold);
    this.weaponChip.textContent = world.squad.weapon.name;
    const cannons = world.squad.cannonCount;
    this.cannonChip.textContent = String(cannons);
    (this.cannonChip.parentElement as HTMLElement).style.opacity = cannons > 0 ? '1' : '0.45';

    this.progressName.textContent = world.level.name;
    const pct = Math.round(world.progress * 100);
    this.progressPct.textContent = `${pct}%`;
    this.progressFill.style.width = `${pct}%`;

    const boss = world.boss.enemy;
    if (boss && boss.alive) {
      this.bossBar.classList.add('on');
      this.bossName.textContent = world.boss.name;
      this.bossHp.textContent = formatHp(Math.ceil(boss.hp));
      this.bossFill.style.width = `${(boss.hp / boss.maxHp) * 100}%`;
    } else {
      this.bossBar.classList.remove('on');
    }
  }
}

/** 世界坐标上飘出来的数字与提示。 */
export class FloatingLayer {
  private readonly root: HTMLElement;
  private live = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    parent.appendChild(this.root);
  }

  spawn(text: string, color: string, x: number, y: number, big: boolean): void {
    if (this.live > 26) return;
    const el = document.createElement('div');
    el.className = big ? 'float big' : 'float';
    el.textContent = text;
    el.style.color = color;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.root.appendChild(el);
    this.live++;
    el.addEventListener('animationend', () => {
      el.remove();
      this.live--;
    });
  }

  clear(): void {
    this.root.replaceChildren();
    this.live = 0;
  }
}
