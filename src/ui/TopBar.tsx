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
  workspaceLabel,
} from '../workspace/model';
import * as radio from '../radio/engine';
import { getStation } from '../radio/stations';
import { Icon } from './icons';
import { Popover, useNow, copyText, justDismissed } from './primitives';
import { RadioConsole, PlayButton, StationDot, phaseLabel } from './RadioConsole';
import { pipSupported, openMiniPlayer, pipOpen } from './MiniPlayer';
import { openAsWindow } from './ExternalCard';
import { GAME_TOOL } from '../data/tools';
import { t } from '../i18n';

export function TopBar() {
  return (
    <header class="topbar">
      {isMobile.value && (
        <button type="button" class="icon-btn" aria-label={t('shell.top.showTools')} onClick={() => (mobileSidebarOpen.value = true)}>
          <Icon name="menu" size={18} />
        </button>
      )}
      <div class="brand" aria-label={t('shell.brand.aria')}>
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
        <button type="button" class="search-btn" onClick={() => (paletteOpen.value = true)} aria-label={t('shell.top.searchAria')}>
          <Icon name="search" />
          {!isMobile.value && (
            <>
              <span>{t('shell.top.searchLabel')}</span>
              <kbd>{t('shell.top.searchKeys')}</kbd>
            </>
          )}
        </button>
        <RadioPill />
        {!isMobile.value && (
          <button type="button" class="btn btn--game" onClick={() => openAsWindow(GAME_TOOL)} title={t('shell.top.playTitle')}>
            <Icon name="gamepad" />
            <span>{t('shell.top.play')}</span>
          </button>
        )}
        {pipSupported && !isMobile.value && (
          <button type="button" class={`icon-btn ${pipOpen.value ? 'is-active' : ''}`} onClick={() => void openMiniPlayer()} title={t('shell.top.miniTitle')} aria-label={t('shell.top.miniAria')}>
            <Icon name="pip" size={18} />
          </button>
        )}
        {!isMobile.value && (
          <button type="button" class="icon-btn" onClick={() => (helpOpen.value = true)} title={t('shell.top.helpTitle')} aria-label={t('shell.top.helpAria')}>
            <Icon name="keyboard" size={18} />
          </button>
        )}
        <button type="button" class="icon-btn" onClick={() => (settingsOpen.value = true)} title={t('shell.top.settings')} aria-label={t('shell.top.settings')}>
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
      toast(t('shell.ws.shareEmpty'), 'warn');
      return;
    }
    const token = await encodeShare({ n: workspaceLabel(ws), i: ws.icon, l: tree });
    const url = `${location.origin}${location.pathname}#ws=${token}`;
    const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
    if (isMobile.value && nav.share) {
      nav.share({ title: t('shell.ws.shareTitle', { name: workspaceLabel(ws) }), url }).catch(() => undefined);
      return;
    }
    toast((await copyText(url)) ? t('shell.ws.shareCopied') : url, 'success', undefined, 7000);
  };

  return (
    <nav class="ws-tabs" aria-label={t('shell.ws.tabs')}>
      <div class="ws-tabs__scroll" role="tablist">
        {workspaces.value.map((ws, i) => (
          <div
            class={`ws-tab ${ws.id === active ? 'is-active' : ''}`}
            role="tab"
            aria-selected={ws.id === active}
            draggable={editing !== ws.id}
            onDragStart={(e) => {
              dragId.current = ws.id;
              e.dataTransfer?.setData('text/plain', workspaceLabel(ws));
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
                value={workspaceLabel(ws)}
                aria-label={t('shell.ws.nameAria')}
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
                <span class="ws-tab__name">{workspaceLabel(ws)}</span>
              </button>
            )}
            {ws.id === active && editing !== ws.id && (
              <button
                ref={menuAnchor}
                type="button"
                class="ws-tab__more"
                aria-label={t('shell.ws.optionsAria', { name: workspaceLabel(ws) })}
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
      <button ref={addAnchor} type="button" class="ws-add" aria-label={t('shell.ws.add')} title={t('shell.ws.add')} onClick={() => !justDismissed() && setAdding(!adding)}>
        <Icon name="plus" />
      </button>

      <Popover anchor={menuAnchor} open={!!menuWs} onClose={() => setMenuFor(null)} label={t('shell.ws.menu')} align="start" class="menu">
        {menuWs && (
          <div class="menu__list">
            <button type="button" onClick={() => (setEditing(menuWs.id), setMenuFor(null))}>
              <Icon name="edit" /> {t('shell.ws.rename')}
            </button>
            <div class="menu__emoji" role="group" aria-label={t('shell.ws.iconGroup')}>
              {['🏠', '💰', '⚔️', '📊', '🗺️', '🏭', '🎖️', '📻', '🧭', '🛡️', '🍺', '🌙'].map((e) => (
                <button type="button" class={menuWs.icon === e ? 'is-active' : ''} onClick={() => renameWorkspace(menuWs.id, workspaceLabel(menuWs), e)} aria-label={t('shell.ws.iconAria', { icon: e })}>
                  {e}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => (void share(menuWs.id), setMenuFor(null))}>
              <Icon name="share" /> {t('shell.ws.share')}
            </button>
            {presetById(menuWs.preset) && (
              <button type="button" onClick={() => (activeDock()?.resetToPreset(), setMenuFor(null), toast(t('shell.ws.resetDone'), 'success'))}>
                <Icon name="reload" /> {t('shell.ws.resetPreset')}
              </button>
            )}
            <button type="button" onClick={() => (activeDock()?.closeAll(), setMenuFor(null))}>
              <Icon name="x" /> {t('shell.ws.closeAll')}
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
                  <Icon name="trash" /> {t('shell.ws.deleteConfirm')}
                </button>
              ) : (
                <button type="button" class="danger" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" /> {t('shell.ws.delete')}
                </button>
              ))}
          </div>
        )}
      </Popover>

      <Popover anchor={addAnchor} open={adding} onClose={() => setAdding(false)} label={t('shell.ws.newMenu')} align="start" class="menu">
        <div class="menu__list">
          <button
            type="button"
            onClick={() => {
              const id = newId();
              addWorkspace({ id, name: t('workspace.newName'), icon: '🗂️' });
              setAdding(false);
              switchWorkspace(id);
              setEditing(id);
            }}
          >
            <Icon name="plus" /> {t('shell.ws.empty')}
          </button>
          <div class="menu__label">{t('shell.ws.fromPreset')}</div>
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
    <button type="button" class="timer-chips" onClick={() => openLaunchable('widget:timers')} title={t('shell.timers.title')}>
      <span class="timer-chip" title={t('shell.timers.regenTitle', { time: formatClock(new Date(regen)) })}>
        <Icon name="reload" size={13} />
        <span class="timer-chip__label">{t('shell.timers.regen')}</span>
        <span class="mono">{formatCountdown(regen - now)}</span>
      </span>
      <span class="timer-chip" title={t('shell.timers.dayTitle', { time: formatClock(new Date(day)) })}>
        <Icon name="clock" size={13} />
        <span class="timer-chip__label">{t('shell.timers.day')}</span>
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
  const title = clip ? t('radio.clip.active', { name: clip }) : radio.isPlaying.value ? np?.title || phaseLabel() : phaseLabel();
  return (
    <div ref={anchor} class={`radio-pill ${radio.isPlaying.value ? 'is-playing' : ''} ${radio.phase.value === 'blocked' ? 'is-blocked' : ''}`}>
      <PlayButton size="sm" />
      <button type="button" class="radio-pill__info" onClick={() => !justDismissed() && setOpen(!open)} aria-expanded={open} aria-label={t('shell.radio.openAria')} data-radio-control>
        {current && <StationDot id={current.id} />}
        {!isMobile.value && (
          <span class="radio-pill__text">
            <span class="radio-pill__station">
              {current?.name ?? t('shell.radio.fallbackName')}
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
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={t('shell.radio.popover')} class="radio-popover">
        <RadioConsole idPrefix="pill" />
      </Popover>
    </div>
  );
}
