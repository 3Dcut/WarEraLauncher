// Mehrsprachigkeit: Deutsch, Englisch, Schwedisch.
//
// Reihenfolge bei der Wahl der Sprache:
//   1. ?lang=de|en|sv in der Adresse (gilt für diesen Aufruf, wird nicht gespeichert)
//   2. die in den Einstellungen gewählte Sprache (localStorage "wl2:lang": "de" | "en" | "sv" | "auto")
//   3. "auto": die Sprache des Browsers, sonst Englisch
// Wer den Launcher schon vor der Übersetzung benutzt hat, bekommt beim ersten Aufruf "de" gespeichert.
//
// Texte liegen je Bereich in messages/*.ts. Deutsch ist die Quelle; TypeScript erzwingt, dass
// Englisch und Schwedisch dieselben Schlüssel haben. Platzhalter schreiben sich {name}.

import { signal, computed, effect } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import { load, save, loadLegacy } from '../core/storage';
import common from './messages/common';
import shell from './messages/shell';
import settingsMsgs from './messages/settings';
import radio from './messages/radio';
import widgets from './messages/widgets';
import workspace from './messages/workspace';

export type Lang = 'de' | 'en' | 'sv';
export type LangPref = Lang | 'auto';

export const LANGS: { id: Lang; name: string; locale: string; og: string }[] = [
  { id: 'de', name: 'Deutsch', locale: 'de-DE', og: 'de_DE' },
  { id: 'en', name: 'English', locale: 'en-GB', og: 'en_GB' },
  { id: 'sv', name: 'Svenska', locale: 'sv-SE', og: 'sv_SE' },
];

export function isLang(value: unknown): value is Lang {
  return value === 'de' || value === 'en' || value === 'sv';
}

// ------------------------------------------------------------------ Kataloge

export { defineMessages } from './define';

export const CATALOGS = [common, shell, settingsMsgs, radio, widgets, workspace] as const;

type Catalog = (typeof CATALOGS)[number];
export type MessageKey = Catalog extends infer C ? (C extends { de: infer D } ? keyof D & string : never) : never;
type PluralBase<K> = K extends `${infer B}.other` ? B : never;
export type PluralKey = PluralBase<MessageKey>;

const dict: Record<Lang, Record<string, string>> = { de: {}, en: {}, sv: {} };
for (const c of CATALOGS) {
  Object.assign(dict.de, c.de);
  Object.assign(dict.en, c.en);
  Object.assign(dict.sv, c.sv);
}

// ------------------------------------------------------------------ aktuelle Sprache

const STORE_KEY = 'lang';

function urlLang(): Lang | null {
  if (typeof location === 'undefined') return null;
  try {
    const value = new URLSearchParams(location.search).get('lang')?.toLowerCase().slice(0, 2);
    return isLang(value) ? value : null;
  } catch {
    return null;
  }
}

function browserLang(): Lang {
  if (typeof navigator === 'undefined') return 'de';
  const list = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of list) {
    const primary = String(tag).toLowerCase().split('-')[0];
    if (isLang(primary)) return primary;
    // Norwegisch und Dänisch lesen sich auf Schwedisch leichter als auf Englisch
    if (primary === 'nb' || primary === 'nn' || primary === 'no' || primary === 'da') return 'sv';
  }
  return 'en';
}

function storedPref(): LangPref {
  const stored = load<string | null>(STORE_KEY, null);
  if (stored === 'auto' || isLang(stored)) return stored;
  // Erster Aufruf mit Übersetzung (index.html entscheidet das sonst schon vor dem Laden):
  // Wer den Launcher bereits kennt, behält Deutsch, neue Besucher folgen dem Browser.
  const known = load<unknown>('settings', null) != null || loadLegacy('wl-theme') != null || loadLegacy('wl-open-tools') != null;
  const pref: LangPref = known ? 'de' : 'auto';
  save(STORE_KEY, pref);
  return pref;
}

/** Gewählte Einstellung: feste Sprache oder automatisch nach Browser. */
export const langPref = signal<LangPref>(storedPref());
/** Sprache aus der Adresse; überstimmt die Einstellung für diesen Aufruf. */
const urlOverride = signal<Lang | null>(urlLang());

/** Was die Sprachwahl in den Einstellungen anzeigt: die Sprache aus der Adresse, sonst die gespeicherte Wahl. */
export const langChoice = computed<LangPref>(() => urlOverride.value ?? langPref.value);

export const lang = computed<Lang>(() => urlOverride.value ?? (langPref.value === 'auto' ? browserLang() : langPref.value));

/** BCP-47-Tag für Intl, z. B. "de-DE". */
export const locale = computed(() => LANGS.find((l) => l.id === lang.value)!.locale);

/**
 * Stellt die Sprache um und speichert die Wahl. Steht ?lang= in der Adresse, wird es angepasst,
 * damit ein Neuladen die neue Wahl nicht wieder überschreibt.
 */
export function setLang(pref: LangPref): void {
  langPref.value = pref;
  save(STORE_KEY, pref);
  if (urlOverride.value && typeof location !== 'undefined') {
    const url = new URL(location.href);
    if (pref === 'auto') url.searchParams.delete('lang');
    else url.searchParams.set('lang', pref);
    history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    urlOverride.value = pref === 'auto' ? null : pref;
  }
}

/** Adresse der Seite in einer bestimmten Sprache, z. B. für Links zum Teilen. */
export function urlForLang(target: Lang, base: string = typeof location !== 'undefined' ? location.href : 'https://warera.de/'): string {
  const url = new URL(base);
  url.searchParams.set('lang', target);
  return url.toString();
}

// ------------------------------------------------------------------ Übersetzen

type Params = Record<string, string | number>;

function lookup(key: string, l: Lang): string {
  return dict[l][key] ?? dict.en[key] ?? dict.de[key] ?? key;
}

function fill(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Ein Text in allen Sprachen, etwa um einen vom Launcher vergebenen Namen wiederzuerkennen. */
export function messageVariants(key: MessageKey): string[] {
  return [dict.de[key], dict.en[key], dict.sv[key]].filter((v): v is string => !!v);
}

/** Übersetzter Text. Liest die Sprache als Signal: Komponenten zeichnen beim Umschalten neu. */
export function t(key: MessageKey, params?: Params): string {
  return fill(lookup(key, lang.value), params);
}

const pluralRules = new Map<string, Intl.PluralRules>();

/**
 * Text mit Mehrzahl: erwartet die Schlüssel "<basis>.one" und "<basis>.other".
 * {count} steht im Text für die formatierte Zahl.
 */
export function tn(base: PluralKey, count: number, params?: Params): string {
  const loc = locale.value;
  let rules = pluralRules.get(loc);
  if (!rules) pluralRules.set(loc, (rules = new Intl.PluralRules(loc)));
  const form = rules.select(count) === 'one' ? 'one' : 'other';
  return fill(lookup(`${base}.${form}`, lang.value), { count: formatNumber(count), ...params });
}

/**
 * Für Sätze mit Markup: Platzhalter werden durch Elemente ersetzt.
 * tx('help.palette', { keys: <kbd>Strg K</kbd> }) → ['Mit ', <kbd/>, ' öffnest du …']
 */
export function tx(key: MessageKey, parts: Record<string, ComponentChildren>): ComponentChildren[] {
  const text = lookup(key, lang.value);
  const out: ComponentChildren[] = [];
  let last = 0;
  for (const m of text.matchAll(/\{(\w+)\}/g)) {
    out.push(text.slice(last, m.index));
    out.push(m[1] in parts ? parts[m[1]] : m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return out.filter((p) => p !== '');
}

// ------------------------------------------------------------------ Mehrsprachige Daten (tools.json, workspaces.json)

/** Text in Datendateien: ein String (gilt für alle Sprachen) oder { "de": …, "en": …, "sv": … }. */
export type LocalizedText = string | Partial<Record<Lang, string>>;

/** Wählt die passende Sprache; fehlt sie, zuerst Englisch, dann Deutsch, dann irgendeine. */
export function localized(value: LocalizedText | undefined | null, l: Lang = lang.value): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return value[l] ?? value.en ?? value.de ?? Object.values(value).find((v) => typeof v === 'string') ?? '';
}

/** Alle Fassungen eines Textes, etwa um einen unveränderten Vorlagennamen zu erkennen. */
export function allVariants(value: LocalizedText | undefined | null): string[] {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  return Object.values(value).filter((v): v is string => typeof v === 'string');
}

/** Adresse mit {lang}-Platzhalter, ebenfalls je Sprache angebbar. */
export function localizedUrl(value: LocalizedText | undefined | null, l: Lang = lang.value): string {
  return localized(value, l).replace(/\{lang\}/g, l);
}

// ------------------------------------------------------------------ Zahlen und Zeiten

const numberFormats = new Map<string, Intl.NumberFormat>();

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const loc = locale.value;
  const cacheKey = `${loc}|${options ? JSON.stringify(options) : ''}`;
  let f = numberFormats.get(cacheKey);
  if (!f) numberFormats.set(cacheKey, (f = new Intl.NumberFormat(loc, options)));
  return f.format(value);
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

export function formatDate(value: Date | number, options: Intl.DateTimeFormatOptions): string {
  const loc = locale.value;
  const cacheKey = `${loc}|${JSON.stringify(options)}`;
  let f = dateFormats.get(cacheKey);
  if (!f) dateFormats.set(cacheKey, (f = new Intl.DateTimeFormat(loc, options)));
  return f.format(value);
}

/** Vergleich für sort() in der aktuellen Sprache. */
export function compareText(a: string, b: string): number {
  return a.localeCompare(b, locale.value);
}

// ------------------------------------------------------------------ Dokument

/** Setzt lang-Attribut, Titel und Beschreibung der Seite passend zur Sprache. */
export function initDocumentLanguage(): void {
  if (typeof document === 'undefined') return;
  effect(() => {
    const l = lang.value;
    document.documentElement.lang = l;
    document.title = t('common.docTitle');
    document.querySelector('meta[name="description"]')?.setAttribute('content', t('common.docDescription'));
    const og = LANGS.find((x) => x.id === l)!.og;
    document.querySelector('meta[property="og:locale"]')?.setAttribute('content', og);
    // Seiten mit ?lang= verweisen per Canonical auf sich selbst, sonst passt hreflang nicht
    const canonical = document.querySelector('link[rel="canonical"]');
    if (canonical) canonical.setAttribute('href', urlOverride.value ? `https://warera.de/?lang=${l}` : 'https://warera.de/');
  });
  // Sprache in einem anderen Tab umgestellt
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === 'wl2:lang') langPref.value = storedPref();
  });
}
