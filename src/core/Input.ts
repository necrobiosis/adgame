import { ROAD_HALF } from '../config/balance';
import { screenDeltaToWorldX } from '../sim/lanes';

/** 拖满整个屏幕宽度对应多少世界单位的横移。 */
const DRAG_SCALE = 30;

/**
 * 操控。
 * 手指（或鼠标）横向拖拽 = 方阵横移，和广告里的操作一致。
 * 键盘 A/D、←/→ 也能用，方便在桌面上调试。
 */
export class Input {
  /** 玩家想让方阵去的 x（世界坐标）。 */
  targetX = 0;
  /** 有没有正在拖。 */
  dragging = false;

  private lastX = 0;
  private keyLeft = false;
  private keyRight = false;
  private enabled = false;
  private readonly onDown: (e: PointerEvent) => void;
  private readonly onMove: (e: PointerEvent) => void;
  private readonly onUp: (e: PointerEvent) => void;
  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onKeyUp: (e: KeyboardEvent) => void;

  constructor(private readonly el: HTMLElement, private readonly viewWidth: () => number) {
    this.onDown = (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      this.lastX = e.clientX;
      el.setPointerCapture(e.pointerId);
    };
    this.onMove = (e) => {
      if (!this.enabled || !this.dragging) return;
      const dx = e.clientX - this.lastX;
      this.lastX = e.clientX;
      this.nudge(screenDeltaToWorldX((dx / Math.max(1, this.viewWidth())) * DRAG_SCALE));
    };
    this.onUp = (e) => {
      this.dragging = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };
    this.onKeyDown = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.keyLeft = true;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.keyRight = true;
    };
    this.onKeyUp = (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.keyLeft = false;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.keyRight = false;
    };

    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.dragging = false;
  }

  reset(x = 0): void {
    this.targetX = x;
    this.dragging = false;
  }

  /** 每帧调用，处理键盘持续输入。 */
  tick(dt: number): void {
    if (!this.enabled) return;
    if (this.keyLeft) this.nudge(screenDeltaToWorldX(-22 * dt));
    if (this.keyRight) this.nudge(screenDeltaToWorldX(22 * dt));
  }

  private nudge(d: number): void {
    this.targetX = clamp(this.targetX + d, -ROAD_HALF, ROAD_HALF);
  }

  /** 把目标位置换算成模拟层要的 [-1,1] 横移意图。 */
  steerFor(currentX: number): number {
    const d = this.targetX - currentX;
    if (Math.abs(d) < 0.05) return 0;
    return clamp(d * 2.4, -1, 1);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
