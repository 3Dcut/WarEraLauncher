import { createDockview, type DockviewApi, type DockviewTheme, type DockviewGroupPanel, type IDockviewPanel, type Position, type SerializedDockview, type Direction } from 'dockview';
import { signal } from '@preact/signals';
import { load, save } from '../core/storage';
import { findLaunchable, type Launchable } from '../data/tools';
import { settings, isMobile, pushRecent, toast, motionEnabled } from '../state';
import { ItemRenderer, HeaderActions, WatermarkRenderer, frameRegistry } from './panels';
import { activeWorkspaceId, workspaces, presetById, isLeaf, childrenOf, sanitizeTree, type LayoutNode } from './model';

export const DRAG_MIME = 'application/x-warera-launchable';

/** Anzahl offener Panels im aktiven Arbeitsbereich (für die Seitenleiste). */
export const openIds = signal<string[]>([]);

function themeFor(): DockviewTheme {
  const s = settings.value;
  return {
    name: 'warera',
    className: 'dockview-theme-warera',
    colorScheme: s.theme === 'hell' ? 'light' : 'dark',
    gap: s.density === 'compact' ? 4 : 8,
    dndOverlayMounting: 'absolute',
    dndPanelOverlay: 'group',
    dndTabIndicator: 'line',
    dndOverlayBorder: '2px solid var(--accent)',
    tabAnimation: motionEnabled() ? 'smooth' : 'default',
  };
}

const DIRECTION: Record<Position, Direction> = {
  top: 'above',
  bottom: 'below',
  left: 'left',
  right: 'right',
  center: 'within',
};

export class WorkspaceDock {
  readonly api: DockviewApi;
  readonly host: HTMLElement;
  private saveTimer: number | undefined;

  constructor(
    readonly workspaceId: string,
    stage: HTMLElement,
    readonly mobile: boolean,
    legacyTree: LayoutNode | null,
  ) {
    this.host = document.createElement('div');
    this.host.className = 'dock-host';
    this.host.dataset.workspace = workspaceId;
    stage.appendChild(this.host);

    this.api = createDockview(this.host, {
      theme: themeFor(),
      defaultRenderer: 'always',
      disableFloatingGroups: mobile,
      floatingGroupBounds: 'boundedWithinViewport',
      noPanelsOverlay: 'watermark',
      createComponent: () => new ItemRenderer(workspaceId),
      createRightHeaderActionComponent: () =>
        new HeaderActions({ workspaceId, mobile, dockBack: (p) => this.dockBack(p) }),
      createWatermarkComponent: () => new WatermarkRenderer(workspaceId),
      getTabContextMenuItems: ({ panel, group }) => this.contextMenu(panel, group),
    });

    this.wireDnd();
    this.restore(legacyTree);
    this.api.onDidLayoutChange(() => this.scheduleSave());
    this.api.onDidAddPanel(() => this.syncOpen());
    this.api.onDidRemovePanel(() => this.syncOpen());
    this.api.onDidActivePanelChange(() => this.syncOpen());
  }

  private get storageKey(): string {
    return `layout:${this.workspaceId}${this.mobile ? ':m' : ''}`;
  }

  // ---------------------------------------------------------------- Laden & Speichern

  private restore(legacyTree: LayoutNode | null): void {
    const saved = load<SerializedDockview | null>(this.storageKey, null);
    if (saved) {
      try {
        this.api.fromJSON(saved);
        if (this.mobile) this.flattenForMobile();
        return;
      } catch (err) {
        console.warn('Gespeichertes Layout defekt, lade Vorlage', err);
      }
    }
    // Mobil ohne eigenes Layout: Panels des Desktop-Layouts als Tabs übernehmen
    if (this.mobile) {
      const desktop = load<SerializedDockview | null>(`layout:${this.workspaceId}`, null);
      const ids = desktop ? Object.values(desktop.panels ?? {}).map((p) => (p.params as { ref?: string } | undefined)?.ref ?? p.id) : [];
      if (ids.length) {
        this.applyTree({ tabs: ids });
        return;
      }
    }
    const ws = workspaces.value.find((w) => w.id === this.workspaceId);
    const tree = (ws?.preset && presetById(ws.preset)?.layout) || legacyTree;
    if (tree) this.applyTree(tree);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => save(this.storageKey, this.api.toJSON()), 400);
  }

  private syncOpen(): void {
    if (activeWorkspaceId.value === this.workspaceId) openIds.value = this.api.panels.map((p) => p.id);
  }

  private flattenForMobile(): void {
    if (this.api.groups.length <= 1) return;
    const ids = this.api.panels.map((p) => p.id);
    this.api.clear();
    this.applyTree({ tabs: ids });
  }

  // ---------------------------------------------------------------- Aufbau aus Vorlagen

  applyTree(input: LayoutNode): void {
    const tree = sanitizeTree(input);
    this.api.clear();
    if (!tree) return;
    if (this.mobile) {
      const ids = collect(tree);
      ids.forEach((id, i) => this.add(id, i === 0 ? undefined : { referencePanel: ids[0], direction: 'within' }));
      this.api.getPanel(ids[0])?.api.setActive();
      return;
    }
    this.api.fromJSON(serializeTree(tree));
  }

  private add(
    id: string,
    position?: { referenceGroup: DockviewGroupPanel; direction: Direction } | { referencePanel: string; direction: Direction },
  ): IDockviewPanel | undefined {
    const item = findLaunchable(id);
    if (!item || this.api.getPanel(id)) return this.api.getPanel(id);
    return this.api.addPanel({
      id,
      component: 'item',
      title: `${item.emoji} ${item.name}`,
      params: { ref: id },
      ...(position ? { position } : {}),
    });
  }

  /** Dockview-Layout in die einfache Baumform (für Teilen und Vorlagen). */
  toTree(): LayoutNode | null {
    const json = this.api.toJSON();
    type GridNode = { type: 'branch' | 'leaf'; data: GridNode[] | { views: string[] } };
    const walk = (node: GridNode, horizontal: boolean): LayoutNode | null => {
      if (node.type === 'leaf') {
        const views = (node.data as { views: string[] }).views ?? [];
        return views.length ? { tabs: views } : null;
      }
      const kids = (node.data as GridNode[]).map((c) => walk(c, !horizontal)).filter((c): c is LayoutNode => !!c);
      if (kids.length === 0) return null;
      if (kids.length === 1) return kids[0];
      return horizontal ? { row: kids } : { column: kids };
    };
    const root = json.grid?.root as unknown as GridNode | undefined;
    if (!root) return null;
    return sanitizeTree(walk(root, json.grid.orientation === 'HORIZONTAL'));
  }

  // ---------------------------------------------------------------- Öffnen, Schließen, Bewegen

  open(item: Launchable, target?: { group?: DockviewGroupPanel; position?: Position }): void {
    pushRecent(item.id);
    const existing = this.api.getPanel(item.id);
    if (existing) {
      if (target?.group && target.position) {
        try {
          existing.api.moveTo({ group: target.group, position: target.position });
        } catch {
          existing.api.setActive();
        }
      } else {
        existing.api.setActive();
        flash(existing.group.element);
      }
      return;
    }

    let position: { referenceGroup: DockviewGroupPanel; direction: Direction } | undefined;
    if (target?.group) {
      position = { referenceGroup: target.group, direction: DIRECTION[target.position ?? 'center'] };
    } else if (this.api.activeGroup) {
      const active = this.api.activeGroup;
      const roomy = !this.mobile && this.api.groups.filter((g) => g.api.location.type === 'grid').length < 3 && active.width > 820;
      const floating = active.api.location.type === 'floating';
      position = { referenceGroup: active, direction: roomy && !floating ? 'right' : 'within' };
    }
    if (this.mobile && this.api.activeGroup) position = { referenceGroup: this.api.activeGroup, direction: 'within' };
    const panel = this.add(item.id, position);
    panel?.api.setActive();
  }

  close(id: string): void {
    this.api.getPanel(id)?.api.close();
  }

  closeAll(): void {
    this.api.clear();
  }

  reloadActive(): void {
    const p = this.api.activePanel;
    if (p) frameRegistry.get(`${this.workspaceId}:${p.id}`)?.reload();
  }

  resetToPreset(): boolean {
    const ws = workspaces.value.find((w) => w.id === this.workspaceId);
    const preset = presetById(ws?.preset);
    if (!preset) return false;
    this.applyTree(preset.layout);
    return true;
  }

  private dockBack(panel: IDockviewPanel): void {
    const target = this.api.groups.find((g) => g.api.location.type === 'grid' && g !== panel.group);
    if (target) panel.group.api.moveTo({ group: target, position: 'right' });
    else panel.group.api.moveTo({ position: 'center' });
  }

  private contextMenu(panel: IDockviewPanel, group: DockviewGroupPanel) {
    const items = [
      { label: 'Schließen', action: () => panel.api.close() },
      { label: 'Andere schließen', action: () => group.panels.filter((p) => p !== panel).forEach((p) => p.api.close()) },
      { label: 'Alle im Bereich schließen', action: () => this.api.clear() },
      'separator' as const,
    ];
    const frame = frameRegistry.get(`${this.workspaceId}:${panel.id}`);
    if (frame) {
      items.push({ label: 'Neu laden', action: () => frame.reload() });
      items.push({ label: 'Im neuen Tab öffnen', action: () => void window.open(frame.url ?? '', '_blank', 'noopener') });
    }
    if (!this.mobile) {
      items.push({ label: group.api.isMaximized() ? 'Wiederherstellen' : 'Maximieren', action: () => (group.api.isMaximized() ? group.api.exitMaximized() : group.api.maximize()) });
      if (group.api.location.type === 'floating') items.push({ label: 'Wieder andocken', action: () => this.dockBack(panel) });
      else items.push({ label: 'Als Fenster lösen', action: () => this.api.addFloatingGroup(panel, { width: 520, height: 380 }) });
    }
    return items;
  }

  // ---------------------------------------------------------------- Drag & Drop aus der Seitenleiste

  private wireDnd(): void {
    this.api.onUnhandledDragOver((e) => {
      const types = (e.nativeEvent as DragEvent).dataTransfer?.types;
      if (types && Array.from(types).includes(DRAG_MIME)) e.accept();
    });
    this.api.onDidDrop((e) => {
      const id = (e.nativeEvent as DragEvent).dataTransfer?.getData(DRAG_MIME);
      if (!id) return;
      const item = findLaunchable(id);
      if (!item) return;
      this.open(item, e.group ? { group: e.group, position: this.mobile ? 'center' : e.position } : undefined);
      document.documentElement.classList.remove('is-dragging');
    });
  }

  updateTheme(): void {
    this.api.updateOptions({ theme: themeFor() });
  }

  show(visible: boolean): void {
    this.host.hidden = !visible;
    if (visible) {
      this.syncOpen();
      requestAnimationFrame(() => this.api.layout(this.host.clientWidth, this.host.clientHeight, true));
    }
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    save(this.storageKey, this.api.toJSON());
    this.api.dispose();
    this.host.remove();
  }
}

/**
 * Baut aus der Baumform direkt ein serialisiertes Dockview-Layout mit gleich großen Anteilen.
 * (Schrittweises addPanel würde immer die zuletzt geteilte Fläche halbieren.)
 */
export function serializeTree(tree: LayoutNode): SerializedDockview {
  const W = 1200;
  const H = 800;
  let groupSeq = 0;
  const panels: SerializedDockview['panels'] = {};

  const leaf = (node: { tabs: string[] }, size: number) => {
    for (const id of node.tabs) {
      const item = findLaunchable(id);
      panels[id] = { id, contentComponent: 'item', title: item ? `${item.emoji} ${item.name}` : id, params: { ref: id } };
    }
    return { type: 'leaf' as const, size, data: { views: node.tabs, activeView: node.tabs[0], id: `g${++groupSeq}` } };
  };

  // Gleich ausgerichtete Verschachtelung (Zeile in Zeile) flach ziehen, Dockview wechselt die Achse je Ebene
  const flatKids = (node: LayoutNode): LayoutNode[] => {
    const horizontal = 'row' in node;
    return childrenOf(node).flatMap((k) => (!isLeaf(k) && 'row' in k === horizontal ? flatKids(k) : [k]));
  };

  type Serialized = SerializedDockview['grid']['root'];
  const branch = (node: LayoutNode, size: number, cross: number): Serialized => {
    const kids = flatKids(node);
    const each = cross / kids.length;
    return { type: 'branch', size, data: kids.map((k) => (isLeaf(k) ? leaf(k, each) : branch(k, each, size))) };
  };

  const horizontal = isLeaf(tree) || 'row' in tree;
  const root: Serialized = isLeaf(tree) ? { type: 'branch', size: H, data: [leaf(tree, W)] } : branch(tree, horizontal ? H : W, horizontal ? W : H);
  return {
    grid: { root, width: W, height: H, orientation: (horizontal ? 'HORIZONTAL' : 'VERTICAL') as SerializedDockview['grid']['orientation'] },
    panels,
    activeGroup: 'g1',
  };
}

function collect(node: LayoutNode): string[] {
  return isLeaf(node) ? node.tabs : childrenOf(node).flatMap(collect);
}

function flash(el: HTMLElement): void {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ------------------------------------------------------------------ Verwaltung aller Arbeitsbereiche

const docks = new Map<string, WorkspaceDock>();
const queuedTrees = new Map<string, LayoutNode>();

/** Layout für einen noch nicht geöffneten Arbeitsbereich vormerken (z. B. aus einem geteilten Link). */
export function queueTree(workspaceId: string, tree: LayoutNode): void {
  queuedTrees.set(workspaceId, tree);
}
let stage: HTMLElement | null = null;
let pendingLegacy: LayoutNode | null = null;

export function mountStage(el: HTMLElement, legacyTree: LayoutNode | null): void {
  stage = el;
  pendingLegacy = legacyTree;
  showWorkspace(activeWorkspaceId.value);
}

function getDock(id: string): WorkspaceDock | undefined {
  if (!stage) return undefined;
  let dock = docks.get(id);
  if (!dock) {
    const initial = queuedTrees.get(id) ?? (id === 'meine-tools' ? pendingLegacy : null);
    queuedTrees.delete(id);
    dock = new WorkspaceDock(id, stage, isMobile.value, initial);
    docks.set(id, dock);
  }
  return dock;
}

function showWorkspace(id: string): void {
  const dock = getDock(id);
  docks.forEach((d, key) => d.show(key === id));
  if (!dock) openIds.value = [];
}

/** Wechselt den Arbeitsbereich; bereits geöffnete Bereiche bleiben im Hintergrund lebendig. */
export function switchWorkspace(id: string): void {
  if (id === activeWorkspaceId.value && docks.get(id)?.host.hidden === false) return;
  const run = () => {
    activeWorkspaceId.value = id;
    showWorkspace(id);
  };
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (motionEnabled() && doc.startViewTransition) doc.startViewTransition(run);
  else run();
}

export function activeDock(): WorkspaceDock | undefined {
  return getDock(activeWorkspaceId.value);
}

export function openLaunchable(id: string): void {
  const item = findLaunchable(id);
  if (!item) return;
  activeDock()?.open(item);
}

export function disposeWorkspaceDock(id: string): void {
  const dock = docks.get(id);
  if (!dock) return;
  dock.api.dispose();
  dock.host.remove();
  docks.delete(id);
}

export function rebuildAllDocks(): void {
  docks.forEach((d) => d.dispose());
  docks.clear();
  showWorkspace(activeWorkspaceId.value);
}

export function refreshDockThemes(): void {
  docks.forEach((d) => d.updateTheme());
}

export function applyTreeToActive(tree: LayoutNode): void {
  activeDock()?.applyTree(tree);
  toast('Layout übernommen', 'success');
}
