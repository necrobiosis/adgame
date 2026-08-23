import * as THREE from 'three';
import {
  ENEMY_STATS,
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
import { CRIMSON, DAY, createLights, createSky, createSkyEnvironment, type SceneLights, type SkyTheme } from './env/Sky';
import { GoldBurst } from './fx/GoldBurst';
import { Lightning } from './fx/Lightning';
import { Particles } from './fx/Particles';
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
  bossGeometry,
  bruteGeometry,
  geometryPivots,
  midBossGeometry,
  runnerGeometry,
  screamerGeometry,
  soldierGeometry,
  titanGeometry,
  zombieGeometry,
  type BuildQuality,
} from './units/HumanoidGeometry';
import { cannonGeometry, shellGeometry } from './units/PropGeometry';

/**
 * 各类敌人的实例缓冲上限。
 *
 * 真正每帧画多少由画质档的 enemyInstances 决定 —— 渲染层只挑**离方阵最近的
 * 那一批**画出来。被舍弃的都在百米开外、埋在雾里，屏幕上只有几个像素，
 * 而模拟层里它们照常存在、照常推进、照常啃人，玩法一点没变。
 */
const CROWD_CAPACITY: Record<EnemyKind, number> = {
  walker: 360,
  runner: 200,
  screamer: 48,
  brute: 40,
  titan: 32,
  midboss: 2,
  boss: 1,
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

export interface FloatRequest {
  text: string;
  color: string;
  x: number;
  y: number;
  z: number;
  /** 字号档位。 */
  big?: boolean;
}

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
  private readonly batches = new Map<EnemyKind, CrowdBatch>();
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
  private readonly bars = new HealthBarBatch(64);
  private readonly tracers = new Tracers();
  private readonly sparks = new Particles(900, true);
  private readonly smoke = new Particles(420, false);
  private readonly gold = new GoldBurst();
  private readonly ring = new TelegraphRing();
  private readonly lane = new TelegraphLane();
  private readonly reticle = new LightningReticle();
  private readonly lightning = new Lightning();
  /** 中 boss 冲击波预警——独立于主 Boss 的 ring，避免两者同屏时互相抢用。 */
  private readonly midRing = new TelegraphRing();
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
  private gateWalls: { z: number; wall: GateWall; id: number }[] = [];
  private blockMeshes: BlockMesh[] = [];
  private time = 0;

  private readonly m = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly sc = new THREE.Vector3(1, 1, 1);
  private readonly axisY = new THREE.Vector3(0, 1, 0);
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
    const geos: Record<EnemyKind, (q: BuildQuality) => THREE.BufferGeometry> = {
      walker: zombieGeometry,
      runner: runnerGeometry,
      screamer: screamerGeometry,
      brute: bruteGeometry,
      titan: titanGeometry,
      midboss: midBossGeometry,
      boss: bossGeometry,
    };

    const crowdShadows = this.r.quality.crowdShadows && this.r.quality.shadowMap > 0;
    for (const kind of Object.keys(geos) as EnemyKind[]) {
      const geo = geos[kind](q);
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
      const batch = new CrowdBatch(geo, set.material, CROWD_CAPACITY[kind], set.depthMaterial);
      // 大体型的怪和 Boss 永远投影，杂兵只在高画质档投
      batch.setCastShadow(this.r.quality.shadowMap > 0 && (crowdShadows || ENEMY_STATS[kind].scale >= 1.5));
      this.batches.set(kind, batch);
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
    const soldierMat = createCrowdMaterial({ roughness: 0.74, metalness: 0.1 });
    soldierMat.setPivots(geometryPivots(soldierGeo));
    this.soldierMatSet = soldierMat;
    this.soldiers = new CrowdBatch(soldierGeo, soldierMat.material, MAX_RENDERED_SOLDIERS, soldierMat.depthMaterial);
    this.soldiers.setCastShadow(this.r.quality.shadowMap > 0);
    this.scene.add(this.soldiers.mesh);
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

    this.scene.add(
      this.bars.mesh, this.tracers.mesh, this.sparks.mesh, this.smoke.mesh, this.gold.mesh,
      this.ring.mesh, this.lane.mesh, this.reticle.mesh, this.lightning.group, this.midRing.mesh,
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
    this.scene.remove(this.cannons, this.shells);
    this.cannons.geometry.dispose();
    (this.cannons.material as THREE.Material).dispose();
    this.shells.geometry.dispose();
    (this.shells.material as THREE.Material).dispose();
    this.buildCharacters();
    this.buildProps();
  }

  /** 为一关搭出静态场景。切关时调用。 */
  buildLevel(world: World): void {
    this.disposeLevel();
    const root = new THREE.Group();
    const theme: SkyTheme = world.level.id >= 4 ? CRIMSON : DAY;
    const q = this.r.quality;

    root.add(createSky(theme));
    // 环境光就是这片天空本身 —— 金属反射到的和玩家看到的是同一个天色
    this.r.setEnvironment(createSkyEnvironment(this.r.renderer, theme), 0.7);

    const lights = createLights(theme, q.shadowMap);
    for (const l of lights.all) root.add(l);
    this.lights = lights;
    this.scene.fog = new THREE.Fog(theme.fog, 90, 420);

    const rng = new Rng(0x1234 + world.level.id * 977);
    root.add(createBridge(world.totalLength, rng, q.envDetail));
    root.add(createCity(world.totalLength, rng, q.envDetail));

    for (const g of world.gates) {
      const wall = new GateWall(g.z, g.left, g.right);
      root.add(wall.group);
      this.gateWalls.push({ z: g.z, wall, id: g.id });
    }
    for (const b of world.blocks) {
      const mesh = new BlockMesh(b);
      root.add(mesh.group);
      this.blockMeshes.push(mesh);
    }

    this.levelRoot = root;
    this.scene.add(root);
    this.camera.snap(world.squad.x, world.squad.z);
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
  }

  /**
   * 开发期：把镜头钉在某个目标近处，用来逐个检查资产。
   * null 表示恢复正常的追尾镜头。
   */
  inspect: { target: 'squad' | 'boss' | 'enemy' | 'cannon'; dist: number; height: number; yaw: number } | null = null;

  private applyInspect(world: World): boolean {
    const ins = this.inspect;
    if (!ins) return false;
    let cx = world.squad.x;
    // 头部高度而不是躯干中心——现在角色有五官了，检查资产多半是想看脸
    let cy = 1.6;
    let cz = world.squad.z;
    if (ins.target === 'boss' && world.boss.enemy) {
      cx = world.boss.enemy.x;
      // Boss 几何体本身按 2.9 米建的模，还要再乘一层实例 scale（4.4 左右），
      // 真实站高逼近 12 米——不能只按 scale 本身估头部高度，那样镜头会
      // 钉在膝盖附近往上看天。
      cy = world.boss.enemy.scale * 2.9 * 0.85;
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
    this.syncShells(world);
    this.syncBoss(world, dt);
    this.syncMidBoss(world);

    for (const g of this.gateWalls) g.wall.update(dt);
    for (const gate of world.gates) {
      if (!gate.taken) continue;
      const gw = this.gateWalls.find((w) => w.id === gate.id);
      if (gw) gw.wall.fade(Math.pow(0.06, dt));
    }
    for (const b of this.blockMeshes) b.update();

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
    this.gold.update(dt);
    this.lightning.update(dt);

    if (!this.applyInspect(world)) {
      this.camera.update(this.r.camera, dt, world.squad.x, world.squad.z, world.squad.depth, world.boss.active);
    }
    this.followSun(world);
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
      vis.sort((a, b) => Math.abs(a.z - sz) - Math.abs(b.z - sz));
      vis.length = budget;
    }

    for (const e of vis) {
      const batch = this.batches.get(e.kind);
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
    const attacking = e.alive && e.z - squadZ < 2.6 + e.scale * 0.6;
    batch.add(
      e.x, 0, e.z,
      yaw,
      e.scale,
      e.phase,
      0,
      attacking ? 1 : 0,
      death,
      flashAmount(e),
      jitterTint(this.tints.get(e.kind)!, e.id, ENEMY_JITTER[e.kind]),
    );
    if (st.showHealthBar && e.alive && e.hp < e.maxHp) {
      this.bars.add(e.x, 1.95 * e.scale, e.z, e.hp / e.maxHp, 1.5 + e.scale * 0.35);
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
      scratch.sort((a, b) => a.row - b.row);
      scratch.length = cap;
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
          this.tracers.spawn(ev.x!, ev.y!, ev.z!, ev.tx!, ev.ty!, ev.tz!, ev.color ?? 0xffd166);
          if (this.rng.next() < 0.22) {
            this.sparks.burst(ev.x!, ev.y!, ev.z! + 0.55, {
              count: 1, color: ev.color ?? 0xffd166,
              speed: [0.4, 1.4], size: [0.3, 0.55], life: [0.05, 0.09], grow: -1.6,
            });
          }
          break;
        }
        case 'cannonFire': {
          this.sparks.burst(ev.x!, ev.y! + 0.7, ev.z! + 1.1, {
            count: 8, color: 0xffb03a, speed: [2, 7], size: [0.5, 1.0], life: [0.1, 0.24], grow: -1.5, drag: 6,
          });
          this.smoke.burst(ev.x!, ev.y! + 0.7, ev.z! + 1.0, {
            count: 4, color: 0x9c9c9c, speed: [0.6, 2.2], size: [0.7, 1.3], life: [0.4, 0.8], grow: 2.2, drag: 2.4, lift: 1.2,
          });
          break;
        }
        case 'shellImpact': {
          this.sparks.burst(ev.x!, 0.5, ev.z!, {
            count: 26, color: 0xffa227, speed: [4, 15], size: [0.6, 1.5], life: [0.15, 0.42], grow: 1.4, drag: 3.5,
          });
          this.smoke.burst(ev.x!, 0.6, ev.z!, {
            count: 10, color: 0x6d6a66, speed: [1.5, 5], size: [1.0, 2.2], life: [0.5, 1.1], grow: 3.2, drag: 2, lift: 1.6,
          });
          this.camera.punch(0.16);
          break;
        }
        case 'kill': {
          const kind = ev.kind ?? 'walker';
          const big = kind === 'brute' || kind === 'titan' || kind === 'midboss';
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: big ? 16 : 4, color: 0x8fbf4a,
            speed: [1.5, big ? 8 : 4], size: [0.3, big ? 1.0 : 0.5], life: [0.15, 0.4], grow: -0.4, gravity: 6, drag: 1.5,
          });
          if (big) {
            this.gold.burst(ev.x!, 0.4, ev.z!, 4);
            this.camera.punch(0.08);
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
        case 'soldierDown': {
          this.sparks.burst(ev.x!, ev.y!, ev.z!, {
            count: 5, color: 0xd93b3b, speed: [1.2, 3.6], size: [0.28, 0.5], life: [0.2, 0.45], gravity: 8, drag: 1.6,
          });
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
            count: 40, color: 0xffc93a, speed: [5, 18], size: [0.6, 1.6], life: [0.25, 0.6], grow: 0.8, drag: 2.5,
          });
          this.smoke.burst(ev.x!, ev.y!, ev.z!, {
            count: 14, color: 0x7b7671, speed: [2, 7], size: [1.2, 2.6], life: [0.6, 1.3], grow: 3, drag: 1.8, lift: 2,
          });
          this.gold.burst(ev.x!, 1.4, ev.z! - 1.4, 46);
          this.camera.punch(0.5);
          this.floats.push({ text: `+${ev.amount ?? 0} 金币`, color: '#ffd44d', x: ev.x!, y: 3.2, z: ev.z!, big: true });
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
        case 'bossSpawn': {
          this.camera.punch(0.9);
          this.smoke.burst(ev.x!, 1, ev.z!, {
            count: 30, color: 0x8a5a4a, speed: [4, 14], size: [2, 4], life: [0.8, 1.6], grow: 4, drag: 1.6, lift: 1,
          });
          break;
        }
        case 'bossPhase': {
          this.camera.punch(0.7);
          this.sparks.burst(ev.x!, 1.5, ev.z!, {
            count: 60, color: 0xff5b2e, speed: [8, 26], size: [0.8, 2.0], life: [0.4, 0.9], grow: 1.5, drag: 2,
          });
          this.floats.push({ text: `第 ${ev.amount} 阶段`, color: '#ff6b3d', x: ev.x!, y: 5, z: ev.z!, big: true });
          break;
        }
        case 'bossSlamHit': {
          this.camera.punch(1.0);
          this.sparks.burst(ev.x!, 0.4, ev.z!, {
            count: 46, color: 0xff4022, speed: [10, 26], size: [0.8, 2.2], life: [0.3, 0.7], grow: 2.4, drag: 2.6,
          });
          this.smoke.burst(ev.x!, 0.5, ev.z!, {
            count: 18, color: 0x6b5a52, speed: [4, 12], size: [1.6, 3.4], life: [0.7, 1.4], grow: 4, drag: 1.6, lift: 2,
          });
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
            count: 50, color: 0xaee8ff, speed: [8, 24], size: [0.6, 1.6], life: [0.25, 0.55], grow: 1.8, drag: 2.6,
          });
          this.smoke.burst(ev.x!, 0.4, ev.z!, {
            count: 10, color: 0x8fb8c8, speed: [2, 6], size: [1.0, 2.0], life: [0.4, 0.8], grow: 2.6, drag: 2, lift: 1.4,
          });
          break;
        }
        case 'midbossSpawn': {
          this.camera.punch(0.5);
          this.smoke.burst(ev.x!, 1, ev.z!, {
            count: 16, color: 0x5a7a3a, speed: [3, 9], size: [1.2, 2.4], life: [0.5, 1.0], grow: 3, drag: 1.6, lift: 1,
          });
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
            count: 30, color: 0x9ce85a, speed: [6, 18], size: [0.6, 1.6], life: [0.25, 0.55], grow: 1.6, drag: 2.4,
          });
          this.smoke.burst(ev.x!, 0.4, ev.z!, {
            count: 10, color: 0x4a6a2c, speed: [2, 6], size: [1.0, 2.0], life: [0.4, 0.8], grow: 2.4, drag: 2, lift: 1.2,
          });
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
    for (const [kind, b] of this.batches) out[kind] = b.mesh.count;
    return out;
  }

  dispose(): void {
    this.disposeLevel();
  }
}
