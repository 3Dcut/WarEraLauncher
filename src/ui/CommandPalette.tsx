import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import fuzzysort from 'fuzzysort';
import { launchables, findLaunchable, GAME_TOOL, type Launchable } from '../data/tools';
import { paletteOpen, settingsOpen, helpOpen, settings, updateSettings, THEMES } from '../state';
import { openLaunchable, switchWorkspace, activeDock } from '../workspace/dock';
import { workspaces, presets, workspaceLabel } from '../workspace/model';
import * as radio from '../radio/engine';
import { STATIONS } from '../radio/stations';
import { setTheme } from '../theme';
import { openAsWindow } from './ExternalCard';
import { pipSupported, openMiniPlayer } from './MiniPlayer';
import { Icon, type IconName } from './icons';
import { t, lang, LANGS, setLang } from '../i18n';

interface Command {
  id: string;
  group: Group;
  title: string;
  hint?: string;
  emoji?: string;
  icon?: IconName;
  keywords?: string;
  run: () => void;
}

type Group = 'favorites' | 'recent' | 'widgets' | 'tools' | 'workspaces' | 'radio' | 'actions' | 'templates' | 'appearance';

function groupLabel(g: Group): string {
  switch (g) {
    case 'favorites': return t('settings.palette.group.favorites');
    case 'recent': return t('settings.palette.group.recent');
    case 'widgets': return t('settings.palette.group.widgets');
    case 'tools': return t('settings.palette.group.tools');
    case 'workspaces': return t('settings.palette.group.workspaces');
    case 'radio': return t('settings.palette.group.radio');
    case 'actions': return t('settings.palette.group.actions');
    case 'templates': return t('settings.palette.group.templates');
    case 'appearance': return t('settings.palette.group.appearance');
  }
}

function toolCommand(l: Launchable): Command {
  return {
    id: l.id,
    group: l.kind === 'widget' ? 'widgets' : 'tools',
    title: l.name,
    hint: l.kind === 'tool' && !l.embed ? t('settings.palette.opensSeparately', { category: l.category }) : l.category,
    emoji: l.emoji,
    keywords: `${l.desc} ${l.tags.join(' ')} ${l.category}`,
    run: () => (l.id === GAME_TOOL.id ? openAsWindow(GAME_TOOL) : openLaunchable(l.id)),
  };
}

function buildCommands(): Command[] {
  const list: Command[] = launchables.value.map(toolCommand);
  workspaces.value.forEach((w, i) =>
    list.push({ id: `ws:${w.id}`, group: 'workspaces', title: workspaceLabel(w), emoji: w.icon, hint: i < 9 ? `Alt+${i + 1}` : undefined, keywords: t('settings.palette.workspaceKeywords'), run: () => switchWorkspace(w.id) }),
  );
  presets.value.forEach((p) =>
    list.push({ id: `preset:${p.id}`, group: 'templates', title: t('settings.palette.template', { name: p.name }), emoji: p.icon, hint: t('settings.palette.templateHint'), keywords: t('settings.palette.templateKeywords'), run: () => activeDock()?.applyTree(p.layout) }),
  );
  STATIONS.forEach((s) =>
    list.push({ id: `station:${s.id}`, group: 'radio', title: t('settings.palette.listen', { name: s.name }), emoji: s.emoji, keywords: t('settings.palette.stationKeywords'), run: () => radio.play(s.id, { user: true }) }),
  );
  const actions: Command[] = [
    { id: 'radio-toggle', group: 'radio', title: radio.isPlaying.value ? t('settings.palette.radioPause') : t('settings.palette.radioPlay'), icon: radio.isPlaying.value ? 'pause' : 'play', hint: 'Alt+M', keywords: t('settings.palette.radioToggleKeywords'), run: () => radio.toggle() },
    { id: 'radio-auto', group: 'radio', title: radio.autoMode.value ? t('settings.palette.autoOff') : t('settings.palette.autoOn'), icon: 'auto', keywords: t('settings.palette.autoKeywords'), run: () => radio.setAuto(!radio.autoMode.value) },
    { id: 'reload', group: 'actions', title: t('settings.palette.reload'), icon: 'reload', hint: 'Alt+R', run: () => activeDock()?.reloadActive() },
    { id: 'close-all', group: 'actions', title: t('settings.palette.closeAll'), icon: 'x', run: () => activeDock()?.closeAll() },
    { id: 'reset', group: 'actions', title: t('settings.palette.resetWorkspace'), icon: 'layout', run: () => activeDock()?.resetToPreset() },
    { id: 'sidebar', group: 'actions', title: settings.value.sidebarCollapsed ? t('settings.palette.sidebarExpand') : t('settings.palette.sidebarCollapse'), icon: 'sidebar', hint: 'Alt+B', run: () => updateSettings({ sidebarCollapsed: !settings.value.sidebarCollapsed }) },
    { id: 'game', group: 'actions', title: t('settings.palette.playGame'), icon: 'gamepad', hint: 'Alt+W', run: () => openAsWindow(GAME_TOOL) },
    { id: 'settings', group: 'actions', title: t('settings.title'), icon: 'settings', keywords: t('settings.palette.settingsKeywords'), run: () => (settingsOpen.value = true) },
    { id: 'help', group: 'actions', title: t('settings.palette.showShortcuts'), icon: 'keyboard', hint: '?', run: () => (helpOpen.value = true) },
    { id: 'legacy', group: 'actions', title: t('settings.palette.openLegacy'), icon: 'external', run: () => void window.open('./legacy.html', '_self') },
  ];
  if (pipSupported) actions.push({ id: 'pip', group: 'actions', title: t('settings.palette.miniPlayer'), icon: 'pip', keywords: t('settings.palette.miniPlayerKeywords'), run: () => void openMiniPlayer() });
  THEMES.forEach((th) =>
    actions.push({ id: `theme:${th.id}`, group: 'appearance', title: t('settings.palette.themeTitle', { name: th.name }), icon: 'palette', hint: th.hint, keywords: t('settings.palette.themeKeywords'), run: () => setTheme(th.id) }),
  );
  LANGS.forEach((l) =>
    actions.push({ id: `lang:${l.id}`, group: 'appearance', title: `${t('settings.language')}: ${l.name}`, icon: 'settings', keywords: `${t('settings.palette.languageKeywords')} ${l.id}`, run: () => setLang(l.id) }),
  );
  return [...list, ...actions];
}

const GROUP_ORDER: Group[] = ['favorites', 'recent', 'widgets', 'tools', 'workspaces', 'radio', 'actions', 'templates', 'appearance'];

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

  const commands = useMemo(() => (open ? buildCommands() : []), [open, lang.value]);

  const results = useMemo(() => {
    if (!open) return [];
    const q = query.trim();
    if (!q) {
      const fav = settings.value.favorites.map(findLaunchable).filter((l): l is Launchable => !!l).map((l) => ({ ...toolCommand(l), group: 'favorites' as Group }));
      const rec = settings.value.recents
        .filter((id) => !settings.value.favorites.includes(id))
        .map(findLaunchable)
        .filter((l): l is Launchable => !!l)
        .slice(0, 5)
        .map((l) => ({ ...toolCommand(l), group: 'recent' as Group }));
      const rest = commands.filter((c) => c.group === 'widgets' || c.group === 'workspaces' || c.id === 'radio-toggle' || c.id === 'radio-auto');
      return [...fav, ...rec, ...rest];
    }
    const hits = fuzzysort.go(q, commands, { keys: ['title', 'keywords', 'hint'], threshold: 0.3, limit: 40 });
    return hits.map((h) => h.obj).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
  }, [query, commands, open, lang.value]);

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

  let lastGroup: Group | '' = '';
  return (
    <dialog
      ref={ref}
      class="palette"
      aria-label={t('settings.palette.label')}
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
              placeholder={t('settings.palette.placeholder')}
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
          <ul id="palette-list" class="palette__list" role="listbox" aria-label={t('settings.palette.results')}>
            {results.length === 0 && <li class="palette__empty">{t('settings.palette.empty')}</li>}
            {results.map((c, i) => {
              const header = c.group !== lastGroup ? groupLabel(c.group) : null;
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
              <kbd>↓</kbd> {t('settings.palette.select')}
            </span>
            <span>
              <kbd>Enter</kbd> {t('settings.palette.run')}
            </span>
            <span>
              <kbd>Esc</kbd> {t('settings.palette.close')}
            </span>
          </footer>
        </div>
      )}
    </dialog>
  );
}
