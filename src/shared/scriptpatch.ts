import type { WireRequest } from './types';
import { interpolate, type Vars } from './request';

/** What a pre-request script changed of the request (dc.request.setHeader …, Bruno's req.*), applied to what is sent. */
export interface RequestPatch {
  method?: string;
  url?: string;
  body?: string;
  /** Name → value, null to take it away. */
  headers?: Record<string, string | null>;
}

/** Scripts answer with plain data: only text of the right shape is taken. */
export const textRecord = (x: unknown): Record<string, string> => (x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([, v]) => typeof v === 'string')) : {}) as Record<string, string>;
export function readPatch(x: unknown): RequestPatch | undefined {
  if (!x || typeof x !== 'object') return undefined;
  const p = x as Record<string, unknown>;
  const out: RequestPatch = {};
  if (typeof p.method === 'string' && /^[A-Z]{1,20}$/.test(p.method)) out.method = p.method;
  if (typeof p.url === 'string') out.url = p.url;
  if (typeof p.body === 'string') out.body = p.body;
  if (p.headers && typeof p.headers === 'object') out.headers = Object.fromEntries(Object.entries(p.headers).filter(([k, v]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) && (v === null || (typeof v === 'string' && !/[\r\n]/.test(v))))) as Record<string, string | null>;
  return Object.keys(out).length ? out : undefined;
}

export function applyPatch(wire: WireRequest, patches: RequestPatch[], vars: Vars): WireRequest {
  let w = wire;
  for (const p of patches) {
    let headers = w.headers;
    for (const [k, v] of Object.entries(p.headers ?? {})) {
      const at = headers.findIndex(([n]) => n.toLowerCase() === k.toLowerCase());
      headers = headers.filter(([n]) => n.toLowerCase() !== k.toLowerCase());
      if (v !== null) headers = at < 0 ? [...headers, [k, interpolate(v, vars)]] : [...headers.slice(0, at), [k, interpolate(v, vars)], ...headers.slice(at)];
    }
    w = { ...w, headers, ...(p.method ? { method: p.method } : {}), ...(p.url !== undefined ? { url: interpolate(p.url, vars) } : {}), ...(p.body !== undefined ? { body: interpolate(p.body, vars), multipart: undefined, bodyFile: undefined } : {}) };
  }
  return w;
}
