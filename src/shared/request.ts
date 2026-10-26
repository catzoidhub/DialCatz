import { emptyBody, HTTP_METHODS, type EnvVariable, type HttpMethod, type KeyValue, type RequestAuth, type RequestSpec, type WireRequest } from './types';

export type { WireRequest };

/**
 * Turning a saved request into what goes on the wire: {{variables}}, query params, auth and body; and the way back
 * (cURL import, URL ⇄ params table). Pure functions, used by the window (preview, code snippets) and the main process.
 */

export type Vars = Map<string, string>;

/** Environment over globals: the active environment wins on the same name. Disabled rows are left out. */
export function buildVars(...layers: (EnvVariable[] | undefined)[]): Vars {
  const out: Vars = new Map();
  for (const layer of layers) for (const v of layer ?? []) if (v.enabled && v.key.trim()) out.set(v.key.trim(), v.value);
  return out;
}

const VAR_RE = /\{\{\s*([\w.$-]+)\s*\}\}/g;

/** Fills {{name}} from vars; unknown names stay as written so the user can see them. A few dynamic ones built in. */
export function interpolate(text: string, vars: Vars): string {
  if (!text || !text.includes('{{')) return text;
  return text.replace(VAR_RE, (whole, name: string) => {
    if (vars.has(name)) return vars.get(name)!;
    switch (name) {
      case '$timestamp':
        return String(Math.floor(Date.now() / 1000));
      case '$isoTimestamp':
        return new Date().toISOString();
      case '$randomUUID':
      case '$guid':
        return crypto.randomUUID();
      case '$randomInt':
        return String(Math.floor(Math.random() * 1000));
      default:
        return whole;
    }
  });
}

/** Names used in a text that have no value (for the "unknown variable" hint). */
export function missingVars(text: string, vars: Vars): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(VAR_RE)) if (!vars.has(m[1]) && !m[1].startsWith('$')) out.add(m[1]);
  return [...out];
}

/** Splits "https://x/y?a=1&b" into the base and its query rows. Keeps {{vars}} intact. */
export function splitUrl(url: string): { base: string; params: KeyValue[] } {
  const q = url.indexOf('?');
  if (q < 0) return { base: url, params: [] };
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const params = query
    .split('&')
    .filter((p) => p.length)
    .map((p) => {
      const i = p.indexOf('=');
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/\+/g, ' '));
        } catch {
          return s;
        }
      };
      return { key: dec(i < 0 ? p : p.slice(0, i)), value: i < 0 ? '' : dec(p.slice(i + 1)), enabled: true };
    });
  return { base: url.slice(0, q), params };
}

const enc = (s: string) => encodeURIComponent(s).replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}');

/** Base URL + enabled params → the URL text shown in the address bar (variables left unresolved). */
export function joinUrl(base: string, params: KeyValue[]): string {
  const on = params.filter((p) => p.enabled && p.key);
  if (!on.length) return base;
  return `${base}?${on.map((p) => (p.value === '' ? enc(p.key) : `${enc(p.key)}=${enc(p.value)}`)).join('&')}`;
}

/**
 * Headers every request gets unless switched off (per request: spec.autoOff; for new requests: Settings →
 * Requests). A header of the same name in the request's own table wins. Shown in the Headers tab, so what is
 * sent is what the user sees.
 */
export const AUTO_HEADERS: { key: string; value: (ctx: AutoContext) => string }[] = [
  { key: 'User-Agent', value: (c) => `DialCatz/${c.version}` },
  { key: 'Accept', value: () => '*/*' },
  { key: 'Accept-Encoding', value: () => 'gzip, deflate, br' },
  { key: 'Connection', value: () => 'keep-alive' },
  { key: 'Cache-Control', value: () => 'no-cache' },
];
export interface AutoContext {
  version: string;
}
/** Headers worked out when the request is sent (shown read-only). */
export const COMPUTED_HEADERS = ['Host', 'Content-Length', 'Content-Type'];

const hasHeader = (h: [string, string][], name: string) => h.some(([k]) => k.toLowerCase() === name.toLowerCase());

/** The auth that applies: the request's own, else the nearest folder / collection that sets one. */
export function effectiveAuth(own: RequestAuth, inherited: RequestAuth[]): RequestAuth {
  if (own.mode !== 'inherit') return own;
  return inherited.find((a) => a.mode !== 'inherit') ?? { mode: 'none' };
}

/** A request with variables filled, auth applied and the body encoded. */
export function toWire(spec: RequestSpec, vars: Vars, auth: RequestAuth = spec.auth, ctx: AutoContext = { version: '0.1' }): WireRequest {
  const v = (s: string | undefined) => interpolate(s ?? '', vars);
  let url = v(spec.url.trim());
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  const headers: [string, string][] = spec.headers.filter((h) => h.enabled && h.key.trim()).map((h) => [v(h.key).trim(), v(h.value)]);

  const extraQuery: [string, string][] = [];
  switch (auth.mode) {
    case 'bearer':
      if (auth.token && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Bearer ${v(auth.token)}`]);
      break;
    case 'basic':
      if (!hasHeader(headers, 'authorization')) headers.push(['Authorization', `Basic ${base64(`${v(auth.username)}:${v(auth.password)}`)}`]);
      break;
    case 'apikey':
      if (auth.key) {
        if (auth.in === 'query') extraQuery.push([v(auth.key), v(auth.value)]);
        else if (!hasHeader(headers, v(auth.key))) headers.push([v(auth.key), v(auth.value)]);
      }
      break;
  }
  if (extraQuery.length) url += (url.includes('?') ? '&' : '?') + extraQuery.map(([k, val]) => `${encodeURIComponent(k)}=${encodeURIComponent(val)}`).join('&');

  let body: string | undefined;
  let multipart: WireRequest['multipart'];
  let bodyFile: string | undefined;
  const b = spec.body ?? emptyBody();
  const canHaveBody = !['GET', 'HEAD'].includes(spec.method);
  if (canHaveBody) {
    const setType = (t: string) => {
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', t]);
    };
    switch (b.mode) {
      case 'json':
        body = v(b.raw);
        setType('application/json');
        break;
      case 'xml':
        body = v(b.raw);
        setType('application/xml');
        break;
      case 'text':
        body = v(b.raw);
        setType('text/plain');
        break;
      case 'graphql': {
        let variables: unknown;
        const raw = v(b.variables ?? '').trim();
        if (raw) {
          try {
            variables = JSON.parse(raw);
          } catch {
            variables = undefined;
          }
        }
        body = JSON.stringify(variables === undefined ? { query: v(b.raw) } : { query: v(b.raw), variables });
        setType('application/json');
        break;
      }
      case 'form':
        body = b.fields
          .filter((f) => f.enabled && f.key)
          .map((f) => `${encodeURIComponent(v(f.key))}=${encodeURIComponent(v(f.value))}`)
          .join('&');
        setType('application/x-www-form-urlencoded');
        break;
      case 'multipart':
        // The main process builds the body with its own boundary (and reads the files).
        multipart = b.fields.filter((f) => f.enabled && f.key).map((f) => (f.type === 'file' ? { name: v(f.key), file: f.src ?? '' } : { name: v(f.key), value: v(f.value) }));
        for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === 'content-type') headers.splice(i, 1);
        headers.push(['Content-Type', 'multipart/form-data']);
        break;
      case 'binary':
        bodyFile = b.file ?? '';
        setType('application/octet-stream');
        break;
    }
  }
  const off = new Set((spec.autoOff ?? []).map((k) => k.toLowerCase()));
  for (const a of AUTO_HEADERS) if (!off.has(a.key.toLowerCase()) && !hasHeader(headers, a.key)) headers.push([a.key, a.value(ctx)]);
  return { method: spec.method, url, headers, body, multipart, bodyFile };
}


function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A cURL command for the request (the wire form). */
export function toCurl(w: WireRequest): string {
  const parts = [`curl -X ${w.method} ${shq(w.url)}`];
  for (const [k, val] of w.headers) if (!(w.multipart && /^content-type$/i.test(k))) parts.push(`-H ${shq(`${k}: ${val}`)}`);
  if (w.body !== undefined && w.body !== '') parts.push(`--data-raw ${shq(w.body)}`);
  for (const p of w.multipart ?? []) parts.push(`-F ${shq(p.file !== undefined ? `${p.name}=@${p.file || '<file>'}` : `${p.name}=${p.value ?? ''}`)}`);
  if (w.bodyFile !== undefined) parts.push(`--data-binary ${shq(`@${w.bodyFile || '<file>'}`)}`);
  return parts.join(' \\\n  ');
}

/** A fetch() snippet (JavaScript). */
export function toFetch(w: WireRequest): string {
  const opts: string[] = [`  method: ${JSON.stringify(w.method)}`];
  const hs = w.multipart ? w.headers.filter(([k]) => !/^content-type$/i.test(k)) : w.headers;
  if (hs.length) opts.push(`  headers: {\n${hs.map(([k, val]) => `    ${JSON.stringify(k)}: ${JSON.stringify(val)}`).join(',\n')}\n  }`);
  if (w.body) opts.push(`  body: ${JSON.stringify(w.body)}`);
  if (w.multipart) {
    const form = w.multipart.map((p) => (p.file !== undefined ? `form.append(${JSON.stringify(p.name)}, fileInput.files[0]); // ${p.file || 'a file'}` : `form.append(${JSON.stringify(p.name)}, ${JSON.stringify(p.value ?? '')});`)).join('\n');
    opts.push('  body: form');
    return `const form = new FormData();\n${form}\nconst res = await fetch(${JSON.stringify(w.url)}, {\n${opts.join(',\n')}\n});\nconsole.log(res.status, await res.text());`;
  }
  return `const res = await fetch(${JSON.stringify(w.url)}, {\n${opts.join(',\n')}\n});\nconsole.log(res.status, await res.text());`;
}

/** Splits a shell command line into words (single / double quotes, backslash escapes, line continuations). */
function shellWords(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const s = cmd.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Reads a pasted cURL command into a request (null: not a cURL command). */
export function parseCurl(cmd: string): RequestSpec | null {
  const words = shellWords(cmd.trim());
  if (words[0] !== 'curl') return null;
  let method: string | null = null;
  let url = '';
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const formFields: KeyValue[] = [];
  let user: string | null = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const next = () => words[++i] ?? '';
    if (w === '-X' || w === '--request') method = next().toUpperCase();
    else if (w === '-H' || w === '--header') {
      const h = next();
      const c = h.indexOf(':');
      if (c > 0) headers.push({ key: h.slice(0, c).trim(), value: h.slice(c + 1).trim(), enabled: true });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '--json'].includes(w)) {
      data.push(next());
      if (w === '--json' && !headers.some((h) => h.key.toLowerCase() === 'content-type')) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
    } else if (w === '-F' || w === '--form') {
      const f = next();
      const e = f.indexOf('=');
      formFields.push({ key: e < 0 ? f : f.slice(0, e), value: e < 0 ? '' : f.slice(e + 1), enabled: true });
    } else if (w === '-u' || w === '--user') user = next();
    else if (w === '--url') url = next();
    else if (w === '-I' || w === '--head') method = 'HEAD';
    else if (['-A', '--user-agent'].includes(w)) headers.push({ key: 'User-Agent', value: next(), enabled: true });
    else if (['-b', '--cookie'].includes(w)) headers.push({ key: 'Cookie', value: next(), enabled: true });
    else if (['-e', '--referer'].includes(w)) headers.push({ key: 'Referer', value: next(), enabled: true });
    else if (['-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '--retry', '-x', '--proxy', '--cacert', '--cert', '--key'].includes(w)) next();
    else if (w.startsWith('-')) continue;
    else if (!url) url = w;
  }
  if (!url) return null;
  const { base, params } = splitUrl(url);
  const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  const raw = data.join('&');
  const spec: RequestSpec = {
    method: (HTTP_METHODS as readonly string[]).includes(method ?? '') ? (method as HttpMethod) : data.length || formFields.length ? 'POST' : 'GET',
    url: joinUrl(base, params),
    params,
    headers: headers.filter((h) => !(formFields.length && h.key.toLowerCase() === 'content-type')),
    body: emptyBody(),
    auth: { mode: 'inherit' },
  };
  if (formFields.length) spec.body = { mode: 'multipart', raw: '', fields: formFields };
  else if (data.length) {
    if (/json/i.test(contentType) || /^\s*[[{]/.test(raw)) spec.body = { mode: 'json', raw: prettyJson(raw), fields: [] };
    else if (/x-www-form-urlencoded/i.test(contentType) || (!contentType && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw))) {
      spec.body = { mode: 'form', raw: '', fields: splitUrl(`?${raw}`).params };
      spec.headers = spec.headers.filter((h) => h.key.toLowerCase() !== 'content-type');
    } else spec.body = { mode: /xml/i.test(contentType) ? 'xml' : 'text', raw, fields: [] };
    if (spec.body.mode === 'json') spec.headers = spec.headers.filter((h) => !(h.key.toLowerCase() === 'content-type' && /^application\/json$/i.test(h.value)));
  }
  if (user !== null) {
    const c = user.indexOf(':');
    spec.auth = { mode: 'basic', username: c < 0 ? user : user.slice(0, c), password: c < 0 ? '' : user.slice(c + 1) };
  } else {
    const ah = spec.headers.findIndex((h) => /^authorization$/i.test(h.key) && /^bearer\s+/i.test(h.value));
    if (ah >= 0) {
      spec.auth = { mode: 'bearer', token: spec.headers[ah].value.replace(/^bearer\s+/i, '') };
      spec.headers.splice(ah, 1);
    }
  }
  return spec;
}

export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** A short name for a request from its URL ("GET /users/:id"). */
export function nameFromUrl(method: string, url: string): string {
  const path = splitUrl(url).base.replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/^\{\{[^}]+\}\}/, '') || '/';
  return `${method} ${path}`.slice(0, 80);
}

/**
 * A request without the paths of picked files: those belong to this computer and never travel (export, team
 * sync, import). The field stays as a file field; the user picks the file again.
 */
export function stripLocalFiles<T extends RequestSpec | undefined>(spec: T): T {
  if (!spec?.body) return spec;
  return { ...spec, body: { ...spec.body, file: undefined, fields: spec.body.fields.map((f) => (f.src ? { ...f, src: undefined } : f)) } };
}
