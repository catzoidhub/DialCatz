import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { stripLocalFiles } from '@shared/request';
import { emptyBody, newRequest, type Environment, type RequestSpec, type TreeItem, type Workspace } from '@shared/types';

/**
 * Folder workspaces (git sharing, phase 1): a workspace kept as files in a folder the user picks — usually inside a
 * Git repository — one small YAML file per collection, folder, request and environment, so changes diff and merge
 * well. Layout:
 *
 *   dialcatz.yml                                   the workspace's name and the format version
 *   collections/<collection>/collection.yml        a collection's settings (auth, scripts, description …)
 *   collections/<collection>/<request>.request.yml one request
 *   collections/<collection>/<folder>/folder.yml   a folder, with its requests and folders beside it
 *   environments/<environment>.env.yml             variable NAMES (on / off, secret) — never values
 *
 * Only what can be shared goes into the folder: variable values, globals, picked file paths, DBCatz settings and the
 * sidebar arrangement stay in DialCatz's own copy on this computer. Every item keeps its id in its file, so renaming a
 * file or an item keeps its links (a collection's environment). The folder is watched: edits from outside (git pull,
 * an editor) come in on their own.
 */

export const META = 'dialcatz.yml';
/** How a workspace says some of its files could not be read (it then writes nothing to the folder). */
export const UNREADABLE = 'Some files could not be read:';
const FORMAT = 1;
const MANAGED = ['collections', 'environments'];

export interface FolderData {
  name: string;
  items: TreeItem[];
  environments: { id: string; name: string; variables: { key: string; enabled: boolean; secret: boolean }[] }[];
  errors: string[];
}

export const isWorkspaceFolder = (dir: string) => existsSync(join(dir, META));

const slug = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';

/** Fields worth a line in a file (empty ones are left out so files stay short). */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))) as Partial<T>;
}

function specDoc(spec: RequestSpec): Record<string, unknown> {
  const s = stripLocalFiles(spec);
  const body = compact({ mode: s.body.mode, raw: s.body.raw, variables: s.body.variables, fields: s.body.fields.map((f) => compact({ key: f.key, value: f.value, enabled: f.enabled, type: f.type, description: f.description })) });
  const kv = (list: RequestSpec['params']) => list.map((r) => compact({ key: r.key, value: r.value, enabled: r.enabled, description: r.description }));
  return compact({ method: s.method, url: s.url, params: kv(s.params), headers: kv(s.headers), body: s.body.mode === 'none' ? undefined : body, auth: s.auth, autoOff: s.autoOff, preRequest: s.preRequest, tests: s.tests });
}

function itemDoc(i: TreeItem): Record<string, unknown> {
  const base = { id: i.id, name: i.name, sort: i.sort, description: i.description };
  if (i.kind === 'request') return compact({ ...base, request: i.request ? specDoc(i.request) : undefined });
  return compact({ ...base, auth: i.auth, preRequest: i.preRequest, tests: i.tests, ...(i.kind === 'collection' ? { insecure: i.insecure, environmentId: i.environmentId } : {}) });
}

const yaml = (o: unknown) => stringify(o, { lineWidth: 0 });

/** Every file the workspace is made of: relative path → text. */
export function folderFiles(w: Workspace): Map<string, string> {
  const out = new Map<string, string>();
  out.set(META, yaml({ dialcatz: FORMAT, kind: 'workspace', name: w.name }));
  const order = (a: TreeItem, b: TreeItem) => a.sort - b.sort || a.id.localeCompare(b.id);
  const walk = (parentId: string, dir: string) => {
    const used = new Set<string>();
    const unique = (name: string) => {
      let s = slug(name);
      for (let n = 2; used.has(s); n++) s = `${slug(name)}-${n}`;
      used.add(s);
      return s;
    };
    for (const i of w.items.filter((x) => x.parentId === parentId).sort(order)) {
      if (i.kind === 'request') out.set(`${dir}/${unique(i.name)}.request.yml`, yaml(itemDoc(i)));
      else {
        const sub = `${dir}/${unique(i.name)}`;
        out.set(`${sub}/folder.yml`, yaml(itemDoc(i)));
        walk(i.id, sub);
      }
    }
  };
  const used = new Set<string>();
  for (const c of w.items.filter((x) => x.kind === 'collection').sort(order)) {
    let s = slug(c.name);
    for (let n = 2; used.has(s); n++) s = `${slug(c.name)}-${n}`;
    used.add(s);
    out.set(`collections/${s}/collection.yml`, yaml(itemDoc(c)));
    walk(c.id, `collections/${s}`);
  }
  const envUsed = new Set<string>();
  for (const e of w.environments) {
    let s = slug(e.name);
    for (let n = 2; envUsed.has(s); n++) s = `${slug(e.name)}-${n}`;
    envUsed.add(s);
    out.set(`environments/${s}.env.yml`, yaml({ id: e.id, name: e.name, variables: e.variables.map((v) => compact({ key: v.key, enabled: v.enabled, secret: v.secret || undefined })) }));
  }
  return out;
}

function listManaged(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      if (name.startsWith('.')) continue;
      const r = `${rel}/${name}`;
      if (statSync(join(root, r)).isDirectory()) walk(r);
      else if (name.endsWith('.yml')) out.push(r);
    }
  };
  for (const m of MANAGED) walk(m);
  return out;
}

function removeEmptyDirs(root: string, rel: string): void {
  const abs = join(root, rel);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) return;
  for (const name of readdirSync(abs)) removeEmptyDirs(root, `${rel}/${name}`);
  if (!readdirSync(abs).length && !MANAGED.includes(rel)) rmdirSync(abs);
}

/** Writes the workspace into its folder: only files whose text changed, and removes the ones that are gone. */
export function writeFolder(root: string, w: Workspace): void {
  const want = folderFiles(w);
  for (const [rel, text] of want) {
    const abs = join(root, rel);
    if (existsSync(abs) && readFileSync(abs, 'utf8') === text) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(`${abs}.tmp`, text);
    renameSync(`${abs}.tmp`, abs);
  }
  for (const m of MANAGED) mkdirSync(join(root, m), { recursive: true });
  for (const rel of listManaged(root)) if (!want.has(rel)) unlinkSync(join(root, rel));
  for (const m of MANAGED) removeEmptyDirs(root, m);
}

// ------------------------------------------------------------------ reading

const str = (v: unknown, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : String(v).slice(0, n));
/** An item written by hand may have no id: one made from its path, so it stays the same on every read. */
const pathId = (prefix: string, rel: string) => `${prefix}${createHash('sha1').update(rel).digest('hex').slice(0, 16)}`;
const okId = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,80}$/.test(v) ? v : '');

function readYaml(root: string, rel: string, errors: string[]): Record<string, unknown> | null {
  try {
    const d = parse(readFileSync(join(root, rel), 'utf8'));
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
  } catch (e) {
    errors.push(`${rel}: ${(e as Error).message.split('\n')[0]}`);
    return null;
  }
}

function kvList(v: unknown): RequestSpec['params'] {
  return Array.isArray(v) ? v.filter((r) => r && typeof r === 'object').map((r) => ({ key: str(r.key, 500), value: str(r.value, 100_000), enabled: r.enabled !== false, ...(r.description ? { description: str(r.description) } : {}), ...(r.type === 'file' ? { type: 'file' as const } : {}) })) : [];
}

function specFrom(d: unknown): RequestSpec {
  const r = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const b = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>;
  const spec: RequestSpec = {
    ...newRequest(),
    method: (str(r.method, 20).toUpperCase() || 'GET') as RequestSpec['method'],
    url: str(r.url, 20_000),
    params: kvList(r.params),
    headers: kvList(r.headers),
    body: { ...emptyBody(), ...(typeof b.mode === 'string' ? { mode: b.mode as RequestSpec['body']['mode'] } : {}), raw: str(b.raw, 5_000_000), fields: kvList(b.fields), ...(b.variables ? { variables: str(b.variables, 1_000_000) } : {}) },
    auth: r.auth && typeof r.auth === 'object' ? (r.auth as RequestSpec['auth']) : { mode: 'inherit' },
  };
  if (Array.isArray(r.autoOff)) spec.autoOff = r.autoOff.map((x) => str(x, 200));
  if (r.preRequest) spec.preRequest = str(r.preRequest, 200_000);
  if (r.tests) spec.tests = str(r.tests, 200_000);
  return spec;
}

function containerFrom(d: Record<string, unknown>, kind: 'collection' | 'folder', rel: string, parentId: string | null, fallbackName: string): TreeItem {
  const item: TreeItem = { id: okId(d.id) || pathId(kind === 'collection' ? 'c_' : 'f_', rel), kind, parentId, name: str(d.name, 200) || fallbackName, sort: Number(d.sort) || 0 };
  if (d.description) item.description = str(d.description, 100_000);
  if (d.auth && typeof d.auth === 'object') item.auth = d.auth as TreeItem['auth'];
  if (d.preRequest) item.preRequest = str(d.preRequest, 200_000);
  if (d.tests) item.tests = str(d.tests, 200_000);
  if (kind === 'collection' && d.insecure === true) item.insecure = true;
  if (kind === 'collection' && (typeof d.environmentId === 'string' || d.environmentId === null)) item.environmentId = d.environmentId as string | null;
  return item;
}

/** Reads a workspace folder back into items and environments (variable names only). */
export function readFolder(root: string): FolderData {
  const errors: string[] = [];
  const meta = readYaml(root, META, errors) ?? {};
  const items: TreeItem[] = [];
  const seen = new Set<string>();
  const add = (i: TreeItem, rel: string) => {
    // Two files with the same id (a copied file): the second gets one of its own.
    if (seen.has(i.id)) i.id = pathId(i.id.slice(0, 2), rel);
    seen.add(i.id);
    items.push(i);
  };
  const walk = (rel: string, parentId: string) => {
    for (const name of readdirSync(join(root, rel)).sort()) {
      if (name.startsWith('.')) continue;
      const r = `${rel}/${name}`;
      if (statSync(join(root, r)).isDirectory()) {
        const d = existsSync(join(root, r, 'folder.yml')) ? readYaml(root, `${r}/folder.yml`, errors) : {};
        if (!d) continue;
        const f = containerFrom(d, 'folder', r, parentId, name);
        add(f, r);
        walk(r, f.id);
      } else if (name.endsWith('.request.yml')) {
        const d = readYaml(root, r, errors);
        if (!d) continue;
        const item: TreeItem = { id: okId(d.id) || pathId('r_', r), kind: 'request', parentId, name: str(d.name, 200) || name.replace(/\.request\.yml$/, ''), sort: Number(d.sort) || 0, request: specFrom(d.request) };
        if (d.description) item.description = str(d.description, 100_000);
        add(item, r);
      }
    }
  };
  if (existsSync(join(root, 'collections'))) {
    for (const name of readdirSync(join(root, 'collections')).sort()) {
      const r = `collections/${name}`;
      if (name.startsWith('.') || !statSync(join(root, r)).isDirectory()) continue;
      const d = existsSync(join(root, r, 'collection.yml')) ? readYaml(root, `${r}/collection.yml`, errors) : {};
      if (!d) continue;
      const c = containerFrom(d, 'collection', r, null, name);
      add(c, r);
      walk(r, c.id);
    }
  }
  const environments: FolderData['environments'] = [];
  if (existsSync(join(root, 'environments'))) {
    for (const name of readdirSync(join(root, 'environments')).sort()) {
      if (!name.endsWith('.env.yml')) continue;
      const r = `environments/${name}`;
      const d = readYaml(root, r, errors);
      if (!d) continue;
      const vars = Array.isArray(d.variables) ? (d.variables as Record<string, unknown>[]).filter((v) => v && typeof v.key === 'string' && v.key).map((v) => ({ key: str(v.key, 200), enabled: v.enabled !== false, secret: v.secret === true })) : [];
      environments.push({ id: okId(d.id) || pathId('e_', r), name: str(d.name, 120) || name.replace(/\.env\.yml$/, ''), variables: vars });
    }
  }
  return { name: str(meta.name, 120), items, environments, errors };
}

/**
 * Folder content into a workspace: items and environment names from the files; what stays on this computer (values,
 * DBCatz settings) is kept by id (values by variable name).
 */
export function mergeFolder(w: Workspace, d: FolderData): Workspace {
  const old = new Map(w.items.map((i) => [i.id, i]));
  const items = d.items.map((i) => {
    const o = old.get(i.id);
    return { ...i, ...(o?.database ? { database: o.database } : {}), ...(o?.dbTable ? { dbTable: o.dbTable } : {}) };
  });
  const environments: Environment[] = d.environments.map((e) => {
    const o = w.environments.find((x) => x.id === e.id) ?? w.environments.find((x) => x.name === e.name);
    return { id: e.id, name: e.name, variables: e.variables.map((v) => ({ ...v, value: o?.variables.find((x) => x.key === v.key)?.value ?? '' })) };
  });
  const active = environments.some((e) => e.id === w.activeEnvironmentId) ? w.activeEnvironmentId : null;
  return { ...w, name: d.name || w.name, items, environments, activeEnvironmentId: active, folderError: d.errors.length ? `${UNREADABLE} ${d.errors.slice(0, 3).join('; ')}. Fix them (or Abort merge in Git) — until then changes here are not written to the folder.` : undefined };
}

/** What a folder holds, to compare before and after an outside change. */
export const fingerprint = (w: Pick<Workspace, 'name' | 'items' | 'environments'>) => JSON.stringify([w.name, w.items.map(itemDoc), w.environments.map((e) => [e.id, e.name, e.variables.map((v) => [v.key, v.enabled, v.secret])])]);

// ------------------------------------------------------------------ watching

interface Watch {
  watcher: FSWatcher;
  quietUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const watches = new Map<string, Watch>();

/** Watches a workspace folder; `changed` runs (debounced) after edits from outside, never after DialCatz's own writes. */
export function watchFolder(id: string, root: string, changed: () => void): void {
  if (watches.has(id)) return;
  try {
    const watcher = watch(root, { recursive: true }, (_e, file) => {
      const f = String(file ?? '');
      if (f.startsWith('.git') || f.includes(`${'/'}.git${'/'}`) || f.endsWith('.tmp')) return;
      const w = watches.get(id);
      if (!w || Date.now() < w.quietUntil) return;
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        w.timer = null;
        if (Date.now() >= w.quietUntil) changed();
      }, 400);
    });
    watcher.on('error', () => stopWatching(id));
    watches.set(id, { watcher, quietUntil: 0, timer: null });
  } catch (e) {
    console.warn(`Could not watch ${root}: ${(e as Error).message}`);
  }
}

/** DialCatz is writing: the watch ignores the folder for a moment. */
export function quiet(id: string): void {
  const w = watches.get(id);
  if (w) w.quietUntil = Date.now() + 1200;
}

export function stopWatching(id: string): void {
  const w = watches.get(id);
  if (!w) return;
  if (w.timer) clearTimeout(w.timer);
  w.watcher.close();
  watches.delete(id);
}
