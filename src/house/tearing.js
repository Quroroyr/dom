import * as THREE from 'three';
import { CLUMPS, SPHERES, clumpAt, bricksForClumps, clumpsRemovedIn, tornIn, groupInfo, bodyFs, FLOAT, skinDepth } from './sdf.js';
import { createHouseMaterial } from '../render/houseMaterial.js';
import { familyState } from '../render/families.js';
import { makePart, stepPart, Spring3 } from './house.js';

// Tearing material out of one continuous cloud.
//
//  grab    — the clump under the finger is chosen (outer layers first). A
//            mesh of exactly those puffs takes their place and the puffs
//            leave the field at once: nearby bricks are re-meshed while the
//            piece still sits in its socket, so nothing is ever duplicated.
//  pull    — the piece slides out with resistance and leaves a real hollow;
//            the rim of the hollow is drawn after it (shader stretch) and
//            spun-sugar fibres thin out between them.
//  tear    — the fibres give way one by one and melt, the rim recoils and the
//            mass settles; the piece floats in the hand, lit as a free object.
//  let go  — before the tear, the piece sinks back and is absorbed again.
//  throw   — loose pieces bump softly into the house and into each other.
//  return  — pieces fly home, their puffs re-enter the field, the bricks are
//            re-meshed and the piece is swallowed with a small swell.

const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpPA = new THREE.Vector3();
const tmpPB = new THREE.Vector3();
const tmpAt = new THREE.Vector3();
const tmpHold = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpR = new THREE.Vector3();
const tmpT = new THREE.Vector3();
const tmpQ2 = new THREE.Quaternion();
const contacts = [];

// 2D convex hull (monotone chain) of [x, z] points, counter-clockwise
function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 1e-9) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 1e-9) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}
// where a resting piece turns over: null when the point (x, z) — its centre
// of mass — is over the support; otherwise the nearest point of the
// support's outline (the edge it tips over)
function supportPivot(pts, x, z) {
  if (!pts.length) return null;
  const h = hull2(pts);
  const n = h.length;
  if (n >= 3) {
    let inside = true;
    for (let i = 0; i < n && inside; i++) {
      const a = h[i], b = h[(i + 1) % n];
      if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) inside = false;
    }
    if (inside) return null;
  }
  if (n === 1) return h[0];
  let best = null, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const a = h[i], b = h[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
    const px = a[0] + ex * t, pz = a[1] + ez * t, d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < bd) { bd = d; best = [px, pz, ez, -ex]; } // (+ the edge's normal, for a balanced piece)
    if (n === 2) break;
  }
  return best;
}
const HALO_C = new THREE.Vector3(0, 3.2, 0);
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const groupKey = (config, ids) => `group:${config}:${ids.join('.')}`;

// soft collisions: cloud against cloud
const PUSH = 0.55;      // share of the overlap resolved per step (soft settle)

export function puffGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 3);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    tmpV.fromBufferAttribute(p, i);
    tmpV.multiplyScalar(1 + 0.08 * Math.sin(tmpV.x * 5.1 + tmpV.y * 3.3) * Math.cos(tmpV.z * 4.7 - tmpV.y * 2.1));
    p.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
  }
  g.computeVertexNormals();
  const n = p.count;
  const bake = new Uint8Array(n * 4), bake2 = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { bake.set([240, 240, 200, 250], i * 4); bake2.set([255, 255, 0, 0], i * 4); }
  g.setAttribute('bake', new THREE.BufferAttribute(bake, 4, true));
  g.setAttribute('bake2', new THREE.BufferAttribute(bake2, 4, true));
  return g;
}

// ---------------------------------------------------------------------------
// Pulled cotton: a soft core of cloud that thins away as it stretches, and
// around it a loose spun-sugar bundle — dozens of fine, uneven, curving
// fibres grouped in fuzzy strands. At the tear the fibres give way one by
// one, each half curls back toward its own side and melts.

const RINGS = 40, SIDES = 18;
const FIBRES = 96, SEG = 26;

// which way a clump faces out of the untouched house: the directions
// around it where the mass ends, weighted by how far out they are
function outwardOf(c) {
  const out = new THREE.Vector3();
  const r = c.rad * 1.1;
  for (let i = 0; i < 26; i++) {
    const y = 1 - (i + 0.5) / 13, s = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.39996;
    tmpV.set(Math.cos(a) * s, y, Math.sin(a) * s);
    // open air, not the room inside the shell
    const d = -skinDepth(c.c[0] + tmpV.x * r, c.c[1] + tmpV.y * r, c.c[2] + tmpV.z * r);
    if (d > 0) out.addScaledVector(tmpV, Math.min(d, 1));
  }
  if (out.lengthSq() < 1e-6) out.set(c.c[0], c.c[1] - 2.6, c.c[2]);
  return out.normalize();
}
// turf world: how much of the untouched house's grass skin a clump carried.
// Its puffs' surfaces are searched for the shallowest point under that skin:
// an outer clump reaches it (~0 m), a rafter or wall core from inside the roof
// stays well under it — its sod is earth all round, no turf on top. The ramp
// is the one blades use (render/fluff.js: bare below 0.035–0.07 m).
function skinOf(c) {
  let minD = Infinity;
  for (const i of c.ids) {
    const s = SPHERES[i];
    for (let k = 0; k < 26; k++) {
      const y = 1 - (k + 0.5) / 13, q = Math.sqrt(Math.max(0, 1 - y * y)), a = k * 2.39996;
      minD = Math.min(minD, skinDepth(s.x + Math.cos(a) * q * s.r * s.sx, s.y + y * s.r * s.sy, s.z + Math.sin(a) * q * s.r * s.sz));
    }
  }
  return 1 - THREE.MathUtils.smoothstep(minD, 0.035, 0.07);
}
const _c = new THREE.Vector3(), _side = new THREE.Vector3(), _up = new THREE.Vector3(), _dir = new THREE.Vector3();
const _p = new THREE.Vector3(), _t = new THREE.Vector3(), _w = new THREE.Vector3(), _v = new THREE.Vector3();
const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

const FIBRE_VERT = /* glsl */ `
attribute vec3 fib; // x across the ribbon (-1..1), y along (0..1), z alpha
varying vec3 vF;
varying vec3 vWorld;
void main(){
  vF = fib;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FIBRE_FRAG = /* glsl */ `
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uTint;
uniform float uDim;
varying vec3 vF;
varying vec3 vWorld;
float h1(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  // soft, fuzzy edge: no hard line, the fibre is denser at its spine
  float x = abs(vF.x);
  float edge = pow(1.0 - smoothstep(0.0, 1.0, x), 1.6);
  // sugar floss is never even: small clumps and gaps along each fibre
  float along = vF.y * 90.0 + vWorld.x * 7.0 + vWorld.z * 5.0;
  float fl = 0.72 + 0.28 * sin(along) * sin(along * 0.37 + 1.7);
  float a = min(1.0, edge * fl * vF.z * 1.5);
  if (a < 0.01) discard;
  // floss catches light at its spine, a lilac shade at its soft edges
  // (a light floss on a light sky reads by its shade, as the cloud does)
  vec3 col = mix(uShade, uLit, 0.05 + 0.55 * (1.0 - x)) * uTint * 0.97;
  col *= mix(0.55, 1.0, uDim);
  gl_FragColor = vec4(col, a);
}`;

export class Wisp {
  constructor(shared) {
    const st = familyState('cloud');
    st.microAmp = 0;
    this.mat = createHouseMaterial(shared, st, st, false);
    this.mat.userData.uniforms.uPaintOn.value = 0;
    const n = (RINGS + 1) * (SIDES + 1);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const bake = new Uint8Array(n * 4), bake2 = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) { bake.set([235, 235, 230, 245], i * 4); bake2.set([230, 230, 0, 0], i * 4); }
    g.setAttribute('bake', new THREE.BufferAttribute(bake, 4, true));
    g.setAttribute('bake2', new THREE.BufferAttribute(bake2, 4, true));
    const idx = [];
    for (let i = 0; i < RINGS; i++) for (let j = 0; j < SIDES; j++) {
      const a = i * (SIDES + 1) + j, b = a + SIDES + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    g.setIndex(idx);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.visible = false;

    // fibre bundle
    const fv = FIBRES * (SEG + 1) * 2;
    const fg = new THREE.BufferGeometry();
    this.fpos = new Float32Array(fv * 3);
    this.fattr = new Float32Array(fv * 3);
    fg.setAttribute('position', new THREE.BufferAttribute(this.fpos, 3).setUsage(THREE.DynamicDrawUsage));
    fg.setAttribute('fib', new THREE.BufferAttribute(this.fattr, 3).setUsage(THREE.DynamicDrawUsage));
    const fidx = [];
    for (let f = 0; f < FIBRES; f++) for (let s = 0; s < SEG; s++) {
      const a = (f * (SEG + 1) + s) * 2;
      fidx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    fg.setIndex(fidx);
    this.fgeo = fg;
    this.fmat = new THREE.ShaderMaterial({
      vertexShader: FIBRE_VERT, fragmentShader: FIBRE_FRAG,
      uniforms: {
        uLit: shared.uCloudLit, uShade: shared.uCloudShadow, uDim: shared.uCloudDim,
        uTint: { value: new THREE.Color('#fbf8f4') },
      },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.fibres = new THREE.Mesh(fg, this.fmat);
    this.fibres.frustumCulled = false;
    this.fibres.renderOrder = 3;
    this.fibres.visible = false;
    // each fibre: where it starts and ends in the two masses, its bundle,
    // thickness, curl, when it appears and when it gives way
    const bundles = Array.from({ length: 9 }, () => ({ a: rnd() * Math.PI * 2, r: 0.2 + rnd() * 0.7, ph: rnd() * 6 }));
    this.fib = Array.from({ length: FIBRES }, (_, i) => {
      const b = bundles[i % bundles.length];
      const ja = b.a + (rnd() - 0.5) * 0.9, jr = Math.min(1, b.r + (rnd() - 0.5) * 0.35);
      return {
        a0: ja, r0: jr, a1: ja + (rnd() - 0.5) * 1.2, r1: Math.min(1, jr * (0.7 + rnd() * 0.5)),
        // most fibres are a fine haze, a few are thick soft ropes of floss
        bundle: b, w: 0.012 + Math.pow(rnd(), 1.7) * 0.075, curl: 0.8 + rnd() * 1.9, ph: rnd() * 6.28, op: 0.45 + rnd() * 0.5,
        appear: rnd() * 0.55, breakT: Math.pow(rnd(), 1.4) * 0.6, cut: 0.3 + rnd() * 0.4, life: 0.5 + Math.pow(rnd(), 1.5) * 1.1,
        freq: 1 + Math.floor(rnd() * 3), seed: rnd() * 100,
      };
    });
    this.camPos = new THREE.Vector3(0, 5, 20);
    this.widthK = 1; // strand weight: a material world may make them finer
    // how the strand behaves (a material world sets it): cotton keeps a core
    // and gives way slowly; turf shows a few short roots that snap together
    this.style = { core: true, count: FIBRES, breakK: 1, lifeK: 1, snapK: 1 };
    this.A = new THREE.Vector3();
    this.B = new THREE.Vector3();
    this.rA = 0.4; this.rB = 0.3;
    this.t = 0;
    this.torn = null; // { age }
    this.s = 0;
  }
  setColor(c) {
    this.mat.userData.A.color.copy(c); this.mat.userData.B.color.copy(c);
    this.fmat.uniforms.uTint.value.copy(c);
  }

  update(dt, stretch01, active) {
    this.t += dt;
    const tr = this.torn;
    if (tr) {
      tr.age += dt;
      tr.g = 1 - Math.exp(-tr.age * 3.2);
      if (tr.age > 2.3) { this.torn = null; this.mesh.visible = false; this.fibres.visible = false; return; }
    } else {
      if (!active || this.A.distanceTo(this.B) < 0.05) { this.mesh.visible = false; this.fibres.visible = false; return; }
      this.s = stretch01;
    }
    const s01 = this.s;
    _dir.subVectors(this.B, this.A);
    const len = _dir.length();
    _dir.divideScalar(len || 1);
    _side.set(0, 1, 0).cross(_dir);
    if (_side.lengthSq() < 1e-4) _side.set(1, 0, 0);
    _side.normalize();
    _up.copy(_dir).cross(_side).normalize();
    this._core(len, s01, tr);
    this._fibres(len, s01, tr);
  }

  // the cotton core: plump at first, thins away into the fibres, gone at the tear
  _core(len, s01, tr) {
    const coreK = !this.style.core ? 0 : tr ? Math.max(0, 1 - tr.age * 5) : 1 - THREE.MathUtils.smoothstep(s01, 0.35, 0.8);
    if (coreK <= 0.01) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const waist = THREE.MathUtils.lerp(0.85, 0.05, Math.pow(s01, 1.1));
    const P = this.pos;
    let k = 0;
    for (let i = 0; i <= RINGS; i++) {
      const t = i / RINGS;
      let r = THREE.MathUtils.lerp(this.rA, this.rB, t) * 0.85;
      const sn = Math.sin(Math.PI * t);
      r *= THREE.MathUtils.lerp(1, waist * coreK, Math.pow(sn, 0.5));
      _c.copy(this.A).addScaledVector(_dir, len * t);
      _c.addScaledVector(_up, -sn * len * (0.05 + s01 * 0.03));
      for (let j = 0; j <= SIDES; j++) {
        const a = (j / SIDES) * Math.PI * 2;
        const fib = 1 + 0.12 * Math.sin(a * 5 + t * 6 + this.t * 0.4) + 0.06 * Math.sin(a * 3 - t * 11 + this.t);
        const rr = r * fib;
        const ca = Math.cos(a) * rr, sa = Math.sin(a) * rr;
        P[k++] = _c.x + _side.x * ca + _up.x * sa;
        P[k++] = _c.y + _side.y * ca + _up.y * sa;
        P[k++] = _c.z + _side.z * ca + _up.z * sa;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeVertexNormals();
  }

  // camera-facing ribbons along curved, bundled fibre paths
  _fibres(len, s01, tr) {
    this.fibres.visible = true;
    const P = this.fpos, F = this.fattr;
    const time = this.t;
    let k = 0, q = 0, any = false;
    const pt = (fb, t, out) => {
      // disc offsets at both ends converge toward a narrow waist in the middle
      const sn = Math.sin(Math.PI * t);
      const a = THREE.MathUtils.lerp(fb.a0, fb.a1, t) + Math.sin(t * 3 + fb.ph) * 0.3;
      const rEnd = THREE.MathUtils.lerp(this.rA * fb.r0, this.rB * fb.r1, t);
      const waist = THREE.MathUtils.lerp(0.9, 0.28, Math.pow(s01, 0.8));
      const rr = rEnd * THREE.MathUtils.lerp(1, waist, Math.pow(sn, 0.7));
      // bundles drift together and apart; each fibre curls loosely around its bundle
      const b = fb.bundle;
      const bw = Math.sin(time * 0.9 + b.ph + t * 4) * 0.05 * sn * len * 0.2;
      const curl = (Math.sin(t * Math.PI * fb.freq + fb.ph + time * 1.3) + 0.5 * Math.sin(t * 17.0 + fb.seed)) * fb.curl * 0.05 * sn * (0.4 + s01);
      out.copy(this.A).addScaledVector(_dir, len * t);
      out.addScaledVector(_up, -sn * len * (0.05 + s01 * 0.03) + Math.sin(a) * rr + curl * 0.6);
      out.addScaledVector(_side, Math.cos(a) * rr + bw + curl);
      return out;
    };
    const st = this.style;
    for (let f = 0; f < FIBRES; f++) {
      const fb = this.fib[f];
      // fibres show as the material is drawn out
      let vis = f < st.count ? THREE.MathUtils.smoothstep(s01, fb.appear * 0.7 + 0.05, fb.appear * 0.7 + 0.3) : 0;
      let cut = -1, g = 0;
      if (tr) {
        const age = tr.age - fb.breakT * st.breakK;
        if (age > 0) {
          cut = fb.cut;
          g = 1 - Math.exp(-age * 2.4 * st.snapK);
          vis *= Math.max(0, 1 - age / (fb.life * st.lifeK));
        }
      }
      for (let s = 0; s <= SEG; s++) {
        let t = s / SEG;
        const sn0 = Math.sin(Math.PI * t); // where along the fibre this sample was born
        let tip = 1;
        if (cut >= 0) {
          // each half pulls back toward its own mass and thins to a soft tip
          const half = t < cut;
          const u = half ? t / cut : (1 - t) / (1 - cut);
          t = half ? u * cut * (1 - g) : 1 - u * (1 - cut) * (1 - g);
          tip = Math.sqrt(Math.max(0, 1 - Math.pow(u, 6)));
        }
        pt(fb, t, _p);
        pt(fb, Math.min(1, t + 0.02), _t);
        _t.sub(_p).normalize();
        _v.subVectors(this.camPos, _p).normalize();
        _w.crossVectors(_t, _v).normalize();
        // thickness is uneven along the fibre and thinner where it is drawn out
        const sn = Math.sin(Math.PI * t);
        const irr = 0.55 + 0.45 * Math.abs(Math.sin(t * 9.0 + fb.seed) * Math.sin(t * 3.7 + fb.seed * 0.3));
        const w = fb.w * this.widthK * irr * (1 - 0.55 * sn * s01) * tip * (0.6 + 0.4 * vis);
        const alpha = vis * fb.op * (0.45 + 0.55 * irr) * THREE.MathUtils.smoothstep(sn0, 0, 0.12 + 0.2 * (1 - s01)) * tip;
        if (alpha > 0.01) any = true;
        for (const side of [-1, 1]) {
          P[k++] = _p.x + _w.x * w * side;
          P[k++] = _p.y + _w.y * w * side;
          P[k++] = _p.z + _w.z * w * side;
          F[q++] = side; F[q++] = t; F[q++] = alpha;
        }
      }
    }
    this.fibres.visible = any;
    this.fgeo.attributes.position.needsUpdate = true;
    this.fgeo.attributes.fib.needsUpdate = true;
  }

  tear() { this.torn = { age: 0, g: 0 }; }
}

// ---------------------------------------------------------------------------

export class Tearing {
  constructor({ house, shared, scene }) {
    this.house = house;
    this.shared = shared;
    this.scene = scene;
    this.puff = puffGeometry();
    this.wisp = new Wisp(shared);
    this.wispPiece = null;
    scene.add(this.wisp.mesh, this.wisp.fibres);
    this.pieces = []; // every detached piece (user or choreography)
    this.pull = null;
    this.onSpawn = null;
    this.onTear = null;
    this.choreo = { name: null, pieces: [] };
    this._refreshT = 0;
    this.paint = null; // PaintManager: a torn piece gets its own paint
    this._lastN = new THREE.Vector3();
    // how far loose pieces drift out (narrow screens keep them closer, in frame)
    this.stage = { halo: 5.4, far: 7.5 };
    // set by the material world:
    //  tear    — how far the material stretches before it gives way
    //  physics — cloud floats in a slow halo; turf has weight, lands, settles
    // give: how far the clump slides out before it goes; tremble: strain
    // shiver near the break; recoil/ripple: how the house answers the break
    this.tearK = { breakK: 1, stretchK: 1, give: 1, tremble: 0, recoil: 1, ripple: 1 };
    // follow/holdSag/throwMax: a piece in the hand; spinK/spinDamp: its
    // rotational inertia; impactPress/impactRipple: how the house takes a hit
    this.physics = {
      gravity: 0, halo: true, bob: true, drag: 1.1, rest: 0.12, slide: 5.5, ground: false, groundFric: 0,
      follow: 12, holdSag: 0, throwMax: 12, spinK: 1, spinDamp: 1.6, impactPress: 1, impactRipple: 1,
    };
    this.onImpact = null; // (houseLocalPoint, speed, normal): a world may answer with debris
    // turf world: a torn clump is a sod — one fused clod, turf on the side
    // that faced out, torn earth (relief in m) everywhere else. null = cotton
    this.sod = null;
    this._free = [];
  }

  // --- a piece: mesh of one clump in the house frame --------------------------
  _makePiece(clumpId, geo, info) {
    const c = info || CLUMPS[clumpId];
    const b = this.house.body;
    // a piece torn while the house is still changing material is born as
    // what the house is becoming, not what it was
    const st = b.morph ? b.morph.to : b.state;
    const mat = createHouseMaterial(this.shared, st, st, false);
    // its own paint bindings: they read the house paint until the piece is
    // torn off, then point at the piece's own volume (fuzz shares them)
    const U = mat.userData.uniforms;
    U.uPaint = { value: this.shared.uPaint.value };
    U.uPaintLo = { value: this.shared.uPaintLo.value.clone() };
    U.uPaintInv = { value: this.shared.uPaintInv.value.clone() };
    mat.userData.A.color.copy(b.morph ? st.color : b.mat.userData.A.color);
    mat.userData.B.color.copy(mat.userData.A.color);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.layers.enable(1);
    mesh.position.fromArray(c.c);
    this.house.container.add(mesh);
    const part = makePart(`piece:${clumpId}`, { family: b.family, mass: 0.4 + c.rad * 0.3 }, mat, mesh);
    part.home.fromArray(c.c);
    // paint lives in the house frame: the piece reads it where it came from
    part.u.uPaintOffset.value.fromArray(c.c);
    // so does the depth under the house's skin (turf above, soil below)
    part.u.uOrigOffset.value.fromArray(c.c);
    // colliders: the piece's own puffs, relative to its pivot
    const colliders = c.ids.map((i) => {
      const s = SPHERES[i];
      return { o: new THREE.Vector3(s.x - c.c[0], s.y - c.c[1], s.z - c.c[2]), r: s.r * Math.min(s.sx, s.sy, s.sz) * 0.5 + s.R * 0.45 };
    });
    const piece = {
      clumpId, clump: c, mesh, part, u: part.u, colliders,
      mass: Math.max(0.2, c.rad ** 3),
      pos: new Spring3(90, 13), vel: new THREE.Vector3(), spin: new THREE.Vector3(),
      state: 'held', hold: null, bob: Math.random() * 6, returning: null, free: 0, squashT: 0, bumpT: 0,
    };
    piece.pos.x.fromArray(c.c); piece.pos.target.fromArray(c.c);
    mesh.userData.piece = piece;
    this.pieces.push(piece);
    this.onSpawn?.(piece);
    return piece;
  }

  // a world switch: sods show as sods only in the turf world
  // a world switch: loose pieces take the world's representation — a sod
  // (fused clod, turf top, torn earth) in the turf world, the plain clump in
  // the cloud — keeping identity, transform, velocity, paint and state
  setSod(cfg) {
    this.sod = cfg;
    for (const pc of this.pieces) {
      if (pc.sod) this._sodLook(pc);
      if (pc.state !== 'choreo') this._represent(pc);
      pc.sleeping = false;
    }
  }
  async _represent(pc) {
    if (pc.clumpId < 0) return;
    const want = this.sod ? 'sod' : 'clump';
    if ((pc.shape || 'clump') === want) return;
    const geo = await (want === 'sod' ? this.house.sodGeometry(pc.clumpId) : this.house.clumpGeometry(pc.clumpId));
    // the world may have changed again, or the piece gone, while it meshed
    if (!geo || !this.pieces.includes(pc) || (this.sod ? 'sod' : 'clump') !== want || pc.shape === want) return;
    pc.mesh.geometry = geo;
    for (const c of pc.mesh.children) if (c.isInstancedMesh) { c.geometry = geo; c.boundingSphere = null; } // its fuzz shells
    pc.shape = want;
    if (want === 'sod') {
      pc.sod = true;
      pc.turfDir ||= outwardOf(pc.clump);
    }
    this._sodLook(pc);
    this.onRepresent?.(pc);
  }
  _sodLook(pc) {
    const on = !!this.sod;
    pc.u.uRough.value.x = on ? this.sod.rough : 0;
    // once per clump: the skin it carried decides whether its sod has a turf top
    pc.clump.skin ??= skinOf(pc.clump);
    pc.u.uTurfDir.value.set(pc.turfDir.x, pc.turfDir.y, pc.turfDir.z, on ? pc.clump.skin : 0);
    // the roots a world hung on it belong to the earth, not to cotton
    if (pc.roots) pc.roots.visible = on;
  }

  _removePiece(piece) {
    const i = this.pieces.indexOf(piece);
    if (i < 0) return;
    this.house.container.remove(piece.mesh);
    // things a world hung on it (roots) free their own buffers
    piece.mesh.traverse((o) => o.userData.dispose?.());
    // its fuzz: own material + instance buffers (the geometry is the shared
    // clump/sod cache and stays)
    this.onRemove?.(piece);
    piece.part.mat.dispose();
    piece.mesh.userData.piece = null;
    this.pieces.splice(i, 1);
  }

  // --- pull ----------------------------------------------------------------
  // worldPoint/worldNormal: where the finger grabbed the body
  begin(worldPoint, worldNormal) {
    const local = this.house.container.worldToLocal(worldPoint.clone());
    const id = clumpAt(local.x, local.y, local.z);
    if (id < 0) return false;
    const c = CLUMPS[id];
    const nLocal = worldNormal.clone().normalize();
    const pull = { id, clump: c, anchor: local, normal: nLocal, dist: 0, piece: null, socket: false, breakAt: (0.75 + c.rad * 0.55) * this.tearK.breakK };
    this.pull = pull;
    // until the house has closed over the socket, a soft dent stands in for it
    const b = this.house.body;
    b.pressPoint.copy(local);
    b.pressDir.copy(nLocal);
    b.u.uPressN.value.w = c.rad * 1.05;
    b.press.target = Math.min(c.rad * 0.6, 0.55);
    const sod = this.sod;
    (sod ? this.house.sodGeometry(id) : this.house.clumpGeometry(id)).then((geo) => {
      if (this.pull !== pull || !geo) return;
      // the piece takes the place of its puffs, then the puffs leave the field
      const piece = this._makePiece(id, geo);
      piece.shape = sod ? 'sod' : 'clump';
      if (sod) {
        piece.sod = true;
        piece.turfDir = outwardOf(c);
        this._sodLook(piece);
      }
      pull.piece = piece;
      this.house.setAlive(c.ids, false);
      piece.detached = this.house.meshBricks('live', bricksForClumps([id])).then(() => {
        pull.socket = true;
        b.press.target = 0; // the real hollow is there now
      });
    });
    return true;
  }

  // hand in world space; returns true when it tears
  drag(handWorld) {
    const p = this.pull;
    if (!p) return false;
    if (!p.piece) return false; // not in the hand yet
    const hand = this.house.container.worldToLocal(handWorld.clone());
    const raw = hand.clone().sub(p.anchor);
    const L = raw.length();
    // cotton resists at first, then gives way
    const eff = L * (0.3 + 0.55 * THREE.MathUtils.smoothstep(L, 0.15, 1.8));
    p.dist = eff;
    const dir = raw.normalize();
    p.dir = dir.clone();
    // the body surface around the grab point is drawn toward the hand
    const b = this.house.body;
    b.u.uPull.value.set(p.anchor.x, p.anchor.y, p.anchor.z, p.clump.rad * 1.15);
    b.pullVec.target.copy(dir).multiplyScalar(p.socket ? Math.min(eff * 0.5, p.clump.rad * 0.8) * this.tearK.stretchK : 0);
    // the clump itself slides out, a little behind the hand. Until the house
    // has closed over its socket it only budges.
    {
      const pc = p.piece;
      const out = (p.socket ? eff : Math.min(eff, p.breakAt * 0.9)) * 0.95 * this.tearK.give;
      // it comes off the surface as well as toward the hand: a peel, not a slide
      pc.pos.target.copy(pc.part.home).addScaledVector(dir, out).addScaledVector(p.normal, out * 0.45);
      // a heavy bond shivers as it strains toward the break
      if (this.tearK.tremble > 0 && p.socket) {
        const strain = THREE.MathUtils.smoothstep(eff / p.breakAt, 0.45, 1);
        const a = 0.014 * this.tearK.tremble * strain * strain;
        pc.pos.target.x += (Math.random() - 0.5) * a; pc.pos.target.y += (Math.random() - 0.5) * a; pc.pos.target.z += (Math.random() - 0.5) * a;
      }
      pc.part.stretchAxis.copy(dir);
      pc.part.stretch.target = Math.min(eff * 0.12, 0.2) * this.tearK.stretchK;
      // its back side stays attached: pulled back toward the house
      const back = p.anchor.clone().sub(pc.part.home);
      pc.u.uPull.value.set(back.x, back.y, back.z, p.clump.rad * 0.9);
      pc.part.pullVec.target.copy(dir).multiplyScalar(-Math.min(eff * 0.45, p.clump.rad * 0.7));
    }
    return p.socket && eff > p.breakAt;
  }

  // separation: the puffs leave the field
  tear(handVel) {
    const p = this.pull;
    if (!p) return null;
    this.pull = null;
    const b = this.house.body;
    // the rim snaps back past rest and the mass settles around the hollow
    b.pullVec.target.set(0, 0, 0);
    b.pullVec.v.addScaledVector(p.dir || p.normal, -2.2 * this.tearK.recoil);
    this.house.ripple(b, p.anchor, 0.04 * this.tearK.ripple);
    const w = this.wisp;
    if (p.piece) {
      w.A.fromArray(p.clump.c).lerp(p.anchor, 0.35); this.house.container.localToWorld(w.A);
      w.B.copy(p.piece.mesh.position); this.house.container.localToWorld(w.B);
      w.tear();
      this.wispPiece = p.piece;
      const pc = p.piece;
      pc.state = 'free';
      // from here on it is its own object: it keeps the paint it showed
      if (this.paint) {
        pc.paintVol = this.paint.detach(pc.part.home, pc.clump.ids.map((i) => SPHERES[i]));
        const U = pc.part.mat.userData.uniforms;
        U.uPaint.value = pc.paintVol.tex;
        U.uPaintLo.value.copy(pc.paintVol.lo);
        U.uPaintInv.value.copy(pc.paintVol.inv);
        U.uPaintOffset.value.set(0, 0, 0);
      }
      pc.vel.copy(handVel || tmpV.set(0, 0, 0)).multiplyScalar(0.35);
      pc.part.pullVec.target.set(0, 0, 0);
      pc.part.stretch.target = 0;
      pc.part.stretch.v -= 1.5; // recoil wobble
    }
    this.onTear?.(p);
    return p.piece;
  }

  // released before separation: everything slides back into the mass
  cancel() {
    const p = this.pull;
    if (!p) return;
    this.pull = null;
    const b = this.house.body;
    b.pullVec.target.set(0, 0, 0);
    this.house.ripple(b, p.anchor, 0.03);
    if (p.piece) {
      p.piece.state = 'sinking';
      p.piece.pos.target.copy(p.piece.part.home);
    }
  }

  // a piece back in its socket: its puffs re-enter the field, and once the
  // bricks have closed over it the piece mesh is dropped
  _absorb(pc, swell = 0) {
    if (pc.absorbing) return;
    pc.absorbing = true;
    this.onAbsorb?.(pc, pc.state);
    // its paint goes back into the house where it sits (unrotated, at home)
    if (pc.paintVol && this.paint) {
      const U = pc.part.mat.userData.uniforms;
      U.uPaint.value = this.shared.uPaint.value;
      U.uPaintLo.value.copy(this.shared.uPaintLo.value);
      U.uPaintInv.value.copy(this.shared.uPaintInv.value);
      U.uPaintOffset.value.copy(pc.part.home);
      pc.mesh.quaternion.identity();
      this.paint.merge(pc.paintVol, pc.part.home);
      pc.paintVol = null;
    }
    const settle = pc.detached || Promise.resolve();
    settle.then(() => {
      this.house.setAlive(pc.clump.ids, true);
      return this.house.meshBricks('live', bricksForClumps([pc.clumpId]));
    }).then(() => {
      const b = this.house.body;
      if (swell) { b.pressPoint.copy(pc.part.home); b.press.x = -swell; }
      this.house.ripple(b, pc.part.home, 0.03 + swell * 0.1);
      this._removePiece(pc);
      // a choreography on screen shows the house as it is now
      if (this.choreo.name) this._queueRefresh();
    });
  }

  // --- reassembly ---------------------------------------------------------------
  returnPiece(pc, delay = 0) {
    if (pc.state === 'choreo') return;
    pc.state = 'returning';
    pc.hold = null;
    pc.sleeping = false;
    pc.returning = { t: -delay, from: pc.mesh.position.clone(), q: pc.mesh.quaternion.clone() };
    this.onReturn?.(pc, delay * 1.4); // (t runs at 1/1.4 of real time)
  }
  reassemble() {
    let i = 0;
    for (const pc of this.pieces) if (pc.state === 'free') this.returnPiece(pc, (i++) * 0.1);
  }
  freeCount() { let n = 0; for (const p of this.pieces) if (p.state === 'free') n++; return n; }

  // --- choreography: OPEN (noFacade) and APART (coreOnly) -----------------------
  // A choreography never rebuilds the house: it shows its own layout of what
  // is still in the house. prepare() re-meshes the bricks around clumps the
  // visitor has torn (or returned since) and meshes the lifted layer from the
  // clumps that are still there.
  prepare(config, merged = false) {
    const set = this.house.sets[config];
    set.torn = set.torn || new Set();
    const want = new Set(tornIn(config));
    const diff = [...want].filter((id) => !set.torn.has(id)).concat([...set.torn].filter((id) => !want.has(id)));
    set.torn = want;
    const jobs = [];
    if (diff.length) jobs.push(this.house.meshBricks(config, bricksForClumps(diff)));
    if (merged) {
      const removed = clumpsRemovedIn(config);
      if (removed.length) jobs.push(this.house.groupGeometry(groupKey(config, removed), removed, 0));
    }
    return Promise.all(jobs);
  }
  isPrepared(config, merged = false) {
    const set = this.house.sets[config];
    if (!set.ready) return false;
    const want = tornIn(config);
    const torn = set.torn || new Set();
    if (want.length !== torn.size || want.some((id) => !torn.has(id))) return false;
    if (merged) {
      const removed = clumpsRemovedIn(config);
      if (removed.length && !this.house.clumpGeo.has(groupKey(config, removed))) return false;
    }
    return true;
  }

  // weight 0..1; offset(clump, w) returns [position, euler] in the house frame
  // merged: the removed clumps move as ONE continuous piece (a peeled layer)
  setChoreo(name, config, w, offset, merged = false) {
    const ch = this.choreo;
    if (w > 0.002 && ch.name !== name) {
      if (ch.name) this._endChoreo();
      if (!this.isPrepared(config, merged)) {
        if (!ch.preparing) { ch.preparing = true; this.prepare(config, merged).then(() => { ch.preparing = false; }); }
        return;
      }
      ch.name = name; ch.config = config; ch.merged = merged; ch.offset = offset;
      this.house.showConfig(config);
      this._buildChoreo();
    }
    if (ch.name === name) {
      if (w <= 0.002) { this._endChoreo(); return; }
      ch.w = w;
      for (const pc of ch.pieces) {
        const [pos, eul] = offset(pc.clump, w);
        pc.mesh.position.copy(pos);
        pc.mesh.rotation.copy(eul);
        // turned away from where its shadows were baked: light it openly
        pc.u.uSunFree.value = Math.min(1, (Math.abs(eul.x) + Math.abs(eul.y) + Math.abs(eul.z)) * 1.6);
      }
    }
  }
  _buildChoreo() {
    const ch = this.choreo;
    for (const pc of ch.pieces) this._removePiece(pc);
    ch.pieces = [];
    const removed = clumpsRemovedIn(ch.config);
    if (ch.merged) {
      const geo = removed.length && this.house.clumpGeo.get(groupKey(ch.config, removed));
      if (geo) {
        const pc = this._makePiece(-1, geo, groupInfo(removed));
        pc.state = 'choreo';
        ch.pieces.push(pc);
      }
    } else {
      for (const id of removed) {
        const geo = this.house.clumpGeo.get(id);
        if (!geo) continue;
        const pc = this._makePiece(id, geo);
        pc.state = 'choreo';
        ch.pieces.push(pc);
      }
    }
  }
  _queueRefresh() {
    clearTimeout(this._refreshT);
    this._refreshT = setTimeout(() => {
      const ch = this.choreo;
      if (!ch.name) return;
      const { name, config, merged } = ch;
      this.prepare(config, merged).then(() => {
        if (this.choreo.name !== name) return;
        this._buildChoreo();
        if (ch.w) this.setChoreo(name, config, ch.w, ch.offset, merged);
      });
    }, 80);
  }
  _endChoreo() {
    const ch = this.choreo;
    for (const pc of ch.pieces) this._removePiece(pc);
    ch.pieces = []; ch.name = null;
    this.house.showConfig('live');
  }

  // preload the meshes the choreography needs
  preload(config, merged = false) {
    const removed = clumpsRemovedIn(config);
    if (merged) return this.house.groupGeometry(groupKey(config, removed), removed, 1);
    return Promise.all(removed.map((id) => this.house.clumpGeometry(id, 1)));
  }

  // move a loose piece by delta without passing through the house: short
  // steps, contact resolved after each (no tunnelling, even when thrown)
  _advance(pc, delta, dt) {
    const len = delta.length();
    const near = bodyFs(pc.mesh.position.x, pc.mesh.position.y, pc.mesh.position.z) < pc.clump.rad + len + 0.5;
    if (!near || len < 0.1) { pc.mesh.position.add(delta); return; }
    const n = Math.min(40, Math.ceil(len / 0.1));
    const step = tmpS.copy(delta).divideScalar(n).clone();
    for (let i = 0; i < n; i++) {
      pc.mesh.position.add(step);
      if (this._hitHouse(pc, dt)) {
        // blocked: keep only the part of the step that slides along the surface
        const into = step.dot(this._lastN);
        if (into < 0) {
          // cotton drags on cotton: a push into the wall mostly stops, it
          // only creeps a little along it
          step.addScaledVector(this._lastN, -into).multiplyScalar(pc.hold ? 0.25 : 0.6);
        }
      }
    }
  }

  // lift a piece so none of its puffs is below the floor (no bounce)
  _keepAboveFloor(pc) {
    const floor = -FLOAT;
    let low = Infinity;
    for (const c of pc.colliders) { this._worldPuff(pc, c, tmpA); low = Math.min(low, tmpA.y - c.r); }
    if (low < floor) { pc.mesh.position.y += floor - low; if (pc.vel.y < 0) pc.vel.y = 0; }
  }

  // the ground under the house (world floor): a heavy piece lands, bumps a
  // little, and settles; friction stops it sliding and rolling
  _ground(pc, dt) {
    const floor = -FLOAT;
    // it stands on its real shape (the round collision puffs let the mesh
    // sink into the ground by up to ~13 cm and widened what it stood on)
    let low = this._shape(pc);
    if (low === Infinity) for (const c of pc.colliders) {
      this._worldPuff(pc, c, tmpA);
      low = Math.min(low, tmpA.y - c.r);
    }
    if (low >= floor) {
      // lifted off mid-turn: the turn goes on as a free spin
      if (pc.tipW && pc.tipW.lengthSq() > 0) { pc.spin.add(pc.tipW); pc.tipW.set(0, 0, 0); }
      pc.unstable = false;
      pc.tipRest = 0; pc.tipAge = 0;
      pc.grounded = false;
      return;
    }
    pc.mesh.position.y += floor - low;
    if (pc.shapeY) for (let k = 0; k < pc.shapeY.length; k++) pc.shapeY[k] += floor - low;
    pc.shapeMin = floor;
    if (pc.vel.y < 0) {
      const speed = -pc.vel.y;
      if (speed > 1.2 && !pc.grounded) this.onImpact?.(tmpAt.set(pc.mesh.position.x, floor, pc.mesh.position.z), speed, tmpN.set(0, 1, 0), 'ground', pc);
      pc.vel.y = speed > 0.8 ? speed * this.physics.rest : 0;
      if (speed > 1.5 && pc.squashT <= 0) {
        pc.part.stretchAxis.set(0, 1, 0).applyQuaternion(tmpQ.copy(pc.mesh.quaternion).invert());
        pc.part.stretch.v -= Math.min(speed * 0.35, 1.4);
        pc.squashT = 0.3;
      }
    }
    const f = Math.exp(-dt * this.physics.groundFric);
    pc.vel.x *= f; pc.vel.z *= f;
    pc.spin.multiplyScalar(f);
    pc.grounded = true;
    this._tip(pc, dt, floor);
  }

  // the piece's real shape in the house frame: a thinned set of its mesh
  // points (≤600, cached per geometry), placed where the piece is now.
  // Returns the lowest height (Infinity without a mesh).
  _shape(pc) {
    const geo = pc.mesh.geometry;
    const pos = geo?.attributes?.position;
    if (!pos) return Infinity;
    if (!pc.shapePts || pc.shapeGeo !== geo) {
      const step = Math.max(1, Math.ceil(pos.count / 600));
      const n = Math.ceil(pos.count / step);
      const pts = new Float32Array(n * 3);
      for (let i = 0, j = 0; i < pos.count; i += step, j += 3) { pts[j] = pos.getX(i); pts[j + 1] = pos.getY(i); pts[j + 2] = pos.getZ(i); }
      pc.shapePts = pts; pc.shapeGeo = geo;
      pc.shapeX = new Float32Array(n); pc.shapeY = new Float32Array(n); pc.shapeZ = new Float32Array(n);
      let r2 = 0;
      for (let j = 0; j < pts.length; j += 3) r2 = Math.max(r2, pts[j] ** 2 + pts[j + 1] ** 2 + pts[j + 2] ** 2);
      pc.shapeR = Math.sqrt(r2);
    }
    const sp = pc.shapePts, qm = pc.mesh.quaternion, pm = pc.mesh.position;
    // well clear of anything below: its lowest point is at most shapeR down
    if (pm.y - pc.shapeR > -FLOAT + 0.05) return pm.y - pc.shapeR;
    const wx = pc.shapeX, wy = pc.shapeY, wz = pc.shapeZ;
    let minY = Infinity;
    for (let i = 0, k = 0; i < sp.length; i += 3, k++) {
      tmpP.set(sp[i], sp[i + 1], sp[i + 2]).applyQuaternion(qm).add(pm);
      wx[k] = tmpP.x; wy[k] = tmpP.y; wz[k] = tmpP.z;
      if (tmpP.y < minY) minY = tmpP.y;
    }
    return minY;
  }

  // A piece resting on the floor stands on the puffs that touch it. If its
  // centre of mass is not over that support, gravity turns it over the
  // nearest edge (a rigid body pivoting on the edge: α = g·d / I, I about
  // the edge), until it lies on a side wide enough to hold it. It does not
  // fall asleep meanwhile; landing on the new side is a (soft) knock.
  _tip(pc, dt, floor) {
    if (!pc.com) {
      // centre of mass: the puffs, weighted by volume (pivot frame)
      pc.com = new THREE.Vector3();
      let wsum = 0;
      for (const c of pc.colliders) { const w = c.r ** 3; pc.com.addScaledVector(c.o, w); wsum += w; }
      pc.com.divideScalar(wsum || 1);
    }
    // what it stands on is its real shape, not the round collision puffs (a
    // thin edge is an edge, not the side of a ball): the lowest points of
    // its mesh (placed this frame by _ground)
    if (!pc.shapeY) return;
    const wx = pc.shapeX, wy = pc.shapeY, wz = pc.shapeZ;
    const minY = pc.shapeMin;
    contacts.length = 0;
    for (let k = 0; k < wy.length; k++) if (wy[k] < minY + 0.03) contacts.push([wx[k], wz[k]]);
    // it may also lean on the house or on another piece (last frame's
    // contacts): those hold it up as well as the floor does
    if (pc.touchPrev) for (const t of pc.touchPrev) contacts.push(t);
    tmpC.copy(pc.com).applyQuaternion(pc.mesh.quaternion).add(pc.mesh.position);
    const w = pc.tipW || (pc.tipW = new THREE.Vector3());
    const piv = supportPivot(contacts, tmpC.x, tmpC.z);
    if (!piv || pc.tipRest > 0) {
      // on its base: a turn that was under way lands here
      const hit = w.length() * (pc.tipL || 0);
      if (hit > 0.7) this.onImpact?.(tmpAt.set(tmpC.x, floor, tmpC.z), hit, tmpN.set(0, 1, 0), 'ground', pc);
      w.set(0, 0, 0);
      pc.unstable = false;
      pc.tipAge = 0;
      // (given up as held up: it rests until it is lifted or picked up)
      return;
    }
    pc.unstable = true;
    tmpP.set(piv[0], minY, piv[1]);
    tmpR.subVectors(tmpC, tmpP);
    // balanced exactly over the edge: the slightest lean decides
    if (tmpR.x * tmpR.x + tmpR.z * tmpR.z < 1e-4) {
      const s = (pc.clumpId & 1) ? 1 : -1, nl = Math.hypot(piv[2] || 1, piv[3] || 0);
      tmpR.x += s * 0.01 * (piv[2] || 1) / nl; tmpR.z += s * 0.01 * (piv[3] || 0) / nl;
    }
    const L2 = tmpR.lengthSq();
    const rad = pc.clump.rad;
    // no turn lasts for ever: one that has not found a resting side in 4 s
    // is held up by something the contacts do not show, and stops there
    pc.tipLean = Math.hypot(tmpR.x, tmpR.z);
    pc.tipAge = (pc.tipAge || 0) + dt;
    if (pc.tipAge > 4) { w.set(0, 0, 0); pc.unstable = false; pc.tipAge = 0; pc.tipRest = Infinity; return; }
    // τ = r × (0, −m·g, 0); I about the edge = I_com + m·L² (m cancels)
    tmpT.set(0, -this.physics.gravity, 0);
    tmpT.crossVectors(tmpR, tmpT).divideScalar(0.4 * rad * rad + L2);
    w.addScaledVector(tmpT, dt);
    w.multiplyScalar(Math.exp(-dt * 0.6)); // soil drags a little
    pc.tipL = Math.sqrt(L2);
    const ws = w.length();
    if (ws > 1e-5) {
      tmpQ2.setFromAxisAngle(tmpT.copy(w).divideScalar(ws), ws * dt);
      pc.mesh.position.sub(tmpP).applyQuaternion(tmpQ2).add(tmpP);
      pc.mesh.quaternion.premultiply(tmpQ2);
    }
    pc.still = 0;
  }

  // --- soft collisions ------------------------------------------------------------
  // The house collider is the cloud field itself (what is still in the house,
  // hollows included). A piece collides through its own puffs.
  _worldPuff(pc, c, out) { return out.copy(c.o).applyQuaternion(pc.mesh.quaternion).add(pc.mesh.position); }

  _hitHouse(pc, dt) {
    const p = pc.mesh.position;
    if (bodyFs(p.x, p.y, p.z) > pc.clump.rad + 0.35) return;
    let hit = false;
    // a piece pushed by the hand is not allowed to sink in: resolve fully
    const push = pc.hold ? 1 : PUSH;
    for (let pass = 0; pass < (pc.hold ? 2 : 1); pass++) for (const c of pc.colliders) {
      this._worldPuff(pc, c, tmpA);
      const d = bodyFs(tmpA.x, tmpA.y, tmpA.z) - c.r;
      if (d >= 0) continue;
      const e = 0.04;
      tmpN.set(
        bodyFs(tmpA.x + e, tmpA.y, tmpA.z) - bodyFs(tmpA.x - e, tmpA.y, tmpA.z),
        bodyFs(tmpA.x, tmpA.y + e, tmpA.z) - bodyFs(tmpA.x, tmpA.y - e, tmpA.z),
        bodyFs(tmpA.x, tmpA.y, tmpA.z + e) - bodyFs(tmpA.x, tmpA.y, tmpA.z - e),
      );
      if (tmpN.lengthSq() < 1e-10) continue;
      tmpN.normalize();
      p.addScaledVector(tmpN, -d * push);
      this._lastN.copy(tmpN);
      this._contact(pc, null, tmpN, tmpAt.copy(tmpA), dt);
      hit = true;
    }
    return hit;
  }

  _hitPieces(dt) {
    // (a bounding-sphere test per pair is the broadphase: for the tens of
    // pieces a scene can have it costs less than any spatial structure)
    const free = this._free;
    free.length = 0;
    for (const pc of this.pieces) if (pc.state === 'free') free.push(pc);
    for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
      const a = free[i], b = free[j];
      if (a.sleeping && b.sleeping) continue;
      if (a.mesh.position.distanceTo(b.mesh.position) > a.clump.rad + b.clump.rad + 0.2) continue;
      for (const ca of a.colliders) {
        for (const cb of b.colliders) {
          this._worldPuff(a, ca, tmpPA);
          this._worldPuff(b, cb, tmpPB);
          tmpN.subVectors(tmpPB, tmpPA);
          const dist = tmpN.length();
          const pen = ca.r + cb.r - dist;
          if (pen <= 0 || dist < 1e-6) continue;
          tmpN.divideScalar(dist);
          // something moving (or held) ran into a sleeper: it wakes. Two
          // pieces resting against each other leave each other be.
          if (a.sleeping !== b.sleeping) {
            const mover = a.sleeping ? b : a, sleeper = a.sleeping ? a : b;
            if (mover.hold || mover.vel.lengthSq() > 0.04) { sleeper.sleeping = false; sleeper.still = 0; }
            else continue;
          }
          // a hand-held piece does not yield; otherwise lighter pieces move more
          const ia = a.hold ? 0 : 1 / a.mass, ib = b.hold ? 0 : 1 / b.mass;
          const sum = ia + ib || 1;
          a.mesh.position.addScaledVector(tmpN, -pen * PUSH * (ia / sum));
          b.mesh.position.addScaledVector(tmpN, pen * PUSH * (ib / sum));
          this._contact(a, b, tmpN, tmpAt.copy(tmpPA).lerp(tmpPB, 0.5), dt, ia, ib);
        }
      }
    }
  }

  // n points from a toward b (or out of the house when b is null)
  _contact(a, b, n, at, dt, ia = 1, ib = 0) {
    // where it touches (for the support of a piece at rest, see _tip)
    (a.touch ||= []).length < 12 && a.touch.push([at.x, at.z]);
    if (b) (b.touch ||= []).length < 12 && b.touch.push([at.x, at.z]);
    let vn, rel;
    if (!b) {
      vn = a.vel.dot(n);
      if (vn < 0) a.vel.addScaledVector(n, -vn * (1 + this.physics.rest));
      rel = -vn;
    } else {
      tmpV.subVectors(b.vel, a.vel);
      vn = tmpV.dot(n);
      rel = -vn;
      if (vn < 0) {
        const jn = -(1 + this.physics.rest) * vn / ((ia + ib) || 1);
        a.vel.addScaledVector(n, -jn * ia);
        b.vel.addScaledVector(n, jn * ib);
      }
    }
    // cloud drags on cloud: sliding contact loses speed quickly
    const k = 1 - Math.exp(-this.physics.slide * dt);
    for (const pc of b ? [a, b] : [a]) {
      tmpV.copy(pc.vel).addScaledVector(n, -pc.vel.dot(n));
      pc.vel.addScaledVector(tmpV, -k);
      // a slow, soft turn from the rub
      pc.spin.addScaledVector(tmpS.crossVectors(n, tmpV), 0.25 * k * this.physics.spinK);
    }
    // an impact squashes the cotton a little and the surface ripples
    if (rel > 0.35) {
      for (const pc of b ? [a, b] : [a]) {
        if (pc.squashT > 0) continue;
        pc.part.stretchAxis.copy(n).applyQuaternion(tmpQ.copy(pc.mesh.quaternion).invert());
        pc.part.stretch.v -= Math.min(rel * 0.9, 2.2);
        pc.squashT = 0.35;
      }
      this.onImpact?.(at, rel, n, b ? 'piece' : 'house', a);
      if (!b && a.bumpT <= 0) {
        const local = at.clone();
        this.house.body.pressPoint.copy(local);
        this.house.body.pressDir.copy(n);
        this.house.body.u.uPressN.value.w = Math.min(0.9, a.clump.rad * 0.9);
        const P = this.physics;
        this.house.body.press.x += Math.min(rel * 0.05, 0.12) * P.impactPress;
        if (P.impactRipple > 0) this.house.ripple(this.house.body, local, Math.min(0.012 + rel * 0.01, 0.035) * P.impactRipple);
        a.bumpT = 0.4;
      }
    }
  }

  // --- per frame --------------------------------------------------------------
  update(dt, time, camera) {
    const container = this.house.container;
    if (camera) this.wisp.camPos.copy(camera.position);
    // strand while pulling (debugWisp: a strand in open air, for looking at it)
    const p = this.pull;
    const dbg = this.debugWisp;
    if (dbg) {
      this.wisp.A.copy(dbg.A); this.wisp.B.copy(dbg.B);
      this.wisp.rA = dbg.rA ?? 0.5; this.wisp.rB = dbg.rB ?? 0.42;
      if (dbg.tear && !this.wisp.torn) { this.wisp.tear(); dbg.tear = false; dbg.torn = true; }
      const frozen = dbg.freeze && this.wisp.torn && this.wisp.torn.age >= dbg.freeze;
      this.wisp.update(frozen ? 0 : dt, dbg.s, !dbg.torn);
    } else if (p && p.piece) {
      this.wisp.A.fromArray(p.clump.c).lerp(p.anchor, 0.35);
      container.localToWorld(this.wisp.A);
      // strand leaves from the piece's side facing the house
      const pc = p.piece;
      const toward = tmpS.copy(p.anchor).sub(pc.mesh.position).normalize();
      this.wisp.B.copy(pc.mesh.position).addScaledVector(toward, p.clump.rad * 0.45);
      container.localToWorld(this.wisp.B);
      this.wisp.rA = p.clump.rad * 0.55;
      this.wisp.rB = p.clump.rad * 0.45;
      this.wisp.update(dt, THREE.MathUtils.clamp(p.dist / p.breakAt, 0, 1), p.dist > 0.08);
    } else {
      const wp = this.wispPiece;
      if (this.wisp.torn && wp && wp.mesh.parent) {
        this.wisp.B.copy(wp.mesh.position);
        container.localToWorld(this.wisp.B);
      }
      this.wisp.update(dt, 0, false);
    }

    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const pc = this.pieces[i];
      pc.u.uTime.value = time;
      stepPart(pc.part, dt);
      // out of the socket a piece is lit as a free object in open air; on its
      // way home it takes the house's light back before it merges
      let freeTarget = pc.state === 'free' ? 1 : 0;
      if (pc.state === 'returning') freeTarget = 1 - THREE.MathUtils.smoothstep(pc.returning.t, 0.55, 0.95);
      pc.free = damp(pc.free, freeTarget, pc.state === 'returning' ? 9 : 2.6, dt);
      pc.u.uFree.value = pc.free;
      pc.squashT -= dt; pc.bumpT -= dt;
      if (pc.state === 'choreo') continue;
      // last frame's touches (house, other pieces) are this frame's support
      if (pc.touch && pc.touch.length) { pc.touchPrev = pc.touch; pc.touch = []; } else if (pc.touchPrev) pc.touchPrev = null;
      if (pc.state === 'held' || pc.state === 'sinking') {
        pc.pos.step(dt);
        pc.mesh.position.copy(pc.pos.x);
        if (pc.state === 'sinking' && pc.pos.x.distanceTo(pc.part.home) < 0.02 && pc.pos.v.length() < 0.08) this._absorb(pc);
        continue;
      }
      if (pc.state === 'returning') {
        const r = pc.returning;
        r.t += dt / 1.4;
        const k = THREE.MathUtils.clamp(r.t, 0, 1);
        const e = k * k * (3 - 2 * k);
        pc.mesh.position.lerpVectors(r.from, pc.part.home, e);
        pc.mesh.position.y += Math.sin(Math.PI * e) * 0.7;
        pc.mesh.quaternion.slerpQuaternions(r.q, tmpQ.identity(), e);
        if (k >= 1) this._absorb(pc, 0.14); // a small swell where it lands
        continue;
      }
      // asleep on the ground: nothing to integrate or collide (it wakes on a
      // grab, a hit, Reassemble or a world change)
      if (pc.sleeping && !pc.hold) continue;
      // free: follows the hand, or drifts and bobs
      if (pc.hold) {
        const P = this.physics;
        const target = container.worldToLocal(tmpHold.copy(pc.hold));
        target.y -= P.holdSag;
        pc.vel.subVectors(target, pc.mesh.position).multiplyScalar(8).clampLength(0, P.throwMax);
        // the hand may go behind the house; the piece stops at its surface
        // and slides along it (moved in short steps, contact after each)
        this._advance(pc, tmpB.subVectors(target, pc.mesh.position).multiplyScalar(1 - Math.exp(-dt * P.follow)), dt);
        // turned by the hand: eases toward the goal orientation
        if (pc.rotGoal) pc.mesh.quaternion.slerp(pc.rotGoal, 1 - Math.exp(-dt * 14));
        // a heavy world has a floor: the hand cannot push a piece through it
        if (P.ground) this._keepAboveFloor(pc);
      } else {
        const P = this.physics;
        pc.vel.multiplyScalar(Math.exp(-dt * P.drag));
        if (P.bob) pc.vel.y += Math.sin(time * 0.8 + pc.bob) * 0.02;
        // cloud: loose pieces drift out to a slow halo around the house
        if (P.halo) {
          tmpV.copy(pc.mesh.position).sub(HALO_C);
          tmpV.y *= 0.4;
          const d = tmpV.length();
          const want = this.stage.halo + pc.clump.rad;
          if (d < want && d > 1e-3) pc.vel.addScaledVector(tmpV.divideScalar(d), (want - d) * 0.45 * dt);
        }
        // turf: it has weight
        pc.vel.y -= P.gravity * dt;
        this._advance(pc, tmpB.copy(pc.vel).multiplyScalar(dt), dt);
        // the stage is soft-walled: loose pieces stay in the frame around the
        // house instead of drifting under the controls or out of view
        tmpV.copy(pc.mesh.position).sub(HALO_C).setY(0);
        const far = tmpV.length() - this.stage.far;
        if (far > 0) pc.vel.addScaledVector(tmpV.normalize(), -far * 3.5 * dt);
        if (!P.ground && pc.mesh.position.y < 0.4) pc.vel.y += (0.4 - pc.mesh.position.y) * 6 * dt;
        if (P.ground) this._ground(pc, dt);
        if (pc.mesh.position.y > 9.5) pc.vel.y -= (pc.mesh.position.y - 9.5) * 4 * dt;
        if (!P.ground && pc.mesh.position.y < -0.2) { pc.mesh.position.y = -0.2; pc.vel.y = Math.abs(pc.vel.y) * 0.25; }
      }
      // the house is solid to a loose piece, even one in the hand
      this._hitHouse(pc, dt);
      // a slow turn, plus whatever the last bump or flick gave it
      if (!pc.hold) {
        pc.spin.multiplyScalar(Math.exp(-dt * this.physics.spinDamp));
        const sw = pc.spin.length();
        if (sw > 1e-4) pc.mesh.rotateOnWorldAxis(tmpV.copy(pc.spin).divideScalar(sw), sw * dt);
        if (this.physics.halo) pc.mesh.rotateY(dt * 0.06);
      } else pc.spin.set(0, 0, 0);
      const sp = pc.vel.length();
      if (pc.squashT <= 0) {
        if (sp > 0.05) {
          pc.part.stretchAxis.copy(pc.vel).normalize().applyQuaternion(tmpQ.copy(pc.mesh.quaternion).invert());
          pc.part.stretch.target = Math.min(sp * 0.035, 0.22);
        } else pc.part.stretch.target = 0;
      } else pc.part.stretch.target = 0;
      // settled: resting (on the ground, the house or another piece), barely
      // moving, for a moment → sleep. Only in a world with weight: a cloud
      // piece keeps drifting.
      // (a piece over no support is still turning over: it stays awake)
      if (!pc.hold && this.physics.ground && sp < 0.05 && pc.spin.lengthSq() < 0.0025 && !pc.unstable) {
        pc.still = (pc.still || 0) + dt;
        if (pc.still > (pc.grounded ? 0.6 : 0.8)) { pc.sleeping = true; pc.vel.set(0, 0, 0); pc.spin.set(0, 0, 0); pc.part.stretch.target = 0; }
      } else pc.still = 0;
      // a piece that keeps a little speed but goes nowhere (a sod propped on
      // another, the two nudging each other by millimetres) settles too:
      // under 4 cm and ~3.5° in 2 s is at rest to the eye
      if (!pc.hold && this.physics.ground && !pc.sleeping) {
        const r = pc.rest || (pc.rest = { p: pc.mesh.position.clone(), q: pc.mesh.quaternion.clone(), t: 0 });
        if (r.p.distanceToSquared(pc.mesh.position) > 0.0016 || r.q.angleTo(pc.mesh.quaternion) > 0.06) {
          r.p.copy(pc.mesh.position); r.q.copy(pc.mesh.quaternion); r.t = 0;
        } else if ((r.t += dt) > 2) {
          pc.sleeping = true; pc.vel.set(0, 0, 0); pc.spin.set(0, 0, 0); pc.part.stretch.target = 0; r.t = 0;
        }
      } else if (pc.rest) pc.rest.t = 0;
    }
    this._hitPieces(dt);
  }

  meshes(out = []) { for (const p of this.pieces) if (p.state === 'free') out.push(p.mesh); return out; }
  // anything that moves the ground shadow: a piece awake, flying home or in a
  // hand. (Choreography pieces move only with the scene's timeline, which
  // the caller checks: at rest they are as still as the house.)
  anyMoving() {
    for (const pc of this.pieces) if (pc.state === 'free' ? !pc.sleeping : pc.state !== 'choreo') return true;
    return false;
  }
}
