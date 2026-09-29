import * as THREE from 'three';
import { makeStateUniform, packState } from './families.js';

// Shared GLSL ----------------------------------------------------------------

export const NOISE_GLSL = /* glsl */ `
vec3 ch_mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 ch_mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 ch_perm(vec4 x){return ch_mod289(((x*34.0)+10.0)*x);}
vec4 ch_tis(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=ch_mod289(i);
  vec4 p=ch_perm(ch_perm(ch_perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=ch_tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`;

// Depth under the ORIGINAL skin of the whole house (a 3D texture a material
// world may build; 0 everywhere until then) and a stylised soil for worlds
// whose body is earth: dark strata, crumbs and pale root threads.
export const EARTH_GLSL = /* glsl */ `
uniform sampler3D uOrig;
uniform vec3 uOrigLo;
uniform vec3 uOrigInv;
uniform vec3 uOrigOffset; // a piece reads it where it sat in the house
// depth below the untouched skin, ±1 m around it (0 where there is no map)
float chDepth(vec3 pH) { return (0.5 - texture(uOrig, (pH - uOrigLo) * uOrigInv).r) * 2.0; }
// a torn sod: xyz the side that faced out of the house (its top); w how much
// of the house's grass skin the clump carried (0: a clump from within —
// earth all round, no turf top; 1: an outer clump)
uniform vec4 uTurfDir;
// the depth a surface of a loose sod reads as: its top keeps the turf, with
// a ring of root felt round it; the torn sides and the bottom are earth
float chDepthN(vec3 pH, vec3 nObj) {
  float d = chDepth(pH);
  if (uTurfDir.w < 0.001) return d;
  float up = dot(normalize(nObj), uTurfDir.xyz);
  float t = mix(d, min(d, 0.085), smoothstep(0.02, 0.22, up));
  t = mix(t, min(t, 0.0), smoothstep(0.22, 0.45, up));
  return mix(d, t, uTurfDir.w);
}
vec3 chEarth(vec3 pH) {
  float strata = 0.5 + 0.5 * snoise(vec3(pH.x * 0.7, pH.y * 3.6, pH.z * 0.7));
  float crumb = 0.5 + 0.5 * snoise(pH * 7.0);
  vec3 c = mix(vec3(0.16, 0.1, 0.058), vec3(0.36, 0.25, 0.145), strata);
  c *= mix(0.8, 1.16, crumb);
  // grit: small pale stones and dark clods
  float grit = snoise(pH * 13.0 + 4.0);
  c = mix(c, vec3(0.4, 0.34, 0.27), smoothstep(0.78, 0.95, grit) * 0.3);
  c *= 1.0 - smoothstep(-0.55, -0.9, grit) * 0.2;
  // damp, darker hollows between clods; drier, paler crests
  float cr = snoise(pH * 4.2 + 2.0);
  c *= mix(0.82, 1.1, 0.5 + 0.5 * cr);
  // a few pale roots, not a net: only where a second field lets them through
  float root = 1.0 - smoothstep(0.0, 0.05, abs(snoise(pH * vec3(2.2, 5.5, 2.2))));
  root *= smoothstep(0.15, 0.55, snoise(pH * 0.9 + 12.0));
  return mix(c, vec3(0.5, 0.41, 0.29), root * 0.55);
}
// the root mat just under the turf: a felt of fine pale roots in dark humus
vec3 chRoots(vec3 pH) {
  float f1 = 1.0 - smoothstep(0.0, 0.06, abs(snoise(pH * vec3(9.0, 3.0, 9.0))));
  float f2 = 1.0 - smoothstep(0.0, 0.05, abs(snoise(pH * vec3(4.0, 11.0, 4.0) + 7.0)));
  vec3 humus = vec3(0.13, 0.085, 0.05) * mix(0.8, 1.2, 0.5 + 0.5 * snoise(pH * 6.0));
  float sparse = smoothstep(-0.2, 0.5, snoise(pH * 1.6 + 5.0));
  return mix(humus, vec3(0.4, 0.31, 0.21), max(f1, f2 * 0.8) * 0.45 * sparse);
}
`;

export const DEFORM_PARS = /* glsl */ `
${EARTH_GLSL}
uniform vec4 uRough; // x: relief (m) of the torn earth on a loose sod; 0 = off
// torn earth: lumpy and crumbly, rougher toward the bottom, a few clods
// standing out and small pits; the turf top stays whole
vec3 chRoughen(vec3 p, vec3 n) {
  vec3 pH = p + uOrigOffset;
  float d = chDepthN(pH, n);
  float soil = smoothstep(0.04, 0.16, d);
  if (soil < 0.001) return p;
  float deep = smoothstep(0.12, 0.7, d);
  float lump = snoise(pH * 2.1) * 0.5 + snoise(pH * 4.7 + 3.0) * 0.3 + snoise(pH * 10.0 + 7.0) * 0.2;
  // clods standing out: cellular-looking bumps, sharp at their foot
  float clod = smoothstep(0.3, 0.75, snoise(pH * 3.4 + 11.0)) + smoothstep(0.45, 0.8, snoise(pH * 6.5 + 5.0)) * 0.5;
  float pit = smoothstep(0.45, 0.8, snoise(pH * 8.0 + 1.7));
  float a = uRough.x * mix(0.45, 1.0, deep);
  return p + n * soil * (lump * a + clod * a * 0.8 - pit * 0.04);
}
uniform float uTime;
uniform vec4 uPress;      // xyz local point, w depth (m)
uniform vec4 uPressN;     // xyz local direction, w radius
uniform vec4 uRipple;     // xyz local point, w age (s), < 0 off
uniform vec2 uRippleAmp;  // amplitude, wavenumber
uniform vec4 uPull;       // xyz local anchor, w radius
uniform vec3 uPullVec;    // local displacement at anchor
uniform vec4 uStretch;    // xyz unit axis (local), w amount
uniform float uBreath;
// fresh holes (turf world): xyz centre, w radius; K.x how far the rim has
// settled under gravity (m), K.y how far the grass round it has keeled over
uniform vec4 uSag[4];
uniform vec4 uSagK[4];
// the last knock (turf world): xyz point, w radius; K.x how flat the grass is
uniform vec4 uFlat;
uniform vec4 uFlatK;
vec3 chDeform(vec3 p, vec3 n){
  vec3 q = uRough.x > 0.0 ? chRoughen(p, n) : p;
  vec3 dp = p - uPress.xyz;
  q -= uPressN.xyz * uPress.w * exp(-dot(dp,dp) / (uPressN.w*uPressN.w));
  if (uRipple.w >= 0.0) {
    float d = distance(p, uRipple.xyz);
    float t = uRipple.w;
    float front = smoothstep(0.0, 0.35, t * 3.2 - d);
    float env = exp(-t * 1.9) * exp(-d * 0.7) * front;
    q += n * sin(d * uRippleAmp.y - t * 11.0) * uRippleAmp.x * env;
  }
  vec3 pp = p - uPull.xyz;
  q += uPullVec * exp(-dot(pp,pp) / (uPull.w*uPull.w));
  float along = dot(q, uStretch.xyz);
  q += uStretch.xyz * along * uStretch.w - (q - uStretch.xyz * along) * uStretch.w * 0.42;
  q += n * uBreath * sin(uTime * 0.85 + p.y * 1.6 + p.x * 0.7 + p.z * 0.5);
  // earth round a fresh hole sinks a little, most at the rim, uneven
  for (int i = 0; i < 4; i++) {
    if (uSagK[i].x <= 0.0) continue;
    float r = distance(p, uSag[i].xyz) / uSag[i].w;
    float rim = exp(-pow((r - 0.95) / 0.45, 2.0));
    q.y -= uSagK[i].x * rim * (0.75 + 0.25 * sin(p.x * 9.0 + p.z * 7.0));
  }
  return q;
}
`;

const VERT_PARS = /* glsl */ `
${NOISE_GLSL}
${DEFORM_PARS}
attribute vec4 bake;
attribute vec4 bake2;
varying vec4 vBake;
varying vec4 vBake2;
varying vec3 vObj;
varying vec3 vObjN;
`;

const VERT_NORMAL = /* glsl */ `
#include <beginnormal_vertex>
vec3 chPos = chDeform(position, normal);
{
  vec3 t1 = normalize(abs(normal.y) < 0.95 ? cross(normal, vec3(0.0,1.0,0.0)) : cross(normal, vec3(1.0,0.0,0.0)));
  vec3 t2 = cross(normal, t1);
  float e = 0.03;
  vec3 p1 = chDeform(position + t1 * e, normal);
  vec3 p2 = chDeform(position + t2 * e, normal);
  vec3 nn = cross(p1 - chPos, p2 - chPos);
  if (dot(nn, nn) > 1e-12) objectNormal = normalize(nn);
}
vBake = bake;
vBake2 = bake2;
vObj = position;
vObjN = normal;
`;

const FRAG_PARS = /* glsl */ `
${NOISE_GLSL}
${EARTH_GLSL}
uniform vec4 uSA[5]; uniform vec3 uSAc[3];
uniform vec4 uSB[5]; uniform vec3 uSBc[3];
uniform vec4 uMorph;          // xyz origin (local), w radius
uniform float uMorphSoft;
uniform vec4 uDrops[10];      // xyz local, w radius
uniform vec4 uDropCol[10];   // rgb + strength (1 = weather wave, <1 = brush)
uniform int uDropCount;
uniform float uAoMix;
uniform float uAoPart;
uniform float uAoStrength;
uniform vec3 uSunDirV;
uniform vec3 uSunCol;
uniform vec3 uGlowCol;
uniform float uGlowBoost;
uniform float uTime;
uniform vec3 uCloudLit;
uniform vec3 uCloudShadow;
uniform vec3 uCloudRim;
uniform float uCloudDim;
uniform float uCavGlow[8];
uniform float uSunFree;       // 1 = ignore the baked sun shadow (a piece turned away from its bake)
uniform vec3 uRoomLit;
uniform vec3 uRoomDeep;
uniform vec4 uRoomWin[3];     // xyz: inner mouth of a window (house frame), w: strength
uniform float uFree;          // 1 = a torn piece in open air: live light, no house bakes
uniform sampler3D uPaint;     // persistent paint, house frame
uniform vec3 uPaintLo;
uniform vec3 uPaintInv;
uniform vec3 uPaintOffset;    // a piece reads paint where it sat in the house
uniform float uPaintOn;
varying vec4 vBake;
varying vec4 vBake2;
varying vec3 vObj;
varying vec3 vObjN;

float chMicro(vec3 p, float type, float s, float fiber){
  if (type < 0.5) return 0.0;
  if (type > 5.5) { // whipped cream: soft piped ridges swirling around
    vec3 q = p * s;
    float a = atan(q.z, q.x) * 2.0 + q.y * 1.7 + snoise(q * 0.6) * 2.2;
    return sin(a * 3.0) * 0.6 + snoise(q * 1.8) * 0.25;
  }
  if (type > 4.5) { // cloud: billowy puffs + stretched cotton fibres
    vec3 q = p * s;
    float n1 = snoise(q);
    float n2 = snoise(q * 2.3 + 4.1);
    float bil = (1.0 - abs(n1)) * 0.7 + (1.0 - abs(n2)) * 0.35;
    float fib = snoise(vec3(p.x * s * 7.0, p.y * s * 0.8, p.z * s * 7.0)) + snoise(vec3(p.x * s * 1.1, p.y * s * 9.0, p.z * s * 1.1)) * 0.6;
    return bil + fib * 0.22 * fiber;
  }
  if (type < 1.5) { // foam pores
    float a = snoise(p * s) * 0.55 + snoise(p * s * 2.37) * 0.3;
    float pores = smoothstep(0.35, 0.75, snoise(p * s * 1.61 + 7.1));
    return a - pores * 0.9;
  }
  if (type < 2.5) return snoise(p * s) * 0.6 + snoise(p * s * 3.1) * 0.25; // glaze
  if (type < 3.5) { // weave + large quilting seams
    vec3 q = p * s;
    float w = sin(q.x + q.y * 0.5) * sin(q.z - q.y * 0.5);
    float seam = smoothstep(0.86, 1.0, abs(sin(p.y * 3.4 + p.x * 0.4)));
    return w * 0.5 - seam * 6.0;
  }
  float r = length(p.xz) * s + snoise(p * 1.4) * 1.6; // pearl growth lines
  return sin(r * 6.2831) * 0.5 + snoise(p * s * 4.0) * 0.2;
}

vec3 chPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection){
  vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
  vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
  vec3 R1 = cross(vSigmaY, surf_norm);
  vec3 R2 = cross(surf_norm, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
float chN = snoise(vObj * 1.25);
float chDist = distance(vObj, uMorph.xyz) + chN * uMorphSoft * 0.9;
float chW = 1.0 - smoothstep(uMorph.w - uMorphSoft, uMorph.w, chDist);
vec4 S0 = mix(uSA[0], uSB[0], chW);
vec4 S1 = mix(uSA[1], uSB[1], chW);
vec4 S2 = mix(uSA[2], uSB[2], chW);
vec4 S3 = mix(uSA[3], uSB[3], chW);
vec4 S4 = mix(uSA[4], uSB[4], chW); // fuzz: length, density, fineness, grass
vec3 chCol = mix(uSAc[0], uSBc[0], chW);
vec3 chSheen = mix(uSAc[1], uSBc[1], chW);
vec3 chSss = mix(uSAc[2], uSBc[2], chW);
float chSoil = 0.0; // bare earth (turf world): matte, no sheen, no glow
// micro type must not blend numerically: pick the dominant side
float chMicroType = chW > 0.5 ? uSB[2].z : uSA[2].z;
float chMicroScale = chW > 0.5 ? uSB[3].x : uSA[3].x;
for (int i = 0; i < 10; i++) {
  if (i >= uDropCount) break;
  vec4 dr = uDrops[i];
  vec4 dc = uDropCol[i];
  float soft = dc.a < 0.99 ? 0.38 : 0.72;       // brush strokes bleed wider
  float n1 = snoise(vObj * 1.9 + float(i) * 3.7);
  float n2 = snoise(vObj * 7.3 + float(i) * 1.3) * 0.35;
  float d = distance(vObj, dr.xyz) + (n1 + n2) * min(dr.w, 1.2) * (dc.a < 0.99 ? 0.22 : 0.35);
  float cov = (1.0 - smoothstep(dr.w * soft, dr.w, d)) * dc.a;
  chCol = mix(chCol, dc.rgb, cov);
}
// a living surface: sunlit turf on top, moss on the sides, earthier in the
// folds and underneath; broad patches of spring and sage green
if (S4.w > 0.001) {
  vec3 pH = vObj + uOrigOffset; // the house frame, even on a turned piece
  vec3 gn = normalize(vObjN);
  float patchN = snoise(pH * 0.45 + 3.7) * 0.5 + 0.5;
  float fineN = snoise(pH * 2.6 - 1.3) * 0.5 + 0.5;
  vec3 turf = chCol * mix(0.8, 1.14, patchN) * mix(0.92, 1.06, fineN);
  // broad drifts of sage (cooler, quieter) and sun-warmed yellow-green
  float drift = snoise(pH * 0.28 + 9.1);
  float lum = dot(turf, vec3(0.3, 0.59, 0.11));
  turf = mix(turf, vec3(lum) * vec3(0.93, 1.03, 0.96), smoothstep(0.1, 0.7, drift) * 0.45);
  turf = mix(turf, turf * vec3(1.12, 1.08, 0.72), smoothstep(-0.1, -0.7, drift) * 0.4);
  turf = mix(turf, turf * vec3(1.22, 1.14, 0.62), smoothstep(0.35, 0.95, gn.y) * 0.55 * patchN);
  vec3 earth = vec3(0.22, 0.17, 0.10);
  float fold = (1.0 - vBake.y) * 0.6 + smoothstep(-0.2, -0.8, gn.y) * 0.45;
  turf = mix(turf, mix(turf, earth, 0.55), clamp(fold, 0.0, 0.7));
  // under the skin: a dark root mat, then the soil body (strata, roots)
  float dep = chDepthN(pH, gn);
  // turf is a thin skin: a few cm of root mat, then soil
  float soilW = smoothstep(0.07, 0.17, dep);
  float rootW = smoothstep(0.025, 0.06, dep) * (1.0 - soilW);
  turf = mix(turf, chRoots(pH), rootW);
  turf = mix(turf, chEarth(pH), soilW);
  chCol = mix(chCol, turf, S4.w);
  chSoil = clamp(soilW + rootW, 0.0, 1.0) * S4.w;
}
if (uPaintOn > 0.5) {
  vec4 pt = texture(uPaint, (vObj + uPaintOffset - uPaintLo) * uPaintInv);
  // pigment soaked into the cloud: it tints, the cotton still shows through
  chCol = mix(chCol, pt.rgb, smoothstep(0.02, 0.85, pt.a) * 0.82);
}
float chSeam = exp(-pow((chDist - uMorph.w) / 0.09, 2.0)) * step(0.01, uMorph.w) * step(uMorph.w, 60.0);
diffuseColor.rgb = chCol;
diffuseColor.a = mix(uSA[3].w, uSB[3].w, chW);
`;

const FRAG_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = S0.x;
`;

const FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
  float amp = S2.w;
  if (amp > 0.001 && chMicroType > 0.5) {
    vec3 mp = vObj;
    float h = chMicro(mp, chMicroType, chMicroScale, S3.z);
    // fade detail out as it approaches pixel frequency
    float fw = length(fwidth(mp)) * chMicroScale;
    float fade = 1.0 - smoothstep(0.35, 1.1, fw);
    vec2 dHdxy = vec2(dFdx(h), dFdy(h)) * amp * 0.02 * fade;
    normal = chPerturb(-vViewPosition, normal, dHdxy, faceDirection);
  }
}
`;

const FRAG_MATERIAL = /* glsl */ `
#include <lights_physical_fragment>
material.roughness = mix(min(max(S0.x, 0.0525) + geometryRoughness, 1.0), 1.0, chSoil);
#ifdef USE_SHEEN
  material.sheenColor = chSheen * S0.y * (1.0 - chSoil);
  material.sheenRoughness = clamp(S0.z, 0.0001, 1.0);
#endif
#ifdef USE_CLEARCOAT
  material.clearcoat = S0.w;
  material.clearcoatRoughness = min(max(S1.x, 0.0525) + geometryRoughness, 1.0);
#endif
#ifdef USE_IRIDESCENCE
  material.iridescence = S1.y;
  material.iridescenceThickness = mix(260.0, 720.0, 0.5 + 0.5 * snoise(vObj * 0.9 + 3.0));
#endif
`;

const FRAG_LIGHT = /* glsl */ `
#include <aomap_fragment>
{
  float aoV = mix(vBake.y, vBake.x, uAoMix * uAoPart);
  // a free piece keeps only a hint of its creases; the rest was the house
  aoV = mix(aoV, max(aoV, 0.85), uFree);
  aoV = mix(0.3, 1.0, aoV);
  float ao = mix(1.0, aoV * mix(1.0, vBake.w, 0.45), uAoStrength);
  reflectedLight.indirectDiffuse *= ao;
  reflectedLight.indirectSpecular *= mix(1.0, ao, 0.85);
  reflectedLight.directDiffuse *= mix(1.0, ao, 0.3);
  #ifdef USE_SHEEN
    sheenSpecularIndirect *= ao;
  #endif
  #ifdef USE_CLEARCOAT
    clearcoatSpecularIndirect *= ao;
  #endif
  // soft light transport: wrap + back-scatter through thin walls
  float thin = vBake.z;
  vec3 L = normalize(uSunDirV);
  vec3 N = normal;
  vec3 V = normalize(vViewPosition);
  float ndl = dot(N, L);
  float wrap = max(0.0, (ndl + 0.7) / 1.7) - max(0.0, ndl);
  float back = pow(clamp(dot(V, L + N * 0.3), 0.0, 1.0), 3.0) * (0.2 + thin);
  // earth is opaque and matte: no light through it, no glow, no gloss
  float lucid = 1.0 - chSoil;
  vec3 sss = chSss * S2.x * (wrap * 0.55 + back * 1.3) * uSunCol * mix(0.4, 1.0, ao) * lucid;
  reflectedLight.directDiffuse += sss * diffuseColor.rgb;
  totalEmissiveRadiance += uGlowCol * (S2.y * (0.35 + 0.65 * thin) + uGlowBoost) * mix(0.6, 1.0, ao) * lucid;
  reflectedLight.directSpecular *= 1.0 - chSoil * 0.95;
  // nor the green bounce of the sky and grass around it
  reflectedLight.indirectDiffuse = mix(reflectedLight.indirectDiffuse, vec3(dot(reflectedLight.indirectDiffuse, vec3(0.3, 0.59, 0.11))) * vec3(1.05, 1.0, 0.92), chSoil);
  reflectedLight.indirectSpecular *= 1.0 - chSoil * 0.9;

  // stylised cloud light: shade is colour, not darkness
  float sty = S3.y;
  if (sty > 0.001) {
    float sunV = mix(mix(vBake2.y, vBake2.x, uAoMix * uAoPart), 1.0, max(uSunFree, uFree));
    float wrapL = clamp((ndl + 0.5) / 1.5, 0.0, 1.0);
    float lit = smoothstep(0.0, 0.8, wrapL * mix(0.22, 1.0, sunV));
    vec3 shade = mix(uCloudShadow, uCloudLit, lit);
    // bare earth does not take the meadow's sage shade: neutral, a touch warm
    shade = mix(shade, vec3(dot(shade, vec3(0.3, 0.59, 0.11))) * vec3(1.05, 1.0, 0.92), chSoil);
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.4);
    float backT = pow(clamp(-dot(V, L), 0.0, 1.0), 3.0) * (0.25 + thin);
    vec3 styl = diffuseColor.rgb * shade * mix(0.36, 1.0, ao);
    // silver lining: edges catch the light, strongest when the sun is behind
    float behind = clamp(-dot(V, L) * 0.5 + 0.5, 0.0, 1.0);
    styl += uCloudRim * fres * (0.35 + 0.65 * behind) * mix(0.45, 1.0, sunV) * 0.9 * (1.0 - chSoil * 0.92);
    styl += (uCloudLit * diffuseColor.rgb * backT * 0.5 * sunV * (0.6 + S2.x * 0.6)
      + chSss * max(0.0, S2.x - 0.8) * (0.35 + thin) * 0.35 // airy substances glow through
      + chSss * S2.x * wrap * 0.25) * lucid;
    styl *= mix(vec3(0.42, 0.44, 0.55), vec3(1.0), uCloudDim); // dusk: the cloud cools and dims
    reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, styl, sty);
    reflectedLight.indirectDiffuse *= 1.0 - sty * 0.92;
  }
  // carved room and openings: a quiet room inside the cloud. Matte plaster
  // in soft indirect daylight — the floor catches the window light, the
  // ceiling sits in a warm hush, the tunnel of an opening brightens toward
  // its lip. No emission by day; at dusk the windows hold a little lamp light.
  if (vBake2.z > 0.004 && uFree < 0.999) {
    int ci = int(floor(vBake2.w * 255.0 / 20.0 + 0.001)); // the rest is nearness to an opening
    float cg = 0.0;
    for (int k = 0; k < 8; k++) if (k == ci) cg = uCavGlow[k];
    float dep = vBake2.z;
    float into = smoothstep(0.0, 0.22, dep) * (1.0 - uFree);
    float deep = smoothstep(0.3, 1.0, dep);
    float up = clamp(normalize(vObjN).y * 0.5 + 0.5, 0.0, 1.0);
    float aoR = mix(vBake.y, vBake.x, uAoMix * uAoPart);
    // daylight falls in through the windows and pools on the floor and the
    // wall opposite; corners and the ceiling stay in soft shade
    vec3 Nw = normalize(vObjN);
    float pool = 0.0;
    for (int k = 0; k < 3; k++) {
      vec3 toW = uRoomWin[k].xyz - vObj;
      float d = length(toW);
      pool += uRoomWin[k].w * max(0.0, dot(Nw, toW / d) * 0.8 + 0.2) / (1.0 + d * d * 0.35);
    }
    float fl = smoothstep(0.3, 0.9, Nw.y); // floor catches it best
    float lightAmt = clamp(0.02 + pool * (1.05 + fl * 0.7) + 0.1 * up + 0.35 * (aoR - 0.5), 0.0, 1.0);
    vec3 room = mix(uRoomDeep, uRoomLit, lightAmt);
    room = mix(uRoomLit * vec3(1.0, 0.97, 0.94), room, deep);
    room *= mix(vec3(1.0), diffuseColor.rgb, 0.55);
    room *= mix(0.5, 1.0, uCloudDim);
    reflectedLight.directDiffuse = mix(reflectedLight.directDiffuse, room, into);
    reflectedLight.indirectDiffuse *= 1.0 - into * 0.92;
    reflectedLight.directSpecular *= 1.0 - into * 0.8;
    totalEmissiveRadiance += uGlowCol * cg * deep * 0.22 * (1.0 - uCloudDim) * (1.0 - uFree);
  }
}
`;

const TRANSMISSION = THREE.ShaderChunk.transmission_fragment
  .replace('material.transmission = transmission;', 'material.transmission = S1.z;')
  .replace('material.thickness = thickness;', 'material.thickness = S1.w * (0.35 + 0.65 * (1.0 - vBake.z));');

// ---------------------------------------------------------------------------

export function createDeformUniforms() {
  return {
    uTime: { value: 0 },
    uPress: { value: new THREE.Vector4(0, 0, 0, 0) },
    uPressN: { value: new THREE.Vector4(0, 1, 0, 0.6) },
    uRipple: { value: new THREE.Vector4(0, 0, 0, -1) },
    uRippleAmp: { value: new THREE.Vector2(0.02, 7) },
    uPull: { value: new THREE.Vector4(0, 0, 0, 0.5) },
    uPullVec: { value: new THREE.Vector3() },
    uStretch: { value: new THREE.Vector4(0, 1, 0, 0) },
    uBreath: { value: 0 },
    uRough: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSag: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, -99, 0, 1)) },
    uSagK: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uFlat: { value: new THREE.Vector4(0, -99, 0, 1) },
    uFlatK: { value: new THREE.Vector4(0, 0, 0, 0) },
    uTurfDir: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
}

function stateUniformArrays(st) {
  return {
    v: [st.a, st.b, st.c, st.d, st.fz],
    c: [st.color, st.sheenColor, st.sssColor],
  };
}

export function createHouseMaterial(shared, stateA, stateB, withTransmission) {
  const deform = createDeformUniforms();
  const A = makeStateUniform();
  const B = makeStateUniform();
  packState(stateA, A);
  packState(stateB || stateA, B);
  const ua = stateUniformArrays(A);
  const ub = stateUniformArrays(B);

  const uniforms = {
    ...deform,
    uTime: shared.uTime,
    uSA: { value: ua.v }, uSAc: { value: ua.c },
    uSB: { value: ub.v }, uSBc: { value: ub.c },
    uMorph: { value: new THREE.Vector4(0, 0, 0, -1) },
    uMorphSoft: { value: 0.35 },
    uDrops: { value: Array.from({ length: 10 }, () => new THREE.Vector4()) },
    uDropCol: { value: Array.from({ length: 10 }, () => new THREE.Vector4(1, 1, 1, 1)) },
    uDropCount: { value: 0 },
    uAoMix: shared.uAoMix,
    uAoPart: { value: 1 },
    uAoStrength: shared.uAoStrength,
    uSunDirV: shared.uSunDirV,
    uSunCol: shared.uSunCol,
    uGlowCol: shared.uGlowCol,
    uGlowBoost: { value: 0 },
    uCloudLit: shared.uCloudLit,
    uCloudShadow: shared.uCloudShadow,
    uCloudRim: shared.uCloudRim,
    uCavGlow: shared.uCavGlow,
    uCloudDim: shared.uCloudDim,
    uSunFree: { value: 0 },
    uRoomLit: shared.uRoomLit,
    uRoomDeep: shared.uRoomDeep,
    uRoomWin: shared.uRoomWin,
    uFree: { value: 0 },
    uPaint: shared.uPaint,
    uPaintLo: shared.uPaintLo,
    uPaintInv: shared.uPaintInv,
    uPaintOffset: { value: new THREE.Vector3() },
    uPaintOn: { value: 1 },
    uOrig: shared.uOrig, uOrigLo: shared.uOrigLo, uOrigInv: shared.uOrigInv,
    uOrigOffset: { value: new THREE.Vector3() },
  };

  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.8,
    sheen: 1,
    clearcoat: 1,
    iridescence: 1,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [260, 720],
    transmission: withTransmission ? 1 : 0,
    thickness: 1,
    ior: 1.38,
    envMapIntensity: 1,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', VERT_NORMAL)
      .replace('#include <begin_vertex>', 'vec3 transformed = chPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
      .replace('#include <lights_physical_fragment>', FRAG_MATERIAL)
      .replace('#include <aomap_fragment>', FRAG_LIGHT)
      .replace('#include <transmission_fragment>', TRANSMISSION);
  };
  mat.customProgramCacheKey = () => 'cloudhouse-v8';
  mat.userData = { uniforms, A, B };
  return mat;
}

// depth / distance materials that follow the same deformation (shadows)
export function createDeformDepthMaterial(uniforms, kind = 'depth') {
  const mat = kind === 'depth'
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshDistanceMaterial();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${DEFORM_PARS}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = chDeform(position, normal);');
  };
  mat.customProgramCacheKey = () => 'cloudhouse-depth3-' + kind;
  return mat;
}
