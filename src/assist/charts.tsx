// Kleine SVG-Grafiken ohne Bibliothek: Verlauf mit Erwartungsband, Balken mit Erwartungsstrich,
// Band aus Zellen (eine je Ziehung) und Streudiagramm. Jede Grafik hat eine Hover-/Fokus-Anzeige;
// Texte stehen in Textfarben, nur die Marken tragen Farbe.

import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

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
  values: number[];
  tone: 'accent' | 'muted';
}

export function LineChart({
  series,
  band,
  height = 180,
  format,
  axisFormat,
  xLabel,
}: {
  series: LineSeries[];
  /** Untere und obere Grenze je Punkt, als Fläche hinter den Linien. */
  band?: { lo: number[]; hi: number[]; label: string };
  height?: number;
  format: (v: number) => string;
  /** Kürzere Beschriftung der Achse, sonst wie format. */
  axisFormat?: (v: number) => string;
  xLabel: (i: number) => string;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const [wrap, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 52, r: 10, t: 8, b: 10 };
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const all = [...series.flatMap((s) => s.values), ...(band ? [...band.lo, ...band.hi] : []), 0];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const ticks = niceTicks(lo, hi, 4);
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (width - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = band
    ? `${band.hi.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')}${band.lo
        .map((_, j) => {
          const i = band.lo.length - 1 - j;
          return `L${x(i).toFixed(1)},${y(band.lo[i]).toFixed(1)}`;
        })
        .join('')}Z`
    : '';

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
        {series.map((s) => (
          <path class={`c-line c-line--${s.tone}`} d={path(s.values)} />
        ))}
        {hover !== null && <line class="c-cross" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} />}
        {hover !== null && series.map((s) => <circle class={`c-end c-end--${s.tone}`} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={4} />)}
      </svg>
      {hover !== null && (
        <div class="c-tip c-tip--top" style={{ left: `${Math.min(78, Math.max(4, tipLeft))}%`, top: '6px' }}>
          <span class="c-tip__head">{xLabel(hover)}</span>
          {series.map((s) => (
            <span class="c-tip__row">
              <i class={`c-key c-key--${s.tone}`} />
              <strong>{format(s.values[hover] ?? 0)}</strong> {s.label}
            </span>
          ))}
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

export interface Cell {
  color: string;
  tip: ComponentChildren;
}

/** Eine Zelle je Ziehung, älteste links oben; bei vielen Ziehungen schmaler. */
export function CellStrip({ cells, legend }: { cells: Cell[]; legend: { label: string; color: string }[] }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const size = cells.length > 1500 ? 4 : cells.length > 600 ? 6 : cells.length > 200 ? 9 : 13;
  const onMove = (e: PointerEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    const box = ref.current?.getBoundingClientRect();
    if (!target || !box) return setTip(null);
    const i = Number(target.dataset.i);
    const own = target.getBoundingClientRect();
    setTip({ x: Math.min(box.width - 180, Math.max(0, own.left - box.left - 60)), y: own.top - box.top - 8, content: cells[i]?.tip });
  };
  const cellEls = useMemo(
    () => cells.map((c, i) => <span class="c-cell" data-i={i} style={{ background: c.color, width: `${size}px`, height: `${size}px` }} />),
    [cells, size],
  );
  return (
    <div class="c-wrap" ref={ref}>
      <div class="c-cells" onPointerMove={onMove} onPointerLeave={() => setTip(null)}>
        {cellEls}
      </div>
      <div class="c-legend">
        {legend.map((l) => (
          <span>
            <i class="c-key c-key--rect" style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
      <TipBox tip={tip} />
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
