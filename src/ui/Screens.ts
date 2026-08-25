import { UPGRADES, type UpgradeId } from '../config/balance';
import { ENDLESS_ID, LEVELS } from '../config/levels';
import { buyUpgrade, loadoutFull, nextCost, slotCount, toggleLoadout, type SaveData } from '../meta/Save';
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
        ${this.loadoutStrip()}
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
          路分<b>三排</b>，枪<b>不自瞄</b>——子弹只往正前方飞，
          <b>你站哪一排，火力就只落在哪一排</b>。地上那条亮带就是你的火线。<br>
          <b>墙只长在其中一排</b>：走过去才打得穿、才拿得到奖励，
          代价是这段时间火力全砸在墙上；走别的排就是彻底错过。<br>
          大怪老远就看得见——先想好它走到跟前时你该站哪一排。<br>
          <b>大炮是曲射的，能砸到隔壁排</b>，这是它和武器等级的本质区别。<br>
          兵工厂里买到的模块，每一局<b>只能带 ${slotCount(this.save)} 个上场</b> ——
          买满不等于全带，出征前先想清楚这一趟要什么。
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

  /**
   * 主菜单上的出征装备一览。
   *
   * 装备位是开打之前唯一的决策点，藏在商店里玩家根本不会意识到它存在——
   * 必须在按下"开始"的那一屏上就看得见。
   */
  private loadoutStrip(): string {
    const slots = slotCount(this.save);
    const names = this.save.loadout.map((id) => UPGRADES.find((u) => u.id === id)?.name ?? id);
    const chips = Array.from({ length: slots }, (_, i) =>
      names[i]
        ? `<div class="chip on">${names[i]}</div>`
        : '<div class="chip">空位</div>').join('');
    return `
      <div class="section">出征装备 ${names.length}/${slots}</div>
      <div class="loadout-strip" data-shop>${chips}</div>
    `;
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

      // 装备位：整个商店最重要的一行。买满不等于全带，玩家必须在这里做取舍。
      const slots = slotCount(this.save);
      const used = this.save.loadout.length;
      const dots = Array.from({ length: slots }, (_, i) => `<div class="slot ${i < used ? 'on' : ''}"></div>`).join('');
      items.appendChild(h(`
        <div class="slots-bar">
          <div class="k">出征装备位</div>
          ${dots}
          <div class="note">${used}/${slots} · 只有装上的模块这一局才生效</div>
        </div>
      `));

      let group = '';
      for (const def of UPGRADES) {
        const g = def.passive ? '元升级' : def.drawback ? '专精模块 · 有代价' : '基础模块';
        if (g !== group) {
          group = g;
          items.appendChild(h(`<div class="shop-group">${g}</div>`));
        }
        const lv = this.save.upgrades[def.id] ?? 0;
        const cost = nextCost(def.id, this.save);
        const maxed = cost === null;
        const afford = !maxed && this.save.gold >= cost;
        const equipped = this.save.loadout.includes(def.id);
        const canEquip = !def.passive && lv > 0 && (equipped || !loadoutFull(this.save));
        const pips = Array.from({ length: def.maxLevel }, (_, i) => `<div class="pip ${i < lv ? 'on' : ''}"></div>`).join('');
        const row = h(`
          <div class="shop-item ${equipped ? 'equipped' : ''}">
            <div class="info">
              <div class="name">${def.name} <span style="color:var(--dim);font-weight:600">Lv.${lv}/${def.maxLevel}</span></div>
              <div class="desc">${def.desc}</div>
              ${def.drawback ? `<div class="cost">代价：${def.drawback}</div>` : ''}
              <div class="pips">${pips}</div>
            </div>
            <div class="col">
              <button class="btn buy ${afford ? 'gold' : ''}" ${maxed || !afford ? 'disabled' : ''} data-buy="${def.id}">
                ${maxed ? '已满级' : `$ ${cost}`}
              </button>
              ${def.passive
                ? '<button class="equip" disabled>常驻</button>'
                : `<button class="equip ${equipped ? 'on' : ''}" ${canEquip ? '' : 'disabled'} data-equip="${def.id}">
                     ${equipped ? '已装备' : lv <= 0 ? '未拥有' : canEquip ? '装备' : '位子已满'}
                   </button>`}
            </div>
          </div>
        `);
        items.appendChild(row);
      }
      items.querySelectorAll('[data-buy]').forEach((n) => {
        n.addEventListener('click', () => {
          const id = (n as HTMLElement).dataset.buy as UpgradeId;
          if (buyUpgrade(id, this.save)) {
            this.actions.click();
            render();
          }
        });
      });
      items.querySelectorAll('[data-equip]').forEach((n) => {
        n.addEventListener('click', () => {
          const id = (n as HTMLElement).dataset.equip as UpgradeId;
          if (toggleLoadout(id, this.save)) {
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
