import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Script } from 'node:vm';
import { parse as parseYaml } from 'yaml';
import { joinUrl, splitUrl } from '@shared/request';
import { emptyBody, HTTP_METHODS, newRequest, uid, type Environment, type EnvVariable, type HttpMethod, type KeyValue, type RequestAuth, type RequestBody, type RequestSpec, type TreeItem } from '@shared/types';
import { DYNAMIC } from './importnotes';
import { parseBru, type BruFile, type BruPair } from './brulang';

/**
 * Moving from Bruno (#104): a collection folder in either of its formats (.bru, or OpenCollection YAML) becomes a
 * DialCatz collection. Files are only read. What DialCatz has no place for is said in `notes`, never dropped quietly.
 *   headers of the collection / folders   copied into their requests (DialCatz has no inherited headers)
 *   collection variables                  into each environment that does not set them (the same order Bruno looks in)
 *   folder / request variables            for that send only, set by the pre-request script (bru.local)
 *   vars after a response, asserts        lines in the tests script (bru.capture, bru.assert)
 *   scripts                               as they are: the script sandbox has bru, req, res, test and expect
 *   {{process.env.X}}                     {{X}}, a secret variable; a .env file is never read
 */

export interface BrunoCollection {
  root: TreeItem;
  items: TreeItem[];
  environments: Environment[];
  format: 'bru' | 'yml';
  notes: string[];
}

const MAX_FILES = 5000;
const MAX_BYTES = 2_000_000;
const SKIP = /^(node_modules|\.git|\.github|dist|build)$/;
const str = (x: unknown): string => (x === null || x === undefined ? '' : typeof x === 'string' ? x : typeof x === 'object' ? JSON.stringify(x) : String(x));
const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const arr = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []) as Record<string, unknown>[];
const said = (d: unknown): string | undefined => (typeof d === 'string' ? d : str(obj(d).content)).trim() || undefined;

// ------------------------------------------------------------------ finding collections

const isCollection = (dir: string): 'bru' | 'yml' | null => (existsSync(join(dir, 'opencollection.yml')) ? 'yml' : existsSync(join(dir, 'bruno.json')) ? 'bru' : null);

/** Collection folders at or below a folder (one inside another counts on its own). */
export function findCollections(root: string): { path: string; format: 'bru' | 'yml' }[] {
  const out: { path: string; format: 'bru' | 'yml' }[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || seen++ > 4000 || out.length >= 100) return;
    const f = isCollection(dir);
    if (f) out.push({ path: dir, format: f });
    for (const n of names(dir)) {
      const p = join(dir, n);
      if (!SKIP.test(n) && !n.startsWith('.') && lstatSync(p).isDirectory()) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}
const names = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
};

// ------------------------------------------------------------------ one shape for both formats

interface Row {
  name: string;
  value: string;
  enabled: boolean;
  description?: string;
  type?: string;
  local?: boolean;
}
interface Raw {
  name: string;
  seq: number | null;
  docs?: string;
  headers: Row[];
  auth: { mode: string; f: Record<string, string> };
  vars: Row[];
  capture: Row[];
  pre: string;
  post: string;
  tests: string;
  asserts: { expr: string; op: string; value: string; enabled: boolean }[];
}
interface RawRequest extends Raw {
  type: 'http' | 'graphql' | 'grpc' | 'ws';
  method: string;
  url: string;
  params: Row[];
  body: { mode: string; raw: string; variables: string; rows: Row[] };
  grpc?: { method: string; proto: string };
  settings: Record<string, string>;
}

const OPS = /^(eq|neq|gte|gt|lte|lt|in|notIn|contains|notContains|length|matches|notMatches|startsWith|endsWith|between|isEmpty|isNotEmpty|isNull|isUndefined|isDefined|isTruthy|isFalsy|isJson|isNumber|isString|isBoolean|isArray)(?:\s+([\s\S]*))?$/;
const assertion = (expr: string, text: string, enabled: boolean) => {
  const m = OPS.exec(text.trim());
  return { expr, op: m ? m[1] : 'eq', value: m ? (m[2] ?? '') : text, enabled };
};
const rows = (list: BruPair[] | undefined): Row[] => (list ?? []).map((p) => ({ name: p.key, value: p.value, enabled: p.enabled, local: p.local, ...(p.description ? { description: p.description } : {}) }));
const one = (list: BruPair[] | undefined, key: string): string => list?.find((p) => p.key === key)?.value ?? '';

function bruRaw(f: BruFile, fallback: string): Raw {
  const mode = one(f.dict.get('auth'), 'mode');
  const fields = f.dict.get(`auth:${mode}`) ?? [];
  const meta = f.dict.get('meta');
  const seq = Number(one(meta, 'seq'));
  return {
    name: one(meta, 'name') || fallback,
    seq: one(meta, 'seq') && Number.isFinite(seq) ? seq : null,
    docs: f.text.get('docs')?.trim() || undefined,
    headers: rows(f.dict.get('headers')),
    auth: { mode, f: Object.fromEntries(fields.map((p) => [p.key, p.value])) },
    vars: rows(f.dict.get('vars:pre-request')),
    capture: rows(f.dict.get('vars:post-response')),
    pre: f.text.get('script:pre-request') ?? '',
    post: f.text.get('script:post-response') ?? '',
    tests: f.text.get('tests') ?? '',
    asserts: (f.dict.get('assert') ?? []).map((p) => assertion(p.key, p.value, p.enabled)),
  };
}

const VERBS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'connect', 'trace', 'http'];
function bruRequest(f: BruFile, fallback: string): RawRequest | null {
  const verb = VERBS.find((v) => f.dict.has(v));
  const kind = verb ? 'http' : f.dict.has('grpc') ? 'grpc' : f.dict.has('ws') ? 'ws' : null;
  if (!kind) return null;
  const head = f.dict.get(verb ?? kind)!;
  const base = bruRaw(f, fallback);
  const mode = one(head, 'auth') || 'none';
  base.auth = { mode, f: Object.fromEntries((f.dict.get(`auth:${mode}`) ?? []).map((p) => [p.key, p.value])) };
  const graphql = one(f.dict.get('meta'), 'type') === 'graphql';
  const bm = one(head, 'body') || (graphql ? 'graphql' : f.text.has('body') ? 'json' : 'none');
  const text = (m: string) => f.text.get(`body:${m}`) ?? '';
  const form = bm === 'form-urlencoded' || bm === 'formUrlEncoded' ? 'body:form-urlencoded' : bm === 'multipart-form' || bm === 'multipartForm' ? 'body:multipart-form' : 'body:file';
  const fields = rows(f.dict.get(form)).map((r): Row => {
    const ct = r.value.replace(/\s*@contentType\([^)]*\)\s*$/, '');
    const file = /^@file\(([\s\S]*)\)$/.exec(ct.trim());
    return file ? { ...r, type: 'file', value: file[1].split('|')[0] } : { ...r, value: ct };
  });
  const messages = f.dict.get(kind === 'grpc' ? 'body:grpc' : 'body:ws') ?? [];
  return {
    ...base,
    type: kind === 'http' ? (graphql ? 'graphql' : 'http') : kind,
    method: verb === 'http' ? one(head, 'method') : (verb ?? ''),
    url: one(head, 'url'),
    headers: kind === 'grpc' ? [...base.headers, ...rows(f.dict.get('metadata'))] : base.headers,
    params: [...rows(f.dict.get('params:query') ?? f.dict.get('query')).map((r) => ({ ...r, type: 'query' })), ...rows(f.dict.get('params:path')).map((r) => ({ ...r, type: 'path' }))],
    body: kind === 'http' ? { mode: bm, raw: bm === 'json' ? text('json') || (f.text.get('body') ?? '') : bm === 'graphql' ? text('graphql') : text(bm), variables: text('graphql:vars'), rows: /^(form|multipart|file)/i.test(bm) ? fields : [] } : { mode: kind, raw: one(messages, 'content'), variables: '', rows: [] },
    ...(kind === 'grpc' ? { grpc: { method: one(head, 'method'), proto: one(head, 'protoPath') } } : {}),
    settings: Object.fromEntries((f.dict.get('settings') ?? []).map((p) => [p.key, p.value])),
  };
}

const ymlRows = (x: unknown): Row[] =>
  arr(x).map((r) => ({ name: str(r.name), value: Array.isArray(r.value) ? str(r.value[0]) : r.value && typeof r.value === 'object' ? str(obj(r.value).data ?? obj(r.value).value) : str(r.value), enabled: r.disabled !== true && r.enabled !== false, ...(typeof r.type === 'string' ? { type: r.type } : {}), ...(said(r.description) ? { description: said(r.description) } : {}) }));
function ymlAuth(a: unknown): Raw['auth'] {
  if (a === 'inherit') return { mode: 'inherit', f: {} };
  const o = obj(a);
  const mode = str(o.type);
  if (!mode) return { mode: 'none', f: {} };
  const flat = { ...o, ...obj(o[mode]) };
  const f = Object.fromEntries(Object.entries(flat).filter(([, v]) => typeof v !== 'object').map(([k, v]) => [k, str(v)]));
  if (mode === 'oauth2') {
    const c = obj(o.credentials);
    const r = obj(o.resourceOwner);
    const t = obj(obj(o.tokenConfig).placement);
    Object.assign(f, { grant_type: f.flow === 'resource_owner_password_credentials' ? 'password' : f.flow, authorization_url: f.authorizationUrl, access_token_url: f.accessTokenUrl, callback_url: f.callbackUrl, client_id: str(c.clientId), client_secret: str(c.clientSecret), credentials_placement: str(c.placement), username: str(r.username), password: str(r.password), pkce: o.pkce && obj(o.pkce).disabled !== true ? 'true' : 'false', token_placement: t.query !== undefined ? 'url' : 'header', token_header_prefix: str(t.header), extra: o.additionalParameters ? '1' : '' });
  }
  return { mode, f };
}
function ymlRaw(info: Record<string, unknown>, request: Record<string, unknown>, runtime: Record<string, unknown>, docs: unknown, fallback: string): Raw {
  const scripts = arr(runtime.scripts);
  const code = (t: string) => str(scripts.find((s) => s.type === t)?.code);
  return {
    name: str(info.name) || fallback,
    seq: typeof info.seq === 'number' ? info.seq : null,
    docs: said(docs) ?? said(info.description),
    headers: ymlRows(request.headers),
    auth: ymlAuth(request.auth),
    vars: ymlRows(runtime.variables),
    capture: arr(runtime.actions)
      .filter((a) => a.type === 'set-variable' && a.phase === 'after-response')
      .map((a) => ({ name: str(obj(a.variable).name), value: str(obj(a.selector).expression), enabled: a.disabled !== true, local: obj(a.variable).scope === 'request' })),
    pre: code('before-request'),
    post: code('after-response'),
    tests: code('tests'),
    asserts: arr(runtime.assertions).map((a) => ({ expr: str(a.expression), op: OPS.exec(str(a.operator))?.[1] ?? 'eq', value: str(a.value), enabled: a.disabled !== true })),
  };
}
function ymlRequest(doc: Record<string, unknown>, fallback: string): RawRequest | null {
  const info = obj(doc.info);
  const type = (['http', 'graphql', 'grpc', 'websocket'] as const).find((t) => doc[t] && typeof doc[t] === 'object');
  if (!type) return null;
  const r = obj(doc[type]);
  const b = obj(r.body);
  const mode = str(b.type) || (type === 'graphql' ? 'graphql' : 'none');
  const message = type === 'grpc' ? r.message : (r.message ?? r.body);
  const first = Array.isArray(message) ? (arr(message).find((m) => m.selected === true) ?? arr(message)[0]) : message;
  const text = typeof first === 'string' ? first : str(obj(obj(first).message).data ?? obj(first).message ?? obj(first).data);
  return {
    ...ymlRaw(info, type === 'grpc' ? { ...r, headers: r.metadata ?? r.headers } : r, obj(doc.runtime), doc.docs, fallback),
    type: type === 'websocket' ? 'ws' : type,
    method: type === 'grpc' ? '' : str(r.method) || (type === 'graphql' ? 'POST' : 'GET'),
    url: str(r.url),
    params: ymlRows(r.params),
    body:
      type === 'grpc' || type === 'websocket'
        ? { mode: type === 'grpc' ? 'grpc' : 'ws', raw: text, variables: '', rows: [] }
        : { mode, raw: mode === 'graphql' ? str(b.query) : typeof b.data === 'string' ? b.data : '', variables: str(b.variables), rows: mode === 'file' ? arr(b.data).map((x) => ({ name: 'file', value: str(x.filePath), enabled: x.selected !== false, type: 'file' })) : ymlRows(b.data) },
    ...(type === 'grpc' ? { grpc: { method: str(r.method), proto: str(r.protoFilePath) } } : {}),
    settings: Object.fromEntries(Object.entries(obj(doc.settings)).map(([k, v]) => [k, str(v)])),
  };
}

// ------------------------------------------------------------------ into DialCatz

/** {{process.env.X}} is an ordinary variable here. */
const envRef = (s: string) => s.replace(/\{\{\s*process\.env\.([\w-]+)\s*\}\}/g, '{{$1}}');
const deepRef = <T>(x: T): T => (typeof x === 'string' ? (envRef(x) as T) : Array.isArray(x) ? (x.map(deepRef) as T) : x && typeof x === 'object' ? (Object.fromEntries(Object.entries(x).map(([k, v]) => [k, deepRef(v)])) as T) : x);
const kv = (r: Row): KeyValue => ({ key: r.name, value: r.value, enabled: r.enabled, ...(r.description ? { description: r.description } : {}) });

function auth(a: Raw['auth'], where: string, notes: Set<string>): RequestAuth {
  const f = a.f;
  const g = (k: string) => f[k] ?? '';
  switch (a.mode) {
    case '':
    case 'none':
      return { mode: 'none' };
    case 'inherit':
      return { mode: 'inherit' };
    case 'bearer':
      return { mode: 'bearer', token: g('token') };
    case 'basic':
      return { mode: 'basic', username: g('username'), password: g('password') };
    case 'apikey':
      return { mode: 'apikey', key: g('key'), value: g('value'), in: /^query/.test(g('placement')) ? 'query' : 'header' };
    case 'oauth2': {
      const grant = g('grant_type');
      if (grant === 'implicit' || !grant) {
        notes.add(`${where}: OAuth 2.0 ${grant || 'without a grant'} is not supported; the auth was left empty`);
        return { mode: 'none' };
      }
      if (g('token_placement') === 'url') notes.add(`${where}: the OAuth token goes into the Authorization header here, not the URL`);
      if (g('extra')) notes.add(`${where}: additional OAuth parameters were left out`);
      const prefix = g('token_header_prefix').trim();
      const cb = g('callback_url').trim();
      return {
        mode: 'oauth2',
        oauth2: {
          grant: grant === 'client_credentials' ? 'client_credentials' : grant === 'password' ? 'password' : 'authorization_code',
          tokenUrl: g('access_token_url'),
          clientId: g('client_id'),
          clientSecret: g('client_secret') || undefined,
          scope: g('scope') || undefined,
          clientAuth: /basic/i.test(g('credentials_placement')) ? 'basic' : 'body',
          ...(grant === 'authorization_code' ? { authUrl: g('authorization_url'), pkce: g('pkce') === 'true', ...(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(cb) ? { redirectUri: cb } : {}) } : {}),
          ...(grant === 'password' ? { username: g('username'), password: g('password') } : {}),
          ...(prefix && prefix !== 'Bearer' ? { headerPrefix: prefix } : {}),
        },
      };
    }
    default:
      notes.add(`${where}: ${a.mode} auth is not supported; the auth was left empty`);
      return { mode: 'none' };
  }
}

const compiles = (code: string): boolean => {
  try {
    new Script(code);
    return true;
  } catch {
    return false;
  }
};
const MODULES = new Set(['chai', 'uuid', 'nanoid', 'atob', 'btoa']);
/** What a script uses that the sandbox does not have. */
function scriptGaps(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) if (!MODULES.has(m[1])) out.add(`require('${m[1]}')`);
  for (const m of code.matchAll(/\bbru\.(sendRequest|runRequest|cookies|setNextRequest|cwd|getOauth2CredentialVar|resetOauth2Credential|deleteAll\w+)\b/g)) out.add(`bru.${m[1]}`);
  for (const m of code.matchAll(/\bbru\.runner\.(skipRequest|stopExecution|setNextRequest|iterationIndex|totalIterations)\b/g)) out.add(`bru.runner.${m[1]}`);
  for (const m of code.matchAll(/\b(req|res)\.(onFail|headerList|jq)\b/g)) out.add(`${m[1]}.${m[2]}`);
  if (/^\s*import\s/m.test(code) || /\bimport\s*\(/.test(code)) out.add('import');
  if (/\b(fetch|axios)\s*[.(]/.test(code)) out.add('network requests');
  if (/\b(process|Buffer|__dirname|__filename)\b/.test(code)) out.add('Node.js globals');
  return [...out];
}

/** Scripts that ran on their own in Bruno, one after the other: each keeps its own names when there are several. */
function join2(parts: string[]): string | undefined {
  const list = parts.map((p) => p.replace(/\s+$/, '')).filter((p) => p.trim());
  if (!list.length) return undefined;
  return list.length === 1 ? list[0] : list.map((p) => (/^bru\.(local|capture|assert)\(/.test(p) ? p : `await (async () => {\n${p}\n})();`)).join('\n\n');
}
const js = (s: string) => JSON.stringify(s).replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
const expression = (s: string) => envRef(s.trim().replace(/^\$(?=re[sq]\b)/, ''));

function scripts(r: Raw, where: string, notes: Set<string>, folderLevel: boolean): { preRequest?: string; tests?: string } {
  const gaps = scriptGaps([r.pre, r.post, r.tests].join('\n'));
  if (gaps.length) notes.add(`${where}: its scripts use ${gaps.join(', ')}, which DialCatz scripts do not have`);
  const locals = r.vars.filter((v) => v.enabled && v.name).map((v) => `bru.local(${js(v.name)}, ${js(envRef(v.value))});`);
  const lines: string[] = [];
  for (const v of r.capture.filter((x) => x.enabled && x.name)) {
    const e = expression(v.value);
    if (!compiles(`(${e})`)) notes.add(`${where}: the variable ${v.name} (${v.value}) could not be read`);
    else lines.push(`bru.capture(${js(v.name)}, () => (${e})${v.local ? ', true' : ''});`);
  }
  const asserts: string[] = [];
  for (const a of r.asserts.filter((x) => x.enabled && x.expr)) {
    const e = expression(a.expr);
    if (!compiles(`(${e})`)) notes.add(`${where}: the assertion ${a.expr} could not be read`);
    else asserts.push(`bru.assert(${js(`${a.expr} ${a.op}${a.value ? ` ${a.value}` : ''}`)}, () => (${e}), ${js(a.op)}${a.value ? `, ${js(a.value)}` : ''});`);
  }
  if (folderLevel && r.post.trim()) notes.add(`${where}: its after-response script runs before the requests' own here (Bruno runs it after them)`);
  return { preRequest: join2([locals.join('\n'), r.pre]), tests: join2([lines.join('\n'), r.post, asserts.join('\n'), r.tests]) };
}


function request(r: RawRequest, where: string, above: Raw[], notes: Set<string>): RequestSpec {
  const spec: RequestSpec = newRequest();
  // Nearest first: a request's own header wins over a folder's, a folder's over the collection's.
  const mine = r.headers.filter((h) => h.name);
  const have = new Set(mine.filter((h) => h.enabled).map((h) => h.name.toLowerCase()));
  const inherited: KeyValue[] = [];
  if (r.type !== 'grpc')
    for (const a of above)
      for (const h of a.headers)
        if (h.enabled && h.name && !have.has(h.name.toLowerCase())) {
          have.add(h.name.toLowerCase());
          inherited.push({ ...kv(h), description: h.description ?? `From ${a.name}` });
        }
  spec.headers = [...mine.map(kv), ...inherited];
  spec.auth = auth(r.auth, where, notes);
  const verb = r.method.toUpperCase();
  if (r.type === 'grpc') spec.method = 'POST';
  else if (r.type !== 'ws') {
    if ((HTTP_METHODS as readonly string[]).includes(verb)) spec.method = verb as HttpMethod;
    else notes.add(`${where}: the method ${verb || '(none)'} is not supported; it became GET`);
  }
  // Path parameters have no table here: their values go into the URL.
  let url = r.url.trim();
  for (const p of r.params.filter((x) => x.type === 'path' && x.name)) {
    const [path, ...q] = url.split('?');
    const fixed = path.split('/').map((seg) => (seg === `:${p.name}` ? p.value || `{{${p.name}}}` : seg)).join('/');
    url = [fixed, ...q].join('?');
  }
  const query = r.params.filter((x) => x.type !== 'path').map(kv);
  spec.params = query.length ? query : splitUrl(url).params;
  spec.url = joinUrl(splitUrl(url).base, spec.params);
  if (r.type === 'grpc') {
    spec.url = /^[a-z]+:\/\//i.test(spec.url) ? spec.url.replace(/^https?:/i, (m) => (/s/i.test(m.slice(4)) ? 'grpcs:' : 'grpc:')) : spec.url.startsWith('{{') ? spec.url : `grpc://${spec.url}`;
    if (spec.url.startsWith('{{')) notes.add(`${where}: the gRPC address needs grpc:// or grpcs:// in front (its variable decides)`);
    const [service, method] = (r.grpc?.method ?? '').replace(/^\//, '').split('/');
    spec.grpc = { service: service ?? '', method: method ?? '' };
    if (r.grpc?.proto) notes.add(`${where}: choose its .proto file again (${basename(r.grpc.proto)}), or use server reflection`);
    spec.body = { mode: 'json', raw: r.body.raw, fields: [] };
  } else if (r.type === 'ws') {
    if (!/^(wss?:\/\/|\{\{)/i.test(spec.url)) spec.url = `ws://${spec.url}`;
    if (r.body.raw.trim()) spec.wsMessage = { text: r.body.raw };
  } else spec.body = body(r, where, spec, notes);
  if (r.settings.followRedirects === 'false') notes.add(`${where}: "do not follow redirects" is a setting of the whole app here`);
  for (const m of JSON.stringify([r.url, r.headers, r.params, r.body]).matchAll(/\{\{\s*(\$\w+|\?[^}]*)\s*\}\}/g)) {
    if (m[1].startsWith('?')) notes.add(`${where}: {{${m[1]}}} (asking for a value) is not supported`);
    else if (!DYNAMIC.has(m[1])) notes.add(`${where}: {{${m[1]}}} is not a value DialCatz makes`);
  }
  Object.assign(spec, scripts(r, where, notes, false));
  return spec;
}

/** What is kept of a file's path: relative as it is, else only its name. */
const fileHint = (p: string) => (/^([a-z]:)?[\\/]|^~/i.test(p) ? basename(p.replace(/\\/g, '/')) : p);
function body(r: RawRequest, where: string, spec: RequestSpec, notes: Set<string>): RequestBody {
  const b = r.body;
  const raw = (mode: 'json' | 'text' | 'xml'): RequestBody => ({ mode, raw: b.raw, fields: [] });
  switch (b.mode) {
    case 'none':
    case '':
      return emptyBody();
    case 'json':
    case 'text':
    case 'xml':
      return raw(b.mode);
    case 'sparql':
      if (!spec.headers.some((h) => h.enabled && h.key.toLowerCase() === 'content-type')) spec.headers.push({ key: 'Content-Type', value: 'application/sparql-query', enabled: true });
      return raw('text');
    case 'graphql':
      return { mode: 'graphql', raw: b.raw, variables: b.variables, fields: [] };
    case 'form-urlencoded':
    case 'formUrlEncoded':
      return { mode: 'form', raw: '', fields: b.rows.map(kv) };
    case 'multipart-form':
    case 'multipartForm': {
      const files = b.rows.filter((x) => x.type === 'file');
      if (files.length) notes.add(`${where}: choose its file${files.length > 1 ? 's' : ''} again (${files.map((x) => basename(x.value)).filter(Boolean).join(', ') || 'multipart'})`);
      return { mode: 'multipart', raw: '', fields: b.rows.map((x) => (x.type === 'file' ? { ...kv(x), type: 'file' as const, value: fileHint(x.value) } : kv(x))) };
    }
    case 'file': {
      const f = b.rows.find((x) => x.enabled && x.value) ?? b.rows[0];
      notes.add(`${where}: choose its file again${f?.value ? ` (${basename(f.value)})` : ''}`);
      return { mode: 'binary', raw: '', fields: [] };
    }
    default:
      notes.add(`${where}: the body type ${b.mode} is not supported`);
      return emptyBody();
  }
}

// ------------------------------------------------------------------ a collection folder

const readText = (p: string): string | null => {
  try {
    const st = lstatSync(p);
    return st.isFile() && st.size <= MAX_BYTES ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};
const yamlDoc = (t: string): Record<string, unknown> => obj(parseYaml(t, { maxAliasCount: 200 }));
const blank = (name: string): Raw => ({ name, seq: null, headers: [], auth: { mode: '', f: {} }, vars: [], capture: [], pre: '', post: '', tests: '', asserts: [] });

export function readCollection(dir: string): BrunoCollection {
  const format = isCollection(dir);
  if (!format) throw new Error('That folder is not a Bruno collection (no bruno.json or opencollection.yml)');
  const notes = new Set<string>();
  let files = 0;
  let raw: Raw;
  let ocRoot: Record<string, unknown> = {};
  if (format === 'yml') {
    ocRoot = yamlDoc(readText(join(dir, 'opencollection.yml')) ?? '');
    const r = obj(ocRoot.request);
    raw = ymlRaw(obj(ocRoot.info), r, r, ocRoot.docs, basename(dir));
  } else {
    let name = basename(dir);
    try {
      name = str(obj(JSON.parse(readText(join(dir, 'bruno.json')) ?? '{}')).name) || name;
    } catch {
      notes.add('bruno.json could not be read');
    }
    const t = readText(join(dir, 'collection.bru'));
    raw = t ? { ...bruRaw(parseBru(t), name), name } : blank(name);
  }
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: raw.name, sort: 0, auth: auth(raw.auth, 'Collection', notes), description: raw.docs, ...scripts({ ...raw, vars: [] }, 'Collection', notes, true) };
  if (root.auth?.mode === 'inherit') root.auth = { mode: 'none' };
  const items: TreeItem[] = [];
  const fileOf = new Map<string, string>([[root.id, '']]);

  const put = (list: { item: TreeItem; seq: number | null; folder: boolean }[]) =>
    list
      .sort((a, b) => Number(b.folder) - Number(a.folder) || (a.seq ?? 1e9) - (b.seq ?? 1e9) || a.item.name.localeCompare(b.item.name))
      .forEach((x, n) => {
        x.item.sort = n;
      });
  const asFolder = (f: Raw, parentId: string, rel: string): TreeItem => {
    const where = `Folder ${f.name}`;
    const a = auth(f.auth, where, notes);
    const item: TreeItem = { id: uid('f_'), kind: 'folder', parentId, name: f.name, sort: 0, auth: a.mode === 'none' ? { mode: 'inherit' } : a, description: f.docs, ...scripts(f, where, notes, true) };
    items.push(item);
    fileOf.set(item.id, rel);
    return item;
  };
  const asRequest = (r: RawRequest, parentId: string, rel: string, above: Raw[]): TreeItem => {
    const item: TreeItem = { id: uid('r_'), kind: 'request', parentId, name: r.name, sort: 0, request: request(r, r.name, above, notes), description: r.docs };
    items.push(item);
    fileOf.set(item.id, rel);
    return item;
  };

  const walk = (abs: string, rel: string, parentId: string, above: Raw[], depth: number) => {
    const here: { item: TreeItem; seq: number | null; folder: boolean }[] = [];
    for (const n of names(abs)) {
      if (n.startsWith('.') || SKIP.test(n) || (!rel && n === 'environments')) continue;
      const p = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        // A collection inside this one is listed on its own.
        if (depth > 20 || isCollection(p)) continue;
        const t = readText(join(p, format === 'yml' ? 'folder.yml' : 'folder.bru'));
        let f = blank(n);
        try {
          if (t && format === 'bru') f = bruRaw(parseBru(t), n);
          else if (t) {
            const d = yamlDoc(t);
            f = ymlRaw(obj(d.info), obj(d.request), obj(d.request), d.docs, n);
          }
        } catch (e) {
          notes.add(`${r}/folder.${format}: ${(e as Error).message.split('\n')[0]}`);
        }
        const before = items.length;
        const item = asFolder(f, parentId, r);
        walk(p, r, item.id, [f, ...above], depth + 1);
        // A folder of other files (scripts, data) is no part of the collection.
        if (items.length === before + 1 && !t) items.pop();
        else here.push({ item, seq: f.seq, folder: true });
        continue;
      }
      if (!st.isFile() || !n.endsWith(format === 'yml' ? '.yml' : '.bru') || /^(folder|collection|opencollection)\.(bru|yml)$/.test(n)) continue;
      if (++files > MAX_FILES) throw new Error(`More than ${MAX_FILES} request files in there`);
      const t = readText(p);
      if (t === null) {
        notes.add(`${r}: too large to read`);
        continue;
      }
      try {
        const f = format === 'bru' ? bruRequest(parseBru(t), n.slice(0, -4)) : ymlRequest(yamlDoc(t), n.slice(0, -4));
        if (f) here.push({ item: asRequest(f, parentId, r, above), seq: f.seq, folder: false });
        else notes.add(`${r}: not a request`);
      } catch (e) {
        notes.add(`${r}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    put(here);
  };
  walk(dir, '', root.id, [raw], 0);

  // An OpenCollection exported as one file carries its items inside.
  const bundle = (list: unknown, rel: string, parentId: string, above: Raw[]) => {
    const here: { item: TreeItem; seq: number | null; folder: boolean }[] = [];
    arr(list).forEach((d, n) => {
      const info = obj(d.info);
      const name = str(info.name) || `item-${n + 1}`;
      const r = rel ? `${rel}/${name}` : name;
      if (Array.isArray(d.items) || info.type === 'folder') {
        const f = ymlRaw(info, obj(d.request), obj(d.request), d.docs, name);
        const item = asFolder(f, parentId, r);
        bundle(d.items, r, item.id, [f, ...above]);
        here.push({ item, seq: f.seq, folder: true });
      } else {
        const f = ymlRequest(d, name);
        if (f) here.push({ item: asRequest(f, parentId, r, above), seq: f.seq, folder: false });
      }
    });
    if (here.length) put(here);
  };
  if (Array.isArray(ocRoot.items)) bundle(ocRoot.items, '', root.id, [raw]);

  const environments = readEnvironments(dir, format, ocRoot, raw, notes);
  const text = JSON.stringify([items, root]);
  // {{process.env.X}} and bru.getProcessEnv('X'): variables to fill in, secret.
  const fromEnv = new Set([...text.matchAll(/\{\{\s*process\.env\.([\w-]+)\s*\}\}|getProcessEnv\(\s*\\?['"]([\w-]+)/g)].map((m) => m[1] ?? m[2]));
  for (const e of environments) for (const v of e.variables) for (const m of v.value.matchAll(/\{\{\s*process\.env\.([\w-]+)\s*\}\}/g)) fromEnv.add(m[1]);
  if (fromEnv.size) {
    if (!environments.length) environments.push({ id: uid('e_'), name: raw.name, variables: [] });
    for (const e of environments) {
      e.variables = e.variables.map((v) => ({ ...v, value: envRef(v.value) }));
      for (const k of fromEnv) if (!e.variables.some((v) => v.key === k)) e.variables.push({ key: k, value: '', enabled: true, secret: true });
    }
    notes.add(`Fill in the variables that came from the .env file: ${[...fromEnv].join(', ')}`);
  }
  for (const e of environments) nested(e, notes);
  const secrets = [...new Set(environments.flatMap((e) => e.variables.filter((v) => v.secret && v.enabled && !v.value && !fromEnv.has(v.key)).map((v) => v.key)))];
  if (secrets.length) notes.add(`Fill in the secret variables (Bruno keeps their values outside the folder): ${secrets.join(', ')}`);
  if (format === 'yml' ? obj(ocRoot.config).clientCertificates : /clientCertificates/.test(readText(join(dir, 'bruno.json')) ?? '')) notes.add('Client certificates: add them in Settings → Client certificates');

  const all = deepRef([root, ...items]).map((i) => Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)) as unknown as TreeItem);
  const withOrigin = all.map((i) => ({ ...i, bruno: { file: fileOf.get(i.id) ?? '', base: parts(i), ...(i.kind === 'collection' ? { folder: dir } : {}) } }));
  return { root: withOrigin[0], items: withOrigin.slice(1), environments, format, notes: [...notes] };
}

function readEnvironments(dir: string, format: 'bru' | 'yml', ocRoot: Record<string, unknown>, raw: Raw, notes: Set<string>): Environment[] {
  const out: { name: string; parent: string; variables: EnvVariable[] }[] = [];
  const fromYml = (d: Record<string, unknown>, fallback: string) => {
    if (d.externalSecrets) notes.add(`Environment ${str(d.name) || fallback}: its values come from an external secret manager, so fill them in here`);
    return { name: str(d.name) || fallback, parent: str(d.extends), variables: arr(d.variables).filter((v) => v.name).map((v) => ({ key: str(v.name), value: v.secret === true ? '' : str(v.value && typeof v.value === 'object' ? (obj(v.value).data ?? obj(v.value).value) : v.value), enabled: v.disabled !== true && v.enabled !== false, secret: v.secret === true })) };
  };
  for (const n of names(join(dir, 'environments'))) {
    const t = /^[^.].*\.(bru|yml)$/.test(n) ? readText(join(dir, 'environments', n)) : null;
    if (t === null) continue;
    const name = n.replace(/\.(bru|yml)$/, '');
    try {
      if (n.endsWith('.yml')) out.push(fromYml(yamlDoc(t), name));
      else {
        const f = parseBru(t);
        out.push({ name, parent: f.text.get('extends') ?? '', variables: [...rows(f.dict.get('vars')).map((v) => ({ key: v.name, value: v.value, enabled: v.enabled, secret: false })), ...(f.list.get('vars:secret') ?? []).map((v) => ({ key: v.name, value: '', enabled: v.enabled, secret: true }))] });
      }
    } catch (e) {
      notes.add(`environments/${n}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  if (format === 'yml') for (const d of arr(obj(ocRoot.config).environments ?? ocRoot.environments)) if (!out.some((e) => e.name === str(d.name))) out.push(fromYml(d, 'Environment'));
  const full = (e: (typeof out)[number], seen: string[] = []): EnvVariable[] => {
    const p = e.parent && !seen.includes(e.parent) ? out.find((x) => x.name === e.parent) : undefined;
    const up = p ? full(p, [...seen, e.name]) : [];
    return [...e.variables, ...up.filter((v) => !e.variables.some((x) => x.key === v.key))];
  };
  const own = raw.vars.filter((v) => v.enabled && v.name).map((v): EnvVariable => ({ key: v.name, value: v.value, enabled: true, secret: false }));
  const envs: Environment[] = out.map((e) => ({ id: uid('e_'), name: e.name, variables: full(e) }));
  if (own.length && !envs.length) envs.push({ id: uid('e_'), name: raw.name, variables: [] });
  return envs.map((e) => ({ ...e, variables: [...e.variables, ...own.filter((v) => !e.variables.some((x) => x.key === v.key && x.enabled))] }));
}

/** A value made of other variables is filled in once: DialCatz does not look inside a value again. */
function nested(e: Environment, notes: Set<string>): void {
  const map = new Map(e.variables.filter((v) => v.enabled && !v.secret).map((v) => [v.key, v]));
  const left = new Set<string>();
  const fill = (s: string, seen: string[]): string =>
    s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (w, n: string) => {
      const v = map.get(n);
      if (!v || seen.includes(n) || seen.length > 10) return w;
      return fill(v.value, [...seen, n]);
    });
  for (const v of e.variables) {
    v.value = fill(v.value, [v.key]);
    if (/\{\{\s*[\w.-]+\s*\}\}/.test(v.value)) left.add(v.key);
  }
  if (left.size) notes.add(`Environment ${e.name}: ${[...left].join(', ')} refers to another variable; write the whole value`);
}

// ------------------------------------------------------------------ what Bruno decides of an item, part by part

const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x ?? '')).digest('hex').slice(0, 16);
const table = (l: KeyValue[]) => l.map((r) => [r.key, r.value, r.enabled !== false, r.type ?? 'text', r.description ?? '']);
const sortKeys = (x: unknown): unknown => (Array.isArray(x) ? x.map(sortKeys) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined && v !== '').sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)])) : x);

export function parts(i: TreeItem): Record<string, string> {
  const r = i.request;
  const base = { name: hash(i.name), description: hash(i.description) };
  if (!r) return { ...base, auth: hash(sortKeys(i.auth ?? {})), preRequest: hash(i.preRequest), tests: hash(i.tests) };
  return {
    ...base,
    method: hash(r.method),
    url: hash([splitUrl(r.url).base, table(r.params)]),
    headers: hash(table(r.headers)),
    body: hash([r.body.mode, r.body.mode === 'none' ? '' : (r.body.raw ?? ''), table(r.body.fields ?? []), r.body.variables ?? '']),
    auth: hash(sortKeys(r.auth)),
    preRequest: hash(r.preRequest),
    tests: hash(r.tests),
    other: hash([r.wsMessage?.text ?? '', r.grpc?.service ?? '', r.grpc?.method ?? '']),
  };
}
