import { signal, effect } from '@preact/signals';
import { load, save, remove, loadLegacy } from '../core/storage';
import { fetchLocalJson } from '../core/http';
import { allTools, findLaunchable } from '../data/tools';

/** Vereinfachte Layoutbeschreibung für Vorlagen und geteilte Links. */
export type LayoutNode = { tabs: string[] } | { row: LayoutNode[] } | { column: LayoutNode[] };

export interface Preset {
  id: string;
  name: string;
  icon: string;
  desc?: string;
  layout: LayoutNode;
}

export interface Workspace {
  id: string;
  name: string;
  icon: string;
  preset?: string;
}

interface PresetFile {
  presets?: Preset[];
  defaults?: string[];
}

export const presets = signal<Preset[]>([]);
export const workspaces = signal<Workspace[]>(load<Workspace[]>('workspaces', []));
export const activeWorkspaceId = signal<string>(load<string>('activeWorkspace', ''));

effect(() => save('workspaces', workspaces.value));
effect(() => save('activeWorkspace', activeWorkspaceId.value));

export function newId(prefix = 'ws'): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isLeaf(node: LayoutNode): node is { tabs: string[] } {
  return 'tabs' in node;
}

export function childrenOf(node: LayoutNode): LayoutNode[] {
  if ('row' in node) return node.row;
  if ('column' in node) return node.column;
  return [];
}

/**
 * Entfernt unbekannte und doppelte IDs sowie leere Zweige; liefert null, wenn nichts übrig bleibt.
 * Jede ID darf im ganzen Baum nur einmal vorkommen, sonst lehnt Dockview das Layout ab.
 */
export function sanitizeTree(node: unknown, depth = 0, seen: Set<string> = new Set()): LayoutNode | null {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.tabs)) {
    const tabs: string[] = [];
    for (const t of n.tabs as unknown[]) {
      if (typeof t !== 'string' || seen.has(t) || !findLaunchable(t) || tabs.length >= 12) continue;
      seen.add(t);
      tabs.push(t);
    }
    return tabs.length ? { tabs } : null;
  }
  const key = Array.isArray(n.row) ? 'row' : Array.isArray(n.column) ? 'column' : null;
  if (!key) return null;
  const kids = (n[key] as unknown[]).map((c) => sanitizeTree(c, depth + 1, seen)).filter((c): c is LayoutNode => !!c).slice(0, 6);
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0];
  return key === 'row' ? { row: kids } : { column: kids };
}

export function treeIds(node: LayoutNode): string[] {
  return isLeaf(node) ? node.tabs : childrenOf(node).flatMap(treeIds);
}

export async function loadPresets(): Promise<string[]> {
  try {
    const file = await fetchLocalJson<PresetFile>('./workspaces.json');
    const list = (file.presets ?? []).filter((p) => p && p.id && p.name && p.layout);
    presets.value = list;
    return file.defaults ?? list.map((p) => p.id);
  } catch (err) {
    console.warn('workspaces.json konnte nicht geladen werden', err);
    presets.value = [];
    return [];
  }
}

export function presetById(id: string | undefined): Preset | undefined {
  return presets.value.find((p) => p.id === id);
}

/** Legt beim ersten Start die Standard-Arbeitsbereiche an und übernimmt offene Tools der alten Oberfläche. */
export function ensureWorkspaces(defaults: string[]): { legacyTree: LayoutNode | null } {
  let legacyTree: LayoutNode | null = null;
  if (workspaces.value.length === 0) {
    const list: Workspace[] = [];
    for (const id of defaults) {
      const p = presetById(id);
      if (p) list.push({ id: p.id, name: p.name, icon: p.icon, preset: p.id });
    }
    legacyTree = legacyOpenTools();
    if (legacyTree) list.push({ id: 'meine-tools', name: 'Meine Tools', icon: '🧭' });
    if (list.length === 0) list.push({ id: newId(), name: 'Arbeitsbereich', icon: '🗂️' });
    workspaces.value = list;
    activeWorkspaceId.value = legacyTree ? 'meine-tools' : list[0].id;
  }
  if (!workspaces.value.some((w) => w.id === activeWorkspaceId.value)) {
    activeWorkspaceId.value = workspaces.value[0].id;
  }
  return { legacyTree };
}

function legacyOpenTools(): LayoutNode | null {
  try {
    const raw = JSON.parse(loadLegacy('wl-open-tools') ?? 'null') as { url?: string }[] | null;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const ids = raw
      .map((entry) => allTools.value.find((t) => t.url === entry.url)?.id)
      .filter((id): id is string => !!id)
      .slice(0, 4);
    if (ids.length === 0) return null;
    return ids.length === 1 ? { tabs: ids } : { row: ids.map((id) => ({ tabs: [id] })) };
  } catch {
    return null;
  }
}

export function addWorkspace(ws: Workspace): void {
  workspaces.value = [...workspaces.value, ws];
  activeWorkspaceId.value = ws.id;
}

export function renameWorkspace(id: string, name: string, icon?: string): void {
  workspaces.value = workspaces.value.map((w) => (w.id === id ? { ...w, name: name.trim() || w.name, icon: icon ?? w.icon } : w));
}

export function deleteWorkspace(id: string): void {
  const rest = workspaces.value.filter((w) => w.id !== id);
  if (rest.length === 0) return;
  remove(`layout:${id}`);
  remove(`layout:${id}:m`);
  workspaces.value = rest;
  if (activeWorkspaceId.value === id) activeWorkspaceId.value = rest[0].id;
}

export function moveWorkspace(id: string, toIndex: number): void {
  const list = [...workspaces.value];
  const from = list.findIndex((w) => w.id === id);
  if (from < 0) return;
  const [item] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, item);
  workspaces.value = list;
}

// ------------------------------------------------------------------ Teilen per Link

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export interface SharedWorkspace {
  n: string;
  i: string;
  l: LayoutNode;
}

export async function encodeShare(data: SharedWorkspace): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (typeof CompressionStream === 'undefined') return `j${toBase64Url(json)}`;
  return `z${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

export async function decodeShare(token: string): Promise<SharedWorkspace | null> {
  try {
    const body = fromBase64Url(token.slice(1));
    const bytes = token[0] === 'z' ? await pipe(body, new DecompressionStream('deflate-raw')) : body;
    const data = JSON.parse(new TextDecoder().decode(bytes)) as SharedWorkspace;
    const layout = sanitizeTree(data.l);
    if (!layout) return null;
    return { n: String(data.n ?? 'Geteilt').slice(0, 40), i: String(data.i ?? '🔗').slice(0, 4), l: layout };
  } catch {
    return null;
  }
}
