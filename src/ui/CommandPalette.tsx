import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import fuzzysort from 'fuzzysort';
import { launchables, findLaunchable, GAME_TOOL, type Launchable } from '../data/tools';
import { paletteOpen, settingsOpen, helpOpen, settings, updateSettings, THEMES } from '../state';
import { openLaunchable, switchWorkspace, activeDock } from '../workspace/dock';
import { workspaces, presets } from '../workspace/model';
import * as radio from '../radio/engine';
import { STATIONS } from '../radio/stations';
import { setTheme } from '../theme';
import { openAsWindow } from './ExternalCard';
import { pipSupported, openMiniPlayer } from './MiniPlayer';
import { Icon, type IconName } from './icons';

interface Command {
  id: string;
  group: string;
  title: string;
  hint?: string;
  emoji?: string;
  icon?: IconName;
  keywords?: string;
  run: () => void;
}

function toolCommand(l: Launchable): Command {
  return {
    id: l.id,
    group: l.kind === 'widget' ? 'Widgets' : 'Tools',
    title: l.name,
    hint: l.kind === 'tool' && !l.embed ? `${l.category} · öffnet separat` : l.category,
    emoji: l.emoji,
    keywords: `${l.desc} ${l.tags.join(' ')} ${l.category}`,
    run: () => (l.id === GAME_TOOL.id ? openAsWindow(GAME_TOOL) : openLaunchable(l.id)),
  };
}

function buildCommands(): Command[] {
  const list: Command[] = launchables.value.map(toolCommand);
  workspaces.value.forEach((w, i) =>
    list.push({ id: `ws:${w.id}`, group: 'Arbeitsbereiche', title: w.name, emoji: w.icon, hint: i < 9 ? `Alt+${i + 1}` : undefined, keywords: 'arbeitsbereich workspace', run: () => switchWorkspace(w.id) }),
  );
  presets.value.forEach((p) =>
    list.push({ id: `preset:${p.id}`, group: 'Vorlagen', title: `Vorlage „${p.name}“ übernehmen`, emoji: p.icon, hint: 'ersetzt das aktuelle Layout', keywords: 'layout vorlage preset', run: () => activeDock()?.applyTree(p.layout) }),
  );
  STATIONS.forEach((s) =>
    list.push({ id: `station:${s.id}`, group: 'Radio', title: `${s.name} hören`, emoji: s.emoji, keywords: 'radio sender musik stream', run: () => radio.play(s.id, { user: true }) }),
  );
  const actions: Command[] = [
    { id: 'radio-toggle', group: 'Radio', title: radio.isPlaying.value ? 'Radio pausieren' : 'Radio abspielen', icon: radio.isPlaying.value ? 'pause' : 'play', hint: 'Alt+M', keywords: 'play pause stop musik', run: () => radio.toggle() },
    { id: 'radio-auto', group: 'Radio', title: radio.autoMode.value ? 'Automatik ausschalten' : 'Automatik einschalten', icon: 'auto', keywords: 'auto sender wechsel', run: () => radio.setAuto(!radio.autoMode.value) },
    { id: 'reload', group: 'Aktionen', title: 'Aktives Tool neu laden', icon: 'reload', hint: 'Alt+R', run: () => activeDock()?.reloadActive() },
    { id: 'close-all', group: 'Aktionen', title: 'Alle Fenster im Arbeitsbereich schließen', icon: 'x', run: () => activeDock()?.closeAll() },
    { id: 'reset', group: 'Aktionen', title: 'Arbeitsbereich auf Vorlage zurücksetzen', icon: 'layout', run: () => activeDock()?.resetToPreset() },
    { id: 'sidebar', group: 'Aktionen', title: settings.value.sidebarCollapsed ? 'Seitenleiste ausklappen' : 'Seitenleiste einklappen', icon: 'sidebar', hint: 'Alt+B', run: () => updateSettings({ sidebarCollapsed: !settings.value.sidebarCollapsed }) },
    { id: 'game', group: 'Aktionen', title: 'WarEra spielen', icon: 'gamepad', hint: 'Alt+W', run: () => openAsWindow(GAME_TOOL) },
    { id: 'settings', group: 'Aktionen', title: 'Einstellungen', icon: 'settings', keywords: 'optionen theme farbe', run: () => (settingsOpen.value = true) },
    { id: 'help', group: 'Aktionen', title: 'Tastenkürzel anzeigen', icon: 'keyboard', hint: '?', run: () => (helpOpen.value = true) },
    { id: 'legacy', group: 'Aktionen', title: 'Alte Oberfläche öffnen', icon: 'external', run: () => void window.open('./legacy.html', '_self') },
  ];
  if (pipSupported) actions.push({ id: 'pip', group: 'Aktionen', title: 'Mini-Player öffnen', icon: 'pip', keywords: 'picture in picture overlay', run: () => void openMiniPlayer() });
  THEMES.forEach((t) =>
    actions.push({ id: `theme:${t.id}`, group: 'Darstellung', title: `Theme „${t.name}“`, icon: 'palette', hint: t.hint, keywords: 'theme farbe design', run: () => setTheme(t.id) }),
  );
  return [...list, ...actions];
}

const GROUP_ORDER = ['Favoriten', 'Zuletzt', 'Widgets', 'Tools', 'Arbeitsbereiche', 'Radio', 'Aktionen', 'Vorlagen', 'Darstellung'];

export function CommandPalette() {
  const open = paletteOpen.value;
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      setQuery('');
      setCursor(0);
      el.showModal();
      requestAnimationFrame(() => input.current?.focus());
    }
    if (!open && el.open) el.close();
  }, [open]);

  const commands = useMemo(() => (open ? buildCommands() : []), [open]);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.trim();
    if (!q) {
      const fav = settings.value.favorites.map(findLaunchable).filter((l): l is Launchable => !!l).map((l) => ({ ...toolCommand(l), group: 'Favoriten' }));
      const rec = settings.value.recents
        .filter((id) => !settings.value.favorites.includes(id))
        .map(findLaunchable)
        .filter((l): l is Launchable => !!l)
        .slice(0, 5)
        .map((l) => ({ ...toolCommand(l), group: 'Zuletzt' }));
      const rest = commands.filter((c) => c.group === 'Widgets' || c.group === 'Arbeitsbereiche' || c.id === 'radio-toggle' || c.id === 'radio-auto');
      return [...fav, ...rec, ...rest];
    }
    const hits = fuzzysort.go(q, commands, { keys: ['title', 'keywords', 'hint'], threshold: 0.3, limit: 40 });
    return hits.map((h) => h.obj).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [query, commands, open]);

  const close = () => (paletteOpen.value = false);
  const run = (c: Command | undefined) => {
    if (!c) return;
    close();
    // Nach dem Schließen ausführen, damit Fokus und View Transitions sauber laufen
    requestAnimationFrame(() => c.run());
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[cursor]);
    }
  };

  useEffect(() => {
    document.getElementById(`cmd-${cursor}`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  let lastGroup = '';
  return (
    <dialog
      ref={ref}
      class="palette"
      aria-label="Befehlspalette"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => e.target === ref.current && close()}
    >
      {open && (
        <div class="palette__inner">
          <label class="palette__search" for="palette-input">
            <Icon name="search" size={18} />
            <input
              id="palette-input"
              ref={input}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={`cmd-${cursor}`}
              placeholder="Tool, Widget, Arbeitsbereich oder Befehl …"
              value={query}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => {
                setQuery((e.target as HTMLInputElement).value);
                setCursor(0);
              }}
              onKeyDown={onKey}
            />
            <kbd>Esc</kbd>
          </label>
          <ul id="palette-list" class="palette__list" role="listbox" aria-label="Ergebnisse">
            {results.length === 0 && <li class="palette__empty">Nichts gefunden. Versuch es mit einem anderen Begriff.</li>}
            {results.map((c, i) => {
              const header = c.group !== lastGroup ? c.group : null;
              lastGroup = c.group;
              return (
                <>
                  {header && (
                    <li class="palette__group" role="presentation">
                      {header}
                    </li>
                  )}
                  <li id={`cmd-${i}`} role="option" aria-selected={i === cursor} class={`palette__item ${i === cursor ? 'is-active' : ''}`} onMouseMove={() => setCursor(i)} onClick={() => run(c)}>
                    <span class="palette__icon" aria-hidden="true">
                      {c.emoji ?? (c.icon ? <Icon name={c.icon} /> : null)}
                    </span>
                    <span class="palette__title">{c.title}</span>
                    {c.hint && <span class="palette__hint">{c.hint}</span>}
                  </li>
                </>
              );
            })}
          </ul>
          <footer class="palette__foot">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> wählen
            </span>
            <span>
              <kbd>Enter</kbd> ausführen
            </span>
            <span>
              <kbd>Esc</kbd> schließen
            </span>
          </footer>
        </div>
      )}
    </dialog>
  );
}
