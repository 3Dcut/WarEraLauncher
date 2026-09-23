// Prüft alle Tools aus tools.json: erreichbar? Einbettung erlaubt (X-Frame-Options, CSP frame-ancestors)?
// Ergebnis landet in tools-status.json; die Oberfläche zeigt daraufhin "offline" bzw. öffnet
// blockierte Seiten automatisch separat. Ein Browser kann diese Header selbst nicht auslesen.
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

async function check(tool) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(tool.url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'WarEraLauncher-ToolCheck/1.0' } });
    if (res.status === 404 || res.status === 410) return { status: 'dead', code: res.status };
    if (res.status >= 500) return { status: 'unknown', code: res.status };
    const blocked = framingBlocked(res.headers);
    if (blocked) return { status: 'blocked', code: res.status, note: blocked };
    return { status: 'ok', code: res.status };
  } catch (err) {
    return { status: 'unknown', note: String(err?.name ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

const categories = JSON.parse(readFileSync('tools.json', 'utf8'));
const tools = categories.flatMap((c) => c.tools ?? []);
const results = {};
await Promise.all(
  tools.map(async (t) => {
    const id = t.id ? slugify(t.id) : slugify(t.name);
    results[id] = await check(t);
    console.log(`${results[id].status.padEnd(8)} ${id} ${results[id].note ?? ''}`);
  }),
);
writeFileSync(out, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
console.log(`geschrieben: ${out}`);
