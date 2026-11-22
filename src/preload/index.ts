import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, type ConnectRequest, type DialCatzApi, type DialCatzSettings, type GitState, type PresenceEntry, type UpdateState, type WsEvent, type OAuthDevicePrompt, type SseEvent, type McatzpAsk, type McatzpInstallProgress } from '@shared/types';

const api = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`dialcatz:${m}`, ...args)])) as unknown as DialCatzApi;

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  // One listener that throws must not stop the others.
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(`${channel} listener failed:`, e);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const bridge = {
  ...api,
  /** A dialcatz://connect link waiting for the user's yes (also asked once at start, for a link that launched the app). */
  pendingConnect: () => ipcRenderer.invoke('dialcatz:pendingConnect') as Promise<ConnectRequest | null>,
  dismissConnect: () => ipcRenderer.invoke('dialcatz:dismissConnect') as Promise<void>,
  /** The window listens now: links from DevCatz / DoCatz that came before it (one that launched the app) arrive. */
  linksReady: () => ipcRenderer.invoke('dialcatz:linksReady') as Promise<void>,
  onConnect: (cb: (r: ConnectRequest) => void) => on('app:connect', cb),
  /** Menu commands (newRequest, save, send, import …). */
  onCommand: (cb: (command: string) => void) => on('app:command', cb),
  /** The shared theme / AI connection changed in another Catzoid app. */
  onSettings: (cb: (s: DialCatzSettings) => void) => on('app:settings', cb),
  /** Team workspaces were added, removed or synced in the background. */
  onWorkspaces: (cb: () => void) => on('app:workspaces', cb),
  onSynced: (cb: () => void) => on('app:synced', cb),
  /** WebSocket tab events (connecting, open, messages, errors, close). */
  onWs: (cb: (e: WsEvent) => void) => on('app:ws', cb),
  /** OAuth 2.0 device code: the code to type in while DialCatz waits; null when the wait is over. */
  onOauthDevice: (cb: (p: OAuthDevicePrompt | null) => void) => on('app:oauthDevice', cb),
  /** A request tab's live SSE answer: each event, then its end. */
  onSse: (cb: (e: SseEvent) => void) => on('app:sse', cb),
  /** dialcatz://open?site=<id> from DevCatz. */
  onDevCatz: (cb: (siteId: string) => void) => on('app:devcatz', cb),
  /** dialcatz://open?docatz=<compose project>[&service=<service>] from DoCatz ('' when no service is named). */
  onDoCatz: (cb: (link: { project: string; service: string }) => void) => on('app:docatz', cb),
  /** dialcatz://mock?docatz=<project>&service=<service> from DoCatz's "Create mock server" (#94). */
  onMockService: (cb: (link: { project: string; service: string }) => void) => on('app:mockService', cb),
  /** dialcatz://ws?url=&mode=raw|socketio|pusher&channel=… (#99): a WebSocket tab, ready to connect. */
  onOpenWs: (cb: (link: { url: string; mode: 'raw' | 'socketio' | 'pusher'; channels: string[]; name: string; secret: string }) => void) => on('app:openWs', cb),
  /** dialcatz://mock?site=<id>&spec=<path> from DevCatz's "Create mock server" (#94). */
  onMockSpec: (cb: (link: { siteId: string; spec: string; app: string }) => void) => on('app:mockSpec', cb),
  /** dialcatz://open?workspace=<id>&collection=<id>[&mock=1] from DevCatz's mock page (#94). */
  onOpenCollection: (cb: (link: { workspaceId: string; collectionId: string; mock: boolean }) => void) => on('app:openCollection', cb),
  /** A question from an MCP client waiting for the user (null: none left). */
  onMcatzpAsk: (cb: (ask: McatzpAsk | null) => void) => on('app:mcatzpAsk', cb),
  /** The main process asks for what only the window holds; answered with mcatzpWindowReply. */
  onMcatzpRead: (cb: (req: { id: string; what: 'tabs' | 'response' | 'runState'; tab: string | null }) => void) => on('app:mcatzpRead', cb),
  /** The main process asks the window to do something only it can (send, with its scripts and history). */
  onMcatzpCommand: (cb: (req: { id: string; what: string; args: Record<string, unknown> }) => void) => on('app:mcatzpCommand', cb),
  /** After Allow: the page of what was asked. */
  onMcatzpOpen: (cb: (page: { workspaceId?: string; itemId?: string; section?: 'requests' | 'environments' | 'git' | 'team' | 'settings' }) => void) => on('app:mcatzpOpen', cb),
  /** A client's change ran: reload what is on screen. */
  onMcatzpRefresh: (cb: () => void) => on('app:mcatzpRefresh', cb),
  /** A new MCatzP version on offer, or none. */
  onMcatzpUpdate: (cb: (version: string | null) => void) => on('app:mcatzpUpdate', cb),
  /** Install MCatzP running in Settings. */
  onMcatzpInstalling: (cb: (p: McatzpInstallProgress | null) => void) => on('app:mcatzpInstalling', cb),
  /** Who has which request open in a team workspace. */
  onPresence: (cb: (p: { workspaceId: string; presence: PresenceEntry[] }) => void) => on('app:presence', cb),
  /** The update check / download moved on (Catzoid #54). */
  onUpdate: (cb: (s: UpdateState) => void) => on('app:update', cb),
  /** The Git section's repositories, accounts or clone moved on. */
  onGit: (cb: (s: GitState) => void) => on('app:git', cb),
  /** Moving from Postman with an API key: which step it is on. */
  onPostmanProgress: (cb: (p: { done: number; total: number; label: string }) => void) => on('app:postman', cb),
};

export type DialCatzBridge = typeof bridge;

contextBridge.exposeInMainWorld('dialcatz', bridge);
