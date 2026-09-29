// Cloud House — one continuous cloud field.
//
// The whole house (cloud bank, walls, roof, facade, chimney, tufts) is ONE
// smooth union of ~120 puffs. Puffs belong to clumps, and clumps to layers:
//   0 outer tufts · 1 secondary masses · 2 architectural core
// Tearing a clump removes its puffs from the field: the surface is re-meshed
// locally (bricks), so the house really loses that volume, and the torn piece
// is meshed from exactly the same puffs (it inherits its shape, even carved
// window holes). Door, windows and the room are carved cavities.

const { abs, max, min, hypot, floor, sqrt } = Math;
// Math.hypot is slow in V8; the field is evaluated millions of times
const len3 = (a, b, c) => sqrt(a * a + b * b + c * c);
const len2 = (a, b) => sqrt(a * a + b * b);

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smin = (a, b, k) => {
  const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
  return b + (a - b) * h - k * h * (1 - h);
};
export const smax = (a, b, k) => -smin(-a, -b, k);

export const FLOAT = 0.8; // the house hovers this high above the floor
export const SUN_DIR = (() => {
  const v = [-0.58, 0.6, 0.55];
  const l = hypot(...v);
  return v.map((x) => x / l);
})();

// ---------------------------------------------------------------------------
// noise

function hash3(i, j, k) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, z) {
  const i = floor(x), j = floor(y), k = floor(z);
  const u = fade(x - i), v = fade(y - j), w = fade(z - k);
  const a = hash3(i, j, k), b = hash3(i + 1, j, k), c = hash3(i, j + 1, k), d = hash3(i + 1, j + 1, k);
  const e = hash3(i, j, k + 1), f = hash3(i + 1, j, k + 1), g = hash3(i, j + 1, k + 1), h = hash3(i + 1, j + 1, k + 1);
  const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u;
  const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
  return y1 + (y2 - y1) * w;
}
export function billow(x, y, z) {
  const n1 = vnoise(x * 1.15 + 11.3, y * 1.15 + 3.1, z * 1.15 - 7.7);
  const n2 = vnoise(x * 3.7 - 2.3, y * 3.7 + 8.9, z * 3.7 + 1.7);
  return (1 - abs(n1 * 2 - 1)) * 0.16 + (1 - abs(n2 * 2 - 1)) * 0.022;
}

// ---------------------------------------------------------------------------
// primitives

// an arched opening: round top, straight sides, flat sill
function archDist(x, y, z, c) {
  const dy = y > c.yt ? y - c.yt : 0;
  return max(len2(x - c.x, dy) - c.r, c.yb - y, abs(z - c.z) - c.depth);
}
function capsule(x, y, z, a, b, r) {
  const px = x - a[0], py = y - a[1], pz = z - a[2];
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const h = clamp((px * bx + py * by + pz * bz) / (bx * bx + by * by + bz * bz), 0, 1);
  return len3(px - bx * h, py - by * h, pz - bz * h) - r;
}
function ellipsoid(x, y, z, c, r) {
  const k0 = len3((x - c[0]) / r[0], (y - c[1]) / r[1], (z - c[2]) / r[2]);
  const k1 = len3((x - c[0]) / (r[0] * r[0]), (y - c[1]) / (r[1] * r[1]), (z - c[2]) / (r[2] * r[2]));
  return k1 < 1e-6 ? -min(...r) : (k0 * (k0 - 1)) / k1;
}

// ---------------------------------------------------------------------------
// the cottage, as clumps of puffs

export const SPHERES = []; // { x, y, z, r, sx, sy, sz, R, layer, clump }
export const CLUMPS = []; // { id, layer, tag, ids, c:[x,y,z], rad }
export const SPEC = {};
export const ORIGIN = [0, 6, 0];
export const LAYERS = ['outer tufts', 'cloud masses', 'architectural core', 'interior shell'];

// a puff: an ellipsoid (sx, sy, sz squash it; walls use flattened puffs)
const S = (x, y, z, r, sy = 1, sx = 1, sz = 1) => [x, y, z, r, sy, sx, sz];
const jit = (i, y, z) => Math.sin(i * 12.9898 + y * 78.233 + z * 3.1) * 0.5;
function row(x0, x1, n, y, z, r, sy = 1, sx = 1, sz = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const j = jit(i, y, z);
    out.push(S(x0 + (x1 - x0) * t, y + j * 0.06, z + j * 0.04, r * (1 + j * 0.1), sy, sx, sz));
  }
  return out;
}
function clump(layer, tag, list) {
  const id = CLUMPS.length;
  const ids = [];
  let cx = 0, cy = 0, cz = 0, w = 0;
  for (const s of list) {
    ids.push(SPHERES.length);
    const [x, y, z, r, sy, sx, sz] = s;
    SPHERES.push({
      x, y, z, r, sx, sy, sz, R: r * max(sx, sy, sz), rmin: r * min(sx, sy, sz),
      ell: sx !== 1 || sy !== 1 || sz !== 1, ix: 1 / (r * sx), iy: 1 / (r * sy), iz: 1 / (r * sz), k: min(K, r * 0.8),
      layer, clump: id,
    });
    const m = r ** 3 * sx * sy * sz;
    cx += x * m; cy += y * m; cz += z * m; w += m;
  }
  const c = [cx / w, cy / w, cz / w];
  let rad = 0;
  for (const s of list) rad = max(rad, hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3] * max(s[4], s[5], s[6]));
  CLUMPS.push({ id, layer, tag, ids, c, rad });
  return id;
}
const each = (layer, tag, list) => list.forEach((s) => clump(layer, tag, [s]));
const groups = (layer, tag, list, n) => { for (let i = 0; i < list.length; i += n) clump(layer, tag, list.slice(i, i + n)); };
const tuft = (at, list) => list.map((s) => S(s[0] + at[0], s[1] + at[1], s[2] + at[2], s[3], s[4], s[5], s[6]));

// a soft puff ring around a round window (arched openings stay bare: puff
// rings around the door and the tall window drew letters on the facade)
function roundRim(w, rr = 0.15) {
  const d = [w.b[0] - w.a[0], w.b[1] - w.a[1], w.b[2] - w.a[2]];
  const l = hypot(...d); d[0] /= l; d[1] /= l; d[2] /= l;
  const c = [w.b[0] - d[0] * w.rimAt, w.b[1] - d[1] * w.rimAt, w.b[2] - d[2] * w.rimAt];
  let u = [-d[2], 0, d[0]];
  const ul = hypot(...u); u = u.map((v) => v / ul);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const out = [];
  const R = w.r + 0.13;
  for (let i = 0; i < 7; i++) {
    const a = (Math.PI * 2 * i) / 7 + 0.4;
    const ca = Math.cos(a), sa = Math.sin(a);
    out.push(S(c[0] + (u[0] * ca + v[0] * sa) * R, c[1] + (u[1] * ca + v[1] * sa) * R, c[2] + (u[2] * ca + v[2] * sa) * R, rr));
  }
  return out;
}

export function buildVariant() {
  SPHERES.length = 0;
  CLUMPS.length = 0;

  // A cottage: long side to the front, gable ends left and right.
  // Walls stand at z = ±1.55 and x = ±2.45; the ridge runs along x at y ≈ 6.
  // One quiet room is carved inside: one door, a tall window over a small
  // balcony, a porthole, a side window, an attic window, a back light.
  SPEC.room = { c: [0.0, 2.62, 0.0], r: [1.92, 1.02, 1.0] };
  SPEC.door = { x: -0.85, yb: 1.3, yt: 2.3, r: 0.5, z: 1.7, depth: 1.15 };
  SPEC.arch = { x: 1.2, yb: 2.4, yt: 3.08, r: 0.37, z: 1.7, depth: 1.15 };
  SPEC.windows = [
    { a: [-1.5, 3.4, -0.35], b: [-3.5, 3.44, -0.35], r: 0.27, rimAt: 0.4 }, // porthole, left gable (on the facade it paired with the tall window into a face)
    { a: [1.4, 2.8, 0.15], b: [3.45, 2.84, 0.15], r: 0.36, rimAt: 0.35 }, // side window (x+)
    { a: [1.9, 4.72, 0.0], b: [3.4, 4.74, 0.0], r: 0.25, rimAt: 0.35 }, // attic, right gable
    { a: [0.55, 2.8, -0.5], b: [0.6, 2.86, -2.7], r: 0.5, noRim: true }, // back daylight
  ];

  // 3 · interior shell: floor, ceiling, four corner posts — the skeleton
  each(3, 'floor', [...row(-1.6, 1.6, 3, 1.28, -0.55, 0.85, 0.4), ...row(-1.6, 1.6, 3, 1.28, 0.55, 0.85, 0.4)]);
  each(3, 'ceiling', [...row(-1.6, 1.6, 3, 3.98, -0.55, 0.82, 0.38), ...row(-1.6, 1.6, 3, 3.98, 0.55, 0.82, 0.38)]);
  for (const [px, pz] of [[-2.3, 1.4], [2.3, 1.4], [-2.3, -1.4], [2.3, -1.4]])
    clump(3, 'post', [S(px, 1.55, pz, 0.46), S(px, 2.45, pz, 0.44), S(px, 3.35, pz, 0.44), S(px, 4.05, pz, 0.42)]);

  // 2 · architectural core: flattened wall puffs, gable triangles, ridge
  const cols = (xs, z, sz) => xs.flatMap((x) => [1.6, 2.5, 3.4].map((y, i) => S(x + jit(i, y, z) * 0.06, y, z, 0.74, 1, 1, sz)));
  groups(2, 'core-front', cols([-1.55, -0.55, 0.45, 1.45], 1.55, 0.52), 3);
  groups(2, 'core-back', cols([-1.55, -0.55, 0.45, 1.45], -1.55, 0.52), 3);
  for (const sx of [-1, 1]) {
    groups(2, 'core-side', [-0.72, 0.72].flatMap((z) => [1.6, 2.5, 3.4].map((y) => S(sx * 2.45, y, z, 0.74, 1, 0.52, 1))), 3);
    clump(2, 'gable', [S(sx * 2.45, 4.3, -0.75, 0.62, 1, 0.5), S(sx * 2.45, 4.35, 0.75, 0.62, 1, 0.5), S(sx * 2.45, 5.05, 0, 0.64, 1, 0.5), S(sx * 2.45, 5.7, 0, 0.5, 1, 0.5), S(sx * 2.45, 6.1, 0, 0.36, 1, 0.5)]);
  }
  groups(2, 'ridge', row(-2.4, 2.4, 6, 6.05, 0, 0.44), 2);
  // rafters: once the roof cloud is gone the house keeps an A-frame
  for (const rx of [-1.45, -0.45, 0.55, 1.5]) for (const sz of [-1, 1])
    clump(2, 'rafter', [S(rx, 4.45, sz * 1.95, 0.32), S(rx, 4.98, sz * 1.35, 0.32), S(rx, 5.5, sz * 0.72, 0.32)]);

  // 1 · cloud masses: puffy cladding over the walls, roof slopes, the bank.
  // The front cladding is flatter (sz .5): a calm soft wall lets the door and
  // the tall window read as openings; the puff lives in roof, corners, bank.
  groups(1, 'clad-front', [S(-2.05, 1.75, 1.95, 0.72, 1, 1, 0.5), S(-2.1, 3.0, 1.95, 0.7, 1, 1, 0.5),
    S(0.05, 1.7, 2.0, 0.66, 1, 1, 0.5), S(0.2, 3.2, 1.95, 0.72, 1, 1, 0.5),
    S(2.1, 1.75, 1.95, 0.72, 1, 1, 0.5), S(2.15, 3.05, 1.95, 0.66, 1, 1, 0.5),
    S(-0.95, 3.55, 1.9, 0.6, 1, 1, 0.5), S(1.25, 1.55, 2.0, 0.6, 1, 1, 0.5)], 2);
  groups(1, 'clad-back', [S(-2.0, 1.8, -1.95, 0.75, 1, 1, 0.8), S(-1.9, 3.1, -1.95, 0.7, 1, 1, 0.8),
    S(-0.7, 2.0, -2.0, 0.72, 1, 1, 0.8), S(1.8, 1.9, -1.95, 0.74, 1, 1, 0.8), S(1.9, 3.15, -1.95, 0.68, 1, 1, 0.8),
    S(-0.6, 3.5, -1.9, 0.62, 1, 1, 0.8)], 2);
  for (const sx of [-1, 1]) groups(1, 'clad-side', [S(sx * 2.85, 1.8, -0.85, 0.7, 1, 0.8), S(sx * 2.85, 1.75, 0.95, 0.68, 1, 0.8),
    S(sx * 2.85, 3.3, -0.95, 0.64, 1, 0.8), S(sx * 2.85, 3.35, 1.0, 0.62, 1, 0.8)], 2);
  for (const sz of [-1, 1]) for (const [z, y, r] of [[1.5, 4.98, 0.74], [0.76, 5.68, 0.72]]) groups(1, 'roof', row(-2.85, 2.85, 6, y, sz * z, r, 0.85), 2);
  groups(1, 'roof', row(-2.75, 2.75, 5, 6.3, 0, 0.62, 0.9), 2);
  each(1, 'bank', [S(-2.9, 0.75, 0.3, 1.35, 0.5), S(-1.2, 0.6, 1.1, 1.55, 0.45), S(1.0, 0.55, 1.2, 1.55, 0.45), S(2.7, 0.65, 0.7, 1.4, 0.5),
    S(-1.4, 0.7, -1.3, 1.5, 0.45), S(1.2, 0.65, -1.35, 1.5, 0.45), S(3.7, 0.9, -0.5, 1.0, 0.55), S(-3.8, 0.95, -0.7, 1.0, 0.55)]);

  // 0 · outer tufts: the eave roll, rims, balcony, canopy, crown, chimney
  for (const sz of [-1, 1]) groups(0, 'eave', row(-3.05, 3.05, 8, 4.25, sz * 2.25, 0.56, 0.9), 2);
  SPEC.windows.forEach((w) => { if (!w.noRim) clump(0, 'window-rim', roundRim(w)); });
  clump(0, 'balcony', [S(0.85, 2.18, 2.5, 0.36, 0.42), S(1.25, 2.12, 2.62, 0.4, 0.42), S(1.65, 2.18, 2.5, 0.36, 0.42), S(1.25, 1.9, 2.45, 0.3, 0.6)]);
  clump(0, 'canopy', [S(-1.3, 3.25, 2.5, 0.3, 0.7), S(-0.85, 3.38, 2.62, 0.36, 0.7), S(-0.4, 3.25, 2.5, 0.3, 0.7)]);
  groups(0, 'crown', [S(-2.15, 6.6, 0.15, 0.66), S(-1.35, 6.85, -0.05, 0.74), S(-0.5, 6.75, 0.1, 0.56), S(-1.75, 7.35, 0.0, 0.46), S(0.3, 6.6, -0.1, 0.44), S(-0.95, 7.4, 0.05, 0.38)], 2);
  clump(0, 'chimney', [S(1.55, 6.35, -0.9, 0.42), S(1.85, 6.45, -1.05, 0.36), S(1.65, 6.95, -0.95, 0.38), S(1.55, 7.4, -0.9, 0.28), S(1.85, 7.48, -1.0, 0.25)]);
  const T = [
    [[-3.25, 4.2, 2.05], [S(0, 0, 0, 0.52), S(0.38, 0.2, 0.05, 0.4), S(-0.28, 0.18, -0.3, 0.38)]],
    [[3.3, 4.2, 2.05], [S(0, 0, 0, 0.5), S(-0.38, 0.22, 0.05, 0.38), S(0.26, 0.2, -0.3, 0.36)]],
    [[-3.25, 4.3, -2.0], [S(0, 0, 0, 0.5), S(0.35, 0.2, -0.05, 0.38)]],
    [[3.3, 4.25, -2.0], [S(0, 0, 0, 0.48), S(-0.35, 0.2, -0.05, 0.36)]],
    [[-2.0, 0.95, 2.35], [S(0, 0, 0, 0.5), S(0.45, -0.02, 0.1, 0.4), S(-0.35, 0.05, 0.1, 0.36)]],
    [[2.2, 0.95, 2.3], [S(0, 0, 0, 0.48), S(-0.42, 0.0, 0.12, 0.38), S(0.3, 0.1, 0.05, 0.34)]],
    [[-3.3, 2.4, 1.2], [S(0, 0, 0, 0.5), S(0.1, 0.4, 0.2, 0.36), S(-0.15, -0.1, 0.35, 0.32)]],
    [[3.4, 1.7, 1.3], [S(0, 0, 0, 0.46), S(-0.1, 0.35, 0.2, 0.34)]],
    [[3.35, 3.6, -1.2], [S(0, 0, 0, 0.44), S(0.05, 0.3, 0.3, 0.32)]],
  ];
  T.forEach(([at, list]) => clump(0, 'tuft', tuft(at, list)));

  const top = SPHERES.filter((s) => CLUMPS[s.clump].tag === 'chimney').reduce((a, b) => (b.y + b.r > a.y + a.r ? b : a));
  ORIGIN[0] = top.x; ORIGIN[1] = top.y + top.r; ORIGIN[2] = top.z;
  for (const k of Object.keys(CONFIGS)) delete CONFIGS[k];
  for (const k of Object.keys(GRIDS)) delete GRIDS[k];
  ALIVE = new Uint8Array(SPHERES.length).fill(1);
  GRIDS.live = buildGrid(ALIVE);
  G = GRIDS.live;
  CONFIGS.live = ALIVE;
  const FRONT = ['clad-front', 'core-front', 'balcony', 'canopy'];
  CONFIGS.noFacade = maskWithout((s) => FRONT.includes(CLUMPS[s.clump].tag)
    || (CLUMPS[s.clump].tag === 'window-rim' && s.z > 1.6) || (CLUMPS[s.clump].tag === 'tuft' && s.z > 1.6 && s.y < 3));
  CONFIGS.coreOnly = maskWithout((s) => s.layer < 2);
  return SPEC;
}

// ---------------------------------------------------------------------------
// alive masks (live = what the user has torn; cached configs for choreography)

export let ALIVE = new Uint8Array(0);
export const CONFIGS = {};
let FIELD_MASK = null;

function maskWithout(pred) {
  const m = new Uint8Array(SPHERES.length).fill(1);
  SPHERES.forEach((s, i) => { if (pred(s)) m[i] = 0; });
  return m;
}
// clumps a choreography moves out of the house. A clump the visitor has
// torn away is not in the house any more, so it is never moved again.
export function clumpsRemovedIn(config) {
  const m = CONFIGS[config];
  return CLUMPS.filter((c) => c.ids.every((i) => !m[i]) && c.ids.every((i) => ALIVE[i])).map((c) => c.id);
}
// torn clumps that the choreography would otherwise still show in place
export function tornIn(config) {
  const m = CONFIGS[config];
  return CLUMPS.filter((c) => c.ids.some((i) => m[i]) && c.ids.every((i) => !ALIVE[i])).map((c) => c.id);
}
export function setAlive(ids, alive) {
  for (const i of ids) ALIVE[i] = alive ? 1 : 0;
  GRIDS.live = buildGrid(ALIVE);
  // a choreography state is its own layout AND what is still in the house
  for (const k of Object.keys(GRIDS)) if (k !== 'live' && k !== 'whole') delete GRIDS[k];
  if (!FIELD_MASK) G = GRIDS.live;
  else useConfig(FIELD_NAME);
}
let FIELD_NAME = null;
export function useConfig(name) {
  FIELD_NAME = name || null;
  if (name) {
    const c = CONFIGS[name];
    const m = new Uint8Array(c.length);
    for (let i = 0; i < c.length; i++) m[i] = c[i] & ALIVE[i];
    FIELD_MASK = m;
  } else FIELD_MASK = null;
  const key = name || 'live';
  if (!GRIDS[key]) GRIDS[key] = buildGrid(FIELD_MASK || ALIVE);
  G = GRIDS[key];
}

// ---------------------------------------------------------------------------
// accelerated field over the alive puffs. The grid lists only puffs that are
// alive in the mask it was built for; it is rebuilt after every tear.

const K = 0.7;
const CELL = 0.4;
let G = null;
const GRIDS = {};

function buildGrid(mask) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const s of SPHERES) {
    const r = s.R;
    lo[0] = min(lo[0], s.x - r - 1.5); lo[1] = min(lo[1], s.y - r - 1.5); lo[2] = min(lo[2], s.z - r - 1.5);
    hi[0] = max(hi[0], s.x + r + 1.5); hi[1] = max(hi[1], s.y + r + 1.5); hi[2] = max(hi[2], s.z + r + 1.5);
  }
  const n = lo.map((v, a) => Math.ceil((hi[a] - v) / CELL));
  const lists = new Array(n[0] * n[1] * n[2]);
  const lower = new Float32Array(lists.length);
  const upper = new Float32Array(lists.length);
  const half = CELL * 0.866;
  const alive = [];
  SPHERES.forEach((s, i) => { if (!mask || mask[i]) alive.push(i); });
  const dc = new Float32Array(alive.length);
  for (let kz = 0; kz < n[2]; kz++) for (let j = 0; j < n[1]; j++) for (let i = 0; i < n[0]; i++) {
    const cx = lo[0] + (i + 0.5) * CELL, cy = lo[1] + (j + 0.5) * CELL, cz = lo[2] + (kz + 0.5) * CELL;
    let best = 1e9, up = 1e9;
    for (let q = 0; q < alive.length; q++) {
      const s = SPHERES[alive[q]];
      const c = len3(cx - s.x, cy - s.y, cz - s.z);
      const d = c - s.R;
      dc[q] = d;
      if (d < best) best = d;
      if (c - s.rmin < up) up = c - s.rmin;
    }
    const list = [];
    for (let q = 0; q < alive.length; q++) if (dc[q] < best + half * 2 + SPHERES[alive[q]].k + 0.05) list.push(alive[q]);
    const id = i + n[0] * (j + n[1] * kz);
    lists[id] = Int32Array.from(list);
    lower[id] = alive.length ? best - half : 1e3;
    upper[id] = alive.length ? up + half : 1e3;
  }
  return { lo, hi, n, lists, lower, upper };
}

// distance to a puff; squashed puffs use the ellipsoid approximation, which
// stays close to the true euclidean distance (the grid bounds rely on that)
function sphereDist(x, y, z, s) {
  const dx = x - s.x, dy = y - s.y, dz = z - s.z;
  if (!s.ell) return sqrt(dx * dx + dy * dy + dz * dz) - s.r;
  const ux = dx * s.ix, uy = dy * s.iy, uz = dz * s.iz;
  const k0 = sqrt(ux * ux + uy * uy + uz * uz);
  const vx = ux * s.ix, vy = uy * s.iy, vz = uz * s.iz;
  const k1 = sqrt(vx * vx + vy * vy + vz * vz);
  return k1 < 1e-6 ? -s.rmin : (k0 * (k0 - 1)) / k1;
}

export function massDist(x, y, z) {
  const { lo, hi, n } = G;
  const i = floor((x - lo[0]) / CELL), j = floor((y - lo[1]) / CELL), kz = floor((z - lo[2]) / CELL);
  if (i < 0 || j < 0 || kz < 0 || i >= n[0] || j >= n[1] || kz >= n[2]) {
    // the grid reaches 1.5 m past every puff, so outside it the surface is
    // at least that far (a lower bound that stays honest for collisions)
    const dx = max(lo[0] - x, 0, x - hi[0]), dy = max(lo[1] - y, 0, y - hi[1]), dz = max(lo[2] - z, 0, z - hi[2]);
    return hypot(dx, dy, dz) + 1.4;
  }
  const id = i + n[0] * (j + n[1] * kz);
  const low = G.lower[id];
  if (low > K + 0.6) return low;
  // deep inside: any clearly negative value will do (an upper bound)
  const up = G.upper[id];
  if (up < -0.4) return up;
  const list = G.lists[id];
  if (!list.length) return max(low, 1.0);
  let d = sphereDist(x, y, z, SPHERES[list[0]]);
  for (let q = 1; q < list.length; q++) {
    const s = SPHERES[list[q]];
    d = smin(d, sphereDist(x, y, z, s), s.k);
  }
  return d;
}

// distance to the skin of the WHOLE house (every puff, nothing carved, no
// relief): how deep a point lies under the original surface. A material
// world uses it to tell outer skin (grass) from the body within (soil).
// depth below the untouched house's OUTER skin (house frame, m; < 0 outside).
// The puffs are a shell: the room and the attic are voids inside it, and
// their walls are no skin — so depth is measured to the air that is open to
// the outside (a flood fill), not to the nearest puff surface. Near the outer
// skin the exact field is used; deeper, a chamfer distance to that air.
// Baked once on a 0.2 m grid, sampled trilinearly.
export const SKIN_LO = [-6, -1.6, -5], SKIN_SIZE = [12, 11, 10], SKIN_CELL = 0.2;
let SKIN = null;
export function bakeSkinDepth() {
  if (SKIN) return SKIN;
  const C = SKIN_CELL, n = SKIN_SIZE.map((v) => Math.round(v / C));
  const [nx, ny, nz] = n, N = nx * ny * nz;
  const id = (i, j, k) => i + nx * (j + ny * k);
  const f = new Float32Array(N);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    f[id(i, j, k)] = massDistWhole(SKIN_LO[0] + (i + 0.5) * C, SKIN_LO[1] + (j + 0.5) * C, SKIN_LO[2] + (k + 0.5) * C);
  // air open to the outside: flood from the box faces through air cells
  const ext = new Uint8Array(N);
  const stack = [];
  const push = (i, j, k) => { const q = id(i, j, k); if (!ext[q] && f[q] > 0) { ext[q] = 1; stack.push(q); } };
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    if (i === 0 || j === 0 || k === 0 || i === nx - 1 || j === ny - 1 || k === nz - 1) push(i, j, k);
  while (stack.length) {
    const q = stack.pop();
    const i = q % nx, j = ((q / nx) | 0) % ny, k = (q / (nx * ny)) | 0;
    if (i > 0) push(i - 1, j, k); if (i < nx - 1) push(i + 1, j, k);
    if (j > 0) push(i, j - 1, k); if (j < ny - 1) push(i, j + 1, k);
    if (k > 0) push(i, j, k - 1); if (k < nz - 1) push(i, j, k + 1);
  }
  // chamfer distance (m) to that air, two passes over the 26-neighbourhood
  const dist = new Float32Array(N);
  for (let q = 0; q < N; q++) dist[q] = ext[q] ? 0 : 1e9;
  const nb = [];
  for (let dk = -1; dk <= 1; dk++) for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const o = di + nx * (dj + ny * dk);
    if (o < 0) nb.push([di, dj, dk, Math.hypot(di, dj, dk) * C]);
  }
  const pass = (fwd) => {
    for (let s = 0; s < N; s++) {
      const q = fwd ? s : N - 1 - s;
      if (ext[q]) continue;
      const i = q % nx, j = ((q / nx) | 0) % ny, k = (q / (nx * ny)) | 0;
      let d = dist[q];
      for (const [di0, dj0, dk0, w] of nb) {
        const di = fwd ? di0 : -di0, dj = fwd ? dj0 : -dj0, dk = fwd ? dk0 : -dk0;
        const a = i + di, b = j + dj, c = k + dk;
        if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
        const v = dist[id(a, b, c)] + w;
        if (v < d) d = v;
      }
      dist[q] = d;
    }
  };
  pass(true); pass(false);
  // signed depth: exact near the outer skin, the chamfer distance deeper
  const depth = new Float32Array(N);
  for (let q = 0; q < N; q++) depth[q] = ext[q] ? -f[q] : Math.max(-f[q], dist[q] - C);
  SKIN = { depth, n, lo: SKIN_LO, cell: C };
  return SKIN;
}
// a grid baked elsewhere (a worker) takes the place of a local bake
export function setSkinDepth(S) { SKIN = { depth: S.depth, n: S.n, lo: S.lo, cell: S.cell }; }
export function skinDepth(x, y, z) {
  const S = bakeSkinDepth(), [nx, ny, nz] = S.n, C = S.cell;
  let u = (x - S.lo[0]) / C - 0.5, v = (y - S.lo[1]) / C - 0.5, w = (z - S.lo[2]) / C - 0.5;
  u = Math.max(0, Math.min(nx - 1.001, u)); v = Math.max(0, Math.min(ny - 1.001, v)); w = Math.max(0, Math.min(nz - 1.001, w));
  const i = floor(u), j = floor(v), k = floor(w), fu = u - i, fv = v - j, fw = w - k;
  const D = S.depth, at = (a, b, c) => D[a + nx * (b + ny * c)];
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(at(i, j, k), at(i + 1, j, k), fu), l(at(i, j + 1, k), at(i + 1, j + 1, k), fu), fv),
    l(l(at(i, j, k + 1), at(i + 1, j, k + 1), fu), l(at(i, j + 1, k + 1), at(i + 1, j + 1, k + 1), fu), fv), fw);
}

export function massDistWhole(x, y, z) {
  if (!GRIDS.whole) GRIDS.whole = buildGrid(null);
  const g = G;
  G = GRIDS.whole;
  const d = massDist(x, y, z);
  G = g;
  return d;
}

export function cavityDist(x, y, z) {
  let c = ellipsoid(x, y, z, SPEC.room.c, SPEC.room.r);
  c = min(c, archDist(x, y, z, SPEC.door));
  c = min(c, archDist(x, y, z, SPEC.arch));
  for (const w of SPEC.windows) c = min(c, capsule(x, y, z, w.a, w.b, w.r));
  return c;
}

// how much a point belongs to the quiet room (1 inside the room box)
export function roomness(x, y, z) {
  const c = SPEC.room.c;
  const qx = abs(x - c[0]) - 2.02, qy = abs(y - c[1]) - 1.06, qz = abs(z - c[2]) - 1.16;
  const out = hypot(max(qx, 0), max(qy, 0), max(qz, 0)) + min(max(qx, qy, qz), 0);
  return 1 - clamp((out + 0.02) / 0.22, 0, 1);
}

// carved surfaces that take warm light from inside: 0 room, 1 door, 2.. windows
export const CAVITIES = [
  { f: (x, y, z) => ellipsoid(x, y, z, SPEC.room.c, SPEC.room.r), index: 0 },
  { f: (x, y, z) => archDist(x, y, z, SPEC.door), index: 1 },
  { f: (x, y, z) => archDist(x, y, z, SPEC.arch), index: 2 },
  ...[0, 1, 2, 3].map((i) => ({ f: (x, y, z) => capsule(x, y, z, SPEC.windows[i].a, SPEC.windows[i].b, SPEC.windows[i].r), index: 3 + i })),
];

const carveF = (base) => (x, y, z) => {
  const b = base(x, y, z);
  if (b > 0.6) return b - 0.15;
  const c = cavityDist(x, y, z);
  if (b < -0.6 && c > 0.6) return b;
  return smax(b - billow(x, y, z), -c, 0.14);
};
const carveFs = (base) => (x, y, z) => {
  const b = base(x, y, z);
  if (b > 0.6) return b - 0.12;
  return smax(b - 0.12, -cavityDist(x, y, z), 0.14);
};
export const bodyF = carveF(massDist);
export const bodyFs = carveFs(massDist);

export function sceneSDF(x, y, z, withGround = true) {
  const g = withGround ? y + FLOAT : 1e9;
  return min(g, bodyFs(x, y, z));
}

// ---------------------------------------------------------------------------
// bricks: the mass is meshed in aligned blocks so a tear only re-meshes nearby

export const BRICK = 1.6;
export function brickKeysIn(lo, hi) {
  const keys = [];
  for (let i = floor(lo[0] / BRICK); i <= floor(hi[0] / BRICK); i++)
    for (let j = floor(lo[1] / BRICK); j <= floor(hi[1] / BRICK); j++)
      for (let k = floor(lo[2] / BRICK); k <= floor(hi[2] / BRICK); k++) keys.push(`${i},${j},${k}`);
  return keys;
}
export function allBrickKeys() {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const s of SPHERES) {
    const r = s.R + 0.35;
    lo[0] = min(lo[0], s.x - r); lo[1] = min(lo[1], s.y - r); lo[2] = min(lo[2], s.z - r);
    hi[0] = max(hi[0], s.x + r); hi[1] = max(hi[1], s.y + r); hi[2] = max(hi[2], s.z + r);
  }
  return brickKeysIn(lo, hi);
}
export function brickPart(key) {
  const [i, j, k] = key.split(',').map(Number);
  const lo = [i * BRICK, j * BRICK, k * BRICK], hi = [(i + 1) * BRICK, (j + 1) * BRICK, (k + 1) * BRICK];
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const halfDiag = BRICK * 0.866 + 0.4;
  const mask = FIELD_MASK || ALIVE;
  let near = false;
  for (let q = 0; q < SPHERES.length && !near; q++) {
    if (!mask[q]) continue;
    const s = SPHERES[q];
    if (hypot(c[0] - s.x, c[1] - s.y, c[2] - s.z) - s.R < halfDiag + K) near = true;
  }
  if (!near) return null;
  return { id: `brick:${key}`, f: bodyF, fs: bodyFs, base: massDist, bbox: [lo, hi], pivot: [0, 0, 0], isBody: true };
}
export function bricksForClumps(ids) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  const keys = new Set();
  for (const id of ids) {
    for (const si of CLUMPS[id].ids) {
      const s = SPHERES[si];
      const r = s.R + K * 0.8 + 0.25;
      for (const k of brickKeysIn([s.x - r, s.y - r, s.z - r], [s.x + r, s.y + r, s.z + r])) keys.add(k);
    }
  }
  void lo; void hi;
  return [...keys];
}

// a torn clump, meshed from exactly its own puffs (carved openings included)
export function clumpPart(id) {
  return groupPart([id]);
}
// several clumps as one continuous piece (the facade lifting as one layer)
export function groupPart(ids) {
  const list = ids.flatMap((id) => CLUMPS[id].ids.map((i) => SPHERES[i]));
  const c = groupInfo(ids);
  const base = (x, y, z) => {
    let d = 1e9, first = true;
    for (const s of list) {
      const di = sphereDist(x, y, z, s);
      d = first ? di : smin(d, di, min(K, s.r * 0.8));
      first = false;
    }
    return d;
  };
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const s of list) {
    const r = s.R + 0.3;
    lo[0] = min(lo[0], s.x - r); lo[1] = min(lo[1], s.y - r); lo[2] = min(lo[2], s.z - r);
    hi[0] = max(hi[0], s.x + r); hi[1] = max(hi[1], s.y + r); hi[2] = max(hi[2], s.z + r);
  }
  return { id: `group:${ids.join('.')}`, f: carveF(base), fs: carveFs(base), base, bbox: [lo, hi], pivot: c.c, isBody: false, small: true };
}
// a torn sod (turf world): the clump's puffs fused into one lump with a
// soft hull at its centre, so no single ball reads — one clod, not balls
// stuck together. The cloud keeps clumpPart.
export function sodPart(id) {
  const c = CLUMPS[id];
  const list = c.ids.map((i) => SPHERES[i]);
  let md = 0, mr = 0;
  for (const s of list) { md += len3(s.x - c.c[0], s.y - c.c[1], s.z - c.c[2]); mr += s.R; }
  md /= list.length; mr /= list.length;
  // a small core only fills the crotches between the puffs: the clump keeps
  // its own outline (long, flat, bent), just without the ball-by-ball lobes
  const hullR = md * 0.5 + mr * 0.3;
  const kk = Math.min(0.42, Math.max(0.22, c.rad * 0.3));
  const base = (x, y, z) => {
    let d = len3(x - c.c[0], y - c.c[1], z - c.c[2]) - hullR;
    for (const s of list) d = smin(d, sphereDist(x, y, z, s), kk);
    return d;
  };
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const s of list) {
    const r = s.R + 0.55;
    lo[0] = min(lo[0], s.x - r); lo[1] = min(lo[1], s.y - r); lo[2] = min(lo[2], s.z - r);
    hi[0] = max(hi[0], s.x + r); hi[1] = max(hi[1], s.y + r); hi[2] = max(hi[2], s.z + r);
  }
  // cut like the house: a clod from round a window keeps the window's edge
  return { id: `sod:${id}`, f: carveF(base), fs: carveFs(base), base, bbox: [lo, hi], pivot: c.c, isBody: false, small: true };
}
export function groupInfo(ids) {
  if (ids.length === 1) return CLUMPS[ids[0]];
  let cx = 0, cy = 0, cz = 0, w = 0, layer = 9;
  for (const id of ids) for (const i of CLUMPS[id].ids) {
    const s = SPHERES[i], m = s.r ** 3 * s.sx * s.sy * s.sz;
    cx += s.x * m; cy += s.y * m; cz += s.z * m; w += m;
    layer = min(layer, s.layer);
  }
  const c = [cx / w, cy / w, cz / w];
  let rad = 0;
  for (const id of ids) for (const i of CLUMPS[id].ids) { const s = SPHERES[i]; rad = max(rad, len3(s.x - c[0], s.y - c[1], s.z - c[2]) + s.R); }
  return { id: -1, layer, tag: 'group', ids: ids.flatMap((id) => CLUMPS[id].ids), c, rad };
}

// which clump sits under a point of the surface (group-local), outer layers first
export function clumpAt(x, y, z) {
  let best = -1, bestScore = 1e9;
  SPHERES.forEach((s, i) => {
    if (!ALIVE[i]) return;
    const d = sphereDist(x, y, z, s);
    if (d > 0.45) return;
    const score = abs(d) + s.layer * 0.22 - s.r * 0.05;
    if (score < bestScore) { bestScore = score; best = s.clump; }
  });
  return best;
}

buildVariant();
