import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SPEC, FLOAT, ALIVE, setAlive, allBrickKeys } from './sdf.js';
import { createHouseMaterial, createDeformDepthMaterial } from '../render/houseMaterial.js';
import { familyState, packState } from '../render/families.js';
import { paletteColors } from '../render/palettes.js';

// ---------------------------------------------------------------------------
// springs

export class Spring3 {
  constructor(k = 60, c = 12) {
    this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); this.target = new THREE.Vector3();
    this.k = k; this.c = c;
  }
  step(dt) {
    const n = Math.ceil(dt / (1 / 240)), h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v.x += (this.k * (this.target.x - this.x.x) - this.c * this.v.x) * h;
      this.v.y += (this.k * (this.target.y - this.x.y) - this.c * this.v.y) * h;
      this.v.z += (this.k * (this.target.z - this.x.z) - this.c * this.v.z) * h;
      this.x.addScaledVector(this.v, h);
    }
  }
}
export class Spring1 {
  constructor(k = 60, c = 12, x = 0) { this.x = x; this.v = 0; this.target = x; this.k = k; this.c = c; }
  step(dt) {
    const n = Math.ceil(dt / (1 / 240)), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += (this.k * (this.target - this.x) - this.c * this.v) * h; this.x += this.v * h; }
  }
}

// a mesh from a worker comes with its raycast tree already built
function withTree(g, d) {
  if (d.bvh) g.boundsTree = MeshBVH.deserialize({ version: 1, roots: d.bvh.roots, index: g.index.array }, g, { setIndex: false });
  else g.computeBoundsTree?.();
  return g;
}

export function toGeometry(m) {
  const g = new THREE.BufferGeometry();
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setAttribute('bake', new THREE.BufferAttribute(m.bake, 4, true));
  g.setAttribute('bake2', new THREE.BufferAttribute(m.bake2, 4, true));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

// a "part" = something with its own material uniforms that can be pressed,
// rippled, painted, stretched and morphed. The body is one part of many bricks.
export function makePart(id, def, mat, mesh) {
  return {
    id, def, mat, mesh, u: mat.userData.uniforms,
    home: new THREE.Vector3(),
    state: familyState(def.family),
    press: new Spring1(30, 5.2), // a cloud sinks deep and re-inflates slowly
    pressPoint: new THREE.Vector3(), pressDir: new THREE.Vector3(0, 1, 0),
    rippleAge: -1,
    pullVec: new Spring3(34, 3.6), // surface drawn toward a pulling hand; recoils softly
    stretch: new Spring1(140, 9), stretchAxis: new THREE.Vector3(0, 1, 0),
    morph: null, drops: [], family: def.family,
  };
}

export function stepPart(p, dt, house) {
  p.press.step(dt);
  p.u.uPress.value.set(p.pressPoint.x, p.pressPoint.y, p.pressPoint.z, p.press.x);
  p.u.uPressN.value.x = p.pressDir.x; p.u.uPressN.value.y = p.pressDir.y; p.u.uPressN.value.z = p.pressDir.z;
  if (p.rippleAge >= 0) { p.rippleAge += dt; if (p.rippleAge > 4) p.rippleAge = -1; }
  p.u.uRipple.value.w = p.rippleAge;
  p.pullVec.step(dt);
  p.u.uPullVec.value.copy(p.pullVec.x);
  p.stretch.step(dt);
  p.u.uStretch.value.set(p.stretchAxis.x, p.stretchAxis.y, p.stretchAxis.z, p.stretch.x);
  if (p.morph) {
    const m = p.morph;
    m.r += dt * m.speed;
    p.u.uMorph.value.set(m.origin.x, m.origin.y, m.origin.z, m.r);
    if (m.r > m.max) {
      packState(m.to, p.mat.userData.A);
      p.state = m.to;
      p.u.uMorph.value.w = -1;
      p.morph = null;
    }
  }
  if (p.drops.length) {
    for (const d of p.drops) d.r = Math.min(d.max, d.r + dt * d.speed * (d.bakeAt ? 1 : 1 - d.r / (d.max * 1.05)));
    for (let k = p.drops.length - 1; k >= 0; k--) {
      const d = p.drops[k];
      if (d.bakeAt && d.r >= d.bakeAt) {
        p.mat.userData.A.color.copy(d.c);
        if (!p.morph) p.mat.userData.B.color.copy(d.c);
        p.state.color.copy(d.c);
        p.drops.splice(0, k + 1);
        break;
      }
    }
    const n = Math.min(p.drops.length, 10);
    for (let k = 0; k < n; k++) {
      const d = p.drops[p.drops.length - n + k];
      p.u.uDrops.value[k].set(d.p.x, d.p.y, d.p.z, d.r);
      p.u.uDropCol.value[k].set(d.c.r, d.c.g, d.c.b, d.a ?? 1);
    }
    p.u.uDropCount.value = n;
  }
  void house;
}

// ---------------------------------------------------------------------------

export class House {
  constructor(shared, cell) {
    this.shared = shared;
    this.cell = cell;
    this.group = new THREE.Group();
    this.group.position.y = FLOAT;
    this.tints = paletteColors('cloud').tint;
    this.roomCenter = new THREE.Vector3().fromArray(SPEC.room.c);

    // the body: one material for every brick → one continuous surface
    this.bodyMat = createHouseMaterial(shared, familyState('cloud'), familyState('cloud'), false);
    // MIST thins the body: a depth pre-pass keeps only the nearest surface,
    // which is then blended over the sky — one clean translucent layer
    // instead of hashed noise through every inner wall
    this.bodyMat.transparent = true;
    this.bodyMat.depthWrite = true;
    this.bodyDepth = createDeformDepthMaterial(this.bodyMat.userData.uniforms, 'depth');
    this.bodyPre = createDeformDepthMaterial(this.bodyMat.userData.uniforms, 'depth');
    this.bodyPre.colorWrite = false;
    this.container = new THREE.Group();
    this.group.add(this.container);
    this.sets = {};
    for (const name of ['live', 'noFacade', 'coreOnly']) {
      const g = new THREE.Group();
      g.visible = name === 'live';
      // a hidden brick set (hundreds of bricks, each with its pre-pass and
      // shells) skips the per-frame matrix walk; showConfig refreshes it
      g.updateMatrixWorld = function (force) { if (this.visible) THREE.Group.prototype.updateMatrixWorld.call(this, force); };
      this.container.add(g);
      this.sets[name] = { group: g, bricks: new Map(), gen: new Map(), ready: false };
    }
    this.config = 'live';
    this.body = makePart('body', { family: 'cloud', mass: 3, isBody: true }, this.bodyMat, this.container);

    // a small pendant of warm light hanging in the room
    const lg = new THREE.SphereGeometry(1, 32, 24);
    lg.scale(0.22, 0.3, 0.22);
    const n = lg.attributes.position.count;
    lg.setAttribute('bake', new THREE.BufferAttribute(new Uint8Array(n * 4).fill(230), 4, true));
    lg.setAttribute('bake2', new THREE.BufferAttribute(new Uint8Array(n * 4).fill(0), 4, true));
    const lmat = createHouseMaterial(shared, familyState('gel'), familyState('gel'), false);
    lmat.userData.uniforms.uPaintOn.value = 0;
    const lantern = new THREE.Mesh(lg, lmat);
    const lc = SPEC.room.c;
    lantern.position.set(lc[0] - 0.3, lc[1] + 0.35, lc[2] - 0.2);
    this.container.add(lantern);
    lantern.visible = false; // no glowing core: the room is lit by its windows
    this.lantern = makePart('lantern', { family: 'gel', mass: 0.2, interior: true }, lmat, lantern);
    this.lantern.home.copy(lantern.position);

    this.parts = [this.body, this.lantern];
    this.byId = { body: this.body, lantern: this.lantern };
    this.weights = { open: 0, explode: 0 };
    this.onBrick = null;
    this.clumpGeo = new Map();
    this.clumpWait = new Map();
    this.waiters = [];
  }

  // --- workers ---------------------------------------------------------------
  // Jobs wait in a queue here, not in the workers: each worker holds one job
  // at a time, so a tear (priority 0) never waits behind the background
  // meshing of the choreography sets (priority 1).
  // the meshing resolution (m); later jobs use it (a first pass may be
  // coarser, then refined)
  setCell(cell) {
    this.cell = cell;
    this._broadcast({ type: 'cell', cell });
  }

  startWorkers(n) {
    this.pool = [];
    this.busy = [];
    this.queue = [];
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { this.busy[i] = 0; this._onMessage(e.data); this._pump(); };
      w.postMessage({ type: 'init', cell: this.cell });
      this.pool.push(w);
      this.busy.push(0);
    }
  }
  _broadcast(msg) { for (const w of this.pool) w.postMessage(msg); }
  _enqueue(job, prio) {
    job.prio = prio;
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].prio > prio) i--;
    this.queue.splice(i, 0, job);
    this._pump();
  }
  _pump() {
    for (let w = 0; w < this.pool.length && this.queue.length; w++) {
      if (this.busy[w]) continue;
      const job = this.queue.shift();
      // a queued brick whose generation moved on is not worth meshing
      if (job.type === 'bricks' && job.gens[0] !== this.sets[job.config].gen.get(job.keys[0])) {
        this._onMessage({ type: 'brick', key: job.keys[0], config: job.config, gen: job.gens[0], skipped: true });
        w--; continue;
      }
      this.busy[w] = 1;
      const { prio, ...msg } = job;
      void prio;
      this.pool[w].postMessage(msg);
    }
  }

  // mesh (or re-mesh) bricks of a set; resolves when every one of them arrived
  meshBricks(config, keys) {
    const set = this.sets[config];
    const want = new Map();
    for (const key of keys) {
      const gen = (set.gen.get(key) || 0) + 1;
      set.gen.set(key, gen);
      want.set(key, gen);
    }
    const prio = config === 'live' && this.sets.live.ready ? 0 : 1;
    for (const k of keys) this._enqueue({ type: 'bricks', config, keys: [k], gens: [want.get(k)] }, prio);
    return new Promise((resolve) => (keys.length ? this.waiters.push({ config, want, resolve }) : resolve()));
  }

  meshAll(config) {
    return this.meshBricks(config, allBrickKeys()).then(() => { this.sets[config].ready = true; });
  }

  setAlive(ids, alive) {
    setAlive(ids, alive);
    this._broadcast({ type: 'alive', ids, alive });
  }

  // several clumps meshed as one piece; cached under a string key
  groupGeometry(key, ids, prio = 1) {
    if (this.clumpGeo.has(key)) return Promise.resolve(this.clumpGeo.get(key));
    if (!this.clumpWait.has(key)) {
      this.clumpWait.set(key, []);
      this._enqueue({ type: 'group', id: key, ids }, prio);
    }
    return new Promise((resolve) => this.clumpWait.get(key).push(resolve));
  }

  // the same clump as one fused clod (a torn sod in the turf world)
  sodGeometry(id, prio = 0) {
    const key = `sod:${id}`;
    if (this.clumpGeo.has(key)) return Promise.resolve(this.clumpGeo.get(key));
    if (!this.clumpWait.has(key)) {
      this.clumpWait.set(key, []);
      this._enqueue({ type: 'sod', id }, prio);
    }
    return new Promise((resolve) => this.clumpWait.get(key).push(resolve));
  }

  clumpGeometry(id, prio = 0) {
    if (this.clumpGeo.has(id)) return Promise.resolve(this.clumpGeo.get(id));
    if (!this.clumpWait.has(id)) {
      this.clumpWait.set(id, []);
      this._enqueue({ type: 'clump', id }, prio);
    } else if (prio === 0) {
      const j = this.queue.find((q) => q.type === 'clump' && q.id === id);
      if (j && j.prio) { this.queue.splice(this.queue.indexOf(j), 1); this._enqueue(j, 0); }
    }
    return new Promise((resolve) => this.clumpWait.get(id).push(resolve));
  }

  // the skin-depth grid, baked in a worker (once; later calls share it)
  skinDepth() {
    if (!this._skin) this._skin = new Promise((resolve) => { this._skinDone = resolve; this._enqueue({ type: 'skin' }, 0); });
    return this._skin;
  }

  _onMessage(d) {
    if (d.type === 'skin') { this._skinDone?.(d); return; }
    if (d.type === 'clump') {
      const g = d.m ? withTree(toGeometry(d.m), d) : null;
      this.clumpGeo.set(d.id, g);
      for (const r of this.clumpWait.get(d.id) || []) r(g);
      this.clumpWait.delete(d.id);
      return;
    }
    if (d.type !== 'brick') return;
    const set = this.sets[d.config];
    const fresh = !d.skipped && d.gen === set.gen.get(d.key); // older answers are dropped
    if (fresh) {
      let mesh = set.bricks.get(d.key);
      if (d.m) {
        const g = withTree(toGeometry(d.m), d);
        if (!mesh) {
          mesh = new THREE.Mesh(g, this.bodyMat);
          mesh.matrixAutoUpdate = false; // bricks sit at the set's origin
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.customDepthMaterial = this.bodyDepth;
          const pre = new THREE.Mesh(g, this.bodyPre);
          pre.matrixAutoUpdate = false;
          pre.renderOrder = -1;
          pre.raycast = () => {};
          mesh.add(pre);
          mesh.userData.partId = 'body';
          mesh.layers.enable(1);
          set.group.add(mesh);
          set.bricks.set(d.key, mesh);
          this.onBrick?.(mesh, d.config);
        } else {
          const old = mesh.geometry;
          mesh.geometry = g;
          for (const c of mesh.children) { c.geometry = g; if (c.isInstancedMesh) c.boundingSphere = null; } // fuzz shells share it
          old.disposeBoundsTree?.();
          old.dispose();
        }
        mesh.visible = true;
      } else if (mesh) {
        mesh.visible = false;
      }
    }
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (w.config !== d.config || !w.want.has(d.key) || d.gen < w.want.get(d.key)) continue;
      w.want.delete(d.key);
      if (!w.want.size) { w.resolve(); this.waiters.splice(i, 1); }
    }
  }

  showConfig(name) {
    for (const [k, s] of Object.entries(this.sets)) s.group.visible = k === name;
    this.config = name;
    // (its matrices were left alone while it was hidden)
    this.sets[name].group.updateMatrixWorld(true);
  }

  update(dt) {
    for (const p of this.parts) stepPart(p, dt, this);
  }

  stateFor(family) {
    const st = familyState(family);
    if (this.tints[family]) st.color.copy(this.tints[family]);
    return st;
  }

  morphTo(part, stateTo, origin, speed = 3.2) {
    if (part.morph) packState(part.morph.to, part.mat.userData.A);
    packState(stateTo, part.mat.userData.B);
    part.morph = { to: stateTo, origin: origin.clone(), r: 0, speed, max: 14 };
    part.u.uMorph.value.set(origin.x, origin.y, origin.z, 0);
    part.family = stateTo.name;
    this.onMorphStart?.(part, stateTo);
  }

  materialWave(originWorld, family) {
    const local = this.container.worldToLocal(originWorld.clone());
    this.morphTo(this.body, this.stateFor(family), local, 3.4);
  }

  colorWave(originWorld, tints, speed = 3.4) {
    this.tints = tints;
    const p = this.body;
    const local = this.container.worldToLocal(originWorld.clone());
    // a sky tints the families it knows; others (another world's) keep their own colour
    const c = tints[p.family] || familyState(p.family).color;
    p.drops.push({ p: local, c: c.clone(), r: 0, max: 16, speed, bakeAt: 15, a: 1 });
  }

  ripple(part, localPoint, amp = 0.03) {
    part.u.uRipple.value.set(localPoint.x, localPoint.y, localPoint.z, 0);
    part.u.uRippleAmp.value.x = amp;
    part.rippleAge = 0;
  }

  addDrop(part, localPoint, color, max = 1.4, speed = 2.2, strength = 0.78) {
    part.drops.push({ p: localPoint.clone(), c: color.clone(), r: 0, max, speed, bakeAt: 0, a: strength });
    if (part.drops.length > 24) part.drops.shift();
  }

  meshes(out = []) {
    for (const m of this.sets[this.config].bricks.values()) if (m.visible) out.push(m);
    return out;
  }

  // share of the original puffs still in the house
  remaining() {
    let n = 0;
    for (let i = 0; i < ALIVE.length; i++) n += ALIVE[i];
    return n / ALIVE.length;
  }
}
