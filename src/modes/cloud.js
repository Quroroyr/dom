import * as THREE from 'three';
import { FAMILIES } from '../render/families.js';

// CLOUD — the house as it was born: airy, fluffy, cotton-candy soft.
// Its families live in render/families.js (they are the base set); this
// world only describes how they are used.

const swatch = {
  cloud: 'radial-gradient(circle at 35% 30%, #ffffff, #f4f1f6 45%, #c9cde0)',
  whip: 'radial-gradient(circle at 30% 26%, #ffffff 0 20%, #fbf3e6 50%, #e9dccb)',
  candy: 'radial-gradient(circle at 35% 30%, #fff5f9, #f7d9e6 55%, #e8c0d6)',
  mist: 'radial-gradient(circle at 40% 35%, rgba(255,255,255,0.95), rgba(226,234,245,0.8) 60%, #c9d6e6)',
};

export function createWorld() {
  return {
    id: 'cloud',
    label: 'Cloud',
    dot: 'radial-gradient(circle at 35% 30%, #ffffff, #f1eef4 50%, #c6c9dd)',
    materials: ['cloud', 'whip', 'candy', 'mist'].map((id) => ({ id, label: FAMILIES[id].label, swatch: swatch[id] })),
    defaultFamily: 'cloud',
    demoFamily: 'whip',
    sky: 'cloud',
    room: {
      outLit: new THREE.Color('#e6cfb8'), outDeep: new THREE.Color('#9d8579'),
      inLit: new THREE.Color('#f6eee6'), inDeep: new THREE.Color('#b8aca6'),
    },
    fibre: { tint: new THREE.Color('#fbf8f4'), width: 1 },
    wind: [0.8, 0.45, 0, 0],
    // cotton: a slow sugar-floss strand around a melting core; loose pieces
    // weigh nothing, drift out to a halo and bob there
    activate(ctx) {
      const T = ctx.tearing;
      Object.assign(T.wisp.style, { core: true, count: 96, breakK: 1, lifeK: 1, snapK: 1 });
      Object.assign(T.tearK, { breakK: 1, stretchK: 1, give: 1, tremble: 0, recoil: 1, ripple: 1 });
      T.setSod(null);
      Object.assign(T.physics, {
        gravity: 0, halo: true, bob: true, drag: 1.1, rest: 0.12, slide: 5.5, ground: false, groundFric: 0,
        follow: 12, holdSag: 0, throwMax: 12, spinK: 1, spinDamp: 1.6, impactPress: 1, impactRipple: 1,
      });
      ctx.setFuzzLod(false);
      ctx.setFuzzLayers(8);
      ctx.setFuzzSolid(false);
    },
  };
}
