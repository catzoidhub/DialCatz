import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { MockState, TreeItem } from '@shared/types';
import { matchRoute, methodsOn, mockBody, pickResponse, preferredCode, routePath, type MockRoute } from '@shared/specmock';
import { setBridgeMocks } from './bridge';

/**
 * Mock servers made from a collection's spec (#94): one per collection, on 127.0.0.1 only, for as long as DialCatz
 * runs (or until stopped). Every request of the collection that carries the spec's responses (#93) is answered with
 * the spec's example, else a body made from its schema; `Prefer: code=404` picks another of its responses. The
 * collection is read again on every call, so edits and spec updates show at once. CORS is open, so a frontend in a
 * browser can call it. Running mocks are listed in bridge.json for DevCatz.
 */

interface Running {
  server: Server;
  state: MockState;
  startedAt: number;
}

const running = new Map<string, Running>();
const key = (workspaceId: string, collectionId: string) => `${workspaceId}:${collectionId}`;
const FIRST_PORT = 4010; // Prism's, so a frontend set up for a mock already points here
/** Mocks stay below 4100, where DevCatz starts handing its sites ports. */
const LAST_PORT = 4099;
const HITS = 50;

/** The ids of a collection and everything in it. */
function under(items: TreeItem[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) (ids.add(i.id), (grew = true));
  }
  return ids;
}

/** The requests of a collection the mock can answer. */
export function routesOf(items: TreeItem[], collectionId: string): MockRoute[] {
  const ids = under(items, collectionId);
  return items.filter((i) => ids.has(i.id) && i.kind === 'request' && i.request && i.specResponses?.length).map((i) => ({ method: i.request!.method, path: routePath(i.request!.url), name: i.name, responses: i.specResponses! }));
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mock';

function publish(): void {
  setBridgeMocks([...running.values()].map((r) => ({ name: r.state.name, slug: slug(r.state.name), workspaceId: r.state.workspaceId, collectionId: r.state.collectionId, url: r.state.url, port: r.state.port, startedAt: r.startedAt, ...(r.state.siteId ? { siteId: r.state.siteId, specFile: r.state.specFile } : {}), ...(r.state.docatzOf ? { docatz: r.state.docatzOf } : {}) })));
}

function cors(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value, null, 2));
}

type Load = () => { items: TreeItem[]; name: string } | null;

function handler(r: { state: MockState }, load: Load) {
  return (req: IncomingMessage, res: ServerResponse) => {
    req.resume(); // the body is not read: a mock answers the same whatever is sent
    const method = (req.method ?? 'GET').toUpperCase();
    const path = (req.url ?? '/').split('?')[0];
    const hit = (status: number, route: string | null) => {
      r.state.hits.unshift({ at: Date.now(), method, path, status, route });
      r.state.hits.length = Math.min(r.state.hits.length, HITS);
    };
    cors(req, res);
    if (method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.statusCode = 204;
      res.end();
      return;
    }
    const w = load();
    if (!w) {
      hit(410, null);
      return json(res, 410, { error: 'This collection is gone from DialCatz' });
    }
    r.state.name = w.name;
    const routes = routesOf(w.items, r.state.collectionId);
    r.state.routes = routes.length;
    const route = matchRoute(routes, method, path);
    if (!route) {
      const allowed = methodsOn(routes, path);
      const status = allowed.length ? 405 : 404;
      if (allowed.length) res.setHeader('Allow', allowed.join(', '));
      hit(status, null);
      return json(res, status, { error: `“${w.name}” has no ${allowed.length ? `${method} request for` : 'request for'} ${path}`, ...(allowed.length ? { allowed } : {}), routes: routes.slice(0, 100).map((x) => `${x.method} ${x.path}`) });
    }
    const picked = pickResponse(route.responses, preferredCode(req.headers.prefer as string | undefined))!;
    const out = mockBody(picked.response);
    res.statusCode = picked.status;
    if (out.contentType) res.setHeader('Content-Type', out.contentType);
    res.setHeader('X-DialCatz-Mock', encodeURIComponent(route.name));
    hit(picked.status, route.name);
    res.end(method === 'HEAD' || picked.status === 204 || picked.status === 304 ? undefined : out.body);
  };
}

/**
 * Something answers on the port already (a container publishing it on every address, another server): binding
 * 127.0.0.1 could still succeed beside it, so it is skipped.
 */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (v: boolean) => (s.destroy(), resolve(v));
    s.setTimeout(300, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const fail = (e: Error) => (server.off('listening', ok), reject(e));
    const ok = () => (server.off('error', fail), resolve((server.address() as AddressInfo).port));
    server.once('error', fail);
    server.once('listening', ok);
    server.listen(port, '127.0.0.1');
  });
}

/** Starts the collection's mock (or gives the running one). `port`: that port only; none: 4010 and up. */
export async function start(workspaceId: string, collectionId: string, name: string, load: Load, port?: number, meta?: { siteId?: string; specFile?: string; docatz?: MockState['docatzOf'] } | null, reserved: Set<number> = new Set()): Promise<MockState> {
  const k = key(workspaceId, collectionId);
  const have = running.get(k);
  if (have) return have.state;
  const w = load();
  if (!w) throw new Error('That collection is gone');
  const routes = routesOf(w.items, collectionId).length;
  if (!routes) throw new Error(`No request in “${name}” has responses from a spec yet. Import it from an OpenAPI document, or use Spec → Check for changes once to bring them in.`);
  const r: Running = { server: createServer(), state: { workspaceId, collectionId, name, url: '', port: 0, routes, hits: [], ...(meta?.siteId ? { siteId: meta.siteId, specFile: meta.specFile } : {}), ...(meta?.docatz ? { docatzOf: meta.docatz } : {}) }, startedAt: Date.now() };
  r.server.on('request', handler(r, load));
  let got = 0;
  if (port) {
    if (reserved.has(port)) throw new Error(`Port ${port} belongs to DevCatz or DoCatz. Pick another, or leave it empty for a free one.`);
    if (await answers(port)) throw new Error(`Something already answers on port ${port}. Pick another, or leave it empty for a free one.`);
    try {
      got = await listen(r.server, port);
    } catch (e) {
      throw new Error((e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${port} is in use. Pick another, or leave it empty for a free one.` : (e as Error).message);
    }
  } else {
    // Free now is not enough: a port DevCatz gave a stopped site would clash the moment that site starts.
    const taken = new Set([...running.values()].map((x) => x.state.port));
    for (const p of reserved) taken.add(p);
    for (let p = FIRST_PORT; p <= LAST_PORT && !got; p++) {
      if (taken.has(p) || (await answers(p))) continue;
      got = await listen(r.server, p).catch(() => 0);
    }
    if (!got) got = await listen(r.server, 0);
  }
  r.state.port = got;
  r.state.url = `http://127.0.0.1:${got}`;
  running.set(k, r);
  publish();
  return r.state;
}

export async function stop(workspaceId: string, collectionId: string): Promise<void> {
  const k = key(workspaceId, collectionId);
  const r = running.get(k);
  if (!r) return;
  running.delete(k);
  publish();
  await new Promise<void>((resolve) => {
    r.server.close(() => resolve());
    r.server.closeAllConnections();
  });
}

export const list = (): MockState[] => [...running.values()].map((r) => ({ ...r.state, hits: [...r.state.hits] }));

/** On quit: nothing left listening, nothing left in bridge.json. */
export function stopAll(): void {
  for (const r of running.values()) r.server.close();
  running.clear();
  publish();
}
