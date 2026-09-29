// Quality tiers: the one place that says how much each scalable system may
// cost. Everything else asks the active profile; nothing checks "is this a
// weak machine" on its own.
//
//   ultra   the full picture (pixel ratio up to 2)
//   high    the same picture at the pixel ratio the site always used
//   medium  fewer shells and half the multisampling; still the full look
//   low     no multisampling, a lower-resolution bloom (the cloud's glow
//           stays: it is part of its softness), no resting depth blur; the
//           grass is fewer, wider blades (a turf, not a thinned-out lawn)
//   safe    the least that still reads as the house: all interaction stays
//
// The picture never goes soft to save time: the render resolution only
// drops to 1 pixel per CSS pixel (on a dense screen), never below it.
//
// The tier is chosen by frame time, not by the name of the GPU: the name
// (and cores, memory, screen) only give the first guess, so a weak machine
// never starts on the heaviest tier; a measured result is kept per device
// and screen and used as the next start.

export const TIERS = ['safe', 'low', 'medium', 'high', 'ultra'];

export const PROFILES = {
  ultra: {
    dpr: 2.0, msaa: 4, bloom: 1, dofTaps: 28, dofRest: true,
    shadowMap: 2048, shadowBlur: 14, shadowHz: 60, contactRes: 512, contactHz: 20,
    cotton: 8, blades: 12, pieceBlades: 12, bladeLen: 1, cottonDetail: true, bladeDetail: true, particles: 1, pollen: 1, paintHz: 20, glass: true,
    budget: 16.7,
  },
  high: {
    dpr: 1.75, msaa: 4, bloom: 1, dofTaps: 28, dofRest: true,
    shadowMap: 2048, shadowBlur: 14, shadowHz: 60, contactRes: 512, contactHz: 20,
    cotton: 8, blades: 10, pieceBlades: 8, bladeLen: 1, cottonDetail: true, bladeDetail: true, particles: 0.8, pollen: 1, paintHz: 20, glass: true,
    budget: 16.7,
  },
  medium: {
    dpr: 1.5, msaa: 2, bloom: 1, dofTaps: 16, dofRest: true,
    shadowMap: 1024, shadowBlur: 10, shadowHz: 30, contactRes: 384, contactHz: 15,
    cotton: 6, blades: 8, pieceBlades: 6, bladeLen: 0.92, cottonDetail: false, bladeDetail: true, particles: 0.6, pollen: 0.7, paintHz: 15, glass: true,
    budget: 22.2,
  },
  low: {
    dpr: 1.25, msaa: 0, bloom: 0.5, dofTaps: 12, dofRest: false,
    shadowMap: 1024, shadowBlur: 8, shadowHz: 15, contactRes: 256, contactHz: 10,
    cotton: 5, blades: 6, pieceBlades: 4, bladeLen: 0.72, cottonDetail: false, bladeDetail: true, particles: 0.45, pollen: 0.5, paintHz: 12, glass: false,
    budget: 33.3,
  },
  safe: {
    dpr: 1.0, msaa: 0, bloom: 0.5, dofTaps: 8, dofRest: false,
    shadowMap: 512, shadowBlur: 6, shadowHz: 10, contactRes: 256, contactHz: 8,
    cotton: 4, blades: 4, pieceBlades: 3, bladeLen: 0.55, cottonDetail: false, bladeDetail: false, particles: 0.2, pollen: 0.3, paintHz: 10, glass: false,
    budget: 33.3,
  },
};

const rank = (t) => TIERS.indexOf(t);
const clampTier = (t, max) => (rank(t) > rank(max) ? max : t);

// ---------------------------------------------------------------------------
// the first guess, before a single frame is measured

export function gpuName(gl) {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; }
}

export function guessTier(gl) {
  const name = gpuName(gl);
  const r = name.toLowerCase();
  const why = [];
  let t = 'high';
  if (/swiftshader|llvmpipe|softpipe|basic render|software/.test(r)) { t = 'safe'; why.push('software renderer'); }
  else if (/adreno|mali|powervr|apple gpu|videocore|tegra/.test(r)) { t = 'low'; why.push('mobile gpu'); }
  else if (/intel/.test(r)) {
    // discrete Arc cards (A380…A770, B580) vs. the Arc / Iris Xe built into a CPU
    if (/arc.*\b[ab]\d{3}/.test(r)) t = 'high';
    else if (/iris|arc|xe/.test(r)) { t = 'medium'; why.push('integrated intel (xe)'); }
    else { t = 'low'; why.push('integrated intel'); }
  } else if (/radeon|amd/.test(r)) {
    if (/\brx\b|pro w|radeon pro|vii|r9|r7 3|hd 7[89]/.test(r)) t = 'high';
    else { t = 'medium'; why.push('integrated radeon'); }
  } else if (/nvidia|geforce|quadro|rtx/.test(r)) {
    if (/\bmx\s?\d|gt \d{3,4}\b|\b(9|7)\d0m?\b/.test(r)) { t = 'low'; why.push('entry nvidia'); }
    else t = 'high';
  } else if (/apple m\d/.test(r)) t = 'medium';
  else { t = 'medium'; why.push('unknown gpu'); }
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory;
  if (cores <= 4) { t = clampTier(t, 'low'); why.push(`${cores} cores`); }
  else if (cores <= 6) t = clampTier(t, 'medium');
  if (mem && mem <= 4) { t = clampTier(t, 'low'); why.push(`${mem} GB`); }
  // a phone or tablet starts light and never climbs above medium on its own
  // (heat and battery: a steady frame now is not a steady frame in a minute)
  let ceiling = 'ultra';
  if (matchMedia('(pointer: coarse)').matches) { t = clampTier(t, 'low'); ceiling = 'medium'; why.push('touch'); }
  // a big buffer (a 4K screen): start a step lower, measuring will tell
  const px = screen.width * screen.height * Math.min(devicePixelRatio, 2) ** 2;
  if (px > 5.5e6 && t !== 'safe') { t = TIERS[rank(t) - 1]; why.push('large screen'); }
  return { tier: t, ceiling, gpu: name, why: why.join(', ') || 'discrete gpu' };
}

// ---------------------------------------------------------------------------
// what the device measured last time (same GPU, screen and pixel ratio)

const KEY = 'cloudhouse.quality.v1';
function signature(gpu) {
  return `${gpu}|${screen.width}x${screen.height}|${Math.round(devicePixelRatio * 100)}`;
}
// a result is kept for 3 days: one taken while something else loaded the GPU
// (a game, another heavy tab) does not hold the device down for good
const KEEP_MS = 3 * 24 * 3600 * 1000;
function loadSaved(gpu) {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && s.sig === signature(gpu) && PROFILES[s.tier] && Date.now() - (s.t || 0) < KEEP_MS) return s;
  } catch { /* storage blocked */ }
  return null;
}
function save(gpu, tier) {
  try { localStorage.setItem(KEY, JSON.stringify({ sig: signature(gpu), tier, t: Date.now() })); } catch { /* storage blocked */ }
}

// ---------------------------------------------------------------------------
// frame-time adaptation
//
// Every frame gives its interval (the truth: what the visitor sees) and, where
// the browser has GPU timer queries, the work of the frame (max of the main
// loop's CPU time and the GPU time of the render). Decisions are made twice
// a second on the last ~2.5 s:
//  down  the median is over the tier's budget (or its p95 far over it) in
//        two evaluations in a row → one tier down; far over it in the first
//        seconds → two tiers at once (a weak machine never sits on a heavy
//        tier for long)
//  up    the work (not the interval: a 60 Hz screen caps it) stays well
//        inside the next tier's budget for 8 s; at least 15 s after any change
//  no ping-pong: after a tier had to be left, it is not tried again for a
//        minute; left twice, never again this visit
// Frames right after a world or scene change, hidden or unfocused tabs (a
// browser may slow those down) and hitches over 250 ms are not counted.
// Early in a visit (the first ~25 s, nothing had to be left yet) a step up
// is checked quickly: a start from a saved result is re-verified at once.

const WINDOW = 2.5, EVAL = 0.5;

export class Quality {
  constructor({ gl, param, apply }) {
    this.gl = gl;
    this.apply = apply;
    const g = guessTier(gl);
    this.gpu = g.gpu;
    this.guess = g.tier;
    this.guessWhy = g.why;
    this.ceiling = g.ceiling;
    const forced = param && PROFILES[param] ? param : null;
    this.auto = !forced;
    const saved = forced ? null : loadSaved(this.gpu);
    this.tier = forced || clampTier(saved?.tier || g.tier, g.ceiling);
    this.reason = forced ? `forced ?quality=${forced}` : saved ? `saved result (${saved.tier})` : `first guess: ${g.why}`;
    this.startTier = this.tier;
    this.samples = []; // [time, interval ms, work ms | -1]
    this.t = 0;
    this.lastChange = -99;
    this.lastEval = 0;
    this.ignoreUntil = 1.5;
    this.over = 0;
    this.headroomSince = -1;
    this.left = {}; // tier → { n, t }
    this.history = [{ t: 0, tier: this.tier, reason: this.reason }];
    this.stable = 0;
    this.saved = !!saved;
    this.timer = null;
    try { this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch { /* none */ }
    this.queries = [];
    this.gpuMs = -1;
    this.cpuMs = 0;
  }

  get profile() { return PROFILES[this.tier]; }

  // hold the tier still for a moment (a world / scene change compiles and
  // meshes: those frames say nothing about the steady cost)
  settle(sec = 1.2) { this.ignoreUntil = Math.max(this.ignoreUntil, this.t + sec); }

  // GPU time of the frame's render (EXT_disjoint_timer_query_webgl2)
  beginGpu() {
    if (!this.timer || this.queryOpen) return;
    // every other frame is plenty
    if ((this._qn = (this._qn || 0) + 1) % 2) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, q);
    this.queryOpen = q;
  }
  endGpu() {
    if (!this.queryOpen) return;
    this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    this.queries.push(this.queryOpen);
    this.queryOpen = null;
  }
  _pollGpu() {
    const gl = this.gl;
    if (!this.queries.length) return;
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    while (this.queries.length) {
      const q = this.queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!disjoint) this.gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
      this.queries.shift();
    }
    if (this.queries.length > 8) { for (const q of this.queries) gl.deleteQuery(q); this.queries.length = 0; }
  }

  // once per frame: dt (s) of the frame, cpu (ms) spent in the loop
  frame(dt, cpu) {
    this.t += dt;
    this.cpuMs = cpu;
    if (this.timer) this._pollGpu();
    const ms = dt * 1000;
    if (document.hidden || ms > 250 || this.t < this.ignoreUntil || !document.hasFocus()) return;
    const work = this.timer && this.gpuMs >= 0 ? Math.max(this.gpuMs, cpu) : -1;
    this.samples.push([this.t, ms, work]);
    while (this.samples.length && this.samples[0][0] < this.t - WINDOW) this.samples.shift();
    if (this.t - this.lastEval < EVAL) return;
    this.lastEval = this.t;
    // enough to judge: 20 frames, or a full second of slow ones
    const n = this.samples.length;
    if (n < 6 || (n < 20 && this.samples[n - 1][0] - this.samples[0][0] < 1)) return;
    this._decide();
  }

  stats() {
    const iv = this.samples.map((s) => s[1]).sort((a, b) => a - b);
    const wk = this.samples.map((s) => s[2]).filter((w) => w >= 0).sort((a, b) => a - b);
    const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : -1);
    return { med: q(iv, 0.5), p95: q(iv, 0.95), workMed: q(wk, 0.5), workP90: q(wk, 0.9), n: iv.length };
  }

  _decide() {
    const s = this.stats();
    this.last = s;
    if (!this.auto) return;
    const P = this.profile, B = P.budget;
    const r = rank(this.tier);
    const sinceChange = this.t - this.lastChange;
    // far over budget early on (or ever): two tiers at once
    if (r > 0 && s.med > B * 2 && sinceChange > 1.5) {
      return this._set(TIERS[Math.max(0, r - 2)], `median ${s.med.toFixed(1)} ms ≫ ${B} ms`, true);
    }
    const slow = s.med > B * 1.12 || s.p95 > B * 1.9;
    this.over = slow ? this.over + 1 : 0;
    if (r > 0 && this.over >= 2 && sinceChange > 2.5) {
      return this._set(TIERS[r - 1], s.med > B * 1.12 ? `median ${s.med.toFixed(1)} ms > ${B} ms` : `p95 ${s.p95.toFixed(1)} ms`, true);
    }
    // headroom: the work of a frame well inside the next tier's budget
    if (r < rank(this.ceiling)) {
      const up = TIERS[r + 1], NB = PROFILES[up].budget;
      const left = this.left[up];
      const blocked = left && (left.n >= 2 || this.t - left.t < 60);
      // without timer queries only the interval is known: a steady frame at
      // the display rate, and never above high
      const room = s.workMed >= 0
        ? s.workP90 < NB * 0.5 && s.med < B * 1.05
        : up !== 'ultra' && s.med < 17.5 && s.p95 < 22 && s.med <= NB * 1.05;
      const early = this.t < 25 && !this.history.some((h) => h.reason.startsWith('↓'));
      if (room && !blocked && !slow) {
        if (this.headroomSince < 0) this.headroomSince = this.t;
        if (this.t - this.headroomSince > (early ? 3 : 8) && sinceChange > (early ? 4 : 15)) {
          return this._set(up, s.workMed >= 0 ? `work p90 ${s.workP90.toFixed(1)} ms` : `steady ${s.med.toFixed(1)} ms`, false);
        }
      } else this.headroomSince = -1;
    }
    // a tier that held for a while is the device's result
    if (sinceChange > 12 && !this.saved) { save(this.gpu, this.tier); this.saved = true; }
  }

  _set(tier, reason, down) {
    if (tier === this.tier) return;
    if (down) {
      const l = this.left[this.tier] || (this.left[this.tier] = { n: 0, t: 0 });
      l.n++; l.t = this.t;
    }
    this.tier = tier;
    this.reason = `${down ? '↓' : '↑'} ${reason}`;
    this.lastChange = this.t;
    this.over = 0;
    this.headroomSince = -1;
    this.samples.length = 0;
    this.history.push({ t: +this.t.toFixed(1), tier, reason: this.reason });
    if (this.history.length > 20) this.history.shift();
    this.saved = false;
    if (down) { save(this.gpu, tier); this.saved = true; }
    this.apply(PROFILES[tier], tier);
  }

  // QA: set a tier by hand (auto stays as it was)
  force(tier) {
    if (!PROFILES[tier]) return;
    this.tier = tier;
    this.reason = 'set by hand';
    this.lastChange = this.t;
    this.samples.length = 0;
    this.history.push({ t: +this.t.toFixed(1), tier, reason: this.reason });
    this.apply(PROFILES[tier], tier);
  }

  status() {
    const s = this.last || this.stats();
    return {
      tier: this.tier, auto: this.auto, reason: this.reason, start: this.startTier, guess: this.guess, guessWhy: this.guessWhy,
      gpu: this.gpu, median: +s.med.toFixed(2), p95: +s.p95.toFixed(2),
      work: s.workMed >= 0 ? +s.workMed.toFixed(2) : null, gpuMs: this.gpuMs >= 0 ? +this.gpuMs.toFixed(2) : null, cpuMs: +this.cpuMs.toFixed(2),
      history: this.history,
    };
  }
}
