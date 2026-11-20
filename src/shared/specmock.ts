import type { SpecResponse } from './types';

/**
 * The pieces of a mock server made from a spec (#94), kept free of Node so they can be tested on their own: which
 * request a call is for (method and path, `:id` / `{id}` segments match anything, the most literal route wins), which
 * of its responses to give (the first 2xx, or the status a `Prefer: code=404` header asks for, as Prism does), and a
 * body (the spec's example, else one made from the schema).
 */

export interface MockRoute {
  method: string;
  /** `/users/:id` (the request's URL without its variable or host, and without the query). */
  path: string;
  name: string;
  responses: SpecResponse[];
}

/** `{{baseUrl}}/users/{id}?page=1` → `/users/:id`. */
export function routePath(url: string): string {
  const p = url
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/\{([^}/]+)\}/g, ':$1')
    .replace(/\/+$/, '');
  return p.startsWith('/') ? p : `/${p}`;
}

const segs = (p: string) => p.split('/').filter(Boolean);
const isVar = (s: string) => s.startsWith(':') || /^\{\{.+\}\}$/.test(s);

/** The route a call is for, or null. HEAD is answered by GET's route. */
export function matchRoute(routes: MockRoute[], method: string, path: string): MockRoute | null {
  const want = segs(decodeURI(path.split(/[?#]/)[0]));
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  let best: { r: MockRoute; score: number } | null = null;
  for (const r of routes) {
    if (r.method.toUpperCase() !== m) continue;
    const have = segs(r.path);
    if (have.length !== want.length) continue;
    let score = 0;
    let fits = true;
    for (let i = 0; i < have.length && fits; i++) {
      if (isVar(have[i])) continue;
      if (have[i] === want[i]) score++;
      else fits = false;
    }
    if (fits && (!best || score > best.score)) best = { r, score };
  }
  return best?.r ?? null;
}

/** Other methods on a path that exists (for 405). */
export function methodsOn(routes: MockRoute[], path: string): string[] {
  return [...new Set(routes.filter((r) => matchRoute([{ ...r, method: 'X' }], 'X', path)).map((r) => r.method.toUpperCase()))];
}

/** The status a `Prefer: code=404` header asks for. */
export function preferredCode(prefer: string | undefined): number | null {
  const m = prefer?.match(/(?:^|[,;\s])code=(\d{3})/i);
  return m ? Number(m[1]) : null;
}

/** The response to give: the asked-for status (exact, its class, or default), else the first 2xx, else the first. */
export function pickResponse(responses: SpecResponse[], code: number | null): { status: number; response: SpecResponse } | null {
  if (!responses.length) return null;
  if (code) {
    const s = String(code);
    const r = responses.find((x) => x.status === s) ?? responses.find((x) => x.status === `${s[0]}XX`) ?? responses.find((x) => x.status === 'DEFAULT');
    if (r) return { status: code, response: r };
  }
  const ok = [...responses].filter((r) => /^2/.test(r.status)).sort((a, b) => a.status.localeCompare(b.status))[0];
  const r = ok ?? responses.find((x) => x.status === 'DEFAULT') ?? responses[0];
  const status = /^\d{3}$/.test(r.status) ? Number(r.status) : /^\dXX$/.test(r.status) ? Number(r.status[0]) * 100 : 200;
  return { status, response: r };
}

type Schema = Record<string, unknown>;

/** A value that fits a schema: its example, default, first enum value or const, else one made up from its type. */
export function exampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;
  const s = schema as Schema;
  if ('example' in s) return s.example;
  if ('default' in s) return s.default;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x) => exampleFromSchema(x, depth + 1)).filter((x) => x && typeof x === 'object' && !Array.isArray(x)));
  const one = (Array.isArray(s.oneOf) && s.oneOf[0]) || (Array.isArray(s.anyOf) && s.anyOf[0]);
  if (one) return exampleFromSchema(one, depth + 1);
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : (s.type as string | undefined);
  switch (type ?? (s.properties ? 'object' : s.items ? 'array' : undefined)) {
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, exampleFromSchema(v, depth + 1)]));
    }
    case 'array':
      return s.items ? [exampleFromSchema(s.items, depth + 1)] : [];
    case 'integer':
      return 1;
    case 'number':
      return 1.5;
    case 'boolean':
      return true;
    case 'string':
      switch (s.format) {
        case 'date-time':
          return '2026-01-01T09:00:00Z';
        case 'date':
          return '2026-01-01';
        case 'email':
          return 'user@example.com';
        case 'uuid':
          return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
        case 'uri':
        case 'url':
          return 'https://example.com';
        default:
          return 'string';
      }
    default:
      return null;
  }
}

/** What the mock answers for a spec response: content type and body text. */
export function mockBody(r: SpecResponse): { contentType: string; body: string } {
  const type = r.types.find((t) => /json/i.test(t)) ?? r.types[0] ?? '';
  if (!type) return { contentType: '', body: '' };
  const value = r.example !== undefined ? r.example : r.schema ? exampleFromSchema(r.schema) : undefined;
  if (/json/i.test(type)) return { contentType: type, body: value === undefined ? '' : JSON.stringify(value, null, 2) };
  return { contentType: type, body: value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value) };
}
