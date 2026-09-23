export class HttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} für ${url}`);
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Hängt einen Zeitstempel an, um Caches zu umgehen. */
  bust?: boolean;
  headers?: Record<string, string>;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = 10_000, bust = false, headers } = options;
  const target = bust ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: controller.signal, headers, cache: bust ? 'no-store' : 'default' });
    if (!res.ok) throw new HttpError(res.status, url);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(url: string, options: FetchJsonOptions = {}): Promise<string> {
  const { timeoutMs = 10_000, bust = false } = options;
  const target = bust ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { signal: controller.signal, cache: bust ? 'no-store' : 'default' });
    if (!res.ok) throw new HttpError(res.status, url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Lädt eine Datei des Launchers selbst (tools.json usw.) ohne Browser-Cache. */
export function fetchLocalJson<T>(path: string): Promise<T> {
  return fetchJson<T>(path, { bust: true, timeoutMs: 15_000 });
}
