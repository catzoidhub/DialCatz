import { computed, reactive, ref, toRaw, watch } from 'vue';
import { newRequest, uid, type ConnectRequest, type McatzpAsk, type McatzpInstallProgress, type McatzpRun, type McatzpTab, type McatzpTabResponse, type DialCatzSettings, type Environment, type EnvVariable, type PresenceEntry, type WsEvent, type SseEvent, type HistoryEntry, type RequestAuth, type RequestSpec, type SendResult, type ServerConnection, type TreeItem, type Workspace, type WorkspaceSummary, type MockState } from '@shared/types';
import { AUTO_HEADERS, buildVars, effectiveAuth, interpolate, nameFromUrl, resolveOAuth, toWire, type Vars } from '@shared/request';
import { store } from './store';
import { requestContext, responseContext, runScript, type ScriptResult, type WsRunMessage } from './scripts';
import { checkResponse } from '@shared/speccheck';

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
  ws?: { state: 'idle' | 'connecting' | 'open' | 'closed'; log: WsEvent[]; draft: string; event?: string; channel?: string; channels?: string[] };
  /** A live SSE answer (text/event-stream): its events as they come, and whether it is still open. */
  sse?: { open: boolean; events: SseEvent[]; reason?: string };
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
/** #92: collections whose spec file or URL changed since they last took it in (the tree marks them). */
export const specStale = ref<Set<string>>(new Set());
/** #92: the collection whose spec review is asked for (the tree opens the dialog). */
export const specAsk = ref<string | null>(null);
/** A collection a link asked to show (#94: DevCatz's "Open in DialCatz"); `mock` opens its Mock server panel. */
export const collectionAsk = ref<{ id: string; mock: boolean } | null>(null);
/** Collections paired with a DevCatz site (devcatzlink.ts): the site's name and app, and whether it is on this computer. */
export const devcatzLinks = ref<Record<string, { site: string | null; app: string; here: boolean }>>({});
/** Link / Unlink and the tree's DevCatz mark show only when DevCatz is installed here. */
export const devcatzInstalled = ref(false);
/** The same for DoCatz projects' services (docatzlink.ts). */
export const docatzLinks = ref<Record<string, { project: string | null; service: string; here: boolean }>>({});
export const docatzInstalled = ref(false);
/** Both pairings, each only while its app is installed here. */
export async function refreshDevcatzLinks(): Promise<void> {
  const w = workspace.value;
  if (!w) return;
  const [dev, doc] = await Promise.all([api.devcatzSites().catch(() => null), api.docatzProjects().catch(() => null)]);
  devcatzInstalled.value = dev?.installed === true;
  docatzInstalled.value = doc?.installed === true;
  const [links, dlinks] = await Promise.all([devcatzInstalled.value ? api.devcatzLinks(w.id).catch(() => null) : {}, docatzInstalled.value ? api.docatzLinks(w.id).catch(() => null) : {}]);
  if (workspace.value?.id !== w.id) return;
  if (links) devcatzLinks.value = links;
  if (dlinks) docatzLinks.value = dlinks;
}
/** #94: mock servers running now (the tree marks their collections). */
export const mocks = ref<MockState[]>([]);
export async function refreshMocks(): Promise<void> {
  const list = await api.mockList().catch(() => null);
  if (list) mocks.value = list;
}
/** #92: asks main which followed specs changed (on focus and when the workspace changes; URLs at most once a minute). */
export async function refreshSpecStale(): Promise<void> {
  const w = workspace.value;
  if (!w || !w.items.some((i) => i.kind === 'collection' && i.spec)) {
    if (specStale.value.size) specStale.value = new Set();
    return;
  }
  const ids = await api.specStale(w.id).catch(() => null);
  if (ids && workspace.value?.id === w.id) specStale.value = new Set(ids);
}
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
/** The MCatzP version to update to, for the badges in Settings. */
export const mcatzpUpdate = ref<string | null>(null);
/** The update check / download (Catzoid #54) and whether its dialog is open. */
export const updateState = ref<import('@shared/types').UpdateState>({ kind: 'idle' });
export const updateOpen = ref(false);
/** What's New was opened by itself (UpdatePrompt, Catzoid #97): the dialog offers "Don't open this on its own". */
export const updateOpenAuto = ref(false);
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

/**
 * The auth a send goes with. OAuth 2.0 (#100) gets its token now: the kept one while it lasts, renewed or asked again
 * otherwise; `interactive` (a request the user sends by hand) may open the browser for a sign-in.
 */
export async function authForSend(spec: RequestSpec, itemId: string | null, withVars: Vars, interactive: boolean): Promise<RequestAuth> {
  const a = effectiveAuth(spec.auth, inheritedAuth(itemId));
  if (a.mode !== 'oauth2') return a;
  const r = await api.oauthToken(plain(resolveOAuth(a.oauth2, withVars)), { interactive, ...(insecureFor(itemId) ? { insecure: true } : {}) });
  return { ...a, token: r.token };
}

/** An OAuth device sign-in's code is on screen in the Auth tab that started it (DeviceCodeCard stays away then). */
export const deviceCodeInline = ref(false);

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
/** #98: a gRPC request (grpc:// or grpcs://). */
export const isGrpcUrl = (url: string) => /^grpcs?:\/\//i.test(url.trim());
export const isGrpc = (tab: Tab) => isGrpcUrl(interpolate(tab.spec.url, vars.value));
const WS_LOG_MAX = 2000;

/** Connect (or disconnect) a WebSocket tab: the request's headers go with the handshake. */
export async function toggleWs(tab: Tab): Promise<void> {
  tab.ws ??= { state: 'idle', log: [], draft: '' };
  if (tab.ws.state === 'open' || tab.ws.state === 'connecting') {
    await api.wsClose(tab.id);
    return;
  }
  let wire = wireFor(tab);
  // OAuth 2.0: the handshake carries the token too.
  if (effectiveAuth(tab.spec.auth, inheritedAuth(tab.itemId)).mode === 'oauth2') {
    const auth = await attempt(() => authForSend(tab.spec, tab.itemId, varsFor(tab.itemId), true));
    if (!auth) return;
    wire = toWire(tab.spec, varsFor(tab.itemId), auth, { version: appVersion.value });
  }
  const hop = /^(connection|upgrade|sec-websocket-(key|version|extensions)|accept-encoding|cache-control|content-type|content-length)$/i;
  const protocols = (wire.headers.find(([k]) => /^sec-websocket-protocol$/i.test(k))?.[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  tab.ws.state = 'connecting';
  await attempt(() => api.wsConnect(tab.id, wire.url, plain(wire.headers.filter(([k]) => !hop.test(k) && !/^sec-websocket-protocol$/i.test(k))), protocols, { socketIo: tab.spec.socketIo === true, pusher: !!tab.spec.pusher }));
}

/** #99: joins (or leaves) a channel on a Pusher tab; the app secret comes from its {{variable}}. */
export async function pusherChannel(tab: Tab, action: 'subscribe' | 'unsubscribe', channel: string): Promise<void> {
  const name = interpolate(channel.trim(), vars.value);
  if (!name) return notify('warning', 'Type a channel name');
  const p = tab.spec.pusher ?? {};
  await attempt(() => api.wsPusherChannel(tab.id, action, name, { secret: p.secret ? interpolate(p.secret, vars.value) : undefined, userId: p.userId ? interpolate(p.userId, vars.value) : undefined }));
}

export async function sendWs(tab: Tab): Promise<void> {
  if (tab.spec.pusher) {
    if (!tab.ws?.event?.trim()) return notify('warning', 'Type the client event name');
    await attempt(() => api.wsSend(tab.id, interpolate(tab.ws!.draft ?? '', vars.value), interpolate(tab.ws!.event!, vars.value), tab.ws!.channel ?? ''));
    return;
  }
  if (tab.spec.socketIo) {
    // Socket.IO: an event by name; its args may be empty.
    if (!tab.ws?.event?.trim()) return notify('warning', 'Type the event name');
    await attempt(() => api.wsSend(tab.id, interpolate(tab.ws!.draft ?? '', vars.value), interpolate(tab.ws!.event!, vars.value)));
    return;
  }
  if (!tab.ws?.draft) return;
  await attempt(() => api.wsSend(tab.id, interpolate(tab.ws!.draft, vars.value)));
}

/** Events from the main process land in their tab's log. */
// Connections the runner opens for a WebSocket request (not a tab's): their events go to the run, not to a tab.
const runSockets = new Map<string, (e: WsEvent) => void>();

/** What a run's row calls a request: its method, or the kind of socket / gRPC it speaks. */
export const runLabel = (spec: RequestSpec): string => (spec.pusher ? 'PSH' : spec.socketIo ? 'SIO' : /^\s*wss?:\/\//i.test(spec.url) ? 'WS' : isGrpcUrl(spec.url) ? 'gRPC' : spec.method);

/** How long a WebSocket request listens in a run after it connected and sent its first message. */
const WS_RUN_WAIT_MS = 2000;

/**
 * A WebSocket / Socket.IO / Pusher request in a run (the collection runner, MCatzP's run_collection), as the CLI does
 * it: connect with the request's handshake headers, join its saved Pusher channels, send the first message kept with
 * the request, listen for a moment, close. The answer is a 101 whose body lists what arrived; tests get it as
 * dc.messages.
 */
async function wsRun(spec: RequestSpec, wire: ReturnType<typeof toWire>, itemId: string | null, vars: Vars): Promise<{ result: SendResult; messages: WsRunMessage[] }> {
  const token = `run-ws-${uid('')}`;
  const started = performance.now();
  const messages: WsRunMessage[] = [];
  const sent = { method: spec.pusher ? 'PSH' : spec.socketIo ? 'SIO' : 'WS', url: wire.url, headers: wire.headers };
  const hop = /^(connection|upgrade|sec-websocket-(key|version|extensions)|accept-encoding|cache-control|content-type|content-length)$/i;
  const protocols = (wire.headers.find(([k]) => /^sec-websocket-protocol$/i.test(k))?.[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const first = spec.wsMessage;
  const timeoutMs = settings.value?.requests.timeoutMs ?? 30_000;
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`No connection within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      let ready = false;
      let sentFirst = false;
      const channels = spec.pusher ? (spec.pusher.channels ?? []).map((ch) => interpolate(ch, vars)) : [];
      const joined = new Set<string>();
      const sendFirst = () => {
        if (sentFirst) return;
        sentFirst = true;
        if (first && (first.text.trim() || first.event?.trim())) {
          void api.wsSend(token, interpolate(first.text, vars), first.event?.trim() ? interpolate(first.event, vars) : undefined, first.channel?.trim() ? interpolate(first.channel, vars) : undefined).catch((e: Error) => fail(e));
        }
        setTimeout(done, WS_RUN_WAIT_MS);
      };
      // Raw and Socket.IO are ready when the connection opens; Pusher once the server has given the socket id.
      const start = () => {
        ready = true;
        clearTimeout(timer);
        if (!spec.pusher) return sendFirst();
        for (const ch of channels) void api.wsPusherChannel(token, 'subscribe', ch, plain({ secret: interpolate(spec.pusher.secret ?? '', vars) || undefined, userId: interpolate(spec.pusher.userId ?? '', vars) || undefined })).catch((e: Error) => fail(e));
        // A client event goes out once its channels are joined (or after a moment, when one was refused).
        if (!channels.length) sendFirst();
        else setTimeout(sendFirst, 2000);
      };
      runSockets.set(token, (e) => {
        if (e.type === 'error') {
          clearTimeout(timer);
          fail(new Error(e.data || 'The connection failed'));
        } else if (e.type === 'close' && !ready) {
          clearTimeout(timer);
          fail(new Error(`The server closed the connection (${e.data || 'no reason'})`));
        } else if (e.type === 'in') {
          const pair = / · /.test(e.event ?? '') ? /^(.*?) · (.*)$/.exec(e.event!) : null;
          const sub = /^subscribed (.+)$/.exec(e.event ?? '');
          messages.push({ data: e.data, ...(pair ? { channel: pair[1], event: pair[2] } : sub ? { channel: sub[1], event: 'subscribed' } : e.event ? { event: e.event } : {}) });
          if (spec.pusher && !ready && e.event === 'connected') start();
          if (sub) {
            joined.add(sub[1]);
            if (ready && channels.every((c) => joined.has(c))) sendFirst();
          }
        } else if (e.type === 'open' && !ready && !spec.pusher) start();
      });
      api.wsConnect(token, wire.url, plain(wire.headers.filter(([k]) => !hop.test(k) && !/^sec-websocket-protocol$/i.test(k))), protocols, { socketIo: spec.socketIo === true, pusher: !!spec.pusher }).catch((e: Error) => {
        clearTimeout(timer);
        fail(e);
      });
    });
    const ms = Math.round(performance.now() - started);
    const body = JSON.stringify(messages, null, 2);
    return { messages, result: { sent, response: { ok: true, status: 101, statusText: 'Switching Protocols', headers: [], body, binary: false, contentType: 'application/json', size: new TextEncoder().encode(body).length, timings: { total: ms, ttfb: ms }, url: wire.url } as unknown as SendResult['response'] } };
  } catch (e) {
    return { messages, result: { sent, error: String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') } };
  } finally {
    runSockets.delete(token);
    void api.wsClose(token).catch(() => undefined);
  }
}

export function onWsEvent(e: WsEvent): void {
  const run = runSockets.get(e.token);
  if (run) return run(e);
  const tab = tabs.value.find((t) => t.id === e.token);
  if (!tab) return;
  tab.ws ??= { state: 'idle', log: [], draft: '' };
  if (e.type === 'open') ((tab.ws.state = 'open'), (tab.ws.channels = []));
  // Pusher (#99): the channels joined, and the request's own channels once the server gives a socket id.
  if (e.event?.startsWith('subscribe ')) tab.ws.channels = [...new Set([...(tab.ws.channels ?? []), e.event.slice(10)])];
  if (e.event?.startsWith('unsubscribe ')) tab.ws.channels = (tab.ws.channels ?? []).filter((c) => c !== e.event!.slice(12));
  if (e.event === 'connected' && tab.spec.pusher?.channels?.length) for (const c of tab.spec.pusher.channels) void pusherChannel(tab, 'subscribe', c);
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
export const insecureFor = (itemId: string | null) => collectionOf(itemId)?.insecure === true;

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
export async function execute(spec: RequestSpec, itemId: string | null, token: string, data?: Record<string, string>, opts: { checkSpec?: boolean; stream?: boolean; interactive?: boolean } = {}): Promise<{ result: SendResult; scripts: { pre?: ScriptResult; tests?: ScriptResult } }> {
  const scripts: { pre?: ScriptResult; tests?: ScriptResult } = {};
  const vars = () => new Map([...varsFor(itemId), ...Object.entries(data ?? {})]);
  const wireNow = () => toWire(spec, vars(), effectiveAuth(spec.auth, inheritedAuth(itemId)), { version: appVersion.value });
  const pre = [...scriptChain(itemId, 'preRequest'), ...(spec.preRequest?.trim() ? [{ from: null, code: spec.preRequest }] : [])];
  scripts.pre = await runChain(pre, () => ({ request: requestContext(wireNow()), vars: Object.fromEntries(vars()), data }), itemId);
  let wire = wireNow();
  let result: SendResult;
  let messages: WsRunMessage[] | undefined;
  try {
    // OAuth 2.0: the token is got after the pre-request scripts (they may set what it is asked with).
    if (effectiveAuth(spec.auth, inheritedAuth(itemId)).mode === 'oauth2') wire = toWire(spec, vars(), await authForSend(spec, itemId, vars(), opts.interactive === true), { version: appVersion.value });
    if (/^wss?:\/\//i.test(wire.url)) {
      // A WebSocket request in a run (a tab connects itself instead, through toggleWs).
      const r = await wsRun(spec, wire, itemId, vars());
      result = r.result;
      messages = r.messages;
    } else if (isGrpcUrl(wire.url)) {
      // #98: a gRPC call. Headers are its metadata (the HTTP ones DialCatz adds by itself stay out); the body is the message.
      const auto = /^(user-agent|accept|accept-encoding|connection|cache-control|content-type|content-length|host)$/i;
      result = await api.grpcCall(plain({ url: wire.url.split('?')[0], service: spec.grpc?.service ?? '', method: spec.grpc?.method ?? '', message: interpolate(spec.body.raw, vars()), metadata: wire.headers.filter(([k]) => !auto.test(k)), protoFiles: spec.grpc?.protoFiles, ...(insecureFor(itemId) ? { insecure: true } : {}) }), token);
    } else result = await api.send(plain(wire), token, { ...(insecureFor(itemId) ? { insecure: true } : {}), ...(opts.stream ? { stream: true } : {}) });
  } catch (e) {
    result = { error: String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), sent: { method: wire.method, url: wire.url, headers: wire.headers, body: wire.body } };
  }
  const tests = [...scriptChain(itemId, 'tests'), ...(spec.tests?.trim() ? [{ from: null, code: spec.tests }] : [])];
  if (result.response) scripts.tests = await runChain(tests, () => ({ request: requestContext(wire), response: responseContext(result.response!), vars: Object.fromEntries(vars()), data, ...(messages ? { messages } : {}) }), itemId);
  // #93: the runner's "Check responses against the spec" counts as one more test.
  const specResponses = opts.checkSpec && !messages ? workspace.value?.items.find((i) => i.id === itemId)?.specResponses : undefined;
  if (result.response && specResponses?.length) {
    const c = checkResponse(specResponses, result.response);
    scripts.tests ??= { tests: [], logs: [], changes: {}, error: null };
    scripts.tests.tests.push({ name: 'Response matches the spec', pass: !c.issues.length, ...(c.issues.length ? { error: c.issues.slice(0, 5).join('; ') + (c.issues.length > 5 ? ` (and ${c.issues.length - 5} more)` : '') } : {}) });
  }
  return { result, scripts };
}

/** Requests that got a response in this window's session: Support Catzoid's success moment (Catzoid #94). */
export const sentOk = ref(0);

const SSE_MAX = 2000;
/** A live SSE answer's event or end, for the tab that sent it (token = tab id). */
export function onSseEvent(e: SseEvent): void {
  const tab = tabs.value.find((t) => t.id === e.token);
  if (!tab?.sse) return;
  if (e.type === 'event') {
    tab.sse.events.push(e);
    if (tab.sse.events.length > SSE_MAX) tab.sse.events.splice(0, tab.sse.events.length - SSE_MAX);
  } else {
    tab.sse.open = false;
    tab.sse.reason = e.reason;
  }
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
  // Ready for a live SSE answer before it can start (its first events may beat the send's own answer).
  tab.sse = { open: true, events: [] };
  try {
    const { result: r, scripts } = await execute(plain(tab.spec), tab.itemId, tab.id, undefined, { stream: true, interactive: true });
    if (!r.response?.streaming) tab.sse = undefined;
    tab.result = r;
    tab.scripts = scripts;
    if (r.response) sentOk.value++;
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
    ...(t.sse ? { events: { open: t.sse.open, list: t.sse.events.slice(-200).map((e) => ({ event: e.event ?? 'message', data: (e.data ?? '').slice(0, 20_000), ...(e.id ? { id: e.id } : {}), at: e.at })) } } : {}),
  };
}

// ---------------------------------------------------------------- MCatzP: what a client asks the window to do

/** The collection run a client started last. */
export const mcatzpRun = ref<McatzpRun | null>(null);
/** A collection run in the Runner dialog (Catzoid #95: closing the window asks first while one goes). */
export const runnerRunning = ref(false);
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

async function runForClient(target: string, iterations: number, delay: number, stopOnFail: boolean, checkSpec: boolean): Promise<void> {
  const list = requestsUnder(target);
  const run = mcatzpRun.value!;
  stopRun = false;
  outer: for (let it = 1; it <= iterations; it++) {
    for (const item of list) {
      if (stopRun) break outer;
      const { result, scripts } = await execute(plain(item.request!), item.id, RUN_TOKEN, undefined, { checkSpec });
      const tests = [...(scripts.pre?.tests ?? []), ...(scripts.tests?.tests ?? [])];
      const error = result.error ?? scripts.pre?.error ?? scripts.tests?.error ?? undefined;
      const failed = tests.filter((t) => !t.pass);
      run.rows.push({ iteration: it, name: item.name, method: runLabel(item.request!), url: result.sent?.url ?? item.request!.url, status: result.response?.status ?? null, timeMs: result.response?.timings.total ?? 0, passed: tests.length - failed.length, failed: failed.length, ...(error ? { error } : {}), failures: failed.map((t) => `${t.name}: ${t.error}`) });
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
  // A file dialog is about to open: the window is up, that is all.
  if (what === 'ping') return null;
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
    void runForClient(root.id, iterations, Number(a.delay) || 0, a.stopOnFail === true, a.checkSpec === true).catch((e: Error) => {
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
  if (what === 'wsChannel') {
    const tab = clientTab(a.tab);
    if (!tab.spec.pusher) throw new Error(`${tab.name} is not a Pusher tab`);
    if (tab.ws?.state !== 'open') throw new Error(`${tab.name} is not connected (websocket_connect)`);
    await pusherChannel(tab, a.action === 'unsubscribe' ? 'unsubscribe' : 'subscribe', String(a.channel));
    return { done: true };
  }
  if (what === 'wsSend') {
    const tab = clientTab(a.tab);
    if (tab.ws?.state !== 'open') throw new Error(`${tab.name} is not connected (websocket_connect)`);
    tab.ws.draft = String(a.text);
    if (a.event !== undefined) tab.ws.event = String(a.event);
    if (a.channel !== undefined) tab.ws.channel = String(a.channel);
    await sendWs(tab);
    return { sent: true };
  }
  if (what === 'wsClose') {
    await api.wsClose(clientTab(a.tab).id);
    return { closed: true };
  }
  throw new Error(`Unknown request from MCatzP: ${what}`);
}
