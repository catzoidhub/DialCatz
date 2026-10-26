import { hostname } from 'node:os';
import { stripLocalFiles } from '@shared/request';
import { uid, type Environment, type Role, type ServerConnection, type ServerIdentity, type SyncConflict, type TreeItem, type Workspace } from '@shared/types';
import type { components, paths } from './den-api';
import { store } from './store';
import { deleteToken, getToken, setToken } from './secrets';
import * as ws from './workspaces';

/**
 * Connections to DialCatz Den servers and the sync of their workspaces. No login: the token is the member's identity
 * (issued by the server's admin, one per device), kept in the secret store; the server says who it belongs to
 * (GET /api/v1/me). Sync is plain REST with revision numbers:
 *   GET  /api/v1/workspaces/:id/changes?since=N  → { revision, items[] }   (deleted items included)
 *   POST /api/v1/workspaces/:id/push { changes[] } → { revision, applied[], conflicts[] }
 * A change carries the revision it was based on; a newer one on the server is a conflict, solved by keeping both:
 * the server's version wins in place and the local one is kept beside it as "(my copy)".
 * Environments sync names and flags only — variable values stay on this computer.
 * Request / response shapes come from DialCatz Den's openapi.yaml (den-api.ts, `bun run gen:den`).
 */

type Schemas = components['schemas'];
/** The JSON body of a Den endpoint's 200 answer. */
type Ok<P extends keyof paths, M extends 'get' | 'post'> = paths[P][M] extends { responses: { 200: { content: { 'application/json': infer R } } } } ? R : never;
/** `data` is a free-form object in the spec; DialCatz reads the fields it knows. */
type RemoteItem = Omit<Schemas['Item'], 'data'> & { data: Record<string, unknown> };
type Change = Omit<Schemas['Change'], 'data'> & { data: Record<string, unknown> };

const KEY = 'servers';
const TIMEOUT = 20_000;

export function servers(): ServerConnection[] {
  return store.extra<ServerConnection[]>(KEY) ?? [];
}

function saveServers(list: ServerConnection[]): void {
  store.setExtra(KEY, list);
}

function update(id: string, patch: Partial<ServerConnection>): ServerConnection {
  const list = servers();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) throw new Error('That server connection does not exist any more');
  list[i] = { ...list[i], ...patch };
  saveServers(list);
  return list[i];
}

/** https://host[:port][/path] without a trailing slash; http only for local addresses. */
export function normaliseUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[\w-]+\.localhost|[\w.-]+\.test|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)$/i.test(u.hostname);
  if (u.protocol === 'http:' && !local) throw new Error('A DialCatz Den must use https:// (http:// is only allowed for local addresses)');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

async function call<T>(base: string, path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${base} did not answer like a DialCatz Den (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const msg = (json as { error?: string } | null)?.error;
      if (res.status === 401) throw new Error(msg || 'The server did not accept the token (revoked or expired). Ask your admin for a new invite link.');
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return json as T;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`${base} did not answer within ${TIMEOUT / 1000} s`);
    const cause = (e as { cause?: { code?: string } }).cause?.code;
    if (cause === 'ENOTFOUND') throw new Error(`Could not find ${new URL(base).host}`);
    if (cause === 'ECONNREFUSED') throw new Error(`${new URL(base).host} refused the connection`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function probe(url: string): Promise<{ ok: boolean; name?: string; version?: string; error?: string }> {
  try {
    const base = normaliseUrl(url);
    const h = await call<Ok<'/api/health', 'get'>>(base, '/api/health');
    if (h?.name !== 'DialCatz Den') return { ok: false, error: `${base} is not a DialCatz Den` };
    return { ok: true, name: h.name, version: h.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * The member's photo as a data: URL: https only (or the Den itself), an image, at most 512 KB, 8 s. Gravatar answers
 * 404 when there is none, which leaves the initials. Fetched here so the window needs no remote images.
 */
async function fetchAvatar(url: string | undefined, base: string): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const u = new URL(url, base);
    if (u.protocol !== 'https:' && u.origin !== new URL(base).origin) return undefined;
    const res = await fetch(u, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 512 * 1024) return undefined;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

async function finishConnect(base: string, token: string, identity: ServerIdentity): Promise<ServerConnection> {
  const list = servers();
  // The same member on the same server again (a new device token): replace that connection.
  const existing = list.find((s) => s.url === base && s.identity?.member.id === identity.member.id);
  const id = existing?.id ?? uid('s');
  await setToken(id, token);
  const conn: ServerConnection = { id, url: base, identity, workspaceIds: existing?.workspaceIds ?? identity.workspaces.map((w) => w.id), connectedAt: new Date().toISOString(), avatar: await fetchAvatar(identity.member.avatarUrl, base) };
  saveServers([...list.filter((s) => s.id !== id), conn]);
  ensureLocalWorkspaces(conn);
  return conn;
}

export async function connectWithToken(url: string, token: string): Promise<ServerConnection> {
  const base = normaliseUrl(url);
  const t = token.trim();
  if (!/^dct_[A-Za-z0-9_-]{20,}$/.test(t)) throw new Error('That does not look like a DialCatz token (they start with dct_)');
  const identity = await call<Ok<'/api/v1/me', 'get'>>(base, '/api/v1/me', { token: t });
  return finishConnect(base, t, identity);
}

export async function connectWithCode(url: string, code: string, device: string): Promise<ServerConnection> {
  const base = normaliseUrl(url);
  const r = await call<Ok<'/api/v1/connect', 'post'>>(base, '/api/v1/connect', { method: 'POST', body: { code: code.trim(), device: device.trim().slice(0, 80) || hostname() } });
  return finishConnect(base, r.token, r.identity);
}

export async function refresh(id: string): Promise<ServerConnection> {
  const s = servers().find((x) => x.id === id);
  if (!s) throw new Error('That server connection does not exist any more');
  try {
    const identity = await call<Ok<'/api/v1/me', 'get'>>(s.url, '/api/v1/me', { token: await getToken(id) });
    const conn = update(id, { identity, lastError: undefined, avatar: identity.member.avatarUrl === s.identity?.member.avatarUrl && s.avatar ? s.avatar : await fetchAvatar(identity.member.avatarUrl, s.url) });
    ensureLocalWorkspaces(conn);
    return conn;
  } catch (e) {
    return update(id, { lastError: (e as Error).message });
  }
}

export async function disconnect(id: string): Promise<void> {
  for (const w of ws.list()) if (w.serverId === id) ws.remove(w.id);
  await deleteToken(id);
  saveServers(servers().filter((s) => s.id !== id));
}

export function subscribe(serverId: string, workspaceId: string, on: boolean): ServerConnection {
  const s = servers().find((x) => x.id === serverId);
  if (!s) throw new Error('That server connection does not exist any more');
  const ids = new Set(s.workspaceIds);
  if (on) ids.add(workspaceId);
  else ids.delete(workspaceId);
  const conn = update(serverId, { workspaceIds: [...ids] });
  ensureLocalWorkspaces(conn);
  return conn;
}

/** A local copy for every subscribed workspace the token grants; copies of ones no longer granted go. */
function ensureLocalWorkspaces(conn: ServerConnection): void {
  const granted = new Map((conn.identity?.workspaces ?? []).map((w) => [w.id, w]));
  const local = ws.list().filter((w) => w.serverId === conn.id);
  for (const l of local) {
    const g = l.remoteId ? granted.get(l.remoteId) : undefined;
    if (!g || !conn.workspaceIds.includes(g.id)) ws.remove(l.id);
    else if (g.name !== l.name || g.role !== l.role) ws.save({ ...ws.load(l.id), name: g.name, role: g.role });
  }
  for (const g of granted.values()) {
    if (!conn.workspaceIds.includes(g.id) || local.some((l) => l.remoteId === g.id)) continue;
    ws.create(g.name, { serverId: conn.id, remoteId: g.id, role: g.role });
  }
}

// ------------------------------------------------------------------ sync


function itemToChange(i: TreeItem): Change {
  return { id: i.id, kind: i.kind, parentId: i.parentId, name: i.name, sort: i.sort, data: { request: stripLocalFiles(i.request), auth: i.auth, description: i.description, ...(i.insecure ? { insecure: true } : {}), ...(i.environmentId !== undefined ? { environmentId: i.environmentId } : {}), ...(i.preRequest ? { preRequest: i.preRequest } : {}), ...(i.tests ? { tests: i.tests } : {}) }, deleted: false, baseRevision: i.rev ?? 0 };
}
function envToChange(e: Environment): Change {
  return { id: e.id, kind: 'environment', parentId: null, name: e.name, sort: 0, data: { variables: e.variables.map((v) => ({ key: v.key, enabled: v.enabled, secret: v.secret })), ...(e.shared ? { shared: e.shared } : {}) }, deleted: false, baseRevision: e.rev ?? 0 };
}

/** Applies a server item to the local copy (environments keep their local values by name). */
function applyRemote(w: Workspace, r: RemoteItem): void {
  if (r.kind === 'environment') {
    const i = w.environments.findIndex((e) => e.id === r.id);
    if (r.deleted) {
      if (i >= 0) w.environments.splice(i, 1);
      if (w.activeEnvironmentId === r.id) w.activeEnvironmentId = null;
      return;
    }
    const local = i >= 0 ? w.environments[i] : null;
    const vars = ((r.data.variables as { key: string; enabled: boolean; secret: boolean }[]) ?? []).map((v) => ({ ...v, value: local?.variables.find((l) => l.key === v.key)?.value ?? '' }));
    const shared = r.data.shared as Environment['shared'] | undefined;
    const env: Environment = { id: r.id, name: r.name, variables: vars, shared: shared && typeof shared === 'object' && shared.values ? shared : undefined, rev: r.revision, dirty: false };
    if (i >= 0) w.environments[i] = env;
    else w.environments.push(env);
    return;
  }
  const i = w.items.findIndex((x) => x.id === r.id);
  if (r.deleted) {
    if (i >= 0) w.items.splice(i, 1);
    return;
  }
  const item: TreeItem = {
    id: r.id,
    kind: r.kind,
    parentId: r.parentId,
    name: r.name,
    sort: r.sort,
    // A file a teammate picked is a path on their computer: never one to read here. Keep the one picked locally.
    request: keepLocalFiles(stripLocalFiles(r.data.request as TreeItem['request']), i >= 0 ? w.items[i].request : undefined),
    auth: r.data.auth as TreeItem['auth'],
    description: r.data.description as string | undefined,
    ...(r.data.insecure === true ? { insecure: true } : {}),
    ...(typeof r.data.preRequest === 'string' && r.data.preRequest ? { preRequest: r.data.preRequest } : {}),
    ...(typeof r.data.tests === 'string' && r.data.tests ? { tests: r.data.tests } : {}),
    ...(typeof r.data.environmentId === 'string' || r.data.environmentId === null ? { environmentId: r.data.environmentId as string | null } : {}),
    // "Check in DBCatz" settings belong to this computer: keep them.
    ...(i >= 0 && w.items[i].database ? { database: w.items[i].database } : {}),
    ...(i >= 0 && w.items[i].dbTable ? { dbTable: w.items[i].dbTable } : {}),
    rev: r.revision,
    dirty: false,
    updatedBy: r.updatedBy?.name,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
  if (i >= 0) w.items[i] = item;
  else w.items.push(item);
}

/** Puts back the files this computer picked for the same fields (matched by key). */
function keepLocalFiles(spec: TreeItem['request'], local: TreeItem['request']): TreeItem['request'] {
  if (!spec?.body || !local?.body) return spec;
  return {
    ...spec,
    body: { ...spec.body, file: spec.body.mode === 'binary' ? local.body.file : undefined, fields: spec.body.fields.map((f) => (f.type === 'file' ? { ...f, src: local.body.fields.find((l) => l.key === f.key && l.type === 'file')?.src } : f)) },
  };
}

/**
 * One sync per workspace at a time: a sync asked for while one runs waits and runs once after it (two asks in a
 * row become one). Two at once would push the same changes twice and see their own second push as a conflict.
 */
const running = new Map<string, Promise<Workspace>>();
const queued = new Map<string, Promise<Workspace>>();
export function sync(workspaceId: string): Promise<Workspace> {
  const cur = running.get(workspaceId);
  if (!cur) {
    const p = syncNow(workspaceId).finally(() => running.get(workspaceId) === p && running.delete(workspaceId));
    running.set(workspaceId, p);
    return p;
  }
  const waiting = queued.get(workspaceId);
  if (waiting) return waiting;
  const next = cur
    .catch(() => undefined)
    .then(() => {
      queued.delete(workspaceId);
      return sync(workspaceId);
    });
  queued.set(workspaceId, next);
  return next;
}

async function syncNow(workspaceId: string): Promise<Workspace> {
  let w = ws.load(workspaceId);
  if (!w.serverId || !w.remoteId) return w;
  const s = servers().find((x) => x.id === w.serverId);
  if (!s) throw new Error('This workspace’s server connection was removed');
  const token = await getToken(s.id);
  const base = `/api/v1/workspaces/${encodeURIComponent(w.remoteId)}`;
  try {
    // 1. Pull. Local unsent changes win over what comes in for now; the push below settles them.
    const pulled = await call<Omit<Ok<'/api/v1/workspaces/{id}/changes', 'get'>, 'items'> & { items: RemoteItem[] }>(s.url, `${base}/changes?since=${w.revision ?? 0}`, { token });
    w = ws.load(workspaceId);
    const dirtyIds = new Set([...w.items.filter((i) => i.dirty).map((i) => i.id), ...w.environments.filter((e) => e.dirty).map((e) => e.id), ...(w.deleted ?? [])]);
    for (const r of pulled.items) if (!dirtyIds.has(r.id)) applyRemote(w, r);
    w.revision = pulled.revision;
    ws.save(w);

    // 2. Push (not for viewers).
    if (w.role !== 'viewer') {
      const changes: Change[] = [
        ...w.items.filter((i) => i.dirty).map(itemToChange),
        ...w.environments.filter((e) => e.dirty).map(envToChange),
        ...(w.deleted ?? []).map((id) => {
          const kind = pulled.items.find((r) => r.id === id)?.kind ?? 'request';
          return { id, kind, parentId: null, name: '', sort: 0, data: {}, deleted: true, baseRevision: Number.MAX_SAFE_INTEGER } satisfies Change;
        }),
      ];
      if (changes.length) {
        const pushed = await call<{ revision: number; applied: { id: string; revision: number }[]; conflicts: { id: string; server: RemoteItem | null }[] }>(s.url, `${base}/push`, { method: 'POST', token, body: { changes } });
        w = ws.load(workspaceId);
        for (const a of pushed.applied) {
          const it = w.items.find((i) => i.id === a.id);
          if (it) Object.assign(it, { rev: a.revision, dirty: false });
          const env = w.environments.find((e) => e.id === a.id);
          if (env) Object.assign(env, { rev: a.revision, dirty: false });
        }
        for (const c of pushed.conflicts) {
          const mine = w.items.find((i) => i.id === c.id);
          const env = w.environments.find((e) => e.id === c.id);
          if (mine && mine.kind === 'request' && c.server && !c.server.deleted) {
            // Keep both: my version of a request becomes a new one next to the server's.
            w.items.push({ ...mine, id: uid('r_'), name: `${mine.name} (my copy)`, rev: 0, dirty: true });
          } else if ((mine && mine.kind !== 'request') || env) {
            // Folders, collections and environments: theirs wins, mine waits in a note (TODO #41).
            noteConflict(w, mine ?? env!, c.server);
          }
          if (env) env.dirty = false;
          if (mine) mine.dirty = false;
          if (c.server) applyRemote(w, c.server);
        }
        const pushedDeletes = new Set(changes.filter((c) => c.deleted).map((c) => c.id));
        w.deleted = (w.deleted ?? []).filter((id) => !pushedDeletes.has(id));
        // Only move forward when nobody else wrote in between; otherwise the next pull picks their changes up.
        if (pushed.revision === (w.revision ?? 0) + pushed.applied.length) w.revision = pushed.revision;
      }
    }
    w.syncedAt = new Date().toISOString();
    w.syncError = undefined;
    return ws.save(w);
  } catch (e) {
    w = ws.load(workspaceId);
    w.syncError = (e as Error).message;
    return ws.save(w);
  }
}

/** What differs between my folder / collection / environment and the server's copy, in words for the note. */
function differences(mine: TreeItem | Environment, theirs: RemoteItem | null): string[] {
  if (!theirs || theirs.deleted) return ['deleted'];
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (mine.name !== theirs.name) out.push('name');
  if ('kind' in mine) {
    if ((mine.parentId ?? null) !== (theirs.parentId ?? null)) out.push('place');
    if (!same(mine.auth, theirs.data.auth)) out.push('auth');
    if (!same(mine.description, theirs.data.description)) out.push('notes');
    if (!same(mine.insecure ?? null, theirs.data.insecure ?? null) || !same(mine.environmentId ?? null, theirs.data.environmentId ?? null)) out.push('settings');
    if (!same(mine.preRequest || null, theirs.data.preRequest || null) || !same(mine.tests || null, theirs.data.tests || null)) out.push('scripts');
  } else {
    const names = (l: { key: string }[] | undefined) => (l ?? []).map((v) => v.key).join('\n');
    if (names(mine.variables) !== names(theirs.data.variables as { key: string }[] | undefined)) out.push('variables');
    if (!same(mine.shared ?? null, theirs.data.shared ?? null)) out.push('shared values');
  }
  return out.length ? out : ['order'];
}

/** Keeps my overruled version of a folder, collection or environment for the note (one per item, the latest). */
function noteConflict(w: Workspace, mine: TreeItem | Environment, theirs: RemoteItem | null): void {
  const kind = 'kind' in mine ? (mine.kind as 'collection' | 'folder') : 'environment';
  const note: SyncConflict = {
    id: mine.id,
    kind,
    name: mine.name,
    by: theirs?.updatedBy?.name ?? null,
    at: theirs ? new Date(theirs.updatedAt).toISOString() : null,
    fields: differences(mine, theirs),
    mine: JSON.parse(JSON.stringify({ ...mine, dirty: false })),
    rev: theirs?.revision,
  };
  w.conflicts = [...(w.conflicts ?? []).filter((x) => x.id !== mine.id), note];
}

/** Settles a conflict: 'mine' puts my version back (on top of theirs) and pushes it; 'theirs' drops the note. */
export async function resolveConflict(workspaceId: string, itemId: string, keep: 'mine' | 'theirs'): Promise<Workspace> {
  let w = ws.load(workspaceId);
  const c = (w.conflicts ?? []).find((x) => x.id === itemId);
  if (!c) return w;
  w.conflicts = (w.conflicts ?? []).filter((x) => x.id !== itemId);
  if (keep === 'mine') {
    if (c.kind === 'environment') {
      const cur = w.environments.find((e) => e.id === c.id);
      const mine = c.mine as Environment;
      // Values are mine anyway (they never sync): only the names / shared values go back.
      const next: Environment = { ...mine, rev: Math.max(cur?.rev ?? 0, c.rev ?? 0), dirty: true };
      w.environments = cur ? w.environments.map((e) => (e.id === c.id ? next : e)) : [...w.environments, next];
    } else {
      const cur = w.items.find((i) => i.id === c.id);
      const mine = c.mine as TreeItem;
      // Deleted by a teammate: it comes back on top of their delete (the server's revision), under its old parent
      // when that still exists.
      const parentOk = !mine.parentId || w.items.some((i) => i.id === mine.parentId);
      const next: TreeItem = { ...mine, parentId: parentOk ? mine.parentId : null, rev: Math.max(cur?.rev ?? 0, c.rev ?? 0), dirty: true };
      w.items = cur ? w.items.map((i) => (i.id === c.id ? next : i)) : [...w.items, next];
    }
  }
  w = ws.save(w);
  return keep === 'mine' ? sync(workspaceId) : w;
}

/** Every team workspace, one after the other. */
export async function syncAll(): Promise<void> {
  for (const w of ws.list()) if (w.serverId) await sync(w.id).catch(() => undefined);
}

export type { Role };
