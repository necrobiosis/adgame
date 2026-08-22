import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { QUALITY, type QualityLevel, type QualitySettings } from './Quality';

/** 竖屏 9:16。桌面端在窗口里居中放一块竖屏画布，手机端就是满屏。 */
export const ASPECT = 9 / 16;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  composer!: EffectComposer;
  quality: QualitySettings;

  private bloom!: UnrealBloomPass;
  private smaa: SMAAPass | null = null;
  private gtao: GTAOPass | null = null;
  private renderPass!: RenderPass;
  /** 画布的 CSS 尺寸，UI 层拿它做世界坐标 → 屏幕坐标投影。 */
  viewWidth = 0;
  viewHeight = 0;

  constructor(readonly canvas: HTMLCanvasElement, level: QualityLevel) {
    this.quality = QUALITY[level];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // 走 composer，MSAA 用不上，改用 SMAA
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // composer 每一趟 pass 都会重置统计，手动累计才能拿到整帧的真实三角形数
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(54, ASPECT, 0.5, 1400);

    this.buildComposer();
    this.applyQuality(level);
    this.resize();
  }

  private buildComposer(): void {
    this.composer?.dispose();
    const composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    composer.addPass(this.renderPass);

    if (this.quality.gtao) {
      // 接触阴影：几何体缝隙、方阵脚下、桁架节点处的暗部
      const gtao = new GTAOPass(this.scene, this.camera, 1, 1);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 12 });
      composer.addPass(gtao);
      this.gtao = gtao;
    } else {
      this.gtao = null;
    }

    // 只留给门、曳光弹、爆炸。阈值是在 tone mapping 之前的线性空间里比的，
    // 被太阳照亮的白色路面标线线性值就已经超过 1，所以阈值必须开在 1 以上。
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.5, 1.7);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());

    if (this.quality.smaa) {
      this.smaa = new SMAAPass();
      composer.addPass(this.smaa);
    } else {
      this.smaa = null;
    }

    this.composer = composer;
  }

  applyQuality(level: QualityLevel): void {
    const q = QUALITY[level];
    const rebuild = q.gtao !== this.quality.gtao || q.smaa !== this.quality.smaa;
    this.quality = q;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q.maxPixelRatio));
    this.renderer.shadowMap.enabled = q.shadowMap > 0;
    if (rebuild) this.buildComposer();
    this.resize();
  }

  private envTarget: THREE.WebGLRenderTarget | null = null;

  /** 环境贴图由 GameView 按关卡主题生成后交进来。 */
  setEnvironment(target: THREE.WebGLRenderTarget, intensity = 1): void {
    this.envTarget?.dispose();
    this.envTarget = target;
    this.scene.environment = target.texture;
    this.scene.environmentIntensity = intensity;
  }

  resize(): void {
    const availW = window.innerWidth;
    const availH = window.innerHeight;
    // 保持 9:16，取能放下的最大尺寸
    let w = availW;
    let h = w / ASPECT;
    if (h > availH) {
      h = availH;
      w = h * ASPECT;
    }
    w = Math.floor(w);
    h = Math.floor(h);
    this.viewWidth = w;
    this.viewHeight = h;

    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.gtao?.setSize(w, h);
    this.camera.aspect = ASPECT;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.info.reset();
    this.composer.render();
  }

  private readonly projScratch = new THREE.Vector3();

  /** 世界坐标 → 画布内的像素坐标（UI 浮字用）。 */
  project(v: THREE.Vector3, out: { x: number; y: number; visible: boolean }): void {
    const p = this.projScratch.copy(v).project(this.camera);
    out.visible = p.z < 1 && p.x > -1.4 && p.x < 1.4 && p.y > -1.4 && p.y < 1.4;
    out.x = (p.x * 0.5 + 0.5) * this.viewWidth;
    out.y = (-p.y * 0.5 + 0.5) * this.viewHeight;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }
}

/**
 * 追尾镜头。
 * 取景照着广告来：机位偏高、在方阵后方，往前压出一大段路面，
 * 这样前方的尸潮、门和 Boss 能一次性全进画面。
 */
export class ChaseCamera {
  private readonly pos = new THREE.Vector3(0, 12, -16.5);
  private readonly look = new THREE.Vector3(0, 1.6, 12);
  private shake = 0;
  /** Boss 战时拉远一点，把 Boss 完整框进来。 */
  zoom = 0;
  /** 平滑过的方阵纵深。 */
  private depth = 0;

  update(
    cam: THREE.PerspectiveCamera,
    dt: number,
    squadX: number,
    squadZ: number,
    squadDepth: number,
    bossActive: boolean,
  ): void {
    this.zoom += ((bossActive ? 1 : 0) - this.zoom) * Math.min(1, dt * 1.2);
    // 方阵越厚，镜头就要往后往上让 —— 否则几百人的后排会直接跑到镜头背后
    this.depth += (squadDepth - this.depth) * Math.min(1, dt * 2.2);
    // Boss 体型从 3.4 提到 4.4（约 +30%），拉远量跟着放大同一个比例，
    // 否则变大的 Boss 会在竖屏画面里顶到镜头
    const height = 12 + this.zoom * 4.4 + this.depth * 0.44;
    const back = 18 + this.zoom * 7.2 + this.depth * 0.98;
    const ahead = 28 + this.zoom * 7.8 + this.depth * 0.35;

    const tx = squadX * 0.42;
    const k = Math.min(1, dt * 4.5);
    this.pos.x += (tx - this.pos.x) * k;
    this.pos.y += (height - this.pos.y) * k;
    this.pos.z += (squadZ - back - this.pos.z) * Math.min(1, dt * 8);

    this.look.x += (squadX * 0.55 - this.look.x) * k;
    this.look.y += (2.0 - this.look.y) * k;
    this.look.z += (squadZ + ahead - this.look.z) * Math.min(1, dt * 8);

    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt * 2.6);
      const s = this.shake * this.shake;
      cam.position.set(
        this.pos.x + (Math.random() - 0.5) * s * 1.6,
        this.pos.y + (Math.random() - 0.5) * s * 1.2,
        this.pos.z + (Math.random() - 0.5) * s * 0.8,
      );
    } else {
      cam.position.copy(this.pos);
    }
    cam.lookAt(this.look);
  }

  /** 爆炸 / Boss 践踏的镜头震动。 */
  punch(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  /** 开新一局时把镜头瞬移到位，避免从上一局的位置飞过来。 */
  snap(squadX: number, squadZ: number): void {
    this.pos.set(squadX * 0.42, 12, squadZ - 18);
    this.look.set(squadX * 0.55, 2.0, squadZ + 28);
    this.shake = 0;
    this.zoom = 0;
    this.depth = 0;
  }
}
