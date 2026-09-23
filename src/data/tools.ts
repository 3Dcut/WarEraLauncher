import { signal, computed } from '@preact/signals';
import { fetchLocalJson } from '../core/http';

/** Eintrag in tools.json. Nur name und url sind Pflicht, alles andere ist optional. */
export interface ToolDef {
  id?: string;
  name: string;
  url: string;
  emoji?: string;
  desc?: string;
  /** false = Seite verbietet Einbettung, wird als Karte mit Öffnen-Knopf gezeigt. */
  embed?: boolean;
  tags?: string[];
}

export interface CategoryDef {
  category: string;
  icon?: string;
  tools: ToolDef[];
}

export type ToolHealth = 'ok' | 'blocked' | 'dead' | 'unknown';

export interface Tool {
  id: string;
  kind: 'tool';
  name: string;
  url: string;
  emoji: string;
  desc: string;
  embed: boolean;
  tags: string[];
  category: string;
  health: ToolHealth;
}

export interface WidgetDef {
  id: string;
  kind: 'widget';
  widget: WidgetKind;
  name: string;
  emoji: string;
  desc: string;
  category: string;
  tags: string[];
}

export type WidgetKind = 'timers' | 'character' | 'market' | 'battles' | 'radio';

export type Launchable = Tool | WidgetDef;

interface StatusFile {
  checkedAt?: string;
  results?: Record<string, { status?: ToolHealth }>;
}

export const WIDGETS: WidgetDef[] = [
  { id: 'widget:timers', kind: 'widget', widget: 'timers', name: 'Zeiten', emoji: '⏱️', desc: 'Regeneration, Tageswechsel, Missionen und Wahlen', category: 'Widgets', tags: ['timer', 'regen', 'countdown', 'wahl'] },
  { id: 'widget:character', kind: 'widget', widget: 'character', name: 'Mein Charakter', emoji: '🪖', desc: 'Energie, Gesundheit und Hunger mit Vollzeit-Prognose', category: 'Widgets', tags: ['energie', 'gesundheit', 'profil', 'spieler'] },
  { id: 'widget:market', kind: 'widget', widget: 'market', name: 'Markt', emoji: '📈', desc: 'Live-Preise, Verlauf und Wert pro Produktionspunkt', category: 'Widgets', tags: ['preise', 'handel', 'marge', 'produktion'] },
  { id: 'widget:battles', kind: 'widget', widget: 'battles', name: 'Front', emoji: '⚔️', desc: 'Laufende Schlachten mit Rundenstand', category: 'Widgets', tags: ['schlacht', 'krieg', 'kampf'] },
  { id: 'widget:radio', kind: 'widget', widget: 'radio', name: 'Radio', emoji: '📻', desc: 'Sender, Automatik und Einspieler-Plan', category: 'Widgets', tags: ['musik', 'stream', 'laut.fm'] },
];

/** Das Spiel selbst lässt sich nie einbetten, ist aber über Palette und Knopf erreichbar. */
export const GAME_TOOL: Tool = {
  id: 'warera-game',
  kind: 'tool',
  name: 'WarEra (Spiel)',
  url: 'https://app.warera.io',
  emoji: '🎮',
  desc: 'Das Spiel in einem eigenen Tab',
  embed: false,
  tags: ['spiel', 'game', 'app'],
  category: 'Spiel',
  health: 'ok',
};

export const categories = signal<{ name: string; icon: string; tools: Tool[] }[]>([]);
export const toolsLoaded = signal(false);
export const toolsError = signal<string | null>(null);

export const allTools = computed<Tool[]>(() => categories.value.flatMap((c) => c.tools));

export const launchables = computed<Launchable[]>(() => [...WIDGETS, ...allTools.value, GAME_TOOL]);

export function findLaunchable(id: string): Launchable | undefined {
  return launchables.value.find((l) => l.id === id);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeCategories(defs: CategoryDef[], status?: StatusFile): { name: string; icon: string; tools: Tool[] }[] {
  const seen = new Set<string>();
  return defs
    .filter((c) => c && Array.isArray(c.tools))
    .map((c) => ({
      name: String(c.category ?? 'Sonstiges'),
      icon: c.icon ?? '🧰',
      tools: c.tools
        .filter((t) => t && typeof t.name === 'string' && typeof t.url === 'string' && isSafeUrl(t.url))
        .map((t): Tool => {
          let id = t.id ? slugify(t.id) : slugify(t.name);
          while (seen.has(id)) id += '-2';
          seen.add(id);
          const health = status?.results?.[id]?.status ?? 'unknown';
          return {
            id,
            kind: 'tool',
            name: t.name,
            url: t.url,
            emoji: t.emoji ?? '🔧',
            desc: t.desc ?? '',
            // Eine blockierte Seite bleibt blockiert, egal was tools.json behauptet.
            embed: t.embed !== false && health !== 'blocked',
            tags: t.tags ?? [],
            category: String(c.category ?? 'Sonstiges'),
            health,
          };
        }),
    }));
}

export async function loadTools(): Promise<void> {
  try {
    const [defs, status] = await Promise.all([
      fetchLocalJson<CategoryDef[]>('./tools.json'),
      fetchLocalJson<StatusFile>('./tools-status.json').catch(() => undefined),
    ]);
    categories.value = normalizeCategories(defs, status);
    toolsError.value = null;
  } catch (err) {
    console.error('tools.json konnte nicht geladen werden', err);
    toolsError.value = 'Die Tool-Liste (tools.json) konnte nicht geladen werden.';
  } finally {
    toolsLoaded.value = true;
  }
}
