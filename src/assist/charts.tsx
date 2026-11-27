// Kleine Grafiken ohne Bibliothek: Verlauf mit Erwartungsband und Min/Max-Hülle (SVG), Balken mit Erwartungsstrich, ein
// Zellband auf einer Canvas-Fläche, das jede einzelne Ziehung darstellt, und ein Streudiagramm. Jede Grafik hat eine
// Hover-/Fokus-Anzeige; Texte stehen in Textfarben, nur die Marken tragen Farbe.

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Breite des Containers in Pixeln, damit Schrift und Linien nicht mitskalieren. */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Tip {
  x: number;
  y: number;
  content: ComponentChildren;
}

function TipBox({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div class="c-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }} role="status">
      {tip.content}
    </div>
  );
}

/** Saubere Achsenstriche (1, 2, 5 × 10^n). */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => raw <= s) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

// ------------------------------------------------------------------ Verlauf

export interface LineSeries {
  label: string;
  /** Wert am Ende jedes Fachs, mit dem Anfangswert davor (Länge Fächer + 1). */
  values: ArrayLike<number>;
  tone: 'accent' | 'muted';
  /** Kleinster und größter Wert innerhalb jedes Fachs (Länge Fächer): die Hülle hinter der Linie. */
  min?: ArrayLike<number>;
  max?: ArrayLike<number>;
}

/**
 * Verlauf über Fächer: Jedes Fach bündelt gleich viele Ziehungen, Linie und Band zeigen die Werte an den Fachgrenzen, die
 * Hülle den kleinsten und größten Wert innerhalb. So fließt jede Kiste ein, auch wenn es eine Million sind.
 */
export function LineChart({
  series,
  band,
  end,
  height = 180,
  format,
  axisFormat,
  xLabel,
}: {
  series: LineSeries[];
  /** Untere und obere Grenze je Fachende, als Fläche hinter den Linien. */
  band?: { lo: ArrayLike<number>; hi: ArrayLike<number>; label: string };
  /** Ziehungen bis zum Ende jedes Fachs (Länge Fächer + 1, erster Eintrag 0). */
  end: ArrayLike<number>;
  height?: number;
  format: (v: number) => string;
  /** Kürzere Beschriftung der Achse, sonst wie format. */
  axisFormat?: (v: number) => string;
  /** Beschriftung zu einer Zahl von Ziehungen. */
  xLabel: (count: number) => string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 10, t: 8, b: 10 };
  const n = end.length;
  let lo = 0;
  let hi = 0;
  const widen = (v: number) => {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  };
  for (const s of series) {
    for (let i = 0; i < s.values.length; i++) widen(s.values[i]);
    if (s.min) for (let i = 0; i < s.min.length; i++) widen(s.min[i]);
    if (s.max) for (let i = 0; i < s.max.length; i++) widen(s.max[i]);
  }
  if (band) for (let i = 0; i < band.lo.length; i++) {
    widen(band.lo[i]);
    widen(band.hi[i]);
  }
  const span = hi - lo || 1;
  const ticks = niceTicks(lo, hi, 4);
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const path = (vals: ArrayLike<number>) => {
    let d = '';
    for (let i = 0; i < vals.length; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(vals[i]).toFixed(1)}`;
    return d;
  };
  const area = band
    ? (() => {
        let d = '';
        for (let i = 0; i < band.hi.length; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(band.hi[i]).toFixed(1)}`;
        for (let i = band.lo.length - 1; i >= 0; i--) d += `L${x(i).toFixed(1)},${y(band.lo[i]).toFixed(1)}`;
        return `${d}Z`;
      })()
    : '';
  // Hülle: oben die Maxima, unten die Minima, jeweils in der Mitte ihres Fachs
  const envelope = (s: LineSeries) => {
    if (!s.min || !s.max || !s.min.length) return '';
    let d = '';
    for (let b = 0; b < s.max.length; b++) d += `${b ? 'L' : 'M'}${x(b + 0.5).toFixed(1)},${y(s.max[b]).toFixed(1)}`;
    for (let b = s.min.length - 1; b >= 0; b--) d += `L${x(b + 0.5).toFixed(1)},${y(s.min[b]).toFixed(1)}`;
    return `${d}Z`;
  };

  const onMove = (e: PointerEvent) => {
    const svg = ref.current;
    if (!svg || n < 1) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const i = Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  if (n < 2) return <div class="c-wrap" ref={wrap} />;
  const tipLeft = hover === null ? 0 : (x(hover) / width) * 100;
  return (
    <div class="c-wrap" ref={wrap}>
      <svg
        ref={ref}
        class="c-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
          if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
        }}
        onBlur={() => setHover(null)}
        role="img"
        aria-label={series.map((s) => `${s.label}: ${format(s.values[s.values.length - 1] ?? 0)}`).join(' · ')}
      >
        {ticks.map((v) => (
          <g>
            <line class={`c-grid ${v === 0 ? 'c-grid--zero' : ''}`} x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} />
            <text class="c-axis" x={pad.l - 6} y={y(v) + 4} text-anchor="end">
              {(axisFormat ?? format)(v)}
            </text>
          </g>
        ))}
        {band && <path class="c-band" d={area} />}
        {series.map((s) => (s.min && s.max ? <path class={`c-envelope c-envelope--${s.tone}`} d={envelope(s)} /> : null))}
        {series.map((s) => (
          <path class={`c-line c-line--${s.tone}`} d={path(s.values)} />
        ))}
        {hover !== null && <line class="c-cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} />}
        {hover !== null && series.map((s) => <circle class={`c-end c-end--${s.tone}`} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} />)}
      </svg>
      {hover !== null && (
        <div class="c-tip c-tip--top" style={{ left: `${Math.min(78, Math.max(4, tipLeft))}%`, top: '6px' }}>
          <span class="c-tip__head">{xLabel(end[hover])}</span>
          {series.map((s) => (
            <span class="c-tip__row">
              <i class={`c-key c-key--${s.tone}`} />
              <strong>{format(s.values[hover] ?? 0)}</strong> {s.label}
            </span>
          ))}
          {hover > 0 &&
            series.map((s) =>
              s.min && s.max && (s.max[hover - 1] !== s.values[hover] || s.min[hover - 1] !== s.values[hover]) ? (
                <span class="c-tip__row muted">
                  {format(s.min[hover - 1])} … {format(s.max[hover - 1])}
                </span>
              ) : null,
            )}
          {band && (
            <span class="c-tip__row muted">
              {band.label}: {format(band.lo[hover])} … {format(band.hi[hover])}
            </span>
          )}
        </div>
      )}
      <div class="c-legend">
        {series.map((s) => (
          <span>
            <i class={`c-key c-key--${s.tone}`} />
            {s.label}
          </span>
        ))}
        {band && (
          <span>
            <i class="c-key c-key--band" />
            {band.label}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Balken mit Erwartung

export interface BarRow {
  key: string;
  label: string;
  value: number;
  expected: number;
  color: string;
  valueText: string;
  tip: ComponentChildren;
}

export function BarList({ rows, legend }: { rows: BarRow[]; legend: [string, string] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const max = Math.max(1e-9, ...rows.map((r) => Math.max(r.value, r.expected)));
  const ref = useRef<HTMLDivElement>(null);
  const show = (row: BarRow, el: HTMLElement) => {
    const box = ref.current?.getBoundingClientRect();
    const own = el.getBoundingClientRect();
    if (!box) return;
    setTip({ x: own.left - box.left + 80, y: own.top - box.top - 4, content: row.tip });
  };
  return (
    <div class="c-wrap" ref={ref}>
      <div class="c-bars">
        {rows.map((r) => (
          <div
            class="c-bar"
            tabIndex={0}
            onPointerEnter={(e) => show(r, e.currentTarget as HTMLElement)}
            onPointerLeave={() => setTip(null)}
            onFocus={(e) => show(r, e.currentTarget as HTMLElement)}
            onBlur={() => setTip(null)}
          >
            <span class="c-bar__label">{r.label}</span>
            <span class="c-bar__track">
              <span class="c-bar__fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
              <span class="c-bar__exp" style={{ left: `${(r.expected / max) * 100}%` }} />
            </span>
            <span class="c-bar__value mono">{r.valueText}</span>
          </div>
        ))}
      </div>
      <div class="c-legend">
        <span>
          <i class="c-key c-key--rect" />
          {legend[0]}
        </span>
        <span>
          <i class="c-key c-key--tick" />
          {legend[1]}
        </span>
      </div>
      <TipBox tip={tip} />
    </div>
  );
}

// ------------------------------------------------------------------ Band aus Zellen

/** "#rrggbb" als 32-Bit-Wert in der Byte-Reihenfolge von ImageData (R, G, B, A little-endian). */
function packColor(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** Zellgrößen von groß nach klein (Kantenlänge in Pixeln); darunter fasst eine Zelle mehrere Ziehungen zusammen. */
const CELL_SIZES = [13, 9, 6, 4, 3, 2, 1];
/** Höchstzahl Zeilen: mehr Höhe als das wäre bei einer Million Ziehungen kaum noch lesbar. */
const MAX_ROWS = 260;

interface Layout {
  size: number;
  pitch: number;
  cols: number;
  rows: number;
  /** Ziehungen je Zelle. */
  per: number;
}

function layoutFor(n: number, width: number): Layout {
  for (const size of CELL_SIZES) {
    const gap = size >= 4 ? 2 : 0;
    const pitch = size + gap;
    const cols = Math.max(1, Math.floor((width + gap) / pitch));
    if (n <= cols * MAX_ROWS) return { size, pitch, cols, rows: Math.max(1, Math.ceil(n / cols)), per: 1 };
  }
  const cols = Math.max(1, Math.floor(width));
  const per = Math.ceil(n / (cols * MAX_ROWS));
  const cells = Math.ceil(n / per);
  return { size: 1, pitch: 1, cols, rows: Math.max(1, Math.ceil(cells / cols)), per };
}

/**
 * Eine Zelle je Ziehung, älteste links oben. Reicht der Platz nicht (bei Hunderttausenden Ziehungen), fasst eine Zelle mehrere
 * zusammen und zeigt die seltenste darunter, damit auch dann jede Kiste in die Grafik einfließt und kein Treffer untergeht.
 */
export function RarityStrip({
  ranks,
  colors,
  tip,
  legend,
  label,
  note,
}: {
  /** Seltenheit + 1 je Ziehung in zeitlicher Reihenfolge (0 unbekannt). */
  ranks: Uint8Array;
  /** Farbe je Wert aus ranks (Index 0 bis 6, "#rrggbb"). */
  colors: string[];
  /** Hinweis zu den Ziehungen ab Stelle `from`, `count` Stück. */
  tip: (from: number, count: number) => ComponentChildren;
  legend: { label: string; color: string }[];
  label: string;
  /** Zusatzzeile, wenn eine Zelle mehrere Ziehungen vertritt. */
  note?: (per: number) => ComponentChildren;
}) {
  const [wrap, width] = useWidth();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; from: number; count: number } | null>(null);
  const n = ranks.length;
  const lay = layoutFor(n, width);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = lay.size >= 3 ? Math.min(2, window.devicePixelRatio || 1) : 1;
    const cssW = Math.ceil(lay.cols * lay.pitch);
    const cssH = lay.rows * lay.pitch;
    el.width = Math.max(1, Math.round(cssW * dpr));
    el.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const packed = colors.map(packColor);
    const cells = Math.ceil(n / lay.per);
    if (lay.size >= 3) {
      ctx.scale(dpr, dpr);
      for (let c = 0; c < cells; c++) {
        let best = 0;
        for (let k = c * lay.per, stop = Math.min(n, k + lay.per); k < stop; k++) if (ranks[k] > best) best = ranks[k];
        ctx.fillStyle = colors[best];
        ctx.fillRect((c % lay.cols) * lay.pitch, Math.floor(c / lay.cols) * lay.pitch, lay.size, lay.size);
      }
    } else {
      // Zellen von 1 bis 2 Pixeln: direkt in die Pixel schreiben, das ist bei hunderttausenden Zellen viel schneller
      const image = ctx.createImageData(el.width, el.height);
      const px = new Uint32Array(image.data.buffer);
      for (let c = 0; c < cells; c++) {
        let best = 0;
        for (let k = c * lay.per, stop = Math.min(n, k + lay.per); k < stop; k++) if (ranks[k] > best) best = ranks[k];
        const color = packed[best];
        const x0 = (c % lay.cols) * lay.pitch;
        const y0 = Math.floor(c / lay.cols) * lay.pitch;
        for (let dy = 0; dy < lay.size; dy++) {
          const row = (y0 + dy) * el.width + x0;
          for (let dx = 0; dx < lay.size; dx++) px[row + dx] = color;
        }
      }
      ctx.putImageData(image, 0, 0);
    }
  }, [ranks, colors, lay.size, lay.cols, lay.rows, lay.per, lay.pitch, n]);

  const onMove = (e: PointerEvent) => {
    const el = canvas.current;
    const box = wrap.current?.getBoundingClientRect();
    if (!el || !box) return;
    const rect = el.getBoundingClientRect();
    const cx = Math.floor((e.clientX - rect.left) / lay.pitch);
    const cy = Math.floor((e.clientY - rect.top) / lay.pitch);
    const cell = cy * lay.cols + cx;
    const from = cell * lay.per;
    if (cx < 0 || cx >= lay.cols || cy < 0 || from < 0 || from >= n) return setHover(null);
    setHover({ x: Math.min(box.width - 190, Math.max(0, e.clientX - box.left - 60)), y: e.clientY - box.top - 12, from, count: Math.min(lay.per, n - from) });
  };

  return (
    <div class="c-wrap" ref={wrap}>
      <canvas ref={canvas} class="c-canvas" role="img" aria-label={label} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      {note && lay.per > 1 && <p class="a-note muted">{note(lay.per)}</p>}
      <div class="c-legend">
        {legend.map((l) => (
          <span>
            <i class="c-key c-key--rect" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
      {hover && (
        <div class="c-tip" style={{ left: `${hover.x}px`, top: `${hover.y}px` }} role="status">
          {tip(hover.from, hover.count)}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Streudiagramm

export interface Point {
  x: number;
  y: number;
  color: string;
  tip: ComponentChildren;
}

export function Scatter({
  points,
  xTicks,
  xFormat,
  yFormat,
  height = 200,
  logX = false,
  legend,
}: {
  points: Point[];
  xTicks: number[];
  xFormat: (v: number) => string;
  yFormat: (v: number) => string;
  height?: number;
  logX?: boolean;
  legend?: { label: string; color: string }[];
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 14, t: 10, b: 22 };
  const fx = (v: number) => (logX ? Math.log10(Math.max(v, 1e-6)) : v);
  const xs = [...points.map((p) => fx(p.x)), ...xTicks.map(fx)];
  const ys = [...points.map((p) => p.y), 0];
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys), 4);
  const [y0, y1] = [Math.min(...ys, ...yTicks), Math.max(...ys, ...yTicks)];
  const X = (v: number) => pad.l + ((fx(v) - x0) / (x1 - x0 || 1)) * (width - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0 || 1)) * (height - pad.t - pad.b);

  const onMove = (e: PointerEvent) => {
    const svg = ref.current;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * width;
    const py = ((e.clientY - box.top) / box.height) * height;
    let best = -1;
    let dist = Infinity;
    points.forEach((p, i) => {
      const d = Math.hypot(X(p.x) - px, Y(p.y) - py);
      if (d < dist) [best, dist] = [i, d];
    });
    setHover(dist < 30 ? best : null);
  };
  if (!points.length) return <div class="c-wrap" ref={wrap} />;
  const h = hover !== null ? points[hover] : null;
  return (
    <div class="c-wrap" ref={wrap}>
      <svg
        ref={ref}
        class="c-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
      >
        {yTicks.map((v) => (
          <g>
            <line class={`c-grid ${v === 0 ? 'c-grid--zero' : ''}`} x1={pad.l} x2={width - pad.r} y1={Y(v)} y2={Y(v)} />
            <text class="c-axis" x={pad.l - 6} y={Y(v) + 4} text-anchor="end">
              {yFormat(v)}
            </text>
          </g>
        ))}
        {xTicks.map((v) => (
          <text class="c-axis" x={X(v)} y={height - 6} text-anchor="middle">
            {xFormat(v)}
          </text>
        ))}
        {points.map((p, i) => (
          <circle class={`c-dot ${hover === i ? 'is-hover' : ''}`} cx={X(p.x)} cy={Y(p.y)} r={hover === i ? 6 : 4} fill={p.color} />
        ))}
      </svg>
      {h && (
        <div class="c-tip" style={{ left: `${Math.min(74, Math.max(2, (X(h.x) / width) * 100))}%`, top: `${Math.max(0, (Y(h.y) / height) * 100 - 30)}%` }}>
          {h.tip}
        </div>
      )}
      {legend && legend.length > 1 && (
        <div class="c-legend">
          {legend.map((l) => (
            <span>
              <i class="c-key c-key--dot" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
