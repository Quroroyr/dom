import { PALETTES } from './render/palettes.js';
import { PAINT_COLORS } from './render/paint.js';
import { SCENES, SKIES } from './story.js';
import { WORLDS } from './modes/index.js';

// Thin DOM layer: a scene rail at the bottom, the variants of the current
// scene above it, two contextual actions, and the mode index at the top.
// Nothing here should compete with the frame.

const pad = (n) => String(n).padStart(2, '0');

export class UI {
  constructor() {
    this.indexN = document.querySelector('.index-n');
    this.indexName = document.querySelector('.index-name');
    this.copies = [...document.querySelectorAll('.copy')];
    this.nav = document.querySelector('.scenes');
    this.glide = document.querySelector('.scenes-glide');
    this.ctx = document.querySelector('.ctx');
    this.reassembleBtn = document.querySelector('.act--reassemble');
    this.viewBtn = document.querySelector('.act--view');
    this.status = document.querySelector('#sr-status');
    this._sceneShown = null;
    this.onScene = null;
    this.onPick = null;
    this.onStep = null;
    this.onBrush = null;
    this.onReassemble = null;
    this.onResetView = null;
    this.onKey = null;
    this.onClearPaint = null;
    this.onPaintColor = null;
    this.onUndo = null;
    this.onWorld = null;
    this.onSound = null;
    this.onMix = null;
    this.onMixReset = null;
    this.panels = {};
    this.options = {};

    document.querySelector('.index-of').textContent = `/ ${pad(SCENES.length)}`;
    this.sceneBtns = SCENES.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scene-btn';
      b.dataset.scene = s.id;
      // the number is the key that opens the scene; the name is the button
      b.innerHTML = `<span class="scene-n" aria-hidden="true">${pad(i + 1)}</span><span class="scene-l">${s.name}</span>`;
      b.setAttribute('aria-keyshortcuts', String(i + 1));
      b.addEventListener('click', () => this.onScene?.(s.id));
      this.nav.appendChild(b);
      return b;
    });

    this._panel('apart', 'Disassembly', SCENES.find((s) => s.id === 'apart').variants, 'text');
    this._panel('material', 'Material', [], 'swatch', null, (o) => o.swatch);
    this._worlds();
    this._panel('weather', 'Weather', SKIES, 'swatch', null, (o) => {
      const p = PALETTES[o.id];
      return `radial-gradient(circle at 35% 30%, ${p.tint.foam}, ${p.air.horizon} 55%, ${p.accent})`;
    });
    this._paintPanel();

    this._soundPanel();
    this.reassembleBtn.addEventListener('click', () => this.onReassemble?.());
    this.viewBtn.addEventListener('click', () => this.onResetView?.());
    addEventListener('keydown', (e) => {
      // Esc closes an open panel first (and goes nowhere else)
      if (e.key === 'Escape' && this.worldsOpen) { e.preventDefault(); this.setWorldsOpen(false, true); return; }
      if (e.key === 'Escape' && this.soundOpen) { e.preventDefault(); this.setSoundOpen(false, true); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea')) return;
      // inside the list of worlds the arrows move between worlds, not scenes
      if (this.worldsOpen && e.target.closest?.('.worlds') && /^Arrow(Up|Down)$|^Home$|^End$/.test(e.key)) {
        e.preventDefault();
        const list = this.worldBtns, i = list.indexOf(e.target);
        const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
        list[j].focus();
        return;
      }
      if (this.onKey?.(e)) e.preventDefault();
    });
    addEventListener('resize', () => this._moveGlide(true));
    document.fonts?.ready.then(() => this._moveGlide(true));
  }

  // one panel of variants for a scene: ‹ options › + the current name
  _panel(scene, title, list, kind, cls, bg) {
    const el = document.createElement('div');
    el.className = `ctx-panel ctx-panel--${kind}`;
    el.dataset.for = scene;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', title);
    const prev = document.createElement('button');
    prev.type = 'button'; prev.className = 'ctx-step'; prev.setAttribute('aria-label', `Previous ${title.toLowerCase()}`);
    prev.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>';
    const next = prev.cloneNode(true);
    next.setAttribute('aria-label', `Next ${title.toLowerCase()}`);
    next.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
    prev.addEventListener('click', () => this.onStep?.(-1));
    next.addEventListener('click', () => this.onStep?.(1));
    const opts = document.createElement('div');
    opts.className = 'ctx-options';
    this._optBuild = this._optBuild || {};
    this._optBuild[scene] = (items) => { opts.textContent = ''; this.options[scene] = build(items); };
    const build = (items) => items.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `opt ${cls ? cls(o) : ''}`;
      b.dataset.value = o.id;
      b.setAttribute('aria-label', o.label);
      b.title = o.label;
      if (kind === 'swatch') {
        const i = document.createElement('i');
        if (bg) i.style.background = bg(o);
        b.appendChild(i);
      } else b.textContent = o.label;
      b.addEventListener('click', () => this.onPick?.(o.id));
      opts.appendChild(b);
      return b;
    });
    this.options[scene] = build(list);
    const name = document.createElement('p');
    name.className = 'ctx-name';
    el.append(prev, opts, next);
    if (kind === 'swatch') el.appendChild(name);
    this.ctx.appendChild(el);
    this.panels[scene] = el;
  }

  // the brush: its own palette (not the material's, not the sky's), size,
  // softness, opacity, an eraser, undo and clear
  _paintPanel() {
    const el = document.createElement('div');
    el.className = 'ctx-panel ctx-panel--paint';
    el.dataset.for = 'paint';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Paint');
    const colors = document.createElement('div');
    colors.className = 'paint-colors';
    this.paintSwatches = PAINT_COLORS.map((c) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt paint-swatch';
      b.dataset.value = c.id;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      const i = document.createElement('i');
      i.style.background = `radial-gradient(circle at 34% 30%, rgb(255 255 255 / 0.55), ${c.hex} 58%)`;
      b.appendChild(i);
      b.addEventListener('click', () => this.onPaintColor?.(c.id));
      colors.appendChild(b);
      return b;
    });
    // the turf world's own brush: it grows wildflowers instead of laying colour
    // (shown only in that world, see style.css)
    {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt paint-swatch paint-swatch--flowers';
      b.dataset.value = 'flowers';
      b.title = 'Wildflowers';
      b.setAttribute('aria-label', 'Wildflowers');
      b.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">'
        + '<circle cx="6.2" cy="7" r="2.6" fill="#f4efe4"/><circle cx="6.2" cy="7" r="1" fill="#e2b937"/>'
        + '<circle cx="13.6" cy="6.2" r="2.3" fill="#e8674a"/><circle cx="13.6" cy="6.2" r=".8" fill="#2f2a25"/>'
        + '<circle cx="10.2" cy="13.4" r="2.5" fill="#8c95d9"/><circle cx="10.2" cy="13.4" r=".85" fill="#f3e6b0"/>'
        + '</svg>';
      b.addEventListener('click', () => this.onPaintColor?.('flowers'));
      colors.appendChild(b);
      this.paintSwatches.push(b);
    }
    const name = document.createElement('p');
    name.className = 'ctx-name paint-name';
    this.paintName = name;
    const sliders = document.createElement('div');
    sliders.className = 'paint-sliders';
    const slider = (key, label, min, max, step, value) => {
      const l = document.createElement('label');
      l.className = 'pslider';
      const t = document.createElement('span');
      t.textContent = label;
      t.dataset.k = key;
      const r = document.createElement('input');
      r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value;
      r.setAttribute('aria-label', label);
      r.addEventListener('input', () => this.onBrush?.(key, +r.value));
      l.append(t, r);
      sliders.appendChild(l);
      return r;
    };
    this.paintSliders = {
      radius: slider('radius', 'Size', 0.18, 1.1, 0.01, 0.5),
      softness: slider('softness', 'Soft', 0, 1, 0.01, 0.6),
      opacity: slider('opacity', 'Opacity', 0.08, 0.9, 0.01, 0.45),
    };
    const actions = document.createElement('div');
    actions.className = 'paint-actions';
    const btn = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'brush';
      b.textContent = label;
      b.addEventListener('click', fn);
      actions.appendChild(b);
      return b;
    };
    this.eraseBtn = btn('Eraser', () => this.onBrush?.('erase', !this.eraseBtn.classList.contains('is-on')));
    this.eraseBtn.setAttribute('aria-pressed', 'false');
    this.undoBtn = btn('Undo', () => this.onUndo?.());
    this.clearBtn = btn('Clear all', () => this.onClearPaint?.());
    this.undoBtn.disabled = true;
    this.clearBtn.disabled = true;
    el.append(colors, name, sliders, actions);
    this.ctx.appendChild(el);
    this.panels.paint = el;
  }
  setPaint({ color, erase }) {
    if (color) {
      for (const b of this.paintSwatches) {
        const on = b.dataset.value === color;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
        if (on) this.paintName.textContent = b.title;
      }
      // flowers: the opacity slider sets how thickly they grow
      const flowers = color === 'flowers';
      this.panels.paint.classList.toggle('is-flowers', flowers);
      const t = this.panels.paint.querySelector('.pslider span[data-k="opacity"]');
      if (t) t.textContent = flowers ? 'Density' : 'Opacity';
      this.paintSliders.opacity.setAttribute('aria-label', flowers ? 'Density' : 'Opacity');
    }
    if (erase !== undefined) {
      this.eraseBtn.classList.toggle('is-on', erase);
      this.eraseBtn.setAttribute('aria-pressed', String(erase));
      this.panels.paint.classList.toggle('is-erasing', erase);
      if (erase) this.paintName.textContent = 'Eraser';
      else { const on = this.paintSwatches.find((b) => b.classList.contains('is-on')); if (on) this.paintName.textContent = on.title; }
    }
  }
  setPaintState(has, canUndo) {
    this.clearBtn.disabled = !has;
    this.undoBtn.disabled = !canUndo;
  }

  _mark(scene, value) {
    for (const b of this.options[scene] || []) {
      const on = b.dataset.value === value;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
      if (on) {
        const n = this.panels[scene].querySelector('.ctx-name');
        if (n) n.textContent = b.getAttribute('aria-label');
      }
    }
  }

  // one short line for a screen reader (the status region is polite)
  say(text) {
    if (!this.status) return;
    // the same words twice in a row are still announced
    this.status.textContent = '';
    requestAnimationFrame(() => { this.status.textContent = text; });
  }

  setScene(idx, scene) {
    this.indexN.textContent = pad(idx + 1);
    this.indexName.textContent = scene.name;
    // only the words of the scene on screen exist for assistive technology
    for (const c of this.copies) {
      const on = c.dataset.scene === scene.id;
      c.classList.toggle('is-active', on);
      c.inert = !on;
      if (on) c.removeAttribute('aria-hidden'); else c.setAttribute('aria-hidden', 'true');
    }
    // announced on a change, not on arrival: scene n of N, its name, its words
    if (this._sceneShown && this._sceneShown !== scene.id) {
      const words = this.copies.find((c) => c.dataset.scene === scene.id)?.textContent.replace(/\s+/g, ' ').trim();
      this.say(`${scene.name}, scene ${idx + 1} of ${this.sceneBtns.length}. ${words || ''}`);
    }
    this._sceneShown = scene.id;
    for (const b of this.sceneBtns) {
      const on = b.dataset.scene === scene.id;
      b.classList.toggle('is-on', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    for (const [id, p] of Object.entries(this.panels)) p.classList.toggle('is-on', id === scene.id);
    document.body.classList.toggle('has-ctx', !!this.panels[scene.id]);
    document.body.dataset.scene = scene.id;
    this._moveGlide();
  }

  _moveGlide(instant = false) {
    const on = this.sceneBtns.find((b) => b.classList.contains('is-on'));
    if (!on || !this.glide) return;
    if (instant) this.glide.style.transition = 'none';
    this.glide.style.width = `${on.offsetWidth}px`;
    this.glide.style.transform = `translateX(${on.offsetLeft}px)`;
    if (instant) requestAnimationFrame(() => { this.glide.style.transition = ''; });
  }

  // scene words: each world may override some of them (static strings from
  // the world modules); the cloud's are the defaults written in the page
  setCopy(over = {}) {
    if (!this._copyBase) {
      this._copyBase = new Map(this.copies.map((c) => [c, { h: c.querySelector('h2')?.innerHTML, p: c.querySelector('p')?.innerHTML }]));
    }
    for (const c of this.copies) {
      const base = this._copyBase.get(c), o = over[c.dataset.scene] || {};
      const h = c.querySelector('h2'), p = c.querySelector('p');
      if (h) h.innerHTML = o.h ?? base.h;
      if (p) p.innerHTML = o.p ?? base.p;
    }
  }

  // the Material scene lists the active world's own families
  setMaterials(list) { this._optBuild.material(list); }

  // material worlds: a small segmented control in the header; on narrow or
  // short screens a button naming the current world opens them as a list
  _worlds() {
    const box = document.querySelector('.worlds');
    this.worldToggle = document.querySelector('.world-toggle');
    this.worldsOpen = false;
    this.worldToggle.addEventListener('click', () => this.setWorldsOpen(!this.worldsOpen));
    addEventListener('pointerdown', (e) => {
      if (this.worldsOpen && !e.target.closest?.('.world-switch')) this.setWorldsOpen(false);
    }, { capture: true });
    this.worldBtns = WORLDS.map((w) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'world-btn';
      b.dataset.world = w.id;
      b.setAttribute('aria-pressed', 'false');
      const i = document.createElement('i');
      i.style.background = w.dot;
      const l = document.createElement('span');
      l.textContent = w.label;
      b.append(i, l);
      b.addEventListener('click', () => {
        const back = this.worldsOpen;
        this.onWorld?.(w.id);
        if (back) this.setWorldsOpen(false, true);
      });
      box.appendChild(b);
      return b;
    });
  }
  setWorldsOpen(open, focusBack = false) {
    if (open && this.soundOpen) this.setSoundOpen(false);
    this.worldsOpen = open;
    this.worldToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('worlds-open', open);
    if (open) (this.worldBtns.find((b) => b.classList.contains('is-on')) || this.worldBtns[0])?.focus();
    else if (focusBack) this.worldToggle.focus();
  }
  setWorld(id) {
    const prev = document.body.dataset.world;
    for (const b of this.worldBtns) {
      const on = b.dataset.world === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const w = WORLDS.find((x) => x.id === id);
    if (w) {
      this.worldToggle.querySelector('i').style.background = w.dot;
      this.worldToggle.querySelector('.world-toggle-l').textContent = w.label;
      if (prev && prev !== id) this.say(`Made of ${w.label}.`);
    }
    document.body.dataset.world = id;
  }
  setWorldLoading(id, on) {
    const b = this.worldBtns.find((x) => x.dataset.world === id);
    if (!b) return;
    b.classList.toggle('is-loading', on);
    if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
    // the button names the world being asked for, so it shows the wait too
    if (document.body.dataset.world === id) {
      this.worldToggle.classList.toggle('is-loading', on);
      if (on) this.worldToggle.setAttribute('aria-busy', 'true'); else this.worldToggle.removeAttribute('aria-busy');
    }
  }

  // sound: the header icon opens a small panel — on/off, volume, a
  // three-band EQ, reset
  _soundPanel() {
    this.soundBtn = document.querySelector('.sound');
    this.soundPop = document.querySelector('.sound-pop');
    this.soundPower = this.soundPop.querySelector('.sp-power');
    this.soundInputs = [...this.soundPop.querySelectorAll('input[type="range"]')];
    this.soundOpen = false;
    this.soundBtn.addEventListener('click', () => this.setSoundOpen(!this.soundOpen));
    this.soundPower.addEventListener('click', () => this.onSound?.(this.soundPower.getAttribute('aria-checked') !== 'true'));
    for (const r of this.soundInputs) {
      r.addEventListener('input', () => { this._soundValue(r); this.onMix?.(r.dataset.k, +r.value); });
      // a double click returns a band to flat
      if (r.dataset.k !== 'vol') r.addEventListener('dblclick', () => { r.value = 0; r.dispatchEvent(new Event('input')); });
    }
    this.soundPop.querySelector('.sp-reset').addEventListener('click', () => this.onMixReset?.());
    // a press anywhere else closes it
    addEventListener('pointerdown', (e) => {
      if (this.soundOpen && !e.target.closest?.('.sound-wrap')) this.setSoundOpen(false);
    }, { capture: true });
  }
  setSoundOpen(open, focusBack = false) {
    if (open && this.worldsOpen) this.setWorldsOpen(false);
    this.soundOpen = open;
    this.soundPop.hidden = !open;
    this.soundBtn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('sound-open', open);
    if (focusBack) this.soundBtn.focus();
  }
  _soundValue(r) {
    const v = +r.value, o = r.nextElementSibling;
    if (r.dataset.k === 'vol') o.textContent = String(Math.round(v));
    else o.textContent = `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)} dB`;
    // fill from the centre (EQ) or from the left (volume)
    const min = +r.min, max = +r.max, k = (v - min) / (max - min);
    const from = r.dataset.k === 'vol' ? 0 : 0.5;
    r.style.setProperty('--a', `${Math.min(from, k) * 100}%`);
    r.style.setProperty('--b', `${Math.max(from, k) * 100}%`);
  }
  setMix(mix) {
    for (const r of this.soundInputs) { r.value = mix[r.dataset.k]; this._soundValue(r); }
  }
  setSound(on) {
    this.soundBtn.classList.toggle('is-off', !on);
    this.soundBtn.title = on ? 'Sound' : 'Sound off';
    this.soundPower.setAttribute('aria-checked', String(on));
    this.soundPower.setAttribute('aria-label', on ? 'Sound on' : 'Sound off');
    this.soundPop.classList.toggle('is-off', !on);
  }

  setVariant(scene, v) { this._mark(scene, v); }
  setMaterial(m) { this._mark('material', m); }
  setPalette(p) { this._mark('weather', p); }
  setBusy(on) { document.body.classList.toggle('is-busy', on); }
  setActions(reassemble, view) {
    this.reassembleBtn.classList.toggle('is-on', reassemble);
    this.viewBtn.classList.toggle('is-on', view);
    this.reassembleBtn.tabIndex = reassemble ? 0 : -1;
    this.viewBtn.tabIndex = view ? 0 : -1;
  }
}
