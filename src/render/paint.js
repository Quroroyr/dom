import * as THREE from 'three';

// Persistent paint.
//
// A paint volume is a small RGBA 3D texture laid over one object in that
// object's own frame. A surface reads the colour at its rest position
// (before any deformation), so paint survives re-meshing, rotation, throws
// and squash — it is locked to the material.
//
//  house  — one volume in the house frame.
//  piece  — a torn piece gets its own volume in its local frame. At the
//           moment of separation it inherits what the house showed there,
//           and the house forgets that paint (it left with the piece). From
//           then on the two never share strokes. On Reassemble the piece's
//           paint is merged back into the house.
//
// Every stroke goes onto one global, chronological undo stack.

export const PAINT_COLORS = [
  { id: 'cloud', label: 'Cloud White', hex: '#f6f3ee' },
  { id: 'butter', label: 'Butter', hex: '#f1dfa6' },
  { id: 'peach', label: 'Peach', hex: '#efc2a3' },
  { id: 'blush', label: 'Blush', hex: '#e7b7bd' },
  { id: 'coral', label: 'Coral Mist', hex: '#e2a394' },
  { id: 'lavender', label: 'Lavender', hex: '#c3b3dd' },
  { id: 'periwinkle', label: 'Periwinkle', hex: '#a9b2de' },
  { id: 'sky', label: 'Sky', hex: '#a9c9e2' },
  { id: 'mint', label: 'Mint', hex: '#b5dccb' },
  { id: 'sage', label: 'Sage', hex: '#b3c1a2' },
  { id: 'pearl', label: 'Pearl Grey', hex: '#c9c6c4' },
  { id: 'charcoal', label: 'Soft Charcoal', hex: '#6e6a6a' },
];

export class PaintVolume {
  constructor({ lo = [-5.8, -1.4, -4.9], hi = [5.8, 9.2, 4.9], cell = 0.14 } = {}) {
    this.lo = new THREE.Vector3(...lo);
    this.size = new THREE.Vector3(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    this.res = [0, 1, 2].map((a) => Math.max(2, Math.ceil(this.size.getComponent(a) / cell)));
    // keep cells cubic: the box grows to a whole number of cells
    this.cell = cell;
    this.size.set(this.res[0] * cell, this.res[1] * cell, this.res[2] * cell);
    const [rx, ry, rz] = this.res;
    this.data = new Uint8Array(rx * ry * rz * 4);
    const tex = new THREE.Data3DTexture(this.data, rx, ry, rz);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.tex = tex;
    this.inv = new THREE.Vector3(1 / this.size.x, 1 / this.size.y, 1 / this.size.z);
    this.dirty = false;
    this.lastUpload = 0;
    this.stroke = null;
    this.disposed = false;
  }

  _box() { return [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; }
  _grow(b, i, j, k) {
    if (i < b[0]) b[0] = i; if (j < b[1]) b[1] = j; if (k < b[2]) b[2] = k;
    if (i > b[3]) b[3] = i; if (j > b[4]) b[4] = j; if (k > b[5]) b[5] = k;
  }

  // one dab: a soft ellipsoid, wide along the surface and shallow across it,
  // so pigment stays in the skin of the cloud. softness widens the fall-off,
  // opacity is how much each dab adds; an eraser lifts pigment the same way.
  splat(p, n, brush) {
    const [rx, ry, rz] = this.res;
    const c = this.cell, lo = this.lo;
    const radius = brush.radius, depth = Math.max(0.18, radius * 0.55);
    const R = Math.max(radius, depth) * 1.2;
    const i0 = Math.max(0, Math.floor((p.x - R - lo.x) / c)), i1 = Math.min(rx - 1, Math.ceil((p.x + R - lo.x) / c));
    const j0 = Math.max(0, Math.floor((p.y - R - lo.y) / c)), j1 = Math.min(ry - 1, Math.ceil((p.y + R - lo.y) / c));
    const k0 = Math.max(0, Math.floor((p.z - R - lo.z) / c)), k1 = Math.min(rz - 1, Math.ceil((p.z + R - lo.z) / c));
    if (i0 > i1 || j0 > j1 || k0 > k1) return;
    const cr = Math.round(brush.color.r * 255), cg = Math.round(brush.color.g * 255), cb = Math.round(brush.color.b * 255);
    const D = this.data;
    const seed = Math.random() * 10;
    const hard = 1 - THREE.MathUtils.clamp(brush.softness, 0, 1) * 0.92; // solid core share
    const st = this.stroke;
    let touched = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = lo.x + (i + 0.5) * c - p.x, dy = lo.y + (j + 0.5) * c - p.y, dz = lo.z + (k + 0.5) * c - p.z;
      const dn = dx * n.x + dy * n.y + dz * n.z;
      const tx = dx - n.x * dn, ty = dy - n.y * dn, tz = dz - n.z * dn;
      // a ragged, watercolour edge rather than a perfect disc
      const rag = 1 + 0.16 * Math.sin(dx * 7.1 + seed) * Math.sin(dz * 6.3 - dy * 5.2 + seed);
      const e = Math.sqrt((tx * tx + ty * ty + tz * tz) / (radius * radius * rag * rag) + (dn * dn) / (depth * depth));
      if (e >= 1) continue;
      const f = (1 - THREE.MathUtils.smoothstep(e, hard, 1)) * brush.opacity;
      if (f <= 0.002) continue;
      const q = (i + rx * (j + ry * k)) * 4;
      if (st && !st.saved[q >> 2]) { st.saved[q >> 2] = 1; this._grow(st.box, i, j, k); }
      const a0 = D[q + 3] / 255;
      if (brush.erase) {
        D[q + 3] = Math.round(a0 * (1 - f) * 255);
      } else {
        const a1 = a0 + (1 - a0) * f;
        const mix = a0 < 0.004 ? 1 : f / Math.max(a1, 1e-3);
        D[q] = Math.round(D[q] + (cr - D[q]) * mix);
        D[q + 1] = Math.round(D[q + 1] + (cg - D[q + 1]) * mix);
        D[q + 2] = Math.round(D[q + 2] + (cb - D[q + 2]) * mix);
        D[q + 3] = Math.round(a1 * 255);
      }
      touched++;
    }
    if (touched) this.dirty = true;
  }

  // trilinear read at a point of this volume's frame → [r, g, b, a] 0..255
  sample(x, y, z, out) {
    const [rx, ry, rz] = this.res;
    const fx = (x - this.lo.x) / this.cell - 0.5, fy = (y - this.lo.y) / this.cell - 0.5, fz = (z - this.lo.z) / this.cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    const u = fx - i, v = fy - j, w = fz - k;
    out[0] = out[1] = out[2] = out[3] = 0;
    for (let c = 0; c < 8; c++) {
      const ii = i + (c & 1), jj = j + ((c >> 1) & 1), kk = k + ((c >> 2) & 1);
      if (ii < 0 || jj < 0 || kk < 0 || ii >= rx || jj >= ry || kk >= rz) continue;
      const wt = ((c & 1) ? u : 1 - u) * (((c >> 1) & 1) ? v : 1 - v) * (((c >> 2) & 1) ? w : 1 - w);
      const q = (ii + rx * (jj + ry * kk)) * 4;
      for (let a = 0; a < 4; a++) out[a] += this.data[q + a] * wt;
    }
    return out;
  }

  // visit every voxel centre (in this volume's frame)
  forEach(fn) {
    const [rx, ry, rz] = this.res;
    const c = this.cell, lo = this.lo;
    let q = 0;
    for (let k = 0; k < rz; k++) for (let j = 0; j < ry; j++) for (let i = 0; i < rx; i++, q += 4) {
      fn(lo.x + (i + 0.5) * c, lo.y + (j + 0.5) * c, lo.z + (k + 0.5) * c, q, i, j, k);
    }
  }

  hasPaint() {
    for (let q = 3; q < this.data.length; q += 4) if (this.data[q] > 2) return true;
    return false;
  }

  clear() { this.data.fill(0); this.tex.needsUpdate = true; this.dirty = false; }

  // upload at most ~20 times a second while painting
  flush(now) {
    if (!this.dirty || now - this.lastUpload < 0.05) return;
    this.tex.needsUpdate = true;
    this.dirty = false;
    this.lastUpload = now;
  }

  dispose() { this.disposed = true; this.tex.dispose(); }
}

// ---------------------------------------------------------------------------
// History and ownership.
//
// Every stroke is one undo entry { seq, vol, box, before }: the touched block
// of its volume as it was before. Entries are chronological across all
// volumes.
//
// A piece owns the house voxels inside its own puffs (it took them at detach;
// their exact values are kept in piece.owned) and inherits a copy of what the
// house showed round it (piece.inherited). This makes the two transfers exact:
//  - Reassemble without new strokes writes the saved house values back, bit
//    for bit (no alpha-over, so repeated detach/reassemble never builds up).
//  - Where the piece was painted, its paint comes back into the house.
// And it keeps the history honest:
//  - At Reassemble every entry made during the piece's life (its own strokes,
//    and house strokes over its socket) is rewritten into house space, in
//    place, so Undo still steps back through them one by one, newest first.
//  - Undoing a house stroke made before a piece left also takes it off that
//    piece: the piece re-inherits from the house as it was.

// trilinear read of any data array laid out like `vol` (piece frame point)
function sampleData(vol, data, x, y, z, out) {
  const [rx, ry, rz] = vol.res;
  const fx = (x - vol.lo.x) / vol.cell - 0.5, fy = (y - vol.lo.y) / vol.cell - 0.5, fz = (z - vol.lo.z) / vol.cell - 0.5;
  const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
  const u = fx - i, v = fy - j, w = fz - k;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let c = 0; c < 8; c++) {
    const ii = i + (c & 1), jj = j + ((c >> 1) & 1), kk = k + ((c >> 2) & 1);
    if (ii < 0 || jj < 0 || kk < 0 || ii >= rx || jj >= ry || kk >= rz) continue;
    const wt = ((c & 1) ? u : 1 - u) * (((c >> 1) & 1) ? v : 1 - v) * (((c >> 2) & 1) ? w : 1 - w);
    const q = (ii + rx * (jj + ry * kk)) * 4;
    for (let a = 0; a < 4; a++) out[a] += data[q + a] * wt;
  }
  return out;
}

// copy a stored "before" block back into a data array
function restoreBlock(data, res, box, before) {
  const [i0, j0, k0, i1, j1, k1] = box;
  const [rx, ry] = res;
  const w = i1 - i0 + 1;
  let o = 0;
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
    data.set(before.subarray(o, o + w * 4), (i0 + rx * (j + ry * k)) * 4);
    o += w * 4;
  }
}
function readBlock(data, res, box) {
  const [i0, j0, k0, i1, j1, k1] = box;
  const [rx, ry] = res;
  const w = i1 - i0 + 1, h = j1 - j0 + 1, d = k1 - k0 + 1;
  const out = new Uint8Array(w * h * d * 4);
  let o = 0;
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
    const q = (i0 + rx * (j + ry * k)) * 4;
    out.set(data.subarray(q, q + w * 4), o);
    o += w * 4;
  }
  return out;
}
const overlaps = (a, b) => a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] && a[2] <= b[5] && b[2] <= a[5];
const near4 = (a, b) => Math.abs(a[0] - b[0]) <= 1.5 && Math.abs(a[1] - b[1]) <= 1.5 && Math.abs(a[2] - b[2]) <= 1.5 && Math.abs(a[3] - b[3]) <= 1.5;

export class PaintManager {
  constructor(house) {
    this.house = house;           // the house volume
    this.pieces = new Set();      // volumes of torn pieces
    this.undo = [];
    this.seq = 0;                 // one clock for strokes and detaches
    this.cur = null;              // { vol, copy, box }
    this.onChange = null;
    this.has = false;
    this._s = new Float32Array(4);
    this._t = new Float32Array(4);
    // other things a brush lays (the turf world's flowers): they keep their own
    // strokes on this clock — { end(), lastSeq(), undoOne(), count(), clear() }
    this.extras = [];
  }
  tick() { return ++this.seq; }
  changed() { this._changed(); }

  // strokes: every change between begin and end is one undo step per target
  begin(vol) {
    if (this.cur && this.cur.vol === vol) return;
    this.end();
    vol.stroke = { saved: new Uint8Array(vol.data.length >> 2), box: vol._box(), copy: vol.data.slice() };
    this.cur = { vol };
  }
  end() {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    const st = c.vol.stroke;
    c.vol.stroke = null;
    if (!st || st.box[0] === Infinity) return;
    // keep only the touched block of the "before" state
    const before = readBlock(st.copy, c.vol.res, st.box);
    this.undo.push({ seq: ++this.seq, vol: c.vol, box: st.box, before });
    if (this.undo.length > 60) this.undo.shift();
    this._changed();
  }
  paint(vol, p, n, brush) {
    this.begin(vol);
    vol.splat(p, n, brush);
  }
  undoLast() {
    this.end();
    for (const x of this.extras) x.end();
    // the newest stroke goes first, whoever laid it
    const top = this.undo.length ? this.undo[this.undo.length - 1].seq : -1;
    let newest = null;
    for (const x of this.extras) if (x.lastSeq() > top && (!newest || x.lastSeq() > newest.lastSeq())) newest = x;
    if (newest) { newest.undoOne(); this._changed(); return true; }
    while (this.undo.length) {
      const u = this.undo.pop();
      if (u.vol.disposed) continue; // (entries are rewritten at merge; kept as a guard)
      const H = this.house;
      // a house stroke older than a piece that is still away: the piece took
      // part of it along — put the house back as it was at that detach, undo
      // the stroke, and let the piece inherit again from the result
      const affected = u.vol === H ? [...this.pieces].filter((P) => P.detachSeq > u.seq && overlaps(P.ownBox, u.box)) : [];
      for (const P of affected) this._restoreOwned(P);
      restoreBlock(u.vol.data, u.vol.res, u.box, u.before);
      for (const P of affected) this._inherit(P);
      u.vol.tex.needsUpdate = true;
      if (affected.length) H.tex.needsUpdate = true;
      this._changed();
      return true;
    }
    return false;
  }
  clearAll() {
    this.end();
    this.house.clear();
    for (const v of this.pieces) {
      v.clear();
      // nothing is left to take back
      v.inherited.fill(0);
      v.owned.rgba.fill(0);
    }
    this.undo.length = 0;
    for (const x of this.extras) x.clear();
    this._changed();
  }
  flush(now) {
    this.house.flush(now);
    for (const v of this.pieces) v.flush(now);
  }
  _changed() {
    let has = this.house.hasPaint() || this.extras.some((x) => x.count() > 0);
    if (!has) for (const v of this.pieces) if (v.hasPaint()) { has = true; break; }
    const canUndo = this.undo.some((u) => !u.vol.disposed) || this.extras.some((x) => x.lastSeq() >= 0);
    if (has !== this.has || canUndo !== this.canUndo) { this.has = has; this.canUndo = canUndo; this.onChange?.(has, canUndo); }
  }

  // --- piece ownership ------------------------------------------------------

  // the house voxels inside the piece's own puffs
  _ownedIndices(puffs) {
    const H = this.house, [rx, ry, rz] = H.res, c = H.cell;
    const idx = [];
    const box = H._box();
    for (const p of puffs) {
      const r = p.R * 0.97;
      const i0 = Math.max(0, Math.floor((p.x - r - H.lo.x) / c)), i1 = Math.min(rx - 1, Math.ceil((p.x + r - H.lo.x) / c));
      const j0 = Math.max(0, Math.floor((p.y - r - H.lo.y) / c)), j1 = Math.min(ry - 1, Math.ceil((p.y + r - H.lo.y) / c));
      const k0 = Math.max(0, Math.floor((p.z - r - H.lo.z) / c)), k1 = Math.min(rz - 1, Math.ceil((p.z + r - H.lo.z) / c));
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const dx = H.lo.x + (i + 0.5) * c - p.x, dy = H.lo.y + (j + 0.5) * c - p.y, dz = H.lo.z + (k + 0.5) * c - p.z;
        if (dx * dx + dy * dy + dz * dz < r * r) { idx.push(i + rx * (j + ry * k)); H._grow(box, i, j, k); }
      }
    }
    // puffs overlap: keep each voxel once
    return { idx: Int32Array.from(new Set(idx)), box };
  }
  // take: copy what the house shows round the piece into it; the house gives
  // up the voxels inside the piece (their exact values are kept for the way back)
  _inherit(P) {
    const H = this.house, s = this._s, pv = P.pivot;
    P.data.fill(0);
    P.forEach((x, y, z, q) => {
      H.sample(x + pv.x, y + pv.y, z + pv.z, s);
      if (s[3] < 1) return;
      P.data[q] = s[0]; P.data[q + 1] = s[1]; P.data[q + 2] = s[2]; P.data[q + 3] = s[3];
    });
    P.inherited = P.data.slice();
    const { idx } = P.owned;
    const rgba = P.owned.rgba;
    for (let n = 0; n < idx.length; n++) {
      const q = idx[n] * 4;
      rgba[n * 4] = H.data[q]; rgba[n * 4 + 1] = H.data[q + 1]; rgba[n * 4 + 2] = H.data[q + 2]; rgba[n * 4 + 3] = H.data[q + 3];
      H.data[q] = H.data[q + 1] = H.data[q + 2] = H.data[q + 3] = 0;
    }
    P.tex.needsUpdate = true;
    H.tex.needsUpdate = true;
  }
  // give the owned voxels back to the house, exactly as they were taken
  _restoreOwned(P) {
    const H = this.house, { idx, rgba } = P.owned;
    for (let n = 0; n < idx.length; n++) {
      const q = idx[n] * 4;
      H.data[q] = rgba[n * 4]; H.data[q + 1] = rgba[n * 4 + 1]; H.data[q + 2] = rgba[n * 4 + 2]; H.data[q + 3] = rgba[n * 4 + 3];
    }
  }

  // separation: a piece takes the paint it showed, the house lets it go.
  // pivot: the piece's origin in the house frame; puffs: [{x,y,z,R}] house frame
  detach(pivot, puffs) {
    this.end();
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const s of puffs) {
      const r = s.R + 0.35;
      lo[0] = Math.min(lo[0], s.x - pivot.x - r); lo[1] = Math.min(lo[1], s.y - pivot.y - r); lo[2] = Math.min(lo[2], s.z - pivot.z - r);
      hi[0] = Math.max(hi[0], s.x - pivot.x + r); hi[1] = Math.max(hi[1], s.y - pivot.y + r); hi[2] = Math.max(hi[2], s.z - pivot.z + r);
    }
    const vol = new PaintVolume({ lo, hi, cell: 0.08 });
    vol.pivot = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
    const own = this._ownedIndices(puffs);
    vol.owned = { idx: own.idx, rgba: new Uint8Array(own.idx.length * 4) };
    vol.ownBox = own.box;
    this._inherit(vol);
    vol.detachSeq = ++this.seq;
    this.pieces.add(vol);
    this._changed();
    return vol;
  }

  // the house block a piece's volume covers, sitting in its socket
  _mergeBox(vol, pivot) {
    const H = this.house, [rx, ry, rz] = H.res, c = H.cell;
    const x0 = vol.lo.x + pivot.x, y0 = vol.lo.y + pivot.y, z0 = vol.lo.z + pivot.z;
    return [
      Math.max(0, Math.floor((x0 - H.lo.x) / c)), Math.max(0, Math.floor((y0 - H.lo.y) / c)), Math.max(0, Math.floor((z0 - H.lo.z) / c)),
      Math.min(rx - 1, Math.ceil((x0 + vol.size.x - H.lo.x) / c)), Math.min(ry - 1, Math.ceil((y0 + vol.size.y - H.lo.y) / c)), Math.min(rz - 1, Math.ceil((z0 + vol.size.z - H.lo.z) / c)),
    ];
  }
  // what the house shows over box M once the piece is back:
  //  owned voxels     — the saved house value if the piece was not painted
  //                     there, else the piece's paint
  //  the rest         — the house as it is, with the piece's new paint laid
  //                     over where it was painted
  // raw: house data over M (block layout); pd: the piece's data
  _composite(vol, pivot, M, raw, pd, ownedAt) {
    const H = this.house, c = H.cell, s = this._s, t = this._t;
    const [i0, j0, k0, i1, j1, k1] = M;
    const out = new Uint8Array(raw.length);
    let o = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++, o += 4) {
      const x = H.lo.x + (i + 0.5) * c - pivot.x, y = H.lo.y + (j + 0.5) * c - pivot.y, z = H.lo.z + (k + 0.5) * c - pivot.z;
      sampleData(vol, pd, x, y, z, s);
      sampleData(vol, vol.inherited, x, y, z, t);
      const own = ownedAt.get(i + H.res[0] * (j + H.res[1] * k));
      const painted = !near4(s, t);
      if (own !== undefined) {
        if (!painted) { for (let a = 0; a < 4; a++) out[o + a] = vol.owned.rgba[own * 4 + a]; }
        else if (s[3] >= 1) { for (let a = 0; a < 4; a++) out[o + a] = Math.round(s[a]); }
        continue;
      }
      if (!painted || s[3] < 1) { for (let a = 0; a < 4; a++) out[o + a] = raw[o + a]; continue; }
      if (t[3] >= 1) { for (let a = 0; a < 4; a++) out[o + a] = Math.round(s[a]); continue; } // repainted inherited paint
      // fresh paint where the piece had none: over the house
      const a = s[3] / 255, a0 = raw[o + 3] / 255, a1 = a + a0 * (1 - a);
      for (let ch = 0; ch < 3; ch++) out[o + ch] = Math.round((s[ch] * a + raw[o + ch] * a0 * (1 - a)) / Math.max(a1, 1e-3));
      out[o + 3] = Math.round(a1 * 255);
    }
    return out;
  }

  // Reassemble: the piece is back in its socket, unrotated — its paint
  // returns to the house and its volume is released. The strokes made while
  // it was away are rewritten into house space so Undo keeps working.
  merge(vol, pivot) {
    this.end();
    const H = this.house;
    const M = this._mergeBox(vol, pivot);
    const ownedAt = new Map();
    vol.owned.idx.forEach((q, n) => ownedAt.set(q, n));
    // rewind: walk the entries of the piece's lifetime from newest to oldest,
    // undoing them on copies, and give each its "before" as the house showed it
    let raw = readBlock(H.data, H.res, M);
    const pd = vol.data.slice();
    const [mi0, mj0, mk0, mi1, mj1, mk1] = M;
    const mw = mi1 - mi0 + 1, mh = mj1 - mj0 + 1;
    for (let e = this.undo.length - 1; e >= 0; e--) {
      const u = this.undo[e];
      if (u.seq < vol.detachSeq) break;
      if (u.vol === vol) {
        restoreBlock(pd, vol.res, u.box, u.before);
        this.undo[e] = { seq: u.seq, vol: H, box: M, before: this._composite(vol, pivot, M, raw, pd, ownedAt) };
      } else if (u.vol === H && overlaps(u.box, M)) {
        // raw house before this stroke (inside M), then how it looked
        const [i0, j0, k0, i1, j1, k1] = u.box;
        const uw = i1 - i0 + 1, uh = j1 - j0 + 1;
        for (let k = Math.max(k0, mk0); k <= Math.min(k1, mk1); k++) for (let j = Math.max(j0, mj0); j <= Math.min(j1, mj1); j++) for (let i = Math.max(i0, mi0); i <= Math.min(i1, mi1); i++) {
          const src = ((i - i0) + uw * ((j - j0) + uh * (k - k0))) * 4, dst = ((i - mi0) + mw * ((j - mj0) + mh * (k - mk0))) * 4;
          for (let a = 0; a < 4; a++) raw[dst + a] = u.before[src + a];
        }
        const shown = this._composite(vol, pivot, M, raw, pd, ownedAt);
        const before = u.before.slice();
        for (let k = Math.max(k0, mk0); k <= Math.min(k1, mk1); k++) for (let j = Math.max(j0, mj0); j <= Math.min(j1, mj1); j++) for (let i = Math.max(i0, mi0); i <= Math.min(i1, mi1); i++) {
          const src = ((i - mi0) + mw * ((j - mj0) + mh * (k - mk0))) * 4, dst = ((i - i0) + uw * ((j - j0) + uh * (k - k0))) * 4;
          for (let a = 0; a < 4; a++) before[dst + a] = shown[src + a];
        }
        this.undo[e] = { seq: u.seq, vol: H, box: u.box, before };
      }
    }
    // and now the real thing
    raw = readBlock(H.data, H.res, M);
    restoreBlock(H.data, H.res, M, this._composite(vol, pivot, M, raw, vol.data, ownedAt));
    H.tex.needsUpdate = true;
    this.pieces.delete(vol);
    vol.dispose();
    this._changed();
  }
}

