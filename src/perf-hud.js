// QA overlay, only with ?perf (its own lazy chunk; nobody else loads it).
// Live numbers, tier buttons, a scripted benchmark and a plain-text report
// for copying. Nothing is sent anywhere: the report goes to the clipboard
// (or a text box to copy from by hand).

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));
const TIER_ORDER = ['ultra', 'high', 'medium', 'low', 'safe'];

function q(a, p) {
  if (!a.length) return -1;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
const f1 = (x) => (x < 0 ? '—' : x.toFixed(1));
const mtri = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

// the real frames of `sec` seconds: intervals, loop CPU, GPU where known
async function measure(ch, sec) {
  const Q = ch.quality;
  const iv = [], cpu = [], gpu = [];
  let calls = 0, tris = 0, last = performance.now();
  const t0 = last;
  let lastGpu = -1;
  while (performance.now() - t0 < sec * 1000) {
    await frame();
    const n = performance.now();
    iv.push(n - last); last = n;
    cpu.push(Q.cpuMs);
    if (Q.gpuMs >= 0 && Q.gpuMs !== lastGpu) { gpu.push(Q.gpuMs); lastGpu = Q.gpuMs; }
    calls = ch.renderer.info.render.calls; tris = ch.renderer.info.render.triangles;
  }
  iv.shift();
  return { med: q(iv, 0.5), p95: q(iv, 0.95), cpu: q(cpu, 0.5), gpu: q(gpu, 0.5), calls, tris };
}

async function toWorld(ch, id) {
  if (ch.worlds.active?.id === id) return;
  const t0 = performance.now();
  document.querySelector(`[data-world="${id}"]`)?.click();
  while (ch.worlds.active?.id !== id && performance.now() - t0 < 30000) await wait(30);
  while (ch.house.body.morph && performance.now() - t0 < 30000) await wait(50);
  await wait(900);
}

// tear n outer clumps that face the camera (the same motion a hand makes)
async function tearN(ch, n) {
  const T = ch.tearing, THREE = ch.THREE, cont = ch.house.container;
  const cam = ch.camera.position.clone(); cont.worldToLocal(cam);
  const used = new Set(T.pieces.map((p) => p.clumpId));
  const cand = ch.CLUMPS.filter((c) => c.layer === 0 && !used.has(c.id) && c.c[1] > 1.2).map((c) => {
    const v = new THREE.Vector3(...c.c); const out = new THREE.Vector3(v.x, 0, v.z).normalize();
    return { c, v, out, s: out.dot(cam.clone().sub(v).normalize()) };
  }).sort((a, b) => b.s - a.s);
  let done = 0;
  for (const { c, v, out } of cand) {
    if (done >= n) break;
    const wp = cont.localToWorld(v.clone().addScaledVector(out, c.rad * 0.35));
    if (!T.begin(wp, out.clone())) continue;
    let torn = false, k = 0;
    while (!torn && k < 300) { await frame(); k++; torn = T.drag(wp.clone().addScaledVector(out, Math.min(k * 0.04, 3))); }
    if (!torn) { T.cancel(); continue; }
    T.tear(out.clone().multiplyScalar(2));
    done++;
    await frame();
  }
  return done;
}

async function home(ch) {
  if (ch.tearing.freeCount()) ch.tearing.reassemble();
  if (ch.story.scene !== 'house') ch.story.go('house');
  await wait(2600);
}

function profileLine(ch) {
  const p = ch.perf();
  return `render ${p.buffer} (ratio ${p.dpr.toFixed(2)}) · MSAA ${p.post.msaa || 'off'} · bloom ${p.post.bloom ? (p.post.bloom < 1 ? 'half-res' : 'on') : 'off'} · depth blur ${p.post.dofRest ? `${p.post.dofTaps} taps` : 'arrival only'} · cotton ${p.shells.cotton} · blades ≤${p.shells.cap} (pieces ≤${p.shells.pieceCap}) · sun shadow ${p.shadow.map}px/${p.shadow.hz}Hz · contact ${p.shadow.contactRes}px`;
}

const row = (name, m, extra = '') => `  ${name.padEnd(18)} median ${f1(m.med).padStart(5)} ms  p95 ${f1(m.p95).padStart(5)}  (${m.med > 0 ? Math.round(1000 / m.med) : '—'} fps)  cpu ${f1(m.cpu)}  gpu ${f1(m.gpu)}  calls ${m.calls}  tris ${mtri(m.tris)}${extra}`;

// one tier through the scenes of the brief
async function benchTier(ch, tier, log) {
  const out = [];
  if (tier) ch.quality.force(tier);
  await home(ch);
  await toWorld(ch, 'cloud');
  await wait(800);
  out.push(`[${ch.quality.tier}] ${profileLine(ch)}`);
  log(`${ch.quality.tier}: cloud`);
  out.push(row('Cloud', await measure(ch, 3)));
  // the first time the turf world is built (module, soil bake, programs)
  const cold = !ch.worlds.isLoaded('grass');
  let gap = 0, lastT = performance.now(), on = true;
  const watch = () => { const n = performance.now(); gap = Math.max(gap, n - lastT); lastT = n; if (on) requestAnimationFrame(watch); };
  requestAnimationFrame(watch);
  const tg = performance.now();
  await toWorld(ch, 'grass');
  on = false;
  if (cold) out.push(`  Grass first activation: ${Math.round(performance.now() - tg - 900)} ms to active, longest frame ${Math.round(gap)} ms`);
  log(`${ch.quality.tier}: grass`);
  const g = await measure(ch, 3);
  const fz = ch.fuzzLodState();
  out.push(row('Grass', g, `  shells ${fz.body}`));
  log(`${ch.quality.tier}: tearing 10 sods`);
  await tearN(ch, 10);
  await wait(300);
  out.push(row('Grass + 10 moving', await measure(ch, 3)));
  await wait(6000);
  const pc = ch.perf();
  out.push(row('Grass + 10 still', await measure(ch, 3), `  (${pc.sleeping}/${pc.pieces} asleep)`));
  await home(ch);
  return out;
}

export function mountPerfHud(ch) {
  const Q = ch.quality;
  const box = document.createElement('div');
  box.className = 'perf-hud';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Performance (QA)');
  box.innerHTML = `
    <style>
      .perf-hud{position:fixed;left:12px;top:72px;z-index:9999;width:min(360px,calc(100vw - 24px));padding:10px 12px;border-radius:10px;
        background:rgba(24,22,20,.86);color:#f3efe9;font:11px/1.45 ui-monospace,Consolas,monospace;box-shadow:0 4px 18px rgba(0,0,0,.25)}
      .perf-hud pre{margin:0;white-space:pre-wrap}
      .perf-hud .row{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
      .perf-hud button{font:inherit;color:inherit;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:4px 7px;cursor:pointer;min-height:28px}
      .perf-hud button[aria-pressed=true]{background:#f3efe9;color:#181614}
      .perf-hud textarea{width:100%;height:160px;margin-top:8px;font:inherit;background:#0e0d0c;color:#f3efe9;border:1px solid rgba(255,255,255,.2);border-radius:6px;display:none}
      .perf-hud .x{position:absolute;right:6px;top:4px;min-height:0;padding:0 6px;background:none;border:0}
    </style>
    <button class="x" aria-label="Hide">×</button>
    <pre class="live">…</pre>
    <div class="row tiers"></div>
    <div class="row">
      <button data-a="bench">Benchmark this tier (~40 s)</button>
      <button data-a="all">All tiers (~3 min)</button>
      <button data-a="copy">Copy performance report</button>
    </div>
    <pre class="state"></pre>
    <textarea readonly aria-label="Report"></textarea>`;
  document.body.appendChild(box);
  const live = box.querySelector('.live'), state = box.querySelector('.state'), ta = box.querySelector('textarea');
  box.querySelector('.x').onclick = () => box.remove();

  const tiersRow = box.querySelector('.tiers');
  const url = new URL(location.href);
  const cur = url.searchParams.get('quality') || 'auto';
  for (const t of ['auto', ...TIER_ORDER]) {
    const b = document.createElement('button');
    b.textContent = t;
    b.setAttribute('aria-pressed', String(t === cur));
    b.onclick = () => { url.searchParams.set('quality', t); url.searchParams.set('perf', ''); location.href = url.toString(); };
    tiersRow.appendChild(b);
  }

  // live numbers, twice a second
  const iv = [];
  let last = performance.now();
  const tick = () => {
    const n = performance.now(); iv.push(n - last); last = n;
    if (iv.length > 120) iv.shift();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setInterval(() => {
    const p = ch.perf();
    const med = q(iv, 0.5), p95 = q(iv, 0.95);
    live.textContent = [
      `${Math.round(1000 / med)} fps   median ${f1(med)} ms   p95 ${f1(p95)} ms`,
      `tier ${p.tier}${p.auto ? ' (auto)' : ' (fixed)'} — ${p.reason}`,
      `cpu ${f1(p.cpuMs)} ms   gpu ${p.gpuMs == null ? 'n/a' : f1(p.gpuMs)} ms`,
      `ratio ${p.dpr.toFixed(2)}   buffer ${p.buffer}`,
      `calls ${p.calls}   triangles ${mtri(p.triangles)}`,
      `shells: cotton ${p.shells.cotton}, blades ${p.shells.body} (cap ${p.shells.cap}, pieces ${p.shells.pieceCap})`,
      `msaa ${p.post.msaa}   bloom ${p.post.bloom || 'off'}   shadow ${p.shadow.map}px`,
      `pieces ${p.pieces}   free ${p.free}   asleep ${p.sleeping}`,
    ].join('\n');
  }, 500);

  let results = [];
  const header = () => {
    const p = ch.perf();
    const gl = ch.renderer.getContext();
    const ua = navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(', ') || navigator.userAgent;
    return [
      `Cloud House — performance report (${new Date().toLocaleString()})`,
      `GPU: ${p.gpu}`,
      `browser: ${ua}`,
      `platform: ${navigator.userAgentData?.platform || navigator.platform}, cores ${navigator.hardwareConcurrency || '?'}, memory ${navigator.deviceMemory ? `${navigator.deviceMemory} GB` : '?'}`,
      `viewport: ${innerWidth}×${innerHeight} CSS, devicePixelRatio ${devicePixelRatio}, screen ${screen.width}×${screen.height}`,
      `tier: ${p.tier} (${p.auto ? 'auto' : 'fixed'}; ${p.reason}); started ${p.start}; first guess ${p.guess} — ${p.guessWhy}`,
      `tier history: ${p.history.map((h) => `${h.t}s ${h.tier}`).join(' → ')}`,
      `render: ${gl.drawingBufferWidth}×${gl.drawingBufferHeight} (ratio ${p.dpr.toFixed(2)}); GPU timer ${p.gpuMs == null ? 'not available' : 'available'}`,
    ].join('\n');
  };
  const report = () => [header(), '', ...results].join('\n');
  const log = (s) => { state.textContent = s; };

  async function run(tiers) {
    const was = { auto: Q.auto, tier: Q.tier };
    Q.auto = false;
    results = [];
    try {
      for (const t of tiers) results.push(...(await benchTier(ch, t, log)), '');
    } finally {
      Q.auto = was.auto;
      if (Q.tier !== was.tier) Q.force(was.tier);
    }
    log('done — press Copy performance report');
  }
  let busy = false;
  box.addEventListener('click', async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a || busy) return;
    if (a === 'copy') {
      const text = report();
      ta.value = text; ta.style.display = 'block';
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch { /* not a secure page */ }
      if (!ok) { ta.select(); try { ok = document.execCommand('copy'); } catch { /* none */ } }
      log(ok ? 'copied to clipboard' : 'select the text below and copy it');
      return;
    }
    busy = true;
    try { await run(a === 'all' ? TIER_ORDER : [null]); } catch (err) { log(`failed: ${err.message}`); } finally { busy = false; }
  });
}
