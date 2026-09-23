import type { ComponentChildren, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons';

// ------------------------------------------------------------------ Modaler Dialog (native <dialog>)

export function Dialog(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: Parameters<typeof Icon>[0]['name'];
  class?: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (props.open && !el.open) el.showModal();
    if (!props.open && el.open) el.close();
  }, [props.open]);

  return (
    <dialog
      ref={ref}
      class={`dialog ${props.class ?? ''}`}
      aria-label={props.title}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) props.onClose();
      }}
    >
      {props.open && (
        <div class="dialog__inner">
          <header class="dialog__head">
            {props.icon && <Icon name={props.icon} size={18} />}
            <h2>{props.title}</h2>
            <button type="button" class="icon-btn" aria-label="Schließen" onClick={props.onClose}>
              <Icon name="x" />
            </button>
          </header>
          <div class="dialog__body">{props.children}</div>
          {props.footer && <footer class="dialog__foot">{props.footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

// ------------------------------------------------------------------ Popover an einem Anker (Top-Layer)

let lastLightDismiss = 0;

/**
 * Ein Klick auf den Auslöser eines offenen Popovers schließt es zuerst per Light-Dismiss
 * (pointerdown) und würde es mit dem folgenden click sofort wieder öffnen. Auslöser fragen
 * deshalb hier nach, ob gerade eben geschlossen wurde.
 */
export function justDismissed(): boolean {
  return performance.now() - lastLightDismiss < 300;
}

export function Popover(props: {
  anchor: RefObject<HTMLElement>;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
  class?: string;
  label: string;
  children: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const supports = typeof el.showPopover === 'function';
    if (props.open) {
      if (supports && !el.matches(':popover-open')) el.showPopover();
      place();
    } else if (supports && el.matches(':popover-open')) {
      el.hidePopover();
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onResize = () => place();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [props.open]);

  function place() {
    const el = ref.current;
    const anchor = props.anchor.current;
    if (!el || !anchor) return;
    const r = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    const margin = 8;
    let left = props.align === 'start' ? r.left : r.right - width;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    el.style.left = `${left}px`;
    el.style.top = `${r.bottom + 8}px`;
    el.style.maxHeight = `${window.innerHeight - r.bottom - 24}px`;
  }

  return (
    <div
      ref={ref}
      popover="auto"
      role="dialog"
      aria-label={props.label}
      class={`popover ${props.class ?? ''} ${props.open ? 'is-open' : ''}`}
      onToggle={(e) => {
        if ((e as unknown as { newState: string }).newState === 'closed' && props.open) {
          lastLightDismiss = performance.now();
          props.onClose();
        }
      }}
    >
      {props.open && props.children}
    </div>
  );
}

// ------------------------------------------------------------------ Kleinteile

export function Switch(props: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label class="switch" for={props.id}>
      <span class="switch__text">
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <input id={props.id} type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <span class="switch__track" aria-hidden="true" />
    </label>
  );
}

export function Segmented<T extends string>(props: { name: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.name}>
      {props.options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === props.value} class={o.value === props.value ? 'is-active' : ''} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Führt fn im Takt aus, solange die Seite sichtbar ist und active gilt. */
export function useVisibleInterval(fn: () => void, ms: number, active = true): void {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const run = () => {
      if (!document.hidden) saved.current();
    };
    const start = () => {
      clearInterval(timer);
      timer = window.setInterval(run, ms);
    };
    const onVisible = () => {
      if (!document.hidden) run();
    };
    run();
    start();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms, active]);
}

/** Sekundentakt für Countdowns. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function copyText(text: string): Promise<boolean> {
  return navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  ) ?? Promise.resolve(false);
}
