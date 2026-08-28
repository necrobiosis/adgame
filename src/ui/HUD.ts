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
  private readonly squadBadge: HTMLElement;
  private readonly strikeBtn: HTMLButtonElement;
  private readonly strikeRing: HTMLElement;
  private strikeReady: boolean | null = null;

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
        <div class="squad-badge">× 0</div>
        <button class="strike" type="button" aria-label="空袭">
          <span class="ring"></span>
          <span class="icon">空袭</span>
        </button>
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
    this.squadBadge = q('.squad-badge');
    this.strikeBtn = q('.strike') as HTMLButtonElement;
    this.strikeRing = q('.strike .ring');
  }

  /** 空袭按钮的点击回调由 Game 装上。 */
  onStrike(fn: () => void): void {
    this.strikeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
  }

  /** 呼叫成功时给一下反馈动画。 */
  flashStrike(): void {
    this.strikeBtn.classList.remove('fire');
    void this.strikeBtn.offsetWidth;
    this.strikeBtn.classList.add('fire');
  }

  /**
   * 方阵人数超过视觉呈现上限时，在渲染出来的最后一排后方挂一个常驻的
   * 总数标签（"露出来的方阵 + 一个总数"，而不是超出的人数凭空消失）。
   * 传 null 隐藏。
   */
  updateSquadBadge(pos: { x: number; y: number; visible: boolean; total: number } | null): void {
    if (!pos || !pos.visible) {
      this.squadBadge.classList.remove('on');
      return;
    }
    this.squadBadge.classList.add('on');
    this.squadBadge.textContent = `× ${pos.total}`;
    this.squadBadge.style.left = `${pos.x}px`;
    this.squadBadge.style.top = `${pos.y}px`;
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
    // 无尽模式没有终点，百分比毫无意义——直接报推进了多少米，那才是成绩
    this.progressPct.textContent = world.level.endless ? `${Math.round(world.distance)} m` : `${pct}%`;
    this.progressFill.style.width = `${pct}%`;

    // 充能环用 conic-gradient 画，满了才点亮并允许点击
    const c = Math.max(0, Math.min(1, world.strikeCharge));
    this.strikeRing.style.background =
      `conic-gradient(#ffb03a ${c * 360}deg, rgba(255,255,255,0.10) 0deg)`;
    const ready = c >= 1;
    if (ready !== this.strikeReady) {
      this.strikeReady = ready;
      this.strikeBtn.classList.toggle('ready', ready);
      this.strikeBtn.disabled = !ready;
    }

    const boss = world.boss.enemy;
    // 预览态的那只只是远处的黑影，血条要等它真正入场才出现
    if (boss && boss.alive && !world.boss.previewing) {
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
  private readonly flashEl: HTMLElement;
  private readonly vignetteEl: HTMLElement;
  private live = 0;
  /** 暗角的节流：一波尸潮里几十个人同时倒下，不能每个都触发一次动画。 */
  private lastVignette = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    parent.appendChild(this.root);
    this.flashEl = document.createElement('div');
    this.flashEl.className = 'screen-flash';
    this.root.appendChild(this.flashEl);
    this.vignetteEl = document.createElement('div');
    this.vignetteEl.className = 'damage-vignette';
    this.root.appendChild(this.vignetteEl);
  }

  /** 掉人了：四周压一下红。 */
  damage(): void {
    const now = performance.now();
    if (now - this.lastVignette < 420) return;
    this.lastVignette = now;
    this.vignetteEl.classList.remove('go');
    void this.vignetteEl.offsetWidth;
    this.vignetteEl.classList.add('go');
  }

  /** 全屏白闪一下——落雷这种"天降打击"需要一瞬间的曝光过量感。 */
  flash(color = '#dff2ff'): void {
    this.flashEl.style.background = color;
    this.flashEl.classList.remove('go');
    void this.flashEl.offsetWidth; // 强制重排，让连续触发也能重新播放
    this.flashEl.classList.add('go');
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
    // 只清飘字，别把常驻的覆盖层（全屏闪、受击暗角）一起端掉——
    // replaceChildren() 会把它们也删掉，之后 flash()/damage() 就都作用在
    // 已经脱离文档的节点上，屏幕上什么都不会发生。
    for (const el of [...this.root.children]) {
      if (el !== this.flashEl && el !== this.vignetteEl) el.remove();
    }
    this.live = 0;
  }
}
