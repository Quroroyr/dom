import * as THREE from 'three';

// A palette is weather: it tints the house per material family AND changes
// the air (sky, horizon, ground), the sun and the inner glow at the same time.

export const PALETTES = {
  cloud: {
    label: 'Cloud',
    air: { zenith: '#b5c2d3', horizon: '#ece4da', ground: '#e3dbd0', sun: '#fff0dd', glow: '#ffb870', word: '#b3a99f', lit: '#fff1e0', shade: '#bdbedb', rim: '#fffaf2' },
    tint: { cloud: '#fbf8f4', whip: '#fffaf2', candy: '#f8d3e3', mist: '#f6f8fb', foam: '#f7f2ea', ceramic: '#f4f6f8', gel: '#fbf8f3', pearl: '#f3ebe8', fabric: '#eeebe6', glass: '#f6f7f8' },
    accent: '#f2c7b4',
  },
  morning: {
    label: 'Morning',
    air: { zenith: '#c6d8e8', horizon: '#f6f0dc', ground: '#ebe4cf', sun: '#fff3d6', glow: '#ffe7a8', word: '#b9b09a' , lit: '#fff4de', shade: '#b6c7dc', rim: '#fffbe8' },
    tint: { cloud: '#fbf5e4', whip: '#fff7e2', candy: '#fbe9df', mist: '#f5f8fb', foam: '#f4eed8', ceramic: '#f8f8f5', gel: '#fff6dc', pearl: '#eef1f6', fabric: '#f1ecd9', glass: '#f7f8f4' },
    accent: '#f3dc8e',
  },
  sunset: {
    label: 'Sunset',
    air: { zenith: '#d3cdda', horizon: '#f1e2d8', ground: '#e7dbd2', sun: '#ffe4d0', glow: '#ffc9a0', word: '#bfa99c' , lit: '#ffe6d4', shade: '#d2bcc6', rim: '#ffdcc2' },
    tint: { cloud: '#fbe9df', whip: '#ffeee2', candy: '#f9dbe4', mist: '#f5eef0', foam: '#f2e0d6', ceramic: '#f6f1ef', gel: '#ffe8d8', pearl: '#ebdce3', fabric: '#eedcd3', glass: '#f7ebe5' },
    accent: '#ec9f86',
  },
  mist: {
    label: 'Mist',
    air: { zenith: '#c3ccd5', horizon: '#e5e9ec', ground: '#dde1e3', sun: '#f3f6fa', glow: '#e9f1ff', word: '#aab2b9' , lit: '#f4f7fb', shade: '#b3bfcc', rim: '#f2f7ff' },
    tint: { cloud: '#f1f4f7', whip: '#f6f8fa', candy: '#eee8f0', mist: '#f0f5fa', foam: '#e7eaec', ceramic: '#eef1f4', gel: '#f1f5f8', pearl: '#e6e8ee', fabric: '#e2e6e8', glass: '#eef3f6' },
    accent: '#a9c3cf',
  },
  pearl: {
    label: 'Pearl',
    air: { zenith: '#d4d2dc', horizon: '#eeebee', ground: '#e3dfe3', sun: '#fbf6ff', glow: '#f3e6ff', word: '#b7b0bb' , lit: '#fbf6fb', shade: '#c3bcd3', rim: '#fff4fb' },
    tint: { cloud: '#f7f3f7', whip: '#faf6f9', candy: '#f4e6f1', mist: '#f5f3f9', foam: '#efecef', ceramic: '#e9ebef', gel: '#f5f0f8', pearl: '#efe6ee', fabric: '#ebe6ec', glass: '#f3f0f6' },
    accent: '#cdb9dc',
  },
  lavender: {
    label: 'Lavender',
    air: { zenith: '#cfcbe0', horizon: '#eee9f0', ground: '#e4dee8', sun: '#fbf3ff', glow: '#eadcff', word: '#b3aac0' , lit: '#f9f2ff', shade: '#b8aed6', rim: '#fbf2ff' },
    tint: { cloud: '#f2ecf8', whip: '#f6f1fa', candy: '#eee0f3', mist: '#f2f0fa', foam: '#e9e3ef', ceramic: '#f3f2f7', gel: '#f2ebfa', pearl: '#e9e2f1', fabric: '#e4dcec', glass: '#f0edf7' },
    accent: '#b9a3d9',
  },
  // blue hour outside, amber light inside (the sky also dims the scene)
  evening: {
    label: 'Evening',
    air: { zenith: '#a9b3c6', horizon: '#dcd4d9', ground: '#cbc5c9', sun: '#ffd6b5', glow: '#ffbf80', word: '#a59fae' , lit: '#ffe4cc', shade: '#8f97b8', rim: '#ffd8b8' },
    tint: { cloud: '#f5eeea', whip: '#faf1ea', candy: '#f3e2e6', mist: '#eef0f4', foam: '#ede7e3', ceramic: '#eff1f5', gel: '#fff0dc', pearl: '#ebe2ea', fabric: '#e7e1df', glass: '#f1eef2' },
    accent: '#e8b08a',
  },
};

// linear-space colours for tweening
export function paletteColors(name) {
  const p = PALETTES[name];
  const c = (h) => new THREE.Color(h);
  return {
    air: Object.fromEntries(Object.entries(p.air).map(([k, v]) => [k, c(v)])),
    tint: Object.fromEntries(Object.entries(p.tint).map(([k, v]) => [k, c(v)])),
    accent: c(p.accent),
  };
}
