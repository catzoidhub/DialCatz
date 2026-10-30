import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { emptyEnvLayout, emptyLayout, newRequest, uid, type Environment, type HttpMethod, type SidebarLayout, type EnvLayout, type EnvVariable, type TreeItem, type Workspace, type WorkspaceSummary } from '@shared/types';
import { dataDir } from './store';
import * as folders from './folders';

/**
 * Workspaces on disk: one JSON file each in <userData>/workspaces/, written atomically (tmp + rename). Personal
 * workspaces live only here; team workspaces are a local copy of a server's workspace plus unsent changes
 * (sync.ts). Every change to a team item marks it dirty so the next sync pushes it. A folder workspace (git sharing,
 * folders.ts) also writes its collections and environment names into its folder on every save, and reads the folder
 * back when it is opened or changed from outside; this file keeps what stays on this computer (values, layout).
 */

const dir = () => dataDir('workspaces');
const file = (id: string) => {
  if (!/^[\w-]+$/.test(id)) throw new Error(`Bad workspace id ${id}`);
  return join(dir(), `${id}.json`);
};

const cache = new Map<string, Workspace>();

function normalise(w: Partial<Workspace> & { id: string }): Workspace {
  return {
    id: w.id,
    name: w.name || 'Workspace',
    serverId: w.serverId ?? null,
    remoteId: w.remoteId,
    role: w.role,
    items: Array.isArray(w.items) ? w.items : [],
    layout: cleanLayout(w.layout),
    environments: Array.isArray(w.environments) ? w.environments : [],
    activeEnvironmentId: w.activeEnvironmentId ?? null,
    globals: Array.isArray(w.globals) ? w.globals : [],
    revision: w.revision ?? 0,
    deleted: w.deleted ?? [],
    syncedAt: w.syncedAt,
    syncError: w.syncError,
    conflicts: Array.isArray(w.conflicts) ? w.conflicts : [],
    ...(w.folder ? { folder: w.folder } : {}),
  };
}

function cleanLayout(l: Partial<SidebarLayout> | undefined): SidebarLayout {
  const e = emptyLayout();
  if (!l || typeof l !== 'object') return e;
  const str = (v: unknown) => String(v ?? '').slice(0, 120);
  return {
    groups: Array.isArray(l.groups) ? l.groups.filter((g) => g && g.id).map((g) => ({ id: str(g.id), name: str(g.name) || 'Group' })) : e.groups,
    groupOf: l.groupOf && typeof l.groupOf === 'object' ? Object.fromEntries(Object.entries(l.groupOf).map(([k, v]) => [str(k), str(v)])) : e.groupOf,
    favorites: Array.isArray(l.favorites) ? [...new Set(l.favorites.map(str))] : e.favorites,
    collapsed: Array.isArray(l.collapsed) ? [...new Set(l.collapsed.map(str))] : e.collapsed,
    sortBy: l.sortBy === 'name' ? 'name' : 'default',
    env: cleanEnvLayout(l.env),
  };
}

function cleanEnvLayout(l: Partial<EnvLayout> | undefined): EnvLayout {
  const e = emptyEnvLayout();
  if (!l || typeof l !== 'object') return e;
  const str = (v: unknown) => String(v ?? '').slice(0, 120);
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(str))] : []);
  return {
    groups: Array.isArray(l.groups) ? l.groups.filter((g) => g && g.id).map((g) => ({ id: str(g.id), name: str(g.name) || 'Group' })) : e.groups,
    groupOf: l.groupOf && typeof l.groupOf === 'object' ? Object.fromEntries(Object.entries(l.groupOf).map(([k, v]) => [str(k), str(v)])) : e.groupOf,
    favorites: ids(l.favorites),
    collapsed: ids(l.collapsed),
    order: ids(l.order),
    sortBy: l.sortBy === 'name' ? 'name' : 'default',
  };
}

export function saveLayout(id: string, layout: SidebarLayout): Workspace {
  const w = load(id);
  const l = cleanLayout(layout);
  // Drop what points at things that are gone.
  const ids = new Set(w.items.map((i) => i.id));
  const groups = new Set(l.groups.map((g) => g.id));
  l.groupOf = Object.fromEntries(Object.entries(l.groupOf).filter(([c, g]) => ids.has(c) && groups.has(g)));
  l.favorites = l.favorites.filter((f) => ids.has(f));
  const envIds = new Set(w.environments.map((e) => e.id));
  const envGroups = new Set(l.env!.groups.map((g) => g.id));
  l.env!.groupOf = Object.fromEntries(Object.entries(l.env!.groupOf).filter(([e, g]) => envIds.has(e) && envGroups.has(g)));
  l.env!.favorites = l.env!.favorites.filter((f) => envIds.has(f));
  l.env!.order = l.env!.order.filter((f) => envIds.has(f));
  w.layout = l;
  return save(w);
}

export function load(id: string): Workspace {
  const hit = cache.get(id);
  if (hit) return hit;
  const f = file(id);
  if (!existsSync(f)) throw new Error('That workspace does not exist any more');
  let w = normalise(JSON.parse(readFileSync(f, 'utf8')));
  if (w.folder) w = fromFolder(w);
  cache.set(id, w);
  return w;
}

/** This computer's copy (values, layout, the last known items) — without touching a workspace folder. */
function writeLocal(w: Workspace): Workspace {
  const f = file(w.id);
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(w, null, 1), { mode: 0o600 });
  renameSync(tmp, f);
  cache.set(w.id, w);
  return w;
}

export function save(w: Workspace): Workspace {
  if (w.folder) {
    if (!folderThere(w.folder)) w.folderError = `The folder ${w.folder} is not there any more. Changes stay on this computer until it is back.`;
    else if (w.folderError?.startsWith(UNREADABLE)) {
      // A file DialCatz cannot read (a merge conflict, a typo) is not in the workspace: writing now would delete it.
      // Nothing goes to the folder until the files read again.
    } else {
      try {
        folders.quiet(w.id);
        folders.writeFolder(w.folder, w);
        if (w.folderError?.startsWith('The folder ') || w.folderError?.startsWith('Could not write')) w.folderError = undefined;
      } catch (e) {
        w.folderError = `Could not write to ${w.folder}: ${(e as Error).message}`;
      }
    }
  }
  return writeLocal(w);
}

// ------------------------------------------------------------------ folder workspaces (git sharing)

const folderThere = (dir: string) => existsSync(dir) && statSync(dir).isDirectory();
const UNREADABLE = folders.UNREADABLE;
let folderListener: (id: string) => void = () => undefined;
/** Called after a workspace folder changed from outside (the window reloads that workspace). */
export function onFolderChange(fn: (id: string) => void): void {
  folderListener = fn;
}

/** The folder's content into the workspace (on open), and a watch on it. */
function fromFolder(w: Workspace): Workspace {
  const dir = w.folder!;
  if (!folderThere(dir)) return { ...w, folderError: `The folder ${dir} is not there any more. Changes stay on this computer until it is back.` };
  folders.watchFolder(w.id, dir, () => folderChanged(w.id));
  if (!folders.isWorkspaceFolder(dir)) return w;
  return folders.mergeFolder(w, folders.readFolder(dir));
}

/** Edits from outside (git pull, an editor): read the folder again; true when anything changed. */
export function folderChanged(id: string): boolean {
  const w = cache.get(id);
  if (!w?.folder || !folderThere(w.folder) || !folders.isWorkspaceFolder(w.folder)) return false;
  const next = folders.mergeFolder(w, folders.readFolder(w.folder));
  if (folders.fingerprint(next) === folders.fingerprint(w) && next.folderError === w.folderError) return false;
  writeLocal(next);
  folderListener(id);
  return true;
}

/** Opens a folder as a workspace: the one it already is here, a DialCatz folder from elsewhere, or a new empty one. */
export function openFolder(dir: string): Workspace {
  const path = resolve(dir);
  mkdirSync(path, { recursive: true });
  const known = list().find((s) => s.folder && resolve(s.folder) === path);
  if (known) return load(known.id);
  const fresh = folders.isWorkspaceFolder(path) ? folders.readFolder(path) : null;
  const w = normalise({ id: uid('w_'), name: fresh?.name || basename(path) || 'Workspace', serverId: null, folder: path });
  if (fresh) {
    const merged = folders.mergeFolder(w, fresh);
    folders.watchFolder(merged.id, path, () => folderChanged(merged.id));
    return writeLocal(merged);
  }
  folders.watchFolder(w.id, path, () => folderChanged(w.id));
  return save(w);
}

/** Moves a personal workspace into a folder: its collections and environment names are written there from now on. */
export function useFolder(id: string, dir: string): Workspace {
  const w = load(id);
  if (w.serverId) throw new Error('A team workspace syncs with its DialCatz Den; make a personal workspace for a folder');
  const path = resolve(dir);
  if (folders.isWorkspaceFolder(path)) throw new Error('That folder already holds a DialCatz workspace: open it with “Open a folder…” instead');
  mkdirSync(path, { recursive: true });
  if (list().some((s) => s.folder && resolve(s.folder) === path)) throw new Error('Another workspace already uses that folder');
  w.folder = path;
  w.folderError = undefined;
  folders.watchFolder(w.id, path, () => folderChanged(w.id));
  return save(w);
}

/** Stops writing to the folder (its files stay as they are); the workspace becomes an ordinary personal one. */
export function stopUsingFolder(id: string): Workspace {
  const w = load(id);
  folders.stopWatching(id);
  delete w.folder;
  delete w.folderError;
  return writeLocal(w);
}

export function list(): WorkspaceSummary[] {
  const out: WorkspaceSummary[] = [];
  for (const name of readdirSync(dir())) {
    if (!name.endsWith('.json')) continue;
    try {
      const w = load(name.slice(0, -5));
      out.push({ id: w.id, name: w.name, serverId: w.serverId, remoteId: w.remoteId, role: w.role, ...(w.folder ? { folder: w.folder } : {}) });
    } catch (e) {
      console.warn(`Workspace ${name} could not be read:`, (e as Error).message);
    }
  }
  // Personal first, then team ones, by name.
  return out.sort((a, b) => Number(!!a.serverId) - Number(!!b.serverId) || a.name.localeCompare(b.name));
}

export function create(name: string, team?: { serverId: string; remoteId: string; role: Workspace['role'] }): Workspace {
  const id = team ? `t_${team.serverId}_${team.remoteId}`.replace(/[^\w-]/g, '_') : uid('w_');
  const w = normalise({ id, name: name.trim().slice(0, 120) || 'Workspace', serverId: team?.serverId ?? null, remoteId: team?.remoteId, role: team?.role });
  return save(w);
}

export function remove(id: string): void {
  // A folder workspace's files stay where they are: only this computer's copy goes.
  folders.stopWatching(id);
  cache.delete(id);
  const f = file(id);
  if (existsSync(f)) unlinkSync(f);
}

/** Viewers of a team workspace cannot change it. */
function writable(w: Workspace): void {
  if (w.serverId && w.role === 'viewer') throw new Error('You can view this team workspace but not change it (your role is Viewer)');
}

const now = () => new Date().toISOString();

/**
 * "Check in DBCatz" settings: the collection's database and the request's table. Local to this computer, so they
 * neither mark the items as changed nor need write access to a team workspace.
 */
export function saveDbTarget(id: string, collectionId: string, database: { conn: string; db: string }, requestId: string | null, table: string | null): Workspace {
  const w = load(id);
  const col = w.items.find((i) => i.id === collectionId && i.kind === 'collection');
  if (!col) throw new Error('No such collection');
  const conn = String(database?.conn ?? '').slice(0, 200);
  col.database = conn ? { conn, db: String(database?.db ?? '').slice(0, 128) } : undefined;
  const req = requestId ? w.items.find((i) => i.id === requestId && i.kind === 'request') : undefined;
  if (req) req.dbTable = table?.trim() ? table.trim().slice(0, 128) : undefined;
  return save(w);
}

export function saveItems(id: string, items: TreeItem[]): Workspace {
  const w = load(id);
  writable(w);
  for (const raw of items) {
    if (!raw.id || !['collection', 'folder', 'request'].includes(raw.kind)) throw new Error('Bad item');
    const prev = w.items.findIndex((i) => i.id === raw.id);
    const item: TreeItem = { ...raw, name: String(raw.name ?? '').slice(0, 200) || 'Untitled', rev: prev >= 0 ? w.items[prev].rev : raw.rev, dirty: !!w.serverId, updatedAt: now() };
    if (prev >= 0) w.items[prev] = item;
    else w.items.push(item);
  }
  return save(w);
}

/** Removes items and everything under them; team ones are remembered for the next push. */
export function deleteItems(id: string, ids: string[]): Workspace {
  const w = load(id);
  writable(w);
  const gone = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const i of w.items) if (!gone.has(i.id) && i.parentId && gone.has(i.parentId)) (gone.add(i.id), (grew = true));
  }
  if (w.serverId) w.deleted = [...new Set([...(w.deleted ?? []), ...w.items.filter((i) => gone.has(i.id) && i.rev).map((i) => i.id)])];
  w.items = w.items.filter((i) => !gone.has(i.id));
  return save(w);
}

export function saveEnvironment(id: string, env: Environment): Workspace {
  const w = load(id);
  const sh = env.shared && w.serverId ? { by: String(env.shared.by).slice(0, 120), byId: String(env.shared.byId), at: String(env.shared.at), values: Object.fromEntries(Object.entries(env.shared.values ?? {}).map(([k, v]) => [String(k).slice(0, 200), String(v)])) } : undefined;
  const e: Environment = { id: env.id || uid('e_'), name: String(env.name ?? '').slice(0, 120) || 'Environment', variables: (env.variables ?? []).map(cleanVar), shared: sh, rev: env.rev, dirty: !!w.serverId && w.role !== 'viewer' };
  const i = w.environments.findIndex((x) => x.id === e.id);
  if (i >= 0) w.environments[i] = { ...e, rev: w.environments[i].rev };
  else w.environments.push(e);
  return save(w);
}

export function deleteEnvironment(id: string, envId: string): Workspace {
  const w = load(id);
  writable(w);
  const env = w.environments.find((e) => e.id === envId);
  if (w.serverId && env?.rev) w.deleted = [...new Set([...(w.deleted ?? []), envId])];
  w.environments = w.environments.filter((e) => e.id !== envId);
  if (w.activeEnvironmentId === envId) w.activeEnvironmentId = null;
  return save(w);
}

export function setActiveEnvironment(id: string, envId: string | null): Workspace {
  const w = load(id);
  w.activeEnvironmentId = envId && w.environments.some((e) => e.id === envId) ? envId : null;
  return save(w);
}

function cleanVar(v: EnvVariable): EnvVariable {
  return { key: String(v.key ?? '').slice(0, 200), value: String(v.value ?? ''), enabled: v.enabled !== false, secret: v.secret === true };
}

export function saveGlobals(id: string, globals: EnvVariable[]): Workspace {
  const w = load(id);
  w.globals = (globals ?? []).map(cleanVar);
  return save(w);
}

/** First start: a personal workspace with a small example collection, so the app is not empty. */
export function ensureDefault(): void {
  if (list().some((w) => !w.serverId)) return;
  const w = create('Personal');
  const col = uid('c_');
  const req = (name: string, method: HttpMethod, url: string, body?: string): TreeItem => ({
    id: uid('r_'),
    kind: 'request',
    parentId: col,
    name,
    sort: 0,
    request: { ...newRequest(), method, url, ...(body ? { body: { mode: 'json', raw: body, fields: [] } } : {}) },
  });
  const items: TreeItem[] = [
    { id: col, kind: 'collection', parentId: null, name: 'Getting started', sort: 0, auth: { mode: 'none' }, description: 'Example requests against httpbin.org.' },
    req('Get JSON', 'GET', '{{baseUrl}}/json'),
    req('Echo a POST', 'POST', '{{baseUrl}}/anything', '{\n  "hello": "{{name}}"\n}'),
    req('A 404 (the cat hisses)', 'GET', '{{baseUrl}}/status/404'),
  ];
  w.items = items.map((i, n) => ({ ...i, sort: n }));
  const env = uid('e_');
  w.environments = [
    {
      id: env,
      name: 'httpbin',
      variables: [
        { key: 'baseUrl', value: 'https://httpbin.org', enabled: true, secret: false },
        { key: 'name', value: 'MrCatz', enabled: true, secret: false },
      ],
    },
  ];
  w.activeEnvironmentId = env;
  save(w);
}
