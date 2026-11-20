import type { WsEvent } from '@shared/types';
import { sioConnect, sioDecode, sioEvent, sioUrl } from '@shared/socketio';
import { authText, clientEventFrame, isPresence, needsAuth, pongFrame, pusherDecode, pusherUrl, subscribeFrame, unsubscribeFrame } from '@shared/pusher';
import { createHmac } from 'node:crypto';

/**
 * WebSocket connections for ws:// and wss:// request tabs, from the main process (Node's built-in WebSocket
 * client, undici): custom handshake headers and subprotocols, text and binary frames, one connection per tab
 * token. Events go to the window as they happen (connecting, open, message in / out, error, close).
 * Socket.IO mode (#98, shared/socketio.ts): the Engine.IO handshake and pings are answered here, and the window sees
 * events by name and the namespace's connect / disconnect, not the raw frames.
 */

const sockets = new Map<string, WebSocket>();
/** Socket.IO connections: their namespace. */
const sio = new Map<string, string>();
/** Pusher connections (#99): the app key, the socket id the server gave, the channels joined. */
const pusher = new Map<string, { key: string; socketId: string | null; channels: Set<string> }>();
let emit: (e: WsEvent) => void = () => undefined;
export const onEvent = (fn: (e: WsEvent) => void) => (emit = fn);

const MAX_FRAME_SHOWN = 1024 * 1024;

export function connect(token: string, url: string, headers: [string, string][], protocols: string[], options: { socketIo?: boolean; pusher?: boolean } = {}): void {
  close(token);
  if (!/^wss?:\/\//i.test(url)) throw new Error('A WebSocket address starts with ws:// or wss://');
  let namespace: string | null = null;
  if (options.socketIo) ({ url, namespace } = sioUrl(url));
  let pusherKey: string | null = null;
  if (options.pusher) ({ url, key: pusherKey } = pusherUrl(url));
  const at = () => Date.now();
  emit({ token, type: 'connecting', at: at(), data: url });
  let ws: WebSocket;
  try {
    // undici's WebSocket takes headers next to the subprotocols (not in the browser API).
    ws = new WebSocket(url, { protocols, headers: Object.fromEntries(headers) } as unknown as string[]);
  } catch (e) {
    emit({ token, type: 'error', at: at(), data: (e as Error).message });
    return;
  }
  ws.binaryType = 'arraybuffer';
  sockets.set(token, ws);
  if (namespace !== null) sio.set(token, namespace);
  else sio.delete(token);
  if (pusherKey !== null) pusher.set(token, { key: pusherKey, socketId: null, channels: new Set() });
  else pusher.delete(token);
  ws.onopen = () => emit({ token, type: 'open', at: at(), data: pusherKey !== null ? `Pusher, app key ${pusherKey}` : namespace !== null ? `Socket.IO, namespace ${namespace}` : ws.protocol ? `subprotocol ${ws.protocol}` : '' });
  ws.onmessage = (m) => {
    if (namespace !== null && typeof m.data === 'string') return onSio(token, ws, namespace, m.data);
    if (pusherKey !== null && typeof m.data === 'string') return onPusher(token, ws, m.data);
    if (typeof m.data === 'string') emit({ token, type: 'in', at: at(), data: m.data.length > MAX_FRAME_SHOWN ? `${m.data.slice(0, MAX_FRAME_SHOWN)}…` : m.data, size: Buffer.byteLength(m.data) });
    else {
      const buf = Buffer.from(m.data as ArrayBuffer);
      emit({ token, type: 'in', at: at(), data: buf.subarray(0, 4096).toString('base64'), binary: true, size: buf.length });
    }
  };
  ws.onerror = (e) => emit({ token, type: 'error', at: at(), data: (e as ErrorEvent).message || 'The connection failed' });
  ws.onclose = (c) => {
    if (sockets.get(token) === ws) sockets.delete(token);
    emit({ token, type: 'close', at: at(), data: `${c.code}${c.reason ? ` ${c.reason}` : ''}` });
  };
}

/** Socket.IO frames: pings answered, the namespace joined once the engine is open, events shown by name. */
function onSio(token: string, ws: WebSocket, namespace: string, frame: string): void {
  const at = Date.now();
  const f = sioDecode(frame);
  switch (f.kind) {
    case 'ping':
      ws.send('3');
      return;
    case 'open':
      ws.send(sioConnect(namespace));
      return;
    case 'connect':
      return emit({ token, type: 'in', at, data: f.sid ? `sid ${f.sid}` : '', event: 'connect' });
    case 'disconnect':
      return emit({ token, type: 'in', at, data: `namespace ${f.namespace}`, event: 'disconnect' });
    case 'connect_error':
      return emit({ token, type: 'error', at, data: f.message, event: 'connect_error' });
    case 'event': {
      const data = JSON.stringify(f.args.length === 1 ? f.args[0] : f.args);
      return emit({ token, type: 'in', at, data: data.length > MAX_FRAME_SHOWN ? `${data.slice(0, MAX_FRAME_SHOWN)}…` : data, size: Buffer.byteLength(frame), event: f.name });
    }
    case 'ack':
      return emit({ token, type: 'in', at, data: JSON.stringify(f.args), event: `ack ${f.ackId ?? ''}`.trim() });
    case 'close':
      return;
    default:
      return emit({ token, type: 'in', at, data: frame, size: Buffer.byteLength(frame) });
  }
}

/** Pusher frames: pings answered, the socket id kept, everything else shown by event and channel. */
function onPusher(token: string, ws: WebSocket, frame: string): void {
  const at = Date.now();
  const f = pusherDecode(frame);
  const p = pusher.get(token);
  if (!f) return emit({ token, type: 'in', at, data: frame, size: Buffer.byteLength(frame) });
  switch (f.event) {
    case 'pusher:ping':
      ws.send(pongFrame());
      return;
    case 'pusher:pong':
      return;
    case 'pusher:connection_established': {
      const id = (f.data as { socket_id?: string } | null)?.socket_id ?? null;
      if (p) p.socketId = id;
      return emit({ token, type: 'in', at, data: id ? `socket id ${id}` : '', event: 'connected' });
    }
    case 'pusher_internal:subscription_succeeded':
      return emit({ token, type: 'in', at, data: f.data && typeof f.data === 'object' && Object.keys(f.data).length ? JSON.stringify(f.data) : '', event: `subscribed ${f.channel ?? ''}`.trim() });
    case 'pusher:error': {
      const d = f.data as { message?: string; code?: number } | null;
      return emit({ token, type: 'error', at, data: `${d?.code ?? ''} ${d?.message ?? frame}`.trim(), event: 'pusher:error' });
    }
    default: {
      const data = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
      return emit({ token, type: 'in', at, data, size: Buffer.byteLength(frame), event: f.channel ? `${f.channel} · ${f.event}` : f.event });
    }
  }
}

/**
 * Joins or leaves a channel on a Pusher connection. private- / presence- channels are signed here with the app secret
 * (filled in from a {{variable}} by the window); a presence channel joins as `userId`.
 */
export function pusherChannel(token: string, action: 'subscribe' | 'unsubscribe', channel: string, o: { secret?: string; userId?: string } = {}): void {
  const ws = sockets.get(token);
  const p = pusher.get(token);
  if (!ws || ws.readyState !== WebSocket.OPEN || !p) throw new Error('Not connected to a Pusher server');
  const name = channel.trim();
  if (!/^[\w\-=@,.;]{1,164}$/.test(name)) throw new Error('A channel name is letters, digits and - _ = @ , . ; (up to 164)');
  if (action === 'unsubscribe') {
    ws.send(unsubscribeFrame(name));
    p.channels.delete(name);
    return emit({ token, type: 'out', at: Date.now(), data: '', event: `unsubscribe ${name}` });
  }
  let auth: string | undefined;
  let channelData: string | undefined;
  if (needsAuth(name)) {
    if (!o.secret) throw new Error(`${name} is ${isPresence(name) ? 'a presence' : 'a private'} channel: give the app secret (a {{variable}}, e.g. {{REVERB_APP_SECRET}})`);
    if (!p.socketId) throw new Error('The server has not given a socket id yet: wait for "connected"');
    if (isPresence(name)) channelData = JSON.stringify({ user_id: o.userId?.trim() || 'dialcatz', user_info: { name: 'DialCatz' } });
    auth = `${p.key}:${createHmac('sha256', o.secret).update(authText(p.socketId, name, channelData)).digest('hex')}`;
  }
  ws.send(subscribeFrame(name, auth, channelData));
  p.channels.add(name);
  emit({ token, type: 'out', at: Date.now(), data: '', event: `subscribe ${name}` });
}

export function send(token: string, data: string, event?: string, channel?: string): void {
  const ws = sockets.get(token);
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
  if (pusher.has(token) && event !== undefined) {
    const frame = clientEventFrame(channel ?? '', event, data);
    ws.send(frame);
    emit({ token, type: 'out', at: Date.now(), data, size: Buffer.byteLength(frame), event: `${channel} · ${JSON.parse(frame).event}` });
    return;
  }
  const ns = sio.get(token);
  if (ns !== undefined) {
    const frame = sioEvent(ns, event ?? '', data);
    ws.send(frame);
    emit({ token, type: 'out', at: Date.now(), data, size: Buffer.byteLength(frame), event: (event ?? '').trim() });
    return;
  }
  ws.send(data);
  emit({ token, type: 'out', at: Date.now(), data, size: Buffer.byteLength(data) });
}

export function close(token: string): void {
  const ws = sockets.get(token);
  if (!ws) return;
  sockets.delete(token);
  sio.delete(token);
  pusher.delete(token);
  try {
    ws.close(1000, 'Closed by DialCatz');
  } catch {
    /* already closing */
  }
}

export function closeAll(): void {
  for (const t of [...sockets.keys()]) close(t);
}
