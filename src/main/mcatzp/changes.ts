import type { ActionDef, CallResult } from '@catzoid/mcatzp-host';
import { buildVars, effectiveAuth, interpolate } from '@shared/request';
import { emptyLayout, newRequest, uid, type DialCatzApi, type DialCatzSettingsPatch, type EnvVariable, type GitPull, type GitRepoEntry, type GitSyncAction, type KeyValue, type McatzpAsk, type RequestAuth, type RequestSpec, type TreeItem, type Workspace, type WorkspaceSummary } from '@shared/types';
import { isSecretVar, isVariable, pick, placeOf, reply, responseOut, type Scopes, underCollection } from './actions';
import { MASK, maskText, maskUrl, SECRET_NAME, secretValues } from './mask';

/**
 * DialCatz's changes for MCatzP (TODO #80): each calls the same `api()` method its UI uses, or for sending the window's
 * own path (scripts, inherited auth, history). Every one asks first, in a dialog built here from the real target, never
 * from the assistant's words. A client never sets or sees a secret: logins can only name a {{variable}}, a secret
 * variable can be created but its value stays the user's to fill in, and a masked value sent back keeps the real one.
 * Writing a script and sending a request never go under "allow for this session", which holds per tool, whatever the
 * call: a script runs with every variable, and a request may carry them to any host.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, maxLength = 512) => ({ type: 'string', minLength: 1, maxLength, description });
const WORKSPACE = S("The workspace's id or name (see list_workspaces).");
const COLLECTION = S("The collection's id or name (see list_collections).");
const REQUEST = S("The request's id, or its name when only one has it (see list_requests).");
const ENVIRONMENT = S("The environment's id or name (see list_environments).");
const REPO = S("The repository's id or name (see list_git_repos).");
const FILES = { type: 'array', minItems: 1, maxItems: 200, items: S('A path from git_status.', 1000) };
const METHOD = { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] };
const ROWS = (description: string) => ({ type: 'array', maxItems: 200, description, items: { type: 'object', additionalProperties: false, required: ['key'], properties: { key: S('The name.', 300), value: { type: 'string', maxLength: 10_000 }, enabled: { type: 'boolean' }, description: { type: 'string', maxLength: 1000 } } } });
const REQUEST_FIELDS = {
  method: METHOD,
  url: { type: 'string', maxLength: 8000, description: 'May use {{variables}}.' },
  params: ROWS('Query parameters. A secret-looking one must be a {{variable}}.'),
  headers: ROWS('Headers. A secret-looking one must be a {{variable}}.'),
  body: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', enum: ['none', 'json', 'text', 'xml', 'form', 'graphql'] }, raw: { type: 'string', maxLength: 500_000 }, fields: ROWS('form: the fields.'), variables: { type: 'string', maxLength: 100_000 } } },
  auth: { type: 'object', additionalProperties: false, required: ['mode'], description: 'How it logs in. The values must be {{variables}}: a client never sets a secret. inherit: from the folder or collection.', properties: { mode: { type: 'string', enum: ['none', 'inherit', 'bearer', 'basic', 'apikey'] }, token: S('bearer: a {{variable}}.'), username: S('basic: a {{variable}}.'), password: S('basic: a {{variable}}.'), key: S('apikey: the header or parameter name.'), value: S('apikey: a {{variable}}.'), in: { type: 'string', enum: ['header', 'query'] } } },
};
type Fact = Extract<McatzpAsk, { kind: 'change' }>['facts'][number];
/** Where DialCatz opens once the user allows it, so they watch it happen. */
export interface McatzpPage {
  workspaceId?: string;
  itemId?: string;
  section?: 'requests' | 'environments' | 'git' | 'team' | 'settings';
}
export interface ChangeAction extends ActionDef {
  /** Only stops work: runs at once, since a dialog would hold up the stopping. Still logged. */
  noDialog?: boolean;
  preview(args: Record<string, unknown>): Promise<{ title: string; facts: Fact[]; page: McatzpPage | null; typeName?: string }>;
}
type Q = Awaited<ReturnType<ChangeAction['preview']>>;
/** What needs the window: its send path holds the scripts, inherited auth and history. */
export type WindowCommand = (what: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>;

const short = (t: string, m = 500) => (t.length > m ? `${t.slice(0, m)}…` : t);
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);
const done = (data: unknown): CallResult => reply(data);

/** A value a client read as masked and sent back: what it stands for stays, a new secret is refused. */
const noMask = (text: string | undefined, what: string) => {
  if (text?.includes(MASK)) throw new Error(`${what} holds a masked value (${MASK}): send what you want to change without it`);
  return text;
};
function rowsFrom(raw: unknown, old: KeyValue[] | undefined, what: string): KeyValue[] {
  return ((raw as { key: string; value?: string; enabled?: boolean; description?: string }[]) ?? []).map((r) => {
    const before = old?.find((o) => o.key === r.key);
    const masked = r.value?.includes(MASK);
    if (masked && !before) throw new Error(`${what} ${r.key} holds a masked value (${MASK}), and there is none to keep`);
    const value = masked ? before!.value : (r.value ?? '');
    if (!masked && SECRET_NAME.test(r.key) && value && !value.includes('{{')) throw new Error(`${what} ${r.key} looks secret: use a {{variable}}, whose value the user fills in`);
    return { key: r.key, value, enabled: r.enabled !== false, ...(r.description ? { description: r.description } : {}) };
  });
}
function authFrom(raw: Record<string, unknown> | undefined, old: RequestAuth | undefined): RequestAuth {
  if (!raw) return old ?? { mode: 'inherit' };
  const val = (name: 'token' | 'username' | 'password' | 'value', v: unknown) => {
    if (typeof v !== 'string') return {};
    if (v.includes(MASK) && old?.[name]) return { [name]: old[name] };
    if (!isVariable(v)) throw new Error(`The ${name} must be a {{variable}}: a client never sets a secret, the user fills in its value`);
    return { [name]: v.trim() };
  };
  return { mode: raw.mode as RequestAuth['mode'], ...val('token', raw.token), ...val('username', raw.username), ...val('password', raw.password), ...(typeof raw.key === 'string' ? { key: raw.key } : {}), ...val('value', raw.value), ...(raw.in ? { in: raw.in as 'header' | 'query' } : {}) };
}
/** Literal secrets in a query string count as well. */
function urlFrom(url: string): string {
  noMask(url, 'The URL');
  for (const [, k, v] of url.matchAll(/[?&]([^=&#]+)=([^&#]*)/g)) if (SECRET_NAME.test(k) && v && !v.includes('{{')) throw new Error(`The URL's ${k} looks secret: use a {{variable}}, whose value the user fills in`);
  return url;
}
function specFrom(a: Record<string, unknown>, old?: RequestSpec): RequestSpec {
  const base = old ?? newRequest();
  const b = a.body as { mode: RequestSpec['body']['mode']; raw?: string; fields?: unknown; variables?: string } | undefined;
  return {
    ...base,
    ...(a.method ? { method: a.method as RequestSpec['method'] } : {}),
    ...(typeof a.url === 'string' ? { url: urlFrom(a.url) } : {}),
    ...(a.params ? { params: rowsFrom(a.params, base.params, 'Parameter') } : {}),
    ...(a.headers ? { headers: rowsFrom(a.headers, base.headers, 'Header') } : {}),
    ...(b ? { body: { mode: b.mode, raw: noMask(b.raw, 'The body') ?? '', fields: rowsFrom(b.fields, base.body.fields, 'Field'), ...(b.variables ? { variables: noMask(b.variables, 'The GraphQL variables') } : {}) } } : {}),
    auth: authFrom(a.auth as Record<string, unknown> | undefined, base.auth),
  };
}
const rowText = (rows: KeyValue[]) => short(rows.map((r) => `${r.key}: ${r.value}`).join(', '), 300);

/** The environment an item's requests use, as the window finds it. */
function envOf(w: Workspace, item: TreeItem | null) {
  let cur = item;
  const byId = new Map(w.items.map((i) => [i.id, i]));
  while (cur && cur.kind !== 'collection') cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null;
  if (cur && cur.environmentId !== undefined) {
    if (cur.environmentId === null) return null;
    const own = w.environments.find((e) => e.id === cur!.environmentId);
    if (own) return own;
  }
  return w.environments.find((e) => e.id === w.activeEnvironmentId) ?? null;
}
function inherited(w: Workspace, item: TreeItem | null): RequestAuth[] {
  const out: RequestAuth[] = [];
  const byId = new Map(w.items.map((i) => [i.id, i]));
  for (let cur = item?.parentId ? byId.get(item.parentId) : undefined; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) if (cur.auth) out.push(cur.auth);
  return out;
}

/** Where a request really goes and what secret it takes along: what the user has to see before it leaves. */
function sendFacts(w: Workspace, spec: RequestSpec, item: TreeItem | null, secrets: string[]): Fact[] {
  const env = envOf(w, item);
  const vars = buildVars(w.globals, env?.variables);
  const url = interpolate(spec.url, vars);
  const auth = effectiveAuth(spec.auth, inherited(w, item));
  const text = [spec.url, ...spec.params.map((r) => r.value), ...spec.headers.map((r) => r.value), spec.body.raw, ...spec.body.fields.map((r) => r.value), spec.body.variables ?? '', auth.token ?? '', auth.username ?? '', auth.password ?? '', auth.value ?? ''].join('\n');
  const names = new Set([...text.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)].map((m) => m[1]));
  const list = [...(w.globals ?? []), ...(env?.variables ?? [])];
  const carried = [...names].filter((n) => list.some((v) => v.key.trim() === n && isSecretVar(v)));
  const saved = ['bearer', 'basic', 'apikey'].includes(auth.mode) && [auth.token, auth.password, auth.value].some((v) => v && !v.includes('{{'));
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = '';
  }
  return [
    { label: 'Goes to', value: host || 'an address that is not complete yet' },
    { label: 'Request', value: short(`${spec.method} ${maskUrl(url, secrets)}`, 300) },
    ...fact('Using', env?.name),
    ...fact('Carries', [...carried.map((n) => `{{${n}}}`), ...(saved ? [`the saved ${auth.mode} login`] : [])].join(', ') || null),
    ...fact('Script', item?.request?.preRequest || item?.request?.tests ? 'Its scripts run too, with your variables' : null),
  ];
}

export function changeActions(api: DialCatzApi, scopes: Scopes, command: WindowCommand, settingsChanged: () => void): ChangeAction[] {
  if (!scopes.changes) return [];
  const shared = async (): Promise<WorkspaceSummary[]> => (await api.workspaces()).filter((w) => scopes.workspace(w.id));
  const workspaceOf = async (ref: unknown): Promise<Workspace> => api.workspace(pick(await shared(), String(ref), 'shared workspace', 'list_workspaces').id);
  const secrets = async (): Promise<string[]> => secretValues((await Promise.all((await api.workspaces()).map((s) => api.workspace(s.id).catch(() => null)))).filter((w): w is Workspace => !!w));
  const collectionOf = (w: Workspace, ref: unknown) => pick(w.items.filter((i) => i.kind === 'collection'), String(ref), 'collection', 'list_collections');
  const requestOf = (w: Workspace, ref: unknown) => pick(w.items.filter((i) => i.kind === 'request' && i.request), String(ref), 'request', 'list_requests');
  const containerOf = (w: Workspace, ref: unknown) => pick(w.items.filter((i) => i.kind !== 'request'), String(ref), 'collection or folder', 'list_collections');
  const envOfRef = (w: Workspace, ref: unknown) => pick(w.environments, String(ref), 'environment', 'list_environments');
  const repoOf = async (ref: unknown): Promise<GitRepoEntry> => pick((await api.gitState()).repos, String(ref), 'repository', 'list_git_repos');
  const nextSort = (w: Workspace, parentId: string | null) => Math.max(-1, ...w.items.filter((i) => i.parentId === parentId).map((i) => i.sort)) + 1;
  const inW = (w: Workspace): Fact[] => [{ label: 'In', value: w.name }];

  /** One dialog. `session`: low-risk, so it may offer "allow for this session". */
  const asked = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], preview: (a: Record<string, unknown>) => Promise<Q>, run: ChangeAction['run'], session = false): ChangeAction => ({ name, title, description: `${description} DialCatz asks the user first.`, tier: 'change', input: OBJECT(props, required), allowSession: session, preview, run });
  /** Only stops work: no dialog. */
  const stopper = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], run: ChangeAction['run']): ChangeAction => ({ name, title, description, tier: 'change', input: OBJECT(props, required), noDialog: true, preview: async () => ({ title, facts: [], page: null }), run });
  const q = (title: string, facts: Fact[], page: McatzpPage | null): Q => ({ title, facts, page });

  const requests: ChangeAction[] = [
    asked('create_workspace', 'Create a workspace', 'A new personal workspace on this computer.', { name: S('Its name.', 200) }, ['name'], async (a) => q(`Create workspace ${String(a.name)}?`, [], null), async (a) => {
      const w = await api.createWorkspace(String(a.name));
      return done({ id: w.id, name: w.name, shared: scopes.workspace(w.id), ...(scopes.workspace(w.id) ? {} : { note: 'Not shared yet: the user can tick it in Settings → MCatzP.' }) });
    }),
    asked('rename_workspace', 'Rename a workspace', 'Gives a workspace a new name.', { workspace: WORKSPACE, name: S('The new name.', 200) }, ['workspace', 'name'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Rename ${w.name} to ${String(a.name)}?`, [], { workspaceId: w.id });
    }, async (a) => done({ name: (await api.renameWorkspace((await workspaceOf(a.workspace)).id, String(a.name))).name })),
    asked('create_folder_workspace', 'Create a workspace in a folder', 'A new workspace kept as files in parent/folder, ready to share through Git. The folder is made when missing.', { name: S('Its name.', 200), parent: S('The folder to put it in (full path).', 1000), folder: S('The new folder’s name.', 200) }, ['name', 'parent', 'folder'], async (a) => q(`Create workspace ${String(a.name)} in a folder?`, [{ label: 'Folder', value: `${String(a.parent)}/${String(a.folder)}` }], null), async (a) => {
      const w = await api.createFolderWorkspace(String(a.name), String(a.parent), String(a.folder));
      return done({ id: w.id, name: w.name, shared: scopes.workspace(w.id) });
    }),
    asked('stop_using_folder', 'Stop using a folder', 'The workspace goes back to being kept on this computer; the files in the folder stay.', { workspace: WORKSPACE }, ['workspace'], async (a) => {
      const w = await workspaceOf(a.workspace);
      if (!w.folder) throw new Error(`${w.name} is not kept in a folder`);
      return q(`Stop keeping ${w.name} in its folder?`, [{ label: 'Folder', value: w.folder }, { label: 'Files', value: 'They stay in the folder' }], { workspaceId: w.id });
    }, async (a) => done({ name: (await api.stopUsingFolder((await workspaceOf(a.workspace)).id)).name })),

    asked('create_collection', 'Create a collection', 'A new collection in a workspace.', { workspace: WORKSPACE, name: S('Its name.', 200), description: { type: 'string', maxLength: 20_000 }, environment: S("The environment its requests use (see list_environments); the workspace's default when left out."), auth: REQUEST_FIELDS.auth }, ['workspace', 'name'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Create collection ${String(a.name)}?`, [...inW(w), ...fact('Uses', a.environment ? envOfRef(w, a.environment).name : null)], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const c: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: String(a.name), sort: nextSort(w, null), auth: authFrom(a.auth as Record<string, unknown> | undefined, { mode: 'none' }), ...(a.description ? { description: noMask(String(a.description), 'The description') } : {}), ...(a.environment ? { environmentId: envOfRef(w, a.environment).id } : {}) };
      await api.saveItems(w.id, [c]);
      return done({ id: c.id, name: c.name });
    }, true),
    asked('update_collection', 'Change a collection', "Its name, description, how it logs in, its environment. What is left out stays. skip_tls_checks turns off certificate checks for its requests.", { workspace: WORKSPACE, collection: COLLECTION, name: S('The new name.', 200), description: { type: 'string', maxLength: 20_000 }, environment: { type: ['string', 'null'], maxLength: 512, description: 'An environment, or null for none.' }, auth: REQUEST_FIELDS.auth, skip_tls_checks: { type: 'boolean' } }, ['workspace', 'collection'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const c = collectionOf(w, a.collection);
      return q(`Change collection ${c.name}?`, [...inW(w), ...fact('Name', a.name), ...fact('Uses', typeof a.environment === 'string' ? envOfRef(w, a.environment).name : a.environment === null ? 'no environment' : null), ...fact('Login', a.auth ? (a.auth as { mode: string }).mode : null), ...fact('TLS', a.skip_tls_checks === undefined ? null : a.skip_tls_checks ? 'Certificate checks off' : 'Certificate checks on'), ...fact('Notes', a.description ? short(String(a.description), 200) : null)], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const c = collectionOf(w, a.collection);
      await api.saveItems(w.id, [{ ...c, ...(a.name ? { name: String(a.name) } : {}), ...(typeof a.description === 'string' ? { description: noMask(a.description, 'The description') } : {}), ...(a.auth ? { auth: authFrom(a.auth as Record<string, unknown>, c.auth) } : {}), ...(a.environment === null ? { environmentId: null } : a.environment ? { environmentId: envOfRef(w, a.environment).id } : {}), ...(a.skip_tls_checks === undefined ? {} : { insecure: a.skip_tls_checks === true }) }]);
      return done({ id: c.id });
    }),
    asked('create_folder', 'Create a folder', 'A new folder in a collection or another folder.', { workspace: WORKSPACE, parent: S('The collection or folder (id or name).'), name: S('Its name.', 200) }, ['workspace', 'parent', 'name'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const p = containerOf(w, a.parent);
      return q(`Create folder ${String(a.name)}?`, [{ label: 'In', value: [...placeOf(w.items, p), p.name].join(' / ') }], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const p = containerOf(w, a.parent);
      const f: TreeItem = { id: uid('f_'), kind: 'folder', parentId: p.id, name: String(a.name), sort: nextSort(w, p.id), auth: { mode: 'inherit' } };
      await api.saveItems(w.id, [f]);
      return done({ id: f.id, name: f.name });
    }, true),
    asked('create_request', 'Create a request', 'A new saved request. Logins and secret-looking headers must be {{variables}}. Use set_scripts for its scripts.', { workspace: WORKSPACE, parent: S('The collection or folder (id or name).'), name: S('Its name.', 200), description: { type: 'string', maxLength: 20_000 }, ...REQUEST_FIELDS }, ['workspace', 'parent', 'name', 'method', 'url'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const p = containerOf(w, a.parent);
      const spec = specFrom(a);
      return q(`Create request ${String(a.name)}?`, [{ label: 'In', value: [...placeOf(w.items, p), p.name].join(' / ') }, { label: 'Request', value: short(`${spec.method} ${spec.url}`, 300) }, ...fact('Headers', spec.headers.length ? rowText(spec.headers) : null)], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const p = containerOf(w, a.parent);
      const r: TreeItem = { id: uid('r_'), kind: 'request', parentId: p.id, name: String(a.name), sort: nextSort(w, p.id), request: specFrom(a), ...(a.description ? { description: noMask(String(a.description), 'The description') } : {}) };
      await api.saveItems(w.id, [r]);
      return done({ id: r.id, name: r.name });
    }, true),
    asked('update_request', 'Change a request', 'What you pass replaces that part; what you leave out stays, like params the user set. A masked value (•••) in a row keeps the real one. Use set_scripts for its scripts.', { workspace: WORKSPACE, request: REQUEST, name: S('The new name.', 200), description: { type: 'string', maxLength: 20_000 }, ...REQUEST_FIELDS }, ['workspace', 'request'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const r = requestOf(w, a.request);
      const spec = specFrom(a, r.request);
      const list = await secrets();
      return q(`Change request ${r.name}?`, [{ label: 'In', value: placeOf(w.items, r).join(' / ') }, ...fact('Name', a.name), { label: 'Request', value: short(`${spec.method} ${maskUrl(spec.url, list)}`, 300) }, ...fact('Headers', a.headers ? maskText(rowText(spec.headers), list) : null), ...fact('Query', a.params ? maskText(rowText(spec.params), list) : null), ...fact('Body', a.body ? short(maskText(spec.body.raw, list), 300) || spec.body.mode : null), ...fact('Login', a.auth ? spec.auth.mode : null)], { workspaceId: w.id, itemId: r.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const r = requestOf(w, a.request);
      await api.saveItems(w.id, [{ ...r, ...(a.name ? { name: String(a.name) } : {}), ...(typeof a.description === 'string' ? { description: noMask(a.description, 'The description') } : {}), request: specFrom(a, r.request) }]);
      return done({ id: r.id });
    }, true),
    asked('set_scripts', 'Set scripts', "A request's, folder's or collection's pre-request and test scripts. A script runs with every variable, secret ones too, so this always asks, showing the script.", { workspace: WORKSPACE, item: S('The request, folder or collection (id, or its name when only one has it).'), pre_request: { type: 'string', maxLength: 100_000, description: 'Empty removes it; left out stays.' }, tests: { type: 'string', maxLength: 100_000, description: 'Empty removes it; left out stays.' } }, ['workspace', 'item'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = pick(w.items, String(a.item), 'item', 'list_requests');
      noMask(a.pre_request as string | undefined, 'The script');
      noMask(a.tests as string | undefined, 'The script');
      return q(`Set the scripts of ${i.name}?`, [{ label: 'Warning', value: 'Scripts run with every variable, secret ones too. Read them before you allow this.' }, ...fact('Before', a.pre_request === '' ? 'removed' : a.pre_request ? short(String(a.pre_request), 1500) : null), ...fact('Tests', a.tests === '' ? 'removed' : a.tests ? short(String(a.tests), 1500) : null)], { workspaceId: w.id, ...(i.kind === 'request' ? { itemId: i.id } : {}), section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = pick(w.items, String(a.item), 'item', 'list_requests');
      const pre = a.pre_request as string | undefined;
      const tests = a.tests as string | undefined;
      await api.saveItems(w.id, [i.kind === 'request' ? { ...i, request: { ...i.request!, ...(pre === undefined ? {} : { preRequest: pre }), ...(tests === undefined ? {} : { tests }) } } : { ...i, ...(pre === undefined ? {} : { preRequest: pre }), ...(tests === undefined ? {} : { tests }) }]);
      return done({ id: i.id });
    }),
    asked('move_item', 'Move or rename an item', 'Moves a request or folder to another collection or folder of the same workspace, and / or renames it.', { workspace: WORKSPACE, item: S('The request or folder (id, or its name when only one has it).'), to: S('The collection or folder to move it to.'), name: S('The new name.', 200) }, ['workspace', 'item'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = pick(w.items.filter((x) => x.kind !== 'collection'), String(a.item), 'item', 'list_requests');
      return q(`${a.to ? 'Move' : 'Rename'} ${i.name}?`, [...fact('To', a.to ? containerOf(w, a.to).name : null), ...fact('Name', a.name)], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = pick(w.items.filter((x) => x.kind !== 'collection'), String(a.item), 'item', 'list_requests');
      const to = a.to ? containerOf(w, a.to) : null;
      await api.saveItems(w.id, [{ ...i, ...(to ? { parentId: to.id, sort: nextSort(w, to.id) } : {}), ...(a.name ? { name: String(a.name) } : {}) }]);
      return done({ id: i.id });
    }, true),
    asked('set_favorite', 'Star or unstar', 'Stars a collection or request in the sidebar, or takes the star off.', { workspace: WORKSPACE, item: S('The collection or request (id, or its name when only one has it).'), on: { type: 'boolean' } }, ['workspace', 'item', 'on'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = pick(w.items, String(a.item), 'item', 'list_requests');
      return q(`${a.on ? 'Star' : 'Unstar'} ${i.name}?`, [], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = pick(w.items, String(a.item), 'item', 'list_requests');
      const l = { ...emptyLayout(), ...w.layout };
      await api.saveLayout(w.id, { ...l, favorites: a.on ? [...new Set([...l.favorites, i.id])] : l.favorites.filter((x) => x !== i.id) });
      return done({ favorite: a.on === true });
    }, true),
    asked('set_group', 'Group a collection', 'Puts a collection in a sidebar group (made when missing), or takes it out with null.', { workspace: WORKSPACE, collection: COLLECTION, group: { type: ['string', 'null'], maxLength: 200 } }, ['workspace', 'collection', 'group'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`${a.group ? `Put ${collectionOf(w, a.collection).name} in group ${String(a.group)}` : `Take ${collectionOf(w, a.collection).name} out of its group`}?`, [], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const c = collectionOf(w, a.collection);
      const l = { ...emptyLayout(), ...w.layout };
      const groups = [...l.groups];
      const groupOf = { ...l.groupOf };
      if (a.group) {
        let g = groups.find((x) => x.name === a.group);
        if (!g) groups.push((g = { id: uid('g_'), name: String(a.group) }));
        groupOf[c.id] = g.id;
      } else delete groupOf[c.id];
      await api.saveLayout(w.id, { ...l, groups, groupOf });
      return done({ group: a.group });
    }, true),
    asked('copy_collection', 'Copy a collection', 'Into another shared workspace: a new copy, or replacing or merging into one of the same name. merge keeps what is there and adds what is missing.', { workspace: WORKSPACE, collection: COLLECTION, to: S('The workspace to copy it to.'), mode: { type: 'string', enum: ['new', 'replace', 'merge'] }, name: S('The name of the copy.', 200) }, ['workspace', 'collection', 'to', 'mode'], async (a) => {
      const [w, to] = await Promise.all([workspaceOf(a.workspace), workspaceOf(a.to)]);
      const c = collectionOf(w, a.collection);
      return q(`Copy ${c.name} to ${to.name}?`, [{ label: 'How', value: a.mode === 'replace' ? 'Replaces the one of the same name there' : a.mode === 'merge' ? 'Merges into the one of the same name there' : 'As a new collection' }], { workspaceId: to.id, section: 'requests' });
    }, async (a) => {
      const [w, to] = await Promise.all([workspaceOf(a.workspace), workspaceOf(a.to)]);
      const c = collectionOf(w, a.collection);
      const r = await api.copyCollection(w.id, c.id, to.id, a.mode as 'new' | 'replace' | 'merge', String(a.name ?? c.name));
      return done({ collection: r.collectionId });
    }),
    asked('import_text', 'Import text', 'Text as a new collection: a Postman collection, an OpenAPI / Swagger document (JSON or YAML), a DialCatz export or a cURL command.', { workspace: WORKSPACE, text: S('The text.', 5_000_000) }, ['workspace', 'text'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Import this into ${w.name}?`, [{ label: 'Text', value: short(maskText(String(a.text), await secrets()), 300) }], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const r = await api.importText((await workspaceOf(a.workspace)).id, String(a.text));
      return done({ collection: r.collectionId, requests: r.count });
    }),
  ];

  const into = { type: 'object', maxProperties: 50, additionalProperties: { type: 'string', maxLength: 200 }, description: "When imported before (see imported_before): per app or service, the collection that gets the new routes, 'all', or 'new'. Left out: the first one imported from there; saved requests are never overwritten." };
  const imports: ChangeAction[] = [
    asked('import_from_devcatz', 'Import from DevCatz', 'A DevCatz site as an environment and its routes as a collection (Laravel runs artisan route:list in the project). Imported before: only new routes are added.', { workspace: WORKSPACE, site: S("The site's id or name (see list_devcatz_sites)."), app: S('Which app of a monorepo (its dir).'), environment: { type: 'boolean' }, env_vars: { type: 'boolean', description: "Add the site's .env, secret ones marked secret." }, routes: { type: 'boolean' }, into }, ['workspace', 'site'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const s = pick((await api.devcatzSites()).sites, String(a.site), 'site', 'list_devcatz_sites');
      return q(`Import ${s.name} from DevCatz?`, [...inW(w), { label: 'Brings', value: [a.environment !== false ? `environment DevCatz · ${s.name}` : '', a.env_vars ? 'its .env' : '', a.routes !== false ? 'its routes' : ''].filter(Boolean).join(', ') }], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const s = pick((await api.devcatzSites()).sites, String(a.site), 'site', 'list_devcatz_sites');
      const r = await api.devcatzImport(w.id, s.id, { environment: a.environment !== false, envVars: a.env_vars === true, routes: a.routes !== false, ...(a.app ? { app: String(a.app) } : {}), ...(a.into ? { into: a.into as Record<string, string> } : {}) });
      return done({ collection: r.collectionId, requests: r.requests, source: r.source, merged: r.merged });
    }),
    asked('import_from_docatz', 'Import from DoCatz', "A DoCatz compose project's API services as an environment and their routes as collections. Imported before: only new routes are added. Service '*' takes them all. The project must be running.", { workspace: WORKSPACE, project: S('The project (see list_docatz_projects).'), service: S("A service, or '*'."), environment: { type: 'boolean' }, env_vars: { type: 'boolean', description: "Add the project's .env, secret ones marked secret." }, routes: { type: 'boolean' }, into }, ['workspace', 'project'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const p = (await api.docatzProjects()).projects.find((x) => x.name === a.project);
      if (!p) throw new Error(`No project ${String(a.project)} (list_docatz_projects shows them)`);
      if (!p.running) throw new Error(`${p.name} is not running: start it in DoCatz, then import again`);
      return q(`Import ${p.name} from DoCatz?`, [...inW(w), ...fact('Service', a.service), { label: 'Brings', value: [a.environment !== false ? `environment DoCatz · ${p.name}` : '', a.env_vars ? 'its .env' : '', a.routes !== false ? 'its routes' : ''].filter(Boolean).join(', ') }], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const r = await api.docatzImport((await workspaceOf(a.workspace)).id, String(a.project), { environment: a.environment !== false, envVars: a.env_vars === true, routes: a.routes !== false, ...(a.service ? { service: String(a.service) } : {}), ...(a.into ? { into: a.into as Record<string, string> } : {}) });
      return done({ collection: r.collectionId, requests: r.requests, source: r.source, merged: r.merged, skipped: r.skipped });
    }),
    asked('open_site_workspace', "Open a site's workspace", "Opens or starts the DialCatz workspace kept in a DevCatz site's repository (its dialcatz folder).", { site: S("The site's id or name (see list_devcatz_sites)."), create: { type: 'boolean', description: 'Start one when it has none.' } }, ['site'], async (a) => {
      const s = pick((await api.devcatzSites()).sites, String(a.site), 'site', 'list_devcatz_sites');
      return q(`Open ${s.name}'s workspace?`, [...fact('Starts', a.create ? 'A new one, when it has none' : null)], null);
    }, async (a) => {
      const s = pick((await api.devcatzSites()).sites, String(a.site), 'site', 'list_devcatz_sites');
      const w = await api.devcatzWorkspace(s.id, a.create === true);
      return done(w ? { id: w.id, name: w.name, shared: scopes.workspace(w.id) } : { none: true, note: `${s.name} has none yet: pass create` });
    }),
    asked('open_git_workspace', "Open a repository's workspace", 'Opens or starts the DialCatz workspace in a Git repository (its root or dialcatz folder).', { repo: REPO }, ['repo'], async (a) => q(`Open the workspace of ${(await repoOf(a.repo)).name}?`, [], null), async (a) => {
      const id = await api.gitOpenWorkspace((await repoOf(a.repo)).id);
      return done({ id, shared: scopes.workspace(id) });
    }),
    asked('open_in_dbcatz', 'Open in DBCatz', 'Opens a table in DBCatz, optionally one row. It only shows it.', { connection: S('A connection id (see list_dbcatz_connections).'), database: S('The database.'), table: S('The table.'), column: S('With value: the row to show.'), value: { type: 'string', maxLength: 500 } }, ['connection', 'database', 'table'], async (a) => q(`Open ${String(a.table)} in DBCatz?`, [{ label: 'In', value: String(a.database) }], null), async (a) => {
      await api.dbcatzOpen({ conn: String(a.connection), db: String(a.database), table: String(a.table), ...(a.column ? { col: String(a.column), val: String(a.value ?? '') } : {}) });
      return done({ opened: true });
    }, true),
    asked('open_in_docatz', 'Open in DoCatz', 'Shows a compose project in DoCatz, ready to Up. Nothing runs from this.', { project: S('The project (see list_docatz_projects).') }, ['project'], async (a) => q(`Open ${String(a.project)} in DoCatz?`, [], null), async (a) => {
      await api.docatzOpen(String(a.project));
      return done({ opened: true });
    }, true),
    asked('set_dbcatz_target', 'Set where Check in DBCatz looks', "A collection's database and optionally a request's table.", { workspace: WORKSPACE, collection: COLLECTION, connection: S('A connection id (see list_dbcatz_connections).'), database: S('The database.'), request: REQUEST, table: S('The table.') }, ['workspace', 'collection', 'connection', 'database'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Point ${collectionOf(w, a.collection).name} at ${String(a.database)}?`, [...fact('Table', a.table)], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      await api.saveDbTarget(w.id, collectionOf(w, a.collection).id, { conn: String(a.connection), db: String(a.database) }, a.request ? requestOf(w, a.request).id : null, a.table ? String(a.table) : null);
      return done({ saved: true });
    }, true),
  ];

  /** Rows for a variable list: a value only where it is no secret; a masked one keeps what is there. */
  const applyVars = (old: EnvVariable[], raw: { name: string; value?: string; enabled?: boolean; secret?: boolean }[]): EnvVariable[] => {
    const next = [...old];
    for (const r of raw) {
      const at = next.findIndex((v) => v.key.trim() === r.name);
      const before = at >= 0 ? next[at] : null;
      const secret = r.secret === true || (before ? isSecretVar(before) : SECRET_NAME.test(r.name));
      if (before && isSecretVar(before) && r.secret === false) throw new Error(`${r.name} is secret: only the user can change that, in Variables`);
      if (secret && r.value !== undefined && r.value !== '' && !r.value.includes(MASK)) throw new Error(`${r.name} is secret: a client never sets its value. Leave value out, and the user fills it in`);
      const value = secret || r.value === undefined || r.value.includes(MASK) ? (before?.value ?? '') : r.value;
      const row: EnvVariable = { key: r.name, value, enabled: r.enabled ?? before?.enabled ?? true, secret: secret || (before?.secret ?? false) };
      if (at >= 0) next[at] = row;
      else next.push(row);
    }
    return next;
  };
  const varRows = { type: 'array', minItems: 1, maxItems: 200, description: 'Variables to add or change; the others stay. A secret one takes no value: the user fills it in, in Variables.', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: S('The name.', 200), value: { type: 'string', maxLength: 10_000 }, enabled: { type: 'boolean' }, secret: { type: 'boolean', description: 'Mark it secret. Only the user can take that off.' } } } };
  const varFacts = (raw: { name: string; value?: string; secret?: boolean }[]): Fact[] => [{ label: 'Variables', value: short(raw.map((r) => (r.secret || SECRET_NAME.test(r.name) ? `${r.name} (secret, you fill it in)` : r.value === undefined ? r.name : `${r.name} = ${r.value}`)).join(', '), 800) }];
  const environments: ChangeAction[] = [
    asked('create_environment', 'Create an environment', 'A new environment in a workspace.', { workspace: WORKSPACE, name: S('Its name.', 200), variables: { ...varRows, minItems: 0 } }, ['workspace', 'name'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Create environment ${String(a.name)}?`, [...inW(w), ...varFacts((a.variables ?? []) as { name: string }[])], { workspaceId: w.id, section: 'environments' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const id = uid('e_');
      await api.saveEnvironment(w.id, { id, name: String(a.name), variables: applyVars([], (a.variables ?? []) as { name: string }[]) });
      return done({ id, name: a.name });
    }, true),
    asked('set_variables', 'Set variables', "Adds or changes an environment's variables; the others stay.", { workspace: WORKSPACE, environment: ENVIRONMENT, variables: varRows }, ['workspace', 'environment', 'variables'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const e = envOfRef(w, a.environment);
      applyVars(e.variables, a.variables as { name: string }[]);
      return q(`Change variables of ${e.name}?`, varFacts(a.variables as { name: string }[]), { workspaceId: w.id, section: 'environments' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const e = envOfRef(w, a.environment);
      await api.saveEnvironment(w.id, { ...e, variables: applyVars(e.variables, a.variables as { name: string }[]) });
      return done({ environment: e.id });
    }, true),
    asked('set_globals', 'Set global variables', "Adds or changes a workspace's global variables; the others stay.", { workspace: WORKSPACE, variables: varRows }, ['workspace', 'variables'], async (a) => {
      const w = await workspaceOf(a.workspace);
      applyVars(w.globals, a.variables as { name: string }[]);
      return q(`Change global variables of ${w.name}?`, varFacts(a.variables as { name: string }[]), { workspaceId: w.id, section: 'environments' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      await api.saveGlobals(w.id, applyVars(w.globals, a.variables as { name: string }[]));
      return done({ saved: true });
    }, true),
    asked('rename_environment', 'Rename an environment', 'Gives an environment a new name.', { workspace: WORKSPACE, environment: ENVIRONMENT, name: S('The new name.', 200) }, ['workspace', 'environment', 'name'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Rename ${envOfRef(w, a.environment).name} to ${String(a.name)}?`, [], { workspaceId: w.id, section: 'environments' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const e = envOfRef(w, a.environment);
      await api.saveEnvironment(w.id, { ...e, name: String(a.name) });
      return done({ environment: e.id });
    }, true),
    asked('set_active_environment', 'Set the default environment', "The workspace's default environment, or null for none.", { workspace: WORKSPACE, environment: { type: ['string', 'null'], maxLength: 512 } }, ['workspace', 'environment'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(a.environment ? `Use ${envOfRef(w, a.environment).name} by default?` : 'Use no environment by default?', inW(w), { workspaceId: w.id });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      await api.setActiveEnvironment(w.id, a.environment ? envOfRef(w, a.environment).id : null);
      return done({ saved: true });
    }, true),
  ];

  /** The window sends: it holds the scripts, inherited auth and history. Waits as long as the request may take. */
  const windowSend = async (what: string, args: Record<string, unknown>, a: Record<string, unknown>, signal: AbortSignal) => {
    const timeout = (await api.settings()).requests.timeoutMs;
    const r = (await command(what, args, timeout + 60_000, signal)) as Parameters<typeof responseOut>[0];
    return done(responseOut(r, await secrets(), a.max_chars));
  };
  const MAX_CHARS = { type: 'integer', minimum: 100, maximum: 200_000, description: 'Cut the body at this many characters; 20000 when left out.' };
  const sending: ChangeAction[] = [
    asked('send_request', 'Send a saved request', 'Sends it the way the Send button does, in its environment, scripts included, and answers with the response, secrets masked. Always asks: it may change something on the server, and carry secrets. It shows up in a tab and in History.', { workspace: WORKSPACE, request: REQUEST, max_chars: MAX_CHARS }, ['workspace', 'request'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const r = requestOf(w, a.request);
      return q(`Send ${r.name}?`, sendFacts(w, r.request!, r, await secrets()), { workspaceId: w.id, itemId: r.id, section: 'requests' });
    }, async (a, ctx) => {
      const w = await workspaceOf(a.workspace);
      return windowSend('send', { workspaceId: w.id, itemId: requestOf(w, a.request).id }, a, ctx.signal);
    }),
    asked('send_new_request', 'Send a new request', 'Sends a request that is not saved, in a new tab, and answers with the response, secrets masked. Always asks. Logins and secret-looking headers must be {{variables}}.', { workspace: WORKSPACE, name: S('A name for its tab.', 200), max_chars: MAX_CHARS, ...REQUEST_FIELDS }, ['workspace', 'method', 'url'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Send ${String(a.method)} request?`, sendFacts(w, specFrom(a), null, await secrets()), { workspaceId: w.id, section: 'requests' });
    }, async (a, ctx) => {
      const w = await workspaceOf(a.workspace);
      return windowSend('sendNew', { workspaceId: w.id, spec: specFrom(a), name: a.name ?? `${String(a.method)} ${String(a.url)}` }, a, ctx.signal);
    }),
    stopper('cancel_send', 'Stop sending', 'Stops a request being sent (tab id from list_open_tabs). Asks nothing: it only stops.', { tab: S('The tab.') }, ['tab'], async (a) => done(await command('cancelSend', { tab: String(a.tab) }, 3000))),
    asked('run_collection', 'Run a collection', 'Every request of a collection or folder in order, with its scripts, in its environment. Answers within seconds; the run goes on: get_run_results shows how far it is, stop_run stops it. Tell the user how it went.', { workspace: WORKSPACE, target: S('The collection or folder (id or name).'), iterations: { type: 'integer', minimum: 1, maximum: 1000 }, delay_ms: { type: 'integer', minimum: 0, maximum: 60_000 }, stop_on_failure: { type: 'boolean' } }, ['workspace', 'target'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const t = containerOf(w, a.target);
      const inside = underCollection(w.items, t.id).filter((i) => i.kind === 'request' && i.request);
      if (!inside.length) throw new Error(`${t.name} has no requests`);
      const list = await secrets();
      const facts = inside.map((i) => sendFacts(w, i.request!, i, list));
      const uniq = (label: string) => [...new Set(facts.flatMap((f) => f.filter((x) => x.label === label).map((x) => x.value)))].join(', ');
      return q(`Run ${t.name}?`, [{ label: 'Requests', value: `${inside.length}, ${inside.filter((i) => !['GET', 'HEAD', 'OPTIONS'].includes(i.request!.method)).length} of them can change something` }, ...fact('Times', a.iterations), ...fact('Goes to', uniq('Goes to')), ...fact('Carries', uniq('Carries')), ...fact('Script', uniq('Script'))], { workspaceId: w.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const t = containerOf(w, a.target);
      return done(await command('run', { workspaceId: w.id, target: t.id, iterations: a.iterations ?? 1, delay: a.delay_ms ?? 0, stopOnFail: a.stop_on_failure === true }, 5000));
    }),
    stopper('stop_run', 'Stop the run', 'Stops the collection run. Asks nothing: it only stops.', {}, [], async () => done(await command('stopRun', {}, 3000))),
    asked('websocket_connect', 'Connect a WebSocket', 'Opens a saved WebSocket request (a ws:// or wss:// URL) in a tab and connects it. get_response gives its messages.', { workspace: WORKSPACE, request: REQUEST }, ['workspace', 'request'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const r = requestOf(w, a.request);
      return q(`Connect ${r.name}?`, sendFacts(w, r.request!, r, await secrets()), { workspaceId: w.id, itemId: r.id, section: 'requests' });
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      return done(await command('wsConnect', { workspaceId: w.id, itemId: requestOf(w, a.request).id }, 10_000));
    }),
    asked('websocket_send', 'Send a WebSocket message', 'Sends a text message on a connected WebSocket tab (id from list_open_tabs).', { tab: S('The tab.'), text: S('The message; may use {{variables}}.', 1_000_000) }, ['tab', 'text'], async (a) => q('Send this message?', [{ label: 'Message', value: short(maskText(String(a.text), await secrets()), 500) }], null), async (a) => done(await command('wsSend', { tab: String(a.tab), text: noMask(String(a.text), 'The message') }, 5000)), false),
    stopper('websocket_close', 'Close a WebSocket', 'Closes a WebSocket tab’s connection. Asks nothing: it only stops.', { tab: S('The tab.') }, ['tab'], async (a) => done(await command('wsClose', { tab: String(a.tab) }, 5000))),
  ];

  const team: ChangeAction[] = [
    asked('sync_workspace', 'Sync a team workspace', 'Pulls, then pushes the local changes of a team workspace.', { workspace: WORKSPACE }, ['workspace'], async (a) => {
      const w = await workspaceOf(a.workspace);
      if (!w.serverId) throw new Error(`${w.name} is not a team workspace`);
      return q(`Sync ${w.name}?`, [{ label: 'With', value: 'Your team’s DialCatz Den' }], { workspaceId: w.id });
    }, async (a) => {
      const w = await api.syncWorkspace((await workspaceOf(a.workspace)).id);
      return done({ syncedAt: w.syncedAt ?? null, ...(w.syncError ? { syncError: maskText(w.syncError, []) } : {}), conflicts: (w.conflicts ?? []).length });
    }, true),
    asked('resolve_conflict', 'Settle a sync conflict', "keep mine: sends my version over the teammate's. keep theirs: drops my change.", { workspace: WORKSPACE, item: S('The id from get_sync_state.'), keep: { type: 'string', enum: ['mine', 'theirs'] } }, ['workspace', 'item', 'keep'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const c = (w.conflicts ?? []).find((x) => x.id === a.item);
      if (!c) throw new Error(`No conflict ${String(a.item)} (get_sync_state shows them)`);
      return q(`Settle the conflict on ${c.name}?`, [{ label: 'Keeps', value: a.keep === 'mine' ? `Yours, over ${c.by ?? 'the teammate'}'s` : `${c.by ?? 'The teammate'}'s. Your change is dropped` }, { label: 'Differs', value: c.fields.join(', ') }], { workspaceId: w.id });
    }, async (a) => {
      await api.resolveConflict((await workspaceOf(a.workspace)).id, String(a.item), a.keep as 'mine' | 'theirs');
      return done({ settled: true });
    }),
    asked('refresh_team_server', 'Refresh a team server', 'Asks a DialCatz Den who you are and which workspaces it offers.', { server: S('The id from list_team_servers.') }, ['server'], async (a) => q('Refresh this team server?', [{ label: 'Server', value: String(a.server) }], { section: 'team' }), async (a) => done({ workspaces: (await api.refreshServer(String(a.server))).workspaceIds.length }), true),
    asked('show_team_workspace', 'Show or hide a team workspace', "Shows or hides one of a Den's workspaces in the app.", { server: S('The id from list_team_servers.'), workspace_id: S("The workspace's id on it."), on: { type: 'boolean' } }, ['server', 'workspace_id', 'on'], async (a) => q(`${a.on ? 'Show' : 'Hide'} this team workspace?`, [{ label: 'Id', value: String(a.workspace_id) }], { section: 'team' }), async (a) => done({ shown: (await api.subscribeWorkspace(String(a.server), String(a.workspace_id), a.on === true)).workspaceIds })),
  ];

  const app: ChangeAction[] = [
    asked('set_settings', 'Change settings', 'The theme and the request defaults. Never the AI connection, its keys, or MCatzP.', { theme: { type: 'string', enum: ['system', 'light', 'dark'] }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 600_000 }, follow_redirects: { type: 'boolean' }, skip_tls_checks: { type: 'boolean', description: 'Certificate checks off for every request.' } }, [], async (a) => q('Change these settings?', [...fact('Theme', a.theme), ...fact('Timeout', a.timeout_ms ? `${String(a.timeout_ms)} ms` : null), ...fact('Redirects', a.follow_redirects === undefined ? null : a.follow_redirects ? 'Follow' : 'Do not follow'), ...fact('TLS', a.skip_tls_checks === undefined ? null : a.skip_tls_checks ? 'Certificate checks OFF for every request' : 'Certificate checks on')], { section: 'settings' }), async (a) => {
      const patch: DialCatzSettingsPatch = { ...(a.theme ? { theme: a.theme as 'system' | 'light' | 'dark' } : {}), requests: { ...(a.timeout_ms ? { timeoutMs: Number(a.timeout_ms) } : {}), ...(a.follow_redirects === undefined ? {} : { followRedirects: a.follow_redirects === true }), ...(a.skip_tls_checks === undefined ? {} : { insecure: a.skip_tls_checks === true }) } };
      await api.setSettings(patch);
      settingsChanged();
      return done({ saved: true });
    }),
    asked('check_for_updates', 'Check for updates', 'Asks the Catzoid site for a newer DialCatz. get_app_info shows the answer.', {}, [], async () => q('Check for a new DialCatz?', [], null), async () => done({ update: (await api.updateCheck()).kind }), true),
    asked('download_update', 'Download the update', 'Downloads the update on offer. get_app_info shows how far it is. Installing stays the user’s.', {}, [], async () => {
      const u = await api.updateState();
      if (u.kind !== 'available') throw new Error('No update is on offer (check_for_updates)');
      return q(`Download DialCatz ${u.version}?`, [], null);
    }, async () => {
      void api.updateDownload().catch(() => undefined);
      return done({ started: true, note: 'Still downloading: get_app_info shows its progress.' });
    }),
    stopper('cancel_update_download', 'Stop the update download', 'Stops the update download. Asks nothing: it only stops.', {}, [], async () => {
      await api.updateCancel();
      return done({ stopped: true });
    }),
    asked('skip_update', 'Skip an update', 'No more offers for this version.', { version: S('The version.', 40) }, ['version'], async (a) => q(`Skip DialCatz ${String(a.version)}?`, [], null), async (a) => {
      await api.updateSkip(String(a.version));
      return done({ skipped: a.version });
    }),
    asked('set_update_prefs', 'Change update settings', 'Automatic checks, the channel and notifications.', { auto: { type: 'boolean' }, channel: { type: 'string', enum: ['stable', 'beta'] }, notify: { type: 'boolean' } }, [], async (a) => q('Change update settings?', [...fact('Automatic', a.auto), ...fact('Channel', a.channel), ...fact('Notify', a.notify)], { section: 'settings' }), async (a) => done({ prefs: await api.setUpdatePrefs(a as { auto?: boolean; channel?: 'stable' | 'beta'; notify?: boolean }) })),
  ];

  const onRepo = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], ask: (r: GitRepoEntry, a: Record<string, unknown>) => Promise<{ title: string; facts: Fact[] }> | { title: string; facts: Fact[] }, run: (r: GitRepoEntry, a: Record<string, unknown>) => Promise<unknown>, session = false) =>
    asked(name, title, description, { repo: REPO, ...props }, ['repo', ...required], async (a) => {
      const r = await repoOf(a.repo);
      const x = await ask(r, a);
      return { ...x, facts: [{ label: 'Repo', value: r.name }, ...x.facts], page: { section: 'git' as const } };
    }, async (a) => {
      const out = await run(await repoOf(a.repo), a);
      return done(out ?? { done: true });
    }, session);
  const filesFact = (a: Record<string, unknown>): Fact => ({ label: 'Files', value: short((a.files as string[]).join(', ')) });
  const git: ChangeAction[] = [
    onRepo('git_init', 'Start a Git repository', 'Makes the folder a Git repository.', {}, [], () => ({ title: 'Start a Git repository?', facts: [] }), (r) => api.gitInit(r.id)),
    onRepo('git_stage', 'Stage files', 'Stages files for the next commit.', { files: FILES }, ['files'], (_r, a) => ({ title: 'Stage these files?', facts: [filesFact(a)] }), (r, a) => api.gitStage(r.id, a.files as string[]), true),
    onRepo('git_unstage', 'Unstage files', 'Takes files out of the next commit; their changes stay.', { files: FILES }, ['files'], (_r, a) => ({ title: 'Unstage these files?', facts: [filesFact(a)] }), (r, a) => api.gitUnstage(r.id, a.files as string[]), true),
    onRepo('git_commit', 'Commit', 'Commits what is staged.', { message: S('The commit message.', 5000) }, ['message'], (_r, a) => ({ title: 'Commit this?', facts: [{ label: 'Message', value: short(String(a.message)) }] }), (r, a) => api.gitCommit(r.id, String(a.message), false)),
    onRepo('git_sync', 'Fetch, pull or push', 'Output: git_sync_log. A force push is not offered here.', { action: { type: 'string', enum: ['fetch', 'pull', 'pull-rebase', 'push'] } }, ['action'], (_r, a) => ({ title: `${String(a.action)}?`, facts: [] }), (r, a) => api.gitSync(r.id, a.action as GitSyncAction)),
    stopper('git_cancel', 'Stop a Git operation', 'Stops the fetch, pull or push running. Asks nothing: it only stops.', { repo: REPO }, ['repo'], async (a) => {
      await api.gitCancel((await repoOf(a.repo)).id);
      return done({ stopped: true });
    }),
    onRepo('git_branch', 'Create, switch or merge a branch', 'Deleting a branch is not offered here.', { action: { type: 'string', enum: ['create', 'switch', 'merge'] }, name: S('The branch.', 300), from: S('create: start from this.', 300) }, ['action', 'name'], (_r, a) => ({ title: `${a.action === 'create' ? 'Create' : a.action === 'switch' ? 'Switch to' : 'Merge'} branch ${String(a.name)}?`, facts: fact('From', a.from) }), (r, a) => api.gitBranch(r.id, a.action as 'create' | 'switch' | 'merge', String(a.name), a.from ? String(a.from) : undefined)),
    onRepo('git_stash', 'Stash', 'save: puts the changes aside. apply / pop: brings a stash back. Dropping one is not offered here.', { action: { type: 'string', enum: ['save', 'apply', 'pop'] }, arg: { type: 'string', maxLength: 500, description: 'save: a message. apply / pop: the ref from git_stashes.' } }, ['action'], (_r, a) => ({ title: `${String(a.action)} stash?`, facts: fact('Stash', a.arg) }), (r, a) => api.gitStash(r.id, a.action as 'save' | 'apply' | 'pop', String(a.arg ?? ''))),
    onRepo('git_tag', 'Create or push a tag', 'Deleting a tag is not offered here.', { action: { type: 'string', enum: ['create', 'push'] }, name: S('The tag.', 300), message: { type: 'string', maxLength: 5000 } }, ['action', 'name'], (_r, a) => ({ title: `${a.action === 'create' ? 'Create' : 'Push'} tag ${String(a.name)}?`, facts: fact('Message', a.message) }), (r, a) => api.gitTag(r.id, a.action as 'create' | 'push', String(a.name), a.message ? String(a.message) : undefined)),
    onRepo('git_operation', 'Rebase, or go on with one in progress', 'rebase onto a branch; continue, skip or abort the merge, rebase or cherry-pick in progress.', { action: { type: 'string', enum: ['rebase', 'continue', 'skip', 'abort'] }, onto: S('rebase: the branch.', 300) }, ['action'], (_r, a) => ({ title: `${String(a.action)}?`, facts: fact('Onto', a.onto) }), (r, a) => api.gitOperation(r.id, a.action as 'rebase' | 'continue' | 'skip' | 'abort', a.onto ? String(a.onto) : undefined)),
    onRepo('git_squash', 'Squash', "Squashes the branch's commits since it left `onto` into one.", { onto: S('The branch.', 300), message: S('The commit message.', 5000) }, ['onto', 'message'], (_r, a) => ({ title: `Squash onto ${String(a.onto)}?`, facts: [{ label: 'Message', value: short(String(a.message)) }] }), (r, a) => api.gitSquash(r.id, String(a.onto), String(a.message))),
    onRepo('git_cherry_pick', 'Cherry-pick', 'Applies a commit on the current branch.', { sha: S('The commit.', 100) }, ['sha'], (_r, a) => ({ title: `Cherry-pick ${String(a.sha).slice(0, 12)}?`, facts: [] }), (r, a) => api.gitCherryPick(r.id, String(a.sha))),
    onRepo('git_revert', 'Revert a commit', 'A new commit that undoes it.', { sha: S('The commit.', 100) }, ['sha'], (_r, a) => ({ title: `Revert ${String(a.sha).slice(0, 12)}?`, facts: [] }), (r, a) => api.gitRevert(r.id, String(a.sha))),
    onRepo('git_restore_file', 'Restore a file', 'Puts one file back to how it was in a commit (staged). Commit before if you want its changes back.', { file: S('The path.', 1000), sha: S('The commit.', 100) }, ['file', 'sha'], (_r, a) => ({ title: `Restore ${String(a.file)}?`, facts: [{ label: 'From', value: String(a.sha).slice(0, 12) }] }), (r, a) => api.gitRestoreFile(r.id, String(a.file), String(a.sha))),
    onRepo('gitignore_add', 'Add to .gitignore', 'Adds lines to .gitignore.', { lines: { type: 'array', minItems: 1, maxItems: 100, items: S('A line.', 500) } }, ['lines'], (_r, a) => ({ title: 'Add to .gitignore?', facts: [{ label: 'Lines', value: short((a.lines as string[]).join(', ')) }] }), (r, a) => api.gitIgnoreAdd(r.id, a.lines as string[]), true),
    onRepo('gitignore_save', 'Write .gitignore', 'Replaces .gitignore.', { content: { type: 'string', maxLength: 200_000 } }, ['content'], (_r, a) => ({ title: 'Replace .gitignore?', facts: [{ label: 'Content', value: short(String(a.content)) }] }), (r, a) => api.gitignoreSave(r.id, String(a.content))),
    onRepo('git_set_identity', 'Set the commit identity', 'Name and email for commits, in this repository or for all.', { name: S('The name.', 200), email: S('The email.', 200), global: { type: 'boolean' } }, ['name', 'email'], (_r, a) => ({ title: 'Set the commit identity?', facts: [{ label: 'As', value: `${String(a.name)} <${String(a.email)}>` }, { label: 'For', value: a.global ? 'Every repository on this computer' : 'This repository' }] }), (r, a) => api.gitSetIdentity(r.id, String(a.name), String(a.email), a.global === true)),
    onRepo('git_add_remote', 'Add a remote', 'Adds a remote.', { name: S('The name.', 100), url: S('The URL.', 1000) }, ['name', 'url'], (_r, a) => ({ title: `Add remote ${String(a.name)}?`, facts: [{ label: 'URL', value: maskUrl(String(a.url), []) }] }), (r, a) => api.gitAddRemote(r.id, String(a.name), String(a.url))),
    onRepo('git_worktree_add', 'Add a worktree', 'The user picks the folder in a dialog.', { branch: S('The branch.', 300), create: { type: 'boolean', description: 'A new branch.' }, from: S('create: start from this.', 300) }, ['branch'], (_r, a) => ({ title: `Add a worktree for ${String(a.branch)}?`, facts: [{ label: 'Folder', value: 'You pick it next' }] }), async (r, a) => ({ added: !!(await api.gitWorktreeAdd(r.id, String(a.branch), a.create === true, a.from ? String(a.from) : undefined)) })),
    onRepo('git_worktree_prune', 'Prune worktrees', 'Forgets worktrees whose folders are gone.', {}, [], () => ({ title: 'Prune worktrees?', facts: [] }), (r) => api.gitWorktreePrune(r.id)),
    onRepo('git_create_pull', 'Create a pull request', 'On the host of the repository.', { title: S('The title.', 300), body: { type: 'string', maxLength: 50_000 }, base: S('The base branch.', 300), draft: { type: 'boolean' } }, ['title', 'base'], (_r, a) => ({ title: 'Open this pull request?', facts: [{ label: 'Title', value: String(a.title) }, { label: 'Into', value: String(a.base) }, ...fact('Draft', a.draft ? 'Yes' : null)] }), async (r, a) => {
      const p = await api.gitCreatePull(r.id, String(a.title), String(a.body ?? ''), String(a.base), a.draft === true);
      return { number: p.number, url: p.url };
    }),
    onRepo('git_checkout_pull', 'Check out a pull request', 'Switches to its branch.', { number: { type: 'integer', minimum: 1 } }, ['number'], (_r, a) => ({ title: `Check out pull request #${String(a.number)}?`, facts: [] }), async (r, a) => {
      const p = (await api.gitPulls(r.id)).find((x: GitPull) => x.number === a.number);
      if (!p) throw new Error(`No open pull request #${String(a.number)} (git_pulls shows them)`);
      await api.gitCheckoutPull(r.id, p);
      return { branch: p.head };
    }),
    asked('git_clone', 'Clone a repository', 'Clones into parent/name and adds it to the Git section; parent is the usual clone folder when left out. Answers quickly: list_git_repos shows when it is there.', { url: S('The URL.', 1000), name: S('The new folder.', 200), parent: S('The folder to clone into (full path).', 1000), branch: S('A branch.', 300), shallow: { type: 'boolean' } }, ['url', 'name'], async (a) => q('Clone this repository?', [{ label: 'From', value: maskUrl(String(a.url), []) }, { label: 'Into', value: `${String(a.parent ?? (await api.gitState()).cloneDir)}/${String(a.name)}` }], { section: 'git' }), async (a) => {
      const parent = String(a.parent ?? (await api.gitState()).cloneDir);
      void api.gitClone(String(a.url), parent, String(a.name), String(a.branch ?? ''), a.shallow === true).catch(() => undefined);
      return done({ started: true, note: 'Still cloning: list_git_repos shows it once it is there.' });
    }),
    stopper('git_cancel_clone', 'Stop the clone', 'Stops the clone running. Asks nothing: it only stops.', {}, [], async () => {
      await api.gitCancelClone();
      return done({ stopped: true });
    }),
    asked('git_create_remote_repo', 'Create a repository on an account', 'A new empty repository on a connected account.', { account: S('The account id from list_git_repos.'), name: S('The name.', 200), private: { type: 'boolean' }, description: { type: 'string', maxLength: 500 } }, ['account', 'name'], async (a) => q(`Create repository ${String(a.name)}?`, [{ label: 'Who sees', value: a.private === false ? 'Everyone: it is public' : 'Private' }, ...fact('About', a.description)], { section: 'git' }), async (a) => {
      const r = await api.gitCreateRemoteRepo(String(a.account), String(a.name), a.private !== false, String(a.description ?? ''));
      return done({ fullName: r.fullName });
    }),
    asked('folder_git_commit', "Commit a workspace's files", "Commits this folder workspace's files only, never the rest of the repository.", { workspace: WORKSPACE, message: S('The commit message.', 5000) }, ['workspace', 'message'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`Commit ${w.name}'s files?`, [{ label: 'Message', value: short(String(a.message)) }], { workspaceId: w.id });
    }, async (a) => {
      await api.folderGitCommit((await workspaceOf(a.workspace)).id, String(a.message));
      return done({ done: true });
    }),
    asked('folder_git_sync', "Pull or push a workspace's repository", 'Pull or push a folder workspace.', { workspace: WORKSPACE, action: { type: 'string', enum: ['pull', 'push'] } }, ['workspace', 'action'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return q(`${a.action === 'pull' ? 'Pull' : 'Push'} ${w.name}?`, [], { workspaceId: w.id });
    }, async (a) => {
      const id = (await workspaceOf(a.workspace)).id;
      if (a.action === 'pull') {
        const r = await api.folderGitPull(id);
        return done({ merged: r.merged, conflicts: r.conflicts });
      }
      await api.folderGitPush(id);
      return done({ pushed: true });
    }),
    asked('folder_git_init', 'Start Git in a workspace folder', 'Makes a folder workspace a Git repository.', { workspace: WORKSPACE }, ['workspace'], async (a) => q(`Start a Git repository in ${(await workspaceOf(a.workspace)).name}'s folder?`, [], null), async (a) => {
      await api.folderGitInit((await workspaceOf(a.workspace)).id);
      return done({ done: true });
    }),
    asked('folder_git_abort_merge', "Abort a workspace's merge", 'Stops a merge in progress in a folder workspace; your side stays.', { workspace: WORKSPACE }, ['workspace'], async (a) => q(`Abort the merge in ${(await workspaceOf(a.workspace)).name}?`, [], null), async (a) => {
      await api.folderGitAbortMerge((await workspaceOf(a.workspace)).id);
      return done({ done: true });
    }),
    asked('folder_git_connect', 'Connect a workspace to a remote', "Connects a folder workspace's repository to a remote (origin) and fetches it.", { workspace: WORKSPACE, url: S('The URL.', 1000) }, ['workspace', 'url'], async (a) => q(`Connect ${(await workspaceOf(a.workspace)).name} to this remote?`, [{ label: 'URL', value: maskUrl(String(a.url), []) }], null), async (a) => {
      const r = await api.folderGitConnect((await workspaceOf(a.workspace)).id, String(a.url));
      return done({ merged: r.merged, conflicts: r.conflicts });
    }),
  ];

  return [...requests, ...imports, ...environments, ...sending, ...team, ...app, ...(scopes.git ? git : [])];
}
