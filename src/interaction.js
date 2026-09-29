import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Touching one continuous cloud:
//  hover  — the surface sinks a little under the finger
//  press  — a deep soft dent; the cloud re-inflates slowly
//  pull   — drag away from the surface: the material under the finger is
//           drawn out, thins, and tears off; the piece stays in the hand
//  carry  — a loose piece in the hand (see below)
//  paint  — the brush lays pigment on whatever the ray hits first: the house
//           or a loose piece. It never grabs and never tears.
//  material — a tap turns the house into the next substance
//  look   — curated states (inside, apart): dragging only turns the view
//
// Input, by state:
//   nothing held   wheel = camera distance · RMB drag = camera orbit
//   piece in hand  LMB move = move it across the view · wheel = push / pull it
//                  in depth · RMB (while LMB stays down) = turn the piece.
//                  The camera does not move while a piece is held.
// Releasing LMB lets the piece go into the physics with the hand's velocity
// and a little of the turn. The context menu is suppressed on the canvas only.

const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

export class Interaction {
  constructor({ dom, camera, house, tearing, rig, cursor }) {
    this.dom = dom;
    this.camera = camera;
    this.house = house;
    this.tearing = tearing;
    this.rig = rig;
    this.cursor = cursor;
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2(-9, -9);
    this.mode = 'idle';
    this.tool = 'touch';
    this.enabled = true;
    this.active = null;
    this.plane = new THREE.Plane();
    this.lastPaint = null;
    this.onTap = null;
    this.onDetach = null;
    this.paint = null; // PaintManager
    this.flowers = null; // FlowerField (turf world)
    // the brush: set by the paint panel. kind: 'paint' lays pigment, 'flowers'
    // grows wildflowers (the eraser takes away whichever the brush lays)
    this.brush = { kind: 'paint', color: new THREE.Color('#c3b3dd'), radius: 0.5, softness: 0.6, opacity: 0.45, erase: false };
    this._v = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this.handVel = new THREE.Vector3();
    this.lastHand = new THREE.Vector3();
    this.pending = false;
    this.hovering = false;
    this.carry = null;

    dom.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', () => this.up());
    window.addEventListener('pointercancel', () => this.up());
    dom.addEventListener('pointerleave', () => { if (this.mode === 'idle') { this.ndc.set(-9, -9); this.pending = true; } });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
      const d = e.deltaY * unit;
      if (this.carry) { this.depth(d); return; } // the piece, not the camera
      this.rig.wheel(d);
    }, { passive: false });
  }

  setNdc(e) {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  pick() {
    this.ray.setFromCamera(this.ndc, this.camera);
    const targets = this._targets || (this._targets = []);
    targets.length = 0;
    this.tearing.meshes(this.house.meshes(targets));
    const hits = this.ray.intersectObjects(targets, false);
    if (!hits.length) return null;
    const h = hits[0];
    const piece = h.object.userData.piece;
    if (piece) {
      // the piece's own frame: rotation and position undone
      return { piece, point: h.point, local: h.object.worldToLocal(h.point.clone()), normal: h.face.normal.clone() };
    }
    const b = this.house.body;
    const local = this.house.container.worldToLocal(h.point.clone());
    // bricks carry no rotation: object-space normal = house-frame normal
    return { part: b, point: h.point, local, normal: h.face.normal.clone() };
  }

  handPoint(out) {
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  down(e) {
    if (!this.enabled) return;
    // right button (alone): orbit only, whatever lies under the cursor
    if (e.button === 2) {
      if (this.mode !== 'idle') return;
      this.mode = 'orbit';
      this.rig.beginDrag(e.clientX, e.clientY);
      this.cursor.setState('turn', true);
      return;
    }
    if (e.button > 0) return;
    this.setNdc(e);
    const hit = this.tool === 'look' ? null : this.pick();
    if (!hit) {
      this.mode = 'orbit';
      this.rig.beginDrag(e.clientX, e.clientY);
      this.cursor.setState('turn', true);
      return;
    }
    // the brush paints what it touches, piece or house; it never grabs
    if (this.tool === 'paint') {
      this.mode = 'paint';
      this.paintAt(hit);
      this.cursor.setState(this.brush.erase ? 'erase' : 'paint', true);
      return;
    }
    this.camera.getWorldDirection(this._v);
    this.plane.setFromNormalAndCoplanarPoint(this._v, hit.point);
    this.lastHand.copy(hit.point);
    this.handVel.set(0, 0, 0);
    if (hit.piece) {
      if (hit.piece.state !== 'free') return;
      this.grab(hit.piece, hit.point);
      return;
    }
    const b = hit.part;
    if (this.tool === 'material' && this.onTap) this.onTap(b, hit.local, hit.point);
    this.mode = 'press';
    this.active = { start: hit.point.clone(), normal: hit.normal.clone(), local: hit.local.clone() };
    b.pressPoint.copy(hit.local);
    b.pressDir.copy(hit.normal);
    b.u.uPressN.value.w = 0.85;
    b.press.target = 0.34;
    this.cursor.setState('press', true);
  }

  // --- a piece in the hand -----------------------------------------------------
  grab(pc, at, fromTear = false) {
    this.onGrab?.(pc, fromTear);
    const point = at.clone();
    this.mode = 'carry';
    // the camera holds still while a piece is in the hand (no cursor parallax)
    this.rig.holdStill = true;
    pc.returning = null;
    pc.sleeping = false;
    pc.hold = point.clone();
    pc.rotGoal = pc.mesh.quaternion.clone();
    pc.spin.set(0, 0, 0);
    this.camera.getWorldDirection(this._d);
    const depth = this._v.subVectors(point, this.camera.position).dot(this._d);
    this.plane.setFromNormalAndCoplanarPoint(this._d, point);
    this.carry = {
      piece: pc, depth, depthGoal: depth, offset: new THREE.Vector3(),
      rotating: false, lx: 0, ly: 0, spin: new THREE.Vector3(), lastTurn: 0,
    };
    this.active = { piece: pc };
    this.cursor.setState('move', true);
  }

  // wheel while holding: along the view, closer or farther
  depth(delta) {
    const c = this.carry;
    const d = THREE.MathUtils.clamp(delta, -140, 140);
    c.depthGoal = THREE.MathUtils.clamp(c.depthGoal + d * 0.012, 4, 42);
    this.cursor.flash('depth');
  }

  // RMB with the piece in hand: turn it about the view's up and side axes
  turn(dx, dy) {
    const c = this.carry, pc = c.piece;
    const cam = this.camera;
    const up = this._v.set(0, 1, 0).applyQuaternion(cam.quaternion);
    const side = this._d.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const ay = THREE.MathUtils.clamp(dx * 0.009, -0.35, 0.35), ax = THREE.MathUtils.clamp(dy * 0.009, -0.35, 0.35);
    const q = new THREE.Quaternion().setFromAxisAngle(up, ay).multiply(new THREE.Quaternion().setFromAxisAngle(side, ax));
    pc.rotGoal.premultiply(q);
    // smoothed angular velocity, for a soft spin on release
    const now = performance.now();
    const sec = Math.max(0.008, (now - c.lastTurn) / 1000);
    c.lastTurn = now;
    const w = up.clone().multiplyScalar(ay / sec).addScaledVector(side, ax / sec);
    c.spin.lerp(w, 0.35);
  }

  release() {
    const c = this.carry;
    if (!c) return;
    const pc = c.piece;
    pc.hold = null;
    pc.rotGoal = null;
    // a flick of the wrist keeps a little of the turn
    if (performance.now() - c.lastTurn < 120) pc.spin.copy(c.spin).clampLength(0, 2.2).multiplyScalar(0.35);
    this.carry = null;
    this.rig.holdStill = false;
    this.onRelease?.(pc);
  }

  // paint stays where it is laid: dabs along the stroke build up coverage
  paintAt(hit) {
    if (this.brush.kind === 'flowers') {
      if (!this.flowers) return;
      const on = hit.piece || this.house;
      const lf = this.lastPaint;
      if (lf && lf.vol === on && lf.local.distanceTo(hit.local) < Math.max(0.06, this.brush.radius * 0.28)) return;
      this.flowers.dab(hit, this.brush);
      this.lastPaint = { vol: on, local: hit.local.clone() };
      return;
    }
    if (!this.paint) return;
    const vol = hit.piece ? hit.piece.paintVol : this.paint.house;
    if (!vol) return; // a piece still attached reads the house paint
    const lp = this.lastPaint;
    if (lp && lp.vol === vol && lp.local.distanceTo(hit.local) < Math.max(0.06, this.brush.radius * 0.28)) return;
    this.paint.paint(vol, hit.local, hit.normal, this.brush);
    this.lastPaint = { vol, local: hit.local.clone() };
  }

  move(e) {
    this.setNdc(e);
    this.cursor.move(e.clientX, e.clientY);
    this.pending = true;
    if (this.mode === 'orbit') { this.rig.drag(e.clientX, e.clientY); return; }
    if (this.mode === 'carry' && this.carry) {
      const c = this.carry;
      // LMB let go while RMB is still down: the piece is released
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) { this.up(); return; }
      if (e.buttons & 2) {
        if (!c.rotating) { c.rotating = true; c.lx = e.clientX; c.ly = e.clientY; this.cursor.setState('rotate', true); return; }
        this.turn(e.clientX - c.lx, e.clientY - c.ly);
        c.lx = e.clientX; c.ly = e.clientY;
        return;
      }
      if (c.rotating) {
        // back to moving: re-anchor so the piece does not jump to the cursor
        c.rotating = false;
        if (this.handPoint(this._v)) c.offset.subVectors(c.piece.hold, this._v);
        this.cursor.setState('move', true);
        return;
      }
      if (!this.handPoint(this._v)) return;
      c.piece.hold.copy(this._v).add(c.offset);
      return;
    }
    if (this.mode === 'pull') {
      if (!this.handPoint(this._v)) return;
      this.handVel.subVectors(this._v, this.lastHand).multiplyScalar(60);
      this.lastHand.copy(this._v);
      // a barely-there drift toward the hand, no zoom
      this.rig.lean(this._v.clone().lerp(this.active.start, 0.55), 0.06);
      if (this.tearing.drag(this._v)) {
        const pc = this.tearing.tear(this.handVel);
        this.rig.lean(null);
        if (pc) {
          this.grab(pc, this._v, true);
          this.cursor.flash('torn');
        } else this.mode = 'idle';
        this.onDetach?.();
      }
      return;
    }
    if (this.mode === 'press') {
      // dragging away from the surface turns a press into a pull
      if (this.tool === 'touch' && this.handPoint(this._v) && this._v.distanceTo(this.active.start) > 0.25) {
        this.house.body.press.target = 0;
        if (this.tearing.begin(this.active.start, this.active.normal)) {
          this.mode = 'pull';
          this.lastHand.copy(this._v);
          this.cursor.setState('pull', true);
        }
        return;
      }
      const hit = this.pick();
      if (hit && hit.part) hit.part.pressPoint.lerp(hit.local, 0.4);
      return;
    }
    if (this.mode === 'paint') {
      if (e.buttons & 2) return; // a right button never paints
      const hit = this.pick();
      if (hit) this.paintAt(hit);
    }
  }

  up() {
    const b = this.house.body;
    if (this.mode === 'orbit') this.rig.endDrag();
    if (this.mode === 'pull') { this.tearing.cancel(); this.rig.lean(null); }
    if (this.mode === 'carry') { this.release(); this.rig.lean(null); }
    if (this.mode === 'press') {
      b.press.target = 0;
      this.house.ripple(b, b.pressPoint, 0.035);
    }
    if (this.mode === 'paint') { this.lastPaint = null; this.paint?.end(); this.flowers?.end(); }
    this.mode = 'idle';
    this.active = null;
    this.cursor.setState(null, false);
    this.pending = true;
  }

  reassembleAll() { this.tearing.reassemble(); }

  frame(dt = 1 / 60) {
    // a held piece: its depth eases toward the wheel's goal and the hand
    // point follows the plane even when the mouse is still
    const c = this.carry;
    if (c) {
      if (c.piece.state !== 'free') { this.carry = null; this.mode = 'idle'; this.rig.holdStill = false; return; }
      c.depth = damp(c.depth, c.depthGoal, 9, dt);
      this.camera.getWorldDirection(this._d);
      this.plane.setFromNormalAndCoplanarPoint(this._d, this._v.copy(this.camera.position).addScaledVector(this._d, c.depth));
      if (!c.rotating && this.handPoint(this._v)) {
        c.piece.hold.copy(this._v).add(c.offset);
        // never so far that it is lost
        const home = this.house.group.position;
        if (c.piece.hold.distanceTo(home) > 14) c.piece.hold.sub(home).setLength(14).add(home);
      }
      return;
    }
    if (this.mode !== 'idle' || !this.pending || !this.enabled) return;
    this.pending = false;
    const hit = this.ndc.x < -2 || this.tool === 'look' ? null : this.pick();
    const b = this.house.body;
    if (hit && hit.part) {
      if (this.tool === 'touch') {
        if (!this.hovering) b.pressPoint.copy(hit.local);
        b.pressPoint.lerp(hit.local, 0.35);
        b.pressDir.copy(hit.normal);
        b.u.uPressN.value.w = 0.55;
        b.press.target = 0.05;
      }
      this.hovering = true;
      this.cursor.setState(this.tool === 'paint' ? (this.brush.erase ? 'erase' : 'paint') : this.tool === 'material' ? 'transform' : 'pull', false);
    } else {
      if (this.hovering) b.press.target = 0;
      this.hovering = false;
      const verb = hit && hit.piece ? (this.tool === 'paint' ? (this.brush.erase ? 'erase' : 'paint') : 'grab') : null;
      this.cursor.setState(verb, false);
    }
  }
}
