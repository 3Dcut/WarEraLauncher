// Aktiver Spieler: kommt aus dem Launcher ("Mein Charakter", wl2:settings) und wird dort auch
// gespeichert, wenn man ihn hier wechselt, damit alle Werkzeuge denselben Spieler zeigen.

import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { batch, unwrap, findPlayer, type Lookup, type Player } from '../battle/api';
import { apiKey } from '../core/apiKey';
import { t } from '../i18n';

const SETTINGS = 'wl2:settings';

function readLauncher(): Player | null {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS) ?? 'null') as { characterId?: string | null; characterName?: string | null } | null;
    return s?.characterId ? { id: s.characterId, name: s.characterName ?? '' } : null;
  } catch {
    return null;
  }
}

export const player = signal<Player | null>(readLauncher());

export function setPlayer(p: Player | null): void {
  player.value = p;
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') ?? {};
    localStorage.setItem(SETTINGS, JSON.stringify({ ...s, characterId: p?.id ?? null, characterName: p?.name ?? null }));
  } catch {
    /* gesperrter Speicher: gilt bis zum Neuladen */
  }
}

window.addEventListener('storage', (e) => {
  if (e.key !== null && e.key !== SETTINGS) return;
  const next = readLauncher();
  if (next?.id !== player.value?.id) player.value = next;
});

/** Ergänzt Name, Bild und Stufe, wenn aus dem Launcher nur die ID kommt. */
export async function completePlayer(p: Player): Promise<Player> {
  if (p.avatarUrl && p.name) return p;
  try {
    const [u] = await batch<{ _id: string; username: string; avatarUrl?: string; leveling?: { level?: number } }>(
      [{ path: 'user.getUserLite', input: { userId: p.id } }],
      apiKey.value || null,
    );
    const user = unwrap(u);
    return { id: user._id, name: user.username, avatarUrl: user.avatarUrl, level: user.leveling?.level };
  } catch {
    return p;
  }
}

export function Avatar({ p, size = 36 }: { p: Player | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  return (
    <span class="a-avatar" style={{ width: `${size}px`, height: `${size}px` }}>
      {p?.avatarUrl && !broken ? (
        <img src={p.avatarUrl} alt="" referrerpolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span style={{ fontSize: `${size * 0.45}px` }}>{(p?.name || '?').slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}

/** Spieler anzeigen oder suchen; `locked` verhindert das Wechseln, etwa während einer Sitzung. */
export function PlayerPicker({ locked = false }: { locked?: boolean }) {
  const p = player.value;
  const [editing, setEditing] = useState(!p);
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (p && (!p.avatarUrl || !p.name)) void completePlayer(p).then((full) => player.value?.id === full.id && (player.value = full));
  }, [p?.id]);

  useEffect(() => {
    if (!p) setEditing(true);
  }, [p]);

  useEffect(() => {
    const q = query.trim();
    setLookup(null);
    if (q.length < 2) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      setBusy(true);
      findPlayer(q, apiKey.value || null)
        .then((res) => id === seq.current && setLookup(res))
        .catch(() => id === seq.current && setLookup({ match: null, suggestions: [] }))
        .finally(() => id === seq.current && setBusy(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [query]);

  const choose = (next: Player) => {
    setPlayer(next);
    setEditing(false);
    setQuery('');
    setLookup(null);
  };

  if (!editing && p) {
    return (
      <div class="a-player">
        <Avatar p={p} />
        <div class="a-player__who">
          <strong>{p.name || '…'}</strong>
          {p.level ? <span class="muted">{t('assist.player.level', { level: p.level })}</span> : null}
        </div>
        {!locked && (
          <button type="button" class="link-btn" onClick={() => setEditing(true)}>
            {t('assist.player.change')}
          </button>
        )}
      </div>
    );
  }

  const options = lookup ? (lookup.match ? [lookup.match] : lookup.suggestions) : [];
  return (
    <div class="a-player a-player--edit">
      <input
        class="input"
        autoFocus
        placeholder={t('assist.player.placeholder')}
        aria-label={t('assist.player.placeholder')}
        value={query}
        onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && options[0]) choose(options[0]);
          if (e.key === 'Escape' && p) setEditing(false);
        }}
      />
      <div class="a-player__suggest">
        {busy ? (
          <span class="muted">{t('assist.player.searching')}</span>
        ) : (
          options.map((o) => (
            <button type="button" class="chip" onClick={() => choose(o)}>
              {o.name}
            </button>
          ))
        )}
        {!busy && lookup && !options.length && <span class="muted">{t('assist.player.notFound')}</span>}
      </div>
    </div>
  );
}
