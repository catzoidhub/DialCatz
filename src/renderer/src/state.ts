import { computed, reactive, ref, toRaw, watch } from 'vue';
import { newRequest, uid, type ConnectRequest, type McatzpAsk, type McatzpInstallProgress, type McatzpRun, type McatzpTab, type McatzpTabResponse, type DialCatzSettings, type Environment, type EnvVariable, type PresenceEntry, type WsEvent, type HistoryEntry, type RequestAuth, type RequestSpec, type SendResult, type ServerConnection, type TreeItem, type Workspace, type WorkspaceSummary } from '@shared/types';
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
export const importRequest = ref<{ tab: 'choose' | 'file' | 'postman' | 'devcatz' | 'docatz'; siteId?: string; project?: string; service?: string } | null>(null);
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
export const settingsTab = ref<'general' | 'ai' | 'mcatzp' | 'updates' | 'about'>('general');
/** A question from an MCP client waiting for the user, and Install MCatzP running in Settings. */
export const mcatzpAsk = ref<McatzpAsk | null>(null);
export const mcatzpInstalling = ref<McatzpInstallProgress | null>(null);
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

// ---------------------------------------------------------------- MCatzP: what only the window holds

const MCATZP_MAX_BODY = 2_000_000;
function mcatzpTab(t: Tab): McatzpTab {
  const r = t.result?.response;
  return { id: t.id, workspaceId: t.workspaceId, name: t.name, method: t.spec.method, url: t.spec.url, dirty: t.dirty, sending: t.sending, active: t.id === activeTabId.value, kind: t.ws ? 'websocket' : 'http', status: r?.status ?? null, error: t.result?.error ?? null, timeMs: r?.timings.total ?? null, sentAt: t.sentAt ?? null };
}
/** Open tabs for a client; the main process masks and leaves out what is not shared. */
export const mcatzpTabs = (): McatzpTab[] => tabs.value.map(mcatzpTab);
/** A tab's last response (the active tab without an id). */
export function mcatzpTabResponse(id: string | null): McatzpTabResponse | null {
  const t = id ? tabs.value.find((x) => x.id === id) : activeTab.value;
  if (!t) return null;
  const r = t.result?.response;
  const s = t.result?.sent;
  return {
    ...mcatzpTab(t),
    statusText: r?.statusText ?? null,
    headers: r?.headers ?? [],
    body: (r?.body ?? '').slice(0, MCATZP_MAX_BODY),
    binary: r?.binary === true,
    contentType: r?.contentType ?? null,
    size: r?.size ?? null,
    truncated: r?.truncated === true || (r?.body.length ?? 0) > MCATZP_MAX_BODY,
    sent: s ? { method: s.method, url: s.url, headers: s.headers } : null,
    tests: (t.scripts?.tests?.tests ?? []).map((x) => ({ name: x.name, passed: x.pass, ...(x.error ? { error: x.error } : {}) })),
    scriptLogs: [...(t.scripts?.pre?.logs ?? []), ...(t.scripts?.tests?.logs ?? [])].slice(-200),
    scriptError: t.scripts?.pre?.error ?? t.scripts?.tests?.error ?? null,
    log: (t.ws?.log ?? []).slice(-200).map((e) => ({ dir: e.type, text: e.binary ? '(binary)' : e.data.slice(0, 20_000), at: e.at })),
  };
}

// ---------------------------------------------------------------- MCatzP: what a client asks the window to do

/** The collection run a client started last. */
export const mcatzpRun = ref<McatzpRun | null>(null);
let stopRun = false;
/** Tabs being sent for a client: what stops when it gives up. */
const clientSends = new Set<string>();
async function clientSend(tab: Tab): Promise<void> {
  clientSends.add(tab.id);
  try {
    await sendTab(tab);
  } finally {
    clientSends.delete(tab.id);
  }
}
const RUN_TOKEN = 'mcatzp-run';

/** After Allow: the page of what was asked. */
export async function mcatzpOpen(page: { workspaceId?: string; itemId?: string; section?: Section }): Promise<void> {
  if (page.workspaceId && page.workspaceId !== workspace.value?.id) await selectWorkspace(page.workspaceId);
  if (page.section) goSection(page.section);
  if (page.section === 'requests' && page.itemId) {
    const item = workspace.value?.items.find((i) => i.id === page.itemId);
    if (item) openItem(item);
  }
}

/** A client's change ran: the sidebar and the open tabs follow, tabs with unsaved edits stay as they are. */
export async function mcatzpRefresh(): Promise<void> {
  await loadWorkspaces();
  await reloadWorkspace();
  if (workspace.value) syncTabsWithWorkspace(workspace.value);
}

async function openForClient(workspaceId: string, itemId: string): Promise<Tab> {
  if (workspace.value?.id !== workspaceId) await selectWorkspace(workspaceId);
  const item = workspace.value?.items.find((i) => i.id === itemId);
  if (!item) throw new Error('That request is gone');
  // What the user allowed is the saved request: a tab with other edits would send something else.
  const open = tabs.value.find((t) => t.itemId === itemId && t.workspaceId === workspaceId);
  if (open?.dirty) throw new Error(`${item.name} has unsaved edits in DialCatz: the user saves or discards them first`);
  openItem(item);
  return tabs.value.find((t) => t.itemId === itemId && t.workspaceId === workspaceId)!;
}

function clientTab(id: unknown): Tab {
  const t = tabs.value.find((x) => x.id === id);
  if (!t) throw new Error(`No tab ${String(id)} (list_open_tabs shows them)`);
  return t;
}

/** Every request under a collection or folder, in the tree's order, as the runner goes through them. */
function requestsUnder(rootId: string): TreeItem[] {
  const items = workspace.value?.items ?? [];
  const out: TreeItem[] = [];
  const walk = (parentId: string) => {
    for (const i of items.filter((x) => x.parentId === parentId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
      if (i.kind === 'request') out.push(i);
      else walk(i.id);
    }
  };
  walk(rootId);
  return out;
}

async function runForClient(target: string, iterations: number, delay: number, stopOnFail: boolean): Promise<void> {
  const list = requestsUnder(target);
  const run = mcatzpRun.value!;
  stopRun = false;
  outer: for (let it = 1; it <= iterations; it++) {
    for (const item of list) {
      if (stopRun) break outer;
      const { result, scripts } = await execute(plain(item.request!), item.id, RUN_TOKEN);
      const tests = [...(scripts.pre?.tests ?? []), ...(scripts.tests?.tests ?? [])];
      const error = result.error ?? scripts.pre?.error ?? scripts.tests?.error ?? undefined;
      const failed = tests.filter((t) => !t.pass);
      run.rows.push({ iteration: it, name: item.name, method: item.request!.method, url: result.sent?.url ?? item.request!.url, status: result.response?.status ?? null, timeMs: result.response?.timings.total ?? 0, passed: tests.length - failed.length, failed: failed.length, ...(error ? { error } : {}), failures: failed.map((t) => `${t.name}: ${t.error}`) });
      if (stopOnFail && (failed.length || error)) break outer;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
  run.finished = true;
  run.stopped = stopRun;
  const failedRows = run.rows.filter((r) => r.failed || r.error || (r.status ?? 0) >= 400).length;
  notify(failedRows ? 'warning' : 'success', `Run of ${run.target}: ${run.rows.length} request(s), ${failedRows} with problems`);
}

/** What a client asked for, after the user allowed it. A throw goes back to the client as the failure. */
export async function mcatzpCommand(what: string, a: Record<string, unknown>): Promise<unknown> {
  if (what === 'send') {
    const tab = await openForClient(String(a.workspaceId), String(a.itemId));
    if (tab.sending) throw new Error(`${tab.name} is being sent already`);
    await clientSend(tab);
    return mcatzpTabResponse(tab.id);
  }
  if (what === 'sendNew') {
    if (workspace.value?.id !== a.workspaceId) await selectWorkspace(String(a.workspaceId));
    const tab = newTab(a.spec as RequestSpec, String(a.name).slice(0, 80));
    if (!tab) throw new Error('No workspace is open');
    await clientSend(tabs.value.find((t) => t.id === tab.id)!);
    return mcatzpTabResponse(tab.id);
  }
  if (what === 'cancelSend') {
    await api.cancel(clientTab(a.tab).id);
    return { stopped: true };
  }
  // The client gave up on its call: what it was waiting for stops, never a send of the user's in another tab.
  if (what === 'cancelClient') {
    for (const id of clientSends) await api.cancel(id);
    return null;
  }
  if (what === 'run') {
    if (mcatzpRun.value && !mcatzpRun.value.finished) throw new Error('A run is going on already: get_run_results shows it, stop_run stops it');
    if (workspace.value?.id !== a.workspaceId) await selectWorkspace(String(a.workspaceId));
    const root = workspace.value?.items.find((i) => i.id === a.target);
    if (!root) throw new Error('That collection is gone');
    const list = requestsUnder(root.id);
    const iterations = Number(a.iterations) || 1;
    mcatzpRun.value = { id: uid('run_'), target: root.name, total: list.length * iterations, finished: false, stopped: false, rows: [] };
    void runForClient(root.id, iterations, Number(a.delay) || 0, a.stopOnFail === true).catch((e: Error) => {
      if (mcatzpRun.value) mcatzpRun.value.finished = true;
      notify('error', e.message);
    });
    return { started: true, requests: mcatzpRun.value.total, note: 'Still running: get_run_results shows how far it is. Tell the user how it went.' };
  }
  if (what === 'stopRun') {
    stopRun = true;
    await api.cancel(RUN_TOKEN);
    return { stopped: !!mcatzpRun.value && !mcatzpRun.value.finished };
  }
  if (what === 'wsConnect') {
    const tab = await openForClient(String(a.workspaceId), String(a.itemId));
    if (!isWs(tab)) throw new Error(`${tab.name} is not a WebSocket request (ws:// or wss://)`);
    if (tab.ws?.state !== 'open') await toggleWs(tab);
    return { tab: tab.id, state: tab.ws?.state ?? 'connecting' };
  }
  if (what === 'wsSend') {
    const tab = clientTab(a.tab);
    if (tab.ws?.state !== 'open') throw new Error(`${tab.name} is not connected (websocket_connect)`);
    tab.ws.draft = String(a.text);
    await sendWs(tab);
    return { sent: true };
  }
  if (what === 'wsClose') {
    await api.wsClose(clientTab(a.tab).id);
    return { closed: true };
  }
  throw new Error(`Unknown request from MCatzP: ${what}`);
}
