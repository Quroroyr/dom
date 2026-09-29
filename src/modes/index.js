// Material worlds of the house.
//
// The house core (field, meshing, tearing, physics, paint, scenes, camera,
// UI shell) is shared. A world only says what the house is made of:
//
//   materials      the families offered in the Material scene
//   defaultFamily  what the house becomes when the world is entered
//   demoFamily     what the Material scene shows off on arrival
//   sky            its own air and light (a palette)
//   room           the tone of the carved room, seen from outside / inside
//   fibre          colour and weight of the strand when a piece is torn
//   wind           breeze through standing fuzz
//   init(ctx)      builds its own resources, once (lazy)
//   activate / deactivate / update   only while it is the active world
//
// Each world is its own module and its own bundle chunk. Only the default
// world is loaded at start; another is fetched and built the first time it
// is chosen, then kept.

// label and dot are here (tiny) so the switcher can show every world before
// its module is fetched
export const WORLDS = [
  { id: 'cloud', label: 'Cloud', dot: 'radial-gradient(circle at 35% 30%, #ffffff, #f1eef4 50%, #c6c9dd)', load: () => import('./cloud.js') },
  { id: 'grass', label: 'Grass', dot: 'radial-gradient(circle at 35% 30%, #e3f0c4, #93b56d 55%, #587d42)', load: () => import('./grass.js') },
];

export class Worlds {
  constructor(ctx) {
    this.ctx = ctx;
    this.cache = new Map();
    this.pending = new Map();
    this.active = null;
    this.leaving = new Set(); // worlds fading their effects out
  }

  isLoaded(id) { return this.cache.has(id); }

  // fetch + build a world once; later calls reuse it
  load(id) {
    if (this.cache.has(id)) return Promise.resolve(this.cache.get(id));
    if (this.pending.has(id)) return this.pending.get(id);
    const entry = WORLDS.find((w) => w.id === id);
    if (!entry) return Promise.reject(new Error(`unknown world ${id}`));
    const t0 = performance.now();
    const p = entry.load()
      .then((mod) => mod.createWorld())
      .then(async (w) => {
        await w.init?.(this.ctx);
        w.loadMs = Math.round(performance.now() - t0);
        this.cache.set(id, w);
        this.pending.delete(id);
        return w;
      })
      .catch((err) => { this.pending.delete(id); throw err; });
    this.pending.set(id, p);
    return p;
  }

  // the one world that renders and runs its effects
  switchTo(w) {
    if (this.active === w) return;
    if (this.active) { this.active.deactivate?.(this.ctx); this.leaving.add(this.active); }
    this.leaving.delete(w);
    this.active = w;
    w.activate?.(this.ctx);
  }

  // only the active world (and one still fading out) does any work
  update(dt, t) {
    this.active?.update?.(dt, t, this.ctx);
    for (const w of this.leaving) {
      w.update?.(dt, t, this.ctx);
      if (w.idle?.() ?? true) this.leaving.delete(w);
    }
  }
}
