import './style.css';
import '@fontsource-variable/fraunces/full.css';
import '@fontsource-variable/geist';
import * as THREE from 'three';
import gsap from 'gsap';
import { House, makePart } from './house/house.js';
import { Tearing } from './house/tearing.js';
import { makeFluffMaterial, attachFluff, detachFluff, fluffShellCount, setFuzzLayers as setFluffLayers, setFuzzSolid as setFluffSolid, setFuzzLod as setFluffLod, setFuzzCap, updateFuzzLod, fuzzLodState } from './render/fluff.js';
import { SPEC, FLOAT, CLUMPS, clumpAt, bodyFs, SUN_DIR as SDF_SUN } from './house/sdf.js';
import { createAtmosphere, buildEnvironment, createBackground, createContactShadow, createFloor, createShadowCatcher } from './render/stage.js';
import { createPost } from './render/post.js';
import { PaintVolume, PaintManager, PAINT_COLORS } from './render/paint.js';
import { FlowerField } from './render/flowers.js';
import { Worlds, WORLDS } from './modes/index.js';
import { CameraRig } from './camera.js';
import { Cursor } from './cursor.js';
import { Interaction } from './interaction.js';
import { Story, POSES, SCENES, MATERIALS } from './story.js';
import { UI } from './ui.js';
import { MaterialAudio } from './audio/audio.js';
import { Quality, PROFILES, TIERS } from './quality.js';

const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------
// when the house cannot be drawn: a still of it and what to do, instead of an
// empty milk screen. 'nogl' — no WebGL 2 here; 'error' — building it failed.

let introDone = false;
function fail(kind, err) {
  if (err) console.error('[cloud-house]', err);
  if (document.body.dataset.fail) return;
  document.body.dataset.fail = kind;
  document.body.classList.remove('is-loading');
  document.querySelector('.nogl').hidden = false;
}
// setting up the scene below runs once, synchronously: an error in it leaves
// nothing to draw. (Removed before boot, whose own failure is caught there;
// a stray error later must never hide a house that works.)
const onSetupError = (e) => fail('error', e.error || e.message);
addEventListener('error', onSetupError);

// ---------------------------------------------------------------------------
// renderer

const canvas = document.querySelector('#gl');
const renderer = (() => {
  // three needs WebGL 2; ?nogl shows the fallback on purpose (for checking it)
  const gl2 = !params.has('nogl') && (() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
  if (!gl2) { fail('nogl'); throw new Error('WebGL 2 is not available'); }
  try {
    return new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  } catch (err) { fail('nogl', err); throw err; }
})();
// a driver reset: three asks for the context back; if it never returns, say so
{
  let lostTimer = 0;
  canvas.addEventListener('webglcontextlost', () => { lostTimer = setTimeout(() => fail('error', 'WebGL context lost'), 4000); });
  canvas.addEventListener('webglcontextrestored', () => clearTimeout(lostTimer));
}
// in a build, three does not read the shader logs after linking: reading them
// makes the main thread wait for the driver (hundreds of ms on the first
// frames); in development they stay on for error reports
renderer.debug.checkShaderErrors = !import.meta.env.PROD;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.12;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
// the sun's shadow is drawn when something that casts it moved (see loop)
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

// quality tier (quality.js): a first guess now, then frame time decides.
// ?quality=ultra|high|medium|low|safe fixes it; auto (default) adapts;
// ?noadapt keeps the first guess; ?low is the old switch for low
const Q = new Quality({
  gl: renderer.getContext(),
  param: params.get('quality') || (params.has('low') ? 'low' : null),
  apply: (p, tier) => applyQuality(p, tier),
});
if (params.has('noadapt')) Q.auto = false;
const BOOT_TIER = Q.tier;
const LIGHT_BOOT = TIERS.indexOf(BOOT_TIER) <= TIERS.indexOf('low');
// never softer than one pixel per CSS pixel: a tier caps a dense screen's
// ratio, it does not blur a plain one
const tierDpr = (p) => Math.min(devicePixelRatio, Math.max(p.dpr, 1));
let dpr = tierDpr(Q.profile);
renderer.setPixelRatio(dpr);
renderer.setSize(innerWidth, innerHeight, false);
document.body.classList.toggle('is-low', !Q.profile.glass);
document.body.dataset.tier = Q.tier;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 220);

// ---------------------------------------------------------------------------
// weather

const atm = createAtmosphere();
let envRT = buildEnvironment(renderer, atm);
scene.environment = envRT.texture;
scene.environmentIntensity = 0.5;

const background = createBackground(atm);
scene.add(background);

const SUN_DIR = new THREE.Vector3(...SDF_SUN).normalize();
background.material.uniforms.uSunDir.value.copy(SUN_DIR);
const sun = new THREE.DirectionalLight(atm.sunColor, atm.sunIntensity);
sun.position.copy(SUN_DIR).multiplyScalar(24).add(new THREE.Vector3(0, 2, 0));
sun.target.position.set(0.3, 2, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(Q.profile.shadowMap, Q.profile.shadowMap);
const sc = sun.shadow.camera;
sc.left = -10; sc.right = 10; sc.top = 10; sc.bottom = -10; sc.near = 4; sc.far = 50;
sun.shadow.radius = 9;
sun.shadow.blurSamples = Q.profile.shadowBlur;
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight('#d9e3ef', '#efe3d4', 0.18);
scene.add(hemi);

const contact = createContactShadow(renderer, { size: 20, res: Q.profile.contactRes, height: 10, blur: 3.6 });
const floor = createFloor(atm, contact);
scene.add(floor);
const dim = background.material.uniforms.uDim;
floor.material.uniforms.uDim = dim;
scene.add(createShadowCatcher());

// paint laid with the brush stays: a 3D texture in the house frame; a torn
// piece gets its own (see render/paint.js)
const housePaint = new PaintVolume();
const paint = new PaintManager(housePaint);

const shared = {
  uPaint: { value: housePaint.tex },
  uPaintLo: { value: housePaint.lo.clone() },
  uPaintInv: { value: housePaint.inv.clone() },
  uTime: { value: 0 },
  uAoMix: { value: 1 },
  uAoStrength: { value: 1 },
  uSunDirV: { value: new THREE.Vector3() },
  uSunCol: { value: atm.sunColor.clone().multiplyScalar(0.9) },
  uGlowCol: { value: atm.glow },
  uCloudLit: { value: atm.cloudLit },
  uCloudShadow: { value: atm.cloudShadow },
  uCloudRim: { value: atm.cloudRim },
  // dusk lamp light in carved surfaces: 0 room, 1 door, 2 arch, 3.. windows
  uCavGlow: { value: [1, 0.75, 0.85, 0.8, 0.7, 0.85, 0.35, 0] },
  // the quiet room: plaster in daylight / in its own shade
  uRoomLit: { value: new THREE.Color('#f6eee6') },
  uRoomDeep: { value: new THREE.Color('#b8aca6') },
  // inner mouths of the back window, the side window and the tall arch
  uRoomWin: { value: [new THREE.Vector4(0.57, 2.83, -0.95, 1.3), new THREE.Vector4(1.85, 2.82, 0.15, 0.8), new THREE.Vector4(1.2, 2.9, 1.1, 0.6)] },
  uCloudDim: { value: 1 },
  uFuzzScale: { value: 1 },
  uFuzzCut: { value: 0 },
  // blade length on a light tier: fewer shells stand closer together, so
  // the grass becomes a shorter, denser turf instead of stepped tall blades
  uBladeLen: { value: 1 },
  // the finest noise octave of cotton / of blades (a light tier leaves it out)
  uFuzzDetail: { value: new THREE.Vector2(1, 1) },
  // breeze through standing fuzz (xz direction, strength, gust); set by the material world
  uWind: { value: new THREE.Vector4(0.8, 0.45, 0, 0) },
  // depth under the untouched skin (house frame); a world that needs it
  // (turf over soil) bakes it, the default is "at the skin" everywhere
  uOrig: { value: (() => { const t = new THREE.Data3DTexture(new Uint8Array([128]), 1, 1, 1); t.format = THREE.RedFormat; t.needsUpdate = true; return t; })() },
  uOrigLo: { value: new THREE.Vector3(-6, -1.6, -5) },
  uOrigInv: { value: new THREE.Vector3(1 / 12, 1 / 11, 1 / 10) },
};

// ---------------------------------------------------------------------------
// title word living in the scene: cloud geometry passes in front of it

function makeWord(text) {
  const c = document.createElement('canvas');
  c.width = 4096; c.height = 1024;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.font = '300 640px "Fraunces Variable"';
  g.letterSpacing = '-18px';
  g.fillText(text, c.width / 2, 770);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: '#bdb4aa', opacity: 0, toneMapped: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(30, 7.5), mat);
  m.renderOrder = -500;
  return m;
}

// ---------------------------------------------------------------------------
// boot

const cursor = new Cursor();
const rig = new CameraRig(camera);
{
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  rig.reduce = mq.matches;
  mq.addEventListener('change', () => { rig.reduce = mq.matches; });
}
const post = createPost(renderer, scene, camera);
post.setQuality(Q.profile);
PaintVolume.interval = 1 / Q.profile.paintHz;
// draw calls and triangles are counted per frame (all passes), not per render call
renderer.info.autoReset = false;
// sound listens to the physics; silent until the visitor's first gesture
const sound = new MaterialAudio({ camera });
const veil = document.querySelector('.veil');
const topBar = document.querySelector('.top');
const dockScenes = document.querySelector('.scenes');
const dockCtx = document.querySelector('.ctx');

// choreography states are meshed in the background after the first frame
const ready = {};
const readyWait = {};
const readyDone = {};
for (const k of ['noFacade', 'coreOnly']) readyWait[k] = new Promise((r) => { readyDone[k] = () => { ready[k] = true; r(); }; });

let house, interaction, tearing, word, story, ui, roomLight, fluffBody, worlds, flowers;

function rebuildEnv() {
  const next = buildEnvironment(renderer, atm);
  const old = envRT;
  envRT = next;
  scene.environment = next.texture;
  old.dispose();
}

async function boot() {
  // everything the first frame needs starts at once: the title font, the
  // default world's module, the meshing (workers) and the shader programs
  // (compiled in parallel while the workers mesh, so the first frame does
  // not stall on them)
  const fontReady = document.fonts.load('300 200px "Fraunces Variable"').catch(() => {});
  WORLDS[0].load().catch(() => {});
  const t0 = performance.now();
  // (the mesh is built once: a light first tier gets the coarser one)
  house = new House(shared, LIGHT_BOOT ? 0.085 : 0.065);
  // the camera keeps its distance from the cloud surface (house frame)
  rig.clearance = (x, y, z) => bodyFs(x - house.group.position.x, y - house.group.position.y, z - house.group.position.z);
  fluffBody = makeFluffMaterial(house.body, shared);
  house.onBrick = (mesh) => attachFluff(mesh, fluffBody);
  // leave the page and the browser two cores (one on a small CPU)
  const cores = navigator.hardwareConcurrency || 4;
  house.startWorkers(Math.max(1, Math.min(7, cores >= 6 ? cores - 2 : cores - 1)));
  scene.add(house.group);
  // quiet interior light: a warm pendant, soft and short-ranged (added before
  // the programs are built: the light count is part of every program)
  roomLight = new THREE.PointLight(atm.glow, 0, 4.2, 1.6);
  scene.add(roomLight);
  const meshed = house.meshAll('live');
  // never waited for: if it is not done when the mesh is, the first frame
  // simply builds what is left (as it always did)
  warmPrograms();
  await meshed;
  console.info(`[cloud-house] live mass ${Math.round(performance.now() - t0)} ms`);

  tearing = new Tearing({ house, shared, scene });
  tearing.onSpawn = (pc) => attachFluff(pc.mesh, makeFluffMaterial(pc.part, shared));
  tearing.onRemove = (pc) => detachFluff(pc.mesh);
  tearing.onRepresent = (pc) => worlds?.active?.onRepresent?.(pc);
  { const w = tearing.wisp; attachFluff(w.mesh, makeFluffMaterial(makePart('wisp', { family: 'cloud' }, w.mat, w.mesh), shared)); }

  await fontReady;
  word = makeWord('Cloud House');
  scene.add(word);

  interaction = new Interaction({ dom: canvas, camera, house, tearing, rig, cursor });
  interaction.enabled = false;

  ui = new UI();
  story = new Story({
    house, tearing, rig, word, atm, shared, interaction, ui, rebuildEnv, sun, floor, scene, dim, post,
    get roomLight() { return roomLight; },
    isReady: (k) => !!ready[k],
    whenReady: (k) => readyWait[k] || Promise.resolve(),
  });
  // material worlds: only the default one is loaded now; others on demand
  // a world asks for its layer count; the quality tier sets the ceiling
  // (soft cotton and standing blades have their own)
  setFuzzLayers(8);
  const setFuzzSolid = (on) => setFluffSolid(on, shared);
  // level of detail for the shells (a world with tall fuzz turns it on)
  const setFuzzLod = (on) => { fuzzLodOn = on; setFluffLod(on); applyFuzz(); for (const pc of tearing.pieces) pc.lod = null; };
  const onDebris = (...a) => sound.debris(...a);
  worlds = new Worlds({ scene, renderer, camera, shared, house, tearing, paint, setFuzzLayers, setFuzzSolid, setFuzzLod, onDebris, quality: Q });
  // a world may answer a tear or a landing (turf throws soil and blades);
  // the sound hears the same events
  tearing.onTear = (p) => { worlds.active?.onTear?.(p); sound.tear(p); };
  tearing.onImpact = (...a) => { worlds.active?.onImpact?.(...a); sound.impact(...a); };
  tearing.onReturn = (pc, delay) => sound.returning(pc, delay);
  tearing.onAbsorb = (pc, how) => sound.absorb(pc, how);
  interaction.onGrab = (pc, fromTear) => sound.grab(pc, fromTear);
  interaction.onRelease = (pc) => sound.release(pc);
  sound.attach({ tearing, interaction });
  const first = await worlds.load('cloud');
  worlds.switchTo(first);
  story.setWorld(first, { instant: true });
  // requested vs active: every click is a new request and supersedes any
  // pending one; a load that resolves for an old request is ignored
  let worldToken = 0;
  const clearLoading = () => { for (const w of WORLDS) ui.setWorldLoading(w.id, false); };
  ui.onWorld = async (id) => {
    const token = ++worldToken;
    ui.setWorld(id); // the choice shows at once; the world follows when ready
    clearLoading();
    if (worlds.active?.id === id) return; // back to the world on screen: nothing pending any more
    const cold = !worlds.isLoaded(id);
    if (cold) ui.setWorldLoading(id, true);
    try {
      const w = await worlds.load(id);
      if (token !== worldToken) return;
      Q.settle(2);
      worlds.switchTo(w);
      story.setWorld(w);
      sound.setWorld(id);
      worldBrush(id);
      console.info(`[cloud-house] world ${id}${cold ? ` loaded in ${w.loadMs} ms` : ' (cached)'}`);
    } catch (err) {
      if (token !== worldToken) return;
      console.warn('[cloud-house] world failed to load', err);
      ui.setWorld(worlds.active.id);
    } finally {
      if (token === worldToken) ui.setWorldLoading(id, false);
    }
  };
  story.init();
  ui.onScene = (id) => { Q.settle(); story.go(id); };
  ui.onPick = (v) => story.pick(v);
  ui.onStep = (dir) => story.step(dir);
  ui.onReassemble = () => story.reassemble();
  ui.onResetView = () => story.resetView();
  ui.onSound = (on) => sound.setEnabled(on);
  sound.onChange = (on) => ui.setSound(on);
  ui.setSound(sound.enabled);
  ui.onMix = (k, v) => sound.setMix(k, v);
  ui.onMixReset = () => { sound.resetMix(); ui.setMix(sound.mix); };
  ui.setMix(sound.mix);
  // the brush: its own palette, size, softness, opacity, eraser, undo
  tearing.paint = paint;
  interaction.paint = paint;
  const brush = interaction.brush;
  // wildflowers (turf world): grown by the same brush, undone on the same clock
  flowers = new FlowerField({ house, tearing, shared, paint });
  paint.extras.push(flowers);
  interaction.flowers = flowers;
  let lastColor = 'lavender';
  ui.onPaintColor = (id) => {
    if (id === 'flowers') {
      brush.kind = 'flowers';
      brush.erase = false;
      ui.setPaint({ color: id, erase: false });
      return;
    }
    const c = PAINT_COLORS.find((p) => p.id === id);
    if (!c) return;
    lastColor = id;
    brush.kind = 'paint';
    brush.color.set(c.hex);
    brush.erase = false;
    ui.setPaint({ color: id, erase: false });
  };
  // the flower brush belongs to the turf world: leaving it, the brush lays colour again
  const worldBrush = (id) => { if (id !== 'grass' && brush.kind === 'flowers') ui.onPaintColor(lastColor); };
  ui.onBrush = (k, v) => { brush[k] = v; if (k === 'erase') ui.setPaint({ erase: v }); };
  ui.onUndo = () => paint.undoLast();
  ui.onClearPaint = () => paint.clearAll();
  paint.onChange = (has, canUndo) => ui.setPaintState(has, canUndo);
  ui.onPaintColor('lavender');
  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ')) { e.preventDefault(); paint.undoLast(); }
  });
  ui.onKey = (e) => {
    if (!introDone) return false;
    const k = e.key;
    if (k === 'ArrowRight' || k === 'ArrowLeft') { story.nextScene(k === 'ArrowRight' ? 1 : -1); return true; }
    if (k === 'ArrowUp' || k === 'ArrowDown') { story.step(k === 'ArrowDown' ? 1 : -1); return !!story.def.variants; }
    if (/^[1-9]$/.test(k) && SCENES[+k - 1]) { story.go(SCENES[+k - 1].id); return true; }
    if (k === 'Escape' || k === 'Home') { story.go('house'); return true; }
    if (k === 'r' || k === 'R') { story.reassemble(); return true; }
    return false;
  };
  // in the material scene a tap turns the house into the next substance,
  // spreading from the point that was touched
  interaction.onTap = (part, local, world) => {
    if (interaction.tool !== 'material') return;
    const i = MATERIALS.findIndex((m) => m.id === story.family);
    story.setFamily(MATERIALS[(i + 1) % MATERIALS.length].id, { origin: world });
  };
  document.querySelector('.mark').addEventListener('click', (e) => { e.preventDefault(); story.go('house'); });
  house.body.u.uBreath.value = 0.006;

  resize();
  intro();
  requestAnimationFrame(loop);

  // in the background: brick sets and piece meshes for the choreography
  (async () => {
    // outer pieces first, so the first pinch is instant
    await Promise.all(CLUMPS.filter((c) => c.layer === 0).map((c) => house.clumpGeometry(c.id, 1)));
    await house.meshAll('noFacade');
    await tearing.preload('noFacade', true);
    readyDone.noFacade();
    await house.meshAll('coreOnly');
    await tearing.preload('coreOnly');
    readyDone.coreOnly();
    console.info(`[cloud-house] choreography ready ${Math.round(performance.now() - t0)} ms`);
  })();
}

// build the programs of the house body, its fuzz and its shadow depth on
// stand-ins while the workers mesh: KHR_parallel_shader_compile links them
// off the main thread, and the first real frame finds them ready
async function warmPrograms() {
  const t0 = performance.now();
  const g = new THREE.BufferGeometry();
  const n = 3;
  g.setIndex([0, 1, 2]);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  g.setAttribute('bake', new THREE.BufferAttribute(new Uint8Array(n * 4), 4, true));
  g.setAttribute('bake2', new THREE.BufferAttribute(new Uint8Array(n * 4), 4, true));
  const body = new THREE.Mesh(g, house.bodyMat);
  body.castShadow = body.receiveShadow = true;
  body.customDepthMaterial = house.bodyDepth;
  const pre = new THREE.Mesh(g, house.bodyPre);
  const fuzz = new THREE.InstancedMesh(g, fluffBody, 1);
  const group = new THREE.Group();
  group.add(body, pre, fuzz);
  // the shadow pass uses the depth material: compile it as a plain material too
  const depth = new THREE.Mesh(g, house.bodyDepth);
  group.add(depth);
  // the programs must be built for the target they will draw into: the
  // scene goes to the composer's buffer (linear colour, tone mapping in the
  // output pass), not to the canvas. The sync part of compileAsync creates
  // them; linking then runs in the background.
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(post.composer.renderTarget2);
  const jobs = [renderer.compileAsync(group, camera, scene), renderer.compileAsync(scene, camera)];
  renderer.setRenderTarget(prev);
  try { await Promise.all(jobs); } catch { /* compiled on first use instead */ }
  g.dispose();
  console.info(`[cloud-house] programs ready ${Math.round(performance.now() - t0)} ms`);
}

// ---------------------------------------------------------------------------
// FIRST CONTACT: the camera comes out of the fog; the cloud swells into its
// full volume and settles with a slow ripple.

const HERO = POSES.first;

function placeWord() {
  const yaw = HERO.yaw;
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  word.position.set(HERO.tx, 4.4, HERO.tz).addScaledVector(dir, -6.5);
  word.rotation.y = yaw;
}

let introTl = null;

function finishIntro() {
  introDone = true;
  interaction.enabled = true;
  document.body.classList.add('is-ready');
  document.body.classList.remove('is-loading');
  rig.followSpeed = 3.2;
  measureFrame();
}

function intro() {
  placeWord();
  introDone = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (params.has('skip') || reduce) {
    rig.set(HERO); rig.snap();
    veil.style.opacity = 0;
    finishIntro();
    return;
  }
  interaction.enabled = false;
  const start = { ...HERO, ty: HERO.ty + 2.2, dist: HERO.dist * 0.55, pitch: HERO.pitch + 0.1, yaw: HERO.yaw - 0.5, roll: 0.04 };
  rig.set(start); rig.snap();
  const fin = post.final.uniforms;
  fin.uAperture.value = 0.9;
  fin.uFocus.value = start.dist;
  const c = house.container;
  const inflate = { s: 0.82 };
  c.scale.setScalar(inflate.s);
  const tl = gsap.timeline({ delay: 0.1 });
  introTl = tl;
  // (the same arrival, tightened: ~3 s instead of ~4.5 s)
  tl.to(veil, { opacity: 0, duration: 1.3, ease: 'power2.out' }, 0);
  tl.to(rig.base, { ...HERO, duration: 3.0, ease: 'power2.inOut' }, 0.15);
  tl.to(fin.uFocus, { value: HERO.dist, duration: 2.4, ease: 'power2.inOut' }, 0.15);
  tl.to(fin.uAperture, { value: 0.12, duration: 1.5, ease: 'power2.in' }, 1.3);
  tl.to(inflate, { s: 1, duration: 2.3, ease: 'elastic.out(1, 0.55)', onUpdate: () => c.scale.setScalar(inflate.s) }, 0.35);
  tl.add(() => house.ripple(house.body, new THREE.Vector3(0, 4, 1), 0.04), 1.6);
  tl.add(finishIntro, 2.9);
  rig.followSpeed = 5;
  // an impatient visitor (a click, a wheel, a key) plays the rest of the
  // arrival quickly instead of waiting for it
  const hurry = () => { if (!introDone && introTl === tl) tl.timeScale(5); };
  for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart']) addEventListener(ev, hurry, { once: true, passive: true });
}

// ---------------------------------------------------------------------------

// the free part of the screen between the overlays: the camera frames the
// house there (desktop: header and dock; phone: the copy on top as well)
function measureFrame() {
  const H = innerHeight;
  let top = topBar.getBoundingClientRect().bottom + 8;
  if (innerWidth <= 700) {
    const c = document.querySelector('.copy.is-active');
    if (c) top = Math.max(top, c.offsetTop + c.offsetHeight + 12);
  }
  let dockTop = dockScenes.getBoundingClientRect().top;
  const panel = dockCtx.querySelector('.ctx-panel.is-on');
  if (panel) dockTop = Math.min(dockTop, panel.getBoundingClientRect().top);
  rig.setInsets(top, Math.max(0, H - dockTop + 10));
}

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  post.setSize(w, h, dpr);
  if (tearing) tearing.stage = w / h < 1 ? { halo: 3.7, far: 4.6 } : { halo: 5.4, far: 7.5 };
  if (introDone) measureFrame();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// quality: every scalable system takes its budget from the active profile

let fuzzWant = 8, fuzzLodOn = false;
function setFuzzLayers(n) { fuzzWant = n; applyFuzz(); }
function applyFuzz() {
  const p = Q.profile;
  // standing blades (level of detail on) and soft cotton have their own ceilings
  const cap = fuzzLodOn ? p.blades : p.cotton;
  setFluffLayers(Math.min(fuzzWant, cap));
  setFuzzCap(p.blades, p.pieceBlades);
  shared.uBladeLen.value = p.bladeLen;
  shared.uFuzzDetail.value.set(p.cottonDetail ? 1 : 0, p.bladeDetail ? 1 : 0);
}

function applyQuality(p, tier) {
  document.body.classList.toggle('is-low', !p.glass);
  document.body.dataset.tier = tier;
  const nd = tierDpr(p);
  if (nd !== dpr) { dpr = nd; resize(); }
  post.setQuality(p);
  if (sun.shadow.mapSize.x !== p.shadowMap) {
    sun.shadow.mapSize.set(p.shadowMap, p.shadowMap);
    sun.shadow.map?.dispose(); sun.shadow.map = null;
    sun.shadow.mapPass?.dispose(); sun.shadow.mapPass = null;
  }
  sun.shadow.blurSamples = p.shadowBlur;
  renderer.shadowMap.needsUpdate = true;
  contact.setRes(p.contactRes);
  contactStill = false;
  PaintVolume.interval = 1 / p.paintHz;
  applyFuzz();
  worlds?.active?.onQuality?.(p);
  console.info(`[cloud-house] quality ${tier} (${Q.reason})`);
}

const clock = new THREE.Timer();
const tmpV = new THREE.Vector3();
const lodCenter = new THREE.Vector3();
let contactTick = 0, contactStill = false, contactRenders = 0;
let frameTick = 0;
const actions = { r: null, v: null };

let sunTick = 0, sunStill = false;
function loop() {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  const tLoop = performance.now();
  clock.update();
  // (the real interval goes to the quality meter; the simulation steps at most 50 ms)
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 1 / 20);
  renderer.info.reset();
  const t = clock.getElapsed();
  shared.uTime.value = t;

  if (introDone) {
    story.apply(dt);
    if (++frameTick % 15 === 0) measureFrame();
  }
  else word.material.opacity = THREE.MathUtils.smoothstep(introTl ? introTl.time() : 9, 3.2, 5.2) * 0.8;
  rig.update(dt);
  // depth of field follows the framing; while pulling it drifts to the hand
  if (introDone) {
    const fin = post.final.uniforms;
    const want = interaction.mode === 'pull' || interaction.mode === 'carry' ? camera.position.distanceTo(interaction.lastHand) : rig.focusDist;
    fin.uFocus.value += (want - fin.uFocus.value) * (1 - Math.exp(-dt * 3));
  }
  shared.uFuzzScale.value = THREE.MathUtils.clamp(camera.position.distanceTo(house.group.position) / 26, 0.35, 1.1);
  house.update(dt);
  interaction.frame(dt);
  tearing.update(dt, t, camera);
  sound.update(dt);
  paint.flush(t, renderer);
  worlds?.update(dt, t);
  flowers?.update(worlds?.active?.id === 'grass');
  if (fluffBody) {
    lodCenter.copy(house.group.position).y += 3;
    updateFuzzLod(dt, camera, renderer.getContext().drawingBufferHeight, (house.body.state?.fuzz ?? 0.3) * shared.uFuzzScale.value, fluffBody, lodCenter, tearing.pieces);
  }
  // contextual actions: reassemble only when something is apart, reset view
  // only when the visitor has turned away from the curated view
  const canReassemble = tearing.freeCount() > 0 || story.scene === 'apart';
  const canResetView = rig.turned && !rig.dragging;
  if (canReassemble !== actions.r || canResetView !== actions.v) {
    actions.r = canReassemble; actions.v = canResetView;
    ui.setActions(canReassemble, canResetView);
  }

  // the pendant lights the room from within
  const lan = house.lantern.mesh;
  lan.getWorldPosition(roomLight.position);
  roomLight.color.copy(atm.glow);

  camera.updateMatrixWorld();
  background.update(camera);
  tmpV.copy(SUN_DIR).transformDirection(camera.matrixWorldInverse);
  shared.uSunDirV.value.copy(tmpV);

  // the ground shadow follows what moves; once everything has settled it is
  // drawn one last time and then left alone until something changes
  const b = house.body;
  const moving = interaction.mode !== 'idle' || story.tl?.isActive() || tearing.anyMoving() || b.press.x > 0.002 || b.rippleAge >= 0 || b.pullVec.x.lengthSq() > 1e-4;
  const P = Q.profile;
  contactTick -= dt;
  if (moving) contactStill = false;
  if (moving ? contactTick <= 0 : !contactStill) {
    contact.render(scene, 1 << 1);
    contactTick = 1 / P.contactHz;
    contactStill = !moving;
    contactRenders++;
  }
  // the sun's shadow map: the same rule (at the tier's rate while things
  // move, once more when they stop), plus a slow refresh for anything that
  // changes the body quietly (a material wave, a settling wound, breathing)
  sunTick -= dt;
  const shaping = moving || !!b.morph || b.drops.length > 0;
  if (shaping) sunStill = false;
  if ((shaping && sunTick <= 0) || (!shaping && !sunStill) || sunTick < -0.5) {
    renderer.shadowMap.needsUpdate = true;
    sunTick = 1 / P.shadowHz;
    sunStill = !shaping;
  }

  Q.beginGpu();
  post.render(t);
  Q.endGpu();
  Q.frame(rawDt, performance.now() - tLoop);
}

window.__ch = {
  get house() { return house; }, get story() { return story; }, get flowers() { return flowers; }, get worlds() { return worlds; }, get tearing() { return tearing; }, get interaction() { return interaction; },
  rig, camera, scene, renderer, post, atm, shared, gsap, THREE, CLUMPS, SPEC, FLOAT, clumpAt, bodyFs, fluffShellCount, paint, sound,
  get contactRenders() { return contactRenders; }, fuzzLodState, contact, sun, quality: Q, PROFILES, TIERS,
  // QA: fix a tier now (auto is paused until a reload)
  setTier(t) { Q.auto = false; Q.force(t); return Q.status(); },
  // the numbers the QA report needs, in one object
  perf() {
    const gl = renderer.getContext(), info = renderer.info, p = Q.profile, fz = fuzzLodState();
    return {
      ...Q.status(), dpr: renderer.getPixelRatio(), buffer: `${gl.drawingBufferWidth}x${gl.drawingBufferHeight}`,
      shells: { body: fz.on ? fz.body : fz.max, cap: fz.cap, pieceCap: fz.pieceCap, cotton: p.cotton },
      shadow: { map: sun.shadow.mapSize.x, blur: sun.shadow.blurSamples, hz: p.shadowHz, contactRes: p.contactRes, contactHz: p.contactHz },
      post: { msaa: post.samples, bloom: post.bloom.enabled ? p.bloom : 0, dofTaps: p.dofTaps, dofRest: p.dofRest },
      pieces: tearing?.pieces.length ?? 0, free: tearing?.freeCount() ?? 0, sleeping: tearing?.pieces.filter((pc) => pc.sleeping).length ?? 0,
      calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length, geometries: info.memory.geometries, textures: info.memory.textures,
    };
  },
};
// the QA overlay (?perf): numbers, a benchmark and a copyable report
if (params.has('perf')) import('./perf-hud.js').then((m) => m.mountPerfHud(window.__ch)).catch((e) => console.warn('[cloud-house] perf hud', e));

removeEventListener('error', onSetupError);
boot().catch((err) => fail('error', err));
