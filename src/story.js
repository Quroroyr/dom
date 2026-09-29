import * as THREE from 'three';
import gsap from 'gsap';
import { PALETTES, paletteColors } from './render/palettes.js';
import { FAMILIES } from './render/families.js';
import { ORIGIN } from './house/sdf.js';
const PEARL = { get x() { return ORIGIN[0]; }, get y() { return ORIGIN[1] + 0.8; }, get z() { return ORIGIN[2]; } };

// Scene director. The experience is a set of curated states the visitor
// switches between with buttons; each scene defines a camera pose, the state
// of the object (whole / opened / apart), light, and what a touch does.
// Transitions are controlled tweens, never bound to the scroll position.

export const POSES = {
  // low, off-centre: the house towers, the title passes behind it
  first: { tx: 0.8, ty: 4.05, tz: 0.2, yaw: 0.5, pitch: -0.03, dist: 20.8, fov: 27, roll: 0, inner: 0 },
  // nearer the eaves and the door: material to pull, the whole house in frame
  touch: { tx: -1.7, ty: 4.3, tz: 0.8, yaw: 0.36, pitch: 0.08, dist: 18.2, fov: 30, roll: 0, inner: 0 },
  open: { tx: 0.3, ty: 4.3, tz: 1.4, yaw: 0.18, pitch: 0.1, dist: 15.8, fov: 30, roll: 0, inner: 0 },
  inside: { tx: 0.3, ty: 2.6, tz: -0.35, yaw: 0.42, pitch: 0.08, dist: 6.0, fov: 42, roll: 0, inner: 1 },
  material: { tx: -1.2, ty: 4.0, tz: 0.3, yaw: -0.58, pitch: -0.02, dist: 19.2, fov: 30, roll: 0, inner: 0 },
  weather: { tx: 0.7, ty: 4.2, tz: 0, yaw: 0.28, pitch: 0.06, dist: 19.8, fov: 28, roll: 0, inner: 0 },
  // painting: near and a little from above, the house to the right of the panel
  paint: { tx: -1.3, ty: 4.2, tz: 0.6, yaw: 0.3, pitch: 0.12, dist: 18.4, fov: 30, roll: 0, inner: 0 },
  drift: { tx: 0.1, ty: 6.0, tz: 0.2, yaw: 0.95, pitch: 0.1, dist: 34, fov: 30, roll: 0, inner: 0 },
};

// the Material scene offers the active world's families (filled by setWorld)
export const MATERIALS = [];
export const SKIES = Object.entries(PALETTES).filter(([, p]) => !p.hidden).map(([id, p]) => ({ id, label: p.label }));

const BASE = { open: 0, explode: 0, dusk: 0, glow: 0, word: 0 };
export const SCENES = [
  { id: 'house', name: 'House', pose: () => POSES.first, state: () => ({ word: 0.8 }), tool: 'touch', limits: { zoom: [0.55, 1.4] } },
  { id: 'touch', name: 'Touch', pose: () => POSES.touch, state: () => ({}), tool: 'touch', limits: { zoom: [0.6, 1.45] } },
  // inside the room: the view may lean in a little and look around, not wander through the walls
  { id: 'inside', name: 'Inside', pose: () => POSES.inside, state: () => ({ open: 1, dusk: 0.55, glow: 1 }), tool: 'look', needs: () => 'noFacade',
    limits: { zoom: [0.72, 1.2], pitch: [-0.06, 0.32], yaw: [-0.45, 0.45] } },
  {
    id: 'apart', name: 'Apart', tool: 'look',
    variants: [{ id: 'layer', label: 'Layer' }, { id: 'drift', label: 'Drift' }],
    pose: (v) => (v === 'drift' ? POSES.drift : POSES.open),
    state: (v) => (v === 'drift' ? { explode: 1 } : { open: 1, dusk: 0.3, glow: 0.8 }),
    needs: (v) => (v === 'drift' ? 'coreOnly' : 'noFacade'),
    limits: { zoom: [0.6, 1.3] },
  },
  { id: 'material', name: 'Material', pose: () => POSES.material, state: () => ({}), tool: 'material', variants: MATERIALS, limits: { zoom: [0.58, 1.4] } },
  { id: 'weather', name: 'Weather', pose: () => POSES.weather, state: () => ({}), tool: 'look', variants: SKIES, limits: { zoom: [0.58, 1.4] } },
  // the brush: its own palette; paints the house or any loose piece
  { id: 'paint', name: 'Paint', pose: () => POSES.paint, state: () => ({}), tool: 'paint', limits: { zoom: [0.55, 1.4] } },
];
const byId = Object.fromEntries(SCENES.map((s) => [s.id, s]));

// evening is a sky with its own light: blue hour outside, amber within
const SKY_LIGHT = { evening: { dusk: 0.2, glow: 1.1 } };

// a visitor who asks for less motion gets cuts, not flights (read live: the
// setting can change while the page is open)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// OPEN: the facade lifts like an awning on a hinge along its top edge
const HINGE = new THREE.Vector3(0.0, 4.15, 2.1);
const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3();
function openOffset(clump, w) {
  const th = -1.42 * w;
  _q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), th);
  _p.fromArray(clump.c).sub(HINGE).applyQuaternion(_q).add(HINGE).add(new THREE.Vector3(0, 0.9 * w, 0.45 * w));
  _e.set(th, 0, 0);
  return [_p, _e];
}
// APART: every non-core puff drifts outward and up, turning a little
const CENTER = new THREE.Vector3(0.0, 3.2, 0);
function apartOffset(clump, w) {
  const home = new THREE.Vector3().fromArray(clump.c);
  const dir = home.clone().sub(CENTER).normalize();
  const amt = clump.layer === 0 ? 3.6 : 2.3;
  _p.copy(home).addScaledVector(dir, amt * w).add(new THREE.Vector3(0, (0.6 + Math.max(0, dir.y)) * 1.3 * w, 0));
  const r = Math.sin(clump.id * 12.9898) * 0.5;
  _e.set(r * 0.3 * w, r * 1.2 * w, -r * 0.3 * w);
  return [_p, _e];
}

export class Story {
  constructor(ctx) {
    this.ctx = ctx; // { house, tearing, rig, word, atm, shared, interaction, ui, rebuildEnv, sun, floor, scene, dim, whenReady }
    this.scene = 'house';
    this.S = { ...BASE, word: 0.8 };
    this.P = { dusk: 0, glow: 0 }; // light that belongs to the sky, not the scene
    this.pose = { ...POSES.first };
    this.variant = { apart: 'layer' };
    this.palette = 'cloud';
    this.family = 'cloud';
    this.world = null; // the active material world (src/modes)
    this.room = null;  // room tone, easing toward the world's
    // what the visitor chose vs what a scene put on for show
    this.demoFamily = null;
    this.demoPalette = null;
    this.brush = false;
    this.tl = null;
    this.token = 0;
  }

  get index() { return SCENES.findIndex((s) => s.id === this.scene); }
  get def() { return byId[this.scene]; }

  init() {
    this.ctx.rig.setLimits(this.def.limits);
    this._enter(this.scene);
  }

  // ---------------------------------------------------------------------------
  // navigation

  async go(id, variant) {
    const d = byId[id];
    if (!d) return;
    const v = variant ?? this.variant[id];
    // the active scene again: back to its own framing
    if (id === this.scene && (!d.variants || id !== 'apart' || v === this.variant.apart)) { if (this.ctx.rig.turned) this.resetView(); return; }
    if (id === 'apart') this.variant.apart = v;
    const prev = this.scene;
    const token = ++this.token;
    this.scene = id;
    this._leave(prev, id);
    this._enter(id);
    // a choreography shows the house as it is now (torn pieces stay torn):
    // its layout is brought in line with what the visitor has taken apart
    const needs = d.needs?.(v);
    if (needs && (!this.ctx.isReady(needs) || !this.ctx.tearing.isPrepared(needs, needs === 'noFacade'))) {
      this.ctx.ui.setBusy(true);
      await this.ctx.whenReady(needs);
      await this.ctx.tearing.prepare(needs, needs === 'noFacade');
      this.ctx.ui.setBusy(false);
      if (token !== this.token) return;
    }
    this._transition(prev, d, v);
  }

  step(dir) {
    const d = this.def;
    if (!d.variants) return;
    const list = d.variants;
    const cur = this.scene === 'apart' ? this.variant.apart : this.scene === 'material' ? this.family : this.palette;
    const i = Math.max(0, list.findIndex((o) => o.id === cur));
    this.pick(list[(i + dir + list.length) % list.length].id);
  }

  // a variant chosen by the visitor
  pick(id, originWorld) {
    if (this.scene === 'apart') return this.go('apart', id);
    if (this.scene === 'material') return this.setFamily(id, { origin: originWorld });
    if (this.scene === 'weather') return this.setPalette(id);
  }

  nextScene(dir) {
    const i = (this.index + dir + SCENES.length) % SCENES.length;
    this.go(SCENES[i].id);
  }

  // parts come home: torn pieces fly back; a dismantled state folds together
  reassemble() {
    const { tearing } = this.ctx;
    if (tearing.freeCount()) tearing.reassemble();
    if (this.scene === 'apart') this.go('house');
  }

  // orbit, distance and inertia back to the scene's intended framing
  resetView() {
    const { rig } = this.ctx;
    rig.reset();
    if (reduceMotion.matches) this._cut(() => rig.settle());
  }

  // reduced motion: a short fade through the sky; underneath it the new state
  // is set in place (camera, opened / apart, light); the fade lifts. The
  // header and the dock stay visible above it and say where you are.
  _cut(apply) {
    const veil = document.querySelector('.veil');
    this.tl?.kill();
    veil.classList.add('is-cut');
    const tl = gsap.timeline({ onComplete: () => veil.classList.remove('is-cut') });
    this.tl = tl;
    tl.to(veil, { opacity: 1, duration: 0.18, ease: 'power1.out' });
    tl.add(apply);
    tl.to(veil, { opacity: 0, duration: 0.32, ease: 'power1.in' }, '+=0.08');
  }

  _transition(prev, d, v) {
    const S = this.S;
    const to = { ...BASE, ...d.state(v) };
    const pose = d.pose(v);
    this.tl?.kill();
    // a cut that was interrupted must not leave the sky drawn over the house
    const veil = document.querySelector('.veil');
    if (veil.classList.contains('is-cut')) { gsap.set(veil, { opacity: 0 }); veil.classList.remove('is-cut'); }
    // the visitor's inspection offset survives the move if it is small and
    // fits the new scene; entering or leaving the room starts from its framing
    this.ctx.rig.sceneChange(d.limits, { resetOrbit: prev === 'inside' || d.id === 'inside' });
    if (reduceMotion.matches) {
      this._cut(() => {
        Object.assign(S, { open: to.open, explode: to.explode, dusk: to.dusk, glow: to.glow, word: to.word });
        Object.assign(this.pose, pose);
        const { rig } = this.ctx;
        rig.set(this.pose); rig.snap(); rig.settle();
      });
      return;
    }
    const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });
    this.tl = tl;
    let t = 0;
    // the two choreographies are exclusive: fold one away before the other
    if (to.open > 0 && S.explode > 0.01) { tl.to(S, { explode: 0, duration: 0.8 }, 0); t = 0.65; }
    if (to.explode > 0 && S.open > 0.01) { tl.to(S, { open: 0, duration: 0.8 }, 0); t = 0.65; }
    const light = { dusk: to.dusk, glow: to.glow, word: to.word };

    if (d.id === 'inside' && S.open < 0.99) {
      // lift the facade from outside, then drift in through the opening
      tl.to(this.pose, { ...POSES.open, duration: 1.0 }, t);
      tl.to(S, { open: 1, duration: 1.0 }, t);
      tl.to(S, { ...light, duration: 1.2 }, t);
      tl.to(this.pose, { ...pose, duration: 1.3, ease: 'power2.inOut' }, t + 0.85);
    } else if (prev === 'inside' && d.id !== 'inside') {
      // leave the room first, then let the layer settle behind the camera
      tl.to(this.pose, { ...pose, duration: 1.5 }, t);
      tl.to(S, { open: to.open, duration: 1.0 }, t + 0.5);
      tl.to(S, { explode: to.explode, duration: 1.1 }, t + 0.6);
      tl.to(S, { ...light, duration: 1.2 }, t);
    } else {
      tl.to(this.pose, { ...pose, duration: 1.5 }, t);
      if (Math.abs(S.open - to.open) > 0.001) tl.to(S, { open: to.open, duration: 1.1 }, t + 0.1);
      if (Math.abs(S.explode - to.explode) > 0.001) tl.to(S, { explode: to.explode, duration: 1.2, ease: 'power2.inOut' }, t + 0.15);
      tl.to(S, { ...light, duration: 1.1 }, t);
    }
  }

  // bookkeeping on arrival: UI, what a touch does, one demo per scene
  _enter(id) {
    const { ui, interaction } = this.ctx;
    const d = byId[id];
    document.body.dataset.scene = id;
    ui.setScene(this.index, d);
    ui.setVariant('apart', this.variant.apart);
    interaction.tool = d.tool;
    interaction.pending = true; // re-read the hover under the cursor for the new tool
    // a scene may dress the house up for show — only if the visitor has not
    // chosen that setting themselves; it is taken off again on leaving
    const W = this.world;
    if (id === 'material' && this.family === W.defaultFamily && !this.userFamily) {
      setTimeout(() => { if (this.scene === 'material' && this.family === W.defaultFamily && !this.userFamily && this.world === W) this.setFamily(W.demoFamily, { demo: true }); }, 450);
    }
    if (id === 'weather' && this.palette === W.sky && !this.userPalette) {
      setTimeout(() => { if (this.scene === 'weather' && this.palette === W.sky && !this.userPalette && this.world === W) this.setPalette('evening', { demo: true }); }, 400);
    }
  }

  _leave(prev, next) {
    if (prev === next) return;
    if (prev === 'material' && this.demoFamily && this.family === this.demoFamily) this.setFamily(this.world.defaultFamily, { demo: true, quiet: true });
    if (prev === 'weather' && this.demoPalette && this.palette === this.demoPalette) this.setPalette(this.world.sky, { demo: true, quiet: true });
    this.demoFamily = null;
    this.demoPalette = null;
  }

  // ---------------------------------------------------------------------------
  // per-frame: push the state into the world

  apply(dt = 1 / 60) {
    const { rig, word, shared, tearing, house } = this.ctx;
    const S = this.S;
    rig.set(this.pose);
    word.material.opacity = S.word;
    tearing.setChoreo('open', 'noFacade', S.open, openOffset, true);
    if (S.open <= 0.002) tearing.setChoreo('apart', 'coreOnly', S.explode, apartOffset);
    shared.uAoMix.value = 1 - Math.max(S.open * 0.4, S.explode * 0.8);
    const glow = Math.max(S.glow, this.P.glow);
    const d = Math.max(S.dusk, this.P.dusk);
    house.lantern.u.uGlowBoost.value = 0.15 + glow * 0.3;
    if (this.ctx.roomLight) this.ctx.roomLight.intensity = glow * 1.6;
    this.ctx.floor.material.uniforms.uGlow.value = glow * 0.25;
    this.ctx.sun.intensity = this.ctx.atm.sunIntensity * (1 - 0.6 * d);
    this.ctx.scene.environmentIntensity = 0.5 * (1 - 0.45 * d);
    this.ctx.dim.value = 1 - 0.22 * d;
    shared.uCloudDim.value = 1 - 0.6 * d;
    // seen from outside the room sits a half-tone deeper and warmer than the
    // sunlit cloud, so door and windows read as openings; once the facade is
    // peeled back the eye adapts and the room brightens to plaster
    const R = this.room, WR = this.world.room, k = 1 - Math.exp(-dt * 1.4);
    for (const key of ['outLit', 'outDeep', 'inLit', 'inDeep']) R[key].lerp(WR[key], k);
    shared.uRoomLit.value.copy(R.outLit).lerp(R.inLit, S.open);
    shared.uRoomDeep.value.copy(R.outDeep).lerp(R.inDeep, S.open);
  }

  // ---------------------------------------------------------------------------
  // material worlds: the same house, grown from another substance.
  // The world's default material spreads from the chimney down as a wave,
  // its sky comes in with it; strands, breeze and room tone follow.

  setWorld(w, { instant = false } = {}) {
    const { ui, tearing, shared } = this.ctx;
    this.world = w;
    MATERIALS.length = 0;
    MATERIALS.push(...w.materials);
    ui.setMaterials(w.materials);
    ui.setWorld(w.id);
    ui.setCopy(w.copy);
    // choices made in another world do not carry over
    this.userFamily = false; this.userPalette = false;
    this.demoFamily = null; this.demoPalette = null;
    if (instant) {
      this.room = Object.fromEntries(Object.entries(w.room).map(([k, c]) => [k, c.clone()]));
      ui.setMaterial(this.family);
      ui.setPalette(this.palette);
    } else {
      this.setFamily(w.defaultFamily, { demo: true, quiet: true });
      this.setPalette(w.sky, { demo: true, quiet: true });
    }
    tearing.wisp.setColor(w.fibre.tint);
    tearing.wisp.widthK = w.fibre.width;
    const [x, z, strength, gust] = w.wind;
    gsap.to(shared.uWind.value, { x, y: z, z: strength, w: gust, duration: instant ? 0 : 2.4, ease: 'sine.inOut', overwrite: true });
  }

  // ---------------------------------------------------------------------------
  // material and sky

  setFamily(family, { demo = false, quiet = false, origin } = {}) {
    if (!FAMILIES[family]) return;
    const { house, ui } = this.ctx;
    this.family = family;
    if (demo) this.demoFamily = quiet ? null : family;
    else { this.userFamily = true; this.demoFamily = null; }
    ui.setMaterial(family);
    const o = origin || house.container.localToWorld(new THREE.Vector3(ORIGIN[0], ORIGIN[1], ORIGIN[2]));
    house.materialWave(o, family);
    // material is one substance for all the cloud, loose pieces included
    // (paint stays each object's own)
    // (the pieces of an Apart / Inside choreography too: every visible part
    // of the house ends in the same material)
    for (const pc of this.ctx.tearing.pieces) {
      house.morphTo(pc.part, house.stateFor(family), new THREE.Vector3(0, 0, 0), 3.4);
    }
  }

  setPalette(name, { demo = false, quiet = false, origin } = {}) {
    if (!PALETTES[name]) return;
    if (demo) this.demoPalette = quiet ? null : name;
    else { this.userPalette = true; this.demoPalette = null; }
    this.palette = name;
    // the page's secondary words darken under a dim sky (see style.css)
    document.body.dataset.sky = name;
    const { house, atm, shared, word, rebuildEnv, ui } = this.ctx;
    const pc = paletteColors(name);
    const o = origin || new THREE.Vector3(PEARL.x, PEARL.y, PEARL.z);
    house.colorWave(o, pc.tint, 3.6);
    ui.setPalette(name);
    gsap.to(this.P, { ...(SKY_LIGHT[name] || { dusk: 0, glow: 0 }), duration: 2.4, ease: 'sine.inOut', overwrite: true });
    // the air changes with the colour: same frame, new weather
    const tw = { t: 0 };
    const from = {
      zenith: atm.zenith.clone(), horizon: atm.horizon.clone(), ground: atm.ground.clone(),
      sun: atm.sunColor.clone(), glow: atm.glow.clone(), word: word.material.color.clone(),
      lit: atm.cloudLit.clone(), shade: atm.cloudShadow.clone(), rim: atm.cloudRim.clone(),
    };
    gsap.to(tw, {
      t: 1, duration: 2.6, ease: 'sine.inOut',
      onUpdate: () => {
        atm.zenith.lerpColors(from.zenith, pc.air.zenith, tw.t);
        atm.horizon.lerpColors(from.horizon, pc.air.horizon, tw.t);
        atm.ground.lerpColors(from.ground, pc.air.ground, tw.t);
        atm.sunColor.lerpColors(from.sun, pc.air.sun, tw.t);
        atm.glow.lerpColors(from.glow, pc.air.glow, tw.t);
        atm.cloudLit.lerpColors(from.lit, pc.air.lit, tw.t);
        atm.cloudShadow.lerpColors(from.shade, pc.air.shade, tw.t);
        atm.cloudRim.lerpColors(from.rim, pc.air.rim, tw.t);
        word.material.color.lerpColors(from.word, pc.air.word, tw.t);
        shared.uSunCol.value.copy(atm.sunColor).multiplyScalar(0.9);
        this.ctx.sun.color.copy(atm.sunColor);
        document.documentElement.style.setProperty('--milk', '#' + atm.horizon.getHexString());
      },
      onComplete: () => rebuildEnv(),
    });
  }
}
