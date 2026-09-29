import * as THREE from 'three';

// Five material families. Every value is a uniform so a part can morph
// between families without recompiling. `micro` = procedural surface detail:
// type 0 none, 1 foam pores, 2 glaze orange-peel, 3 woven fabric, 4 pearl growth lines.

export const FAMILIES = {
  // CLOUD — ultra diffuse, soft white, fibrous
  cloud: {
    label: 'Cloud',
    color: '#fbf8f4', roughness: 0.96, sheen: 0.35, sheenColor: '#ffffff', sheenRoughness: 0.7,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.6, sssColor: '#ffe9dc', glow: 0.0, micro: 5, microAmp: 0.32, microScale: 5, stylize: 1, fiber: 0.3,
    opacity: 1, fuzz: 0.17, fuzzDensity: 1.0, fuzzFiber: 1.0,
  },
  // WHIPPED CREAM — warmer, smoother, thick glossy highlights, piped relief
  whip: {
    label: 'Whipped cream',
    color: '#fff3e2', roughness: 0.34, sheen: 0.15, sheenColor: '#ffffff', sheenRoughness: 0.4,
    clearcoat: 0.8, clearcoatRoughness: 0.22, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.5, sssColor: '#ffe6cc', glow: 0.0, micro: 6, microAmp: 0.9, microScale: 3.2, stylize: 0.55, fiber: 0.0,
    opacity: 1, fuzz: 0.02, fuzzDensity: 0.0, fuzzFiber: 1.0,
  },
  // COTTON CANDY — pale pink, airy, glowing through, fine long fibres
  candy: {
    label: 'Cotton candy',
    color: '#fbdde9', roughness: 0.98, sheen: 0.9, sheenColor: '#fff0f6', sheenRoughness: 0.5,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 1.35, sssColor: '#ffd3e6', glow: 0.0, micro: 5, microAmp: 0.5, microScale: 8, stylize: 1, fiber: 1.0,
    opacity: 1, fuzz: 0.28, fuzzDensity: 1.25, fuzzFiber: 2.3,
  },
  // MIST — cool, low density, see-through body, edges melting into air
  mist: {
    label: 'Mist',
    color: '#eef3fa', roughness: 0.9, sheen: 0.0, sheenColor: '#ffffff', sheenRoughness: 0.5,
    clearcoat: 0.0, clearcoatRoughness: 0.3, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 1.1, sssColor: '#e6efff', glow: 0.0, micro: 5, microAmp: 0.2, microScale: 3, stylize: 1, fiber: 0.2,
    opacity: 0.5, fuzz: 0.5, fuzzDensity: 0.7, fuzzFiber: 0.55,
  },
  foam: {
    label: 'Cloud Foam',
    color: '#f7f2ea', roughness: 0.94, sheen: 0.5, sheenColor: '#fffaf2', sheenRoughness: 0.6,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.45, sssColor: '#ffe2cc', glow: 0.0, micro: 1, microAmp: 0.32, microScale: 30,
  },
  ceramic: {
    label: 'Milk Ceramic',
    color: '#f4f6f8', roughness: 0.3, sheen: 0.0, sheenColor: '#ffffff', sheenRoughness: 0.5,
    clearcoat: 0.8, clearcoatRoughness: 0.09, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.22, sssColor: '#ffe6d2', glow: 0.0, micro: 2, microAmp: 0.08, microScale: 9,
  },
  gel: {
    label: 'Frosted Gel',
    color: '#fbf8f3', roughness: 0.38, sheen: 0.0, sheenColor: '#ffffff', sheenRoughness: 0.5,
    clearcoat: 0.5, clearcoatRoughness: 0.12, iridescence: 0.0, transmission: 0.7, thickness: 0.8,
    sss: 0.9, sssColor: '#ffe9d4', glow: 0.85, micro: 0, microAmp: 0.0, microScale: 1,
  },
  pearl: {
    label: 'Pearl Shell',
    color: '#f3ebe8', roughness: 0.2, sheen: 0.25, sheenColor: '#f3ecff', sheenRoughness: 0.35,
    clearcoat: 0.9, clearcoatRoughness: 0.08, iridescence: 1.0, transmission: 0.0, thickness: 0.0,
    sss: 0.18, sssColor: '#f5e8ff', glow: 0.0, micro: 4, microAmp: 0.12, microScale: 6,
  },
  fabric: {
    label: 'Fabric Membrane',
    color: '#eeebe6', roughness: 0.86, sheen: 1.0, sheenColor: '#e9f0ff', sheenRoughness: 0.42,
    clearcoat: 0.0, clearcoatRoughness: 0.5, iridescence: 0.0, transmission: 0.0, thickness: 0.0,
    sss: 0.7, sssColor: '#ffe9d8', glow: 0.0, micro: 3, microAmp: 0.35, microScale: 60,
  },
  glass: {
    label: 'Soft Glass',
    color: '#f6f7f8', roughness: 0.16, sheen: 0.0, sheenColor: '#ffffff', sheenRoughness: 0.5,
    clearcoat: 0.6, clearcoatRoughness: 0.05, iridescence: 0.15, transmission: 1.0, thickness: 0.6,
    sss: 0.35, sssColor: '#fff1e2', glow: 0.1, micro: 0, microAmp: 0.0, microScale: 1,
  },
};

// Flatten a family into a plain numeric state (colours as THREE.Color, linear)
export function familyState(name, tint) {
  const f = FAMILIES[name];
  const c = new THREE.Color(f.color);
  if (tint) c.multiply(tint);
  return {
    name,
    color: c,
    roughness: f.roughness,
    sheen: f.sheen,
    sheenColor: new THREE.Color(f.sheenColor),
    sheenRoughness: f.sheenRoughness,
    clearcoat: f.clearcoat,
    clearcoatRoughness: f.clearcoatRoughness,
    iridescence: f.iridescence,
    transmission: f.transmission,
    thickness: f.thickness,
    sss: f.sss,
    sssColor: new THREE.Color(f.sssColor),
    glow: f.glow,
    micro: f.micro,
    microAmp: f.microAmp,
    microScale: f.microScale,
    stylize: f.stylize || 0,
    fiber: f.fiber || 0,
    opacity: f.opacity ?? 1,
    fuzz: f.fuzz ?? 0.17,
    fuzzDensity: f.fuzzDensity ?? 1,
    fuzzFiber: f.fuzzFiber ?? 1,
    // 0 = cotton fuzz, 1 = standing blades (a material world adds its own
    // families at load time, see src/modes/)
    grass: f.grass ?? 0,
  };
}

// uniform packing: 4 vec4 + 2 vec3 per state
export function packState(s, u) {
  u.a.set(s.roughness, s.sheen, s.sheenRoughness, s.clearcoat);
  u.b.set(s.clearcoatRoughness, s.iridescence, s.transmission, s.thickness);
  u.c.set(s.sss, s.glow, s.micro, s.microAmp);
  u.d.set(s.microScale, s.stylize, s.fiber, s.opacity);
  if (u.fz) u.fz.set(s.fuzz, s.fuzzDensity, s.fuzzFiber, s.grass || 0);
  u.color.copy(s.color);
  u.sheenColor.copy(s.sheenColor);
  u.sssColor.copy(s.sssColor);
}

export function makeStateUniform() {
  return {
    a: new THREE.Vector4(), b: new THREE.Vector4(), c: new THREE.Vector4(), d: new THREE.Vector4(), fz: new THREE.Vector4(),
    color: new THREE.Color(), sheenColor: new THREE.Color(), sssColor: new THREE.Color(),
  };
}
