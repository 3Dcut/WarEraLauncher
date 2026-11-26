// Konfetti und Funken auf einer Leinwand über der ganzen Seite. Die Schleife läuft nur,
// solange Teilchen unterwegs sind; bei reduzierter Bewegung gibt es nur wenige.

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  life: number;
  max: number;
  shape: 'rect' | 'spark';
}

let canvas: HTMLCanvasElement | null = null;
let g: CanvasRenderingContext2D | null = null;
const parts: Particle[] = [];
let running = false;
let reduced = false;
let rainUntil = 0;
let rainColors: string[] = [];

export function setFxReduced(value: boolean): void {
  reduced = value;
}

function ensureCanvas(): boolean {
  if (canvas && g) return true;
  canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);
  g = canvas.getContext('2d');
  const resize = () => {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    g?.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);
  return !!g;
}

function spawn(x: number, y: number, color: string, speed: number, shape: Particle['shape']): void {
  const angle = Math.random() * Math.PI * 2;
  const v = speed * (0.35 + Math.random() * 0.65);
  parts.push({
    x,
    y,
    vx: Math.cos(angle) * v,
    vy: Math.sin(angle) * v - speed * 0.35,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.4,
    size: shape === 'spark' ? 2 + Math.random() * 2 : 5 + Math.random() * 6,
    color,
    life: 0,
    max: 60 + Math.random() * 50,
    shape,
  });
}

/** Explosion an einer Stelle, etwa beim Öffnen einer Kiste. */
export function burst(x: number, y: number, colors: string[], count = 60): void {
  if (!ensureCanvas()) return;
  const n = reduced ? Math.min(12, count) : count;
  for (let i = 0; i < n; i++) spawn(x, y, colors[i % colors.length], reduced ? 4 : 9, i % 3 === 0 ? 'spark' : 'rect');
  loop();
}

/** Konfettiregen über die ganze Breite, für den Sieg. */
export function rain(colors: string[], ms = 4500): void {
  if (!ensureCanvas()) return;
  rainColors = colors;
  rainUntil = performance.now() + (reduced ? 600 : ms);
  loop();
}

export function burstAt(el: Element | null, colors: string[], count?: number): void {
  if (!el) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, colors, count);
}

function loop(): void {
  if (running) return;
  running = true;
  const step = () => {
    if (!g || !canvas) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (performance.now() < rainUntil) {
      for (let i = 0; i < (reduced ? 1 : 5); i++) {
        parts.push({
          x: Math.random() * w,
          y: -10,
          vx: (Math.random() - 0.5) * 2,
          vy: 2 + Math.random() * 3,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.3,
          size: 6 + Math.random() * 6,
          color: rainColors[Math.floor(Math.random() * rainColors.length)],
          life: 0,
          max: 260,
          shape: 'rect',
        });
      }
    }
    g.clearRect(0, 0, w, h);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life++;
      p.vy += p.shape === 'spark' ? 0.12 : 0.18;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      if (p.life > p.max || p.y > h + 40) {
        parts.splice(i, 1);
        continue;
      }
      const fade = 1 - Math.max(0, (p.life - p.max * 0.7) / (p.max * 0.3));
      g.globalAlpha = fade;
      g.fillStyle = p.color;
      if (p.shape === 'spark') {
        g.beginPath();
        g.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        g.fill();
      } else {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        g.restore();
      }
    }
    g.globalAlpha = 1;
    if (parts.length || performance.now() < rainUntil) requestAnimationFrame(step);
    else {
      running = false;
      g.clearRect(0, 0, w, h);
    }
  };
  requestAnimationFrame(step);
}
