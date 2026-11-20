/**
 * Socket.IO over a WebSocket tab (#98): Engine.IO v4 framing and Socket.IO v5 packets, enough to talk to a server the
 * way its JavaScript client does, over the WebSocket transport only (no long-polling).
 *   address    ws://host:port/<namespace>  → ws://host:port/socket.io/?EIO=4&transport=websocket, namespace /<namespace>
 *              (a path that already holds socket.io is used as it is, namespace /)
 *   engine     0 open {sid, pingInterval} · 2 ping → answer 3 pong · 4 message (a Socket.IO packet) · 1 close
 *   socket.io  0 connect (sent after open; the server's 0 confirms) · 1 disconnect · 2 event ["name", ...args]
 *              · 3 ack · 4 connect error; a namespace other than / comes first, followed by a comma
 */

export function sioUrl(input: string): { url: string; namespace: string } {
  const u = new URL(input);
  let namespace = '/';
  if (!/socket\.io/.test(u.pathname)) {
    namespace = u.pathname.replace(/\/+$/, '') || '/';
    u.pathname = '/socket.io/';
  }
  u.searchParams.set('EIO', '4');
  u.searchParams.set('transport', 'websocket');
  return { url: u.toString(), namespace };
}

const nsPrefix = (ns: string) => (ns && ns !== '/' ? `${ns},` : '');

/** The Socket.IO connect packet for a namespace (with an auth object when given). */
export const sioConnect = (namespace: string, auth?: unknown) => `40${nsPrefix(namespace)}${auth !== undefined ? JSON.stringify(auth) : ''}`;

/** An event: `name` and the args, from the text typed (a JSON list = several args, other JSON = one, '' = none). */
export function sioEvent(namespace: string, name: string, argsText: string): string {
  if (!name.trim()) throw new Error('Type the event name');
  const t = argsText.trim();
  let args: unknown[] = [];
  if (t) {
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      v = argsText; // plain text: one string argument
    }
    args = Array.isArray(v) ? v : [v];
  }
  return `42${nsPrefix(namespace)}${JSON.stringify([name.trim(), ...args])}`;
}

export type SioFrame =
  | { kind: 'open'; sid?: string; pingInterval?: number }
  | { kind: 'ping' }
  | { kind: 'close' }
  | { kind: 'connect'; namespace: string; sid?: string }
  | { kind: 'disconnect'; namespace: string }
  | { kind: 'event'; namespace: string; name: string; args: unknown[]; ackId?: number }
  | { kind: 'ack'; namespace: string; ackId?: number; args: unknown[] }
  | { kind: 'connect_error'; namespace: string; message: string }
  | { kind: 'other'; raw: string };

/** One WebSocket text frame from the server, decoded. */
export function sioDecode(frame: string): SioFrame {
  const e = frame[0];
  if (e === '0') {
    try {
      const o = JSON.parse(frame.slice(1)) as { sid?: string; pingInterval?: number };
      return { kind: 'open', sid: o.sid, pingInterval: o.pingInterval };
    } catch {
      return { kind: 'open' };
    }
  }
  if (e === '2') return { kind: 'ping' };
  if (e === '1') return { kind: 'close' };
  if (e !== '4') return { kind: 'other', raw: frame };
  const p = frame.slice(1);
  const type = p[0];
  let rest = p.slice(1);
  let namespace = '/';
  if (rest.startsWith('/')) {
    const c = rest.indexOf(',');
    namespace = c < 0 ? rest : rest.slice(0, c);
    rest = c < 0 ? '' : rest.slice(c + 1);
  }
  const idMatch = rest.match(/^(\d+)/);
  const ackId = idMatch ? Number(idMatch[1]) : undefined;
  if (idMatch) rest = rest.slice(idMatch[1].length);
  const json = (): unknown => {
    try {
      return rest ? JSON.parse(rest) : undefined;
    } catch {
      return rest;
    }
  };
  switch (type) {
    case '0':
      return { kind: 'connect', namespace, sid: (json() as { sid?: string } | undefined)?.sid };
    case '1':
      return { kind: 'disconnect', namespace };
    case '2': {
      const v = json();
      const list = Array.isArray(v) ? v : [];
      return { kind: 'event', namespace, name: String(list[0] ?? ''), args: list.slice(1), ...(ackId !== undefined ? { ackId } : {}) };
    }
    case '3': {
      const v = json();
      return { kind: 'ack', namespace, ...(ackId !== undefined ? { ackId } : {}), args: Array.isArray(v) ? v : [] };
    }
    case '4': {
      const v = json() as { message?: string } | string | undefined;
      return { kind: 'connect_error', namespace, message: typeof v === 'string' ? v : (v?.message ?? 'The server refused the connection') };
    }
    default:
      return { kind: 'other', raw: frame };
  }
}
