import { computed, reactive, ref, toRaw, watch } from 'vue';
import { newRequest, uid, type ConnectRequest, type DialCatzSettings, type Environment, type EnvVariable, type PresenceEntry, type WsEvent, type HistoryEntry, type RequestAuth, type RequestSpec, type SendResult, type ServerConnection, type TreeItem, type Workspace, type WorkspaceSummary } from '@shared/types';
import { AUTO_HEADERS, buildVars, effectiveAuth, interpolate, nameFromUrl, toWire, type Vars } from '@shared/request';
import { store } from './store';
import { requestContext, responseContext, runScript, type ScriptResult } from './scripts';

/**
 * The window's state: settings, the workspace on screen, open request tabs and their responses. Everything that
 * lasts goes through window.dialcatz (main process); tabs are kept in localStorage so a restart reopens them.
 */

export type Section = 'requests' | 'environments' | 'history' | 'git' | 'team' | 'settings';

export interface Tab {
  id: string;
  /** The saved request it edits (null: a scratch request). */
  itemId: string | null;
  workspaceId: string;
  name: string;
  spec: RequestSpec;
  /** Differs from the saved request. */
  dirty: boolean;
  sending: boolean;
  result: SendResult | null;
  sentAt?: string;
  /** Results of the request's scripts for the last send. */
  scripts?: { pre?: ScriptResult; tests?: ScriptResult };
  /** WebSocket tabs (ws:// or wss:// URL): connection state, message log and the message being written. */
  ws?: { state: 'idle' | 'connecting' | 'open' | 'closed'; log: WsEvent[]; draft: string };
}

const api = window.dialcatz;
/** IPC can only clone plain data. */
export const plain = <T>(v: T): T => JSON.parse(JSON.stringify(toRaw(v)));

export const section = ref<Section>('requests');
/** Variables has unsaved edits: leaving the section asks first (pendingSection is where the user wanted to go). */
export const envDirty = ref(false);
export const pendingSection = ref<Section | null>(null);
export function goSection(s: Section): void {
  if (section.value === 'environments' && envDirty.value && s !== 'environments') pendingSection.value = s;
  else section.value = s;
}
/** Open the Import dialog on a tab (a dialcatz://open?site= link from DevCatz, the Postman shortcut …). */
export const importRequest = ref<{ tab: 'choose' | 'file' | 'postman' | 'devcatz'; siteId?: string } | null>(null);
/** A dialcatz://connect request waiting for the user's yes (from a link, or pasted on the Team page). */
export const connectRequest = ref<ConnectRequest | null>(null);
export const settings = ref<DialCatzSettings | null>(null);
export const workspaces = ref<WorkspaceSummary[]>([]);
export const workspace = ref<Workspace | null>(null);
export const servers = ref<ServerConnection[]>([]);
export const history = ref<HistoryEntry[]>([]);
export const tabs = ref<Tab[]>([]);
export const activeTabId = ref<string | null>(null);
export const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) ?? null);

export const toast = reactive<{ kind: 'success' | 'error' | 'warning' | 'info'; text: string; at: number }>({ kind: 'info', text: '', at: 0 });
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function notify(kind: typeof toast.kind, text: string): void {
  Object.assign(toast, { kind, text, at: Date.now() });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.text = ''), kind === 'error' ? 6000 : 3200);
}
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) notify('success', ok);
    return r;
  } catch (e) {
    notify('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

// ------------------------------------------------------------------ presence (team workspaces)

export const presence = ref<Record<string, PresenceEntry[]>>({});
/** Item id → names of teammates who have it open (this device left out). */
export const presenceByItem = computed<Record<string, string[]>>(() => {
  const w = workspace.value;
  if (!w?.serverId) return {};
  const me = servers.value.find((s) => s.id === w.serverId)?.identity;
  const out: Record<string, string[]> = {};
  for (const p of presence.value[w.id] ?? []) {
    if (!p.itemId || (p.memberId === me?.member.id && p.device === me?.device)) continue;
    (out[p.itemId] ??= []).push(p.memberId === me?.member.id ? `${p.name} (${p.device})` : p.name);
  }
  return out;
});
watch(
  () => [workspace.value?.id, workspace.value?.serverId, activeTabId.value] as const,
  () => {
    const w = workspace.value;
    if (!w?.serverId) return;
    const t = tabs.value.find((x) => x.id === activeTabId.value && x.workspaceId === w.id);
    void api.setPresence(w.id, t?.itemId ?? null);
  },
);

/** Is AI on in DialCatz and this feature not switched off (Settings → AI)? */
export const aiOn = (feature: import('@shared/types').AiFeature) => !!settings.value?.ai.enabled && !settings.value.ai.off.includes(feature);
export const askOpen = ref(false);
/** Settings page tab (General / AI / Updates / About), like DBCatz. */
export const settingsTab = ref<'general' | 'ai' | 'updates' | 'about'>('general');
/** The update check / download (Catzoid #54) and whether its dialog is open. */
export const updateState = ref<import('@shared/types').UpdateState>({ kind: 'idle' });
export const updateOpen = ref(false);
/** The Report a Bug / Send Feedback dialog (Catzoid #65), and the Uninstall dialog (#55). */
export const reportOpen = ref<import('@shared/types').ReportKind | null>(null);
export const uninstallOpen = ref(false);

export const readOnly = computed(() => !!workspace.value?.serverId && workspace.value.role === 'viewer');

// ------------------------------------------------------------------ variables

/** The collection an item is in (itself for a collection). */
export function collectionOf(itemId: string | null, w: Workspace | null = workspace.value): TreeItem | null {
  const items = w?.items ?? [];
  let cur = items.find((i) => i.id === itemId);
  for (let n = 0; cur && n < 50; n++) {
    if (cur.kind === 'collection') return cur;
    cur = items.find((i) => i.id === cur!.parentId);
  }
  return null;
}

/** The workspace's default environment: for scratch tabs and collections that do not pick their own. */
export const defaultEnvironment = computed(() => workspace.value?.environments.find((e) => e.id === workspace.value?.activeEnvironmentId) ?? null);

/** The environment an item's requests use: its collection's own choice, else the workspace default. */
export function envFor(itemId: string | null, w: Workspace | null = workspace.value): Environment | null {
  const c = collectionOf(itemId, w);
  if (c && c.environmentId !== undefined) {
    if (c.environmentId === null) return null;
    const own = w?.environments.find((e) => e.id === c.environmentId);
    if (own) return own;
  }
  return w?.environments.find((e) => e.id === w.activeEnvironmentId) ?? null;
}
export const varsFor = (itemId: string | null) => buildVars(workspace.value?.globals, envFor(itemId)?.variables);

/** The environment in effect for the active tab (what {{variables}} in the editor show). */
export const activeEnvironment = computed(() => {
  const t = activeTab.value;
  return envFor(t && t.workspaceId === workspace.value?.id ? t.itemId : null);
});
export const vars = computed<Vars>(() => buildVars(workspace.value?.globals, activeEnvironment.value?.variables));
export const knownVar = (name: string) => vars.value.has(name);

/** Auth from the folders / collection above an item, nearest first. */
export function inheritedAuth(itemId: string | null, w: Workspace | null = workspace.value): RequestAuth[] {
  const out: RequestAuth[] = [];
  if (!w || !itemId) return out;
  let cur = w.items.find((i) => i.id === itemId);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = w.items.find((i) => i.id === cur!.parentId);
    if (cur?.auth) out.push(cur.auth);
  }
  return out;
}

export const appVersion = ref('0.1.0');
export function wireFor(tab: Tab) {
  return toWire(tab.spec, varsFor(tab.itemId), effectiveAuth(tab.spec.auth, inheritedAuth(tab.itemId)), { version: appVersion.value });
}

/** A new request, with the auto headers Settings → Requests switched off for new requests. */
export function freshRequest(): RequestSpec {
  const on = settings.value?.requests.autoHeaders ?? {};
  return { ...newRequest(), autoOff: AUTO_HEADERS.filter((a) => on[a.key] === false).map((a) => a.key) };
}

/** Where a {{variable}} gets its value: the active environment, else the workspace's globals. */
export function varSource(name: string): { where: 'environment' | 'globals' | null; envId: string | null; label: string; variable: EnvVariable | null } {
  const env = activeEnvironment.value;
  const inEnv = env?.variables.find((v) => v.enabled && v.key.trim() === name);
  if (env && inEnv) return { where: 'environment', envId: env.id, label: env.name, variable: inEnv };
  const g = workspace.value?.globals.find((v) => v.enabled && v.key.trim() === name);
  if (g) return { where: 'globals', envId: null, label: 'Globals', variable: g };
  return { where: null, envId: env?.id ?? null, label: env?.name ?? 'Globals', variable: null };
}

/** Sets a variable's value where it lives (or adds it to the active environment, else to the globals). */
export async function setVarValue(name: string, value: string): Promise<boolean> {
  const w = workspace.value;
  if (!w) return false;
  const src = varSource(name);
  const upsert = (list: EnvVariable[]) => (list.some((v) => v.key.trim() === name) ? list.map((v) => (v.key.trim() === name ? { ...v, value, enabled: true } : v)) : [...list, { key: name, value, enabled: true, secret: false }]);
  const env = src.envId ? w.environments.find((e) => e.id === src.envId) : null;
  const next = await attempt(() => (src.where !== 'globals' && env ? window.dialcatz.saveEnvironment(w.id, plain({ ...env, variables: upsert(env.variables) })) : window.dialcatz.saveGlobals(w.id, plain(upsert(w.globals)))), 'Variable saved');
  if (next) setWorkspace(next);
  return !!next;
}

/** Variables page: which environment (or '__globals') and variable to show when it opens. */
export const envFocus = ref<{ envId: string; key: string } | null>(null);
export function openVariable(name: string): void {
  const src = varSource(name);
  envFocus.value = { envId: src.where === 'globals' || !src.envId ? '__globals' : src.envId, key: name };
  goSection('environments');
}

// ------------------------------------------------------------------ loading

export async function loadSettings(): Promise<void> {
  settings.value = await api.settings();
  appVersion.value = (await api.appInfo()).version;
}

export async function loadWorkspaces(selectId?: string): Promise<void> {
  workspaces.value = await api.workspaces();
  servers.value = await api.servers();
  const want = selectId ?? workspace.value?.id ?? store.get('workspace', '');
  const id = workspaces.value.find((w) => w.id === want)?.id ?? workspaces.value[0]?.id;
  if (id) workspace.value = await api.workspace(id);
  else workspace.value = null;
}

export async function selectWorkspace(id: string): Promise<void> {
  workspace.value = await api.workspace(id);
  store.set('workspace', id);
}

export async function reloadWorkspace(): Promise<void> {
  if (workspace.value) workspace.value = await api.workspace(workspace.value.id);
}

export function setWorkspace(w: Workspace): void {
  if (w.id === workspace.value?.id) workspace.value = w;
}

// A new sync conflict (TODO #41) says so once; the bar under the workspace picker stays until it is settled.
const seenConflicts = new Set<string>();
watch(
  () => workspace.value?.conflicts ?? [],
  (list) => {
    const fresh = list.filter((c) => !seenConflicts.has(`${c.id}|${c.at}`));
    fresh.forEach((c) => seenConflicts.add(`${c.id}|${c.at}`));
    if (fresh.length) notify('info', fresh.length === 1 ? `${fresh[0].by ?? 'A teammate'} changed “${fresh[0].name}” at the same time as you — Review it under the workspace name` : `${fresh.length} of your changes met a teammate's — Review them under the workspace name`);
  },
);

export async function loadHistory(): Promise<void> {
  history.value = await api.history();
}

// ------------------------------------------------------------------ tabs

const TABS_KEY = 'tabs';
interface SavedTabs {
  tabs: Omit<Tab, 'sending' | 'result' | 'ws' | 'scripts'>[];
  active: string | null;
}

export function restoreTabs(): void {
  const s = store.get<SavedTabs | null>(TABS_KEY, null);
  if (!s?.tabs?.length) return;
  tabs.value = s.tabs.map((t) => ({ ...t, sending: false, result: null }));
  activeTabId.value = s.active && tabs.value.some((t) => t.id === s.active) ? s.active : tabs.value[0].id;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  [tabs, activeTabId],
  () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set<SavedTabs>(TABS_KEY, { tabs: tabs.value.map(({ sending: _s, result: _r, ws: _w, scripts: _sc, ...t }) => plain(t)), active: activeTabId.value }), 300);
  },
  { deep: true },
);

/** Tabs of the workspace on screen. */
export const workspaceTabs = computed(() => tabs.value.filter((t) => t.workspaceId === workspace.value?.id));

export function openItem(item: TreeItem): void {
  if (item.kind !== 'request' || !workspace.value) return;
  const open = tabs.value.find((t) => t.itemId === item.id && t.workspaceId === workspace.value!.id);
  if (open) {
    activeTabId.value = open.id;
    return;
  }
  const tab: Tab = { id: uid('t_'), itemId: item.id, workspaceId: workspace.value.id, name: item.name, spec: plain(item.request ?? newRequest()), dirty: false, sending: false, result: null };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  section.value = 'requests';
}

export function newTab(spec: RequestSpec = freshRequest(), name = 'Untitled request'): Tab | null {
  if (!workspace.value) return null;
  const tab: Tab = { id: uid('t_'), itemId: null, workspaceId: workspace.value.id, name, spec, dirty: false, sending: false, result: null };
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  section.value = 'requests';
  return tab;
}

export function closeTab(id: string): void {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  const wasActive = activeTabId.value === id;
  tabs.value[i].sending && void api.cancel(id);
  if (tabs.value[i].ws) void api.wsClose(id);
  tabs.value.splice(i, 1);
  if (wasActive) {
    const rest = workspaceTabs.value;
    activeTabId.value = rest[Math.min(i, rest.length - 1)]?.id ?? null;
  }
}

/** Keeps open tabs in step when items are renamed or removed. */
export function syncTabsWithWorkspace(w: Workspace): void {
  for (const t of tabs.value) {
    if (t.workspaceId !== w.id || !t.itemId) continue;
    const it = w.items.find((i) => i.id === t.itemId);
    if (!it) t.itemId = null;
    else {
      t.name = it.name;
      if (!t.dirty && it.request) t.spec = plain(it.request);
    }
  }
}

// ------------------------------------------------------------------ sending

// ------------------------------------------------------------------ WebSocket tabs

export const isWs = (tab: Tab) => /^wss?:\/\//i.test(interpolate(tab.spec.url.trim(), vars.value));
const WS_LOG_MAX = 2000;

/** Connect (or disconnect) a WebSocket tab: the request's headers go with the handshake. */
export async function toggleWs(tab: Tab): Promise<void> {
  tab.ws ??= { state: 'idle', log: [], draft: '' };
  if (tab.ws.state === 'open' || tab.ws.state === 'connecting') {
    await api.wsClose(tab.id);
    return;
  }
  const wire = wireFor(tab);
  const hop = /^(connection|upgrade|sec-websocket-(key|version|extensions)|accept-encoding|cache-control|content-type|content-length)$/i;
  const protocols = (wire.headers.find(([k]) => /^sec-websocket-protocol$/i.test(k))?.[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  tab.ws.state = 'connecting';
  await attempt(() => api.wsConnect(tab.id, wire.url, plain(wire.headers.filter(([k]) => !hop.test(k) && !/^sec-websocket-protocol$/i.test(k))), protocols));
}

export async function sendWs(tab: Tab): Promise<void> {
  if (!tab.ws?.draft) return;
  await attempt(() => api.wsSend(tab.id, interpolate(tab.ws!.draft, vars.value)));
}

/** Events from the main process land in their tab's log. */
export function onWsEvent(e: WsEvent): void {
  const tab = tabs.value.find((t) => t.id === e.token);
  if (!tab) return;
  tab.ws ??= { state: 'idle', log: [], draft: '' };
  if (e.type === 'open') tab.ws.state = 'open';
  else if (e.type === 'close') tab.ws.state = 'closed';
  else if (e.type === 'connecting') tab.ws.state = 'connecting';
  tab.ws.log.push(e);
  if (tab.ws.log.length > WS_LOG_MAX) tab.ws.log.splice(0, tab.ws.log.length - WS_LOG_MAX);
}

/** Writes the variable changes a script made: into the active environment (else the globals), in one save. */
export async function applyVarChanges(changes: Record<string, string | null>, itemId?: string | null): Promise<void> {
  const w = workspace.value;
  const names = Object.keys(changes);
  if (!w || !names.length) return;
  const edit = (list: EnvVariable[]) => {
    let next = list.filter((v) => !(changes[v.key.trim()] === null));
    for (const [k, val] of Object.entries(changes)) {
      if (val === null) continue;
      if (next.some((v) => v.key.trim() === k)) next = next.map((v) => (v.key.trim() === k ? { ...v, value: val, enabled: true } : v));
      else next = [...next, { key: k, value: val, enabled: true, secret: false }];
    }
    return next;
  };
  const env = itemId === undefined ? activeEnvironment.value : envFor(itemId);
  const saved = await attempt(() => (env ? window.dialcatz.saveEnvironment(w.id, plain({ ...env, variables: edit(env.variables) })) : window.dialcatz.saveGlobals(w.id, plain(edit(w.globals)))));
  if (saved) setWorkspace(saved);
}
const varsObject = (itemId: string | null) => Object.fromEntries(varsFor(itemId));

/** Whether the request's collection skips certificate checks (otherwise the app setting applies). */
const insecureFor = (itemId: string | null) => collectionOf(itemId)?.insecure === true;

/** The scripts of the collection and folders above an item, outermost first (Postman's order), with their names. */
function scriptChain(itemId: string | null, kind: 'preRequest' | 'tests'): { from: string; code: string }[] {
  const items = workspace.value?.items ?? [];
  const out: { from: string; code: string }[] = [];
  let cur = items.find((i) => i.id === itemId);
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = items.find((i) => i.id === cur!.parentId);
    const code = cur?.[kind];
    if (cur && code?.trim()) out.unshift({ from: `${cur.kind === 'collection' ? 'Collection' : 'Folder'} ${cur.name}`, code });
  }
  return out;
}

/** Runs scripts one after the other (each sees the variables the previous set) and merges their results. */
async function runChain(chain: { from: string | null; code: string }[], ctx: () => Parameters<typeof runScript>[1], itemId: string | null): Promise<ScriptResult | undefined> {
  if (!chain.length) return undefined;
  const merged: ScriptResult = { tests: [], logs: [], changes: {}, error: null };
  for (const s of chain) {
    const r = await runScript(s.code, ctx());
    await applyVarChanges(r.changes, itemId);
    const tag = s.from ? `${s.from} · ` : '';
    merged.tests.push(...r.tests.map((t) => ({ ...t, name: tag + t.name })));
    merged.logs.push(...r.logs.map((l) => tag + l));
    Object.assign(merged.changes, r.changes);
    if (r.error && !merged.error) merged.error = tag + r.error;
  }
  return merged;
}

/**
 * One request from start to end: pre-request scripts (collection, folders, then the request's own; their variable
 * changes are saved before the request is built), send, then test scripts in the same order. Used by request tabs
 * and the collection runner; the runner passes its iteration's data row, which wins over environment variables.
 */
export async function execute(spec: RequestSpec, itemId: string | null, token: string, data?: Record<string, string>): Promise<{ result: SendResult; scripts: { pre?: ScriptResult; tests?: ScriptResult } }> {
  const scripts: { pre?: ScriptResult; tests?: ScriptResult } = {};
  const vars = () => new Map([...varsFor(itemId), ...Object.entries(data ?? {})]);
  const wireNow = () => toWire(spec, vars(), effectiveAuth(spec.auth, inheritedAuth(itemId)), { version: appVersion.value });
  const pre = [...scriptChain(itemId, 'preRequest'), ...(spec.preRequest?.trim() ? [{ from: null, code: spec.preRequest }] : [])];
  scripts.pre = await runChain(pre, () => ({ request: requestContext(wireNow()), vars: Object.fromEntries(vars()), data }), itemId);
  const wire = wireNow();
  let result: SendResult;
  try {
    result = await api.send(plain(wire), token, insecureFor(itemId) ? { insecure: true } : {});
  } catch (e) {
    result = { error: (e as Error).message, sent: { method: wire.method, url: wire.url, headers: wire.headers, body: wire.body } };
  }
  const tests = [...scriptChain(itemId, 'tests'), ...(spec.tests?.trim() ? [{ from: null, code: spec.tests }] : [])];
  if (result.response) scripts.tests = await runChain(tests, () => ({ request: requestContext(wire), response: responseContext(result.response!), vars: Object.fromEntries(vars()), data }), itemId);
  return { result, scripts };
}

export async function sendTab(tab: Tab): Promise<void> {
  if (isWs(tab)) return toggleWs(tab);
  if (tab.sending) {
    await api.cancel(tab.id);
    return;
  }
  if (!tab.spec.url.trim()) {
    notify('warning', 'Type a URL first');
    return;
  }
  tab.sending = true;
  tab.sentAt = new Date().toISOString();
  try {
    const { result: r, scripts } = await execute(plain(tab.spec), tab.itemId, tab.id);
    tab.result = r;
    tab.scripts = scripts;
    const entry: HistoryEntry = {
      id: uid('h_'),
      at: tab.sentAt,
      workspaceId: tab.workspaceId,
      itemId: tab.itemId,
      name: tab.itemId ? tab.name : nameFromUrl(tab.spec.method, tab.spec.url),
      request: plain(tab.spec),
      status: r.response?.status ?? null,
      error: r.error,
      timeMs: r.response?.timings.total ?? 0,
      size: r.response?.size ?? 0,
    };
    await api.addHistory(entry);
    history.value = [entry, ...history.value].slice(0, 300);
  } finally {
    tab.sending = false;
  }
}

/** Saves a tab into its request; a scratch tab goes into `parentId` (a collection / folder) as a new request. */
export async function saveTab(tab: Tab, parentId?: string, name?: string): Promise<boolean> {
  const w = workspace.value;
  if (!w || w.id !== tab.workspaceId) return false;
  let item = tab.itemId ? w.items.find((i) => i.id === tab.itemId) : undefined;
  if (!item) {
    if (!parentId) return false;
    item = { id: uid('r_'), kind: 'request', parentId, name: name || tab.name, sort: w.items.filter((i) => i.parentId === parentId).length };
  }
  const saved = await attempt(() => api.saveItems(w.id, [plain({ ...item!, name: name || item!.name, request: tab.spec })]));
  if (!saved) return false;
  workspace.value = saved;
  tab.itemId = item.id;
  tab.name = name || item.name;
  tab.dirty = false;
  return true;
}
