import * as THREE from 'three';

// Tactile audio: the house sounds like what it is made of.
//
// A separate layer that only listens: the physics, the worlds and the UI do
// not change for it. Everything is synthesised (Web Audio). A few textures
// are made once — soft noises, cotton fibre, soil grain, blade rustle — and
// every event shapes them with filters and envelopes, a little differently
// each time. No music, no ambience.
//
//   event layers → event gain (ducking) → panner
//     → material bus (the material's own hidden, selective EQ)
//     → headroom trim → user EQ (low shelf · mid peak · high shelf)
//     → peak control → master volume → ceiling → out
//
// Loudness: nothing is normalised to full scale. The trim sits before the
// compressor, so everything arrives at it with headroom: it only catches the
// rare peak and never presses on ordinary events (placed after a fixed
// master it squeezed nearly every sound by several dB — the "blanket").
// Both compressors are compensated for the make-up gain the browser adds on
// its own (measured: +3.35 dB and +2.3 dB for these settings).
//
// Soft is not muffled: the highs are not cut globally. Each material keeps a
// quiet, slow-rising air/texture layer above a soft body; only sharp fronts,
// hiss bursts and narrow resonances are kept out.
//
// Events are grouped: a tear is the master event of its moment — for
// ~200 ms smaller sounds are ducked, a second tear becomes a quiet
// secondary, the torn piece's own knocks are dropped. Priorities decide
// who is dropped when too much happens at once.
//
// Positions are in camera space (listener at the origin looking down −z),
// the sideways part halved — left is left, but no hard stereo.

const PROFILES = {
  cloud: () => Promise.resolve({ default: cloudProfile }),
  grass: () => import('./grass.js'),
};

// priority: who stays when too much happens at once
export const PRIO = { TEAR: 6, IMPACT: 5, RETURN: 4, TENSION: 3, DEBRIS: 2, MINOR: 1 };
const MAX_EVENTS = 10;
const TEAR_WINDOW = 0.2;   // s: the tear's moment
const DUCK = 0.32;         // −10 dB for smaller sounds inside it
const MAJOR_HIT = 1.2;     // m/s: a hit that leads its moment
const HIT_WINDOW = 0.12;   // s: the main hit's moment (secondary hits −9 dB, minor sounds ducked)
const HIT_DUCK = 0.35;
const BOUNCE_HOLD = 0.7;   // s: a piece's small re-contacts after a real hit stay silent

const STORE = 'ch-sound';
const STORE_MIX = 'ch-sound-mix';
export const MIX_DEFAULT = { vol: 50, low: 0, mid: 0, high: 0 };
// the fixed trim before the EQ and the compressor (calibrated in
// qa/audio-lab.js: the same loudness as the muffled pass — the clarity comes
// from the spectrum, not from level — i.e. ~10.5–13 LU under the first
// version, 40–50 % of its loudness); the fader after it is quadratic:
// 50 = ×1 (default), 100 = +12 dB
const TRIM = 0.18;
const COMP_MAKEUP = 10 ** (-3.35 / 20);
const CEIL_MAKEUP = 10 ** (-2.3 / 20);

const tmp = new THREE.Vector3();
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// --- textures (made once) ------------------------------------------------------------
// every texture loops seamlessly (grains wrap around) and is band-limited
// where it is made: nothing harsh is stored, filters only shape it further

function onePoleLP(d, fc, sr, passes = 1) {
  const a = Math.exp(-2 * Math.PI * fc / sr);
  for (let p = 0; p < passes; p++) {
    // two runs over the loop so the filter state is settled at the seam
    let y = 0;
    for (let r = 0; r < 2; r++) for (let i = 0; i < d.length; i++) { y = (1 - a) * d[i] + a * y; if (r) d[i] = y; }
  }
}
function onePoleHP(d, fc, sr) {
  const lp = Float32Array.from(d);
  onePoleLP(lp, fc, sr);
  for (let i = 0; i < d.length; i++) d[i] -= lp[i];
}
function normalize(d, peak) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  if (m > 0) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
}
function toBuffer(ctx, d) {
  const b = ctx.createBuffer(1, d.length, ctx.sampleRate);
  b.getChannelData(0).set(d);
  return b;
}
function pinkArray(n) {
  const d = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    if (r) d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return d;
}

// soft pink noise (only the very top eased)
export function pinkTexture(ctx, sec = 2) {
  const d = pinkArray(Math.round(ctx.sampleRate * sec));
  onePoleLP(d, 12000, ctx.sampleRate);
  normalize(d, 0.8);
  return toBuffer(ctx, d);
}
// brown (red) noise: all body, no edge
export function brownTexture(ctx, sec = 2) {
  const sr = ctx.sampleRate, n = Math.round(sr * sec);
  const d = new Float32Array(n);
  let y = 0;
  for (let r = 0; r < 2; r++) for (let i = 0; i < n; i++) { y = y * 0.998 + (Math.random() * 2 - 1) * 0.04; if (r) d[i] = y; }
  onePoleHP(d, 25, sr);
  normalize(d, 0.8);
  return toBuffer(ctx, d);
}
// grains: `density` per second of `grain` s, content from `src`, soft edges.
// shape: 'hann' (a swell) or 'tap' (quick soft rise, short decay)
function grains(n, sr, { density, len, src, shape = 'hann', rise = [0.0005, 0.0012], amp = 1.6 }) {
  const d = new Float32Array(n);
  const count = Math.round(density * n / sr);
  for (let g = 0; g < count; g++) {
    const at = (Math.random() * n) | 0;
    const L = Math.max(8, Math.round(rnd(len[0], len[1]) * sr));
    const a = Math.pow(Math.random(), amp) * (Math.random() < 0.5 ? -1 : 1);
    const off = (Math.random() * src.length) | 0;
    const R = Math.max(2, Math.round(rnd(rise[0], rise[1]) * sr));
    for (let j = 0; j < L; j++) {
      let w;
      if (shape === 'hann') w = 0.5 - 0.5 * Math.cos(2 * Math.PI * j / L);
      else w = (j < R ? 0.5 - 0.5 * Math.cos(Math.PI * j / R) : 1) * Math.exp(-4 * (j / L));
      d[(at + j) % n] += a * w * src[(off + j) % src.length];
    }
  }
  return d;
}
// cotton: a slow flutter of soft fibre friction (overlapping swells of pink
// noise), nothing above ~2.5 kHz
export function cottonTexture(ctx, sec = 2.5) {
  const sr = ctx.sampleRate, n = Math.round(sr * sec);
  const pink = pinkArray(sr);
  // (long, dense, overlapping swells: soft fabric, not a patter)
  const d = grains(n, sr, { density: 120, len: [0.04, 0.12], src: pink, shape: 'hann', amp: 1 });
  onePoleLP(d, 2400, sr, 2);
  onePoleHP(d, 70, sr);
  normalize(d, 0.8);
  return toBuffer(ctx, d);
}
// air: continuous smooth noise, 2–10 kHz, breathing only slowly (a few
// swells a second, ±25 %) — space and loose fibre. No grains: grains here
// flickered at 10–30 Hz and a tear sounded like trickling sand.
export function fibreTexture(ctx, sec = 2.5) {
  const sr = ctx.sampleRate, n = Math.round(sr * sec);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  onePoleHP(d, 1800, sr);
  onePoleLP(d, 10000, sr);
  // the breath: a slow random swell, seamless over the loop
  const K = 6, ph = Array.from({ length: K }, () => Math.random() * 2 * Math.PI), f = Array.from({ length: K }, (_, k) => Math.round((1.2 + k * 0.9) * sec) / sec);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < K; k++) m += Math.sin(2 * Math.PI * f[k] * i / sr + ph[k]);
    d[i] *= 1 + 0.25 * m / Math.sqrt(K);
  }
  // (continuous noise carries more energy than the grains did at the same
  // peak: scaled so every layer that uses it keeps its level)
  normalize(d, 0.45);
  return toBuffer(ctx, d);
}

// --- the core -------------------------------------------------------------------------

export class MaterialAudio {
  constructor({ camera }) {
    this.camera = camera;
    this.ctx = null;
    this.on = readPref();
    this.mix = readMix();
    this.world = 'cloud';
    this.profiles = new Map(); // id → { def, bus }
    this.profile = null;       // the active one (once loaded)
    this.buffers = new Map();
    this.events = [];          // playing
    this.nodes = 0;            // audio nodes alive (for checks)
    this.loop = null;          // the one held loop (tension / carry)
    this.tearing = null;
    this.interaction = null;
    this._pre = false;         // pre-tear latch (hysteresis)
    this._preEv = null;        // the pre-tear sound, faded if the tear comes at once
    this._pieces = new WeakMap(); // per-piece memory: hits, settle, torn
    this._debris = null;       // grains gathered over a short window
    this._hitTimes = [];       // impacts in the last second (rate cap)
    this._tearT = -9;          // the last full tear
    this._tearN = 0;           // secondaries in its window
    this._hitT = -9;           // the last main hit
    this.meter = null;         // QA: peak at the output (see enableMeter)
    this.onChange = null;

    const first = () => this._gesture();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, first, { capture: true, passive: true });
    // some browsers only unlock on a completed tap
    for (const ev of ['pointerup', 'click']) addEventListener(ev, () => { if (this.on && this.ctx?.state === 'suspended' && !document.hidden) this.ctx.resume(); }, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (this.on) this.ctx.resume();
    });
  }

  attach({ tearing, interaction }) { this.tearing = tearing; this.interaction = interaction; }

  // --- lifecycle ---------------------------------------------------------------
  _gesture() {
    if (this.ctx || !this.on) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const bq = (type, f, q, g = 0) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = g; return n; };
    // headroom trim, then the user EQ (flat at reset: the material buses
    // already carry the sound design)
    const trim = ctx.createGain(); trim.gain.value = TRIM;
    this.eq = { low: bq('lowshelf', 180, 0.7), mid: bq('peaking', 1250, 0.8), high: bq('highshelf', 4500, 0.7) };
    // peak control only: well above ordinary events, not instant, gentle ratio
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 6; comp.ratio.value = 2;
    comp.attack.value = 0.008; comp.release.value = 0.25;
    const compMk = ctx.createGain(); compMk.gain.value = COMP_MAKEUP;
    this.master = ctx.createGain();
    const ceil = ctx.createDynamicsCompressor();
    ceil.threshold.value = -4; ceil.knee.value = 0; ceil.ratio.value = 20;
    ceil.attack.value = 0.002; ceil.release.value = 0.12;
    const ceilMk = ctx.createGain(); ceilMk.gain.value = CEIL_MAKEUP;
    trim.connect(this.eq.low).connect(this.eq.mid).connect(this.eq.high).connect(comp).connect(compMk)
      .connect(this.master).connect(ceil).connect(ceilMk).connect(ctx.destination);
    this.input = trim;
    this.out = ceilMk;
    this.comp = comp; this.compMk = compMk;
    this.nodes += 9;
    this._applyMix(true);
    this.buffer('pink', pinkTexture);
    this.buffer('brown', brownTexture);
    this.buffer('cotton', cottonTexture);
    this.buffer('fibre', fibreTexture);
    this.setWorld(this.world);
    if (ctx.state === 'suspended') ctx.resume();
  }

  get enabled() { return this.on; }
  setEnabled(on) {
    this.on = on;
    try { localStorage.setItem(STORE, on ? '1' : '0'); } catch { /* private mode */ }
    if (on) {
      if (!this.ctx) this._gesture(); // the switch's own click is a gesture
      else { this.ctx.resume(); this._applyMix(); }
    } else if (this.ctx) {
      // fully silent at once, then the clock stops (no CPU while muted)
      this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.015);
      this._stopLoop(0.02);
      setTimeout(() => { if (!this.on) this.ctx.suspend(); }, 120);
    }
    this.onChange?.(on);
  }

  // --- the listener's mix: volume and a three-band EQ, remembered ----------------
  setMix(key, value) {
    this.mix = { ...this.mix, [key]: value };
    try { localStorage.setItem(STORE_MIX, JSON.stringify(this.mix)); } catch { /* private mode */ }
    this._applyMix();
  }
  resetMix() {
    this.mix = { ...MIX_DEFAULT };
    try { localStorage.removeItem(STORE_MIX); } catch { /* private mode */ }
    this._applyMix();
  }
  _applyMix(instant = false) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, set = (p, v) => (instant ? p.setValueAtTime(v, now) : p.setTargetAtTime(v, now, 0.03));
    const m = this.mix;
    set(this.master.gain, this.on ? (m.vol / 50) ** 2 : 0);
    set(this.eq.low.gain, m.low);
    set(this.eq.mid.gain, m.mid);
    set(this.eq.high.gain, m.high);
  }

  // the world changed: its profile takes over (fetched on first use)
  async setWorld(id) {
    this.world = id;
    if (!this.ctx) return; // made on the first gesture
    let P = this.profiles.get(id);
    if (!P) {
      const load = PROFILES[id];
      if (!load) { this.profile = null; return; }
      const mod = await load();
      P = this.profiles.get(id);
      if (!P) {
        const def = mod.default;
        def.init?.(this);
        P = { def, bus: this._bus(def) };
        this.profiles.set(id, P);
      }
    }
    if (this.world === id) this.profile = P;
  }
  // a material's own bus: level and its hidden sound-design EQ
  _bus(def) {
    const ctx = this.ctx;
    const inp = ctx.createGain();
    inp.gain.value = def.level ?? 1;
    let tail = inp;
    for (const e of def.eq || []) {
      const n = ctx.createBiquadFilter();
      n.type = e.type; n.frequency.value = e.f; n.Q.value = e.q ?? 0.7;
      if (e.gain != null) n.gain.value = e.gain;
      tail.connect(n); tail = n;
    }
    tail.connect(this.input);
    this.nodes += 1 + (def.eq?.length || 0);
    return inp;
  }

  // a texture made once and kept
  buffer(name, make) {
    if (!this.buffers.has(name) && make) this.buffers.set(name, make(this.ctx));
    return this.buffers.get(name) || null;
  }

  // --- events ---------------------------------------------------------------------
  get t() { return this.ctx.currentTime; }
  get live() { return this.on && this.ctx && this.ctx.state === 'running' && this.profile; }

  // where a world point sits for the listener (camera space, sides halved)
  _local(world) {
    tmp.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
    tmp.x *= 0.5;
    return tmp;
  }

  liveEvents() { let n = 0; for (const e of this.events) if (!e.dying) n++; return n; }

  // may an event of this priority start? When full, the least important
  // (then the quietest) playing one makes room — or the newcomer is dropped
  _admit(prio, level) {
    if (this.liveEvents() < MAX_EVENTS) return true;
    let w = null;
    for (const e of this.events) if (!e.dying && (!w || e.prio < w.prio || (e.prio === w.prio && e.level < w.level))) w = e;
    if (!w || w.prio > prio || (w.prio === prio && w.level >= level)) return false;
    w.kill();
    return true;
  }

  // one event: several layers under one gain (for ducking) and one position.
  //   spec:  { prio, gain, pos, at }
  //   layer: { buf, rate, gain, at, env: { a, h, d }, hp, lp: f | [f, f1, ft], lp2, bp, q }
  // lp / hp are 12 dB/oct, `lp2: true` doubles the low-pass (24 dB/oct).
  // Every layer varies a little: gain, filter, speed, decay, noise segment.
  event(spec, layers, P = this.profile) {
    const ctx = this.ctx;
    if (!ctx || !P || ctx.state !== 'running') return null;
    const prio = spec.prio ?? PRIO.MINOR;
    let gain = (spec.gain ?? 1) * rnd(0.88, 1.12);
    // inside a tear's moment the smaller sounds step back
    if (prio < PRIO.TEAR && ctx.currentTime - this._tearT < TEAR_WINDOW) gain *= DUCK;
    // and inside a main hit's: crumbs step back (coming up again over
    // ~0.4 s as the rest of the soil lands), minor sounds wait it out
    const since = ctx.currentTime - this._hitT;
    if (prio === PRIO.DEBRIS && since < HIT_WINDOW + 0.4) gain *= HIT_DUCK + (1 - HIT_DUCK) * clamp01((since - HIT_WINDOW) / 0.4);
    else if (prio === PRIO.MINOR && since < HIT_WINDOW) gain *= HIT_DUCK;
    if (gain < 1e-4) return null;
    if (!this._admit(prio, gain)) return null;
    const t0 = ctx.currentTime + 0.004 + (spec.at || 0);
    const eg = ctx.createGain();
    eg.gain.value = gain;
    let out = eg, nodes = 1;
    if (spec.pos) {
      const p = ctx.createPanner();
      p.panningModel = 'equalpower';
      p.distanceModel = 'inverse';
      p.refDistance = 10; p.rolloffFactor = 0.6; p.maxDistance = 200;
      const l = this._local(spec.pos);
      p.positionX.value = l.x; p.positionY.value = l.y; p.positionZ.value = l.z;
      eg.connect(p); out = p; nodes++;
    }
    out.connect(P.bus);
    const ev = { prio, level: gain, dying: false, eg, out, srcs: [], base: nodes, nodes, open: 0 };
    let end = t0;
    for (const L of layers) {
      if (!L) continue;
      const e = this._layer(L, t0, ev);
      if (e) end = Math.max(end, e);
    }
    if (!ev.open) { eg.disconnect(); out.disconnect(); return null; }
    this.nodes += ev.nodes;
    ev.kill = (fade = 0.03) => {
      if (ev.dying) return;
      ev.dying = true;
      const now = ctx.currentTime;
      eg.gain.cancelScheduledValues(now);
      eg.gain.setValueAtTime(eg.gain.value, now);
      eg.gain.linearRampToValueAtTime(0, now + fade);
      for (const s of ev.srcs) { try { s.stop(now + fade + 0.01); } catch { /* ended */ } }
    };
    ev.duck = (k) => { if (!ev.dying) eg.gain.setTargetAtTime(eg.gain.value * k, ctx.currentTime, 0.02); };
    this.events.push(ev);
    return ev;
  }

  _layer(L, t0, ev) {
    const ctx = this.ctx;
    const buf = this.buffer(L.buf || 'pink');
    if (!buf) return null;
    const ff = rnd(0.92, 1.08);                        // filter shift
    const { a = 0.01, h = 0 } = L.env || {};
    const d = (L.env?.d ?? 0.15) * rnd(0.88, 1.12);  // decay varies
    const start = t0 + (L.at || 0);
    const end = start + a + h + d;
    const nodes = [];
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = (L.rate ?? 1) * (L.fixedRate ? 1 : rnd(0.96, 1.04));
    nodes.push(src);
    let tail = src;
    const filt = (type, f, q) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      const [f0, f1, ft] = Array.isArray(f) ? f : [f];
      n.frequency.setValueAtTime(f0 * ff, start);
      if (f1) n.frequency.exponentialRampToValueAtTime(f1 * ff, start + (ft ?? a + h + d));
      n.Q.value = q;
      tail.connect(n); tail = n; nodes.push(n);
    };
    if (L.hp) filt('highpass', L.hp, 0.6);
    if (L.bp) filt('bandpass', L.bp, L.q ?? 0.7);
    if (L.lp) { filt('lowpass', L.lp, 0.6); if (L.lp2) filt('lowpass', L.lp, 0.6); }
    // the envelope: a rounded rise (no hard edge), a hold, a decay that
    // eases out to exactly zero
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueCurveAtTime(envCurve(a, h, d, L.gain ?? 1), start, a + h + d);
    tail.connect(g); nodes.push(g);
    g.connect(ev.eg);
    src.start(start, Math.random() * (buf.duration - 0.1));
    src.stop(end + 0.02);
    ev.srcs.push(src);
    ev.open++;
    ev.nodes += nodes.length;
    src.onended = () => {
      for (const n of nodes) n.disconnect();
      this.nodes -= nodes.length;
      // the last layer out takes the event's own gain and panner with it
      if (--ev.open === 0) {
        ev.eg.disconnect(); if (ev.out !== ev.eg) ev.out.disconnect();
        this.nodes -= ev.base;
        const i = this.events.indexOf(ev);
        if (i >= 0) this.events.splice(i, 1);
      }
    };
    return end;
  }

  // --- the held loop: one for the whole house ------------------------------------
  // (tension while pulling, motion while carrying). Made when needed, stopped
  // when it has been silent for a while; a world switch fades the old one out.
  _ensureLoop(P) {
    const spec = P.def.loop;
    if (!spec) return null;
    if (this.loop && this.loop.P === P) return this.loop;
    this._stopLoop(0.05);
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer(spec.buf);
    src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = spec.hp; hp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = spec.lp; lp.Q.value = 0.6;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = spec.lp; lp2.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(hp).connect(lp).connect(lp2).connect(g).connect(P.bus);
    src.start(ctx.currentTime, Math.random() * (src.buffer.duration - 0.1));
    const nodes = [src, hp, lp, lp2, g];
    // its quiet air: a second texture in its own band, mixed in by tension
    let air = null;
    if (spec.air) {
      const as = ctx.createBufferSource();
      as.buffer = this.buffer(spec.air.buf);
      as.loop = true;
      const ahp = ctx.createBiquadFilter(); ahp.type = 'highpass'; ahp.frequency.value = spec.air.hp; ahp.Q.value = 0.6;
      const alp = ctx.createBiquadFilter(); alp.type = 'lowpass'; alp.frequency.value = spec.air.lp; alp.Q.value = 0.6;
      const ag = ctx.createGain(); ag.gain.value = 0;
      as.connect(ahp).connect(alp).connect(ag).connect(g);
      as.start(ctx.currentTime, Math.random() * (as.buffer.duration - 0.1));
      nodes.push(as, ahp, alp, ag);
      air = { src: as, g: ag, level: 0 };
    }
    this.nodes += nodes.length;
    this.loop = { P, src, lp, lp2, g, air, nodes, level: 0, f: spec.lp, rate: 1, quiet: 0 };
    return this.loop;
  }
  _stopLoop(fade = 0.05) {
    const L = this.loop;
    if (!L) return;
    this.loop = null;
    const now = this.ctx.currentTime;
    L.g.gain.cancelScheduledValues(now);
    L.g.gain.setTargetAtTime(0, now, fade / 3);
    L.src.stop(now + fade + 0.05);
    L.air?.src.stop(now + fade + 0.05);
    L.src.onended = () => { for (const n of L.nodes) n.disconnect(); this.nodes -= L.nodes.length; };
  }
  _loopTo(level, f, rate, dt, air = 0) {
    const L = this.loop;
    const now = this.ctx.currentTime;
    // only when something changed: no stream of automation events
    if (Math.abs(level - L.level) > 0.0005) { L.g.gain.setTargetAtTime(level, now, level > L.level ? 0.09 : 0.06); L.level = level; }
    if (L.air && Math.abs(air - L.air.level) > 0.005) { L.air.g.gain.setTargetAtTime(air, now, 0.12); L.air.level = air; }
    if (f && Math.abs(f - L.f) > L.f * 0.02) { L.lp.frequency.setTargetAtTime(f, now, 0.08); L.lp2.frequency.setTargetAtTime(f, now, 0.08); L.f = f; }
    if (rate && Math.abs(rate - L.rate) > 0.01) { L.src.playbackRate.setTargetAtTime(rate, now, 0.1); L.rate = rate; }
    L.quiet = level > 0 ? 0 : L.quiet + dt;
    if (L.quiet > 0.6) this._stopLoop(0.02);
  }

  // --- events from the physics hooks -------------------------------------------------
  _emit(kind, p, P = this.profile) { if (this.live && P) return P.def.play(this, kind, p, P); return null; }

  grab(pc, fromTear) {
    if (fromTear || !this.live) return;
    this._emit('grab', { pos: pc.mesh.getWorldPosition(new THREE.Vector3()), size: pc.clump.rad });
  }
  tear(p) {
    if (!this.live) return;
    const now = this.ctx.currentTime;
    // the strain lets go at once
    if (this.loop) this._loopTo(0, 0, 0, 0);
    this._pre = false;
    const pos = this.tearing.house.container.localToWorld(p.anchor.clone());
    if (p.piece) this._mem(p.piece).tornAt = now;
    if (now - this._tearT < TEAR_WINDOW) {
      // another tear inside this one's moment: a quiet secondary, at most two
      if (++this._tearN <= 2) this._emit('tear2', { pos, size: p.clump.rad });
      return;
    }
    this._tearT = now;
    this._tearN = 0;
    // the whisper before it is cut short; smaller sounds already playing step back
    if (this._preEv && now - this._preEv.t < 0.25) this._preEv.ev?.kill(0.06);
    this._preEv = null;
    for (const e of this.events) if (e.prio <= PRIO.DEBRIS) e.duck(DUCK);
    this._emit('tear', { pos, size: p.clump.rad });
  }
  // at: house frame (a temp vector: read now)
  impact(at, speed, n, kind, pc) {
    if (!this.live) return;
    const now = this.ctx.currentTime;
    const m = pc ? this._mem(pc) : null;
    if (m) {
      // a piece still next to the wound it left: its bumps belong to the tear
      if (now - m.tornAt < 0.3) return;
      // a contact that goes on (pressed against the house, resting on
      // another) reports every frame: only a new touch, or a harder one
      const gap = now - m.lastContact;
      m.lastContact = now;
      if (gap < 0.25 && speed < m.lastSpeed * 1.8) return;
      if (now - m.lastSound < 0.12) return;
    }
    const def = this.profile.def;
    if (speed < (def.impactMin ?? 0.5)) return;
    // one landing is one sound: after a real hit, the same piece's small
    // bounces and re-contacts are silent for a moment (hysteresis: only a
    // clearly new, strong hit comes through)
    if (m && now - m.bigT < BOUNCE_HOLD && speed < m.bigV * 0.6) return;
    // at most 6 a second overall
    const hs = this._hitTimes;
    while (hs.length && now - hs[0] > 1) hs.shift();
    if (hs.length >= 6) return;
    hs.push(now);
    if (m) { m.lastSound = now; m.lastSpeed = speed; }
    // the first real hit of a moment is the main one; another contact inside
    // its window (the same fall touching the house, a neighbour knocked) is
    // a quiet secondary
    const major = speed >= MAJOR_HIT;
    const sub = now - this._hitT < HIT_WINDOW;
    if (major && !sub) this._hitT = now;
    if (major && m) { m.bigV = now - m.bigT < BOUNCE_HOLD ? Math.max(speed, m.bigV) : speed; m.bigT = now; }
    const pos = this.tearing.house.container.localToWorld(at.clone());
    this._emit('impact', { pos, speed, kind, mass: pc ? pc.mass : 1, size: pc ? pc.clump.rad : 1, gainK: sub ? HIT_DUCK : 1 });
  }
  release(pc) {
    if (!this.live) return;
    const speed = pc.vel.length();
    if (speed > 2.5) this._emit('throw', { pos: pc.mesh.getWorldPosition(new THREE.Vector3()), speed, size: pc.clump.rad });
  }
  returning(pc, delay) {
    if (!this.live) return;
    this._emit('return', { pos: pc.mesh.getWorldPosition(new THREE.Vector3()), delay, size: pc.clump.rad });
  }
  absorb(pc, how) {
    if (!this.live) return;
    this._emit('absorb', { pos: pc.mesh.getWorldPosition(new THREE.Vector3()), size: pc.clump.rad, soft: how !== 'returning' });
  }
  // grains hitting the ground or the house (world frame), gathered over ~70 ms
  // into a few taps — never one sound per grain. `world`: the material they
  // are (a leaving world's debris still sounds like itself)
  debris(n, at, vmax, world) {
    if (!this.live) return;
    const P = this.profiles.get(world);
    if (!P) return;
    const g = this._debris || (this._debris = { n: 0, at: new THREE.Vector3(), v: 0, t: 0, P });
    g.at.multiplyScalar(g.n).addScaledVector(at, n).divideScalar(g.n + n);
    g.n += n; g.v = Math.max(g.v, vmax); g.P = P;
  }

  _mem(pc) {
    let m = this._pieces.get(pc);
    if (!m) { m = { lastContact: -9, lastSound: -9, lastSpeed: 0, peak: 0, settleT: -9, tornAt: -9, bigT: -9, bigV: 0, swishT: -9, fast: false }; this._pieces.set(pc, m); }
    return m;
  }

  // --- per frame: what is only known by looking --------------------------------
  update(dt) {
    if (this.meter) this._readMeter();
    if (!this.live || !this.tearing) return;
    const P = this.profile, def = P.def;
    const now = this.ctx.currentTime;
    const pull = this.tearing.pull;
    const carry = this.interaction?.carry;
    let tension = 0, move = 0;
    if (pull && pull.piece && pull.socket) tension = clamp01(pull.dist / pull.breakAt);
    else if (carry) move = carry.piece.vel.length();
    // a detached piece swept fast: at most one faint swish (if the material
    // has one), on the way up past the speed, then a rest
    if (carry && def.swish) {
      const m = this._mem(carry.piece);
      if (move > def.swish.speed && !m.fast && now - m.swishT > def.swish.cooldown) {
        m.swishT = now;
        def.play(this, 'swish', { pos: carry.piece.mesh.getWorldPosition(new THREE.Vector3()), k: clamp01((move - def.swish.speed) / 4 + 0.5) }, P);
      }
      m.fast = move > def.swish.speed * 0.8;
    }
    const [lv, f, rate, air] = def.loopLevel(tension, move);
    if (lv > 0 || (this.loop && this.loop.P === P)) {
      if (this._ensureLoop(P)) this._loopTo(lv, f, rate, dt, air);
    } else if (this.loop) this._loopTo(0, 0, 0, dt);
    // the moment before it gives
    if (tension > 0.68 && !this._pre) {
      this._pre = true;
      const pos = this.tearing.house.container.localToWorld(pull.anchor.clone());
      this._preEv = { t: now, ev: def.play(this, 'pretear', { pos, tension, size: pull.clump.rad }, P) };
    } else if (tension < 0.55) this._pre = false;
    // a material may keep speaking under strain (roots creaking)
    if (tension > 0 && def.strain) def.strain(this, dt, tension, pull, P);

    // settle: a loose piece that was moving comes to rest
    for (const pc of this.tearing.pieces) {
      if (pc.state !== 'free' || pc.hold) continue;
      const m = this._mem(pc);
      const sp = pc.sleeping ? 0 : pc.vel.length();
      if (sp > m.peak) m.peak = sp;
      if (m.peak > 0.8 && sp < 0.12) {
        m.peak = 0;
        // (a piece that has just landed hard already said so: no second thud)
        if (now - m.settleT > 1.5 && now - m.bigT > 0.8) {
          m.settleT = now;
          def.play(this, 'settle', { pos: pc.mesh.getWorldPosition(new THREE.Vector3()), size: pc.clump.rad }, P);
        }
      }
    }

    // grains: one gathering every 70 ms
    const g = this._debris;
    if (g && g.n) {
      g.t += dt;
      if (g.t >= 0.07) {
        g.P.def.play(this, 'debris', { pos: g.at, n: g.n, v: g.v }, g.P);
        this._debris = null;
      }
    }
  }

  // --- checks ------------------------------------------------------------------------
  enableMeter(on = true) {
    if (!this.ctx) return;
    if (!on) { this.meter = null; return; }
    const an = this.ctx.createAnalyser();
    an.fftSize = 2048;
    this.out.connect(an);
    this.meter = { an, buf: new Float32Array(2048), peak: 0 };
  }
  _readMeter() {
    const m = this.meter;
    m.an.getFloatTimeDomainData(m.buf);
    for (let i = 0; i < m.buf.length; i++) m.peak = Math.max(m.peak, Math.abs(m.buf[i]));
  }
  stats() {
    return {
      on: this.on, state: this.ctx?.state ?? 'none', world: this.world, profile: this.profile?.def.id ?? null,
      events: this.liveEvents(), fading: this.events.length - this.liveEvents(), nodes: this.nodes,
      loop: this.loop ? +this.loop.g.gain.value.toFixed(4) : null, peak: this.meter?.peak ?? null, mix: this.mix,
    };
  }
}

// an envelope as a curve: raised-cosine rise over a, hold h, then a decay
// that eases out to exactly zero over d (no step, no click at either end)
const K = 4.5, EK = Math.exp(-K);
export function envCurve(a, h, d, peak = 1) {
  const T = a + h + d;
  const n = Math.max(24, Math.min(256, Math.ceil(T / 0.004)));
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * T;
    let v;
    if (t < a) v = 0.5 - 0.5 * Math.cos(Math.PI * t / a);
    else if (t < a + h) v = 1;
    else { const x = (t - a - h) / d; v = (Math.exp(-K * x) - EK) / (1 - EK); }
    c[i] = v * peak;
  }
  c[n - 1] = 0;
  return c;
}

function readPref() {
  try { return localStorage.getItem(STORE) !== '0'; } catch { return true; }
}
function readMix() {
  try {
    const m = JSON.parse(localStorage.getItem(STORE_MIX) || 'null');
    if (m && typeof m === 'object') {
      const out = { ...MIX_DEFAULT };
      for (const k of Object.keys(MIX_DEFAULT)) if (Number.isFinite(m[k])) out[k] = m[k];
      out.vol = Math.min(100, Math.max(0, out.vol));
      for (const k of ['low', 'mid', 'high']) out[k] = Math.min(12, Math.max(-12, out[k]));
      return out;
    }
  } catch { /* unreadable: defaults */ }
  return { ...MIX_DEFAULT };
}

// --- Cloud: soft + airy ---------------------------------------------------------------
// Two parts in every sound:
//   BODY — soft low-mid puff and cotton fibre, 200 Hz–2 kHz, rising over
//          20–50 ms (no hard front anywhere)
//   AIR  — a quiet, diffuse fibre shimmer, ~4–8 kHz, that rises slower
//          still (50–80 ms) and lingers: space and loose fibre, not hiss
// The air is never the loudest part and never arrives first: that was the
// "firework" (white noise whose highs came in 18 ms). A harder hit gets more
// body and a little more displaced air — not a brighter tone.

const AIR = { buf: 'fibre', hp: 3800, lp: 9000 };

const cloudProfile = {
  id: 'cloud',
  level: 1,
  impactMin: 0.45,
  // selective, not a blanket: a touch of warmth, the upper mids held a
  // little (where a hiss would sit), only the very top eased
  eq: [
    { type: 'lowshelf', f: 220, gain: 1 },
    { type: 'peaking', f: 2500, q: 1.4, gain: -2 },
    { type: 'highshelf', f: 9500, gain: -2 },
  ],
  loop: { buf: 'cotton', hp: 150, lp: 900, air: AIR },
  // → [gain, low-pass, rate, air]: tension brings more fibre and a little
  // more air, never a hiss (the low-pass moves little, the air stays small).
  // Only an ATTACHED piece under strain has this friction: a detached piece
  // carried, moved or turned in the air is silent (the fibre texture tied to
  // its speed read as shuffling). Fast motion gets at most a faint swish.
  loopLevel(tension) {
    if (tension > 0) return [0.085 * tension ** 1.6, 900 + 600 * tension, 0.96 + 0.06 * tension, 0.18 + 0.22 * tension];
    return [0, 0, 0, 0];
  },
  // a detached piece swept fast through the air: one faint, smooth breath
  // (pink noise, no grain) when the hand passes this speed, then a rest
  swish: { speed: 7, cooldown: 0.8 },
  play(A, kind, p, P) {
    const size = clamp01((p.size ?? 1) / 1.4);
    switch (kind) {
      case 'grab':
        // a loose piece taken in the hand: barely a touch
        return A.event({ prio: PRIO.MINOR }, [
          { buf: 'pink', hp: 200, lp: 1000, env: { a: 0.03, d: 0.1 }, gain: 0.08 },
        ], P);
      case 'swish':
        return A.event({ prio: PRIO.MINOR, pos: p.pos }, [
          { buf: 'pink', hp: 500, lp: 2200, env: { a: 0.09, d: 0.3 }, gain: 0.05 * p.k },
        ], P);
      case 'pretear':
        // a whisper of strain
        return A.event({ prio: PRIO.TENSION, pos: p.pos }, [
          { buf: 'cotton', hp: 180, lp: 1400, env: { a: 0.12, h: 0.05, d: 0.2 }, gain: 0.3 },
          { ...AIR, env: { a: 0.14, h: 0.04, d: 0.22 }, gain: 0.06 },
        ], P);
      case 'tear': {
        // BODY "whuff": fibre parting (cotton, band closing from 2.2 kHz to
        // 1 kHz), a warm puff of displaced air under it, some breath
        // AIR: a soft fibre shimmer, slower than the body, fading long
        const k = (0.75 + 0.35 * size) * 0.5;
        return A.event({ prio: PRIO.TEAR, pos: p.pos, gain: k }, [
          { buf: 'cotton', hp: 180, lp: [2200, 1000, 0.4], env: { a: 0.035 + 0.012 * size, h: 0.03, d: 0.33 + 0.12 * size }, gain: 1.3 },
          { buf: 'brown', hp: 120, lp: 380, lp2: true, env: { a: 0.028, h: 0.02, d: 0.28 + 0.08 * size }, gain: 0.45 },
          { buf: 'pink', hp: 300, lp: 3000, env: { a: 0.05, d: 0.36 }, gain: 0.25, at: 0.015 },
          { ...AIR, lp: [9000, 4500, 0.35], env: { a: 0.065, h: 0.04, d: 0.3 + 0.08 * size }, gain: 0.4, at: 0.015 },
        ], P);
      }
      case 'tear2':
        // a second piece let go in the same moment: a small soft poof
        return A.event({ prio: PRIO.DEBRIS, pos: p.pos, gain: 0.3 }, [
          { buf: 'brown', hp: 100, lp: 400, lp2: true, env: { a: 0.04, d: 0.25 }, gain: 0.6 },
          { buf: 'cotton', hp: 180, lp: 1400, env: { a: 0.045, d: 0.22 }, gain: 0.7 },
          { ...AIR, env: { a: 0.07, d: 0.3 }, gain: 0.14 },
        ], P);
      case 'impact': {
        // a muted puff: body compression, then a little displaced air as a
        // soft tail. Harder = more body and a bit more air — not brighter.
        const s = clamp01((p.speed - 0.45) / 5);
        const m = clamp01(p.mass);
        const minor = p.speed < 1;
        const k = (0.14 + 0.35 * s) * (0.7 + 0.3 * m) * (p.kind === 'piece' ? 0.8 : 1) * (p.gainK ?? 1);
        return A.event({ prio: minor ? PRIO.MINOR : PRIO.IMPACT, pos: p.pos, gain: k }, [
          { buf: 'brown', hp: 80, lp: 450 - 80 * s, lp2: true, env: { a: 0.016 + 0.006 * s, h: 0.01, d: 0.16 + 0.16 * s + 0.06 * m }, gain: 0.8 },
          { buf: 'cotton', hp: 180, lp: 1300 - 200 * s, env: { a: 0.02, d: 0.12 + 0.1 * s }, gain: minor ? 0.35 : 0.55 + 0.3 * s },
          { ...AIR, env: { a: 0.05, d: 0.25 + 0.15 * s }, gain: 0.14 + 0.1 * s, at: 0.02 },
        ], P);
      }
      case 'throw':
        // let go fast: a smooth breath of air, no fibre
        return A.event({ prio: PRIO.MINOR, pos: p.pos }, [
          { buf: 'pink', hp: 400, lp: [1800, 900, 0.3], env: { a: 0.06, d: 0.28 }, gain: 0.07 * clamp01(p.speed / 8) },
        ], P);
      case 'settle':
        // barely there: an exhale
        return A.event({ prio: PRIO.MINOR, pos: p.pos }, [
          { buf: 'cotton', hp: 120, lp: 800, env: { a: 0.06, d: 0.2 }, gain: 0.12 },
          { ...AIR, env: { a: 0.08, d: 0.25 }, gain: 0.025 },
        ], P);
      case 'return':
        // drawn back in: a slow soft draw of air, fibre gathering
        if (!claimReturn(A, p.delay)) return null;
        return A.event({ prio: PRIO.RETURN, pos: p.pos, at: p.delay }, [
          { buf: 'cotton', hp: 150, lp: [500, 1200, 1.2], env: { a: 0.95, h: 0.05, d: 0.3 }, gain: 0.24 },
          { ...AIR, env: { a: 1.0, d: 0.3 }, gain: 0.09 },
        ], P);
      case 'absorb':
        // fibre joins fibre
        return A.event({ prio: PRIO.RETURN, pos: p.pos, gain: (p.soft ? 0.55 : 1) * (0.7 + 0.3 * size) }, [
          { buf: 'brown', hp: 80, lp: 400, lp2: true, env: { a: 0.022, d: 0.22 }, gain: 0.4 },
          { buf: 'cotton', hp: 160, lp: 1300, env: { a: 0.03, d: 0.16 }, gain: 0.28 },
          { ...AIR, env: { a: 0.05, d: 0.25 }, gain: 0.1, at: 0.01 },
        ], P);
      default:
        return null;
    }
  },
};

// a Reassemble of many pieces: at most three flight sounds overlap (by their
// scheduled starts); every piece still lands with its own absorb
export function claimReturn(A, delay = 0) {
  const start = A.t + delay;
  A._returns = (A._returns || []).filter((t) => t > A.t - 2);
  if (A._returns.filter((t) => Math.abs(t - start) < 0.6).length >= 3) return false;
  A._returns.push(start);
  return true;
}

export { rnd, clamp01, grains, onePoleLP, onePoleHP, normalize, toBuffer, pinkArray };
