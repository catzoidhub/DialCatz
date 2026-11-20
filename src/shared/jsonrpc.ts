/**
 * JSON-RPC 2.0 (#97): the body mode builds the envelope from a method and params, or a batch from a list of calls, and
 * the response view reads the replies back by id.
 *   single  method + params (JSON text: an object or an array; empty = none) → { jsonrpc, method, params?, id: 1 }
 *   batch   params is a JSON array of { method, params?, notify? } → one envelope each, ids 1, 2, …
 *   notify  no id: a notification, which gets no reply
 */

export interface RpcCall {
  method: string;
  params?: unknown;
  notify?: boolean;
}

/** The text of params, already parsed ('' → none). Throws a readable error for text that is not JSON. */
function parse(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(`The params are not JSON: ${(e as Error).message}`);
  }
}

export function rpcEnvelope(o: { method: string; params: string; batch?: boolean; notify?: boolean }): unknown {
  if (o.batch) {
    const list = parse(o.params);
    if (!Array.isArray(list) || !list.length) throw new Error('A batch is a JSON list of calls: [{ "method": "…", "params": … }, …]');
    return list.map((c, i) => {
      const call = (c ?? {}) as RpcCall;
      if (typeof call.method !== 'string' || !call.method) throw new Error(`Call ${i + 1} of the batch has no method`);
      return { jsonrpc: '2.0', method: call.method, ...(call.params !== undefined ? { params: call.params } : {}), ...(call.notify ? {} : { id: i + 1 }) };
    });
  }
  if (!o.method.trim()) throw new Error('Type the JSON-RPC method');
  const params = parse(o.params);
  return { jsonrpc: '2.0', method: o.method.trim(), ...(params !== undefined ? { params } : {}), ...(o.notify ? {} : { id: 1 }) };
}

export const RPC_ERRORS: Record<number, string> = {
  [-32700]: 'Parse error: the server could not read the JSON',
  [-32600]: 'Invalid request',
  [-32601]: 'Method not found',
  [-32602]: 'Invalid params',
  [-32603]: 'Internal error',
};

export interface RpcReply {
  id: unknown;
  /** The method the id belongs to, from the request sent. */
  method: string | null;
  ok: boolean;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown; meaning?: string };
}

/** The replies in a response, each matched to its call by id (null when the body is not JSON-RPC). */
export function rpcReplies(sentBody: string | undefined, responseBody: string): RpcReply[] | null {
  let res: unknown;
  try {
    res = JSON.parse(responseBody);
  } catch {
    return null;
  }
  const list = Array.isArray(res) ? res : [res];
  if (!list.length || !list.every((r) => r && typeof r === 'object' && ('result' in r || 'error' in r))) return null;
  const methods = new Map<string, string>();
  try {
    const sent = JSON.parse(sentBody ?? '');
    for (const c of Array.isArray(sent) ? sent : [sent]) if (c && c.id !== undefined) methods.set(JSON.stringify(c.id), String(c.method));
  } catch {
    /* the request was not JSON: no names */
  }
  return list.map((r) => {
    const x = r as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    const method = methods.get(JSON.stringify(x.id ?? null)) ?? null;
    if (x.error) {
      const code = Number(x.error.code);
      const meaning = RPC_ERRORS[code] ?? (code <= -32000 && code >= -32099 ? 'Server error' : undefined);
      return { id: x.id ?? null, method, ok: false, error: { code, message: String(x.error.message ?? ''), ...(x.error.data !== undefined ? { data: x.error.data } : {}), ...(meaning ? { meaning } : {}) } };
    }
    return { id: x.id ?? null, method, ok: true, result: x.result };
  });
}
