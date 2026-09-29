import * as THREE from 'three';
import { FAMILIES } from '../render/families.js';
import { PALETTES } from '../render/palettes.js';
import { skinDepth, bakeSkinDepth, setSkinDepth, bodyFs, CLUMPS, ALIVE } from '../house/sdf.js';

// GRASS — the same house as a sculpture of living turf over soil. Blades
// stand on the skin only (they taper, sway, glow when backlit); a hand's
// depth below is the root mat, and under it dark earth with strata, crumbs
// and pale roots — what a tear lays open. A torn clump is a sod: a few
// short roots snap, soil and loose blades rain from the break, and the sod
// is heavy — it drops, thuds and settles on the ground. Loaded only when
// chosen; a fresher sky and a few pollen motes come with it.

// its materials: registered into the shared family table on load
const GRASS_FAMILIES = {
  meadow: {
    label: 'Meadow',
    color: '#9ab47a', roughness: 0.95, sheen: 0.3, sheenColor: '#efffd6', sheenRoughness: 0.6,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.45, sssColor: '#dff3a8', glow: 0.0, micro: 5, microAmp: 0.28, microScale: 7, stylize: 1, fiber: 0.15,
    opacity: 1, fuzz: 0.34, fuzzDensity: 1.25, fuzzFiber: 0.55, grass: 1,
  },
  moss: {
    label: 'Moss',
    color: '#7f9a63', roughness: 0.97, sheen: 0.4, sheenColor: '#e4f5c8', sheenRoughness: 0.7,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.35, sssColor: '#cfe6a0', glow: 0.0, micro: 5, microAmp: 0.42, microScale: 10, stylize: 1, fiber: 0.3,
    opacity: 1, fuzz: 0.12, fuzzDensity: 1.4, fuzzFiber: 1.1, grass: 1,
  },
  wild: {
    label: 'Wild grass',
    color: '#adb67e', roughness: 0.94, sheen: 0.25, sheenColor: '#fff6d6', sheenRoughness: 0.6,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.55, sssColor: '#f1ecb0', glow: 0.0, micro: 5, microAmp: 0.22, microScale: 5, stylize: 1, fiber: 0.1,
    opacity: 1, fuzz: 0.46, fuzzDensity: 1.0, fuzzFiber: 0.45, grass: 1,
  },
};

// its sky: fresh daylight, a little warmer sun, sage shadows
const MEADOW_SKY = {
  label: 'Meadow', hidden: true,
  air: { zenith: '#a6c6e2', horizon: '#eef0de', ground: '#dfe3c8', sun: '#fff0cc', glow: '#ffd98e', word: '#98a384', lit: '#fff5d8', shade: '#a3b6a2', rim: '#f4fbe2' },
  tint: { ...PALETTES.cloud.tint },
  accent: '#c9d98f',
};

const swatch = {
  meadow: 'radial-gradient(circle at 35% 30%, #e6f2c8, #9cbd73 55%, #5f8446)',
  moss: 'radial-gradient(circle at 35% 30%, #cfe0ae, #7d9d5b 55%, #4b6b3a)',
  wild: 'radial-gradient(circle at 35% 30%, #f2eec8, #b2bd78 55%, #7c8c4c)',
};

// pollen: a few motes drifting in the sun — all motion is in the shader
function makePollen(count = 140) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3), seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 18;
    pos[i * 3 + 1] = Math.random() * 11;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 13;
    seed[i] = Math.random();
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color('#fff4c6') }, uFade: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float uTime;
      varying float vA;
      void main(){
        vec3 p = position;
        float t = uTime * (0.05 + seed * 0.05);
        p.y = mod(p.y + t * 3.0, 11.0);
        p.x += sin(uTime * 0.23 + seed * 31.0) * 0.6 + uTime * 0.05;
        p.z += cos(uTime * 0.19 + seed * 17.0) * 0.5;
        p.x = mod(p.x + 9.0, 18.0) - 9.0;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (1.5 + seed * 2.5) * 60.0 / -mv.z;
        vA = (0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * 1.3 + seed * 40.0))) * smoothstep(0.0, 1.5, p.y) * smoothstep(11.0, 9.0, p.y);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uFade;
      varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.55 * uFade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  return pts;
}

// --- the soil under the turf ----------------------------------------------------
// depth below the untouched house's outer skin (sdf.js bakes it: the room
// and attic are voids inside the shell, so they count as deep), put into a
// small 3D texture. Body and blades read it to know where turf ends and earth
// begins — on the house, inside a hollow or the room, and on a torn piece.
function bakeDepth() {
  const S = bakeSkinDepth();
  const data = new Uint8Array(S.depth.length);
  // stored as 0.5 - depth/2: the shader reads depth within ±1 m of the skin
  for (let q = 0; q < data.length; q++) data[q] = Math.max(0, Math.min(255, Math.round((0.5 - S.depth[q] / 2) * 255)));
  const tex = new THREE.Data3DTexture(data, S.n[0], S.n[1], S.n[2]);
  tex.format = THREE.RedFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// --- debris: soil crumbs, dust, loose blades, little bits of sod -------------------
// one small pool per shape in the world frame, plain ballistic motion: they
// fall, knock off the house, bounce once on the ground, lie a moment and
// shrink away. Only bursts — nothing is emitted continuously.
const SOIL = ['#5b4331', '#6e5139', '#80603f', '#4a3627', '#8f7150'].map((c) => new THREE.Color(c));
const DUST = ['#8a7258', '#9c8466', '#7a634b'].map((c) => new THREE.Color(c));
const LEAF = ['#7f9c5a', '#95b268', '#a9bb72', '#6b8a4c'].map((c) => new THREE.Color(c));
const WHITE = [new THREE.Color('#ffffff')];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const M = new THREE.Matrix4(), INV = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
const N = new THREE.Vector3(), A = new THREE.Vector3(), S = new THREE.Vector3(), L = new THREE.Vector3();
const W = new THREE.Vector3(), D = new THREE.Vector3();

// per kind: pool size, size range (m), air drag, gravity, bounce, life (s)
const KINDS = {
  // tap: its landings are heard (dust and blades fall silently)
  crumb: { n: 130, s: [0.045, 0.13], drag: 0.35, g: 9.8, bounce: 0.28, life: [2.6, 4.8], pal: SOIL, tap: true },
  dust: { n: 90, s: [0.012, 0.028], drag: 2.8, g: 6.5, bounce: 0.1, life: [1.6, 2.8], pal: DUST },
  blade: { n: 60, s: [0.22, 0.42], drag: 2.2, g: 5.5, bounce: 0.15, life: [2.6, 4.8], pal: LEAF },
  sod: { n: 12, s: [0.09, 0.14], drag: 0.3, g: 9.8, bounce: 0.2, life: [4.0, 5.5], pal: WHITE, tap: true },
};

function bladeGeometry() {
  // a thin tapered blade, 1 m tall (scaled down per instance), a little bent
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-0.05, 0, 0, 0.05, 0, 0, -0.03, 0.5, 0.06, 0.03, 0.5, 0.06, 0, 1, 0.16], 3));
  g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
  g.computeVertexNormals();
  return g;
}

// a thumb-sized bit of sod: a squat clod, green on top, earth below
function sodBitGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position;
  const col = new Float32Array(p.count * 3);
  const top = new THREE.Color('#86a85c'), mid = new THREE.Color('#5c4a30'), low = new THREE.Color('#4a3627');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setXYZ(i, p.getX(i) * (1 + Math.sin(i * 7.1) * 0.12), y * 0.55, p.getZ(i) * (1 + Math.cos(i * 5.3) * 0.12));
    c.copy(y > 0.35 ? top : y > 0.05 ? mid : low);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

class Debris {
  constructor(scene, container) {
    this.container = container;
    const mk = (geo, n, side, vertexColors = false) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, side, vertexColors }), n);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.visible = false;
      for (let i = 0; i < n; i++) { m.setMatrixAt(i, ZERO); m.setColorAt(i, WHITE[0]); }
      scene.add(m);
      return m;
    };
    // a lump of earth: an uneven, soft-edged clod (not a faceted gem)
    const rock = new THREE.IcosahedronGeometry(1, 1);
    {
      const p = rock.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const k = 0.78 + 0.22 * Math.sin(v.x * 5.1 + v.y * 3.7) * Math.cos(v.z * 4.3 - v.y * 2.1) + 0.12 * Math.sin(v.x * 11.0 + v.z * 9.0);
        p.setXYZ(i, v.x * k, v.y * k * 0.8, v.z * k);
      }
      rock.computeVertexNormals();
    }
    this.sets = {};
    for (const [kind, K] of Object.entries(KINDS)) {
      const geo = kind === 'blade' ? bladeGeometry() : kind === 'sod' ? sodBitGeometry() : rock;
      const mesh = mk(geo, K.n, kind === 'blade' ? THREE.DoubleSide : THREE.FrontSide, kind === 'sod');
      const list = Array.from({ length: K.n }, () => ({
        live: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(),
        s: 0, age: 0, life: 0,
      }));
      this.sets[kind] = { K, mesh, list, next: 0 };
    }
    this.meshes = Object.values(this.sets).map((s) => s.mesh);
    this.setList = Object.entries(this.sets).map(([kind, v]) => ({ kind, ...v })); // (for the per-frame loop)
    this.alive = 0;
    this.cool = 0;
    this.hitN = 0; this.hitAt = new THREE.Vector3(); this.hitV = 0;
    this.onHits = null;
  }

  // at: world point; dir: the way the burst is thrown; mix: how many of each kind
  burst(at, dir, mix, spread, speed) {
    for (const [kind, count] of Object.entries(mix)) {
      const set = this.sets[kind], K = set.K;
      for (let n = 0; n < count; n++) {
        // round-robin: when the pool is full the oldest goes first
        const i = set.next; set.next = (i + 1) % set.list.length;
        const d = set.list[i];
        if (!d.live) this.alive++;
        d.live = true;
        d.p.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spread).add(at);
        const sp = kind === 'dust' ? speed * 0.5 : kind === 'sod' ? speed * 0.7 : speed;
        d.v.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(sp * 1.4)
          .addScaledVector(dir, sp * (0.4 + Math.random() * 0.8));
        d.q.setFromEuler(E.set(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
        // a bit of sod mostly falls turf side up, turning slowly
        if (kind === 'sod') d.q.setFromEuler(E.set((Math.random() - 0.5) * 0.8, Math.random() * 6.3, (Math.random() - 0.5) * 0.8));
        d.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(kind === 'blade' ? 14 : kind === 'sod' ? 3 : 9);
        d.s = K.s[0] + (K.s[1] - K.s[0]) * (kind === 'crumb' ? Math.random() * Math.random() : Math.random());
        d.age = 0;
        d.life = K.life[0] + Math.random() * (K.life[1] - K.life[0]);
        set.mesh.setColorAt(i, K.pal[(Math.random() * K.pal.length) | 0]);
        set.mesh.instanceColor.needsUpdate = true;
      }
      if (count) set.mesh.visible = true;
    }
  }

  update(dt) {
    if (!this.alive) return;
    // the house is solid to debris too: its field lives in the house frame
    INV.copy(this.container.matrixWorld).invert();
    let alive = 0;
    for (const { kind, K, list, mesh } of this.setList) {
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const d = list[i];
        if (!d.live) continue;
        d.age += dt;
        if (d.age > d.life) { d.live = false; mesh.setMatrixAt(i, ZERO); continue; }
        alive++; any = true;
        const r = kind === 'blade' ? 0.015 : kind === 'sod' ? d.s * 0.55 : d.s;
        d.v.multiplyScalar(Math.exp(-dt * K.drag));
        d.v.y -= K.g * dt;
        d.p.addScaledVector(d.v, dt);
        L.copy(d.p).applyMatrix4(INV);
        const f = bodyFs(L.x, L.y, L.z);
        if (f < r) {
          const e = 0.04;
          N.set(bodyFs(L.x + e, L.y, L.z) - f, bodyFs(L.x, L.y + e, L.z) - f, bodyFs(L.x, L.y, L.z + e) - f);
          if (N.lengthSq() > 1e-12) {
            N.normalize().transformDirection(this.container.matrixWorld);
            d.p.addScaledVector(N, r - f);
            const vn = d.v.dot(N);
            if (vn < -1 && K.tap) this._hit(d.p, -vn);
            if (vn < 0) d.v.addScaledVector(N, -vn * (1 + K.bounce));
            d.v.multiplyScalar(0.7);
            d.w.multiplyScalar(0.6);
          }
        }
        // the ground: a small bounce, then it lies there
        if (d.p.y < r) {
          d.p.y = r;
          if (d.v.y < -1 && K.tap) this._hit(d.p, -d.v.y);
          if (d.v.y < 0) d.v.y = d.v.y < -1.2 ? -d.v.y * K.bounce : 0;
          const k = Math.exp(-dt * 9);
          d.v.x *= k; d.v.z *= k;
          d.w.multiplyScalar(Math.exp(-dt * 10));
        }
        const wl = d.w.length();
        if (wl > 1e-4) d.q.premultiply(Q.setFromAxisAngle(A.copy(d.w).divideScalar(wl), wl * dt));
        // shrinks away at the end of its life
        S.setScalar(d.s * (1 - THREE.MathUtils.smoothstep(d.age, d.life - 0.9, d.life)));
        mesh.setMatrixAt(i, M.compose(d.p, d.q, S));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (!any) mesh.visible = false;
    }
    this.alive = alive;
    // grains that struck this frame, for whoever listens (sound)
    if (this.hitN) { this.onHits?.(this.hitN, this.hitAt.divideScalar(this.hitN), this.hitV); this.hitN = 0; }
  }
  _hit(p, v) {
    if (!this.hitN) { this.hitAt.set(0, 0, 0); this.hitV = 0; }
    this.hitN++;
    this.hitAt.add(p);
    this.hitV = Math.max(this.hitV, v);
  }
}

// --- roots hanging from a torn sod -----------------------------------------------
// short root ends where the sod tore out of the earth: a few thicker ones,
// many fine ones, soil still caked at their base, drooping under the clod.
// Built once per tear as thin tapered tubes, a child of the piece.
const ROOT_MAT = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, vertexColors: true });
const ROOT_BASE = new THREE.Color('#3f2e20'), ROOT_MID = new THREE.Color('#6f583f'), ROOT_TIP = new THREE.Color('#a48b69');

function makeRoots(piece, turfDir) {
  const geo = piece.mesh.geometry;
  const P = geo.attributes.position, Nn = geo.attributes.normal;
  const c = piece.clump.c;
  // where it tore: vertices on the underside, deep below the old skin
  const cand = [];
  const n = new THREE.Vector3();
  const step = Math.max(1, Math.floor(P.count / 900));
  for (let i = 0; i < P.count; i += step) {
    n.fromBufferAttribute(Nn, i);
    const facing = n.dot(turfDir);
    if (facing > -0.15) continue;
    if (skinDepth(P.getX(i) + c[0], P.getY(i) + c[1], P.getZ(i) + c[2]) < 0.12) continue;
    cand.push(i);
  }
  if (!cand.length) return null;
  const count = Math.min(34, 18 + Math.round(piece.clump.rad * 12));
  const RAD = 4, SEGS = 7;
  const pos = [], col = [], idx = [];
  const down = new THREE.Vector3(0, -1, 0).multiplyScalar(0.6).addScaledVector(turfDir, -0.4).normalize();
  const p = new THREE.Vector3(), dir = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), jig = new THREE.Vector3();
  const colr = new THREE.Color();
  for (let r = 0; r < count; r++) {
    const vi = cand[(Math.random() * cand.length) | 0];
    const thick = r < 4;
    const len = thick ? 0.3 + Math.random() * 0.22 : 0.14 + Math.random() * 0.28;
    const w0 = thick ? 0.02 + Math.random() * 0.008 : 0.006 + Math.random() * 0.005;
    n.fromBufferAttribute(Nn, vi);
    // the torn surface is lifted by its relief in the shader: start just
    // outside the smooth one, the caked base hides the join
    p.fromBufferAttribute(P, vi).addScaledVector(n, 0.02);
    dir.copy(n).multiplyScalar(0.55).addScaledVector(down, 0.45).normalize();
    const base = pos.length / 3;
    for (let s = 0; s <= SEGS; s++) {
      const t = s / SEGS;
      if (s > 0) {
        // fine roots kink and curl; the thick ones bend more gently
        jig.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(thick ? 0.45 : 0.9);
        dir.addScaledVector(down, 0.22).add(jig).normalize();
        p.addScaledVector(dir, len / SEGS);
      }
      // a frame around the direction
      t1.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize();
      t2.crossVectors(dir, t1);
      // soil caked on the first third, then the bare root tapering off
      const w = w0 * (1 - t * 0.85) * (t < 0.25 ? 2.2 - t * 4.8 : 1);
      colr.copy(t < 0.3 ? ROOT_BASE : ROOT_MID).lerp(t < 0.3 ? ROOT_MID : ROOT_TIP, t < 0.3 ? t / 0.3 : (t - 0.3) / 0.7);
      for (let k = 0; k < RAD; k++) {
        const a = (k / RAD) * Math.PI * 2;
        pos.push(p.x + (t1.x * Math.cos(a) + t2.x * Math.sin(a)) * w, p.y + (t1.y * Math.cos(a) + t2.y * Math.sin(a)) * w, p.z + (t1.z * Math.cos(a) + t2.z * Math.sin(a)) * w);
        col.push(colr.r, colr.g, colr.b);
      }
      if (s > 0) {
        const a0 = base + (s - 1) * RAD, a1 = base + s * RAD;
        for (let k = 0; k < RAD; k++) {
          const k1 = (k + 1) % RAD;
          idx.push(a0 + k, a1 + k, a0 + k1, a0 + k1, a1 + k, a1 + k1);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, ROOT_MAT);
  mesh.castShadow = true;
  mesh.raycast = () => {};
  mesh.userData.dispose = () => g.dispose();
  return mesh;
}

// --- fresh holes: the earth round a tear settles, then keeps still ----------------
// Up to four at a time, each a slot in the body's uniforms (uSag/uSagK): the rim
// sinks a few cm under gravity, the turf round it keels over the torn edge (with
// a little flop), a few late clods and crumbs drop from the rim during the first
// second or so, and a handful of torn root ends hang from the rim and droop.
// Then it all stops and stays. A hole that closes again (Reassemble) lets go.
const RIM_ROOT_MAT_BASE = { roughness: 1, metalness: 0, vertexColors: true };

function makeRimRoots(center, n, R) {
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3();
  t1.set(Math.abs(n.y) < 0.9 ? 0 : 1, Math.abs(n.y) < 0.9 ? 1 : 0, 0).cross(n).normalize();
  t2.crossVectors(n, t1);
  const pos = [], col = [], sag = [], idx = [];
  const RAD = 4, SEGS = 6;
  const p = new THREE.Vector3(), dir = new THREE.Vector3(), a1 = new THREE.Vector3(), a2 = new THREE.Vector3(), jig = new THREE.Vector3(), s = new THREE.Vector3();
  const colr = new THREE.Color();
  const count = 7 + Math.round(R * 6);
  for (let r = 0; r < count; r++) {
    // a point on the rim, found on the surface by walking in along the normal
    const ang = Math.random() * Math.PI * 2;
    s.copy(center).addScaledVector(t1, Math.cos(ang) * R * 0.92).addScaledVector(t2, Math.sin(ang) * R * 0.92).addScaledVector(n, 0.45);
    let ok = false;
    for (let k = 0; k < 28; k++) {
      const d = bodyFs(s.x, s.y, s.z);
      if (Math.abs(d) < 0.01) { ok = true; break; }
      s.addScaledVector(n, -d * 0.9);
    }
    if (!ok) continue;
    const thick = r < 2;
    const len = thick ? 0.16 + Math.random() * 0.14 : 0.07 + Math.random() * 0.16;
    const w0 = thick ? 0.011 + Math.random() * 0.005 : 0.003 + Math.random() * 0.003;
    // they stick out of the torn edge, over the hole
    p.copy(s).addScaledVector(n, -0.03);
    dir.copy(center).sub(s).addScaledVector(n, -dir.dot(n)).normalize().multiplyScalar(0.8).addScaledVector(n, 0.25).normalize();
    const base = pos.length / 3;
    for (let q = 0; q <= SEGS; q++) {
      const t = q / SEGS;
      if (q > 0) {
        jig.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.7);
        dir.add(jig).normalize();
        p.addScaledVector(dir, len / SEGS);
      }
      a1.set(Math.abs(dir.y) < 0.9 ? 0 : 1, Math.abs(dir.y) < 0.9 ? 1 : 0, 0).cross(dir).normalize();
      a2.crossVectors(dir, a1);
      const w = w0 * (1 - t * 0.85) * (t < 0.25 ? 1.8 - t * 3.2 : 1);
      colr.copy(t < 0.3 ? ROOT_BASE : ROOT_MID).lerp(t < 0.3 ? ROOT_MID : ROOT_TIP, t < 0.3 ? t / 0.3 : (t - 0.3) / 0.7);
      for (let k = 0; k < RAD; k++) {
        const an = (k / RAD) * Math.PI * 2;
        pos.push(p.x + (a1.x * Math.cos(an) + a2.x * Math.sin(an)) * w, p.y + (a1.y * Math.cos(an) + a2.y * Math.sin(an)) * w, p.z + (a1.z * Math.cos(an) + a2.z * Math.sin(an)) * w);
        col.push(colr.r, colr.g, colr.b);
        sag.push(t * t * len * 0.8); // how far this point falls when the root droops
      }
      if (q > 0) {
        const b0 = base + (q - 1) * RAD, b1 = base + q * RAD;
        for (let k = 0; k < RAD; k++) {
          const k1 = (k + 1) % RAD;
          idx.push(b0 + k, b1 + k, b0 + k1, b0 + k1, b1 + k, b1 + k1);
        }
      }
    }
  }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSag', new THREE.Float32BufferAttribute(sag, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mat = rimRootMaterial();
  const uDroop = mat.userData.uDroop;
  const mesh = new THREE.Mesh(g, mat);
  mesh.raycast = () => {};
  mesh.userData.droop = uDroop;
  mesh.userData.dispose = () => { g.dispose(); mat.dispose(); };
  return mesh;
}

// torn root ends at a rim: droop is a vertex shift (each hole owns its
// material, the program is shared)
function rimRootMaterial() {
  const uDroop = { value: 0 };
  const mat = new THREE.MeshStandardMaterial(RIM_ROOT_MAT_BASE);
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDroop = uDroop;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSag;\nuniform float uDroop;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y -= aSag * uDroop;');
  };
  mat.customProgramCacheKey = () => 'rim-roots';
  mat.userData.uDroop = uDroop;
  return mat;
}

class Wounds {
  constructor(body, container, debris) {
    this.body = body;
    this.container = container;
    this.debris = debris;
    this.slots = [null, null, null, null];
    this.next = 0;
  }

  // a clump just tore out (p: the pull)
  open(p) {
    let i = this.slots.findIndex((s) => !s);
    if (i < 0) { i = this.next; this.next = (this.next + 1) % 4; this._free(i); }
    const c = p.clump;
    const center = new THREE.Vector3().fromArray(c.c);
    const n = p.normal.clone().normalize();
    const R = c.rad * 1.05;
    const s = {
      clump: c, center, n, R, age: 0,
      sag: 0, sagMax: 0.028 + R * 0.02,
      lean: 0, leanV: 0,
      drops: Array.from({ length: 4 + Math.round(R * 3) }, () => 0.12 + Math.random() * 1.3).sort((a, b) => a - b),
      roots: makeRimRoots(center, n, R),
      droop: 0, droopV: 0,
      closing: false,
    };
    if (s.roots) this.container.add(s.roots);
    this.slots[i] = s;
    this.body.u.uSag.value[i].set(center.x, center.y, center.z, R);
    this.body.u.uSagK.value[i].set(0, 0, 0, 0);
  }

  _free(i) {
    const s = this.slots[i];
    if (!s) return;
    if (s.roots) { this.container.remove(s.roots); s.roots.userData.dispose(); }
    this.slots[i] = null;
    this.body.u.uSagK.value[i].set(0, 0, 0, 0);
  }

  // active: the turf world is showing (else everything relaxes away)
  update(dt, active) {
    let busy = false;
    for (let i = 0; i < 4; i++) {
      const s = this.slots[i];
      if (!s) continue;
      s.age += dt;
      // the hole closed again (Reassemble): let go of it
      if (!s.closing && s.clump.ids.some((q) => ALIVE[q])) s.closing = true;
      const on = active && !s.closing;
      // the rim sinks under gravity over about a second, then stays
      const sagGoal = on ? s.sagMax : 0;
      s.sag += (sagGoal - s.sag) * (1 - Math.exp(-dt * (on ? 2.6 : 5)));
      // the turf round it keels over with a small flop, then stays bent
      const leanGoal = on ? 1 : 0;
      s.leanV += ((leanGoal - s.lean) * 38 - s.leanV * 5.5) * dt;
      s.lean += s.leanV * dt;
      // torn root ends droop
      s.droopV += (((on ? 1 : 0) - s.droop) * 30 - s.droopV * 4.5) * dt;
      s.droop += s.droopV * dt;
      if (s.roots) { s.roots.userData.droop.value = Math.max(0, s.droop); s.roots.visible = on || s.lean > 0.05; }
      this.body.u.uSagK.value[i].set(s.sag, Math.max(0, s.lean), 0, 0);
      // a few late clods and crumbs from the rim, only in the first moments
      if (on) {
        while (s.drops.length && s.age >= s.drops[0]) {
          s.drops.shift();
          const ang = Math.random() * Math.PI * 2;
          const t1 = tmpT1.set(Math.abs(s.n.y) < 0.9 ? 0 : 1, Math.abs(s.n.y) < 0.9 ? 1 : 0, 0).cross(s.n).normalize();
          const t2 = tmpT2.crossVectors(s.n, t1);
          W.copy(s.center).addScaledVector(t1, Math.cos(ang) * s.R * 0.85).addScaledVector(t2, Math.sin(ang) * s.R * 0.85).addScaledVector(s.n, 0.05);
          this.container.localToWorld(W);
          D.set(0, -1, 0);
          this.debris.burst(W, D, { crumb: 1 + (Math.random() < 0.4 ? 1 : 0), dust: 3 + ((Math.random() * 3) | 0) }, 0.12, 0.35);
        }
      }
      if (s.closing && s.sag < 0.002 && Math.abs(s.lean) < 0.02) { this._free(i); continue; }
      // still moving (a relaxed hole of an inactive world needs no updates)
      const goal = on ? 1 : 0;
      if (Math.abs(s.sag - sagGoal) > 0.001 || Math.abs(s.lean - goal) > 0.01 || Math.abs(s.leanV) > 0.01 || (on && s.drops.length)) busy = true;
    }
    return busy;
  }
}
const tmpT1 = new THREE.Vector3(), tmpT2 = new THREE.Vector3();

// how a tear and the loose pieces behave in this world (the cloud sets its own)
const STYLE = { core: false, count: 26, breakK: 0.35, lifeK: 0.5, snapK: 2 }; // a few short roots snap together
// turf gives way sooner and stretches little; the clump comes out reluctantly
// (it lags the hand) and shivers as roots and soil strain; the house answers
// the break with a short stiff jolt, not a cotton wobble
const TEAR = { breakK: 0.55, stretchK: 0.3, give: 0.55, tremble: 1, recoil: 0.55, ripple: 0.35 };
// heavy: falls hard, barely bounces, settles fast, hard to spin (and keeps
// turning a little longer); hangs below the hand and lags it; hits dent the
// turf rather than ripple it
const PHYSICS = {
  gravity: 11, halo: false, bob: false, drag: 0.6, rest: 0.03, slide: 10, ground: true, groundFric: 7,
  follow: 6.5, holdSag: 0.12, throwMax: 8, spinK: 0.45, spinDamp: 1.0, impactPress: 1.5, impactRipple: 0.2,
};
const SOD = { rough: 0.13 };                                                    // torn earth relief (m)

export function createWorld() {
  let pollen = null, debris = null, depthTex = null, container = null, solid = false, wounds = null, body = null;
  return {
    id: 'grass',
    label: 'Grass',
    dot: 'radial-gradient(circle at 35% 30%, #e3f0c4, #93b56d 55%, #587d42)',
    materials: Object.entries(GRASS_FAMILIES).map(([id, f]) => ({ id, label: f.label, swatch: swatch[id] })),
    defaultFamily: 'meadow',
    demoFamily: 'moss',
    sky: 'meadow',
    room: {
      // a chamber dug into earth: warm packed soil within, dark loam from outside
      outLit: new THREE.Color('#8a6c4f'), outDeep: new THREE.Color('#3e2e22'),
      inLit: new THREE.Color('#b08f6c'), inDeep: new THREE.Color('#5e4634'),
    },
    // the strand of a torn sod: a few short pale-brown roots
    fibre: { tint: new THREE.Color('#8a6b4a'), width: 0.62 },
    // its own words where the cloud's would not fit
    copy: {
      house: { p: '<em>A house grown from meadow.</em> Press it, pull turf away, look inside.' },
      touch: { p: 'Pinch anywhere and pull. A sod of turf rips loose with its soil and drops; the house keeps the hollow.' },
      material: { h: 'Meadow, <em>moss,</em> <br />wild grass.', p: 'Tap the house to change what grows on it.' },
    },
    wind: [0.82, 0.42, 1, 0.35],

    async init(ctx) {
      Object.assign(FAMILIES, GRASS_FAMILIES);
      PALETTES.meadow = MEADOW_SKY;
      container = ctx.house.container;
      const t0 = performance.now();
      // the bake runs in a mesh worker: the page stays responsive meanwhile
      setSkinDepth(await ctx.house.skinDepth());
      depthTex = bakeDepth();
      this.bakeMs = Math.round(performance.now() - t0);
      pollen = makePollen();
      ctx.scene.add(pollen);
      debris = new Debris(ctx.scene, container);
      debris.onHits = (n, at, v) => ctx.onDebris?.(n, at, v, 'grass');
      body = ctx.house.body;
      wounds = new Wounds(body, container, debris);
      // torn sods are fused clods: mesh the outer ones ahead, in the background
      for (const c of CLUMPS) if (c.layer === 0) ctx.house.sodGeometry(c.id, 1);
      // let the GPU build the new programs before the world is shown. The
      // objects stay hidden meanwhile (three compiles hidden ones too): drawing
      // one whose program is still being linked would stall the frame.
      const roots = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), ROOT_MAT);
      const rim = new THREE.Mesh(roots.geometry, rimRootMaterial());
      roots.visible = rim.visible = false;
      ctx.scene.add(roots, rim);
      // (one object per frame: each program build is its own short task, the
      // page keeps drawing in between instead of one long stall)
      for (const o of [pollen, roots, rim, ...debris.meshes]) {
        await ctx.renderer.compileAsync?.(o, ctx.camera, ctx.scene).catch(() => {});
        await new Promise((r) => requestAnimationFrame(r));
      }
      ctx.scene.remove(roots, rim); roots.geometry.dispose(); rim.material.dispose();
      pollen.visible = false;
    },
    activate(ctx) {
      pollen.visible = true;
      pollen.userData.leaving = false;
      ctx.shared.uOrig.value = depthTex;
      const T = ctx.tearing;
      Object.assign(T.wisp.style, STYLE);
      Object.assign(T.tearK, TEAR);
      Object.assign(T.physics, PHYSICS);
      T.setSod(SOD);
      // taller blades need more shells to stay smooth; how many are drawn
      // follows their size on screen (level of detail)
      ctx.setFuzzLayers(12);
      ctx.setFuzzLod(true);
      // blades turn solid once the house has become turf (see update)
      solid = false;
    },
    deactivate() {
      // pollen fades out, debris finishes falling; the soil map stays bound
      // (only turf reads it)
      pollen.userData.leaving = true;
    },
    // a sod rips out: soil and loose blades rain from the break
    onTear(p) {
      const pc = p.piece;
      if (!pc) return;
      // earth crumbles from the wound as the bond goes: clods, dry crumb, a
      // few blades and a bit or two of sod
      W.copy(p.anchor); container.localToWorld(W);
      D.copy(p.normal).transformDirection(container.matrixWorld);
      const k = p.clump.rad;
      debris.burst(W, D, { crumb: 14 + Math.round(k * 10), dust: 18 + Math.round(k * 10), blade: 6, sod: Math.random() < 0.5 ? 1 : 2 }, k * 0.7, 1.3);
      // and some shaken from the underside of the sod as it goes
      W.copy(pc.mesh.position); container.localToWorld(W);
      debris.burst(W, D.set(0, -1, 0), { crumb: 8, dust: 12 }, k * 0.9, 0.6);
      // root ends left hanging under it
      if (pc.sod && !pc.roots) {
        pc.roots = makeRoots(pc, pc.turfDir);
        if (pc.roots) pc.mesh.add(pc.roots);
      }
      // a heavy clod turns a little as it drops
      pc.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6);
      // and the hole it leaves settles
      wounds.open(p);
    },
    // a cloud-born piece turned sod when the world came: give it roots too
    onRepresent(pc) {
      if (pc.sod && !pc.roots) {
        pc.roots = makeRoots(pc, pc.turfDir);
        if (pc.roots) pc.mesh.add(pc.roots);
      }
    },
    // a sod knocks against the house, another sod or the ground
    //  house: the grass there flattens for a moment (the dent itself is the
    //         body press, set by the tearing physics)
    //  any:   above a threshold, and not too often, it sheds a little dirt
    onImpact(at, speed, n, kind, pc) {
      if (kind === 'house' && speed > 0.4) {
        const f = Math.min(0.9, (speed - 0.3) * 0.35);
        // a harder knock wins over a fading one
        if (f > body.u.uFlatK.value.x * 0.8) {
          body.u.uFlat.value.set(at.x, at.y, at.z, 0.45 + Math.min(speed, 5) * 0.09);
          body.u.uFlatK.value.x = f;
        }
      }
      if (speed < 1.5 || debris.cool > 0 || (pc && pc.shedT > 0)) return;
      debris.cool = 0.25;
      if (pc) pc.shedT = 0.5;
      W.copy(at); container.localToWorld(W);
      const strong = speed > 3.5;
      const k = strong ? 6 + Math.round(Math.min(speed - 3.5, 4)) : 2 + Math.round(speed - 1.5);
      debris.burst(W, D.set(0, 1, 0), { crumb: k, dust: k * 2 + 2, blade: strong ? 2 : 0 }, 0.22, strong ? 1.2 : 0.6);
    },
    update(dt, t, ctx) {
      // solid blades while the turf world is showing and its material wave is
      // done (during the wave cotton and grass share the shells)
      const want = !pollen.userData.leaving && !ctx.house.body.morph;
      if (want !== solid) { solid = want; ctx.setFuzzSolid(solid); }
      const u = pollen.material.uniforms;
      u.uTime.value = t;
      const target = pollen.userData.leaving ? 0 : 1;
      u.uFade.value += (target - u.uFade.value) * (1 - Math.exp(-dt * (target ? 1.5 : 3)));
      debris.cool -= dt;
      debris.update(Math.min(dt, 1 / 30));
      for (const pc of ctx.tearing.pieces) if (pc.shedT > 0) pc.shedT -= dt;
      // holes settle; flattened grass springs back up
      this._busy = wounds.update(Math.min(dt, 1 / 30), !pollen.userData.leaving);
      const fk = body.u.uFlatK.value;
      if (fk.x > 0) fk.x = fk.x < 0.01 ? 0 : fk.x * Math.exp(-dt * 2.4);
      if (pollen.userData.leaving) fk.x = 0;
    },
    // the leaving world keeps updating until its fade and its debris are done
    idle() {
      if (pollen.userData.leaving && pollen.material.uniforms.uFade.value < 0.02 && !debris.alive && !this._busy) {
        pollen.visible = false;
        pollen.userData.leaving = false;
        return true;
      }
      return false;
    },
    pollen: () => pollen,
    debris: () => debris,
  };
}
