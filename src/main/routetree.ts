import { newRequest, uid, type HttpMethod, type TreeItem } from '@shared/types';

/** One line of a framework's route list. */
export interface ListedRoute {
  /** Methods joined by | (GET|HEAD). */
  method: string;
  uri: string;
  name: string | null;
  action: string;
  middleware?: string[];
}

/** `artisan route:list --json` output as requests (from DevCatz's PHP, or inside a DoCatz container). */
export function laravelTree(out: string, collectionId: string): TreeItem[] {
  return routesTree(JSON.parse(out.slice(out.indexOf('['))) as ListedRoute[], collectionId);
}

/**
 * Routes as requests: closures and framework internals skipped, split by route file — an "api" folder (the api middleware
 * group, or /api/…) and a "web" folder, when there are both — each grouped by its first path segment.
 */
export function routesTree(routes: ListedRoute[], collectionId: string): TreeItem[] {
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

const HTTP = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)(\|(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS))*$/;

/**
 * What Goravel's `artisan route:list` prints, which has no --json: `GET|HEAD  users/{id} .... name › handler`. STATIC
 * lines serve files, and the Showing line is a count. Colours are stripped whatever the program was asked.
 */
export function parseGoravelRoutes(text: string): ListedRoute[] {
  const out: ListedRoute[] = [];
  for (const raw of text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z|]+)\s+(\S+)\s*\.*\s*(.*?)\s*$/);
    if (!m || !HTTP.test(m[1])) continue;
    const [name, action] = m[3].includes('›') ? m[3].split('›').map((x) => x.trim()) : [null, m[3]];
    out.push({ method: m[1], uri: m[2], name: name || null, action: action ?? '' });
  }
  return out;
}

/** What starts an image from source, where no built program exists: there the route list comes from `go run`. */
const FROM_SOURCE = new Set(['go', 'air', 'gow', 'reflex', 'modd', 'realize', 'dlv', 'task', 'make', 'sh', 'bash', 'ash', 'dash']);
const SHELLS = new Set(['sh', 'bash', 'ash', 'dash']);

/** The command listing a Goravel container's routes, from its image's entrypoint and command. */
export function goravelCommand(entrypoint: string[] | null, cmd: string[] | null): string[] {
  const args = ['artisan', 'route:list', '--no-ansi'];
  const all = [...(entrypoint ?? []), ...(cmd ?? [])];
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
  // sh -c /www/main: the program is the one word it runs.
  if (SHELLS.has(base(all[0] ?? '')) && all[1] === '-c' && /^\S+$/.test(all[2] ?? '') && !FROM_SOURCE.has(base(all[2]))) return [all[2], ...args];
  if (!all.length || FROM_SOURCE.has(base(all[0]))) return ['go', 'run', '.', ...args];
  return [all[0], ...args];
}
