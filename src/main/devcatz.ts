import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { newRequest, uid, type DevCatzApp, type DevCatzOpenApi, type DevCatzSite, type EnvVariable, type HttpMethod, type TreeItem } from '@shared/types';
import { send } from './http';
import { importText } from './importers';

/**
 * DevCatz → DialCatz. DevCatz runs the user's local sites on https://<site>.localhost and writes what it runs to
 * bridge.json (schema 1, read-only for us): each site's apps (web / api / assets, with their own URL) and the
 * OpenAPI documents it found. DialCatz makes an environment per site (baseUrl = the chosen app's URL) and imports
 * its routes: Laravel through `php artisan route:list --json` (DevCatz's PHP), else the OpenAPI document — a file
 * from the bridge, then one served by the app. Without a bridge.json (older DevCatz) it falls back to config.json.
 * A site's .env values stay on this computer (environment values never sync).
 */

const DATA = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'DevCatz') : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DevCatz');

interface DevCatzConfig {
  projects?: { id: string; name: string; path: string; domain: string }[];
  settings?: { httpsPort?: number };
}

interface Bridge {
  schema: number;
  sites?: {
    id: string;
    name: string;
    domain: string;
    url: string;
    path: string;
    running?: boolean;
    apps?: { dir: string; name: string; framework: string; kind: string; url: string | null }[];
    openapi?: DevCatzOpenApi[];
  }[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(join(DATA, file), 'utf8')) as T;
  } catch {
    return null;
  }
}

function framework(path: string): DevCatzSite['framework'] {
  const read = (f: string) => {
    try {
      return readFileSync(join(path, f), 'utf8');
    } catch {
      return '';
    }
  };
  if (existsSync(join(path, 'artisan')) && /laravel\/framework/.test(read('composer.json'))) return 'laravel';
  const pkg = read('package.json');
  if (/"@nestjs\/core"/.test(pkg)) return 'nestjs';
  if (/"express"|"fastify"|"hono"/.test(pkg)) return 'node';
  if (/"nuxt"|"next"/.test(pkg)) return 'web';
  if (existsSync(join(path, 'go.mod'))) return 'go';
  if (/fastapi|django/i.test(read('requirements.txt') + read('pyproject.toml'))) return 'python';
  return 'other';
}

/** The site's kind from its apps' frameworks (bridge names), else from its files. */
function siteFramework(path: string, apps: DevCatzApp[]): DevCatzSite['framework'] {
  if (apps.some((a) => a.framework === 'laravel')) return 'laravel';
  const f = (apps.find((a) => a.kind === 'api') ?? apps.find((a) => a.kind === 'web'))?.framework ?? '';
  if (f === 'nestjs') return 'nestjs';
  if (['express', 'fastify', 'hono', 'koa', 'node'].includes(f)) return 'node';
  if (f === 'go' || f === 'gin' || f === 'fiber' || f === 'echo') return 'go';
  if (['fastapi', 'django', 'flask', 'python'].includes(f)) return 'python';
  if (['nuxt', 'next', 'astro', 'vite', 'vue', 'react', 'svelte', 'static'].includes(f)) return 'web';
  return framework(path);
}

export function installed(): boolean {
  return existsSync(join(DATA, 'bridge.json')) || existsSync(join(DATA, 'config.json'));
}

export function sites(): DevCatzSite[] {
  const b = readJson<Bridge>('bridge.json');
  if (b?.schema === 1 && b.sites) {
    return b.sites
      .filter((p) => p.domain && p.path)
      .map((p) => {
        const apps: DevCatzApp[] = (p.apps ?? []).map((a) => ({ dir: a.dir, name: a.name, framework: a.framework, kind: a.kind === 'api' || a.kind === 'assets' ? a.kind : 'web', url: a.url || null }));
        return { id: p.id, name: p.name, domain: p.domain, path: p.path, url: p.url, framework: siteFramework(p.path, apps), hasEnv: existsSync(join(p.path, '.env')), running: !!p.running, apps, openapi: (p.openapi ?? []).filter((o) => o.file || o.url) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const c = readJson<DevCatzConfig>('config.json');
  if (!c?.projects) return [];
  const port = c.settings?.httpsPort && c.settings.httpsPort !== 443 ? `:${c.settings.httpsPort}` : '';
  return c.projects
    .filter((p) => p.domain && p.path)
    .map((p) => ({ id: p.id, name: p.name, domain: p.domain, path: p.path, url: `https://${p.domain}${port}`, framework: framework(p.path), hasEnv: existsSync(join(p.path, '.env')), running: false, apps: [], openapi: [] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function site(id: string): DevCatzSite {
  const s = sites().find((x) => x.id === id);
  if (!s) throw new Error('DevCatz does not have that site any more');
  return s;
}

/** The app to talk to: the one asked for, else the site's API app, else its web app. */
export function pickApp(s: DevCatzSite, dir?: string): DevCatzApp | null {
  const usable = s.apps.filter((a) => a.kind !== 'assets');
  return (dir !== undefined ? usable.find((a) => a.dir === dir) : undefined) ?? usable.find((a) => a.kind === 'api' && a.url) ?? usable.find((a) => a.url) ?? null;
}

/** A short name for an app: `@catzoid/web` → web, `github.com/x/api` → api. */
export const appLabel = (a: DevCatzApp) => a.name.split('/').pop() || a.dir;

/** The address requests go to (the environment's baseUrl). */
export function baseUrl(s: DevCatzSite, dir?: string): string {
  return (pickApp(s, dir)?.url ?? s.url).replace(/\/+$/, '');
}

/** The site's .env as variables; names that look like secrets are marked secret. */
export function envVariables(s: DevCatzSite): EnvVariable[] {
  let text = '';
  try {
    text = readFileSync(join(s.path, '.env'), 'utf8');
  } catch {
    return [];
  }
  const out: EnvVariable[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value: v, enabled: true, secret: /KEY|SECRET|PASSWORD|PASS$|TOKEN|PRIVATE|DSN|CREDENTIAL/i.test(m[1]) });
  }
  return out;
}

function run(cmd: string, args: string[], cwd: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH: `${join(DATA, 'bin')}:${process.env.PATH ?? ''}` } }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join(' '))) : resolve(stdout),
    ),
  );
}

/**
 * Laravel: every route of `artisan route:list` (closures and framework internals skipped) as requests, split by
 * route file — an "api" folder (the api middleware group, or /api/…) and a "web" folder, when there are both —
 * each grouped by its first path segment.
 */
async function laravelRoutes(cwd: string, collectionId: string): Promise<TreeItem[]> {
  const php = existsSync(join(DATA, 'bin', 'php')) ? join(DATA, 'bin', 'php') : 'php';
  const out = await run(php, ['artisan', 'route:list', '--json'], cwd);
  const routes = JSON.parse(out.slice(out.indexOf('['))) as { method: string; uri: string; name: string | null; action: string; middleware?: string[] }[];
  const kept = routes.filter((r) => !/^(_ignition|sanctum\/csrf-cookie|telescope|horizon|_debugbar|livewire|up$|storage\/)/.test(r.uri));
  const isApi = (r: (typeof kept)[number]) => (r.middleware ?? []).includes('api') || r.uri === 'api' || r.uri.startsWith('api/');
  const items: TreeItem[] = [];
  const folder = (name: string, parentId: string, sort: number): TreeItem => {
    const f: TreeItem = { id: uid('f_'), kind: 'folder', parentId, name, sort, auth: { mode: 'inherit' } };
    items.push(f);
    return f;
  };
  let n = 0;
  const parts = [['api', kept.filter(isApi)], ['web', kept.filter((r) => !isApi(r))]] as const;
  const split = parts.every(([, list]) => list.length);
  for (const [kind, list] of parts) {
    if (!list.length) continue;
    const top = split ? folder(kind, collectionId, kind === 'api' ? 0 : 1) : { id: collectionId };
    const groups = new Map<string, TreeItem>();
    for (const r of list) {
      const method = (r.method.split('|').find((m) => m !== 'HEAD') ?? 'GET') as HttpMethod;
      const segs = r.uri.replace(/^\//, '').split('/');
      const group = (kind === 'api' && segs[0] === 'api' ? segs[1] : segs[0]) || '/';
      if (!groups.has(group)) groups.set(group, folder(group === '/' ? 'root' : group, top.id, groups.size));
      items.push({
        id: uid('r_'),
        kind: 'request',
        parentId: groups.get(group)!.id,
        name: r.name || `${method} /${r.uri.replace(/^\//, '')}`,
        sort: n++,
        request: {
          ...newRequest(),
          method,
          url: `{{baseUrl}}/${r.uri.replace(/^\//, '').replace(/\{(\w+)\??\}/g, ':$1')}`,
          headers: kind === 'api' ? [{ key: 'Accept', value: 'application/json', enabled: true }] : [],
          ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: { mode: 'json' as const, raw: '{\n  \n}', fields: [] } } : {}),
        },
        description: r.action,
      });
    }
  }
  return items;
}

const OPENAPI_PATHS = ['/openapi.json', '/swagger.json', '/api/openapi.json', '/docs/openapi.json', '/api-docs', '/v3/api-docs', '/swagger/v1/swagger.json', '/api/docs.json', '/openapi.yaml'];
const MAX_SPEC = 20 * 1024 * 1024;

type Parsed = { root: TreeItem; items: TreeItem[] };

function parseSpec(text: string): Parsed | null {
  if (!/openapi|swagger/i.test(text.slice(0, 4000))) return null;
  try {
    return importText(text);
  } catch {
    return null;
  }
}

async function fetchSpec(url: string, siteId: string): Promise<Parsed | null> {
  const r = await send({ method: 'GET', url, headers: [['Accept', 'application/json, application/yaml']] }, `devcatz-${siteId}`, { timeoutMs: 5000, insecure: true, followRedirects: true });
  return r.response?.ok ? parseSpec(r.response.body) : null;
}

/** The OpenAPI documents DevCatz found for the site: the chosen app's first, files read from disk, URLs fetched. */
async function bridgeSpec(s: DevCatzSite, app: DevCatzApp | null): Promise<{ api: Parsed; from: string } | null> {
  const list = [...s.openapi].sort((a, b) => Number(b.app === app?.dir) - Number(a.app === app?.dir));
  for (const o of list) {
    if (o.file) {
      try {
        if (statSync(o.file).size > MAX_SPEC) continue;
        const api = parseSpec(readFileSync(o.file, 'utf8'));
        if (api) return { api, from: basename(o.file) };
      } catch {
        /* moved or unreadable: try the next one */
      }
    } else if (o.url) {
      const api = await fetchSpec(o.url, s.id);
      if (api) return { api, from: o.url };
    }
  }
  return null;
}

/** Any framework: the first OpenAPI document one of the site's addresses answers with (chosen app, API apps, site). */
async function servedSpec(s: DevCatzSite, app: DevCatzApp | null): Promise<{ api: Parsed; from: string } | null> {
  const bases = [...new Set([app?.url, ...s.apps.filter((a) => a.kind === 'api').map((a) => a.url), s.url].filter((u): u is string => !!u).map((u) => u.replace(/\/+$/, '')))];
  for (const b of bases)
    for (const p of OPENAPI_PATHS) {
      const api = await fetchSpec(`${b}${p}`, s.id);
      if (api) return { api, from: `${b}${p}` };
    }
  return null;
}

/** A collection of the site's routes: Laravel's route list, else the site's OpenAPI document (bridge file or served). */
export async function routes(s: DevCatzSite, dir?: string): Promise<{ root: TreeItem; items: TreeItem[]; source: string }> {
  const app = pickApp(s, dir);
  const base = baseUrl(s, dir);
  const name = app && s.apps.filter((a) => a.kind !== 'assets').length > 1 ? `${s.name} · ${appLabel(app)}` : s.name;
  const note = `Imported from DevCatz (${base}).`;
  const laravel = app ? app.framework === 'laravel' : s.framework === 'laravel';
  if (laravel) {
    const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name, sort: 0, auth: { mode: 'none' }, description: note };
    return { root, items: await laravelRoutes(join(s.path, app?.dir ?? '.'), root.id), source: 'artisan route:list' };
  }
  const found = (await bridgeSpec(s, app)) ?? (await servedSpec(s, app));
  if (found) return { root: { ...found.api.root, name, description: `${found.api.root.description ?? ''}\n\n${note}`.trim() }, items: found.api.items, source: `OpenAPI (${found.from})` };
  throw new Error(
    s.running
      ? `${s.name} has no OpenAPI document DialCatz could find (DevCatz found none, and ${base} does not serve one at ${OPENAPI_PATHS.slice(0, 3).join(', ')} …).`
      : `${s.name} has no OpenAPI file DevCatz found, and it is not running. Start it in DevCatz, then import again.`,
  );
}
