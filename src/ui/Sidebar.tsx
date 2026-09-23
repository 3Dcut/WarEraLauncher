import { useState } from 'preact/hooks';
import { categories, WIDGETS, findLaunchable, toolsError, type Launchable } from '../data/tools';
import { settings, updateSettings, toggleFavorite, isMobile, mobileSidebarOpen } from '../state';
import { openLaunchable, openIds, DRAG_MIME } from '../workspace/dock';
import { load, save } from '../core/storage';
import { Icon } from './icons';

function startDrag(e: DragEvent, id: string): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DRAG_MIME, id);
  e.dataTransfer.setData('text/plain', findLaunchable(id)?.name ?? id);
  e.dataTransfer.effectAllowed = 'copyMove';
  // Iframes schlucken Drag-Ereignisse; solange gezogen wird, ignorieren sie den Zeiger
  document.documentElement.classList.add('is-dragging');
  if (isMobile.value) mobileSidebarOpen.value = false;
}

function endDrag(): void {
  document.documentElement.classList.remove('is-dragging');
}

function launch(id: string): void {
  openLaunchable(id);
  if (isMobile.value) mobileSidebarOpen.value = false;
}

function Item({ item }: { item: Launchable }) {
  const fav = settings.value.favorites.includes(item.id);
  const open = openIds.value.includes(item.id);
  const external = item.kind === 'tool' && !item.embed;
  const dead = item.kind === 'tool' && item.health === 'dead';
  return (
    <li class={`tool-item ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        class="tool-item__main"
        draggable
        onDragStart={(e) => startDrag(e as DragEvent, item.id)}
        onDragEnd={endDrag}
        onClick={() => launch(item.id)}
        title={item.desc ? `${item.name}: ${item.desc}` : item.name}
      >
        <span class="tool-item__emoji" aria-hidden="true">
          {item.emoji}
        </span>
        <span class="tool-item__name">{item.name}</span>
        {external && (
          <span class="tool-item__flag" title="Öffnet sich separat (Seite erlaubt keine Einbettung)">
            <Icon name="external" size={12} />
          </span>
        )}
        {dead && <span class="badge badge--warn">offline</span>}
        {open && <span class="tool-item__open" title="Im aktuellen Arbeitsbereich geöffnet" />}
      </button>
      <button type="button" class={`tool-item__fav ${fav ? 'is-fav' : ''}`} onClick={() => toggleFavorite(item.id)} aria-label={fav ? `${item.name} aus Favoriten entfernen` : `${item.name} zu Favoriten`} aria-pressed={fav}>
        <Icon name="star" size={14} filled={fav} />
      </button>
    </li>
  );
}

function Section({ id, title, icon, items, defaultOpen = true }: { id: string; title: string; icon?: string; items: Launchable[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(() => load<Record<string, boolean>>('sidebar:sections', {})[id] ?? defaultOpen);
  if (items.length === 0) return null;
  return (
    <section class="side-section">
      <button
        type="button"
        class="side-section__head"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          save('sidebar:sections', { ...load<Record<string, boolean>>('sidebar:sections', {}), [id]: next });
        }}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        {icon && <span aria-hidden="true">{icon}</span>}
        <span>{title}</span>
        <span class="side-section__count">{items.length}</span>
      </button>
      {open && (
        <ul class="tool-list">
          {items.map((item) => (
            <Item item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function Sidebar() {
  const [filter, setFilter] = useState('');
  const collapsed = settings.value.sidebarCollapsed && !isMobile.value;
  const q = filter.trim().toLowerCase();
  const match = (l: Launchable) => !q || `${l.name} ${l.desc} ${l.tags.join(' ')} ${l.category}`.toLowerCase().includes(q);
  const favorites = settings.value.favorites.map(findLaunchable).filter((l): l is Launchable => !!l);
  const recents = settings.value.recents
    .filter((id) => !settings.value.favorites.includes(id))
    .map(findLaunchable)
    .filter((l): l is Launchable => !!l)
    .slice(0, 4);

  if (collapsed) {
    const rail = [...favorites, ...WIDGETS.filter((w) => !settings.value.favorites.includes(w.id))];
    return (
      <aside class="sidebar sidebar--rail" aria-label="Werkzeuge">
        <button type="button" class="icon-btn" onClick={() => updateSettings({ sidebarCollapsed: false })} aria-label="Seitenleiste ausklappen" title="Seitenleiste ausklappen (Alt+B)">
          <Icon name="chevronRight" />
        </button>
        <ul class="rail">
          {rail.map((item) => (
            <li>
              <button type="button" class={`rail__item ${openIds.value.includes(item.id) ? 'is-open' : ''}`} draggable onDragStart={(e) => startDrag(e as DragEvent, item.id)} onDragEnd={endDrag} onClick={() => launch(item.id)} title={item.name} aria-label={item.name}>
                {item.emoji}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    );
  }

  return (
    <aside class={`sidebar ${isMobile.value ? 'sidebar--drawer' : ''} ${mobileSidebarOpen.value ? 'is-open' : ''}`} aria-label="Werkzeuge">
      <div class="sidebar__head">
        <h2>Werkzeuge</h2>
        {isMobile.value ? (
          <button type="button" class="icon-btn" onClick={() => (mobileSidebarOpen.value = false)} aria-label="Schließen">
            <Icon name="x" />
          </button>
        ) : (
          <button type="button" class="icon-btn" onClick={() => updateSettings({ sidebarCollapsed: true })} aria-label="Seitenleiste einklappen" title="Seitenleiste einklappen (Alt+B)">
            <Icon name="chevronLeft" />
          </button>
        )}
      </div>
      <label class="filter" for="sidebar-filter">
        <Icon name="search" size={14} />
        <input id="sidebar-filter" type="search" placeholder="Filtern …" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} autocomplete="off" />
      </label>
      <p class="sidebar__hint">Klicken öffnet, Ziehen platziert frei im Layout.</p>
      <div class="sidebar__scroll">
        {toolsError.value && <p class="notice notice--warn">{toolsError.value}</p>}
        {!q && <Section id="favorites" title="Favoriten" icon="★" items={favorites} />}
        {!q && <Section id="recents" title="Zuletzt benutzt" items={recents} defaultOpen={false} />}
        <Section id="widgets" title="Live-Widgets" icon="✨" items={WIDGETS.filter(match)} />
        {categories.value.map((c) => (
          <Section id={`cat:${c.name}`} title={c.name} icon={c.icon} items={c.tools.filter(match)} />
        ))}
      </div>
    </aside>
  );
}
