import * as THREE from 'three';
import { createHouseMaterial } from '../render/houseMaterial.js';

// A taffy-like bridge between a pulled part and the house.
// Geometry is rebuilt on the CPU every frame (≈1.5k vertices).
// Before the break: one hourglass tube A→B. After: two stubs retracting.

const SEG = 40;   // along
const RAD = 28;   // around

export class Neck {
  constructor(shared, state) {
    this.count = (SEG + 1) * (RAD + 1);
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(this.count * 2 * 3);
    this.nor = new Float32Array(this.count * 2 * 3);
    const bake = new Uint8Array(this.count * 2 * 4);
    for (let i = 0; i < this.count * 2; i++) bake.set([235, 235, 190, 255], i * 4);
    const idx = [];
    for (let s = 0; s < 2; s++) {
      const o = s * this.count;
      for (let i = 0; i < SEG; i++) {
        for (let j = 0; j < RAD; j++) {
          const a = o + i * (RAD + 1) + j, b = a + RAD + 1;
          idx.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('bake', new THREE.BufferAttribute(bake, 4, true));
    const bake2 = new Uint8Array(this.count * 2 * 4);
    for (let i = 0; i < this.count * 2; i++) bake2.set([255, 255, 0, 0], i * 4);
    g.setAttribute('bake2', new THREE.BufferAttribute(bake2, 4, true));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    this.mat = createHouseMaterial(shared, state, state, false);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.visible = false;
    this.A = new THREE.Vector3();
    this.B = new THREE.Vector3();
    this.rA = 0.4;
    this.rB = 0.35;
    this.breakT = -1; // <0: intact, else seconds since break
    this.snapLen = 0;
    this._frame = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  }

  // stretch01: 0 = relaxed, 1 = at breaking point
  update(dt, stretch01) {
    const g = this.mesh.geometry;
    const d = new THREE.Vector3().subVectors(this.B, this.A);
    const len = d.length();
    if (this.breakT < 0 && len < 0.02) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const dir = len > 1e-4 ? d.clone().divideScalar(len) : new THREE.Vector3(0, 1, 0);
    const [t1, t2] = this._frame;
    t1.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.9) t1.set(1, 0, 0);
    t1.crossVectors(dir, t1).normalize();
    t2.crossVectors(dir, t1).normalize();

    if (this.breakT < 0) {
      // hourglass: thins in the middle as it stretches, sags very slightly
      const waist = THREE.MathUtils.lerp(0.92, 0.14, Math.pow(stretch01, 1.7));
      this._tube(0, (t) => {
        const c = this.A.clone().lerp(this.B, t);
        c.y -= Math.sin(Math.PI * t) * 0.06 * len;
        const end = THREE.MathUtils.lerp(this.rA, this.rB, t);
        const flare = 1 + 0.55 * (Math.exp(-t * 9) + Math.exp(-(1 - t) * 9));
        const r = end * THREE.MathUtils.lerp(1, waist, Math.pow(Math.sin(Math.PI * t), 0.7)) * flare;
        return [c, r];
      }, dir, t1, t2);
      this._collapse(1);
    } else {
      // two stubs retract with an elastic overshoot
      this.breakT += dt;
      const k = this.breakT;
      const s = Math.max(0, 0.5 * Math.exp(-k * 5.5) * Math.cos(k * 9) + 0.5 * Math.exp(-k * 7)) * this.snapLen;
      const stub = (from, towards, r0, slot) => {
        const dd = towards.clone().sub(from).normalize();
        this._tube(slot, (t) => {
          const c = from.clone().addScaledVector(dd, t * s);
          const tip = Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.2)));
          const flare = 1 + 0.55 * Math.exp(-t * 7);
          return [c, r0 * 0.55 * tip * flare];
        }, dd, t1, t2);
      };
      stub(this.A, this.B, this.rA, 0);
      stub(this.B, this.A, this.rB, 1);
      if (s < 0.004 && k > 0.6) { this.mesh.visible = false; }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
  }

  _collapse(slot) {
    const o = slot * this.count * 3;
    this.pos.fill(0, o, o + this.count * 3);
  }

  _tube(slot, fn, dir, t1, t2) {
    const o = slot * this.count;
    let prevC = null, prevR = 0;
    const samples = [];
    for (let i = 0; i <= SEG; i++) samples.push(fn(i / SEG));
    for (let i = 0; i <= SEG; i++) {
      const [c, r] = samples[i];
      // radius slope tilts the normal along the tube
      const rn = samples[Math.min(i + 1, SEG)][1], rp = samples[Math.max(i - 1, 0)][1];
      const cn = samples[Math.min(i + 1, SEG)][0], cp = samples[Math.max(i - 1, 0)][0];
      const ds = Math.max(cn.distanceTo(cp), 1e-4);
      const slope = (rn - rp) / ds;
      for (let j = 0; j <= RAD; j++) {
        const a = (j / RAD) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = t1.x * ca + t2.x * sa, ny = t1.y * ca + t2.y * sa, nz = t1.z * ca + t2.z * sa;
        const k = (o + i * (RAD + 1) + j) * 3;
        this.pos[k] = c.x + nx * r; this.pos[k + 1] = c.y + ny * r; this.pos[k + 2] = c.z + nz * r;
        let mx = nx - dir.x * slope, my = ny - dir.y * slope, mz = nz - dir.z * slope;
        const l = Math.hypot(mx, my, mz) || 1;
        this.nor[k] = mx / l; this.nor[k + 1] = my / l; this.nor[k + 2] = mz / l;
      }
      prevC = c; prevR = r;
    }
  }
}
