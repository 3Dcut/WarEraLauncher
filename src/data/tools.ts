import { signal, computed, effect } from '@preact/signals';
import { fetchLocalJson } from '../core/http';
import { t, lang, localized, localizedUrl, allVariants, type Lang, type LocalizedText } from '../i18n';
import { reachability, type ReachMap } from './reachability';

/**
 * Eintrag in tools.json. Nur name und url sind Pflicht, alles andere ist optional.
 * name, url, desc und category dürfen ein String oder { "de": …, "en": …, "sv": … } sein;
 * in url wird {lang} durch die aktuelle Sprache ersetzt.
 */
export interface ToolDef {
  id?: string;
  name: LocalizedText;
  url: LocalizedText;
  emoji?: string;
  desc?: LocalizedText;
  /** false = Seite verbietet Einbettung, wird als Karte mit Öffnen-Knopf gezeigt. */
  embed?: boolean;
  tags?: string[];
  /** true = vorübergehend ausgeblendet, etwa weil das Tool nicht an das aktuelle Spiel angepasst ist. */
  hidden?: boolean;
  /** Grund fürs Ausblenden oder sonstiger Hinweis, erscheint auf der Karte offener Panels. */
  note?: LocalizedText;
}

export interface CategoryDef {
  category: LocalizedText;
  icon?: string;
  tools: ToolDef[];
}

/** Ergebnis des Build-Checks: dead = 404/410, down = Netzwerk-, Zertifikats- oder Serverfehler. */
export type ToolHealth = 'ok' | 'blocked' | 'dead' | 'down' | 'unknown';

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
  /** Sprachunabhängige Kennung der Kategorie (aus dem deutschen bzw. ersten Namen). */
  categoryId: string;
  health: ToolHealth;
  /** HTTP-Status aus dem Build-Check, falls der Server geantwortet hat. */
  healthCode: number | null;
  hidden: boolean;
  note: string;
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
  results?: Record<string, { status?: ToolHealth; code?: number }>;
}

// Namen und Beschreibungen sind Getter: Sie lesen die aktuelle Sprache erst beim Zugriff,
// Komponenten zeichnen deshalb beim Umschalten der Sprache neu.
function widget(
  widgetKind: WidgetKind,
  emoji: string,
  tags: string[],
  name: () => string,
  desc: () => string,
): WidgetDef {
  return {
    id: `widget:${widgetKind}`,
    kind: 'widget',
    widget: widgetKind,
    emoji,
    tags,
    get name() {
      return name();
    },
    get desc() {
      return desc();
    },
    get category() {
      return t('widgets.category');
    },
  };
}

export const WIDGETS: WidgetDef[] = [
  widget('timers', '⏱️', ['timer', 'regen', 'countdown', 'wahl', 'election', 'val'], () => t('widgets.timers.name'), () => t('widgets.timers.desc')),
  widget('character', '🪖', ['energie', 'gesundheit', 'profil', 'spieler', 'energy', 'health', 'player', 'energi', 'hälsa', 'spelare'], () => t('widgets.character.name'), () => t('widgets.character.desc')),
  widget('market', '📈', ['preise', 'handel', 'marge', 'produktion', 'prices', 'trade', 'margin', 'production', 'priser', 'handel', 'marknad'], () => t('widgets.market.name'), () => t('widgets.market.desc')),
  widget('battles', '⚔️', ['schlacht', 'krieg', 'kampf', 'battle', 'war', 'front', 'strid', 'krig'], () => t('widgets.battles.name'), () => t('widgets.battles.desc')),
  widget('radio', '📻', ['musik', 'stream', 'laut.fm', 'music', 'musik'], () => t('widgets.radio.name'), () => t('widgets.radio.desc')),
];

/** Das Spiel selbst lässt sich nie einbetten, ist aber über Palette und Knopf erreichbar. */
export const GAME_TOOL: Tool = {
  id: 'warera-game',
  kind: 'tool',
  get name() {
    return t('widgets.game.name');
  },
  url: 'https://app.warera.io',
  emoji: '🎮',
  get desc() {
    return t('widgets.game.desc');
  },
  embed: false,
  tags: ['spiel', 'game', 'app', 'spel'],
  get category() {
    return t('widgets.game.category');
  },
  categoryId: 'spiel',
  health: 'ok',
  healthCode: null,
  hidden: false,
  note: '',
};

export const categories = signal<{ id: string; name: string; icon: string; tools: Tool[] }[]>([]);
export const toolsLoaded = signal(false);
export const toolsError = signal<string | null>(null);

export const allTools = computed<Tool[]>(() => categories.value.flatMap((c) => c.tools));

export const launchables = computed<Launchable[]>(() => [...WIDGETS, ...allTools.value, GAME_TOOL]);

export function findLaunchable(id: string): Launchable | undefined {
  return launchables.value.find((l) => l.id === id);
}

/**
 * Warum ein Tool gerade nicht angeboten wird, oder null, wenn alles in Ordnung ist.
 * Die Prüfung im Browser zeigt den aktuellen Zustand aus Sicht der Nutzer und entscheidet bei
 * Netzwerk-, DNS- und Zertifikatsfehlern. Statuscodes sieht sie nicht (no-cors), eine Fehlerseite
 * gilt ihr als erreichbar; deshalb behalten 404 und Serverfehler aus dem Build-Check Vorrang.
 */
export function unavailableReason(item: Launchable, reach: ReachMap = reachability.value): string | null {
  if (item.kind !== 'tool' || item.id === GAME_TOOL.id) return null;
  if (item.hidden) return item.note ? t('shell.unavailable.hiddenNote', { note: item.note }) : t('shell.unavailable.hidden');
  if (item.health === 'dead') return t('shell.unavailable.dead');
  if (item.health === 'down' && item.healthCode != null && item.healthCode >= 500) return t('shell.unavailable.serverError', { code: item.healthCode });
  const probe = reach[item.id];
  if (probe) return probe.ok ? null : t('shell.unavailable.unreachable');
  if (item.health === 'down') return t('shell.unavailable.down');
  return null;
}

export function isOffered(item: Launchable): boolean {
  return unavailableReason(item) === null;
}

/** Nur die Tools, die gerade angeboten werden: für Seitenleiste, Befehlspalette und Vorlagen. */
export const offeredCategories = computed(() =>
  categories.value.map((c) => ({ ...c, tools: c.tools.filter(isOffered) })).filter((c) => c.tools.length > 0),
);

export const offeredLaunchables = computed<Launchable[]>(() => launchables.value.filter(isOffered));

export function findOffered(id: string): Launchable | undefined {
  const item = findLaunchable(id);
  return item && isOffered(item) ? item : undefined;
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

const isText = (v: unknown): v is LocalizedText =>
  typeof v === 'string' || (!!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string'));

/** Erster Name eines mehrsprachigen Textes in fester Reihenfolge (de, en, sv), unabhängig von der Anzeigesprache. */
const stableName = (v: LocalizedText): string => localized(v, 'de') || allVariants(v)[0] || '';

export function normalizeCategories(defs: CategoryDef[], status?: StatusFile, l: Lang = lang.value): { id: string; name: string; icon: string; tools: Tool[] }[] {
  const seen = new Set<string>();
  return defs
    .filter((c) => c && Array.isArray(c.tools))
    .map((c) => {
      const catDef: LocalizedText = isText(c.category) ? c.category : { de: 'Sonstiges', en: 'Other', sv: 'Övrigt' };
      const categoryId = slugify(stableName(catDef)) || 'sonstiges';
      const category = localized(catDef, l);
      return {
        id: categoryId,
        name: category,
        icon: c.icon ?? '🧰',
        tools: c.tools
          .filter((t) => t && isText(t.name) && isText(t.url) && allVariants(t.url).every((u) => isSafeUrl(u.replace(/\{lang\}/g, 'de'))))
          .map((t): Tool => {
            let id = t.id ? slugify(t.id) : slugify(stableName(t.name));
            while (seen.has(id)) id += '-2';
            seen.add(id);
            const health = status?.results?.[id]?.status ?? 'unknown';
            const healthCode = status?.results?.[id]?.code ?? null;
            return {
              id,
              kind: 'tool',
              name: localized(t.name, l),
              url: localizedUrl(t.url, l),
              emoji: t.emoji ?? '🔧',
              desc: isText(t.desc) ? localized(t.desc, l) : '',
              // Eine blockierte Seite bleibt blockiert, egal was tools.json behauptet.
              embed: t.embed !== false && health !== 'blocked',
              tags: t.tags ?? [],
              category,
              categoryId,
              health,
              healthCode,
              hidden: t.hidden === true,
              note: isText(t.note) ? localized(t.note, l) : '',
            };
          }),
      };
    });
}

/** Rohdaten aus tools.json; die Liste wird bei jedem Sprachwechsel daraus neu aufgebaut. */
const rawTools = signal<{ defs: CategoryDef[]; status?: StatusFile } | null>(null);

effect(() => {
  const raw = rawTools.value;
  const l = lang.value;
  if (raw) categories.value = normalizeCategories(raw.defs, raw.status, l);
});

export async function loadTools(): Promise<void> {
  try {
    const [defs, status] = await Promise.all([
      fetchLocalJson<CategoryDef[]>('./tools.json'),
      fetchLocalJson<StatusFile>('./tools-status.json').catch(() => undefined),
    ]);
    rawTools.value = { defs, status };
    toolsError.value = null;
  } catch (err) {
    console.error('tools.json konnte nicht geladen werden', err);
    toolsError.value = 'tools.json';
  } finally {
    toolsLoaded.value = true;
  }
}
