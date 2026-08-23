import * as THREE from 'three';

/**
 * 天空里一条纯装饰的飞龙——不参与战斗，没有 AI，就是背景氛围。
 *
 * 沿用项目"零外部资源、全程序化"的规矩，但刻意不接入角色那套骨骼蒙皮系统：
 * 那是为几百个角色共享一次 draw call设计的重型机制，单条龙用不上。这里
 * 就是几个手搭的低模网格 + CPU 端每帧算一次的刚体变换，比角色管线简单得多：
 * - 身体：一个沿长轴车削出来的纺锤体（LatheGeometry），头尾自然收尖
 * - 翅膀：两片三角扇网格，各自挂一个肩部轴心，扇动就是绕轴心转一下
 * - 飞行路径：绕着方阵前方的一个中心点画大圈，纯 CPU 变换，没有物理/寻路
 */
export class Dragon {
  readonly group = new THREE.Group();
  private readonly wingL = new THREE.Group();
  private readonly wingR = new THREE.Group();
  private t = 0;
  private readonly lookTarget = new THREE.Vector3();

  constructor() {
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 0.85, metalness: 0.05 });
    const body = new THREE.Mesh(bodyGeometry(), bodyMat);
    body.frustumCulled = false;
    this.group.add(body);

    const wingMat = new THREE.MeshStandardMaterial({
      color: 0x1c1815, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    });
    const wingGeo = wingGeometry(3.6, 2.4);
    const meshL = new THREE.Mesh(wingGeo, wingMat);
    const meshR = new THREE.Mesh(wingGeo, wingMat);
    meshR.scale.x = -1;
    meshL.frustumCulled = false;
    meshR.frustumCulled = false;
    this.wingL.add(meshL);
    this.wingR.add(meshR);
    this.wingL.position.set(-0.5, 0.05, -0.3);
    this.wingR.position.set(0.5, 0.05, -0.3);
    this.group.add(this.wingL, this.wingR);

    // 眼睛：纯剪影里唯一的一点暖色，读起来是"有生命的东西"而不是一块影子
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff5a2a, toneMapped: false });
    const eyeGeo = new THREE.SphereGeometry(0.05, 6, 5);
    for (const sx of [-1, 1] as const) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(sx * 0.14, 0.05, -2.5);
      eye.frustumCulled = false;
      this.group.add(eye);
    }

    this.group.scale.setScalar(3.2);
    this.group.frustumCulled = false;
  }

  /** 每帧调用：绕 (centerX, centerZ) 上空画一个缓慢的大圈，高度带一点起伏。 */
  update(dt: number, centerX: number, centerZ: number): void {
    this.t += dt;
    const angle = this.t * 0.05;
    const radius = 85;
    const height = 60 + Math.sin(this.t * 0.12) * 10;
    const x = centerX + Math.cos(angle) * radius;
    const z = centerZ + Math.sin(angle) * radius;
    this.group.position.set(x, height, z);

    // 朝向路径切线方向——往前一点点取样，用 lookAt 顺出朝向，不用另外算角速度
    this.lookTarget.set(
      centerX + Math.cos(angle + 0.04) * radius,
      height,
      centerZ + Math.sin(angle + 0.04) * radius,
    );
    this.group.lookAt(this.lookTarget);

    const flap = Math.sin(this.t * 2.4) * 0.55 + 0.15;
    this.wingL.rotation.z = flap;
    this.wingR.rotation.z = -flap;
  }
}

/** 纺锤体：尾尖 → 身体最粗处 → 收向脖子 → 头部 → 吻部收尖。鼻尖朝 -Z，配合 lookAt 的默认朝向。 */
function bodyGeometry(): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector2(0.02, 3.2),   // 尾尖
    new THREE.Vector2(0.35, 2.2),
    new THREE.Vector2(0.55, 0.8),
    new THREE.Vector2(0.62, -0.4),  // 身体最粗
    new THREE.Vector2(0.4, -1.4),
    new THREE.Vector2(0.3, -1.9),
    new THREE.Vector2(0.36, -2.3),  // 头部
    new THREE.Vector2(0.12, -2.7),  // 吻部
    new THREE.Vector2(0.01, -2.85), // 鼻尖
  ];
  const geo = new THREE.LatheGeometry(pts, 10);
  geo.rotateX(Math.PI / 2);
  geo.computeVertexNormals();
  return geo;
}

/** 翅膀剪影：肩部 → 前缘中段 → 翼尖 → 后缘两点收回来，一个三角扇。 */
function wingGeometry(span: number, chord: number): THREE.BufferGeometry {
  const pts = [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(span * 0.55, span * 0.1, chord * 0.15),
    new THREE.Vector3(span, -span * 0.05, chord * 0.05),
    new THREE.Vector3(span * 0.62, -span * 0.03, -chord * 0.55),
    new THREE.Vector3(span * 0.18, -span * 0.02, -chord * 0.35),
  ];
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = p.y;
    pos[i * 3 + 2] = p.z;
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  geo.computeVertexNormals();
  return geo;
}
