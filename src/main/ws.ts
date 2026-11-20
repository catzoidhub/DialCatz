import type { WsEvent } from '@shared/types';
import { sioConnect, sioDecode, sioEvent, sioUrl } from '@shared/socketio';

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
let emit: (e: WsEvent) => void = () => undefined;
export const onEvent = (fn: (e: WsEvent) => void) => (emit = fn);

const MAX_FRAME_SHOWN = 1024 * 1024;

export function connect(token: string, url: string, headers: [string, string][], protocols: string[], options: { socketIo?: boolean } = {}): void {
  close(token);
  if (!/^wss?:\/\//i.test(url)) throw new Error('A WebSocket address starts with ws:// or wss://');
  let namespace: string | null = null;
  if (options.socketIo) ({ url, namespace } = sioUrl(url));
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
  ws.onopen = () => emit({ token, type: 'open', at: at(), data: namespace !== null ? `Socket.IO, namespace ${namespace}` : ws.protocol ? `subprotocol ${ws.protocol}` : '' });
  ws.onmessage = (m) => {
    if (namespace !== null && typeof m.data === 'string') return onSio(token, ws, namespace, m.data);
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

export function send(token: string, data: string, event?: string): void {
  const ws = sockets.get(token);
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
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
  try {
    ws.close(1000, 'Closed by DialCatz');
  } catch {
    /* already closing */
  }
}

export function closeAll(): void {
  for (const t of [...sockets.keys()]) close(t);
}
