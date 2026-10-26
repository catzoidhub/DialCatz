import type { WsEvent } from '@shared/types';

/**
 * WebSocket connections for ws:// and wss:// request tabs, from the main process (Node's built-in WebSocket
 * client, undici): custom handshake headers and subprotocols, text and binary frames, one connection per tab
 * token. Events go to the window as they happen (connecting, open, message in / out, error, close).
 */

const sockets = new Map<string, WebSocket>();
let emit: (e: WsEvent) => void = () => undefined;
export const onEvent = (fn: (e: WsEvent) => void) => (emit = fn);

const MAX_FRAME_SHOWN = 1024 * 1024;

export function connect(token: string, url: string, headers: [string, string][], protocols: string[]): void {
  close(token);
  if (!/^wss?:\/\//i.test(url)) throw new Error('A WebSocket address starts with ws:// or wss://');
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
  ws.onopen = () => emit({ token, type: 'open', at: at(), data: ws.protocol ? `subprotocol ${ws.protocol}` : '' });
  ws.onmessage = (m) => {
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

export function send(token: string, data: string): void {
  const ws = sockets.get(token);
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');
  ws.send(data);
  emit({ token, type: 'out', at: Date.now(), data, size: Buffer.byteLength(data) });
}

export function close(token: string): void {
  const ws = sockets.get(token);
  if (!ws) return;
  sockets.delete(token);
  try {
    ws.close(1000, 'Closed by DialCatz');
  } catch {
    /* already closing */
  }
}

export function closeAll(): void {
  for (const t of [...sockets.keys()]) close(t);
}
