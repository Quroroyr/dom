import * as THREE from 'three';
import { createHouseMaterial } from '../render/houseMaterial.js';
import { familyState } from '../render/families.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Cotton-candy mechanics for the pullable tufts.
//
//  Wisp      — while a tuft is being pulled, a strand of small cloud puffs
//              stretches between it and the house; it thins, trembles and,
//              past the breaking point, bursts into dissolving wisps.
//  FreeCloud — the torn-off tuft keeps living as a small free cloud: it can be
//              carried, left floating, and called back to merge into the house.
//  Regrowth  — the house re-inflates the torn tuft in place (scale 0 → 1).

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpV = new THREE.Vector3();

function puffGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const n = g.attributes.position.count;
  // lumpy: displace the unit sphere a little so each puff is not a ball
  const p = g.attributes.position;
  for (let i = 0; i < n; i++) {
    tmpV.fromBufferAttribute(p, i);
    const k = 1 + 0.08 * Math.sin(tmpV.x * 5.1 + tmpV.y * 3.3) * Math.cos(tmpV.z * 4.7 - tmpV.y * 2.1);
    tmpV.multiplyScalar(k);
    p.setXYZ(i, tmpV.x, tmpV.y, tmpV.z);
  }
  g.computeVertexNormals();
  const bake = new Uint8Array(n * 4);
  const bake2 = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { bake.set([240, 240, 200, 250], i * 4); bake2.set([255, 255, 0, 0], i * 4); }
  g.setAttribute('bake', new THREE.BufferAttribute(bake, 4, true));
  g.setAttribute('bake2', new THREE.BufferAttribute(bake2, 4, true));
  return g;
}

// a few small cotton clumps for pinched-off pieces
function pieceGeometry(seed) {
  let sd = seed * 9301 + 49297;
  const rnd = () => ((sd = (sd * 9301 + 49297) % 233280) / 233280);
  const parts = [];
  const n = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const r = 0.3 + rnd() * 0.24;
    const g = puffGeometry().scale(r, r * (0.85 + rnd() * 0.3), r);
    const a = rnd() * Math.PI * 2, e = (rnd() - 0.4) * 1.2, d = i === 0 ? 0 : 0.26 + rnd() * 0.22;
    g.translate(Math.cos(a) * Math.cos(e) * d, Math.sin(e) * d, Math.sin(a) * Math.cos(e) * d);
    parts.push(g);
  }
  const m = mergeGeometries(parts, false);
  m.computeBoundingSphere();
  m.computeBoundingBox();
  return m;
}

const COUNT = 30;

export class Wisp {
  constructor(shared, geo) {
    this.mat = createHouseMaterial(shared, familyState('cloud'), familyState('cloud'), false);
    this.mesh = new THREE.InstancedMesh(geo, this.mat, COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    this.mesh.layers.enable(1);
    this.A = new THREE.Vector3();
    this.B = new THREE.Vector3();
    this.rA = 0.35;
    this.rB = 0.3;
    // loose cotton: each puff sits a little off the axis, sizes vary
    this.jit = Array.from({ length: COUNT }, () => [Math.random(), Math.random() * Math.PI * 2, 0.6 + Math.random() * 0.6, Math.random()]);
    this.bits = null; // after a tear: dissolving puffs
    this.t = 0;
  }

  setColor(c) { this.mat.userData.A.color.copy(c); this.mat.userData.B.color.copy(c); }

  update(dt, stretch01, active) {
    this.t += dt;
    if (this.bits) return this._dissolve(dt);
    const d = tmpV.subVectors(this.B, this.A);
    const len = d.length();
    if (!active || len < 0.06) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const dir = d.clone().divideScalar(len);
    const side = new THREE.Vector3(0, 1, 0).cross(dir);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const up = dir.clone().cross(side).normalize();
    const waist = THREE.MathUtils.lerp(0.95, 0.28, Math.pow(stretch01, 1.6));
    const tremble = 0.05 + stretch01 * 0.1;
    for (let i = 0; i < COUNT; i++) {
      const [r0, ph, sz, off] = this.jit[i];
      const t = Math.min(1, (i + 0.5) / COUNT + (r0 - 0.5) * 0.04);
      const s = Math.sin(Math.PI * t);
      const c = this.A.clone().lerp(this.B, t);
      const wob = Math.sin(this.t * 7 + ph) * tremble * s * len * 0.25;
      const r = THREE.MathUtils.lerp(this.rA, this.rB, t) * THREE.MathUtils.lerp(1, waist, Math.pow(s, 0.8)) * sz;
      const rad = r * 0.55 * off;
      c.addScaledVector(side, wob * Math.cos(ph) + Math.cos(ph * 3.1) * rad).addScaledVector(up, wob * Math.sin(ph) - s * 0.05 * len + Math.sin(ph * 3.1) * rad);
      tmpQ.setFromAxisAngle(dir, ph + this.t * 0.3);
      tmpS.set(r, r * 1.15, r);
      tmpM.compose(c, tmpQ, tmpS);
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // strand bursts: puffs drift apart, rise a little and fade away (shrink)
  tear() {
    const mid = this.A.clone().lerp(this.B, 0.5);
    this.bits = [];
    for (let i = 0; i < COUNT; i++) {
      this.mesh.getMatrixAt(i, tmpM);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      tmpM.decompose(p, q, s);
      const v = p.clone().sub(mid).multiplyScalar(1.6).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6));
      this.bits.push({ p, q, s0: s.x, v, life: 0.9 + Math.random() * 0.8 });
    }
    this.age = 0;
  }

  _dissolve(dt) {
    this.age += dt;
    let alive = false;
    this.bits.forEach((b, i) => {
      b.v.multiplyScalar(Math.exp(-dt * 2.2));
      b.p.addScaledVector(b.v, dt);
      const k = Math.max(0, 1 - this.age / b.life);
      if (k > 0) alive = true;
      const r = b.s0 * (0.4 + 0.6 * k) * Math.min(1, k * 3);
      tmpS.set(r, r, r);
      tmpM.compose(b.p, b.q, tmpS);
      this.mesh.setMatrixAt(i, tmpM);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!alive) { this.bits = null; this.mesh.visible = false; }
  }
}

// ---------------------------------------------------------------------------

export class Tufts {
  constructor({ house, shared, scene }) {
    this.house = house;
    this.shared = shared;
    this.scene = scene;
    this.puff = puffGeometry();
    this.wisps = {};
    this.free = []; // free-floating clouds
    this.center = new THREE.Vector3();
    for (const p of house.parts) {
      if (!p.def.grab) continue;
      const w = new Wisp(shared, this.puff);
      this.wisps[p.id] = w;
      scene.add(w.mesh);
      // anchor: where the tuft sits on the house (toward the house core)
      const room = house.roomCenter;
      const dir = room.clone().sub(p.home).normalize();
      const r = p.mesh.geometry.boundingSphere.radius;
      p.anchor = p.home.clone().addScaledVector(dir, r * 0.55);
      p.anchorR = r * 0.42;
    }
    this.onReveal = null;
    this.pieces = [0, 1, 2, 3].map((i) => pieceGeometry(i + 3));
    this.pinchWisp = new Wisp(shared, this.puff);
    scene.add(this.pinchWisp.mesh);
    this.pinch = null;
    this.sinking = [];
  }

  // --- pinch: draw a clump of cotton out of any point of the cloud ---------
  beginPinch(part, worldPoint) {
    const geo = this.pieces[Math.floor(Math.random() * this.pieces.length)];
    const mat = createHouseMaterial(this.shared, part.state, part.state, false);
    mat.userData.A.color.copy(part.mat.userData.A.color);
    mat.userData.B.color.copy(part.mat.userData.A.color);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.layers.enable(1);
    mesh.position.copy(worldPoint);
    mesh.scale.setScalar(0.05);
    this.scene.add(mesh);
    const local = part.mesh.worldToLocal(worldPoint.clone());
    this.pinch = { part, local, mesh, mat, u: mat.userData.uniforms, anchor: worldPoint.clone(), dist: 0 };
    this.onSpawn?.({ mesh, mat, u: mat.userData.uniforms });
    return this.pinch;
  }

  // hand = world point under the finger; returns true when it tears
  dragPinch(hand) {
    const pc = this.pinch;
    if (!pc) return false;
    pc.anchor.copy(pc.local);
    pc.part.mesh.localToWorld(pc.anchor);
    const raw = hand.clone().sub(pc.anchor);
    const L = raw.length();
    const eff = L * (0.35 + 0.55 * THREE.MathUtils.smoothstep(L, 0.2, 2.0));
    pc.dist = eff;
    const target = pc.anchor.clone().addScaledVector(raw.normalize(), eff);
    pc.mesh.position.lerp(target, 0.35);
    // the clump grows as it is drawn out of the mass
    pc.mesh.scale.setScalar(THREE.MathUtils.clamp(0.45 + eff * 0.5, 0.45, 1.0));
    // the cloud answers: the spot sinks as cotton is taken from it
    pc.part.pressPoint.copy(pc.local);
    pc.part.press.target = Math.min(eff * 0.3, 0.4);
    return eff > 1.45;
  }

  tearPinch(velocity) {
    const pc = this.pinch;
    if (!pc) return null;
    this.pinch = null;
    const w = this.pinchWisp;
    w.A.copy(pc.anchor);
    w.B.copy(pc.mesh.position);
    w.tear();
    const fc = {
      mesh: pc.mesh, mat: pc.mat, u: pc.u, from: null, fromPart: pc.part, fromLocal: pc.local,
      vel: velocity.clone().multiplyScalar(0.4), bob: Math.random() * 6, hold: null, stretch: 0, returning: null,
    };
    pc.mesh.userData.freeCloud = fc;
    this.free.push(fc);
    // the dent slowly re-inflates
    pc.part.press.target = 0;
    pc.part.press.k = 14;
    setTimeout(() => (pc.part.press.k = 55), 2600);
    this.house.ripple(pc.part, pc.local, 0.035);
    return fc;
  }

  // released before tearing: the clump sinks back into the mass
  cancelPinch() {
    const pc = this.pinch;
    if (!pc) return;
    this.pinch = null;
    pc.returning = { t: 0, from: pc.mesh.position.clone(), s0: pc.mesh.scale.x };
    pc.part.press.target = 0;
    this.sinking.push(pc);
  }

  // world-space point on the tuft that is attached to the house
  attachPoint(p, out) {
    return out.copy(p.anchor).sub(p.home).applyQuaternion(p.mesh.quaternion).multiplyScalar(p.mesh.scale.x).add(p.mesh.position).add(this.house.group.position);
  }

  // the anchor follows choreographed layouts (open / explode) but not the pull
  anchorWorld(p, out) {
    return out.copy(p.anchor).add(this.house.targetBase(p, tmpS)).add(this.house.group.position);
  }

  // called when the user pulls past breaking point
  tear(p, velocity) {
    const w = this.wisps[p.id];
    // the free cloud takes over the tuft's current look and transform
    const mat = createHouseMaterial(this.shared, p.state, p.state, false);
    mat.userData.A.color.copy(p.mat.userData.A.color);
    mat.userData.B.color.copy(p.mat.userData.A.color);
    const mesh = new THREE.Mesh(p.mesh.geometry, mat);
    mesh.position.copy(p.mesh.position).add(this.house.group.position);
    mesh.quaternion.copy(p.mesh.quaternion);
    mesh.castShadow = true;
    mesh.layers.enable(1);
    mesh.userData.free = true;
    this.scene.add(mesh);
    const fc = {
      mesh, mat, u: mat.userData.uniforms, from: p, vel: velocity.clone().multiplyScalar(0.4), bob: Math.random() * 6,
      hold: null, stretch: 0, returning: null, geoCenter: p.home.clone(),
    };
    mesh.userData.freeCloud = fc;
    this.free.push(fc);
    this.onSpawn?.(fc);

    // strand bursts
    this.attachPoint(p, w.B);
    this.anchorWorld(p, w.A);
    w.tear();
    // the house re-inflates the tuft, a moment later
    p.user.set(0, 0, 0);
    p.pos.x.set(0, 0, 0);
    p.pos.v.set(0, 0, 0);
    p.grow.x = 0.001; p.grow.v = 0; p.grow.target = 0.001;
    p.torn = true;
    setTimeout(() => { p.grow.target = 1; p.torn = false; }, 1400);
    this.house.ripple(p, new THREE.Vector3(), 0.04);
    if (p.def.plug !== null && p.def.plug !== undefined) this.onReveal?.(p.def.plug, p);
    return fc;
  }

  // call every free cloud back; each flies home and melts into its tuft
  reassemble() {
    this.free.forEach((fc, i) => {
      if (fc.returning) return;
      fc.returning = { t: -i * 0.12, from: fc.mesh.position.clone(), s0: fc.mesh.scale.x };
    });
  }

  update(dt, time, pull) {
    // strands for tufts being pulled (still attached)
    for (const p of this.house.parts) {
      if (!p.def.grab) continue;
      const w = this.wisps[p.id];
      const pulling = pull && pull.part === p && !p.torn;
      const own = p.pos.x.distanceTo(this.house.targetBase(p, tmpV));
      if (!pulling && own < 0.05) p.springBack = false;
      if (pulling || (!w.bits && p.springBack && own > 0.08 && !p.torn)) {
        this.anchorWorld(p, w.A);
        this.attachPoint(p, w.B);
        w.rA = p.anchorR * 1.3;
        w.rB = p.anchorR * 1.05;
        const s = THREE.MathUtils.clamp(w.A.distanceTo(w.B) / (p.breakAt || 1.3), 0, 1);
        w.update(dt, s, true);
      } else {
        w.update(dt, 0, false);
      }
    }

    // pinch strand
    const pw = this.pinchWisp;
    if (this.pinch) {
      pw.A.copy(this.pinch.anchor);
      pw.B.copy(this.pinch.mesh.position);
      pw.rA = 0.42;
      pw.rB = 0.32 * this.pinch.mesh.scale.x + 0.1;
      pw.update(dt, THREE.MathUtils.clamp(this.pinch.dist / 1.45, 0, 1), true);
    } else pw.update(dt, 0, false);
    for (let i = this.sinking.length - 1; i >= 0; i--) {
      const pc = this.sinking[i];
      pc.returning.t += dt / 0.45;
      const k = Math.min(pc.returning.t, 1);
      const anchor = pc.part.mesh.localToWorld(pc.local.clone());
      pc.mesh.position.lerpVectors(pc.returning.from, anchor, k * k);
      pc.mesh.scale.setScalar(Math.max(0.001, pc.returning.s0 * (1 - k)));
      if (k >= 1) {
        this.scene.remove(pc.mesh);
        pc.mat.dispose();
        this.sinking.splice(i, 1);
        this.house.ripple(pc.part, pc.local, 0.03);
      }
    }

    // free clouds drift, bob, answer the hand, or fly home
    for (let i = this.free.length - 1; i >= 0; i--) {
      const fc = this.free[i];
      fc.u.uTime.value = time;
      if (fc.returning) {
        const r = fc.returning;
        r.t += dt / 1.5;
        const k = THREE.MathUtils.clamp(r.t, 0, 1);
        const e = k * k * (3 - 2 * k);
        const home = fc.from ? fc.from.mesh.position.clone().add(this.house.group.position) : fc.fromPart.mesh.localToWorld(fc.fromLocal.clone());
        fc.mesh.position.lerpVectors(r.from, home, e);
        fc.mesh.position.y += Math.sin(Math.PI * e) * 0.8;
        fc.mesh.scale.setScalar(r.s0 * (1 - 0.7 * e));
        if (k >= 1) {
          // merge: the tuft swallows it with a soft pulse
          this.scene.remove(fc.mesh);
          fc.mat.dispose();
          this.free.splice(i, 1);
          if (fc.from) {
            const p = fc.from;
            p.grow.x = Math.max(p.grow.x, 0.8);
            p.grow.v += 3.2;
            this.house.ripple(p, new THREE.Vector3(), 0.05);
          } else {
            // merging back: a small swell where it lands
            fc.fromPart.pressPoint.copy(fc.fromLocal);
            fc.fromPart.press.x = -0.12;
            this.house.ripple(fc.fromPart, fc.fromLocal, 0.045);
          }
        }
        continue;
      }
      if (fc.hold) {
        fc.vel.subVectors(fc.hold, fc.mesh.position).multiplyScalar(9);
        fc.mesh.position.lerp(fc.hold, 1 - Math.exp(-dt * 12));
      } else {
        fc.vel.multiplyScalar(Math.exp(-dt * 1.4));
        fc.vel.y += Math.sin(time * 0.8 + fc.bob) * 0.02;
        fc.mesh.position.addScaledVector(fc.vel, dt);
        if (fc.mesh.position.y < 0.7) { fc.mesh.position.y = 0.7; fc.vel.y = Math.abs(fc.vel.y) * 0.5; }
      }
      // squash and stretch from motion
      const sp = fc.vel.length();
      fc.stretch += (Math.min(sp * 0.04, 0.25) - fc.stretch) * (1 - Math.exp(-dt * 10));
      if (sp > 0.05) {
        tmpQ.copy(fc.mesh.quaternion).invert();
        tmpV.copy(fc.vel).normalize().applyQuaternion(tmpQ);
        fc.u.uStretch.value.set(tmpV.x, tmpV.y, tmpV.z, fc.stretch);
      }
      fc.mesh.rotation.y += dt * 0.08;
    }
  }

  meshes() {
    return this.free.map((f) => f.mesh);
  }
}
