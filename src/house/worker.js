import { meshPart } from './mesher.js';
import { buildVariant, setAlive, useConfig, brickPart, clumpPart, groupPart, sodPart, sceneSDF, bakeSkinDepth } from './sdf.js';

// Each worker keeps its own copy of the cloud field (alive puffs + configs).
// Messages are processed in order, so an 'alive' update always lands before
// the brick requests that depend on it.

let cell = 0.06;

const send = (msg, m) => {
  if (!m) { self.postMessage(msg); return; }
  self.postMessage({ ...msg, m }, [m.index.buffer, m.position.buffer, m.normal.buffer, m.bake.buffer, m.bake2.buffer]);
};

self.onmessage = (e) => {
  const d = e.data;
  if (d.type === 'init') {
    cell = d.cell;
    buildVariant();
  } else if (d.type === 'cell') {
    cell = d.cell;
  } else if (d.type === 'alive') {
    setAlive(d.ids, d.alive);
  } else if (d.type === 'bricks') {
    useConfig(d.config === 'live' ? null : d.config);
    d.keys.forEach((key, i) => {
      const part = brickPart(key);
      const m = part ? meshPart(part, cell, sceneSDF) : null;
      send({ type: 'brick', key, config: d.config, gen: d.gens[i] }, m);
    });
    useConfig(null);
  } else if (d.type === 'clump') {
    const m = meshPart(clumpPart(d.id), cell * 0.85, sceneSDF);
    send({ type: 'clump', id: d.id }, m);
  } else if (d.type === 'skin') {
    // the depth below the untouched outer skin (turf world), baked off the
    // main thread; the grid goes back as a transferable
    const S = bakeSkinDepth();
    const depth = S.depth.slice();
    self.postMessage({ type: 'skin', depth, n: S.n, lo: S.lo, cell: S.cell }, [depth.buffer]);
  } else if (d.type === 'sod') {
    const m = meshPart(sodPart(d.id), cell * 0.85, sceneSDF);
    send({ type: 'clump', id: `sod:${d.id}` }, m);
  } else if (d.type === 'group') {
    const m = meshPart(groupPart(d.ids), cell * 0.9, sceneSDF);
    send({ type: 'clump', id: d.id }, m);
  }
};
