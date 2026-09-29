import { PRIO, claimReturn, rnd, clamp01, grains, onePoleLP, onePoleHP, normalize, toBuffer, pinkArray } from './audio.js';

// Grass: heavy + textured. Fetched with the Grass world; its textures are
// made the first time it plays.
//
// No oscillators and no narrow resonant filters: a pitched thump and a
// Q-6 band were what made earth sound like metal ("tonk"). Weight comes
// from band-limited brown noise, the soil body from a broad noise band, and
// the texture — dirt, dry crumb, roots, blades — from soft-edged grains
// that keep their upper mids and highs (1.5–7 kHz), only quietly. A harder
// landing is louder, lower, longer and crumbles more — never higher.

// soil: grains with a soft rise and a short decay — crumb, not clicks
function soilTexture(ctx, density) {
  const sr = ctx.sampleRate, n = Math.round(sr * 2);
  const src = pinkArray(sr);
  // a little brown body in every grain
  let y = 0;
  for (let i = 0; i < src.length; i++) { y = y * 0.97 + src[i] * 0.3; src[i] = src[i] * 0.5 + y; }
  // (the soft rise of each grain keeps it from clicking; the band is left
  // open so the grit survives — layers choose what they use)
  const d = grains(n, sr, { density, len: [0.004, 0.016], src, shape: 'tap', rise: [0.0006, 0.0015], amp: 2 });
  onePoleLP(d, 9000, sr);
  onePoleHP(d, 60, sr);
  normalize(d, 0.85);
  return toBuffer(ctx, d);
}
// grit: dry crumb and dirt — short white-noise grains with a soft rise, the
// detail layer of every earth sound (1.5–5 kHz where it is used)
function gritTexture(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * 2);
  const src = new Float32Array(sr).map(() => Math.random() * 2 - 1);
  // (dense and even: no single grain stands out as a click)
  const d = grains(n, sr, { density: 650, len: [0.003, 0.01], src, shape: 'tap', rise: [0.0006, 0.0014], amp: 1.2 });
  onePoleHP(d, 700, sr);
  onePoleLP(d, 9000, sr);
  normalize(d, 0.85);
  return toBuffer(ctx, d);
}
// blades: dry, soft, higher than the soil but band-limited
function rustleTexture(ctx) {
  const sr = ctx.sampleRate, n = Math.round(sr * 2);
  const src = new Float32Array(sr).map(() => Math.random() * 2 - 1);
  // (dense and even: a soft scatter of blades, no single tick standing out)
  const d = grains(n, sr, { density: 420, len: [0.003, 0.01], src, shape: 'tap', rise: [0.0006, 0.0012], amp: 1.2 });
  onePoleHP(d, 600, sr);
  onePoleLP(d, 11000, sr);
  normalize(d, 0.8);
  return toBuffer(ctx, d);
}

// the loudest a clod may land (event gain): even the hardest normal fall is
// no louder than about a tear
const IMPACT_CEIL = 0.62;

export default {
  id: 'grass',
  level: 1.12,
  impactMin: 0.5,
  // more low-mid body; the top only eased a little. No blind cut in the
  // upper mids: the lab (qa/audio-lab.js, peak3) finds no narrow peaks there
  // now that the sources are pure noise and grain.
  eq: [
    { type: 'lowshelf', f: 160, gain: 2 },
    { type: 'peaking', f: 380, q: 0.8, gain: 1.5 },
    { type: 'highshelf', f: 8000, gain: -2 },
  ],
  init(A) {
    A.buffer('soilSparse', (ctx) => soilTexture(ctx, 60));
    A.buffer('soilMid', (ctx) => soilTexture(ctx, 260));
    A.buffer('soilDense', (ctx) => soilTexture(ctx, 1100));
    A.buffer('rustle', rustleTexture);
    A.buffer('grit', gritTexture);
    this._creak = 0;
  },
  // the held loop: blades rustling, and under it (the second texture) the
  // turf's grit straining, which grows with the pull
  loop: { buf: 'rustle', hp: 900, lp: 5500, air: { buf: 'soilDense', hp: 500, lp: 3000 } },
  // pulled: the rustle sinks from the blades into the turf; carried: the
  // clod's grass brushes the air. Always quiet.
  loopLevel(tension, move) {
    if (tension > 0) return [0.08 * tension ** 1.4, 5500 - 2200 * tension, 1, 0.3 + 0.6 * tension];
    if (move > 0.3) { const s = clamp01(move / 7) ** 1.2; return [0.045 * s, 5000, 0.95 + 0.1 * s, 0.1]; }
    return [0, 0, 0, 0];
  },
  // roots strain now and then while the sod is pulled (irregularly)
  strain(A, dt, tension, pull, P) {
    this._creak -= dt;
    if (tension < 0.6 || this._creak > 0) return;
    this._creak = rnd(0.16, 0.4) * (1.3 - tension * 0.5);
    this.play(A, 'creak', { tension }, P);
  },
  play(A, kind, p, P) {
    const size = clamp01((p.size ?? 1) / 1.4);
    switch (kind) {
      case 'grab':
        // a loose clod taken in the hand: a dull soft touch of earth, the
        // blades only a trace (a bright rustle here read as sharp)
        return A.event({ prio: PRIO.MINOR, pos: p.pos }, [
          { buf: 'soilMid', hp: 150, lp: 1100, env: { a: 0.025, d: 0.11 }, gain: 0.16 },
          { buf: 'rustle', hp: 1500, lp: 3500, env: { a: 0.04, d: 0.12 }, gain: 0.04 },
        ], P);
      case 'creak':
        // fibrous roots stretching: dense soil grains, slowed, in a broad
        // band (never narrow: no pitch); never two on top of each other
        if (A.t - (this._lastCreak ?? -9) < 0.14) return null;
        this._lastCreak = A.t;
        return A.event({ prio: PRIO.TENSION }, [
          { buf: 'soilDense', rate: rnd(0.55, 0.8), hp: 300, lp: 1500, env: { a: 0.02, h: 0.04, d: 0.09 }, gain: 0.22 * (0.6 + 0.4 * p.tension) },
        ], P);
      case 'pretear':
        // the first strong strain; the next ones wait their turn
        this._creak = rnd(0.16, 0.3);
        return this.play(A, 'creak', { tension: 1.1 }, P);
      case 'tear': {
        // three layers, each audible, mixed quietly:
        //   1 grass rustle  — blades, 3–7 kHz, soft and scattered
        //   2 root rupture  — the turf gives (grit + a low body), one or two
        //                     short dry snaps that stay under the rest
        //   3 soil crumble  — broad granular mid/high, running on
        const k = (0.75 + 0.35 * size) * 0.8;
        const snaps = Math.random() < 0.5 ? 1 : 2;
        return A.event({ prio: PRIO.TEAR, pos: p.pos, gain: k }, [
          { buf: 'rustle', hp: 2800, lp: 7000, env: { a: 0.025, h: 0.05, d: 0.26 }, gain: 0.38 },
          { buf: 'soilDense', hp: 150, lp: 2000, env: { a: 0.01, h: 0.05, d: 0.22 }, gain: 0.75 },
          { buf: 'brown', hp: 60, lp: 230, env: { a: 0.009, h: 0.01, d: 0.16 }, gain: 0.55 },
          { buf: 'soilMid', hp: 400, lp: 1800, env: { a: 0.004, d: 0.03 }, gain: 0.14, at: rnd(0.02, 0.05) },
          snaps > 1 ? { buf: 'soilMid', hp: 400, lp: 1700, env: { a: 0.004, d: 0.026 }, gain: 0.09, at: rnd(0.06, 0.1) } : null,
          { buf: 'soilMid', hp: 300, lp: 5000, env: { a: 0.03, h: 0.08, d: 0.45 }, gain: 0.55, at: 0.05 },
          { buf: 'grit', hp: 1500, lp: 5500, env: { a: 0.03, h: 0.06, d: 0.4 }, gain: 0.12, at: 0.06 },
        ], P);
      }
      case 'tear2':
        // another sod in the same moment: its rupture and crumble, quieter, no snaps
        return A.event({ prio: PRIO.DEBRIS, pos: p.pos, gain: 0.4 }, [
          { buf: 'soilDense', hp: 150, lp: 1800, env: { a: 0.012, h: 0.04, d: 0.2 }, gain: 0.8 },
          { buf: 'soilMid', hp: 300, lp: 4000, env: { a: 0.03, h: 0.05, d: 0.3 }, gain: 0.45, at: 0.04 },
        ], P);
      case 'debris': {
        // grains landing: one to four short dull taps across ~70 ms, each its
        // own grain, filter, speed and level; a little grit, no ticks
        const taps = Math.min(4, 1 + Math.floor(Math.log2(1 + p.n)));
        const g = 0.2 + 0.32 * clamp01(p.v / 5);
        const layers = [];
        for (let i = 0; i < taps; i++) {
          layers.push({
            buf: Math.random() < 0.3 ? 'brown' : Math.random() < 0.5 ? 'grit' : 'soilSparse', rate: rnd(0.8, 1.2), hp: 150, lp: rnd(1200, 3000),
            env: { a: rnd(0.003, 0.006), d: rnd(0.025, 0.06) }, gain: rnd(0.5, 1), at: rnd(0, 0.07),
          });
        }
        return A.event({ prio: PRIO.DEBRIS, pos: p.pos, gain: g }, layers, P);
      }
      case 'impact': {
        // an earth clod lands:
        //   low body  — brown noise, ~80–220 Hz, a short muffled thump
        //   soil body — a broad band, ~250 Hz–1.5 kHz
        //   texture   — soft grains, ~1.5–5 kHz: dirt, dry crumb, roots, blades
        //   crumble   — more of it, longer, for a harder landing
        // Loudness follows a compressed curve with a ceiling (small = very
        // quiet, medium = a clear earthy thud, strong = only a little louder
        // than medium); the strength is heard as weight instead: more low
        // body, a longer decay, more crumble.
        // (speeds from the physics: a low drop lands at ~2.5 m/s, a fall
        // from about a metre at ~5, a hard throw at 9 and more)
        const v = p.speed;
        const s = clamp01((v - 1.5) / 8) ** 0.9;
        const m = clamp01(p.mass);
        const onPiece = p.kind === 'piece';
        const minor = v < 1.2;
        const curve = 0.05 + 0.6 * (1 - Math.exp(-((Math.max(0, v - 0.4) / 3.2) ** 1.8)));
        const level = Math.min(IMPACT_CEIL, curve) * (0.85 + 0.15 * m) * (p.gainK ?? 1);
        return A.event({ prio: minor ? PRIO.MINOR : PRIO.IMPACT, pos: p.pos, gain: level }, [
          { buf: 'brown', hp: 70, lp: 230 - 30 * m, env: { a: 0.006, h: 0.01, d: 0.11 + 0.1 * s + 0.05 * m }, gain: (onPiece ? 0.55 : 0.9) * (0.8 + 0.25 * s) },
          { buf: 'pink', hp: 250, lp: 1500, env: { a: 0.007, h: 0.01, d: 0.11 + 0.1 * s }, gain: onPiece ? 0.7 : 0.6 },
          { buf: 'grit', hp: 1500, lp: 5000, env: { a: 0.008, h: 0.01, d: 0.1 + 0.15 * s }, gain: 0.3 + 0.1 * s, at: 0.006 },
          minor ? null : { buf: 'soilMid', hp: 300, lp: 3500, env: { a: 0.02, h: 0.02, d: 0.18 + 0.3 * s }, gain: 0.2 + 0.4 * s, at: 0.02 },
        ], P);
      }
      case 'throw':
        return A.event({ prio: PRIO.MINOR, pos: p.pos }, [
          { buf: 'rustle', hp: 1500, lp: [5000, 3000, 0.25], env: { a: 0.03, d: 0.22 }, gain: 0.18 * clamp01(p.speed / 8) },
        ], P);
      case 'settle':
        return A.event({ prio: PRIO.MINOR, pos: p.pos }, [
          { buf: 'soilSparse', hp: 200, lp: 2500, env: { a: 0.02, h: 0.04, d: 0.16 }, gain: 0.25 },
        ], P);
      case 'return':
        // earth sliding back
        if (!claimReturn(A, p.delay)) return null;
        return A.event({ prio: PRIO.RETURN, pos: p.pos, at: p.delay + 0.25 }, [
          { buf: 'soilDense', hp: 200, lp: [2500, 1400, 0.9], env: { a: 0.35, h: 0.2, d: 0.5 }, gain: 0.26 },
          { buf: 'grit', hp: 1500, lp: 4500, env: { a: 0.4, h: 0.15, d: 0.5 }, gain: 0.05 },
        ], P);
      case 'absorb':
        // packed back in: a low knock and a short crumble
        return A.event({ prio: PRIO.RETURN, pos: p.pos, gain: p.soft ? 0.55 : 1 }, [
          { buf: 'brown', hp: 60, lp: 220, env: { a: 0.006, d: 0.13 }, gain: 0.55 },
          { buf: 'soilMid', hp: 300, lp: 4000, env: { a: 0.01, d: 0.14 }, gain: 0.3 },
          { buf: 'grit', hp: 1500, lp: 5000, env: { a: 0.01, d: 0.12 }, gain: 0.08 },
        ], P);
      default:
        return null;
    }
  },
};
