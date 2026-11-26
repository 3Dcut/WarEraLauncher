// Inhalte der Dockview-Panels. Tool-Iframes werden einmal erzeugt und nie umgehängt;
// Dockview rendert sie mit renderer:'always' in einer festen Ebene, so bleiben sie beim
// Verschieben, Stapeln und Lösen erhalten (im Chromium-Test gemessen).

import { render } from 'preact';
import { signal, effect, type Signal } from '@preact/signals';
import type {
  IContentRenderer,
  GroupPanelPartInitParameters,
  IHeaderActionsRenderer,
  IGroupHeaderProps,
  IWatermarkRenderer,
  WatermarkRendererInitParameters,
  DockviewApi,
  IDockviewPanel,
} from 'dockview';
import { findLaunchable, type Tool } from '../data/tools';
import { t } from '../i18n';
import { iconSvg } from '../ui/icons';
import { ExternalCard, MissingCard } from '../ui/ExternalCard';
import { WidgetHost } from '../widgets/WidgetHost';
import { Watermark } from '../ui/Watermark';

export interface PanelParams {
  ref: string;
}

/** Lebende Iframe-Panels je Arbeitsbereich, damit Kopfleiste und Tastenkürzel sie neu laden können. */
export const frameRegistry = new Map<string, ItemRenderer>();

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';

export class ItemRenderer implements IContentRenderer {
  readonly element: HTMLElement;
  private iframe: HTMLIFrameElement | null = null;
  private tool: Tool | null = null;
  private visible: Signal<boolean> = signal(false);
  private key = '';
  private slowTimer: number | undefined;
  private loaded = false;
  private disposeEffects: (() => void)[] = [];

  constructor(private readonly workspaceId: string) {
    this.element = document.createElement('div');
    this.element.className = 'panel-body';
  }

  init(params: GroupPanelPartInitParameters): void {
    const ref = (params.params as Partial<PanelParams>).ref ?? params.api.id;
    const item = findLaunchable(ref);
    this.key = `${this.workspaceId}:${params.api.id}`;
    this.visible.value = params.api.isVisible;
    params.api.onDidVisibilityChange((e) => {
      this.visible.value = e.isVisible;
      if (e.isVisible) this.ensureLoaded();
    });

    if (!item) {
      render(<MissingCard id={ref} onClose={() => params.api.close()} />, this.element);
      return;
    }
    if (item.kind === 'widget') {
      this.element.classList.add('panel-widget');
      render(<WidgetHost kind={item.widget} visible={this.visible} />, this.element);
      return;
    }
    if (!item.embed) {
      this.element.classList.add('panel-external');
      render(<ExternalCard tool={item} />, this.element);
      return;
    }
    this.tool = item;
    this.buildFrame(item);
    frameRegistry.set(this.key, this);
    // Hängt die Adresse eines Tools von der Sprache ab ({lang} oder je Sprache in tools.json),
    // lädt ein bereits geöffnetes Iframe nach dem Umschalten die passende Fassung.
    this.disposeEffects.push(
      effect(() => {
        const fresh = findLaunchable(ref);
        if (!fresh || fresh.kind !== 'tool' || !this.tool || fresh.url === this.tool.url) return;
        this.tool = fresh;
        this.element.querySelector<HTMLAnchorElement>('.frame-loader__hint a')?.setAttribute('href', fresh.url);
        if (this.iframe?.getAttribute('src')) this.reload();
      }),
    );
    // Erst nach dem Aufbau der Gruppe ist klar, welcher Tab sichtbar ist
    window.setTimeout(() => {
      if (params.api.isVisible) this.ensureLoaded();
    }, 0);
  }

  private buildFrame(tool: Tool): void {
    this.element.classList.add('panel-frame');
    const loader = document.createElement('div');
    loader.className = 'frame-loader';
    const emoji = document.createElement('div');
    emoji.className = 'frame-loader__emoji';
    emoji.textContent = tool.emoji;
    const label = document.createElement('div');
    label.className = 'frame-loader__label';
    const bar = document.createElement('div');
    bar.className = 'frame-loader__bar';
    const hint = document.createElement('div');
    hint.className = 'frame-loader__hint';
    const hintText = document.createElement('span');
    hint.appendChild(hintText);
    const open = document.createElement('a');
    open.className = 'btn btn--ghost btn--sm';
    open.target = '_blank';
    open.rel = 'noopener';
    const openLabel = document.createElement('span');
    open.append(openLabel);
    open.insertAdjacentHTML('afterbegin', iconSvg('external', 14));
    hint.appendChild(open);
    loader.append(emoji, label, bar, hint);

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', SANDBOX);
    iframe.allow = 'clipboard-write; fullscreen; autoplay';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.addEventListener('load', () => {
      if (!iframe.getAttribute('src')) return;
      this.loaded = true;
      clearTimeout(this.slowTimer);
      this.element.classList.add('is-loaded');
      this.element.classList.remove('is-slow');
    });
    this.iframe = iframe;
    this.disposeEffects.push(
      effect(() => {
        label.textContent = t('workspace.loading', { name: tool.name });
        hintText.textContent = t('workspace.loadingSlow');
        openLabel.textContent = t('workspace.action.openNewTab');
        open.href = this.tool?.url ?? tool.url;
        iframe.title = tool.name;
      }),
    );
    this.element.append(iframe, loader);
  }

  /** Lädt erst, wenn das Panel zum ersten Mal sichtbar wird (Tabs im Hintergrund kosten nichts). */
  private ensureLoaded(): void {
    if (!this.iframe || !this.tool || this.iframe.getAttribute('src')) return;
    this.iframe.src = this.tool.url;
    this.slowTimer = window.setTimeout(() => {
      if (!this.loaded) this.element.classList.add('is-slow');
    }, 15_000);
  }

  reload(): void {
    if (!this.iframe || !this.tool) return;
    this.loaded = false;
    this.element.classList.remove('is-loaded', 'is-slow');
    clearTimeout(this.slowTimer);
    this.iframe.removeAttribute('src');
    this.ensureLoaded();
  }

  get url(): string | null {
    return this.tool?.url ?? null;
  }

  dispose(): void {
    clearTimeout(this.slowTimer);
    this.disposeEffects.forEach((d) => d());
    this.disposeEffects = [];
    frameRegistry.delete(this.key);
    render(null, this.element);
    this.iframe?.remove();
  }
}

// ------------------------------------------------------------------ Kopfleisten-Aktionen

interface HeaderContext {
  workspaceId: string;
  mobile: boolean;
  dockBack: (panel: IDockviewPanel) => void;
}

export class HeaderActions implements IHeaderActionsRenderer {
  readonly element: HTMLElement;
  private disposers: { dispose(): void }[] = [];

  constructor(private readonly ctx: HeaderContext) {
    this.element = document.createElement('div');
    this.element.className = 'dv-actions';
  }

  init(props: IGroupHeaderProps): void {
    const make = (icon: Parameters<typeof iconSvg>[0], onClick: () => void) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dv-action';
      btn.innerHTML = iconSvg(icon, 15);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
      });
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.element.appendChild(btn);
      return btn;
    };

    const active = () => props.group.activePanel;
    const frame = () => {
      const p = active();
      return p ? frameRegistry.get(`${this.ctx.workspaceId}:${p.id}`) : undefined;
    };

    const reload = make('reload', () => frame()?.reload());
    const external = make('external', () => {
      const url = frame()?.url;
      if (url) window.open(url, '_blank', 'noopener');
    });
    const float = make('float', () => {
      const p = active();
      if (!p) return;
      if (props.api.location.type === 'floating') this.ctx.dockBack(p);
      else props.containerApi.addFloatingGroup(p, { width: 520, height: 380 });
    });
    const maximize = make('maximize', () => {
      const p = active();
      if (!p) return;
      if (props.api.isMaximized()) props.api.exitMaximized();
      else props.api.maximize();
    });

    const setLabel = (btn: HTMLButtonElement, text: string) => {
      btn.title = text;
      btn.setAttribute('aria-label', text);
    };
    // Beschriftungen folgen der Sprache; update() setzt sie je nach Zustand neu
    const update = () => {
      const hasFrame = !!frame();
      reload.hidden = !hasFrame;
      external.hidden = !hasFrame;
      float.hidden = this.ctx.mobile;
      const floating = props.api.location.type === 'floating';
      float.innerHTML = iconSvg(floating ? 'dock' : 'float', 15);
      setLabel(reload, t('workspace.action.reload'));
      setLabel(external, t('workspace.action.openNewTab'));
      setLabel(float, floating ? t('workspace.action.dockAgain') : t('workspace.action.detach'));
      const max = props.api.isMaximized();
      maximize.hidden = floating || this.ctx.mobile;
      maximize.innerHTML = iconSvg(max ? 'minimize' : 'maximize', 15);
      setLabel(maximize, max ? t('workspace.action.restore') : t('workspace.action.maximize'));
    };

    this.disposers.push(
      props.api.onDidActivePanelChange(() => queueMicrotask(update)),
      props.api.onDidLocationChange(() => queueMicrotask(update)),
      props.containerApi.onDidMaximizedGroupChange(() => queueMicrotask(update)),
    );
    queueMicrotask(update);
    this.disposers.push({ dispose: effect(() => update()) });
  }

  dispose(): void {
    this.disposers.forEach((d) => d.dispose());
  }
}

// ------------------------------------------------------------------ Leerer Arbeitsbereich

export class WatermarkRenderer implements IWatermarkRenderer {
  readonly element: HTMLElement;

  constructor(private readonly workspaceId: string) {
    this.element = document.createElement('div');
    this.element.className = 'watermark-host';
  }

  init(params: WatermarkRendererInitParameters): void {
    render(<Watermark workspaceId={this.workspaceId} api={params.containerApi as DockviewApi} />, this.element);
  }

  dispose(): void {
    render(null, this.element);
  }
}
