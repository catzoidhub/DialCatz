import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, type ConnectRequest, type DialCatzApi, type DialCatzSettings, type GitState, type PresenceEntry, type UpdateState, type WsEvent } from '@shared/types';

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
  /** dialcatz://open?site=<id> from DevCatz. */
  onDevCatz: (cb: (siteId: string) => void) => on('app:devcatz', cb),
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
