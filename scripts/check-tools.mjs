// Prüft alle Tools aus tools.json: gültig erreichbar? Einbettung erlaubt (X-Frame-Options, CSP frame-ancestors)?
// Ergebnis landet in tools-status.json. Die Oberfläche bietet Tools mit "dead" (404/410) und "down"
// (DNS-, Zertifikats-, Verbindungs- oder Serverfehler, auch nach einem zweiten Versuch) nicht an und
// öffnet blockierte Seiten separat. Ein Browser kann Statuscodes und diese Header selbst nicht auslesen;
// ob eine Seite gerade erreichbar ist, prüft er zusätzlich selbst (src/data/reachability.ts).
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'dist/tools-status.json';
const ORIGIN = 'https://warera.de';

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function framingBlocked(headers) {
  const xfo = (headers.get('x-frame-options') ?? '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return `X-Frame-Options: ${xfo}`;
  const csp = headers.get('content-security-policy') ?? '';
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.toLowerCase().startsWith('frame-ancestors'));
  if (!directive) return null;
  const sources = directive.split(/\s+/).slice(1);
  const allowed = sources.some((s) => s === '*' || s === 'https:' || ORIGIN.startsWith(s.replace(/\*\./, '')) || s.includes('warera.de'));
  return allowed ? null : `CSP ${directive}`;
}

async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    // fetch lehnt abgelaufene oder falsche Zertifikate ab, das zählt als nicht gültig erreichbar
    return await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'WarEraLauncher-ToolCheck/1.0' } });
  } finally {
    clearTimeout(timer);
  }
}

function describe(err) {
  return String(err?.cause?.code ?? err?.name ?? err);
}

async function check(tool) {
  // Eigene Unterseiten unter warera.de/ werden mit dem Launcher ausgeliefert und existieren
  // beim Check des ersten Deploys noch nicht.
  if (tool.url.startsWith(ORIGIN + '/')) return { status: 'ok', note: 'eigene Seite' };
  let res;
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetchOnce(tool.url);
      error = undefined;
      if (res.status < 500) break;
    } catch (err) {
      res = undefined;
      error = err;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 5_000));
  }
  if (!res) return { status: 'down', note: describe(error) };
  if (res.status === 404 || res.status === 410) return { status: 'dead', code: res.status };
  if (res.status >= 500) return { status: 'down', code: res.status };
  const blocked = framingBlocked(res.headers);
  if (blocked) return { status: 'blocked', code: res.status, note: blocked };
  return { status: 'ok', code: res.status };
}

const categories = JSON.parse(readFileSync('tools.json', 'utf8'));
const tools = categories.flatMap((c) => c.tools ?? []);
const results = {};
await Promise.all(
  tools.map(async (t) => {
    const id = t.id ? slugify(t.id) : slugify(t.name);
    results[id] = await check(t);
    console.log(`${results[id].status.padEnd(8)} ${id} ${results[id].note ?? ''}${t.hidden ? ' (ausgeblendet)' : ''}`);
  }),
);
writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
console.log(`geschrieben: ${out}`);
