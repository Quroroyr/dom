import * as THREE from 'three';

// Camera rig: the scene director sets a base pose (target, yaw, pitch,
// distance, fov); the visitor adds an inspection offset on top of it —
// orbit (drag empty space, or right-drag anywhere on the canvas) and a
// distance factor (mouse wheel); the cursor adds a whisper of parallax.
//
//   camera = scene pose  ⊕  user orbit (yaw, pitch)  ⊗  user zoom (distance)
//
// Input only moves a goal. What is rendered eases toward the goal
// (exponential smoothing), and a released drag keeps a smoothed velocity
// that decays softly — no raw delta ever reaches the camera directly.
// Limits are per scene: a distance range, a polar range (absolute pitch, so
// the camera never flips or dives under the floor) and, where a scene needs
// it (inside the room), a yaw range.
//
// Framing is resolution-aware: the DOM reports how much of the screen its
// overlays take (header / copy on top, dock at the bottom). The projection is
// shifted so the pose target sits in the middle of the free area, and the
// camera steps back until the house fits it in width and in height.

const damp = (a, b, lambda, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-lambda * dt));

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    // inner: 1 = the camera is inside the house; it fits narrow screens by
    // widening the lens instead of stepping back through a wall
    this.base = { tx: 0.3, ty: 3.2, tz: 0, yaw: 0.62, pitch: 0.1, dist: 18, fov: 30, roll: 0, inner: 0 };
    this.cur = { ...this.base };
    this.user = { yaw: 0, pitch: 0, zoom: 1 }; // rendered (smoothed)
    this.goal = { yaw: 0, pitch: 0, zoom: 1 }; // where the input wants it
    this.vel = { yaw: 0, pitch: 0 };           // release inertia, rad/s
    this.limits = { zoom: [0.55, 1.45], pitch: [-0.1, 1.0], yaw: null };
    this.resetting = false;
    this._lastMove = 0;
    this.clearance = null; // (x, y, z) → distance to the house surface
    this.parallax = new THREE.Vector2();
    this.parallaxCur = new THREE.Vector2();
    this.dragging = false;
    this.last = new THREE.Vector2();
    this.followSpeed = 3.2; // how fast the camera chases the base pose
    // reduced motion: no cursor parallax, the framing follows the overlays
    // without a glide (scene changes are cuts, see story.js)
    this.reduce = false;
    // lean: a barely-there drift toward the hand while pulling — the house
    // stays whole in frame, the camera never dives at a piece
    this.leanPoint = new THREE.Vector3();
    this.leanOn = false;
    this.leanAmt = 0.06;
    this.leanW = 0;
    // free screen area (px), reported by the page
    this.insets = { top: 0, bottom: 0 };
    this.insetsCur = { top: 0, bottom: 0 };
    this.target = new THREE.Vector3();
    this._shift = null;
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      this.parallax.set((e.clientX / innerWidth) * 2 - 1, (e.clientY / innerHeight) * 2 - 1);
    });
  }

  set(p) { Object.assign(this.base, p); }
  lean(point, amount = 0.06) {
    if (!point) { this.leanOn = false; return; }
    this.leanPoint.copy(point); this.leanAmt = amount; this.leanOn = true;
  }
  snap() { Object.assign(this.cur, this.base); Object.assign(this.insetsCur, this.insets); }
  // the visitor's orbit and distance arrive at once (reduced-motion cuts)
  settle() { Object.assign(this.user, this.goal); this.stopInertia(); this.resetting = false; }
  setInsets(top, bottom) { this.insets.top = top; this.insets.bottom = bottom; }
  // has the visitor moved away from the curated view (orbit or distance)?
  get turned() {
    const g = this.goal;
    return Math.abs(g.yaw) > 0.04 || Math.abs(g.pitch) > 0.04 || Math.abs(Math.log(g.zoom)) > 0.04;
  }
  stopInertia() { this.vel.yaw = this.vel.pitch = 0; }

  setLimits(l) {
    this.limits = { zoom: l?.zoom || [0.55, 1.45], pitch: l?.pitch || [-0.1, 1.0], yaw: l?.yaw || null };
  }
  _clampGoal() {
    const g = this.goal, L = this.limits;
    // polar limits are absolute: base pitch + user pitch stays in range
    const p = THREE.MathUtils.clamp(g.pitch, L.pitch[0] - this.base.pitch, L.pitch[1] - this.base.pitch);
    if (p !== g.pitch) { g.pitch = p; this.vel.pitch = 0; }
    if (L.yaw) {
      const y = THREE.MathUtils.clamp(g.yaw, L.yaw[0], L.yaw[1]);
      if (y !== g.yaw) { g.yaw = y; this.vel.yaw = 0; }
    }
    g.zoom = THREE.MathUtils.clamp(g.zoom, L.zoom[0], L.zoom[1]);
  }

  beginDrag(x, y) { this.dragging = true; this.resetting = false; this.last.set(x, y); this.stopInertia(); this._lastMove = performance.now(); }
  drag(x, y) {
    const dx = x - this.last.x, dy = y - this.last.y;
    this.last.set(x, y);
    const now = performance.now();
    const sec = Math.max(0.008, (now - this._lastMove) / 1000);
    this._lastMove = now;
    const clampD = (v) => THREE.MathUtils.clamp(v, -0.25, 0.25);
    const dYaw = clampD(-dx * 0.0046), dPitch = clampD(dy * 0.003);
    this.goal.yaw += dYaw;
    this.goal.pitch += dPitch;
    // smoothed velocity for the release: a flick keeps turning, a stop stops
    this.vel.yaw = THREE.MathUtils.lerp(this.vel.yaw, dYaw / sec, 0.35);
    this.vel.pitch = THREE.MathUtils.lerp(this.vel.pitch, dPitch / sec, 0.35);
    this._clampGoal();
  }
  endDrag() {
    this.dragging = false;
    if (performance.now() - this._lastMove > 90) this.stopInertia();
    this.vel.yaw = THREE.MathUtils.clamp(this.vel.yaw, -2.5, 2.5);
    this.vel.pitch = THREE.MathUtils.clamp(this.vel.pitch, -1.5, 1.5);
  }
  // wheel: move closer / farther (distance, not lens). Steps are capped so a
  // mouse notch and a trackpad swipe both glide.
  wheel(delta) {
    this.resetting = false;
    const d = THREE.MathUtils.clamp(delta, -140, 140);
    this.goal.zoom *= Math.exp(d * 0.0011);
    this._clampGoal();
  }
  // back to the scene's own framing, softly
  reset() {
    // unwind along the short way round
    const wrap = Math.round(this.user.yaw / (Math.PI * 2)) * Math.PI * 2;
    this.user.yaw -= wrap;
    this.goal.yaw = 0; this.goal.pitch = 0; this.goal.zoom = 1;
    this.stopInertia();
    this.resetting = true;
  }
  // entering a scene: keep a small inspection offset, clamp it into the new
  // scene's ranges, never carry a big or wound-up rotation across
  sceneChange(limits, { resetOrbit = false } = {}) {
    this.setLimits(limits);
    const wrap = Math.round(this.goal.yaw / (Math.PI * 2)) * Math.PI * 2;
    this.goal.yaw -= wrap; this.user.yaw -= wrap;
    this.stopInertia();
    if (resetOrbit || Math.abs(this.goal.yaw) > 0.7 || Math.abs(this.goal.pitch) > 0.45) {
      this.goal.yaw = 0; this.goal.pitch = 0;
      this.resetting = true;
    }
  }

  update(dt) {
    if (!this.dragging) {
      // release inertia: the goal keeps drifting and slows down
      this.goal.yaw += this.vel.yaw * dt;
      this.goal.pitch += this.vel.pitch * dt;
      const k = Math.exp(-dt * 4.2);
      this.vel.yaw *= k; this.vel.pitch *= k;
    }
    this._clampGoal();
    {
      const g = this.goal, u = this.user;
      const lo = this.resetting ? 2.8 : 10;
      u.yaw = damp(u.yaw, g.yaw, lo, dt);
      u.pitch = damp(u.pitch, g.pitch, lo, dt);
      u.zoom = Math.exp(damp(Math.log(u.zoom), Math.log(g.zoom), this.resetting ? 2.8 : 6.5, dt));
      if (this.resetting && Math.abs(u.yaw) + Math.abs(u.pitch) + Math.abs(Math.log(u.zoom)) < 0.002) this.resetting = false;
    }
    const f = this.followSpeed;
    for (const k in this.base) this.cur[k] = damp(this.cur[k], this.base[k], f, dt);
    // the cursor's parallax waits while a piece is held: the view stays put
    if (this.reduce) this.parallaxCur.set(0, 0);
    else if (!this.holdStill) {
      this.parallaxCur.x = damp(this.parallaxCur.x, this.parallax.x, 2.0, dt);
      this.parallaxCur.y = damp(this.parallaxCur.y, this.parallax.y, 2.0, dt);
    }
    if (this.reduce) Object.assign(this.insetsCur, this.insets);
    else {
      this.insetsCur.top = damp(this.insetsCur.top, this.insets.top, 4, dt);
      this.insetsCur.bottom = damp(this.insetsCur.bottom, this.insets.bottom, 4, dt);
    }
    this.leanW = damp(this.leanW, this.leanOn ? 1 : 0, this.leanOn ? 1.6 : 1.1, dt);

    const c = this.cur;
    const cam = this.camera;
    const W = innerWidth, H = innerHeight;
    const aspect = W / H;
    const { top, bottom } = this.insetsCur;
    const safeH = Math.max(H * 0.35, H - top - bottom);
    // step back so the house fits: narrow screens by width, and the free
    // area left between the overlays by height
    // the house is the frame: overlays may graze its edges, it must not shrink
    // into a small object on a page
    const hfit = aspect < 1.25 ? Math.pow(1.25 / aspect, 0.77) : 1;
    const vfit = Math.pow(H / safeH, 0.35);
    const fit = Math.max(hfit, vfit);
    const inner = THREE.MathUtils.clamp(c.inner, 0, 1);
    const distFit = THREE.MathUtils.lerp(fit, 1, inner);
    const fovFit = THREE.MathUtils.lerp(1, fit, inner);
    const fov = Math.min(80, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(c.fov) / 2) * fovFit)));
    const dist = c.dist * distFit * this.user.zoom * (1 - 0.03 * this.leanW);
    const lw = this.leanW * this.leanAmt;
    // off-centre landscape compositions would push the house out of a narrow
    // frame: on portrait screens pull the aim toward the house axis
    const pc = Math.min(1, Math.max(0, (1.25 - aspect) / 0.6)) * 0.92;
    const bx = c.tx + (0.1 - c.tx) * pc, bz = c.tz * (1 - pc);
    const tx = bx + (this.leanPoint.x - bx) * lw, ty = c.ty + (this.leanPoint.y - c.ty) * lw, tz = bz + (this.leanPoint.z - bz) * lw;
    this.target.set(tx, ty, tz);
    const yaw = c.yaw + this.user.yaw + this.parallaxCur.x * 0.035;
    const pitch = c.pitch + this.user.pitch - this.parallaxCur.y * 0.02;
    const cp = Math.cos(pitch);
    cam.position.set(
      tx + Math.sin(yaw) * cp * dist,
      ty + Math.sin(pitch) * dist,
      tz + Math.cos(yaw) * cp * dist
    );
    cam.up.set(Math.sin(c.roll), Math.cos(c.roll), 0);
    cam.lookAt(tx, ty, tz);
    this.focusDist = dist;
    // never inside the cloud: if an orbit + zoom brings the lens too close
    // to the surface, the distance goal is eased back out
    if (this.clearance && inner < 0.5) {
      const cl = this.clearance(cam.position.x, cam.position.y, cam.position.z);
      if (cl < 1.6) this.goal.zoom = Math.min(this.limits.zoom[1], this.goal.zoom * (1 + (1.6 - cl) * 0.04));
    }

    // centre of the free area: shift the projection window, not the camera
    const shift = Math.round((bottom - top) / 2);
    let dirty = Math.abs(cam.fov - fov) > 1e-3;
    if (dirty) cam.fov = fov;
    if (shift !== this._shift || cam.view?.fullWidth !== W || cam.view?.fullHeight !== H) {
      this._shift = shift;
      if (shift) cam.setViewOffset(W, H, 0, shift, W, H);
      else cam.clearViewOffset();
      dirty = true;
    }
    if (dirty) cam.updateProjectionMatrix();
  }
}
