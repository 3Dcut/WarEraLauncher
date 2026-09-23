import { useRef, useState } from 'preact/hooks';
import { gameDates } from '../warera/dates';
import { formatCountdown, formatClock } from '../core/clock';
import { paletteOpen, settingsOpen, helpOpen, mobileSidebarOpen, isMobile, toast } from '../state';
import { openLaunchable, switchWorkspace, activeDock, disposeWorkspaceDock, queueTree } from '../workspace/dock';
import {
  workspaces,
  activeWorkspaceId,
  presets,
  addWorkspace,
  renameWorkspace,
  deleteWorkspace,
  moveWorkspace,
  presetById,
  newId,
  encodeShare,
} from '../workspace/model';
import * as radio from '../radio/engine';
import { getStation } from '../radio/stations';
import { Icon } from './icons';
import { Popover, useNow, copyText, justDismissed } from './primitives';
import { RadioConsole, PlayButton, StationDot, phaseLabel } from './RadioConsole';
import { pipSupported, openMiniPlayer, pipOpen } from './MiniPlayer';
import { openAsWindow } from './ExternalCard';
import { GAME_TOOL } from '../data/tools';

export function TopBar() {
  return (
    <header class="topbar">
      {isMobile.value && (
        <button type="button" class="icon-btn" aria-label="Werkzeuge anzeigen" onClick={() => (mobileSidebarOpen.value = true)}>
          <Icon name="menu" size={18} />
        </button>
      )}
      <div class="brand" aria-label="WarEra Launcher">
        <span class="brand__mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="22" height="22">
            <path d="M16 2 4 7v8.5C4 23 9.2 28.2 16 30c6.8-1.8 12-7 12-14.5V7z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" />
            <path d="m9.5 12 3 9 3.5-7 3.5 7 3-9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        {!isMobile.value && (
          <span class="brand__text">
            WarEra <b>Launcher</b>
          </span>
        )}
      </div>

      <WorkspaceTabs />

      <div class="topbar__right">
        {!isMobile.value && <TimerChips />}
        <button type="button" class="search-btn" onClick={() => (paletteOpen.value = true)} aria-label="Suchen und Befehle (Strg+K)">
          <Icon name="search" />
          {!isMobile.value && (
            <>
              <span>Suchen …</span>
              <kbd>Strg K</kbd>
            </>
          )}
        </button>
        <RadioPill />
        {!isMobile.value && (
          <button type="button" class="btn btn--game" onClick={() => openAsWindow(GAME_TOOL)} title="WarEra als Fenster öffnen (Alt+W)">
            <Icon name="gamepad" />
            <span>Spielen</span>
          </button>
        )}
        {pipSupported && !isMobile.value && (
          <button type="button" class={`icon-btn ${pipOpen.value ? 'is-active' : ''}`} onClick={() => void openMiniPlayer()} title="Mini-Player über dem Spiel (bleibt im Vordergrund)" aria-label="Mini-Player öffnen">
            <Icon name="pip" size={18} />
          </button>
        )}
        {!isMobile.value && (
          <button type="button" class="icon-btn" onClick={() => (helpOpen.value = true)} title="Tastenkürzel (?)" aria-label="Tastenkürzel und Hilfe">
            <Icon name="keyboard" size={18} />
          </button>
        )}
        <button type="button" class="icon-btn" onClick={() => (settingsOpen.value = true)} title="Einstellungen" aria-label="Einstellungen">
          <Icon name="settings" size={18} />
        </button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ Arbeitsbereiche als Reiter

function WorkspaceTabs() {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const addAnchor = useRef<HTMLButtonElement>(null);
  const dragId = useRef<string | null>(null);
  const active = activeWorkspaceId.value;
  const menuWs = workspaces.value.find((w) => w.id === menuFor);

  const share = async (id: string) => {
    const ws = workspaces.value.find((w) => w.id === id);
    const tree = activeDock()?.toTree();
    if (!ws || !tree) {
      toast('Dieser Arbeitsbereich ist leer, es gibt nichts zu teilen.', 'warn');
      return;
    }
    const token = await encodeShare({ n: ws.name, i: ws.icon, l: tree });
    const url = `${location.origin}${location.pathname}#ws=${token}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (isMobile.value && nav.share) {
      nav.share({ title: `WarEra Launcher: ${ws.name}`, url }).catch(() => undefined);
      return;
    }
    toast((await copyText(url)) ? 'Link kopiert. Wer ihn öffnet, bekommt dieses Layout als neuen Arbeitsbereich.' : url, 'success', undefined, 7000);
  };

  return (
    <nav class="ws-tabs" aria-label="Arbeitsbereiche">
      <div class="ws-tabs__scroll" role="tablist">
        {workspaces.value.map((ws, i) => (
          <div
            class={`ws-tab ${ws.id === active ? 'is-active' : ''}`}
            role="tab"
            aria-selected={ws.id === active}
            draggable={editing !== ws.id}
            onDragStart={(e) => {
              dragId.current = ws.id;
              e.dataTransfer?.setData('text/plain', ws.name);
            }}
            onDragOver={(e) => dragId.current && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId.current) moveWorkspace(dragId.current, i);
              dragId.current = null;
            }}
          >
            {editing === ws.id ? (
              <input
                id={`ws-name-${ws.id}`}
                class="ws-tab__input"
                value={ws.name}
                aria-label="Name des Arbeitsbereichs"
                ref={(el) => el?.focus()}
                onBlur={(e) => {
                  renameWorkspace(ws.id, (e.target as HTMLInputElement).value);
                  setEditing(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button type="button" class="ws-tab__btn" onClick={() => switchWorkspace(ws.id)} onDblClick={() => setEditing(ws.id)} title={i < 9 ? `Alt+${i + 1}` : undefined}>
                <span aria-hidden="true">{ws.icon}</span>
                <span class="ws-tab__name">{ws.name}</span>
              </button>
            )}
            {ws.id === active && editing !== ws.id && (
              <button
                ref={menuAnchor}
                type="button"
                class="ws-tab__more"
                aria-label={`Optionen für ${ws.name}`}
                onClick={() => {
                  if (justDismissed()) return;
                  setConfirmDelete(false);
                  setMenuFor(menuFor ? null : ws.id);
                }}
              >
                <Icon name="chevronDown" size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button ref={addAnchor} type="button" class="ws-add" aria-label="Arbeitsbereich hinzufügen" title="Arbeitsbereich hinzufügen" onClick={() => !justDismissed() && setAdding(!adding)}>
        <Icon name="plus" />
      </button>

      <Popover anchor={menuAnchor} open={!!menuWs} onClose={() => setMenuFor(null)} label="Arbeitsbereich-Optionen" align="start" class="menu">
        {menuWs && (
          <div class="menu__list">
            <button type="button" onClick={() => (setEditing(menuWs.id), setMenuFor(null))}>
              <Icon name="edit" /> Umbenennen
            </button>
            <div class="menu__emoji" role="group" aria-label="Symbol wählen">
              {['🏠', '💰', '⚔️', '📊', '🗺️', '🏭', '🎖️', '📻', '🧭', '🛡️', '🍺', '🌙'].map((e) => (
                <button type="button" class={menuWs.icon === e ? 'is-active' : ''} onClick={() => renameWorkspace(menuWs.id, menuWs.name, e)} aria-label={`Symbol ${e}`}>
                  {e}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => (void share(menuWs.id), setMenuFor(null))}>
              <Icon name="share" /> Layout als Link teilen
            </button>
            {presetById(menuWs.preset) && (
              <button type="button" onClick={() => (activeDock()?.resetToPreset(), setMenuFor(null), toast('Auf Vorlage zurückgesetzt', 'success'))}>
                <Icon name="reload" /> Auf Vorlage zurücksetzen
              </button>
            )}
            <button type="button" onClick={() => (activeDock()?.closeAll(), setMenuFor(null))}>
              <Icon name="x" /> Alle Fenster schließen
            </button>
            {workspaces.value.length > 1 &&
              (confirmDelete ? (
                <button
                  type="button"
                  class="danger"
                  onClick={() => {
                    disposeWorkspaceDock(menuWs.id);
                    deleteWorkspace(menuWs.id);
                    setMenuFor(null);
                    switchWorkspace(activeWorkspaceId.value);
                  }}
                >
                  <Icon name="trash" /> Wirklich löschen?
                </button>
              ) : (
                <button type="button" class="danger" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" /> Arbeitsbereich löschen
                </button>
              ))}
          </div>
        )}
      </Popover>

      <Popover anchor={addAnchor} open={adding} onClose={() => setAdding(false)} label="Neuer Arbeitsbereich" align="start" class="menu">
        <div class="menu__list">
          <button
            type="button"
            onClick={() => {
              const id = newId();
              addWorkspace({ id, name: 'Neuer Bereich', icon: '🗂️' });
              setAdding(false);
              switchWorkspace(id);
              setEditing(id);
            }}
          >
            <Icon name="plus" /> Leerer Arbeitsbereich
          </button>
          <div class="menu__label">Aus Vorlage</div>
          {presets.value.map((p) => (
            <button
              type="button"
              onClick={() => {
                const id = newId();
                queueTree(id, p.layout);
                addWorkspace({ id, name: p.name, icon: p.icon, preset: p.id });
                setAdding(false);
                switchWorkspace(id);
              }}
            >
              <span aria-hidden="true">{p.icon}</span> {p.name}
            </button>
          ))}
        </div>
      </Popover>
    </nav>
  );
}

// ------------------------------------------------------------------ Zeit-Chips

function TimerChips() {
  const now = useNow(1000);
  const dates = gameDates.value;
  if (!dates) return null;
  const regen = Date.parse(dates.nextRegenAt);
  const day = Date.parse(dates.nextDayAt);
  return (
    <button type="button" class="timer-chips" onClick={() => openLaunchable('widget:timers')} title="Alle Spielzeiten anzeigen">
      <span class="timer-chip" title={`Regeneration um ${formatClock(new Date(regen))}`}>
        <Icon name="reload" size={13} />
        <span class="timer-chip__label">Regen</span>
        <span class="mono">{formatCountdown(regen - now)}</span>
      </span>
      <span class="timer-chip" title={`Tageswechsel um ${formatClock(new Date(day))}`}>
        <Icon name="clock" size={13} />
        <span class="timer-chip__label">Tag</span>
        <span class="mono">{formatCountdown(day - now)}</span>
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ Radio-Pille

function RadioPill() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const current = getStation(radio.station.value);
  const np = radio.nowPlaying.value;
  const clip = radio.activeClip.value;
  const title = clip ? `Einspieler: ${clip}` : radio.isPlaying.value ? np?.title || phaseLabel() : phaseLabel();
  return (
    <div ref={anchor} class={`radio-pill ${radio.isPlaying.value ? 'is-playing' : ''} ${radio.phase.value === 'blocked' ? 'is-blocked' : ''}`}>
      <PlayButton size="sm" />
      <button type="button" class="radio-pill__info" onClick={() => !justDismissed() && setOpen(!open)} aria-expanded={open} aria-label="Radio-Steuerung öffnen" data-radio-control>
        {current && <StationDot id={current.id} />}
        {!isMobile.value && (
          <span class="radio-pill__text">
            <span class="radio-pill__station">
              {current?.name ?? 'Radio'}
              {radio.autoMode.value && <span class="badge badge--tiny">AUTO</span>}
            </span>
            <span class="radio-pill__title">{title}</span>
          </span>
        )}
        {radio.isPlaying.value && (
          <span class="eq" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        <Icon name="chevronDown" size={14} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Radio" class="radio-popover">
        <RadioConsole idPrefix="pill" />
      </Popover>
    </div>
  );
}
