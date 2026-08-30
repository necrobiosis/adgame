import * as THREE from 'three';
import {
  ENEMY_STATS,
  type BossKind,
  MAX_RENDERED_SOLDIERS,
  ROAD_HALF,
  SLOT_SPACING_Z,
  type EnemyKind,
} from '../config/balance';
import { Rng } from '../core/Rng';
import type { World } from '../sim/World';
import type { Enemy, SimEvent, Unit } from '../sim/types';
import { LANE_SIGN } from '../sim/lanes';
import { ChaseCamera, Renderer } from './Renderer';
import { createCity } from './env/City';
import { createBridge } from './env/Bridge';
import { BRICK_SKY, createBrickBridge, createBrickCity, createBrickProps } from './env/Brick';
import { Dragon } from './env/Dragon';
import { createLights, createSky, createSkyEnvironment, skyForLevel, type SceneLights, type SkyTheme } from './env/Sky';
import { createProps, propsForLevel } from './env/Props';
import { Weather, type WeatherKind } from './env/Weather';
import { AreaTelegraph } from './fx/AreaTelegraph';
import { FireLane } from './fx/FireLane';
import { fireCorridor } from '../sim/Enemies';

/**
 * 火线亮带画多长 = 有效射程 × 这个系数。
 *
 * 射程是无限的，带子当然不可能画到无限远。画到"伤害还剩个零头"的那个距离
 * 为止，正好把有效射程这件事也画出来了：换上电磁炮，地上那条光带一下子
 * 铺出去三倍远——升级看得见，不用读数值。
 */
const FIRE_LANE_REACH = 2.6;
import { Decals } from './fx/Decals';
import { FlashLights } from './fx/FlashLights';
import { GoldBurst } from './fx/GoldBurst';
import { Lightning } from './fx/Lightning';
import { Particles } from './fx/Particles';
import { Shockwaves } from './fx/Shockwaves';
import { LightningReticle, TelegraphLane, TelegraphRing } from './fx/Telegraph';
import { Tracers } from './fx/Tracers';
import { BlockMesh } from './hud3d/BlockMesh';
import { GateWall } from './hud3d/GateWall';
import { HealthBarBatch } from './hud3d/HealthBarBatch';
import { CrowdBatch } from './units/CrowdRenderer';
import { PRESET, industrial } from './mat/pbr';
import { ensureSurf } from './mat/triplanar';
import { createCrowdMaterial, type CrowdMaterialSet } from './units/CrowdMaterial';
import { ENEMY_JITTER, SOLDIER_JITTER, WHITE, jitterTint } from './units/colorVariation';
import {
  armoredGeometry,
  bossGeometry,
  bruteGeometry,
  leaperGeometry,
  geometryPivots,
  midBossGeometry,
  runnerGeometry,
  screamerGeometry,
  soldierGeometry,
  spitterGeometry,
  titanGeometry,
  zombieGeometry,
  swarmlingGeometry,
  bomberGeometry,
  zombieVariantGeometry,
  runnerVariantGeometry,
  ZOMBIE_VARIANTS,
  RUNNER_VARIANTS,
  type BuildQuality,
} from './units/HumanoidGeometry';
import { cannonGeometry, coinPileGeometry, shellGeometry } from './units/PropGeometry';

/**
 * 各类敌人的实例缓冲上限。
 *
 * 真正每帧画多少由画质档的 enemyInstances 决定 —— 渲染层只挑**离方阵最近的
 * 那一批**画出来。被舍弃的都在百米开外、埋在雾里，屏幕上只有几个像素，
 * 而模拟层里它们照常存在、照常推进、照常啃人，玩法一点没变。
 */
/**
 * 每个 Boss 的熔纹发光色和强度——和它的招式配色对得上。
 *
 * 强度必须一只一只调：发光量取决于身上有多少凸起的棱线，而腐化巨兽
 * 又宽又肿，同样的强度会把整个躯干糊成一团荧光绿，看不出体型。
 */
/** 各 Boss 几何体的建模身高（米），检视镜头要靠它算头部位置。 */
const BOSS_HEIGHT: Record<BossKind, number> = {
  overlord: 2.9, plague: 2.75, maw: 3.35, apostle: 3.05, ender: 3.5,
};

const BOSS_CRACK: Record<BossKind, { color: number; strength: number }> = {
  overlord: { color: 0xff5a1a, strength: 4.5 },
  plague: { color: 0x9ce85a, strength: 2.2 },
  maw: { color: 0xff9a3c, strength: 4.0 },
  apostle: { color: 0xff3a44, strength: 3.6 },
  ender: { color: 0xc9a8ff, strength: 4.2 },
};

/** `walker#2` → `walker`。批次键里带变体号，统计和材质仍按种类走。 */
function baseKind(key: string): EnemyKind {
  const i = key.indexOf('#');
  return (i < 0 ? key : key.slice(0, i)) as EnemyKind;
}

/** 实例 → 批次键。同一种杂兵按 id 摊到几套体型上。 */
function batchKey(e: Enemy): string {
  if (e.kind === 'walker') {
    const v = e.id % ZOMBIE_VARIANTS;
    return v === 0 ? 'walker' : `walker#${v}`;
  }
  if (e.kind === 'runner') {
    const v = e.id % RUNNER_VARIANTS;
    return v === 0 ? 'runner' : `runner#${v}`;
  }
  return e.kind;
}

const CROWD_CAPACITY: Record<EnemyKind, number> = {
  walker: 360,
  runner: 200,
  screamer: 48,
  brute: 40,
  titan: 32,
  midboss: 2,
  boss: 1,
  spitter: 60,
  leaper: 90,
  armored: 60,
  swarmling: 420,
  bomber: 60,
};

/**
 * 受击提亮的强度。
 *
 * 体型越大的怪闪得越弱：Boss 每秒要挨上百发，flash 实际上是常驻满值的，
 * 按小怪的幅度去提亮会让它整只糊成一块粉白。大块头挨一枪本来也不该整个亮起来。
 */
function flashAmount(e: Enemy): number {
  if (e.flash <= 0) return 0;
  const raw = e.flash / 0.09;
  return e.scale >= 2 ? raw * 0.3 : e.scale >= 1.4 ? raw * 0.6 : raw;
}

/** Enemies.ts 里的倒地动画时长，用来把 dying 换算成 0..1 的翻倒进度。 */
const DYING_TIME = 0.55;

/** 大炮的渲染上限。单门约 6.6k 三角形，32 门封顶约 21 万。 */
const MAX_RENDERED_CANNONS = 32;
/** 一关撒的金币堆数量留足余量（按 GOLD_PICKUP.spacing 估算，最长的关卡也就二十来枚）。 */
const MAX_RENDERED_PICKUPS = 48;

export interface FloatRequest {
  text: string;
  color: string;
  x: number;
  y: number;
  z: number;
  /** 字号档位。 */
  big?: boolean;
}

/**
 * 每关的环境个性：天气种类、窗灯色、雾的远近。
 * 天色本身由 skyForLevel() 给（同时也是 IBL 环境光），这里只补天色之外
 * 那几样能把关卡拉开距离的东西。关卡名承诺的场景，靠这张表兑现。
 */
/**
 * 每关的天气 / 窗灯 / 雾。
 *
 * 雾的近端全部推到了一百米开外：路切成三排、大怪从一百五十米外开始走过来
 * 之后，中远景不再只是气氛，而是玩家做决策要读的信息。雾太近的话，
 * "那一排远处有三只泰坦"这句话玩家根本看不到。
 */
/** 走积木/像素画风的关卡。目前只有第一关。 */
const BRICK_LEVEL = 1;

const LEVEL_FLAVOUR: readonly { weather: WeatherKind; window: number; fogNear: number; fogFar: number }[] = [
  // 一 · 跨海大桥：远海方向飘来的灰
  { weather: 'ash',   window: 0xff9c3a, fogNear: 105, fogFar: 430 },
  // 二 · 高架断层：冷雨，视野最差
  { weather: 'rain',  window: 0xbfd4e0, fogNear: 105, fogFar: 420 },
  // 三 · 尸山阶梯：腐气蒸腾，灰更重
  { weather: 'ash',   window: 0xc8e05a, fogNear: 105, fogFar: 420 },
  // 四 · 猩红黎明：天上下火星
  { weather: 'ember', window: 0xff7a3a, fogNear: 105, fogFar: 420 },
  // 五 · 世界终点：火星 + 最近的雾，世界正在合拢
  { weather: 'ember', window: 0xd8b0ff, fogNear: 105, fogFar: 420 },
];

export class GameView {
  readonly camera = new ChaseCamera();
  /** 本帧要显示的飘字，由 UI 层取走。 */
  readonly floats: FloatRequest[] = [];

  private readonly scene: THREE.Scene;
  /**
   * 每种角色一套材质。
   * 骨骼轴心是 uniform，而每种角色的身材比例不同、轴心也就不同 ——
   * 共用一套材质的话后建的会把先建的轴心覆盖掉，蒙皮整个错位。
   */
  private readonly matSets: CrowdMaterialSet[] = [];
  /**
   * 批次键：普通怪就是 kind 本身，尸群/疾行者拆成 `walker#0`…`runner#2`
   * 几个体型变体各占一个批次。实例按 id 分流，同一片尸潮里高矮胖瘦都有。
   */
  private readonly batches = new Map<string, CrowdBatch>();
  private readonly tints = new Map<EnemyKind, THREE.Color>();
  private soldiers!: CrowdBatch;
  private soldierMatSet!: CrowdMaterialSet;
  /** 当前士兵批次是照哪个武器等级建的模——和 world.squad.weaponLevel 对不上时触发重建。 */
  private soldierWeaponTier = 0;
  /** 每帧重建的"最近 N 个敌人"缓冲。 */
  private readonly visible: Enemy[] = [];
  /** syncSquad() 每帧重建的候选士兵缓冲，避免每帧新分配数组。 */
  private readonly soldierScratch: Unit[] = [];
  /**
   * 方阵人数超过视觉呈现上限时，供 Game/HUD 读取的溢出信息——
   * 世界坐标里"该在哪显示总数标签"的一个锚点，null 表示不需要显示。
   */
  squadOverflow: { total: number; shown: number; x: number; y: number; z: number } | null = null;
  private cannons!: THREE.InstancedMesh;
  private shells!: THREE.InstancedMesh;
  private pickupMesh!: THREE.InstancedMesh;
  private pickupSpin = 0;
  private readonly bars = new HealthBarBatch(64);
  private readonly tracers = new Tracers();
  private readonly sparks = new Particles(900, true);
  private readonly smoke = new Particles(420, false);
  /**
   * 血。单独一套粒子，而且必须是**普通混合**——火花那套是加色的，
   * 血用加色画出来是橙白色的火星，一点血的样子都没有。
   */
  private readonly blood = new Particles(700, false);
  /** 城市废墟里常驻的烟柱/余烬——和战斗特效用的 smoke 分开，不互相挤占配额。 */
  private readonly ambientSmoke = new Particles(220, false);
  private smokeColumns: { x: number; y: number; z: number; ember: boolean; next: number }[] = [];
  /** 天上的装饰性飞龙——不参与战斗，纯氛围点缀，所有关卡都能看到。 */
  private readonly dragon = new Dragon();
  private readonly gold = new GoldBurst();
  /** 大型敌人炸开时抛出的碎块。复用金锭那套弹道，换成暗色不反光的块。 */
  private readonly gibs = new GoldBurst(120, { size: [0.3, 0.26, 0.34], color: 0x5d6b3a, debris: true });
  /** 地面留痕：血迹 / 尸液 / 焦痕。打完一场仗地上要看得出来。 */
  private readonly decals = new Decals(160);
  /** 爆炸的动态点光。常驻场景，只改强度，避免灯数变化触发着色器重编译。 */
  private readonly flashes = new FlashLights(3);
  /** 爆炸冲击波环。 */
  private readonly waves = new Shockwaves(24);
  private readonly ring = new TelegraphRing();
  private readonly lane = new TelegraphLane();
  private readonly reticle = new LightningReticle();
  private readonly lightning = new Lightning();
  /** 中 boss 冲击波预警——独立于主 Boss 的 ring，避免两者同屏时互相抢用。 */
  private readonly midRing = new TelegraphRing();
  /** 矩形/条状预警：半场毒爆、带缺口的火墙、扫射光束共用这一个池。 */
  private readonly areaTg = new AreaTelegraph(6);
  /** 火线走廊的地面指示——枪不自瞄，火力落在哪必须看得见。 */
  private readonly fireLane = new FireLane();
  /** 当前这一关的 Boss 种类——换关时要重建 Boss 的几何体。 */
  private bossKind: BossKind = 'overlord';
  /** 上一帧 Boss 的 z——用来判断这一帧是不是正在高速冲锋，从而甩出拖尾电弧。 */
  private lastBossZ = 0;
  private hasLastBossZ = false;
  private readonly tailA = new THREE.Vector3();
  private readonly tailB = new THREE.Vector3();
  private readonly strikeFrom = new THREE.Vector3();
  private readonly strikeTo = new THREE.Vector3();

  /** 每关重建的静态场景。 */
  private levelRoot = new THREE.Group();
  private lights: SceneLights | null = null;
  private weather: Weather | null = null;
  private gateWalls: { z: number; wall: GateWall; id: number }[] = [];
  private blockMeshes: BlockMesh[] = [];
  private time = 0;

  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly axisY = new THREE.Vector3(0, 1, 0);
  /**
   * 每帧留给"高频小事件"（炮弹落地、击杀、酸液）的镜头抖动配额。
   *
   * punch() 是累加的，衰减只有 2.6/秒。四十门大炮每秒落弹接近三十发，
   * 每发 0.16 就是每秒往里灌 4.6——抖动会被死死顶在上限，整局画面一直在震。
   * 大事件（Boss 重击、打碎方块）不走这条路，照旧满额抖。
   */
  private shakeBudget = 0;
  private readonly rng = new Rng(0xc0ffee);
  /** 太阳相对方阵的固定偏移，保证阴影方向在整局里是一致的。 */
  private readonly sunOffset = new THREE.Vector3(-38, 52, 28);

  constructor(private readonly r: Renderer) {
    this.scene = r.scene;
    this.buildCharacters();
    this.buildProps();
  }

  /**
   * 角色几何体按画质档生成。
   * 骨骼轴心是几何体自带的（buildSkeleton 算出来的那一套），必须交给材质 ——
   * 两边用的不是同一份轴心的话，蒙皮会整个错位。
   */
  private buildCharacters(): void {
    const q: BuildQuality = {
      radialSegments: this.r.quality.radialSegments,
      lengthDetail: this.r.quality.lengthDetail,
      accessory: this.r.quality.accessory,
    };
    const geos: Record<string, (q: BuildQuality) => THREE.BufferGeometry> = {
      walker: zombieGeometry,
      runner: runnerGeometry,
      screamer: screamerGeometry,
      brute: bruteGeometry,
      titan: titanGeometry,
      midboss: midBossGeometry,
      boss: (bq) => bossGeometry(bq, this.bossKind),
      spitter: spitterGeometry,
      leaper: leaperGeometry,
      armored: armoredGeometry,
      swarmling: swarmlingGeometry,
      bomber: bomberGeometry,
    };
    // 尸群/疾行者换成多套体型：0 号沿用原来的键，其余挂在 `kind#n` 上
    for (let v = 1; v < ZOMBIE_VARIANTS; v++) geos[`walker#${v}`] = (bq) => zombieVariantGeometry(bq, v);
    for (let v = 1; v < RUNNER_VARIANTS; v++) geos[`runner#${v}`] = (bq) => runnerVariantGeometry(bq, v);

    const crowdShadows = this.r.quality.crowdShadows && this.r.quality.shadowMap > 0;
    for (const key of Object.keys(geos)) {
      const kind = baseKind(key);
      const geo = geos[key]!(q);
      // Boss/泰坦身上叠一层熔纹自发光——复用已经烘进顶点的磨损数据，让炭黑的
      // 甲壳在棱线处渗出橙红熔光，而不是靠底色本身撑"看起来很凶"
      // 通用材质默认的磨损/脏污颜色是偏暖的浅米色（给普通杂兵用的"露出底色"效果）。
      // Boss/泰坦的底色已经压到近黑，如果不覆盖这两个颜色，默认的浅色磨损会在
      // 大片凸起区域把整个身体洗成一片暖橙——盖过了调色板本身的对比，"发光裂纹"
      // 也会被这片底噪淹没。这里把磨损/脏污都摁进深色，只留 crackGlow 的
      // emissive 脉动作为唯一的亮色来源。
      const set = kind === 'boss'
        ? createCrowdMaterial({
            emissive: 0x180502, roughness: 0.62, metalness: 0.12,
            wearColor: 0x241008, wear: 0.14, grungeColor: 0x0a0503, grunge: 0.22, ao: 0.75,
            crackGlow: true, crackColor: 0xff5a1a, crackStrength: 4.5,
          })
        : kind === 'titan'
          ? createCrowdMaterial({
              emissive: 0x0d0301, roughness: 0.7, metalness: 0.08,
              wearColor: 0x2a1710, wear: 0.12, grungeColor: 0x110907, grunge: 0.2, ao: 0.75,
              crackGlow: true, crackColor: 0xe8481f, crackStrength: 3.4,
            })
          : kind === 'midboss'
            ? createCrowdMaterial({
                emissive: 0x081405, roughness: 0.68, metalness: 0.1,
                wearColor: 0x1a2412, wear: 0.13, grungeColor: 0x0c1208, grunge: 0.2, ao: 0.75,
                // 腐蚀绿而不是火橙——和 titan/boss 的暖色裂纹拉开，一眼认得出
                // 这是另一种怪，不是缩小版 boss
                crackGlow: true, crackColor: 0x9ce85a, crackStrength: 3.6,
              })
            : createCrowdMaterial();
      set.setPivots(geometryPivots(geo));
      this.matSets.push(set);
      // 变体分摊容量：四种尸群各占四分之一多一点，留一点余量防分布不均
      const variants = kind === 'walker' ? ZOMBIE_VARIANTS : kind === 'runner' ? RUNNER_VARIANTS : 1;
      const cap = Math.ceil(CROWD_CAPACITY[kind] / variants) + (variants > 1 ? 24 : 0);
      const batch = new CrowdBatch(geo, set.material, cap, set.depthMaterial);
      // 大体型的怪和 Boss 永远投影，杂兵只在高画质档投
      batch.setCastShadow(this.r.quality.shadowMap > 0 && (crowdShadows || ENEMY_STATS[kind].scale >= 1.5));
      this.batches.set(key, batch);
      this.scene.add(batch.mesh);
      this.tints.set(kind, new THREE.Color(ENEMY_STATS[kind].tint));
    }

    this.buildSoldierBatch(q);
  }

  /**
   * 士兵批次单独拆出来建——武器等级是全队共用的一个值，升级是稀疏的门
   * 事件（不是每帧都变），所以不维护六个等级并存的批次，而是像换画质档
   * 一样整批重建，只是这次只重建士兵这一个批次。
   */
  private buildSoldierBatch(q: BuildQuality): void {
    const soldierGeo = soldierGeometry(q, this.soldierWeaponTier);
    // 士兵单独给一点冷色自发光：五关的雾从暖褐到暗紫都有，纯反射光的话
    // 队伍在远处会被雾洗成和路面一个颜色。这一点点底光不影响近处观感，
    // 但保证了"我的人在哪"这件事在任何一关都读得出来。
    const soldierMat = createCrowdMaterial({
      roughness: 0.7, metalness: 0.12, soldierPose: true,
      emissive: 0x0c1c2c,
    });
    soldierMat.setPivots(geometryPivots(soldierGeo));
    this.soldierMatSet = soldierMat;
    this.soldiers = new CrowdBatch(soldierGeo, soldierMat.material, MAX_RENDERED_SOLDIERS, soldierMat.depthMaterial);
    this.soldiers.setCastShadow(this.r.quality.shadowMap > 0);
    this.scene.add(this.soldiers.mesh);
  }

  /**
   * 换关时只重建 Boss 那一个批次。
   * 五关的 Boss 外形不同，而几何体是在 buildCharacters() 里一次性建好的——
   * 不重建的话，第五关会顶着第一关那只的模型出场。
   */
  private rebuildBoss(kind: BossKind): void {
    if (kind === this.bossKind && this.batches.has('boss')) return;
    this.bossKind = kind;
    const old = this.batches.get('boss');
    if (old) {
      this.scene.remove(old.mesh);
      old.dispose();
    }
    const q: BuildQuality = {
      radialSegments: this.r.quality.radialSegments,
      lengthDetail: this.r.quality.lengthDetail,
      accessory: this.r.quality.accessory,
    };
    const geo = bossGeometry(q, kind);
    const set = createCrowdMaterial({
      emissive: 0x180502, roughness: 0.62, metalness: 0.12,
      wearColor: 0x241008, wear: 0.14, grungeColor: 0x0a0503, grunge: 0.22, ao: 0.75,
      crackGlow: true, crackColor: BOSS_CRACK[kind].color, crackStrength: BOSS_CRACK[kind].strength,
    });
    set.setPivots(geometryPivots(geo));
    this.matSets.push(set);
    const batch = new CrowdBatch(geo, set.material, CROWD_CAPACITY.boss, set.depthMaterial);
    batch.setCastShadow(this.r.quality.shadowMap > 0);
    this.scene.add(batch.mesh);
    this.batches.set('boss', batch);
  }

  /** 武器等级变化（门事件触发）时只重建士兵批次，不动其它任何东西。 */
  private rebuildSoldiers(tier: number): void {
    this.soldierWeaponTier = tier;
    this.scene.remove(this.soldiers.mesh);
    this.soldiers.dispose();
    const q: BuildQuality = {
      radialSegments: this.r.quality.radialSegments,
      lengthDetail: this.r.quality.lengthDetail,
      accessory: this.r.quality.accessory,
    };
    this.buildSoldierBatch(q);
  }

  private buildProps(): void {

    this.cannons = new THREE.InstancedMesh(
      cannonGeometry(),
      industrial(PRESET.machinery()),
      MAX_RENDERED_CANNONS,
    );
    this.cannons.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cannons.frustumCulled = false;
    this.cannons.count = 0;
    this.cannons.castShadow = this.r.quality.shadowMap > 0;
    this.cannons.receiveShadow = true;
    this.scene.add(this.cannons);

    this.shells = new THREE.InstancedMesh(
      ensureSurf(shellGeometry()),
      industrial({ color: 0xffffff, roughness: 0.42, metalness: 0.55, wear: 0.3, grunge: 0.2, triScale: 3 }),
      64,
    );
    this.shells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shells.frustumCulled = false;
    this.shells.count = 0;
    this.scene.add(this.shells);

    this.pickupMesh = new THREE.InstancedMesh(
      coinPileGeometry(),
      industrial({ ...PRESET.gold(), color: 0xffffff }),
      MAX_RENDERED_PICKUPS,
    );
    this.pickupMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pickupMesh.frustumCulled = false;
    this.pickupMesh.count = 0;
    this.pickupMesh.castShadow = this.r.quality.shadowMap > 0;
    this.scene.add(this.pickupMesh);

    this.scene.add(
      this.bars.mesh, this.tracers.mesh, this.sparks.mesh, this.smoke.mesh, this.blood.mesh, this.gold.mesh,
      this.ring.mesh, this.lane.mesh, this.reticle.mesh, this.lightning.group, this.midRing.mesh,
      this.ambientSmoke.mesh, this.dragon.group,
      this.decals.mesh, this.waves.mesh, this.flashes.group, this.gibs.mesh, this.areaTg.mesh,
      this.fireLane.mesh,
    );
  }

  /**
   * 换画质档时重建所有动态资产。
   * 角色几何体是按档生成的（分段数和配件档不同），不重建的话换档只会改光影
   * 而角色面数原封不动。
   */
  rebuild(): void {
    for (const b of this.batches.values()) {
      this.scene.remove(b.mesh);
      b.dispose();
    }
    this.batches.clear();
    this.matSets.length = 0;
    this.scene.remove(this.soldiers.mesh);
    this.soldiers.dispose();
    this.scene.remove(this.cannons, this.shells, this.pickupMesh);
    this.cannons.geometry.dispose();
    (this.cannons.material as THREE.Material).dispose();
    this.shells.geometry.dispose();
    (this.shells.material as THREE.Material).dispose();
    this.pickupMesh.geometry.dispose();
    (this.pickupMesh.material as THREE.Material).dispose();
    this.buildCharacters();
    this.buildProps();
  }

  /** 为一关搭出静态场景。切关时调用。 */
  buildLevel(world: World): void {
    this.disposeLevel();
    const root = new THREE.Group();
    const bossBeat = world.level.beats.find((b) => b.t === 'boss');
    if (bossBeat && bossBeat.t === 'boss') this.rebuildBoss(bossBeat.kind);
    // 第一关是积木/像素关：整套环境和后期都换一条路，别的关照旧。
    const brickLevel = world.level.id === BRICK_LEVEL;
    this.r.setPixelStyle(brickLevel);
    const theme: SkyTheme = brickLevel ? BRICK_SKY : skyForLevel(world.level.id);
    const flavour = LEVEL_FLAVOUR[Math.max(0, Math.min(LEVEL_FLAVOUR.length - 1, world.level.id - 1))]!;
    const q = this.r.quality;

    root.add(createSky(theme));
    // 环境光就是这片天空本身 —— 金属反射到的和玩家看到的是同一个天色
    this.r.setEnvironment(createSkyEnvironment(this.r.renderer, theme), 0.7);

    const lights = createLights(theme, q.shadowMap);
    for (const l of lights.all) root.add(l);
    this.lights = lights;
    // 积木关的雾要往远推：这套画风的看点就是远处那片彩色积木城，
    // 照写实关 105 米就起雾的话，城市全糊在一片白里
    this.scene.fog = new THREE.Fog(theme.fog, brickLevel ? 260 : flavour.fogNear, brickLevel ? 900 : flavour.fogFar);

    const rng = new Rng(0x1234 + world.level.id * 977);
    if (brickLevel) {
      root.add(createBrickBridge(world.totalLength, rng, q.envDetail));
      root.add(createBrickCity(world.totalLength, rng, q.envDetail));
      root.add(createBrickProps(world.totalLength, rng, q.envDetail));
    } else {
      root.add(createBridge(world.totalLength, rng, q.envDetail));
      root.add(createCity(world.totalLength, rng, q.envDetail, flavour.window));
      // 路肩陈设：每关一套配方，用近景把五关的差别坐实（远景交给天色和天气）
      root.add(createProps(world.totalLength, rng, propsForLevel(world.level.id), q.envDetail));
    }

    // 积木关不下灰也不下火星：飘着的颗粒和像素化的颗粒会打架，
    // 屏幕上分不清哪些是天气哪些是像素块
    if (flavour.weather !== 'none' && !brickLevel) {
      this.weather = new Weather(flavour.weather, q.envDetail);
      root.add(this.weather.mesh);
    }

    for (const g of world.gates) {
      const wall = new GateWall(g.z, g.left, g.right);
      root.add(wall.group);
      this.gateWalls.push({ z: g.z, wall, id: g.id });
    }
    for (const b of world.blocks) {
      const mesh = new BlockMesh(b, brickLevel);
      root.add(mesh.group);
      this.blockMeshes.push(mesh);
    }

    this.levelRoot = root;
    this.scene.add(root);
    this.camera.snap(world.squad.x, world.squad.z);

    // 末日城市里常驻几根烟柱——废墟还在闷烧，不只是配色暗了而已。
    // 积木关不要：那是一座干干净净的塑料城。
    this.smokeColumns = [];
    if (brickLevel) return;
    const colRng = new Rng(0x9e3 + world.level.id * 131);
    for (let i = 0; i < 6; i++) {
      const side = colRng.next() < 0.5 ? -1 : 1;
      this.smokeColumns.push({
        x: side * colRng.range(20, 55),
        y: colRng.range(-8, 16),
        z: colRng.range(20, world.totalLength - 20),
        ember: i % 3 === 0,
        next: colRng.range(0, 0.3),
      });
    }
  }

  private disposeLevel(): void {
    this.scene.remove(this.levelRoot);
    this.levelRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
    for (const b of this.blockMeshes) b.dispose();
    this.gateWalls = [];
    this.blockMeshes = [];
    this.levelRoot = new THREE.Group();
    // 地面留痕和爆闪不跟着换关：上一关的血迹留到下一关是穿帮
    this.decals.clear();
    this.flashes.reset();
    // weather 的网格挂在 levelRoot 下，上面的 traverse 已经 dispose 过几何和材质了
    this.weather = null;
  }

  /**
   * 开发期：把镜头钉在某个目标近处，用来逐个检查资产。
   * null 表示恢复正常的追尾镜头。
   */
  inspect: { target: 'squad' | 'boss' | 'enemy' | 'cannon'; dist: number; height: number; yaw: number } | null = null;

  /** 开发期：这一帧屏幕上有多少发曳光弹在飞。 */
  get tracerCount(): number {
    return this.tracers.mesh.count;
  }

  private applyInspect(world: World): boolean {
    const ins = this.inspect;
    if (!ins) return false;
    let cx = world.squad.x;
    // 头部高度而不是躯干中心——现在角色有五官了，检查资产多半是想看脸
    let cy = 1.6;
    let cz = world.squad.z;
    if (ins.target === 'boss' && world.boss.enemy) {
      cx = world.boss.enemy.x;
      // 五只 Boss 的建模身高各不相同（2.75~3.5），再乘一层实例 scale。
      // 写死 2.9 的话，高个子那几只镜头会钉在胸口、直接埋进身体里。
      cy = world.boss.enemy.scale * BOSS_HEIGHT[this.bossKind] * 0.9;
      cz = world.boss.enemy.z;
    } else if (ins.target === 'cannon') {
      const c = world.squad.units.find((u) => u.alive && u.isCannon);
      if (c) { cx = c.x; cy = 0.7; cz = c.z; }
    } else if (ins.target === 'enemy') {
      const e = world.enemies.list.find((x) => x.alive && !x.scripted);
      if (e) { cx = e.x; cy = e.scale * 1.5; cz = e.z; }
    }
    const cam = this.r.camera;
    cam.position.set(cx + Math.sin(ins.yaw) * ins.dist, cy + ins.height, cz + Math.cos(ins.yaw) * ins.dist);
    cam.lookAt(cx, cy, cz);
    return true;
  }

  update(world: World, dt: number, events: readonly SimEvent[]): void {
    this.time += dt;
    this.floats.length = 0;
    for (const m of this.matSets) m.setTime(this.time);
    this.soldierMatSet.setTime(this.time);

    if (world.squad.weaponLevel !== this.soldierWeaponTier) this.rebuildSoldiers(world.squad.weaponLevel);

    this.syncEnemies(world);
    this.syncSquad(world);
    // 火线：跟着方阵，宽度就是判定用的走廊宽度，一米不差
    this.fireLane.update(
      world.squad.x, world.squad.z,
      fireCorridor(world.squad),
      world.squad.weapon.falloffStart * FIRE_LANE_REACH,
      world.squad.weapon.tracer,
    );
    this.syncShells(world);
    this.syncBoss(world, dt);
    this.syncMidBoss(world);
    this.syncPickups(world, dt);

    for (const g of this.gateWalls) g.wall.update(dt);
    for (const gate of world.gates) {
      if (!gate.taken) continue;
      const gw = this.gateWalls.find((w) => w.id === gate.id);
      if (gw) gw.wall.fade(Math.pow(0.06, dt));
    }
    for (const b of this.blockMeshes) b.update();

    // 每帧重置小事件的抖动配额
    this.shakeBudget = 0.11;
    this.handleEvents(events, world);

    this.tracers.update(dt);
    // 子弹这一帧刚好飞抵目标的，在落点补一粒极小的火花——子弹是真的"打中"了
    // 什么东西，而不是瞬间出现瞬间消失
    for (const hit of this.tracers.impacts) {
      this.sparks.burst(hit.x, hit.y, hit.z, {
        count: 1, color: hit.color,
        speed: [0.6, 1.8], size: [0.24, 0.42], life: [0.04, 0.08], grow: -1.8,
      });
    }
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.blood.update(dt);
    this.gold.update(dt);
    this.gibs.update(dt);
    this.lightning.update(dt);
    this.decals.update(dt);
    this.waves.update(dt);
    this.flashes.update(dt);
    this.updateAmbientSmoke(dt);
    // 天气盒跟着方阵走，所以实例数恒定，不用按赛道长度铺满
    this.weather?.update(dt, world.squad.x * 0.4, world.squad.z + 20);
    this.dragon.update(dt, world.squad.x * 0.3, world.squad.z + 90);

    if (!this.applyInspect(world)) {
      this.camera.update(this.r.camera, dt, world.squad.x, world.squad.z, world.squad.depth, world.boss.active);
    }
    this.followSun(world);
  }

  /** 城市废墟里常驻的烟柱：每根柱子按各自的节奏冒一缕烟，偶尔夹一点余烬。 */
  private updateAmbientSmoke(dt: number): void {
    for (const c of this.smokeColumns) {
      c.next -= dt;
      if (c.next > 0) continue;
      c.next = 0.18 + this.rng.next() * 0.14;
      this.ambientSmoke.burst(c.x, c.y, c.z, {
        count: 1, color: 0x4a463e,
        speed: [0.3, 0.8], size: [1.6, 2.8], life: [2.2, 3.4], grow: 1.1, drag: 0.6, lift: 1.2,
      });
      if (c.ember) {
        this.sparks.burst(c.x, c.y - 1, c.z, {
          count: 1, color: 0xff7a2e,
          speed: [0.2, 0.6], size: [0.3, 0.5], life: [0.5, 0.9], grow: -0.3, lift: 0.6,
        });
      }
    }
    this.ambientSmoke.update(dt);
  }

  /**
   * 让阴影相机跟着方阵走。
   * 方向光的阴影相机是个固定大小的正交盒，不跟着走的话方阵一往前推就出了盒子，
   * 阴影会整片消失。
   */
  private followSun(world: World): void {
    const sun = this.lights?.sun;
    if (!sun || !sun.castShadow) return;
    const cx = world.squad.x * 0.4;
    const cz = world.squad.z + 6;
    sun.target.position.set(cx, 0, cz);
    sun.target.updateMatrixWorld();
    sun.position.set(cx + this.sunOffset.x, this.sunOffset.y, cz + this.sunOffset.z);
    sun.shadow.camera.updateProjectionMatrix();
  }

  // ── 同步 ────────────────────────────────────────────────────

  private syncEnemies(world: World): void {
    for (const b of this.batches.values()) b.begin();
    this.bars.begin();

    // 只画离方阵最近的一批。远处的那些在雾里只有几个像素，
    // 省下的预算全部留给近处角色的精度。
    const vis = this.visible;
    vis.length = 0;
    for (const e of world.enemies.list) {
      if (e.scripted) continue; // Boss 单独处理
      if (!e.alive && e.dying <= 0) continue;
      vis.push(e);
    }
    const budget = this.r.quality.enemyInstances;
    if (vis.length > budget) {
      const sz = world.squad.z;
      // 大块头永远画，不管它离得多远。
      //
      // 单纯按距离截断的话，脚下一堆杂兵就会把一百多米外那几只泰坦挤掉——
      // 而"远处有个大东西正在慢慢走过来"恰恰是这个游戏最重要的一条预告：
      // 玩家要靠它提前决定走哪一排、要不要现在把炮攒着。杂兵在雾里少几个
      // 没人看得出来，少一只泰坦是致命的信息缺失。
      vis.sort((a, b) => {
        const ba = ENEMY_STATS[a.kind].scale >= 1.5 ? 1 : 0;
        const bb = ENEMY_STATS[b.kind].scale >= 1.5 ? 1 : 0;
        if (ba !== bb) return bb - ba;
        return Math.abs(a.z - sz) - Math.abs(b.z - sz);
      });
      vis.length = budget;
    }

    for (const e of vis) {
      const batch = this.batches.get(batchKey(e));
      if (batch) this.addEnemy(batch, e, world.squad.z);
    }

    for (const b of this.batches.values()) b.end();
  }

  private addEnemy(batch: CrowdBatch, e: Enemy, squadZ: number): void {
    const st = ENEMY_STATS[e.kind];
    const death = e.alive ? 0 : 1 - Math.max(0, e.dying) / DYING_TIME;
    // 僵尸朝 -z 走，几何体本身面朝 +z，所以转 180°
    const yaw = Math.PI + ((e.id % 7) - 3) * 0.045;
    // 贴到方阵跟前的会切成攻击姿态
    // 三档姿态：走 → 挥手 → 啃食。咬中人的那一下会切到 2，
    // 保持大半秒再回落，读起来是"扑上去啃一口、直起身、再扑"
    const attacking = e.alive && e.z - squadZ < 2.6 + e.scale * 0.6;
    const state = e.alive && e.eating > 0 ? 2 : attacking ? 1 : 0;
    // 跳跃者滞空时抬到抛物线的高度上；其余怪 airY 恒为 0
    batch.add(
      e.x, e.airY ?? 0, e.z,
      yaw,
      e.scale,
      e.phase,
      0,
      state,
      death,
      flashAmount(e),
      jitterTint(this.tints.get(e.kind)!, e.id, ENEMY_JITTER[e.kind]),
    );
    if (st.showHealthBar && e.alive && e.hp < e.maxHp) {
      this.bars.add(e.x, (e.airY ?? 0) + 1.95 * e.scale, e.z, e.hp / e.maxHp, 1.5 + e.scale * 0.35);
    }
  }

  private syncSquad(world: World): void {
    const squad = world.squad;
    this.soldiers.begin();
    let cannonCount = 0;
    // 有敌人逼近时切成射击姿态
    const threat = world.enemies.list.some((e) => e.alive && e.z - squad.z < 30);

    // 大炮走独立的上限计数，和步兵分开
    for (const u of squad.units) {
      if (!u.alive || !u.isCannon) continue;
      if (cannonCount >= this.r.quality.cannonInstances) continue;
      this.v.set(u.x, 0, u.z);
      this.q.setFromAxisAngle(this.axisY, 0);
      this.sc.set(1, 1, 1);
      this.m.compose(this.v, this.q, this.sc);
      this.cannons.setMatrixAt(cannonCount, this.m);
      cannonCount++;
    }
    this.cannons.count = cannonCount;
    if (this.cannons.count > 0) this.cannons.instanceMatrix.needsUpdate = true;

    // 步兵：数量一多，18 米宽的桥根本摆不下，视觉呈现上限比性能上限更保守。
    // 超出的不是随便扔掉——优先保留 row 最小的最前排（前排本来就是主要
    // 火力，后排还有火力衰减，视觉上也最合理），超出的部分改用头顶的
    // 总数标签表示（见 squadOverflow，由 Game/HUD 消费）。
    const scratch = this.soldierScratch;
    scratch.length = 0;
    for (const u of squad.units) {
      if (u.alive && !u.isCannon) scratch.push(u);
    }
    const totalSoldiers = scratch.length;
    const cap = Math.min(this.r.quality.soldierInstances, this.r.quality.soldierVisualCap);
    if (totalSoldiers > cap) {
      // 光按 row 排序切前 cap 个：人一多，队形的一整排本身就能超过 cap
      // （比如 236 人时一排能有二十几个），稳定排序又保留了同排内原始的
      // 从左到右顺序——截断结果变成"第一排最左边连续 cap 个人"，画出来是
      // 一条横线，还正好方便 Boss 的 AoE 一圈全部罩住。改成分层取样：挑
      // 几排、每排横向匀开取样，凑出一个有宽度也有纵深的小方阵。
      scratch.sort((a, b) => (a.row === b.row ? a.col - b.col : a.row - b.row));
      const dispCols = Math.max(1, Math.ceil(Math.sqrt(cap * 1.4)));
      let w = 0;
      let i = 0;
      while (i < scratch.length && w < cap) {
        let j = i;
        const row = scratch[i]!.row;
        while (j < scratch.length && scratch[j]!.row === row) j++;
        const groupLen = j - i;
        const take = Math.min(dispCols, cap - w, groupLen);
        if (groupLen <= take) {
          for (let k = i; k < j; k++) scratch[w++] = scratch[k]!;
        } else {
          // 行内按列等间距抽样，保住这一排原本的宽度感，而不是从一头连续切一段
          for (let k = 0; k < take; k++) {
            const idx = i + Math.min(groupLen - 1, Math.round((k + 0.5) * groupLen / take));
            scratch[w++] = scratch[idx]!;
          }
        }
        i = j;
      }
      scratch.length = w;
    }

    for (const u of scratch) {
      // 前几排整齐，越往后越有点自然的错落
      const posJitter = ((u.id * 2654435761) % 1000) / 1000 - 0.5;
      this.soldiers.add(
        u.x + posJitter * 0.06, 0, u.z,
        0,
        1,
        u.id * 0.7,
        threat ? 5.5 : 7.5,
        threat ? 1 : 0,
        0,
        u.flash > 0 ? u.flash / 0.12 : 0,
        jitterTint(WHITE, u.id, SOLDIER_JITTER),
      );
    }
    this.soldiers.end();

    const shown = scratch.length;
    if (totalSoldiers > shown) {
      // 标签挂在"渲染出来的那块方阵"正后方、头顶高度——紧贴着看得见的
      // 最后一排，读起来像是"后面还有一串延伸出画面的队伍"
      const shownRows = Math.max(1, Math.ceil(shown / Math.max(1, squad.cols)));
      this.squadOverflow = {
        total: totalSoldiers,
        shown,
        x: squad.x,
        y: 2.3,
        z: squad.z - shownRows * SLOT_SPACING_Z,
      };
    } else {
      this.squadOverflow = null;
    }
  }

  private syncShells(world: World): void {
    let n = 0;
    for (const s of world.combat.shells) {
      if (n >= 64) break;
      const t = Math.min(1, s.t);
      const x = s.x + (s.tx - s.x) * t;
      const z = s.z + (s.tz - s.z) * t;
      const y = s.y + s.arc * 4 * t * (1 - t);
      this.v.set(x, y, z);
      this.q.setFromAxisAngle(this.axisY, 0);
      this.sc.set(1, 1, 1);
      this.m.compose(this.v, this.q, this.sc);
      this.shells.setMatrixAt(n, this.m);
      n++;
    }
    this.shells.count = n;
    if (n > 0) this.shells.instanceMatrix.needsUpdate = true;
  }

  /** 路边的金币堆：慢慢自转 + 轻微起伏，捡到的（!alive）直接不再分配实例槽位，当场消失。 */
  /** 高频小事件的抖动：从每帧配额里扣，扣完这一帧就不再抖。 */
  private softPunch(amount: number): void {
    const give = Math.min(amount, this.shakeBudget);
    if (give <= 0) return;
    this.shakeBudget -= give;
    this.camera.punch(give);
  }

  private syncPickups(world: World, dt: number): void {
    this.pickupSpin += dt;
    let n = 0;
    for (const p of world.pickups) {
      if (!p.alive) continue;
      if (n >= MAX_RENDERED_PICKUPS) break;
      const y = 0.4 + Math.sin(this.pickupSpin * 2.2 + p.id) * 0.06;
      this.v.set(p.x, y, p.z);
      this.q.setFromAxisAngle(this.axisY, this.pickupSpin * 1.4 + p.id);
      this.sc.set(1, 1, 1);
      this.m.compose(this.v, this.q, this.sc);
      this.pickupMesh.setMatrixAt(n, this.m);
      n++;
    }
    this.pickupMesh.count = n;
    if (n > 0) this.pickupMesh.instanceMatrix.needsUpdate = true;
  }

  private syncBoss(world: World, dt: number): void {
    const batch = this.batches.get('boss')!;
    batch.begin();
    const b = world.boss.enemy;
    if (b && (b.alive || b.dying > 0)) {
      const death = b.alive ? 0 : 1 - Math.max(0, b.dying) / DYING_TIME;
      batch.add(
        b.x, 0, b.z,
        Math.PI,
        b.scale,
        b.phase,
        0,
        0,
        death,
        flashAmount(b),
        this.tints.get('boss')!,
      );
    }
    batch.end();

    // 技能预警：火/电/雷三种形状和配色，红圈已经拆开成三种能一眼分辨的语言
    const tg = world.boss.telegraph;
    if (tg && tg.kind === 'slam') {
      this.ring.show(tg.x, tg.z, tg.radius, tg.t, 0xff6a12);
      this.lane.hide();
      this.reticle.hide();
      // 熔岩践踏预警期间往外冒火星，光一个圈不够"火"
      if (this.rng.next() < 0.5) {
        const rx = tg.x + (this.rng.next() - 0.5) * tg.radius * 1.4;
        const rz = tg.z + (this.rng.next() - 0.5) * tg.radius * 1.4;
        this.sparks.burst(rx, 0.1, rz, {
          count: 1, color: 0xff9433, speed: [0.5, 1.4], size: [0.3, 0.55], life: [0.3, 0.55], grow: -0.5, lift: 3.2, drag: 0.5,
        });
      }
    } else if (tg && tg.kind === 'charge' && b) {
      this.lane.show(tg.x, b.z, world.squad.z - 6, tg.radius, tg.t, 0x5fd0ff);
      this.ring.hide();
      this.reticle.hide();
    } else if (tg && tg.kind === 'lightning') {
      this.reticle.show(tg.x, tg.z, tg.radius, tg.t, 0x8fe0ff);
      this.ring.hide();
      this.lane.hide();
    } else {
      this.ring.hide();
      this.lane.hide();
      this.reticle.hide();
    }

    // 矩形/条状预警：半场毒爆、带缺口的火墙、扫射光束
    this.areaTg.begin();
    // 空袭的地面预警：一整块盖住整条弹幕走廊的橙红区域。
    // 一发能抹掉半条街，落地前必须先把"要炸哪儿"摊在地上给玩家看清楚。
    const sz = world.strikeZone;
    if (sz) this.areaTg.push(sz.x, sz.z, sz.halfW * 2, sz.halfZ * 2, sz.t, 0xff5a1a);
    if (tg && tg.kind === 'quake' && tg.x0 !== undefined && tg.x1 !== undefined) {
      this.areaTg.push((tg.x0 + tg.x1) / 2, tg.z, tg.x1 - tg.x0, (tg.halfZ ?? 12) * 2, tg.t, 0x9ce85a);
      if (this.rng.next() < 0.6) {
        const rx = tg.x0 + this.rng.next() * (tg.x1 - tg.x0);
        const rz = tg.z + (this.rng.next() - 0.5) * (tg.halfZ ?? 12) * 2;
        this.sparks.burst(rx, 0.1, rz, {
          count: 1, color: 0xaef05a, speed: [0.4, 1.2], size: [0.3, 0.6], life: [0.3, 0.6], grow: -0.4, lift: 2.6, drag: 0.6,
        });
      }
    } else if (tg && tg.kind === 'breath' && tg.gapX !== undefined && tg.gapW !== undefined) {
      // 画成"缺口两侧的两条火墙"——安全的那一段刻意留空，一眼看得出往哪儿钻
      const halfZ = (tg.halfZ ?? 3) * 2;
      const leftW = (tg.gapX - tg.gapW) - -ROAD_HALF;
      const rightW = ROAD_HALF - (tg.gapX + tg.gapW);
      if (leftW > 0.2) this.areaTg.push(-ROAD_HALF + leftW / 2, tg.z, leftW, halfZ, tg.t, 0xff7a2a);
      if (rightW > 0.2) this.areaTg.push(ROAD_HALF - rightW / 2, tg.z, rightW, halfZ, tg.t, 0xff7a2a);
    } else if (tg && tg.kind === 'beam' && tg.angle !== undefined) {
      // 从 Boss 脚下甩出去的一条长带，随读条一路扫过整条路
      const len = 90;
      const a = tg.angle;
      this.areaTg.push(
        tg.x + Math.sin(a) * (len / 2),
        tg.z - Math.cos(a) * (len / 2),
        tg.radius * 2, len, tg.t, 0xff3a44, a,
      );
    }
    this.areaTg.end();

    // 冲锋没有独立的"正在冲锋"事件——用这一帧 z 方向的瞬时速度反推是不是在
    // 高速冲锋，是的话身后随手甩几道电弧拖尾，读起来像雷霆附体
    if (b && b.alive && this.hasLastBossZ && dt > 0) {
      const vz = (this.lastBossZ - b.z) / dt;
      if (vz > 15 && this.rng.next() < 0.55) {
        const bx = b.x + (this.rng.next() - 0.5) * 2;
        const bz = b.z + 1.4 + this.rng.next() * 1.6;
        this.tailA.set(bx, 0.3 + this.rng.next() * 0.8, bz);
        this.tailB.set(bx + (this.rng.next() - 0.5) * 2.6, 0.1 + this.rng.next() * 1.8, bz + (this.rng.next() - 0.5) * 2.6);
        this.lightning.spawn(this.tailA, this.tailB, { segments: 4, jitter: 0.5, thickness: 0.06, life: 0.12, color: 0x6fe0ff });
      }
    }
    if (b) {
      this.lastBossZ = b.z;
      this.hasLastBossZ = true;
    }
  }

  /**
   * 中 boss 走的是普通敌人 AI（scripted: false），本体已经在 syncEnemies()
   * 里当成一只 midboss 敌人画过了——这里只管它那一圈冲击波预警。
   */
  private syncMidBoss(world: World): void {
    const tg = world.midBoss.telegraph;
    if (tg) this.midRing.show(tg.x, tg.z, tg.radius, tg.t, 0x8fe85a);
    else this.midRing.hide();
  }

  // ── 事件 → 特效 ─────────────────────────────────────────────

  private handleEvents(events: readonly SimEvent[], world: World): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'shot': {
          // amount 带的是曳光弹的视觉档（见 WEAPON_TIERS.beam）
          const beam = ev.amount ?? 0;
          const col = ev.color ?? 0xffd166;
          this.tracers.spawn(ev.x!, ev.y!, ev.z!, ev.tx!, ev.ty!, ev.tz!, col, beam);
          // 枪口焰也跟着档位长大：高档武器每一发都该把周围照亮一下
          if (this.rng.next() < 0.22 + beam * 0.14) {
            this.sparks.burst(ev.x!, ev.y!, ev.z! + 0.55, {
              count: 1 + beam, color: col,
              speed: [0.4, 1.4 + beam * 0.8], size: [0.3 + beam * 0.16, 0.55 + beam * 0.3],
              life: [0.05, 0.09 + beam * 0.03], grow: -1.6,
            });
          }
          // 落点火花：镜头是顺着弹道往前看的，弹道本身被压成一个小点，
          // 真正看得见"这一枪有多重"的地方是**打在谁身上**。档位越高，
          // 命中处炸开的火花越大。
          if (beam >= 1 && this.rng.next() < 0.18 + beam * 0.16) {
            this.sparks.burst(ev.tx!, ev.ty!, ev.tz!, {
              count: beam, color: col, color2: 0xffffff,
              speed: [1.2 + beam, 3 + beam * 2.2], size: [0.3 + beam * 0.14, 0.6 + beam * 0.34],
              life: [0.07, 0.14 + beam * 0.03], grow: -0.8, drag: 3,
            });
          }
          // 顶级武器：每一发都点一盏灯。这是"我换枪了"最直接的一层反馈
          if (beam >= 3 && this.rng.next() < 0.3) {
            this.flashes.flash(ev.x!, ev.y! + 0.4, ev.z! + 1.0, col, 30 + beam * 14, 0.07);
          }
          break;
        }
        case 'cannonFire': {
          this.sparks.burst(ev.x!, ev.y! + 0.7, ev.z! + 1.1, {
            count: 8, color: 0xffb03a, speed: [2, 7], size: [0.5, 1.0], life: [0.1, 0.24], grow: -1.5, drag: 6,
          });
          this.smoke.burst(ev.x!, ev.y! + 0.7, ev.z! + 1.0, {
            count: 4, color: 0x9c9c9c, color2: 0x4a4744, speed: [0.6, 2.2], size: [0.7, 1.3],
            life: [0.4, 0.8], grow: 2.2, drag: 2.4, lift: 1.2, fadeIn: 0.15,
          });
          this.flashes.flash(ev.x!, ev.y! + 0.9, ev.z! + 1.2, 0xffb257, 46, 0.11);
          break;
        }
        case 'shellImpact': {
          // 火星从亮黄烧到暗红，并且沿飞出方向拖成条
          this.sparks.burst(ev.x!, 0.5, ev.z!, {
            count: 26, color: 0xfff0b0, color2: 0xc42a08, speed: [4, 15], size: [0.6, 1.5],
            life: [0.15, 0.42], grow: 1.4, drag: 3.5, stretch: 2.2,
          });
          this.smoke.burst(ev.x!, 0.6, ev.z!, {
            count: 10, color: 0x8b857e, color2: 0x3a3733, speed: [1.5, 5], size: [1.0, 2.2],
            life: [0.5, 1.1], grow: 3.2, drag: 2, lift: 1.6, fadeIn: 0.2,
          });
          this.waves.spawn(ev.x!, ev.z!, 0.6, (ev.radius ?? 4.6) * 1.5, 0xffb257, 0.42);
          this.flashes.flash(ev.x!, 1.4, ev.z!, 0xff9838, 90, 0.22);
          this.decals.add('scorch', ev.x!, ev.z!, (ev.radius ?? 4.6) * 1.1, 0.34);
          this.softPunch(0.09);
          break;
        }
        case 'kill': {
          const kind = ev.kind ?? 'walker';
          const big = kind === 'brute' || kind === 'titan' || kind === 'midboss';
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: big ? 16 : 4, color: 0xb6e05a, color2: 0x2f4a10,
            speed: [1.5, big ? 8 : 4], size: [0.3, big ? 1.0 : 0.5], life: [0.15, 0.4],
            grow: -0.4, gravity: 6, drag: 1.5, stretch: big ? 1.4 : 0.6,
          });
          // 尸液留痕：小怪按概率、大怪必留，否则一片尸山之后地面还是干净的
          if (big || this.rng.next() < 0.16) {
            this.decals.add('ichor', ev.x!, ev.z!, big ? 3.4 : 1.5, big ? 0.8 : 0.55);
          }
          if (big) {
            this.gold.burst(ev.x!, 0.4, ev.z!, 4);
            this.gibs.burst(ev.x!, 0.9, ev.z!, 7);
            this.softPunch(0.05);
            this.waves.spawn(ev.x!, ev.z!, 0.3, 3.2, 0x8fbf4a, 0.34, 0.7);
          } else if (this.rng.next() < 0.06) {
            this.gold.burst(ev.x!, 0.3, ev.z!, 1);
          }
          break;
        }
        case 'hitBig': {
          if (this.floats.length < 14) {
            this.floats.push({ text: String(ev.amount ?? 0), color: '#ffe27a', x: ev.x!, y: ev.y! + 0.6, z: ev.z! });
          }
          break;
        }
        case 'impaled': {
          // 被倒刺串死：一大蓬血朝镜头喷，加一块地面血迹和一声金属穿刺。
          // 撞墙的代价必须看得见——这是玩家唯一一次"自己走上去送人头"。
          this.blood.burst(ev.x!, ev.y!, ev.z!, {
            count: 22, color: 0xd42a2a, color2: 0x4d0606,
            speed: [3, 10], size: [0.24, 0.6], life: [0.3, 0.65],
            gravity: 12, drag: 1.1, stretch: 2.6,
          });
          this.sparks.burst(ev.x!, ev.y! + 0.3, ev.z!, {
            count: 4, color: 0xffe0a0, speed: [2, 6], size: [0.2, 0.4], life: [0.08, 0.16], grow: -1.4,
          });
          this.decals.add('blood', ev.x!, ev.z! + 0.6, 1.6, 0.7);
          break;
        }
        case 'weaponPickup': {
          // 打穿军械门：门里那把枪飞出来落进队伍里。
          // 这是全场最值钱的一次奖励，要有和空袭一个量级的仪式感。
          this.floats.push({ text: `获得 ${ev.text ?? '新武器'}`, color: '#ffd45a', x: ev.x!, y: 4.4, z: ev.z!, big: true });
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: 48, color: 0xfff0b0, color2: 0xff9a1f, speed: [4, 16], size: [0.6, 1.6],
            life: [0.4, 0.9], grow: 0.6, drag: 2.2, stretch: 2.0,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.2, 14, 0xffd45a, 0.7, 1.1);
          this.flashes.flash(ev.x!, 2.6, ev.z!, 0xffd45a, 260, 0.4);
          this.gold.burst(ev.x!, 1.6, ev.z!, 16);
          this.camera.punch(0.3);
          break;
        }
        case 'blockSmashed': {
          // 硬撞穿：碎块 + 一圈冲击波 + 一次强震。没有金币飘字——
          // 这条路是拿命换的，不是打下来的
          this.gibs.burst(ev.x!, 1.4, ev.z!, 14);
          this.waves.spawn(ev.x!, ev.z!, 9, 3, 0xc9d2dc, 0.9, 0.5);
          this.smoke.burst(ev.x!, 1.6, ev.z!, {
            count: 8, color: 0x9aa0a8, color2: 0x40454b, speed: [1.5, 5], size: [0.9, 1.8],
            life: [0.5, 1.0], grow: 2.2, drag: 2, lift: 1.2, fadeIn: 0.1,
          });
          this.softPunch(0.14);
          break;
        }
        case 'bite': {
          // 咬中的一口血。喷得又快又碎，还在地上留一小摊——
          // 僵尸贴到脸上这件事必须有代价感，不能只是血条在掉。
          const big = ev.amount ?? 1;
          this.blood.burst(ev.x!, ev.y!, ev.z!, {
            count: Math.round(9 + big * 5), color: 0xd42a2a, color2: 0x5c0808,
            speed: [3 + big, 8 + big * 2.6], size: [0.26 + big * 0.08, 0.55 + big * 0.18],
            life: [0.28, 0.6], gravity: 13, drag: 1.1, stretch: 2.4,
          });
          // 不是每一口都留印子——几十只僵尸同时啃的时候，全留会把整条路涂红
          if (this.rng.next() < 0.6) this.decals.add('blood', ev.x!, ev.z!, 0.95 + big * 0.5, 0.55);
          break;
        }
        case 'soldierDown': {
          this.blood.burst(ev.x!, ev.y! + 0.5, ev.z!, {
            count: 26, color: 0xc42227, color2: 0x3d0505, speed: [2.5, 9], size: [0.2, 0.5],
            life: [0.3, 0.7], gravity: 13, drag: 1.2, stretch: 2.4,
          });
          this.blood.burst(ev.x!, ev.y! + 0.7, ev.z!, {
            count: 6, color: 0x7d1416, color2: 0x2c0404, speed: [0.5, 2], size: [0.45, 0.85],
            life: [0.35, 0.7], grow: 1.4, drag: 2.6, fadeIn: 0.05,
          });
          this.decals.add('blood', ev.x!, ev.z!, 2.4, 0.85);
          break;
        }
        case 'blockHit': {
          this.sparks.burst(ev.x!, ev.y!, ev.z! - 1.3, {
            count: 3, color: 0xffd98a, speed: [1.5, 5], size: [0.25, 0.5], life: [0.1, 0.25], gravity: 10,
          });
          break;
        }
        case 'blockDestroyed': {
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: 40, color: 0xfff3c0, color2: 0xd04a0a, speed: [5, 18], size: [0.6, 1.6],
            life: [0.25, 0.6], grow: 0.8, drag: 2.5, stretch: 2.6,
          });
          this.smoke.burst(ev.x!, ev.y!, ev.z!, {
            count: 14, color: 0x938d86, color2: 0x35322e, speed: [2, 7], size: [1.2, 2.6],
            life: [0.6, 1.3], grow: 3, drag: 1.8, lift: 2, fadeIn: 0.18,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.0, 13, 0xffd06a, 0.6, 1.2);
          this.flashes.flash(ev.x!, 2.2, ev.z!, 0xffc061, 150, 0.3);
          this.decals.add('scorch', ev.x!, ev.z! - 1.4, 7, 0.5);
          this.gold.burst(ev.x!, 1.4, ev.z! - 1.4, 46);
          this.camera.punch(0.5);
          this.floats.push({ text: `+${ev.amount ?? 0} 金币`, color: '#ffd44d', x: ev.x!, y: 3.2, z: ev.z!, big: true });
          break;
        }
        case 'goldPickup': {
          this.gold.burst(ev.x!, ev.y!, ev.z!, 6);
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: 10, color: 0xffd54a, speed: [2, 6], size: [0.3, 0.6], life: [0.2, 0.4], grow: -0.5, lift: 2,
          });
          this.floats.push({ text: `+${ev.amount ?? 0}`, color: '#ffd44d', x: ev.x!, y: 1.6, z: ev.z! });
          break;
        }
        case 'gate': {
          const x = LANE_SIGN[ev.side ?? 'left'] * (ROAD_HALF / 2);
          this.floats.push({ text: ev.text ?? '', color: '#ffffff', x, y: 3.4, z: ev.z!, big: true });
          this.sparks.burst(world.squad.x, 1.2, world.squad.z, {
            count: 30, color: 0x8fd8ff, speed: [3, 11], size: [0.5, 1.2], life: [0.3, 0.7], grow: 0.6, drag: 2.2, lift: 2,
          });
          break;
        }
        case 'strikeCall': {
          this.floats.push({ text: '空袭已呼叫', color: '#ff7a1a', x: ev.x!, y: 4.2, z: ev.z!, big: true });
          // 呼叫到落地之间有一秒多的空白，那段等待本身就是戏——
          // 用一排从近到远点亮的地面标记把这一秒填满
          for (let i = 0; i < 10; i++) {
            const zz = ev.z! - 20 + i * 4.4;
            this.sparks.burst(ev.x! + (this.rng.next() - 0.5) * 12, 0.15, zz, {
              count: 2, color: 0xff8a2a, speed: [0.4, 1.6], size: [0.5, 0.9],
              life: [0.6, 1.1], grow: -0.4, lift: 2.4, drag: 0.6,
            });
          }
          break;
        }
        case 'strikeImpact': {
          const R = ev.radius ?? 8.2;
          // 火球核心：一小撮极亮的白，读作"这里刚刚过曝了"
          this.sparks.burst(ev.x!, 1.0, ev.z!, {
            count: 26, color: 0xffffff, color2: 0xffd07a, speed: [3, 12], size: [1.4, 3.4],
            life: [0.12, 0.3], grow: 3.2, drag: 4.5,
          });
          // 外层的火与碎屑：又快又远，沿速度方向拉成条
          this.sparks.burst(ev.x!, 0.5, ev.z!, {
            count: 80, color: 0xfff2c8, color2: 0x8f2404, speed: [10, 34], size: [0.8, 2.4],
            life: [0.3, 0.85], grow: 1.6, drag: 2.2, stretch: 3.4,
          });
          // 蘑菇云：一柱往上翻的浓烟，一秒多才散
          this.smoke.burst(ev.x!, 1.2, ev.z!, {
            count: 30, color: 0xa39a90, color2: 0x2a2724, speed: [2.5, 11], size: [2.2, 5.2],
            life: [1.2, 2.6], grow: 4.6, drag: 1.5, lift: 4.5, fadeIn: 0.15,
          });
          // 两圈冲击波：一圈又快又薄先冲出去，一圈厚的慢慢跟上
          this.waves.spawn(ev.x!, ev.z!, 1.0, R * 3.2, 0xfff0c0, 0.42, 1.9);
          this.waves.spawn(ev.x!, ev.z!, 0.8, R * 2.0, 0xff7a1a, 0.75, 1.1);
          // 抛起来的碎块
          this.gibs.burst(ev.x!, 1.2, ev.z!, 10);
          this.flashes.flash(ev.x!, 3.0, ev.z!, 0xffb257, 420, 0.4);
          this.decals.add('scorch', ev.x!, ev.z!, R * 1.8, 0.6);
          // 这是玩家一局只放一两次的东西，抖动不走每帧预算，直接给足。
          // 但只有第一发给满——十六发全给满的话镜头会整轮钉在上限。
          this.camera.punch(ev.amount === 1 ? 0.7 : 0.2);
          break;
        }
        case 'spitterFire': {
          // 枪口侧：吐出来的那一下
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: 8, color: 0xd8ff88, color2: 0x4a6a18, speed: [2, 6], size: [0.3, 0.6],
            life: [0.18, 0.36], grow: -0.4, stretch: 1.6,
          });
          // 落点：一圈毒绿的预警火花，告诉玩家"这里要中招了，闪开"
          this.sparks.burst(ev.tx!, 0.2, ev.tz!, {
            count: 6, color: 0xaef05a, speed: [0.5, 1.8], size: [0.25, 0.5], life: [0.3, 0.6], grow: -0.3,
          });
          this.waves.spawn(ev.tx!, ev.tz!, (ev.radius ?? 3) * 1.6, (ev.radius ?? 3) * 0.9, 0x9ce85a, 0.9, 0.8);
          break;
        }
        case 'spitterHit': {
          this.sparks.burst(ev.x!, 0.3, ev.z!, {
            count: 24, color: 0xd8ff9a, color2: 0x2f5010, speed: [3, 11], size: [0.4, 1.1],
            life: [0.25, 0.55], grow: 1.2, drag: 2.4, stretch: 1.8,
          });
          this.smoke.burst(ev.x!, 0.3, ev.z!, {
            count: 6, color: 0x6f8c3a, color2: 0x2a3a18, speed: [1, 4], size: [0.8, 1.6],
            life: [0.5, 1.0], grow: 2.2, drag: 2, lift: 1, fadeIn: 0.2,
          });
          this.decals.add('ichor', ev.x!, ev.z!, (ev.radius ?? 3) * 1.5, 0.7);
          this.flashes.flash(ev.x!, 1.2, ev.z!, 0x9ce85a, 40, 0.2);
          if ((ev.amount ?? 0) > 0) this.softPunch(0.08);
          break;
        }
        case 'bomberBlast': {
          // 橙红的爆炸 + 一圈冲击波 + 地上的焦痕。
          // 这一下必须比任何小怪的死亡都响亮——它是"你放它进来了"的惩罚。
          this.sparks.burst(ev.x!, 0.5, ev.z!, {
            count: 34, color: 0xffd48a, color2: 0x8a2a08, speed: [5, 16], size: [0.4, 1.2],
            life: [0.25, 0.6], grow: 1.0, drag: 2.2, stretch: 2.2,
          });
          this.smoke.burst(ev.x!, 0.6, ev.z!, {
            count: 10, color: 0x6a5040, color2: 0x241a14, speed: [1.5, 5], size: [1.0, 2.2],
            life: [0.7, 1.4], grow: 2.6, drag: 1.8, lift: 1.6, fadeIn: 0.15,
          });
          this.waves.spawn(ev.x!, ev.z!, (ev.radius ?? 4) * 2.0, (ev.radius ?? 4) * 0.6, 0xffa040, 1.0, 0.55);
          this.decals.add('scorch', ev.x!, ev.z!, (ev.radius ?? 4) * 1.4, 0.85);
          this.flashes.flash(ev.x!, 1.4, ev.z!, 0xffa347, 90, 0.26);
          this.softPunch(0.12);
          break;
        }
        case 'leaperJump': {
          this.sparks.burst(ev.x!, 0.2, ev.z!, {
            count: 10, color: 0xffd08a, color2: 0x6a4410, speed: [2, 6], size: [0.3, 0.7],
            life: [0.2, 0.4], grow: -0.4, lift: 1.5, stretch: 1.2,
          });
          break;
        }
        case 'leaperLand': {
          // 砸进阵型：一圈小冲击波，让玩家意识到"后排被打了"
          this.sparks.burst(ev.x!, 0.2, ev.z!, {
            count: 18, color: 0xffe0a0, color2: 0x8a4a10, speed: [4, 12], size: [0.4, 1.0],
            life: [0.2, 0.45], grow: 1.0, drag: 2.6, stretch: 2.0,
          });
          this.waves.spawn(ev.x!, ev.z!, 0.4, (ev.radius ?? 2.2) * 2.4, 0xffb257, 0.4, 1.0);
          this.softPunch(0.14);
          break;
        }
        case 'bossSpawn': {
          this.camera.punch(0.9);
          this.smoke.burst(ev.x!, 1, ev.z!, {
            count: 30, color: 0x9a6a58, color2: 0x2e2320, speed: [4, 14], size: [2, 4],
            life: [0.8, 1.6], grow: 4, drag: 1.6, lift: 1, fadeIn: 0.2,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.5, 22, 0xff7a3a, 0.9, 1.1);
          this.flashes.flash(ev.x!, 3, ev.z!, 0xff6a2a, 120, 0.5);
          this.decals.add('scorch', ev.x!, ev.z!, 11, 0.45);
          break;
        }
        case 'bossPhase': {
          this.camera.punch(0.7);
          this.sparks.burst(ev.x!, 1.5, ev.z!, {
            count: 60, color: 0xffd08a, color2: 0xc02a08, speed: [8, 26], size: [0.8, 2.0],
            life: [0.4, 0.9], grow: 1.5, drag: 2, stretch: 2.4,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.2, 18, 0xff5b2e, 0.7, 1.3);
          this.flashes.flash(ev.x!, 3, ev.z!, 0xff5b2e, 130, 0.4);
          this.floats.push({ text: `第 ${ev.amount} 阶段`, color: '#ff6b3d', x: ev.x!, y: 5, z: ev.z!, big: true });
          break;
        }
        case 'bossSlamHit': {
          this.camera.punch(1.0);
          this.sparks.burst(ev.x!, 0.4, ev.z!, {
            count: 46, color: 0xffe0a0, color2: 0xc41808, speed: [10, 26], size: [0.8, 2.2],
            life: [0.3, 0.7], grow: 2.4, drag: 2.6, stretch: 2.8,
          });
          this.smoke.burst(ev.x!, 0.5, ev.z!, {
            count: 18, color: 0x7d6b62, color2: 0x2f2926, speed: [4, 12], size: [1.6, 3.4],
            life: [0.7, 1.4], grow: 4, drag: 1.6, lift: 2, fadeIn: 0.18,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.0, (ev.radius ?? 6.4) * 2.2, 0xff5320, 0.55, 1.4);
          this.flashes.flash(ev.x!, 1.6, ev.z!, 0xff4a20, 160, 0.3);
          this.decals.add('scorch', ev.x!, ev.z!, (ev.radius ?? 6.4) * 1.6, 0.5);
          break;
        }
        case 'bossCharge': {
          this.camera.punch(0.3);
          break;
        }
        case 'bossLightning': {
          // 预警刚出现：落点先冒一缕电火花，提示玩家往哪看
          this.sparks.burst(ev.x!, 0.3, ev.z!, {
            count: 4, color: 0x8fe0ff, speed: [0.6, 2.2], size: [0.2, 0.4], life: [0.15, 0.3], grow: -0.5,
          });
          break;
        }
        case 'bossLightningHit': {
          this.camera.punch(1.1);
          this.strikeFrom.set(ev.x!, 26, ev.z!);
          this.strikeTo.set(ev.x!, 0, ev.z!);
          this.lightning.spawn(this.strikeFrom, this.strikeTo, {
            segments: 9, jitter: 1.6, thickness: 0.16, life: 0.22, color: 0xc9f2ff,
          });
          this.sparks.burst(ev.x!, 0.3, ev.z!, {
            count: 50, color: 0xeafaff, color2: 0x2f7aa0, speed: [8, 24], size: [0.6, 1.6],
            life: [0.25, 0.55], grow: 1.8, drag: 2.6, stretch: 3.0,
          });
          this.smoke.burst(ev.x!, 0.4, ev.z!, {
            count: 10, color: 0xa8cede, color2: 0x3c4a52, speed: [2, 6], size: [1.0, 2.0],
            life: [0.4, 0.8], grow: 2.6, drag: 2, lift: 1.4, fadeIn: 0.2,
          });
          this.waves.spawn(ev.x!, ev.z!, 0.8, (ev.radius ?? 5.2) * 2.4, 0xbfefff, 0.5, 1.5);
          this.flashes.flash(ev.x!, 2.4, ev.z!, 0xbfefff, 220, 0.26);
          this.decals.add('scorch', ev.x!, ev.z!, (ev.radius ?? 5.2) * 1.5, 0.52);
          break;
        }
        case 'bossQuakeHit': {
          // 半场毒爆：沿着那半条路铺一排爆点，读起来是"整块地掀起来"
          const side = (ev.amount ?? 1) > 0 ? 1 : -1;
          this.camera.punch(0.85);
          for (let i = 0; i < 5; i++) {
            const px = side * (ROAD_HALF * (0.1 + i * 0.2));
            const pz = ev.z! + (i - 2) * 5;
            this.sparks.burst(px, 0.4, pz, {
              count: 16, color: 0xd8ff9a, color2: 0x2f5010, speed: [5, 16], size: [0.5, 1.4],
              life: [0.3, 0.65], grow: 1.4, drag: 2.4, stretch: 2.0,
            });
            this.waves.spawn(px, pz, 0.6, 8, 0x9ce85a, 0.5, 1.1);
            this.decals.add('ichor', px, pz, 6, 0.5);
          }
          this.flashes.flash(side * ROAD_HALF * 0.5, 2, ev.z!, 0x9ce85a, 130, 0.3);
          break;
        }
        case 'bossBreathHit': {
          // 火墙：缺口以外整条烧起来
          this.camera.punch(0.9);
          for (let i = 0; i < 7; i++) {
            const px = -ROAD_HALF + (i / 6) * ROAD_HALF * 2;
            if (Math.abs(px - ev.x!) < (ev.radius ?? 3)) continue; // 缺口不烧
            this.sparks.burst(px, 0.5, ev.z!, {
              count: 18, color: 0xfff0b0, color2: 0xc42a08, speed: [6, 18], size: [0.6, 1.6],
              life: [0.3, 0.7], grow: 1.8, drag: 2.2, stretch: 2.6,
            });
            this.smoke.burst(px, 0.6, ev.z!, {
              count: 5, color: 0x8b857e, color2: 0x35322e, speed: [2, 6], size: [1.2, 2.4],
              life: [0.6, 1.2], grow: 3, drag: 1.8, lift: 2, fadeIn: 0.18,
            });
            this.decals.add('scorch', px, ev.z!, 6, 0.4);
          }
          this.flashes.flash(0, 2.4, ev.z!, 0xff8a3a, 170, 0.34);
          break;
        }
        case 'bossBeamHit': {
          // 光束：沿着那条线一路炸过去
          this.camera.punch(0.7);
          const a = ev.amount ?? 0;
          for (let i = 1; i <= 9; i++) {
            const d = i * 7;
            const px = ev.x! + Math.sin(a) * d;
            const pz = ev.z! - Math.cos(a) * d;
            this.sparks.burst(px, 0.5, pz, {
              count: 10, color: 0xffd0d4, color2: 0xb0121a, speed: [4, 13], size: [0.5, 1.2],
              life: [0.25, 0.5], grow: 1.2, drag: 2.6, stretch: 2.8,
            });
            if (i % 3 === 0) this.decals.add('scorch', px, pz, 5, 0.4);
          }
          this.flashes.flash(ev.x!, 3, ev.z!, 0xff3a44, 150, 0.28);
          break;
        }
        case 'bossSubmerge': {
          this.camera.punch(0.6);
          this.smoke.burst(ev.x!, 0.6, ev.z!, {
            count: 26, color: 0x8a7ab0, color2: 0x241c33, speed: [4, 13], size: [1.8, 3.6],
            life: [0.8, 1.6], grow: 4, drag: 1.6, lift: 1.4, fadeIn: 0.2,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.2, 20, 0xc9a8ff, 0.8, 1.2);
          this.floats.push({ text: '潜地 · 免疫伤害', color: '#c9a8ff', x: ev.x!, y: 5, z: ev.z!, big: true });
          break;
        }
        case 'bossEmerge': {
          this.camera.punch(1.0);
          this.sparks.burst(ev.x!, 0.6, ev.z!, {
            count: 46, color: 0xeaddff, color2: 0x4a2a80, speed: [8, 24], size: [0.7, 1.8],
            life: [0.35, 0.75], grow: 1.8, drag: 2.4, stretch: 2.4,
          });
          this.waves.spawn(ev.x!, ev.z!, 0.8, 24, 0xc9a8ff, 0.7, 1.5);
          this.flashes.flash(ev.x!, 3, ev.z!, 0xc9a8ff, 190, 0.34);
          break;
        }
        case 'midbossSpawn': {
          this.camera.punch(0.5);
          this.smoke.burst(ev.x!, 1, ev.z!, {
            count: 16, color: 0x6f9448, color2: 0x22301a, speed: [3, 9], size: [1.2, 2.4],
            life: [0.5, 1.0], grow: 3, drag: 1.6, lift: 1, fadeIn: 0.2,
          });
          this.waves.spawn(ev.x!, ev.z!, 1.0, 12, 0x9ce85a, 0.6, 0.9);
          this.flashes.flash(ev.x!, 2.4, ev.z!, 0x9ce85a, 70, 0.35);
          break;
        }
        case 'midbossAbility': {
          // 预警刚出现：脚下先冒几粒毒绿的火花，提示玩家往哪躲
          this.sparks.burst(ev.x!, 0.2, ev.z!, {
            count: 6, color: 0x9ce85a, speed: [0.6, 2.0], size: [0.24, 0.45], life: [0.2, 0.4], grow: -0.4,
          });
          break;
        }
        case 'midbossAbilityHit': {
          this.camera.punch(0.6);
          this.sparks.burst(ev.x!, 0.4, ev.z!, {
            count: 30, color: 0xd8ff9a, color2: 0x3f6a18, speed: [6, 18], size: [0.6, 1.6],
            life: [0.25, 0.55], grow: 1.6, drag: 2.4, stretch: 2.2,
          });
          this.smoke.burst(ev.x!, 0.4, ev.z!, {
            count: 10, color: 0x5f8438, color2: 0x24301a, speed: [2, 6], size: [1.0, 2.0],
            life: [0.4, 0.8], grow: 2.4, drag: 2, lift: 1.2, fadeIn: 0.2,
          });
          this.waves.spawn(ev.x!, ev.z!, 0.8, (ev.radius ?? 5.0) * 2.2, 0x9ce85a, 0.5, 1.2);
          this.flashes.flash(ev.x!, 1.5, ev.z!, 0x9ce85a, 110, 0.28);
          this.decals.add('ichor', ev.x!, ev.z!, (ev.radius ?? 5.0) * 1.4, 0.7);
          break;
        }
        default:
          break;
      }
    }
  }

  /** 开发期调试：每种单位这一帧实际画了多少个实例。 */
  instanceCounts(): Record<string, number> {
    const out: Record<string, number> = {
      soldiers: this.soldiers.mesh.count,
      cannons: this.cannons.count,
      shells: this.shells.count,
      bars: this.bars.mesh.count,
    };
    for (const [key, b] of this.batches) out[key] = b.mesh.count;
    return out;
  }

  dispose(): void {
    this.disposeLevel();
  }
}
