/* Volo — Calibrate 三维视口底层（gridScene.tsx）
   Blender 视口交互模型的 1:1 复刻（源码常量逐项对照 source/blender/editors/space_view3d），
   渲染换成 three.js / @react-three/fiber GPU 管线（z-buffer 深度、真透视、无限地面网格）。
   世界坐标系与 mesh-core 一致：Z-up（X=列/横向、Y=弯曲深度、Z=行/竖直）。

   Blender 常量对照（见 view3d_navigate_*.cc / overlay_grid_frag.glsl）：
   - 转台 orbit 灵敏度 0.4°/px（拖 900px = 整圈）；方位角恒绕世界 Z、俯仰绕相机水平轴；
     俯仰不钳制，翻越极点后方位角自动反向（persmat 上下颠倒判定）。
   - 滚轮缩放每格 ×1.2；缩放锚定光标下的世界点（USER_ZOOM_TO_MOUSEPOS）。
   - 平移按轨道目标深度换算 px→世界（目标深度处内容 1:1 跟手）。
   - 透视 50mm/36mm 胶片（水平 FOV≈39.6°）；轴向正交视图 + 自由旋转自动回透视。
   - 离散跳转（gizmo 吸附/复位/取景）200ms 平滑过渡，拖拽即时生效。
   - 地面网格 10 的幂 LOD、相邻级小数交叉淡化、掠射角淡出 1-(1-|V.z|)³、径向淡出，
     地面上下对称可见（钻到地下仰视不再翻转）。 */
import * as React from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";

const DEG = Math.PI / 180;
const ORBIT_SENS = 0.4 * DEG;          /* Blender view_rotate_sensitivity_turntable */
const ZOOM_STEP = 1.2;                 /* Blender 滚轮 dist 因子 */
const HFOV = 2 * Math.atan(36 / (2 * 50)); /* Blender lens 50mm / sensor 36mm */
const DIST_MIN = 0.05, DIST_MAX = 500;
const SMOOTH_MS = 200;                 /* Blender U.smooth_viewtx */

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const WORLD_Z = new THREE.Vector3(0, 0, 1);

export interface RigView { quat: THREE.Quaternion; dist: number; target: THREE.Vector3; ortho: boolean }

/** 轨道相机：Blender RegionView3D 的 (viewquat, dist, ofs) 三元组等价物。 */
export class CameraRig {
  quat = new THREE.Quaternion();
  dist = 8;
  target = new THREE.Vector3(0, 0, 0.5);
  ortho = false;
  persp = new THREE.PerspectiveCamera(40, 1, 0.01, 2000);
  orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  width = 1; height = 1;
  touched = false;   /* 用户手动操作过后停用自动取景（沿用旧视口约定） */
  private listeners = new Set<() => void>();
  private anim: number | null = null;

  constructor() { this.setAzEl(30, 22); this.apply(); }

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.ortho ? this.orthoCam : this.persp;
  }
  private vfov(): number { /* 水平 FOV 固定（Blender 胶片宽装配），竖直随宽高比推导 */
    const aspect = this.width / Math.max(1, this.height);
    return 2 * Math.atan(Math.tan(HFOV / 2) / Math.max(0.2, aspect));
  }

  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { this.listeners.forEach((fn) => fn()); }

  setSize(w: number, h: number) { this.width = Math.max(1, w); this.height = Math.max(1, h); this.apply(); }

  /** 由旧视口 az/el 语义构造朝向（az 自 +Y 顺时针、el 仰角），保持初始视角 1:1。 */
  setAzEl(azDeg: number, elDeg: number) {
    const a = azDeg * DEG, e = elDeg * DEG;
    const back = _v1.set(Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e));
    this.quat.copy(quatFromViewDir(back, WORLD_Z));
  }

  apply() {
    const back = _v1.set(0, 0, 1).applyQuaternion(this.quat);
    const cam = this.camera;
    cam.position.copy(this.target).addScaledVector(back, this.dist);
    cam.quaternion.copy(this.quat);
    if (cam === this.persp) {
      this.persp.fov = this.vfov() / DEG;
      this.persp.aspect = this.width / Math.max(1, this.height);
      this.persp.near = Math.max(0.005, this.dist * 0.005);
      this.persp.far = Math.max(200, this.dist * 50);
    } else {
      /* 正交可见范围 = 透视在目标深度的可见范围 → 透视↔正交切换缩放连续 */
      const halfH = this.dist * Math.tan(this.vfov() / 2);
      const halfW = halfH * (this.width / Math.max(1, this.height));
      this.orthoCam.left = -halfW; this.orthoCam.right = halfW;
      this.orthoCam.top = halfH; this.orthoCam.bottom = -halfH;
    }
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    this.emit();
  }

  cancelAnim() { if (this.anim != null) { cancelAnimationFrame(this.anim); this.anim = null; } }

  /** Blender 转台：俯仰绕相机水平轴（无钳制、可翻越），方位角绕世界 Z（倒置时反向）。 */
  orbit(dxPx: number, dyPx: number) {
    this.cancelAnim(); this.touched = true;
    if (this.ortho) this.ortho = false; /* USER_AUTOPERSP：轴向正交视图一旦自由旋转即回透视 */
    const right = _v1.set(1, 0, 0).applyQuaternion(this.quat);
    this.quat.premultiply(_q1.setFromAxisAngle(right, -dyPx * ORBIT_SENS));
    /* 方位角符号使「场景跟手」（grab-and-spin，Blender 同感）；世界倒置时反向。 */
    const upsideDown = _v2.set(0, 1, 0).applyQuaternion(this.quat).z < 0;
    this.quat.premultiply(_q1.setFromAxisAngle(WORLD_Z, (upsideDown ? 1 : -1) * dxPx * ORBIT_SENS));
    this.quat.normalize();
    this.apply();
  }

  /** 平移：px→世界按目标深度换算（Blender ED_view3d_win_to_delta 等价）。 */
  pan(dxPx: number, dyPx: number) {
    this.cancelAnim(); this.touched = true;
    const wpp = (2 * this.dist * Math.tan(this.vfov() / 2)) / this.height;
    const right = _v1.set(1, 0, 0).applyQuaternion(this.quat);
    const up = _v2.set(0, 1, 0).applyQuaternion(this.quat);
    this.target.addScaledVector(right, -dxPx * wpp).addScaledVector(up, dyPx * wpp);
    this.apply();
  }

  /** 滚轮缩放 ×1.2/格，锚定光标下世界点（Blender zoom-to-mouse：ofs 朝光标射线重定位）。 */
  zoomStep(dir: 1 | -1, ndc: { x: number; y: number } | null) {
    this.cancelAnim(); this.touched = true;
    const dfac = dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const newDist = Math.max(DIST_MIN, Math.min(DIST_MAX, this.dist * dfac));
    const f = newDist / this.dist;
    if (ndc && Math.abs(1 - f) > 1e-6) {
      /* 光标下目标深度处的世界点 P：缩放前后保持其屏幕位置不动 */
      const cam = this.camera;
      const tNdc = _v1.copy(this.target).project(cam);
      const p = _v2.set(ndc.x, ndc.y, tNdc.z).unproject(cam);
      this.target.add(_v3.subVectors(p, this.target).multiplyScalar(1 - f));
    }
    this.dist = newDist;
    this.apply();
  }

  /** 自动取景：内容包围盒对角线占视口短边 ~55%（沿用旧视口取景比例）。 */
  fit(min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) {
    this.cancelAnim();
    this.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    const halfDiag = Math.max(0.25, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2);
    const tanV = Math.tan(this.vfov() / 2);
    const tanH = tanV * (this.width / Math.max(1, this.height));
    this.dist = Math.max(DIST_MIN, Math.min(DIST_MAX, halfDiag / (0.55 * Math.min(tanV, tanH))));
    this.apply();
  }

  snapshot(): RigView {
    return { quat: this.quat.clone(), dist: this.dist, target: this.target.clone(), ortho: this.ortho };
  }

  /** 200ms 平滑过渡（仅离散跳转用；拖拽恒即时）。smoothstep 缓动，dist 走对数插值。 */
  smoothTo(to: Partial<RigView>) {
    this.cancelAnim();
    const from = this.snapshot();
    const toQ = to.quat ? to.quat.clone() : from.quat;
    const toD = to.dist != null ? to.dist : from.dist;
    const toT = to.target ? to.target.clone() : from.target;
    if (to.ortho != null) this.ortho = to.ortho;
    const t0 = performance.now();
    const tick = () => {
      const u = Math.min(1, (performance.now() - t0) / SMOOTH_MS);
      const s = u * u * (3 - 2 * u);
      this.quat.slerpQuaternions(from.quat, toQ, s);
      this.dist = Math.exp(THREE.MathUtils.lerp(Math.log(from.dist), Math.log(toD), s));
      this.target.lerpVectors(from.target, toT, s);
      this.apply();
      this.anim = u < 1 ? requestAnimationFrame(tick) : null;
    };
    tick();
  }

  /** gizmo 轴向吸附：沿轴看向目标 + 正交投影（Blender 轴视图约定）。 */
  axisView(dir: THREE.Vector3, up: THREE.Vector3) {
    this.touched = true;
    this.smoothTo({ quat: quatFromViewDir(dir, up), ortho: true });
  }

  /** 世界点 → 视口 CSS 像素；相机背后返回 null（叠加层裁剪用）。 */
  project(p: { x: number; y: number; z: number }): [number, number] | null {
    const cam = this.camera;
    _v1.set(p.x, p.y, p.z).applyMatrix4(cam.matrixWorldInverse);
    if (cam === this.persp && _v1.z > -0.01) return null;
    _v1.applyMatrix4(cam.projectionMatrix);
    return [(_v1.x * 0.5 + 0.5) * this.width, (1 - (_v1.y * 0.5 + 0.5)) * this.height];
  }
}

/** 视线方向（自目标指向相机的 back 向量）+ up → 相机朝向四元数。 */
const _origin = new THREE.Vector3();
export function quatFromViewDir(back: THREE.Vector3, up: THREE.Vector3): THREE.Quaternion {
  _m1.lookAt(back, _origin, up);
  return new THREE.Quaternion().setFromRotationMatrix(_m1);
}

/* ---------- 拾取 ---------- */

export interface PickBox { key: string; c: number; r: number; corners: { x: number; y: number; z: number }[]; masked: boolean }
export interface PickHit { entryId: string; box: PickBox }
export interface SceneStore {
  pickMeshes: THREE.Mesh[];
  setHover: (hit: PickHit | null) => void;
  invalidate: () => void;
}
const _raycaster = new THREE.Raycaster();
/* 拾取网格专用材质：Mesh.raycast 尊重 material.side，必须 DoubleSide 才能从墙两侧命中 */
const PICK_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });

/** 视口 client 坐标 → 命中的箱体（不可见 pick mesh 全量拾取，含镂空块）。 */
export function pickBoxAt(rig: CameraRig, store: SceneStore, rect: DOMRect, clientX: number, clientY: number): PickHit | null {
  const ndc = {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
  _raycaster.setFromCamera(ndc as THREE.Vector2, rig.camera);
  const hits = _raycaster.intersectObjects(store.pickMeshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  const ud = hit.object.userData as { entryId: string; boxes: PickBox[] };
  const bi = Math.floor((hit.faceIndex || 0) / 2);
  return ud.boxes[bi] ? { entryId: ud.entryId, box: ud.boxes[bi] } : null;
}

/* ---------- 无限地面网格（Blender overlay_grid 片元逻辑的移植） ---------- */

const GRID_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GRID_FRAG = /* glsl */ `
precision highp float;
varying vec3 vW;
uniform vec3 uCam;
uniform float uLevel;    /* log10 连续 LOD：整数部分=细线级距 10^n，小数部分驱动交叉淡化 */
uniform float uFade;     /* 径向淡出半径（米） */
uniform float uMinorA;
uniform float uMajorA;
uniform vec3 uAxisX;
uniform vec3 uAxisY;

float gridLine(vec2 uv) {
  vec2 g = abs(fract(uv - 0.5) - 0.5) / fwidth(uv);
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  float lf = fract(uLevel);
  float stepFine = pow(10.0, floor(uLevel));
  float gFine = gridLine(vW.xy / stepFine);
  float gMid = gridLine(vW.xy / (stepFine * 10.0));
  float gBig = gridLine(vW.xy / (stepFine * 100.0));
  /* 缩放时细一级淡出、粗一级顶替 —— Blender「网格从不突变」的关键 */
  float aMinor = max(gFine * (1.0 - lf), gMid * lf) * uMinorA;
  float aMajor = max(gMid * (1.0 - lf), gBig * lf) * uMajorA;
  float alpha = max(aMinor, aMajor);
  vec3 col = vec3(1.0);

  /* 世界轴线（面内 X 红 / Y 蓝）优先于网格线 */
  vec2 px = fwidth(vW.xy);
  float axX = 1.0 - min(abs(vW.y) / (px.y * 1.2), 1.0);
  float axY = 1.0 - min(abs(vW.x) / (px.x * 1.2), 1.0);
  if (axX > 0.0 || axY > 0.0) {
    col = axX >= axY ? uAxisX : uAxisY;
    alpha = max(alpha, max(axX, axY) * 0.8);
  }

  float d = length(vW.xy - uCam.xy);
  alpha *= clamp(1.0 - d / uFade, 0.0, 1.0);
  vec3 V = normalize(uCam - vW);
  alpha *= 1.0 - pow(1.0 - abs(V.z), 3.0);  /* 掠射角淡出；abs → 地面下方对称可见 */
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col, alpha);
}`;

function GroundGrid({ rig }: { rig: CameraRig }) {
  const invalidate = useThree((s) => s.invalidate);
  const mesh = React.useRef<THREE.Mesh>(null);
  const mat = React.useMemo(() => new THREE.ShaderMaterial({
    vertexShader: GRID_VERT,
    fragmentShader: GRID_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide, /* 相机低于地面时仍渲染（默认 FrontSide 会整面背剔，地下视角网格消失） */
    uniforms: {
      uCam: { value: new THREE.Vector3() },
      uLevel: { value: 0 },
      uFade: { value: 40 },
      uMinorA: { value: 0.05 },   /* = CSS .gw-grid-l */
      uMajorA: { value: 0.09 },   /* = CSS .gw-grid-l.maj */
      uAxisX: { value: new THREE.Color('#c74436') },
      uAxisY: { value: new THREE.Color('#3f74c4') },
    },
  }), []);
  React.useEffect(() => () => { mat.dispose(); }, [mat]);
  React.useEffect(() => {
    const update = () => {
      const m = mesh.current;
      if (!m) return;
      const cam = rig.camera;
      const fade = Math.max(20, Math.min(800, rig.dist * 4));
      m.position.set(cam.position.x, cam.position.y, 0);
      m.scale.set(fade * 2.2, fade * 2.2, 1);
      mat.uniforms.uCam.value.copy(cam.position);
      mat.uniforms.uFade.value = fade;
      mat.uniforms.uLevel.value = Math.max(-3, Math.min(4, Math.log10(Math.max(0.5, rig.dist) * 0.06)));
      invalidate();
    };
    update();
    return rig.onChange(update);
  }, [rig, mat, invalidate]);
  return (
    <mesh ref={mesh} renderOrder={50} material={mat} frustumCulled={false}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

/* ---------- 箱体场景 ---------- */

export interface SceneEntry {
  id: string;
  isActive: boolean;
  boxes: PickBox[];
  ghostBoxes: PickBox[] | null;
  provByKey: Record<string, string> | null;  /* key → measured/interpolated/extrapolated 颜色 */
  cutout: boolean;                            /* masked 块按镂空渲染（否则半透明填充） */
  patternUrl: string | null;
  normalSign: number;                         /* normal_flip → -1 */
  selKeys: string[];                          /* 选中箱体 key（激活屏才非空） */
}
export interface SceneData {
  entries: SceneEntry[];
  showGround: boolean;
  selColor: string;
}

const BOX_FILL = new THREE.Color('#45464a');
const MASK_FILL = new THREE.Color('rgb(120,124,134)');
const HOVER_FILL = new THREE.Color('#4e5054');

function boxFrontNormal(b: PickBox, sign: number): THREE.Vector3 {
  const dx = b.corners[1].x - b.corners[0].x, dy = b.corners[1].y - b.corners[0].y;
  const len = Math.hypot(dx, dy) || 1;
  return new THREE.Vector3((sign * -dy) / len, (sign * dx) / len, 0);
}

interface ScreenGeo {
  solid: THREE.BufferGeometry;
  edges: THREE.BufferGeometry | null;
  dashed: THREE.BufferGeometry | null;   /* masked 边框（虚线）；镂空块也在此 */
  pattern: THREE.BufferGeometry | null;
  sel: THREE.BufferGeometry | null;
  pick: THREE.BufferGeometry;
  pickBoxes: PickBox[];
}

function pushQuad(pos: number[], idx: number[], corners: { x: number; y: number; z: number }[], flip: boolean) {
  const base = pos.length / 3;
  corners.forEach((p) => pos.push(p.x, p.y, p.z));
  if (flip) idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  else idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
function pushEdges(arr: number[], c: { x: number; y: number; z: number }[]) {
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    arr.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}
function geomFrom(pos: number[], idx?: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (idx) g.setIndex(idx);
  return g;
}

function buildScreenGeo(e: SceneEntry): ScreenGeo {
  const solidPos: number[] = [], solidIdx: number[] = [], solidCol: number[] = [];
  const edgePos: number[] = [], dashPos: number[] = [], selPos: number[] = [];
  const patPos: number[] = [], patIdx: number[] = [], patUv: number[] = [];
  const pickPos: number[] = [], pickIdx: number[] = [];
  const pickBoxes: PickBox[] = [];
  const selSet = new Set(e.selKeys);
  const cols = e.boxes.reduce((m, b) => Math.max(m, b.c + 1), 1);
  const rows = e.boxes.reduce((m, b) => Math.max(m, b.r + 1), 1);

  e.boxes.forEach((b) => {
    pushQuad(pickPos, pickIdx, b.corners, false);
    pickBoxes.push(b);
    if (b.masked && e.cutout) {
      pushEdges(dashPos, b.corners); /* 镂空：只留虚线边框（= CSS .gw-box--cut） */
    } else {
      const col = b.masked ? MASK_FILL : (e.provByKey && e.provByKey[b.key] ? new THREE.Color(e.provByKey[b.key]) : BOX_FILL);
      const a = b.masked ? 0.28 : 1;
      for (let i = 0; i < 4; i++) solidCol.push(col.r, col.g, col.b, a);
      pushQuad(solidPos, solidIdx, b.corners, false);
      pushEdges(b.masked ? dashPos : edgePos, b.corners);
      if (!b.masked && e.patternUrl) {
        /* 前面 = LED 出光面（含 normal_flip）；纹理只贴前面，背面露底色（= 旧 faceToCamera 行为） */
        const n = boxFrontNormal(b, e.normalSign);
        const e1 = _v1.set(b.corners[1].x - b.corners[0].x, b.corners[1].y - b.corners[0].y, b.corners[1].z - b.corners[0].z);
        const e2 = _v2.set(b.corners[3].x - b.corners[0].x, b.corners[3].y - b.corners[0].y, b.corners[3].z - b.corners[0].z);
        const geoN = _v3.crossVectors(e1, e2);
        pushQuad(patPos, patIdx, b.corners, geoN.dot(n) < 0);
        /* three 纹理原点在左下 + 生成图 row0 在墙顶：双翻转相消 → v 直接用 r/rows */
        const u0 = b.c / cols, u1 = (b.c + 1) / cols, v0 = b.r / rows, v1 = (b.r + 1) / rows;
        patUv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      }
    }
    if (selSet.has(b.key)) pushEdges(selPos, b.corners);
  });

  const solid = geomFrom(solidPos, solidIdx);
  solid.setAttribute('color', new THREE.Float32BufferAttribute(solidCol, 4));
  let pattern: THREE.BufferGeometry | null = null;
  if (patPos.length) {
    pattern = geomFrom(patPos, patIdx);
    pattern.setAttribute('uv', new THREE.Float32BufferAttribute(patUv, 2));
  }
  return {
    solid,
    edges: edgePos.length ? geomFrom(edgePos) : null,
    dashed: dashPos.length ? geomFrom(dashPos) : null,
    pattern,
    sel: selPos.length ? geomFrom(selPos) : null,
    pick: geomFrom(pickPos, pickIdx),
    pickBoxes,
  };
}

function disposeGeo(g: ScreenGeo) {
  g.solid.dispose(); g.pick.dispose();
  g.edges?.dispose(); g.dashed?.dispose(); g.pattern?.dispose(); g.sel?.dispose();
}

function ghostGeoFrom(boxes: PickBox[]): THREE.BufferGeometry {
  const pos: number[] = [];
  boxes.forEach((b) => pushEdges(pos, b.corners));
  return geomFrom(pos);
}

function ScreenObjects({ e, store, selColor }: { e: SceneEntry; store: SceneStore; selColor: string }) {
  const invalidate = useThree((s) => s.invalidate);
  const geo = React.useMemo(() => buildScreenGeo(e), [e]);
  const ghostGeo = React.useMemo(() => (e.ghostBoxes ? ghostGeoFrom(e.ghostBoxes) : null), [e.ghostBoxes]);
  React.useEffect(() => () => { disposeGeo(geo); }, [geo]);
  React.useEffect(() => () => { ghostGeo?.dispose(); }, [ghostGeo]);

  const dimOpacity = e.isActive ? 1 : 0.38; /* = CSS .gw-box--dim */
  const solidMat = React.useMemo(() => new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, side: THREE.DoubleSide,
  }), []);
  solidMat.opacity = dimOpacity;
  const edgeMat = React.useMemo(() => new THREE.LineBasicMaterial({ color: 0x000000, transparent: true }), []);
  edgeMat.opacity = 0.4 * dimOpacity;
  const dashMat = React.useMemo(() => new THREE.LineDashedMaterial({
    color: 0xffffff, transparent: true, dashSize: 0.05, gapSize: 0.05,
  }), []);
  dashMat.opacity = 0.25 * dimOpacity;
  const ghostMat = React.useMemo(() => new THREE.LineDashedMaterial({
    color: new THREE.Color('rgb(120,180,255)'), transparent: true, opacity: 0.5, dashSize: 0.04, gapSize: 0.04,
  }), []);
  const selMat = React.useMemo(() => new THREE.LineBasicMaterial({ color: new THREE.Color(selColor) }), [selColor]);
  React.useEffect(() => () => {
    solidMat.dispose(); edgeMat.dispose(); dashMat.dispose(); ghostMat.dispose(); selMat.dispose();
  }, [solidMat, edgeMat, dashMat, ghostMat, selMat]);

  const [patTex, setPatTex] = React.useState<THREE.Texture | null>(null);
  React.useEffect(() => {
    if (!e.patternUrl || !geo.pattern) { setPatTex(null); return; }
    let live = true;
    const tex = new THREE.TextureLoader().load(e.patternUrl, () => { if (live) invalidate(); });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    setPatTex(tex);
    return () => { live = false; tex.dispose(); };
  }, [e.patternUrl, geo.pattern, invalidate]);
  const patMat = React.useMemo(() => (patTex ? new THREE.MeshBasicMaterial({
    map: patTex, transparent: true, opacity: 0.5, side: THREE.FrontSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  }) : null), [patTex]);
  React.useEffect(() => () => { patMat?.dispose(); }, [patMat]);

  const pickRef = React.useRef<THREE.Mesh>(null);
  React.useEffect(() => {
    const m = pickRef.current;
    if (!m) return;
    m.userData = { entryId: e.id, boxes: geo.pickBoxes };
    store.pickMeshes.push(m);
    invalidate();
    return () => { const i = store.pickMeshes.indexOf(m); if (i >= 0) store.pickMeshes.splice(i, 1); };
  }, [e.id, geo, store, invalidate]);

  /* LineDashedMaterial 需要 lineDistance 属性 → 对象在 memo 里建一次并 computeLineDistances */
  const dashSegs = React.useMemo(() => {
    if (!geo.dashed) return null;
    const ls = new THREE.LineSegments(geo.dashed, dashMat);
    ls.computeLineDistances();
    return ls;
  }, [geo.dashed, dashMat]);
  const ghostSegs = React.useMemo(() => {
    if (!ghostGeo) return null;
    const ls = new THREE.LineSegments(ghostGeo, ghostMat);
    ls.computeLineDistances();
    return ls;
  }, [ghostGeo, ghostMat]);

  return (
    <group>
      <mesh geometry={geo.solid} material={solidMat} />
      {geo.edges ? <lineSegments geometry={geo.edges} material={edgeMat} /> : null}
      {dashSegs ? <primitive object={dashSegs} /> : null}
      {ghostSegs ? <primitive object={ghostSegs} /> : null}
      {geo.pattern && patMat ? <mesh geometry={geo.pattern} material={patMat} /> : null}
      {geo.sel ? <lineSegments geometry={geo.sel} material={selMat} renderOrder={5} /> : null}
      <mesh ref={pickRef} geometry={geo.pick} material={PICK_MAT} visible={false} />
    </group>
  );
}

/** hover 高亮块：单独一块 quad 由指针逻辑命令式更新（避免 hover 触发整树重渲）。 */
function HoverQuad({ store }: { store: SceneStore }) {
  const invalidate = useThree((s) => s.invalidate);
  const mesh = React.useRef<THREE.Mesh>(null);
  const geo = React.useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }, []);
  const mat = React.useMemo(() => new THREE.MeshBasicMaterial({
    color: HOVER_FILL, transparent: true, opacity: 0.5, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), []);
  React.useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  React.useEffect(() => {
    store.setHover = (hit) => {
      const m = mesh.current;
      if (!m) return;
      if (!hit) { if (m.visible) { m.visible = false; invalidate(); } return; }
      const attr = geo.getAttribute('position') as THREE.BufferAttribute;
      hit.box.corners.forEach((p, i) => attr.setXYZ(i, p.x, p.y, p.z));
      attr.needsUpdate = true;
      geo.computeBoundingSphere();
      m.visible = true;
      invalidate();
    };
    return () => { store.setHover = () => {}; };
  }, [store, geo, invalidate]);
  return <mesh ref={mesh} geometry={geo} material={mat} visible={false} />;
}

/** 世界竖直轴（绿，0→2m）：面内红/蓝轴已入网格 shader，绿轴保留为方向锚。 */
function VerticalAxis() {
  const geo = React.useMemo(() => geomFrom([0, 0, 0, 0, 0, 2]), []);
  const mat = React.useMemo(() => new THREE.LineBasicMaterial({
    color: new THREE.Color('#3f9c46'), transparent: true, opacity: 0.8,
  }), []);
  React.useEffect(() => () => { geo.dispose(); mat.dispose(); }, [geo, mat]);
  return <lineSegments geometry={geo} material={mat} renderOrder={49} />;
}

function RigBridge({ rig }: { rig: CameraRig }) {
  const set = useThree((s) => s.set);
  const invalidate = useThree((s) => s.invalidate);
  const size = useThree((s) => s.size);
  const [orthoTick, setOrthoTick] = React.useState(rig.ortho);
  React.useEffect(() => { rig.setSize(size.width, size.height); }, [rig, size.width, size.height]);
  React.useEffect(() => {
    set({ camera: rig.camera as unknown as THREE.PerspectiveCamera });
  }, [set, rig, orthoTick]);
  React.useEffect(() => rig.onChange(() => {
    setOrthoTick(rig.ortho);
    invalidate();
  }), [rig, invalidate]);
  return null;
}

export function SceneCanvas({ rig, data, store }: { rig: CameraRig; data: SceneData; store: SceneStore }) {
  return (
    <Canvas
      frameloop="demand"
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ position: 'absolute', inset: 0 }}
      onCreated={(state) => { store.invalidate = state.invalidate; }}
    >
      <RigBridge rig={rig} />
      {data.showGround ? <GroundGrid rig={rig} /> : null}
      {data.showGround ? <VerticalAxis /> : null}
      {data.entries.map((e) => <ScreenObjects key={e.id} e={e} store={store} selColor={data.selColor} />)}
      <HoverQuad store={store} />
    </Canvas>
  );
}
