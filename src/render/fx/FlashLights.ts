import * as THREE from 'three';

/**
 * 爆炸 / 炮口的动态点光。
 *
 * 之前爆炸完全不照亮周围——一团加色粒子浮在原地，地面和角色一点反应都没有。
 * 几盏点光是性价比最高的一处改动。
 *
 * **关键约束**：灯必须在启动时一次性建好并常驻场景，运行期只改
 * position/intensity/color。three.js 在场景灯数量变化时会重编译所有材质的
 * 着色器——真到爆炸那一帧再 add 一盏灯，会直接卡一下。
 */

interface Slot {
  light: THREE.PointLight;
  life: number;
  maxLife: number;
  peak: number;
}

export class FlashLights {
  readonly group = new THREE.Group();
  private readonly slots: Slot[] = [];

  constructor(count = 3, distance = 26) {
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xffffff, 0, distance, 2);
      light.castShadow = false;
      this.group.add(light);
      this.slots.push({ light, life: 0, maxLife: 1, peak: 0 });
    }
  }

  /**
   * 点一盏。抢占策略：优先用空闲的，全忙就顶掉当前最暗的那盏——
   * 大爆炸不该被一串小闪光挤掉。
   */
  flash(x: number, y: number, z: number, color: number, intensity: number, life = 0.28): void {
    let best: Slot | null = null;
    let bestScore = Infinity;
    for (const s of this.slots) {
      const score = s.life <= 0 ? -1 : s.peak * (s.life / s.maxLife);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (!best) return;
    // 已经亮着、而且比这次更亮的，不要被抢
    if (best.life > 0 && bestScore > intensity) return;
    best.light.position.set(x, y, z);
    best.light.color.setHex(color);
    best.light.intensity = intensity;
    best.peak = intensity;
    best.maxLife = life;
    best.life = life;
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.life = 0;
        s.light.intensity = 0;
        continue;
      }
      // 二次衰减：闪一下就灭，不拖泥带水
      const t = s.life / s.maxLife;
      s.light.intensity = s.peak * t * t;
    }
  }

  reset(): void {
    for (const s of this.slots) {
      s.life = 0;
      s.light.intensity = 0;
    }
  }
}
