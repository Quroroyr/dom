import * as THREE from 'three';
import { SPHERES, clumpAt, skinDepth } from '../house/sdf.js';

// Wildflowers (turf world): a brush that grows flowers out of the turf.
//
// Each flower is a small built plant — stem, a leaf or two, a head — of one
// of five kinds (daisy, buttercup, clover, bluebell, poppy), with its own
// tint, size, lean and turn. They are drawn instanced, one draw per kind, and
// sway in the world's breeze.
//
// A flower belongs to the clump it grew on. It keeps its pose in the house's
// rest frame; every frame it follows whatever shows that clump now: the house
// itself, a torn sod (in the hand, thrown, lying on the ground, flying home)
// or the lifted layer of a choreography. So flowers leave with a sod, come
// back on Reassemble and ride the facade when it opens, with no extra state.
//
// They grow on the grass skin only: the house where its turf is (not the
// earth of a socket), a sod on its turf side. Strokes share the paint's
// clock, so Undo steps back through paint and flowers in the order they
// were laid (see PaintManager.extras).

const CAP = 1400; // per kind
const SPACING = 0.085; // m between two flowers
const UP = new THREE.Vector3(0, 1, 0);
const HS = 1.45; // heads: sized to read from the scene's distance, stems stay slender

// --- the plants -----------------------------------------------------------------

const col = (hex) => new THREE.Color(hex);
const STEM = col('#5d8a3a'), STEM_DARK = col('#46702e'), LEAF = col('#6f9c46'), BRACT = col('#577f35');

class Build {
  constructor() { this.p = []; this.c = []; this.k = []; }
  tri(a, b, c, color, petal = 0) {
    for (const v of [a, b, c]) { this.p.push(v.x, v.y, v.z); this.c.push(color.r, color.g, color.b); this.k.push(petal); }
  }
  quad(a, b, c, d, color, petal = 0) { this.tri(a, b, c, color, petal); this.tri(a, c, d, color, petal); }
  // a fan from a to the arc points
  fan(a, arc, color, petal = 0) { for (let i = 0; i < arc.length - 1; i++) this.tri(a, arc[i], arc[i + 1], color, petal); }
  geometry(top) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aPetal', new THREE.Float32BufferAttribute(this.k, 1));
    // how far up the plant a vertex is: the breeze bends the top, not the root
    const h = new Float32Array(this.p.length / 3);
    for (let i = 0; i < h.length; i++) h[i] = THREE.MathUtils.clamp(this.p[i * 3 + 1] / top, 0, 1.1);
    g.setAttribute('aH', new THREE.BufferAttribute(h, 1));
    g.computeVertexNormals();
    return g;
  }
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// a slightly bent, tapered stem; returns its centre line
function stem(b, H, bend, sides = 5, segs = 7) {
  const at = (t) => V(bend * t * t, H * t, 0);
  const rad = (t) => THREE.MathUtils.lerp(0.0068, 0.0042, t);
  const ring = (t) => {
    const c = at(t), r = rad(t), out = [];
    for (let s = 0; s < sides; s++) { const a = (s / sides) * Math.PI * 2; out.push(V(c.x + Math.cos(a) * r, c.y, c.z + Math.sin(a) * r)); }
    return out;
  };
  let prev = ring(0);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs, cur = ring(t), c = t < 0.3 ? STEM_DARK : STEM;
    for (let s = 0; s < sides; s++) b.quad(prev[s], prev[(s + 1) % sides], cur[(s + 1) % sides], cur[s], c);
    prev = cur;
  }
  return at;
}
// a pointed leaf off the stem, rising outward
function leaf(b, from, angle, len, width, rise = 0.55, color = LEAF) {
  const d = V(Math.cos(angle), rise, Math.sin(angle)).normalize();
  const side = V(-Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(width);
  const mid = from.clone().addScaledVector(d, len * 0.45).add(V(0, len * 0.08, 0));
  const tip = from.clone().addScaledVector(d, len).add(V(0, -len * 0.12, 0));
  b.quad(from, mid.clone().add(side), tip, mid.clone().sub(side), color);
}
// a petal: a narrow base, widest past the middle, rounded tip; lifted by `el`
function petal(b, T, angle, r0, r1, w, el, color, cupK = 0) {
  r0 *= HS; r1 *= HS; w *= HS;
  const pt = (r, across) => {
    const e = el + cupK * (r - r0) / (r1 - r0);
    const h = V(Math.cos(angle), 0, Math.sin(angle)), s = V(-Math.sin(angle), 0, Math.cos(angle));
    return T.clone().addScaledVector(h, r * Math.cos(e)).add(V(0, r * Math.sin(e), 0)).addScaledVector(s, across);
  };
  const m = r0 + (r1 - r0) * 0.62;
  const a = pt(r0, -w * 0.35), bb = pt(r0, w * 0.35), c = pt(m, w), d = pt(m, -w), tip = pt(r1, 0);
  const tl = pt(r1 - (r1 - r0) * 0.12, -w * 0.55), tr = pt(r1 - (r1 - r0) * 0.12, w * 0.55);
  b.quad(a, bb, c, d, color, 1);
  b.quad(d, c, tr, tl, color, 1);
  b.tri(tl, tr, tip, color, 1);
}
// a small rounded knob (octahedron, stretched)
function knob(b, c, r, h, color, petalK = 0) {
  r *= HS; h *= HS;
  const top = c.clone().add(V(0, h, 0)), bot = c.clone().add(V(0, -h * 0.4, 0));
  const ring = [0, 1, 2, 3, 4, 5].map((i) => c.clone().add(V(Math.cos(i / 6 * Math.PI * 2) * r, 0, Math.sin(i / 6 * Math.PI * 2) * r)));
  for (let i = 0; i < 6; i++) { const n = ring[(i + 1) % 6]; b.tri(ring[i], n, top, color, petalK); b.tri(n, ring[i], bot, color, petalK); }
}

const WHITE = col('#ffffff');
const KINDS = [
  {
    id: 'daisy', weight: 0.3, tints: ['#f7f4ea', '#f5efe2', '#f2dde3', '#ece4f3'],
    build() {
      const b = new Build(), H = 0.46, at = stem(b, H, 0.03);
      leaf(b, at(0.22), 0.4, 0.07, 0.012); leaf(b, at(0.36), 3.4, 0.06, 0.011);
      const T = at(1);
      knob(b, T.clone().add(V(0, -0.006, 0)), 0.014, 0.006, BRACT);
      for (let i = 0; i < 13; i++) petal(b, T.clone().add(V(0, 0.004, 0)), (i / 13) * Math.PI * 2 + (i % 2) * 0.1, 0.011, 0.058 + (i % 3) * 0.004, 0.0085, 0.16, WHITE);
      knob(b, T.clone().add(V(0, 0.006, 0)), 0.016, 0.009, col('#e9c23b'));
      return b.geometry(H);
    },
  },
  {
    id: 'buttercup', weight: 0.22, tints: ['#f3cf43', '#f6da5e', '#eec13a', '#f6e28e'],
    build() {
      const b = new Build(), H = 0.44, at = stem(b, H, -0.035);
      leaf(b, at(0.28), 1.2, 0.06, 0.016, 0.35); leaf(b, at(0.3), 4.1, 0.055, 0.015, 0.35);
      const T = at(1);
      knob(b, T.clone().add(V(0, -0.004, 0)), 0.009, 0.006, BRACT);
      for (let i = 0; i < 5; i++) petal(b, T, (i / 5) * Math.PI * 2, 0.004, 0.036, 0.016, 0.55, WHITE, 0.45);
      knob(b, T.clone().add(V(0, 0.004, 0)), 0.008, 0.008, col('#c4b13a'));
      return b.geometry(H);
    },
  },
  {
    id: 'clover', weight: 0.2, tints: ['#dc8db2', '#e8abc6', '#f1e9ee', '#c97cab'],
    build() {
      const b = new Build(), H = 0.38, at = stem(b, H, 0.02);
      // trefoil: three round leaflets
      const base = at(0.3);
      for (let i = 0; i < 3; i++) {
        const a = i / 3 * Math.PI * 2 + 0.3, c = base.clone().add(V(Math.cos(a) * 0.026, 0.004, Math.sin(a) * 0.026));
        const arc = []; for (let s = 0; s <= 8; s++) { const q = s / 8 * Math.PI * 2; arc.push(c.clone().add(V(Math.cos(q) * 0.017, 0, Math.sin(q) * 0.017))); }
        b.fan(c, arc, LEAF);
      }
      // the head: a pompom of little florets
      const T = at(1).add(V(0, 0.016 * HS, 0));
      const ico = new THREE.IcosahedronGeometry(0.023 * HS, 1).toNonIndexed();
      const pa = ico.getAttribute('position');
      const jit = (i) => 1 + 0.12 * Math.sin(i * 12.9898);
      for (let i = 0; i < pa.count; i += 3) {
        const v = [0, 1, 2].map((k) => V(pa.getX(i + k), pa.getY(i + k) * 1.1, pa.getZ(i + k)).multiplyScalar(jit(i + k)).add(T));
        b.tri(v[0], v[1], v[2], WHITE, 1);
      }
      ico.dispose();
      knob(b, T.clone().add(V(0, -0.02 * HS, 0)), 0.012, 0.006, BRACT);
      return b.geometry(H + 0.04);
    },
  },
  {
    id: 'bluebell', weight: 0.14, tints: ['#8492d8', '#9b90dd', '#7489cb', '#b2a5e6'],
    build() {
      const b = new Build(), H = 0.5, at = stem(b, H, 0.11);
      // long strap leaves at the foot
      leaf(b, at(0.02), 0.2, 0.16, 0.012, 1.4); leaf(b, at(0.02), 2.6, 0.14, 0.011, 1.3);
      // bells hang from the arch on short stalks, open side down
      for (const [t, k] of [[0.74, 0.85], [0.86, 0.95], [0.98, 1]]) {
        const s = at(t), apex = s.clone().add(V(0.012, -0.012, 0.004));
        b.tri(s, apex, apex.clone().add(V(0, 0, 0.003)), STEM);
        const L = 0.034 * k * HS, R = 0.015 * k * HS, sides = 7, mouth = [], flare = [];
        for (let i = 0; i < sides; i++) {
          const a = i / sides * Math.PI * 2;
          mouth.push(apex.clone().add(V(Math.cos(a) * R, -L, Math.sin(a) * R)));
          flare.push(apex.clone().add(V(Math.cos(a + 0.2) * R * 1.45, -L * 1.1, Math.sin(a + 0.2) * R * 1.45)));
        }
        for (let i = 0; i < sides; i++) {
          const n = (i + 1) % sides;
          b.tri(apex, mouth[i], mouth[n], WHITE, 1);
          b.quad(mouth[i], flare[i], flare[n], mouth[n], WHITE, 1);
        }
      }
      return b.geometry(H);
    },
  },
  {
    id: 'poppy', weight: 0.14, tints: ['#e05a40', '#ea7b4b', '#d8493d', '#f1a45e'],
    build() {
      const b = new Build(), H = 0.52, at = stem(b, H, -0.05);
      leaf(b, at(0.2), 2.2, 0.075, 0.017, 0.4); leaf(b, at(0.34), 5.4, 0.065, 0.015, 0.45);
      const T = at(1);
      for (let i = 0; i < 4; i++) petal(b, T, (i / 4) * Math.PI * 2 + 0.3, 0.006, 0.056, 0.03, 0.62, WHITE, 0.35);
      knob(b, T.clone().add(V(0, 0.006, 0)), 0.012, 0.012, col('#6c7a3d'));
      knob(b, T.clone().add(V(0, 0.016, 0)), 0.009, 0.003, col('#2b2622'));
      return b.geometry(H);
    },
  },
];
const WSUM = KINDS.reduce((s, k) => s + k.weight, 0);
function pickKind() {
  let r = Math.random() * WSUM;
  for (let i = 0; i < KINDS.length; i++) { r -= KINDS[i].weight; if (r <= 0) return i; }
  return 0;
}

// stems and leaves keep their own green; petals take the flower's tint.
// The breeze bends each plant from the root up, each on its own phase.
function flowerMaterial(shared) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = shared.uTime;
    s.uniforms.uWind = shared.uWind;
    s.vertexShader = 'attribute float aPetal;\nattribute float aH;\nattribute vec3 aTint;\nattribute float aPhase;\nuniform float uTime;\nuniform vec4 uWind;\n' + s.vertexShader
      .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.rgb = mix(vColor.rgb, aTint, aPetal);')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
  float bendW = aH * aH;
  float gust = sin(uTime * 1.6 + aPhase) * 0.6 + sin(uTime * 2.9 + aPhase * 1.7) * 0.25;
  transformed.x += bendW * (0.012 + 0.03 * uWind.z) * gust;
  transformed.z += bendW * 0.01 * cos(uTime * 1.25 + aPhase);`);
  };
  m.customProgramCacheKey = () => 'cloudhouse-flowers';
  return m;
}

// --- the field ----------------------------------------------------------------------

const _m = new THREE.Matrix4(), _M = new THREE.Matrix4(), _T = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _s = new THREE.Vector3();
const _o = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _u = new THREE.Vector3();

export class FlowerField {
  constructor({ house, tearing, shared, paint }) {
    this.house = house;
    this.tearing = tearing;
    this.paint = paint;
    this.group = new THREE.Group();
    this.group.name = 'flowers';
    this.group.visible = false;
    house.container.add(this.group);
    const mat = flowerMaterial(shared);
    this.kinds = KINDS.map((k) => {
      const geo = k.build();
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3));
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1));
      const mesh = new THREE.InstancedMesh(geo, mat, CAP);
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false; // instances move with the pieces; bounds would go stale
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      return { k, mesh, list: [], tints: k.tints.map(col), dirty: false };
    });
    this.byClump = new Map();  // clump id → its flowers
    this.frames = new Map();   // clump id → the matrix its flowers were last placed with
    this.grid = new Map();     // spacing lookup (rest frame)
    this.total = 0;
    this.undo = [];
    this.cur = null;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
  }

  // --- bookkeeping ----------------------------------------------------------------
  _cell(p) { return `${Math.floor(p.x / SPACING)},${Math.floor(p.y / SPACING)},${Math.floor(p.z / SPACING)}`; }
  _crowded(p) {
    const ci = Math.floor(p.x / SPACING), cj = Math.floor(p.y / SPACING), ck = Math.floor(p.z / SPACING);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
      const l = this.grid.get(`${ci + i},${cj + j},${ck + k}`);
      if (l) for (const f of l) if (f.p.distanceToSquared(p) < SPACING * SPACING) return true;
    }
    return false;
  }
  _add(f) {
    const K = this.kinds[f.kind];
    if (K.list.length >= CAP) return false;
    f.i = K.list.length;
    K.list.push(f);
    this._write(K, f);
    K.mesh.count = K.list.length;
    let l = this.byClump.get(f.clump);
    if (!l) this.byClump.set(f.clump, (l = []));
    l.push(f);
    const key = this._cell(f.p);
    if (!this.grid.has(key)) this.grid.set(key, []);
    this.grid.get(key).push(f);
    this.total++;
    return true;
  }
  _remove(f) {
    const K = this.kinds[f.kind];
    if (K.list[f.i] !== f) return;
    const last = K.list.pop();
    if (last !== f) { last.i = f.i; K.list[f.i] = last; this._write(K, last); }
    K.mesh.count = K.list.length;
    K.dirty = true;
    const l = this.byClump.get(f.clump);
    l.splice(l.indexOf(f), 1);
    if (!l.length) { this.byClump.delete(f.clump); this.frames.delete(f.clump); }
    const g = this.grid.get(this._cell(f.p));
    g.splice(g.indexOf(f), 1);
    this.total--;
  }
  _write(K, f) {
    const g = K.mesh.geometry;
    g.attributes.aTint.setXYZ(f.i, f.tint.r, f.tint.g, f.tint.b);
    g.attributes.aPhase.setX(f.i, f.phase);
    g.attributes.aTint.needsUpdate = g.attributes.aPhase.needsUpdate = true;
    K.mesh.setMatrixAt(f.i, _m.multiplyMatrices(this._frame(f.clump), f.rest));
    K.dirty = true;
  }

  // what shows a clump now: a piece (single, or a layer lifted as one) or the
  // house. Returns the matrix from the rest frame to the house container.
  _pieceOf() {
    const map = this._map || (this._map = new Map());
    map.clear();
    for (const pc of this.tearing.pieces) {
      if (pc.clumpId >= 0) { map.set(pc.clumpId, pc); continue; }
      if (!pc._clumps) pc._clumps = [...new Set(pc.clump.ids.map((i) => SPHERES[i].clump))];
      for (const id of pc._clumps) map.set(id, pc);
    }
    return map;
  }
  _frame(clump, map = this._pieceOf()) {
    const pc = map.get(clump);
    if (!pc) return _M.identity();
    pc.mesh.updateMatrix();
    return _M.multiplyMatrices(pc.mesh.matrix, _T.makeTranslation(-pc.part.home.x, -pc.part.home.y, -pc.part.home.z));
  }

  // every frame: flowers follow their clumps (only the ones that moved)
  update(active) {
    this.group.visible = active && this.total > 0;
    if (!this.group.visible) return;
    const map = this._pieceOf();
    for (const [clump, list] of this.byClump) {
      const F = this._frame(clump, map);
      const prev = this.frames.get(clump);
      if (prev && F.equals(prev)) continue;
      if (prev) prev.copy(F); else this.frames.set(clump, F.clone());
      for (const f of list) {
        const K = this.kinds[f.kind];
        K.mesh.setMatrixAt(f.i, _m.multiplyMatrices(F, f.rest));
        K.dirty = true;
      }
    }
    for (const K of this.kinds) if (K.dirty) { K.mesh.instanceMatrix.needsUpdate = true; K.dirty = false; }
  }

  // --- the brush ----------------------------------------------------------------------
  // hit: { piece?, local, normal } from Interaction.pick (house container or piece frame)
  dab(hit, brush) {
    this.begin();
    if (brush.erase) return this._erase(hit, brush);
    const pc = hit.piece;
    const frame = pc ? pc.mesh : this.house.container;
    const targets = pc ? [pc.mesh] : this.house.meshes([]);
    const pivot = pc ? pc.part.home : null;
    frame.updateMatrixWorld();
    const n = _n.copy(hit.normal).normalize();
    _t1.copy(Math.abs(n.y) < 0.9 ? UP : _u.set(1, 0, 0)).cross(n).normalize();
    _t2.crossVectors(n, _t1);
    const R = brush.radius;
    // opacity reads as density: ~8 to ~50 flowers per m², a share of it per dab
    // (dabs along a stroke overlap several times)
    const perDab = Math.max(2, Math.round((8 + brush.opacity * 50) * Math.PI * R * R * 0.34));
    const hard = 1 - THREE.MathUtils.clamp(brush.softness, 0, 1) * 0.9;
    for (let s = 0; s < perDab; s++) {
      const r = Math.sqrt(Math.random()) * R, a = Math.random() * Math.PI * 2;
      // a soft brush thins out toward its edge
      if (Math.random() > 1 - THREE.MathUtils.smoothstep(r / R, hard, 1)) continue;
      _o.copy(hit.local).addScaledVector(_t1, Math.cos(a) * r).addScaledVector(_t2, Math.sin(a) * r).addScaledVector(n, 0.45);
      _d.copy(n).negate();
      this.ray.set(_o.applyMatrix4(frame.matrixWorld), _d.transformDirection(frame.matrixWorld));
      this.ray.far = 1.0;
      const h = this.ray.intersectObjects(targets, false)[0];
      if (!h) continue;
      const local = frame.worldToLocal(_p.copy(h.point));
      const rest = pivot ? local.add(pivot) : local; // (bricks: the container frame is the rest frame)
      const nr = h.face.normal; // object space: bricks — house frame; a piece — its rest frame
      // only where the turf is: the house's grass skin; a sod's turf side
      if (pc) {
        if (!pc.sod || (pc.clump.skin ?? 1) < 0.5 || nr.dot(pc.turfDir) < 0.3) continue;
      } else if (skinDepth(rest.x, rest.y, rest.z) > 0.045) continue;
      if (this._crowded(rest)) continue;
      const clump = pc && pc.clumpId >= 0 ? pc.clumpId : clumpAt(rest.x, rest.y, rest.z);
      if (clump < 0) continue;
      this._grow(rest, nr, clump);
    }
    this._flushDirty();
  }
  _grow(at, n, clump) {
    const p = at.clone();
    const kind = pickKind(), K = this.kinds[kind];
    // stems lean toward the light a little, each a bit its own way
    _u.copy(n).addScaledVector(UP, 0.8).normalize();
    _u.x += (Math.random() - 0.5) * 0.3; _u.z += (Math.random() - 0.5) * 0.3;
    _u.normalize();
    _q.setFromUnitVectors(UP, _u).multiply(_q2.setFromAxisAngle(UP, Math.random() * Math.PI * 2));
    const s = 0.78 + Math.random() * 0.5;
    const rest = new THREE.Matrix4().compose(_p.copy(p).addScaledVector(n, -0.03), _q, _s.set(s, s * (0.85 + Math.random() * 0.3), s));
    const tint = K.tints[(Math.random() * K.tints.length) | 0].clone().offsetHSL((Math.random() - 0.5) * 0.02, 0, (Math.random() - 0.5) * 0.05);
    const f = { kind, clump, p, rest, tint, phase: Math.random() * 6.28 };
    if (this._add(f)) this.cur.added.push(f);
  }
  _erase(hit, brush) {
    const pc = hit.piece;
    const center = pc ? _p.copy(hit.local).add(pc.part.home) : _p.copy(hit.local);
    const map = this._pieceOf();
    const R2 = brush.radius * brush.radius;
    const gone = [];
    for (const [clump, list] of this.byClump) {
      // only what shows on the thing under the brush
      if ((map.get(clump) || null) !== (pc || null)) continue;
      for (const f of list) if (f.p.distanceToSquared(center) < R2) gone.push(f);
    }
    for (const f of gone) { this._remove(f); this.cur.removed.push(f); }
    this._flushDirty();
  }
  _flushDirty() {
    for (const K of this.kinds) if (K.dirty) { K.mesh.instanceMatrix.needsUpdate = true; K.dirty = false; }
    this.frames.clear(); // the next update re-places every clump once
  }

  // --- history (shares the paint's clock) ------------------------------------------------
  begin() { if (!this.cur) this.cur = { added: [], removed: [] }; }
  end() {
    const c = this.cur;
    this.cur = null;
    if (!c || (!c.added.length && !c.removed.length)) return;
    this.undo.push({ seq: this.paint.tick(), ...c });
    if (this.undo.length > 60) this.undo.shift();
    this.paint.changed();
  }
  lastSeq() { return this.undo.length ? this.undo[this.undo.length - 1].seq : -1; }
  undoOne() {
    const u = this.undo.pop();
    if (!u) return;
    for (const f of u.added) this._remove(f);
    for (const f of u.removed) this._add(f);
    this._flushDirty();
  }
  count() { return this.total; }
  clear() {
    this.cur = null;
    for (const K of this.kinds) { K.list.length = 0; K.mesh.count = 0; }
    this.byClump.clear(); this.frames.clear(); this.grid.clear();
    this.total = 0;
    this.undo.length = 0;
  }
}
