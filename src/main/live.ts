import type { PresenceEntry } from '@shared/types';
import { getToken } from './secrets';
import * as srv from './servers';
import * as ws from './workspaces';

/**
 * Live updates from DialCatz Den: one server-sent-events stream per team workspace
 * (GET /api/v1/workspaces/:id/events). A `change` from someone else starts a sync at once (the minute timer stays
 * as the fallback); `presence` says who has which request open. This app's own presence is posted when the
 * open request changes and every 30 s (POST /presence). Streams reconnect with a growing pause.
 */

interface Stream {
  ctl: AbortController;
  retry: number;
  timer?: NodeJS.Timeout;
}
const streams = new Map<string, Stream>();
const presence = new Map<string, PresenceEntry[]>();
let onPresence: (workspaceId: string, list: PresenceEntry[]) => void = () => undefined;
let onSynced: (workspaceId: string) => void = () => undefined;
let onRenamed: (workspaceId: string) => void = () => undefined;
export function hooks(h: { presence: typeof onPresence; synced: typeof onSynced; renamed?: typeof onRenamed }): void {
  if (h.renamed) onRenamed = h.renamed;
  onPresence = h.presence;
  onSynced = h.synced;
}
export const presenceOf = (workspaceId: string) => presence.get(workspaceId) ?? [];

/** Opens streams for every team workspace on this computer and closes the ones gone. */
export function refresh(): void {
  const team = ws.list().filter((w) => w.serverId && w.remoteId);
  for (const id of [...streams.keys()]) if (!team.some((w) => w.id === id)) stop(id);
  for (const w of team) if (!streams.has(w.id)) start(w.id);
}

export function stopAll(): void {
  for (const id of [...streams.keys()]) stop(id);
}

function stop(id: string): void {
  const s = streams.get(id);
  if (!s) return;
  s.ctl.abort();
  clearTimeout(s.timer);
  streams.delete(id);
  presence.delete(id);
}

function start(id: string, retry = 0): void {
  const s: Stream = { ctl: new AbortController(), retry };
  streams.set(id, s);
  void run(id, s).finally(() => {
    if (streams.get(id) !== s || s.ctl.signal.aborted) return;
    // Dropped: try again after 2, 4, 8 … up to 60 s.
    const wait = Math.min(60_000, 2000 * 2 ** s.retry);
    s.timer = setTimeout(() => streams.get(id) === s && start(id, s.retry + 1), wait);
  });
}

async function run(id: string, s: Stream): Promise<void> {
  let w;
  try {
    w = ws.load(id);
  } catch {
    return;
  }
  const conn = srv.servers().find((x) => x.id === w.serverId);
  if (!conn || !w.remoteId) return;
  const token = await getToken(conn.id);
  if (!token) return;
  let res: Response;
  try {
    res = await fetch(`${conn.url}/api/v1/workspaces/${encodeURIComponent(w.remoteId)}/events`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: s.ctl.signal });
  } catch {
    return;
  }
  if (!res.ok || !res.body) {
    // 401 / 403: the token or membership is gone; the minute sync shows the error. Do not hammer.
    if (res.status === 401 || res.status === 403 || res.status === 404) s.retry = 5;
    return;
  }
  s.retry = 0;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        handle(id, block);
      }
    }
  } catch {
    /* aborted or dropped */
  }
}

function handle(id: string, block: string): void {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload: { revision?: number; presence?: PresenceEntry[]; name?: string };
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (payload.presence) {
    presence.set(id, payload.presence);
    onPresence(id, payload.presence);
  }
  // The owner renamed it: read the new name (and roles) from the server.
  if (event === 'renamed') {
    try {
      const w = ws.load(id);
      if (w.serverId) void srv.refresh(w.serverId).then(() => onRenamed(id));
    } catch {
      /* gone meanwhile */
    }
    return;
  }
  if ((event === 'change' || event === 'hello') && payload.revision !== undefined) {
    let local = 0;
    try {
      local = ws.load(id).revision ?? 0;
    } catch {
      return;
    }
    // A sync only when the server is ahead of what we have (our own pushes usually are not).
    if (payload.revision > local) void srv.sync(id).then(() => onSynced(id));
  }
}

// ------------------------------------------------------------------ this app's presence

const looking = new Map<string, string | null>();
let beat: NodeJS.Timeout | null = null;

async function post(id: string, itemId: string | null): Promise<void> {
  let w;
  try {
    w = ws.load(id);
  } catch {
    return;
  }
  const conn = srv.servers().find((x) => x.id === w.serverId);
  if (!conn || !w.remoteId) return;
  const token = await getToken(conn.id);
  await fetch(`${conn.url}/api/v1/workspaces/${encodeURIComponent(w.remoteId)}/presence`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId }),
  }).catch(() => undefined);
}

/** The request this app has open in a team workspace (null: none). Re-sent every 30 s while set. */
export function setPresence(workspaceId: string, itemId: string | null): void {
  for (const [id] of looking) if (id !== workspaceId) (looking.delete(id), void post(id, null));
  looking.set(workspaceId, itemId);
  void post(workspaceId, itemId);
  beat ??= setInterval(() => {
    for (const [id, item] of looking) void post(id, item);
  }, 30_000);
}
