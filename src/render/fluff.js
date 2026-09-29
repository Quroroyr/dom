import * as THREE from 'three';
import { NOISE_GLSL, DEFORM_PARS, EARTH_GLSL } from './houseMaterial.js';

// Fuzz: each mesh is drawn again as thin shells pushed out along the normal.
// The material decides what grows there (and follows the same morph front):
//  cotton — a fibrous 3D noise, denser at grazing angles: soft, airy edges
//  grass  — standing blades (fuzz .w = 1): a dense field of strands that
//           thin to their tips, dark moss at the root, sunlit at the tip,
//           each blade its own shade, swaying in a light breeze
// One program for every material world: switching worlds never recompiles.

export const FLUFF_LAYERS = 8;

const vertex = /* glsl */ `
${NOISE_GLSL}
${DEFORM_PARS}
attribute vec4 bake;
attribute vec4 bake2;
uniform float uFuzzScale;
uniform float uBladeLen;
uniform float uLayers;
uniform vec4 uFzA;
uniform vec4 uFzB;
uniform vec4 uMorph;
uniform float uMorphSoft;
uniform vec4 uWind; // xz direction, strength, gust
varying vec3 vObj;
varying vec3 vNo;
varying vec3 vN;
varying vec3 vV;
varying float vLayer;
varying vec4 vBake;
varying vec4 vBake2;
varying float vW;
varying float vG;
varying vec3 vSlow; // grass: tuft modulation, blade shade, colour drift (slow noises)
void main(){
  float layer = (float(gl_InstanceID) + 1.0) / uLayers;
  float w = 0.0;
  if (uMorph.w >= 0.0) {
    float dist = distance(position, uMorph.xyz) + snoise(position * 1.25) * uMorphSoft * 0.9;
    w = 1.0 - smoothstep(uMorph.w - uMorphSoft, uMorph.w, dist);
  }
  vW = w;
  float fz = mix(uFzA.x, uFzB.x, w) * uFuzzScale * (1.0 - smoothstep(0.0, 0.15, bake2.z));
  vec3 p = chDeform(position, normal);
  float g = mix(uFzA.w, uFzB.w, w);
  fz *= mix(1.0, uBladeLen, g);
  // tall grass is cropped short round windows and doors so they stay open
  float nearOpen = mod(floor(bake2.w * 255.0 + 0.5), 20.0) / 19.0;
  fz *= 1.0 - smoothstep(0.15, 0.85, nearOpen) * 0.88 * g;
  vG = g;
  vec3 q = p + normal * fz * layer;
  // cotton droops a little; grass stands up and leans with the breeze
  q.y -= fz * 0.25 * layer * layer * (1.0 - g);
  if (g > 0.001) {
    float tall = fz * layer * layer * g;
    float jit = 0.6 + 0.4 * snoise(position * 3.1 + 4.0);
    // blades near a pulling hand lean after it — they bend, they do not
    // stretch: only the sideways part of the pull, at most most of the
    // blade's own length, and a leaning blade sinks so its length holds
    // (an absolute shift drew long blades out into strands on big clods)
    vec3 pp = position - uPull.xyz;
    float pw = exp(-dot(pp, pp) / (uPull.w * uPull.w * 2.2));
    vec3 lean = uPullVec * pw * 3.2 * jit;
    lean -= normal * dot(lean, normal);
    float bl = max(fz, 1e-4), ll = length(lean);
    if (ll > bl * 0.8) { lean *= bl * 0.8 / ll; ll = bl * 0.8; }
    float kb = ll / bl;
    q += (lean - normal * bl * (1.0 - sqrt(1.0 - kb * kb))) * layer * layer * g;
    // round a fresh hole the turf keels outward and down over the torn edge
    for (int i = 0; i < 4; i++) {
      if (uSagK[i].y <= 0.0) continue;
      vec3 d = position - uSag[i].xyz;
      float r = length(d) / uSag[i].w;
      float ring = smoothstep(0.55, 0.95, r) * (1.0 - smoothstep(1.05, 1.9, r));
      vec3 outw = normalize(d - normal * dot(d, normal) + vec3(1e-4));
      q += normalize(outw * 0.7 + vec3(0.0, -0.8, 0.0)) * uSagK[i].y * ring * tall * 1.3 * jit;
    }
    // a knock flattens the grass for a moment
    if (uFlatK.x > 0.0) {
      vec3 d = position - uFlat.xyz;
      float f = exp(-dot(d, d) / (uFlat.w * uFlat.w)) * uFlatK.x;
      q -= normal * fz * layer * f * 0.75 * g;
      q += normalize(d + vec3(1e-4)) * tall * f * 0.5;
    }
  }
  if (g > 0.001 && uWind.z > 0.0) {
    float ph = uTime * 1.7 + dot(position, vec3(0.9, 0.35, 0.7)) + snoise(position * 0.45 + uTime * 0.12) * 2.2;
    float sway = (sin(ph) * 0.6 + sin(ph * 2.3 + 1.1) * 0.25 + uWind.w * sin(uTime * 0.6)) * uWind.z;
    q += vec3(uWind.x, 0.0, uWind.y) * sway * fz * 0.9 * layer * layer * g;
  }
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  vObj = position;
  vNo = normal;
  vLayer = layer;
  // (low-frequency: once per vertex is as good as once per pixel)
  vSlow = vec3(0.0);
  if (g > 0.001) {
    vec3 pH = position + uOrigOffset;
    vSlow = vec3(snoise(pH * 1.4 + 2.0), snoise(pH * 1.9 + 11.0), snoise(pH * 0.28 + 9.1));
  }
  vBake = bake;
  vBake2 = bake2;
  gl_Position = projectionMatrix * mv;
}`;

const fragment = /* glsl */ `
${NOISE_GLSL}
${EARTH_GLSL}
uniform float uFuzzCut;
uniform vec2 uFuzzDetail; // cotton, blades: 0 leaves the finest noise octave out (light tiers)
uniform float uLayers;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec4 uFzA;
uniform vec4 uFzB;
uniform vec3 uCloudLit;
uniform vec3 uCloudShadow;
uniform vec3 uCloudRim;
uniform vec3 uSunDirV;
uniform float uAoMix;
uniform float uAoPart;
uniform float uCloudDim;
uniform float uSunFree;
uniform float uFree;
uniform sampler3D uPaint;
uniform vec3 uPaintLo;
uniform vec3 uPaintInv;
uniform vec3 uPaintOffset;
uniform float uPaintOn;
varying vec3 vObj;
varying vec3 vNo;
varying vec3 vN;
varying vec3 vV;
varying float vLayer;
varying vec4 vBake;
varying vec4 vBake2;
varying float vW;
varying float vG;
varying vec3 vSlow;
void main(){
  float density = mix(uFzA.y, uFzB.y, vW);
  if (density < 0.01) discard;
  float fine = mix(uFzA.z, uFzB.z, vW);
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 1.6);
  float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  bool grass = vG > 0.5;
  float a;
  float bladeTone = 0.0;
  vec3 pH = vObj + uOrigOffset;
  if (!grass) {
    // cotton clumps with finer fibres (finer for sugar, looser for mist)
    float f = 0.5 + 0.5 * snoise(vObj * vec3(11.0, 6.0, 11.0) * fine);
    f = f * 0.6 + (uFuzzDetail.x > 0.5 ? 0.5 + 0.5 * snoise(vObj * 30.0 * fine + 3.1) : 0.5) * 0.4;
    float th = mix(0.42, 0.86, vLayer) + dither * 0.09;
    float few = max(1.0, 8.0 / uLayers);
    a = smoothstep(th, th + 0.12 * few, f) * (1.0 - vLayer * 0.8) * sqrt(few);
    a *= mix(0.12, 1.2, fres) * min(density, 1.3) * (1.0 - smoothstep(0.0, 0.1, vBake2.z));
  } else {
    // a shell seen from well behind (the far side of a bulge) is hidden by
    // the body; skip its work early (the rim, near edge-on, stays)
    if (dot(N, V) < -0.35) discard;
    // blades: cells of a noise field, gathered into tufts; the cut-off rises
    // with height, so every blade tapers to a point
    vec3 bp = pH * 24.0 * fine;
    float b = (0.5 + 0.5 * snoise(bp)) * 0.72 + (uFuzzDetail.y > 0.5 ? 0.5 + 0.5 * snoise(bp * 2.3 + 5.3) : 0.5) * 0.28;
    b *= mix(0.8, 1.12, 0.5 + 0.5 * vSlow.x);
    float gth = mix(0.34, 0.8, vLayer) + dither * 0.04;
    // fewer shells (LOD): each blade a little wider, so the turf keeps its cover
    gth -= clamp(12.0 / uLayers - 1.0, 0.0, 1.0) * 0.075;
    a = smoothstep(gth, gth + 0.045, b) * mix(0.8, 1.0, fres) * min(density, 1.4) * (1.0 - vLayer * 0.22);
    a *= 1.0 - smoothstep(0.0, 0.1, vBake2.z);
    // blades grow on the skin only: the root mat and the soil beneath are bare
    a *= 1.0 - smoothstep(0.035, 0.07, chDepthN(pH, vNo));
    bladeTone = vSlow.y;
    // solid blades (turf world): each blade is opaque and writes depth, so
    // the shells of neighbouring bricks can be drawn in any order without
    // one brick's grass laying over the next along the seam
    // (the faint fringe is dropped, the rest keeps a little of its softness)
    if (uFuzzCut > 0.5) { if (a < 0.4) discard; a = mix(a, 1.0, 0.45); }
  }
  if (a < 0.01) discard;
  float sunV = mix(mix(vBake2.y, vBake2.x, uAoMix * uAoPart), 1.0, max(uSunFree, uFree));
  float ndl = dot(N, normalize(uSunDirV));
  float lit = smoothstep(0.0, 0.8, clamp((ndl + 0.5) / 1.5, 0.0, 1.0) * mix(0.22, 1.0, sunV));
  float ao = mix(vBake.y, vBake.x, uAoMix * uAoPart);
  ao = mix(ao, max(ao, 0.85), uFree);
  vec3 base = mix(uColorA, uColorB, vW);
  // painted cotton: the fibres carry the same colour as the skin beneath
  if (uPaintOn > 0.5) {
    vec4 pt = texture(uPaint, (vObj + uPaintOffset - uPaintLo) * uPaintInv);
    base = mix(base, pt.rgb, smoothstep(0.02, 0.85, pt.a) * 0.78);
  }
  if (grass) {
    // dark moss at the root, sunlit straw-green at the tip, each blade its own shade
    vec3 root = base * vec3(0.5, 0.58, 0.46);
    vec3 tip = base * vec3(1.3, 1.24, 0.82);
    base = mix(root, tip, smoothstep(0.1, 1.0, vLayer)) * (1.0 + bladeTone * 0.14);
    base = mix(base, base * vec3(1.12, 1.08, 0.7), max(0.0, bladeTone) * 0.35);
    // the same broad drifts as the turf beneath: sage patches, sunny patches
    float drift = vSlow.z;
    float lum = dot(base, vec3(0.3, 0.59, 0.11));
    base = mix(base, vec3(lum) * vec3(0.93, 1.03, 0.96), smoothstep(0.1, 0.7, drift) * 0.45);
    base = mix(base, base * vec3(1.12, 1.08, 0.72), smoothstep(-0.1, -0.7, drift) * 0.4);
  }
  vec3 col = base * mix(uCloudShadow, uCloudLit, lit) * mix(0.6, 1.0, ao);
  if (grass) {
    // light through the blade tips when the sun is behind them
    float back = pow(clamp(-dot(V, normalize(uSunDirV)), 0.0, 1.0), 2.0);
    col += uCloudLit * base * back * vLayer * 0.35;
    col += uCloudRim * fres * 0.12;
  } else col += uCloudRim * fres * 0.35;
  col *= mix(vec3(0.42, 0.44, 0.55), vec3(1.0), uCloudDim);
  gl_FragColor = vec4(col, a);
}`;

// one fuzz material per part (the body shares one across all its bricks)
export function makeFluffMaterial(part, shared) {
  const u = part.u;
  const A = part.mat.userData.A, B = part.mat.userData.B;
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: u.uTime, uPress: u.uPress, uPressN: u.uPressN, uRipple: u.uRipple, uRippleAmp: u.uRippleAmp,
      uPull: u.uPull, uPullVec: u.uPullVec, uStretch: u.uStretch, uBreath: u.uBreath,
      uRough: u.uRough, uTurfDir: u.uTurfDir,
      uSag: u.uSag, uSagK: u.uSagK, uFlat: u.uFlat, uFlatK: u.uFlatK,
      uMorph: u.uMorph, uMorphSoft: u.uMorphSoft,
      uFzA: { value: A.fz }, uFzB: { value: B.fz },
      uWind: shared.uWind,
      uColorA: { value: A.color }, uColorB: { value: B.color },
      uFuzzScale: shared.uFuzzScale,
      uFuzzCut: shared.uFuzzCut,
      uBladeLen: shared.uBladeLen,
      uFuzzDetail: shared.uFuzzDetail,
      uLayers: { value: FLUFF_LAYERS },
      uCloudLit: shared.uCloudLit, uCloudShadow: shared.uCloudShadow, uCloudRim: shared.uCloudRim,
      uSunDirV: shared.uSunDirV, uAoMix: shared.uAoMix, uAoPart: u.uAoPart, uCloudDim: shared.uCloudDim, uSunFree: part.mat.userData.uniforms.uSunFree,
      uFree: part.mat.userData.uniforms.uFree,
      // the part's own paint bindings (a torn piece switches them to its own volume)
      uPaint: part.mat.userData.uniforms.uPaint, uPaintLo: part.mat.userData.uniforms.uPaintLo, uPaintInv: part.mat.userData.uniforms.uPaintInv,
      uPaintOffset: part.mat.userData.uniforms.uPaintOffset, uPaintOn: part.mat.userData.uniforms.uPaintOn,
      uOrig: shared.uOrig, uOrigLo: shared.uOrigLo, uOrigInv: shared.uOrigInv,
      uOrigOffset: part.mat.userData.uniforms.uOrigOffset,
    },
    vertexShader: vertex,
    fragmentShader: fragment,
  });
}

// shells are allocated for the most layers any world uses; how many are
// drawn is set per world (cloud: soft 8; turf: 12 for taller blades)
export const FLUFF_MAX = 12;
const SHELLS = new Set();
let layersNow = FLUFF_LAYERS;
export function attachFluff(mesh, mat, layers) {
  // a new brick of the body joins at the body's current level of detail
  if (layers === undefined) layers = lodOn && mat === lodBodyMat && bodyLod.n ? bodyLod.n : layersNow;
  mat.uniforms.uLayers.value = layers;
  const shell = new THREE.InstancedMesh(mesh.geometry, mat, FLUFF_MAX);
  const I = new THREE.Matrix4();
  for (let i = 0; i < FLUFF_MAX; i++) shell.setMatrixAt(i, I);
  shell.count = layers;
  // culled with its brick's bounds, grown by the most the shells ever reach
  // out (blade length, a leaning pull, a sagging rim): a brick behind the
  // camera (inside the room) draws no fuzz
  shell.computeBoundingSphere = shellBounds;
  shell.matrixAutoUpdate = false; // always at its brick's origin
  shell.renderOrder = 2;
  shell.raycast = () => {};
  mesh.add(shell);
  SHELLS.add(shell);
  mat.depthWrite = solidNow;
  return shell;
}
// a piece is gone for good: free what its fuzz owns — its own material and
// the shell's instance buffers — and forget the shell. The geometry is the
// piece's (shared with the house's clump cache): not ours to dispose.
export function detachFluff(mesh) {
  for (let i = mesh.children.length - 1; i >= 0; i--) {
    const s = mesh.children[i];
    if (!SHELLS.has(s)) continue;
    SHELLS.delete(s);
    mesh.remove(s);
    s.material.dispose();
    s.dispose();
  }
}
export const fluffShellCount = () => SHELLS.size;
const SHELL_PAD = 1.5;
function shellBounds() {
  const g = this.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  if (!this.boundingSphere) this.boundingSphere = new THREE.Sphere();
  this.boundingSphere.copy(g.boundingSphere);
  this.boundingSphere.radius += SHELL_PAD;
}

// grass blades as solid cut-outs that write depth (turf world) or soft,
// blended fuzz (cotton): set by the world once its material wave is done
let solidNow = false;
export function setFuzzSolid(on, shared) {
  solidNow = on;
  shared.uFuzzCut.value = on ? 1 : 0;
  for (const s of SHELLS) {
    if (!s.parent || !s.parent.parent) { SHELLS.delete(s); continue; }
    s.material.depthWrite = on;
  }
}
// --- shell level of detail (turf world) ----------------------------------------
// A shell's layer count follows how long a blade is on screen, about 2 px
// per layer, never above the world's maximum or the quality cap. The body's
// shells share one material → one count; every loose piece has its own (a
// piece far off or small on screen draws fewer). Steps are one layer at a
// time, at most every 0.2 s, with ±0.75 layer of slack: no flicker.
const LOD_PX = 2.0, LOD_MIN = 3;
let lodOn = false, lodCap = FLUFF_MAX, pieceCap = FLUFF_MAX, lodBodyMat = null;
const bodyLod = { n: 0, t: 0 };
const _wp = new THREE.Vector3();
export function setFuzzLod(on) {
  lodOn = on;
  bodyLod.n = 0;
  if (!on) setFuzzLayers(layersNow);
}
// the quality tier's ceilings: the body's shells and (lower) a loose piece's
export function setFuzzCap(n, piece = n) {
  lodCap = Math.max(1, Math.min(FLUFF_MAX, n));
  pieceCap = Math.max(1, Math.min(lodCap, piece));
}
export const fuzzLodState = () => ({ on: lodOn, body: bodyLod.n, cap: lodCap, pieceCap, max: layersNow });
function lodStep(st, target, max, dt) {
  st.t -= dt;
  if (!st.n) { st.n = Math.max(1, Math.min(max, Math.round(target))); return true; }
  if (st.n > max) { st.n = max; return true; }
  if (st.t > 0) return false;
  if (target > st.n + 0.75 && st.n < max) { st.n++; st.t = 0.2; return true; }
  if (target < st.n - 0.75 && st.n > Math.min(LOD_MIN, max)) { st.n--; st.t = 0.2; return true; }
  return false;
}
export function updateFuzzLod(dt, camera, heightPx, blade, bodyMat, bodyCenter, pieces) {
  if (!lodOn) return;
  lodBodyMat = bodyMat;
  const max = Math.min(layersNow, lodCap);
  const k = blade * heightPx / (2 * Math.tan(camera.fov * Math.PI / 360)) / LOD_PX;
  const target = (d, m = max) => Math.max(Math.min(LOD_MIN, m), Math.min(m, k / Math.max(d, 0.5)));
  if (lodStep(bodyLod, target(camera.position.distanceTo(bodyCenter)), max, dt)) {
    for (const s of SHELLS) if (s.material === bodyMat) s.count = bodyLod.n;
    bodyMat.uniforms.uLayers.value = bodyLod.n;
  }
  const pmax = Math.min(max, pieceCap);
  for (const pc of pieces) {
    const st = pc.lod || (pc.lod = { n: 0, t: 0 });
    pc.mesh.getWorldPosition(_wp);
    if (!lodStep(st, target(camera.position.distanceTo(_wp), pmax), pmax, dt)) continue;
    for (const s of pc.mesh.children) if (SHELLS.has(s)) { s.count = st.n; s.material.uniforms.uLayers.value = st.n; }
  }
}

export function setFuzzLayers(n) {
  layersNow = n = Math.min(FLUFF_MAX, Math.max(1, Math.round(n)));
  for (const s of SHELLS) {
    // shells of disposed pieces / old bricks drop out of the registry
    if (!s.parent || !s.parent.parent) { SHELLS.delete(s); continue; }
    s.count = n;
    s.material.uniforms.uLayers.value = n;
  }
}
