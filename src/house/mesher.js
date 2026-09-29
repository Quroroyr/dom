// Surface-nets polygoniser + per-vertex light bakes.
//
// Grids are snapped to a world lattice. A brick samples a padded region but
// only emits the faces whose grid edge it owns, so neighbouring bricks meet
// vertex-to-vertex with no seams and no duplicated faces.
//
// bake  (Uint8 x4): [aoFull, aoSelf, thin, crease]
// bake2 (Uint8 x4): [sunFull, sunSelf, warm mask, cavity index * 20]

import { clamp, SUN_DIR, CAVITIES, roomness } from './sdf.js';

const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export function meshPart(part, cell, sceneSDF) {
  const f = part.f;
  const [lo, hi] = part.bbox;
  const pad = cell * 3;
  const ox = Math.floor((lo[0] - pad) / cell) * cell, oy = Math.floor((lo[1] - pad) / cell) * cell, oz = Math.floor((lo[2] - pad) / cell) * cell;
  const nx = Math.ceil((hi[0] + pad - ox) / cell) + 1;
  const ny = Math.ceil((hi[1] + pad - oy) / cell) + 1;
  const nz = Math.ceil((hi[2] + pad - oz) / cell) + 1;
  // owned grid range (world lattice indices)
  const gx0 = Math.floor(lo[0] / cell), gx1 = Math.floor(hi[0] / cell);
  const gy0 = Math.floor(lo[1] / cell), gy1 = Math.floor(hi[1] / cell);
  const gz0 = Math.floor(lo[2] / cell), gz1 = Math.floor(hi[2] / cell);
  const bx = Math.round(ox / cell), by = Math.round(oy / cell), bz = Math.round(oz / cell);
  const owns = part.isBody
    ? (i, j, k) => { const a = bx + i, b = by + j, c = bz + k; return a >= gx0 && a < gx1 && b >= gy0 && b < gy1 && c >= gz0 && c < gz1; }
    : () => true;

  const field = new Float32Array(nx * ny * nz);
  const P = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++) {
    const z = oz + k * cell;
    for (let j = 0; j < ny; j++) {
      const y = oy + j * cell;
      for (let i = 0; i < nx; i++) field[P(i, j, k)] = f(ox + i * cell, y, z);
    }
  }

  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const C = (i, j, k) => i + cx * (j + cy * k);
  const vIndex = new Int32Array(cx * cy * cz).fill(-1);
  const pos = [];
  const v = new Float32Array(8);
  const eps = Math.min(0.004, cell * 0.1);
  const g = [0, 0, 0];
  const grad = (x, y, z, out) => {
    out[0] = f(x + eps, y, z) - f(x - eps, y, z);
    out[1] = f(x, y + eps, z) - f(x, y - eps, z);
    out[2] = f(x, y, z + eps) - f(x, y, z - eps);
    const l = Math.sqrt(out[0] * out[0] + out[1] * out[1] + out[2] * out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return l / (2 * eps);
  };

  for (let k = 0; k < cz; k++) {
    for (let j = 0; j < cy; j++) {
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const val = field[P(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          v[c] = val;
          if (val < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = v[a], vb = v[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          const ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1;
          const bxx = b & 1, byy = (b >> 1) & 1, bzz = (b >> 2) & 1;
          sx += ax + (bxx - ax) * t; sy += ay + (byy - ay) * t; sz += az + (bzz - az) * t;
          n++;
        }
        let x = ox + (i + sx / n) * cell, y = oy + (j + sy / n) * cell, z = oz + (k + sz / n) * cell;
        const x0 = x, y0 = y, z0 = z;
        for (let it = 0; it < 3; it++) {
          const d = f(x, y, z);
          const gl = grad(x, y, z, g);
          const step = d / Math.max(gl, 1);
          x -= g[0] * step; y -= g[1] * step; z -= g[2] * step;
        }
        if (Math.hypot(x - x0, y - y0, z - z0) > cell * 1.2) { x = x0; y = y0; z = z0; }
        vIndex[C(i, j, k)] = pos.length / 3;
        pos.push(x, y, z);
      }
    }
  }

  const idx = [];
  const quad = (a, b, c, d) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const mx = (pos[a * 3] + pos[b * 3] + pos[c * 3] + pos[d * 3]) / 4;
    const my = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) / 4;
    const mz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2] + pos[d * 3 + 2]) / 4;
    grad(mx, my, mz, g);
    const ux = pos[c * 3] - pos[a * 3], uy = pos[c * 3 + 1] - pos[a * 3 + 1], uz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const wx = pos[d * 3] - pos[b * 3], wy = pos[d * 3 + 1] - pos[b * 3 + 1], wz = pos[d * 3 + 2] - pos[b * 3 + 2];
    const flip = (uy * wz - uz * wy) * g[0] + (uz * wx - ux * wz) * g[1] + (ux * wy - uy * wx) * g[2] < 0;
    const t = ux * ux + uy * uy + uz * uz < wx * wx + wy * wy + wz * wz ? [a, b, c, a, c, d] : [a, b, d, b, c, d];
    if (flip) for (let q = 0; q < 6; q += 3) { const s = t[q + 1]; t[q + 1] = t[q + 2]; t[q + 2] = s; }
    idx.push(...t);
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!owns(i, j, k)) continue;
        const s0 = field[P(i, j, k)] < 0;
        if (i < nx - 1 && j > 0 && k > 0 && j < cy && k < cz && s0 !== field[P(i + 1, j, k)] < 0)
          quad(vIndex[C(i, j, k)], vIndex[C(i, j - 1, k)], vIndex[C(i, j - 1, k - 1)], vIndex[C(i, j, k - 1)]);
        if (j < ny - 1 && i > 0 && k > 0 && i < cx && k < cz && s0 !== field[P(i, j + 1, k)] < 0)
          quad(vIndex[C(i, j, k)], vIndex[C(i - 1, j, k)], vIndex[C(i - 1, j, k - 1)], vIndex[C(i, j, k - 1)]);
        if (k < nz - 1 && i > 0 && j > 0 && i < cx && j < cy && s0 !== field[P(i, j, k + 1)] < 0)
          quad(vIndex[C(i, j, k)], vIndex[C(i - 1, j, k)], vIndex[C(i - 1, j - 1, k)], vIndex[C(i, j - 1, k)]);
      }
    }
  }
  if (!idx.length) return null;

  // keep only referenced vertices
  const remap = new Int32Array(pos.length / 3).fill(-1);
  let count = 0;
  for (const i of idx) if (remap[i] < 0) remap[i] = count++;
  const order = new Int32Array(count);
  for (let i = 0; i < remap.length; i++) if (remap[i] >= 0) order[remap[i]] = i;

  const fs = part.fs || f;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const bake = new Uint8Array(count * 4);
  const bake2 = new Uint8Array(count * 4);
  const [px, py, pz] = part.pivot;
  const AO_STEPS = [0.2, 0.6, 1.3];
  const CAV_STEPS = [0.04, 0.09, 0.16];
  const THIN_STEPS = [0.12, 0.3, 0.6, 1.0];
  const [lx, ly, lz] = SUN_DIR;
  const sunVis = (x, y, z, field2) => {
    let res = 1, t = 0.12;
    for (let i = 0; i < 12 && t < 11; i++) {
      const h = field2(x + lx * t, y + ly * t, z + lz * t);
      res = Math.min(res, (3.2 * h) / t);
      if (res < 0.02) break;
      t += clamp(h, 0.2, 1.2);
    }
    return clamp(res, 0, 1);
  };
  const noGround = (a, b, c) => sceneSDF(a, b, c, false);
  for (let q = 0; q < count; q++) {
    const src = order[q];
    const x = pos[src * 3], y = pos[src * 3 + 1], z = pos[src * 3 + 2];
    grad(x, y, z, g);
    const [gx, gy, gz] = g;
    position[q * 3] = x - px; position[q * 3 + 1] = y - py; position[q * 3 + 2] = z - pz;
    normal[q * 3] = gx; normal[q * 3 + 1] = gy; normal[q * 3 + 2] = gz;

    let occF = 0, occS = 0, wsum = 0;
    for (let s2 = 0; s2 < AO_STEPS.length; s2++) {
      const h = AO_STEPS[s2];
      const w = 1 / (1 + s2 * 0.6);
      const sx = x + gx * h, sy = y + gy * h, sz = z + gz * h;
      const self = fs(sx, sy, sz);
      occF += w * clamp((h - (part.isBody ? sceneSDF(sx, sy, sz, true) : self)) / h, 0, 1);
      occS += w * clamp((h - self) / h, 0, 1);
      wsum += w;
    }
    let cav = 0;
    for (const h of CAV_STEPS) cav += clamp((h - f(x + gx * h, y + gy * h, z + gz * h)) / h, 0, 1);
    let thick = 0;
    for (const h of THIN_STEPS) thick += clamp(-fs(x - gx * h, y - gy * h, z - gz * h) / (h * 0.5), 0, 1);
    bake[q * 4] = Math.round(255 * clamp(1 - (occF / wsum) * 1.25, 0, 1));
    bake[q * 4 + 1] = Math.round(255 * clamp(1 - (occS / wsum) * 1.25, 0, 1));
    bake[q * 4 + 2] = Math.round(255 * clamp(1 - thick / THIN_STEPS.length, 0, 1));
    bake[q * 4 + 3] = Math.round(255 * clamp(1 - (cav / CAV_STEPS.length) * 1.1, 0, 1));

    // two origins lifted off the surface: soft, crease-stable sun shadow
    const facing = gx * lx + gy * ly + gz * lz;
    const sField = part.isBody ? noGround : fs;
    const sf = facing < -0.35 ? 0 : sunVis(x + gx * 0.14, y + gy * 0.14, z + gz * 0.14, sField);
    bake2[q * 4] = Math.round(255 * sf);
    bake2[q * 4 + 1] = Math.round(255 * sf);
    // carved surfaces: how deep inside the uncarved mass they lie (0 at the
    // lip of an opening, 1 in the room) and which cavity they belong to
    let best = 1e9, gi = 0;
    for (const c of CAVITIES) {
      const d = Math.abs(c.f(x, y, z));
      if (d < best) { best = d; gi = c.index; }
    }
    const tunnel = best < 0.25 && part.base ? clamp((-part.base(x, y, z) - 0.02) / 0.75, 0, 1) : 0;
    const depth = Math.max(tunnel, roomness(x, y, z));
    bake2[q * 4 + 2] = Math.round(255 * depth);
    // + how close the nearest opening is (0..19): fuzz is kept short there so
    // a window or door stays readable through tall grass
    const nearOpen = clamp(1 - (best - 0.04) / 0.55, 0, 1);
    bake2[q * 4 + 3] = gi * 20 + Math.round(19 * nearOpen);
  }

  const index = new Uint32Array(idx.length);
  for (let i = 0; i < idx.length; i++) index[i] = remap[idx[i]];
  despike(index, count, normal, bake, bake2);
  despike(index, count, normal, bake, bake2);
  return { index, position, normal, bake, bake2 };
}

// A single vertex whose gradient flipped on a crease (billow meets a carved
// opening) or whose shadow ray grazed a bump shows up as a dark four-point
// star — the outlier smeared over its triangle fan. Replace only such
// outliers with the mean of their ring; everything else is left untouched.
function despike(index, count, normal, bake, bake2) {
  const nsum = new Float32Array(count * 3);
  const bsum = new Float32Array(count * 7); // ao full, ao self, crease, sun full, sun self, warm, thin
  const deg = new Uint16Array(count);
  const add = (a, b) => {
    nsum[a * 3] += normal[b * 3]; nsum[a * 3 + 1] += normal[b * 3 + 1]; nsum[a * 3 + 2] += normal[b * 3 + 2];
    bsum[a * 7] += bake[b * 4]; bsum[a * 7 + 1] += bake[b * 4 + 1]; bsum[a * 7 + 2] += bake[b * 4 + 3];
    bsum[a * 7 + 3] += bake2[b * 4]; bsum[a * 7 + 4] += bake2[b * 4 + 1]; bsum[a * 7 + 5] += bake2[b * 4 + 2];
    bsum[a * 7 + 6] += bake[b * 4 + 2];
    deg[a]++;
  };
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    add(a, b); add(a, c); add(b, a); add(b, c); add(c, a); add(c, b);
  }
  const LIM = 45;
  for (let q = 0; q < count; q++) {
    const n = deg[q];
    if (n < 6) continue;
    let mx = nsum[q * 3] / n, my = nsum[q * 3 + 1] / n, mz = nsum[q * 3 + 2] / n;
    const l = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
    mx /= l; my /= l; mz /= l;
    if (normal[q * 3] * mx + normal[q * 3 + 1] * my + normal[q * 3 + 2] * mz < 0.85) {
      normal[q * 3] = mx; normal[q * 3 + 1] = my; normal[q * 3 + 2] = mz;
    }
    const fix = (arr, i, mean) => { if (Math.abs(arr[i] - mean) > LIM) arr[i] = Math.round(mean); };
    fix(bake, q * 4, bsum[q * 7] / n);
    fix(bake, q * 4 + 1, bsum[q * 7 + 1] / n);
    fix(bake, q * 4 + 3, bsum[q * 7 + 2] / n);
    fix(bake2, q * 4, bsum[q * 7 + 3] / n);
    fix(bake2, q * 4 + 1, bsum[q * 7 + 4] / n);
    fix(bake2, q * 4 + 2, bsum[q * 7 + 5] / n);
    fix(bake, q * 4 + 2, bsum[q * 7 + 6] / n);
  }
}
