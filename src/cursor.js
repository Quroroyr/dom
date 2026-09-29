// Soft ring cursor that names the gesture (press / pull / turn / paint).

export class Cursor {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'cursor';
    this.el.innerHTML = '<span class="cursor-ring"></span><span class="cursor-label"></span>';
    document.body.appendChild(this.el);
    this.label = this.el.querySelector('.cursor-label');
    this.x = this.tx = innerWidth / 2;
    this.y = this.ty = innerHeight / 2;
    this.state = null;
    this.coarse = matchMedia('(pointer: coarse)').matches;
    if (this.coarse) this.el.style.display = 'none';
    const loop = () => {
      this.x += (this.tx - this.x) * 0.22;
      this.y += (this.ty - this.y) * 0.22;
      this.el.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
      requestAnimationFrame(loop);
    };
    loop();
  }
  move(x, y) { this.tx = x; this.ty = y; }
  setState(verb, active) {
    const key = `${verb}|${active}`;
    if (key === this.state) return;
    this.state = key;
    this.el.dataset.verb = verb || '';
    this.el.classList.toggle('is-active', !!active);
    this.el.classList.toggle('is-over', !!verb);
    if (verb) this.label.textContent = verb;
  }
  flash(text) {
    this.label.textContent = text;
    this.el.classList.add('is-flash');
    setTimeout(() => this.el.classList.remove('is-flash'), 700);
  }
}
