import { UPGRADES } from '../config/balance';
import { ENDLESS_ID, LEVELS } from '../config/levels';
import { buyUpgrade, nextCost, type SaveData } from '../meta/Save';
import type { RunStats } from '../sim/World';

const h = (html: string): HTMLElement => {
  const t = document.createElement('div');
  t.innerHTML = html.trim();
  return t.firstElementChild as HTMLElement;
};

export interface ScreenActions {
  startLevel(id: number): void;
  openShop(): void;
  openMenu(): void;
  retry(): void;
  nextLevel(): void;
  toggleMute(): void;
  /** 在低 / 中 / 高之间循环。 */
  cycleQuality(): void;
  qualityLabel(): string;
  click(): void;
}

export interface ResultInfo {
  won: boolean;
  levelId: number;
  stats: RunStats;
  goldEarned: number;
  hasNext: boolean;
  /** 无尽模式：没有"通关"，成绩是推进了多远。 */
  endless?: boolean;
  distance?: number;
}

/** 主菜单 / 商店 / 结算三个全屏界面。 */
export class Screens {
  private current: HTMLElement | null = null;

  constructor(
    private readonly parent: HTMLElement,
    private readonly save: SaveData,
    private readonly actions: ScreenActions,
  ) {}

  get open(): boolean {
    return this.current !== null;
  }

  hide(): void {
    this.current?.remove();
    this.current = null;
  }

  private mount(el: HTMLElement): void {
    this.hide();
    this.current = el;
    this.parent.appendChild(el);
  }

  private bind(root: HTMLElement, sel: string, fn: () => void): void {
    root.querySelectorAll(sel).forEach((n) => {
      n.addEventListener('click', () => {
        this.actions.click();
        fn();
      });
    });
  }

  // ── 主菜单 ─────────────────────────────────────────────────

  showMenu(): void {
    const el = h(`
      <div class="screen">
        <button class="btn mute-btn" data-mute>${this.save.muted ? '🔇' : '🔊'}</button>
        <button class="btn quality-btn" data-quality>画质 ${this.actions.qualityLabel()}</button>
        <div class="title">末日生存</div>
        <div class="subtitle">尸潮防线</div>
        <div class="stat gold" style="align-self:center;margin-bottom:6px"><div class="dot">$</div><div class="val">${this.save.gold}</div></div>
        <div class="section">选择关卡</div>
        <div class="levels"></div>
        <button class="btn endless" data-endless>
          <div class="num">∞</div>
          <div class="meta">
            <div class="n">无尽模式</div>
            <div class="s">怪一路变强，撑到撑不住为止${this.save.bestDistance ? ` · 最远 ${Math.round(this.save.bestDistance)} m` : ''}</div>
          </div>
        </button>
        <div class="spacer"></div>
        <button class="btn gold" data-shop>兵工厂 · 永久升级</button>
        <div class="section">怎么玩</div>
        <div class="hint tips">
          左右<b>拖动屏幕</b>移动方阵，自动开火。<br>
          每道门是<b>二选一</b>：门上写着给什么，门顶写着<b>前方是什么怪</b>。<br>
          <b>蜂群</b>要靠大炮的溅射和人海去扛，<b>精英</b>要靠武器等级的单体高伤。<br>
          后排士兵的射界被前排挡住，火力会衰减 ——
          <b>堆人头买的是生存，换武器买的才是输出</b>。
        </div>
      </div>
    `);

    const list = el.querySelector('.levels')!;
    for (const lv of LEVELS) {
      const locked = lv.id > this.save.unlockedLevel;
      const best = this.save.bestTime[lv.id];
      const btn = h(`
        <button class="btn level-btn ${locked ? 'locked' : ''}" ${locked ? 'disabled' : ''} data-level="${lv.id}">
          <div class="num">${locked ? '🔒' : lv.id}</div>
          <div class="meta">
            <div class="n">${lv.name}</div>
            <div class="s">${locked ? '通关上一关后解锁' : lv.subtitle + (best ? ` · 最佳 ${best.toFixed(1)}s` : '')}</div>
          </div>
        </button>
      `);
      list.appendChild(btn);
    }

    this.mount(el);
    this.bind(el, '[data-level]', () => {});
    el.querySelectorAll('[data-level]').forEach((n) => {
      n.addEventListener('click', () => {
        const id = Number((n as HTMLElement).dataset.level);
        if (id > this.save.unlockedLevel) return;
        this.actions.click();
        this.actions.startLevel(id);
      });
    });
    this.bind(el, '[data-endless]', () => {
      this.actions.click();
      this.actions.startLevel(ENDLESS_ID);
    });
    this.bind(el, '[data-shop]', () => this.actions.openShop());
    this.bind(el, '[data-mute]', () => {
      this.actions.toggleMute();
      this.showMenu();
    });
    this.bind(el, '[data-quality]', () => {
      this.actions.cycleQuality();
      this.showMenu();
    });
  }

  // ── 商店 ───────────────────────────────────────────────────

  showShop(): void {
    const el = h(`
      <div class="screen">
        <div class="title" style="font-size:26px">兵工厂</div>
        <div class="subtitle">升级是永久的，会带进每一局</div>
        <div class="stat gold" style="align-self:center;margin-bottom:14px"><div class="dot">$</div><div class="val" data-gold>${this.save.gold}</div></div>
        <div class="items"></div>
        <div class="spacer"></div>
        <button class="btn primary" data-back>返回</button>
      </div>
    `);
    const items = el.querySelector('.items')!;

    const render = () => {
      items.replaceChildren();
      (el.querySelector('[data-gold]') as HTMLElement).textContent = String(this.save.gold);
      for (const def of UPGRADES) {
        const lv = this.save.upgrades[def.id] ?? 0;
        const cost = nextCost(def.id, this.save);
        const maxed = cost === null;
        const afford = !maxed && this.save.gold >= cost;
        const pips = Array.from({ length: def.maxLevel }, (_, i) => `<div class="pip ${i < lv ? 'on' : ''}"></div>`).join('');
        const row = h(`
          <div class="shop-item">
            <div class="info">
              <div class="name">${def.name} <span style="color:var(--dim);font-weight:600">Lv.${lv}/${def.maxLevel}</span></div>
              <div class="desc">${def.desc}</div>
              <div class="pips">${pips}</div>
            </div>
            <button class="btn buy ${afford ? 'gold' : ''}" ${maxed || !afford ? 'disabled' : ''} data-buy="${def.id}">
              ${maxed ? '已满级' : `$ ${cost}`}
            </button>
          </div>
        `);
        items.appendChild(row);
      }
      items.querySelectorAll('[data-buy]').forEach((n) => {
        n.addEventListener('click', () => {
          const id = (n as HTMLElement).dataset.buy as (typeof UPGRADES)[number]['id'];
          if (buyUpgrade(id, this.save)) {
            this.actions.click();
            render();
          }
        });
      });
    };

    render();
    this.mount(el);
    this.bind(el, '[data-back]', () => this.actions.openMenu());
  }

  // ── 结算 ───────────────────────────────────────────────────

  showResult(info: ResultInfo): void {
    const s = info.stats;
    const el = h(`
      <div class="screen">
        <div class="result-title ${info.won ? 'win' : 'lose'}">${info.endless ? '力 竭' : info.won ? '通 关' : '全 灭'}</div>
        <div class="subtitle">${info.endless ? '无尽模式' : LEVELS[info.levelId - 1]!.name}</div>
        <div class="result-stats">
          <div class="cell"><div class="k">击杀</div><div class="v">${s.kills}</div></div>
          <div class="cell"><div class="k">最高兵力</div><div class="v">${s.peakSoldiers}</div></div>
          ${info.endless
            ? `<div class="cell"><div class="k">推进距离</div><div class="v">${Math.round(info.distance ?? 0)} m</div></div>
               <div class="cell"><div class="k">最远纪录</div><div class="v" style="color:var(--gold)">${Math.round(this.save.bestDistance ?? 0)} m</div></div>`
            : `<div class="cell"><div class="k">用时</div><div class="v">${s.elapsed.toFixed(1)}s</div></div>
               <div class="cell"><div class="k">获得金币</div><div class="v" style="color:var(--gold)">+${info.goldEarned}</div></div>`}
        </div>
        <div class="hint tips">${info.won ? this.winTip(info) : this.loseTip()}</div>
        <div class="spacer"></div>
        <div class="row" style="margin-bottom:9px">
          <button class="btn" data-retry>${info.endless ? '再来一次' : '重打这关'}</button>
          ${info.won && info.hasNext ? '<button class="btn primary" data-next>下一关</button>' : ''}
        </div>
        <div class="row">
          <button class="btn gold" data-shop>兵工厂</button>
          <button class="btn" data-menu>主菜单</button>
        </div>
      </div>
    `);
    this.mount(el);
    this.bind(el, '[data-retry]', () => this.actions.retry());
    this.bind(el, '[data-next]', () => this.actions.nextLevel());
    this.bind(el, '[data-shop]', () => this.actions.openShop());
    this.bind(el, '[data-menu]', () => this.actions.openMenu());
  }

  private winTip(info: ResultInfo): string {
    return info.hasNext
      ? '下一关的怪更硬，光靠人头顶不住了 —— 去兵工厂把<b>制式装备</b>和<b>弹药强化</b>提上来。'
      : '五关全部通关。试试用更少的时间、更少的兵力再打一遍。';
  }

  private loseTip(): string {
    const tips = [
      '被<b>蜂群</b>淹掉了？大炮的溅射一次能清掉一整片，比多站几十个人管用。',
      '被<b>精英</b>正面打穿了？巨怪吃的是单体高伤，武器等级才是解法。',
      'Boss 脚下那个红圈是<b>践踏预警</b>，圈亮起来之前把方阵拖出去。',
      '兵力少的时候先吃"数量"门；兵力起来之后再吃"质量"门 —— 后排的火力是打折的。',
    ];
    return tips[Math.floor(Math.random() * tips.length)]!;
  }
}
