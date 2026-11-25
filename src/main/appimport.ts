import { joinUrl, splitUrl } from '@shared/request';
import { emptyBody, HTTP_METHODS, newRequest, uid, type Environment, type EnvVariable, type HttpMethod, type KeyValue, type RequestAuth, type RequestBody, type RequestSpec, type TreeItem } from '@shared/types';
import { gapsNote, scriptGaps, type Notes } from './importnotes';

/**
 * What the imports of other apps share (Insomnia, Yaak): a tree of folders and requests said plainly, made into a
 * DialCatz collection. Headers of a folder or the collection go into their requests; a folder's variables are set for
 * that send only by its pre-request script (bru.local).
 */

export type Obj = Record<string, unknown>;
export const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
export const arr = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []) as Obj[];
export const str = (x: unknown): string => (x === null || x === undefined ? '' : typeof x === 'string' ? x : typeof x === 'object' ? JSON.stringify(x) : String(x));
export const said = (x: unknown): string | undefined => str(x).trim() || undefined;

interface Base {
  name: string;
  docs?: string;
  headers: KeyValue[];
  auth: RequestAuth;
  pre?: string;
  post?: string;
}
export interface AppFolder extends Base {
  kind: 'folder';
  locals: EnvVariable[];
  children: AppNode[];
}
export interface AppRequest extends Base {
  kind: 'request';
  type: 'http' | 'ws' | 'socketio' | 'grpc';
  method: string;
  url: string;
  query: KeyValue[];
  path: { name: string; value: string }[];
  body: RequestBody;
  /** Sent when neither the request nor a folder sets one. */
  contentType?: string;
  message?: { text: string; event?: string };
  grpc?: { service: string; method: string };
}
export type AppNode = AppFolder | AppRequest;
export interface AppCollection extends Base {
  children: AppNode[];
  environments: Environment[];
}
export interface AppImported {
  root: TreeItem;
  items: TreeItem[];
  environments: Environment[];
  notes: string[];
}

export const rowsOf = (x: unknown, tx: (s: string) => string): KeyValue[] =>
  arr(x)
    .filter((r) => str(r.name) || str(r.value))
    .map((r) => ({ key: tx(str(r.name)), value: tx(str(r.value)), enabled: r.disabled !== true && r.enabled !== false, ...(said(r.description) ? { description: said(r.description) } : {}) }));

const js = (s: string) => JSON.stringify(s).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
function scripts(n: Base & { locals?: EnvVariable[] }, where: string, notes: Notes): { preRequest?: string; tests?: string } {
  const gaps = scriptGaps(`${n.pre ?? ''}\n${n.post ?? ''}`);
  if (gaps.length) notes.add(where, gapsNote(gaps));
  const before = [...(n.locals ?? []).filter((v) => v.enabled && !v.secret).map((v) => `bru.local(${js(v.key)}, ${js(v.value)});`), ...(n.pre?.trim() ? [n.pre.trim()] : [])].join('\n');
  return { ...(before ? { preRequest: before } : {}), ...(n.post?.trim() ? { tests: n.post.trim() } : {}) };
}

function request(r: AppRequest, above: Base[], notes: Notes): RequestSpec {
  const spec = newRequest();
  const have = new Set(r.headers.filter((h) => h.enabled).map((h) => h.key.toLowerCase()));
  const inherited: KeyValue[] = [];
  if (r.type !== 'grpc')
    for (const a of above)
      for (const h of a.headers)
        if (h.enabled && h.key && !have.has(h.key.toLowerCase())) {
          have.add(h.key.toLowerCase());
          inherited.push({ ...h, description: h.description ?? `From ${a.name}` });
        }
  spec.headers = [...r.headers, ...inherited];
  if (r.contentType && !have.has('content-type')) spec.headers.push({ key: 'Content-Type', value: r.contentType, enabled: true });
  spec.auth = r.auth;
  let url = r.url.trim();
  for (const p of r.path.filter((x) => x.name)) {
    const [path, ...rest] = url.split('?');
    url = [path.split('/').map((s) => (s === `:${p.name}` ? p.value || `{{${p.name}}}` : s)).join('/'), ...rest].join('?');
  }
  const inUrl = splitUrl(url);
  spec.params = [...inUrl.params, ...r.query];
  spec.url = joinUrl(inUrl.base, spec.params);
  if (r.type === 'grpc') {
    spec.method = 'POST';
    spec.url = /^[a-z]+:\/\//i.test(spec.url) ? spec.url.replace(/^https:/i, 'grpcs:').replace(/^http:/i, 'grpc:') : spec.url.startsWith('{{') ? spec.url : `grpc://${spec.url}`;
    if (spec.url.startsWith('{{')) notes.add(r.name, 'the gRPC address needs grpc:// or grpcs:// in front (its variable decides)');
    spec.grpc = { service: r.grpc?.service ?? '', method: r.grpc?.method ?? '' };
    spec.body = { mode: 'json', raw: r.message?.text ?? '', fields: [] };
  } else if (r.type === 'ws' || r.type === 'socketio') {
    spec.url = spec.url.replace(/^http(s?):/i, 'ws$1:');
    if (!/^(wss?:\/\/|\{\{)/i.test(spec.url)) spec.url = `ws://${spec.url}`;
    if (r.type === 'socketio') spec.socketIo = true;
    if (r.message && (r.message.text.trim() || r.message.event)) spec.wsMessage = { text: r.message.text, ...(r.message.event ? { event: r.message.event } : {}) };
  } else {
    const verb = r.method.toUpperCase() || 'GET';
    if ((HTTP_METHODS as readonly string[]).includes(verb)) spec.method = verb as HttpMethod;
    else notes.add(r.name, `the method ${verb} is not supported; it became GET`);
    spec.body = r.body;
    const files = r.body.fields.filter((f) => f.type === 'file');
    if (files.length) notes.add(r.name, `choose its file${files.length > 1 ? 's' : ''} again${files.some((f) => f.value) ? ` (${files.map((f) => f.value).filter(Boolean).join(', ')})` : ''}`);
    if (r.body.mode === 'binary') notes.add(r.name, 'choose its file again');
    if (r.body.mode !== 'none' && ['GET', 'HEAD'].includes(spec.method)) notes.add(r.name, `a ${spec.method} request is sent without its body here`);
  }
  notes.dynamic(r.name, [spec.url, spec.headers, spec.body, spec.wsMessage]);
  Object.assign(spec, scripts(r, r.name, notes));
  return spec;
}

export function buildCollection(c: AppCollection, notes: Notes): AppImported {
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: c.name, sort: 0, auth: c.auth.mode === 'inherit' ? { mode: 'none' } : c.auth, ...(c.docs ? { description: c.docs } : {}), ...scripts(c, 'Collection', notes) };
  const items: TreeItem[] = [];
  const walk = (list: AppNode[], parentId: string, above: Base[]) => {
    list.forEach((n, sort) => {
      const base = { parentId, name: n.name, sort, ...(n.docs ? { description: n.docs } : {}) };
      if (n.kind === 'folder') {
        const id = uid('f_');
        const secret = n.locals.filter((v) => v.secret).map((v) => v.key);
        if (secret.length) notes.add(`Folder ${n.name}`, `add its secret variables to an environment: ${secret.join(', ')}`);
        items.push({ id, kind: 'folder', ...base, auth: n.auth, ...scripts(n, `Folder ${n.name}`, notes) });
        walk(n.children, id, [n, ...above]);
      } else items.push({ id: uid('r_'), kind: 'request', ...base, request: request(n, above, notes) });
    });
  };
  walk(c.children, root.id, [c]);
  const secrets = [...new Set(c.environments.flatMap((e) => e.variables.filter((v) => v.secret && !v.value).map((v) => v.key)))];
  if (secrets.length) notes.plain(`Fill in the secret variables (their values are not in the export): ${secrets.join(', ')}`);
  return { root, items, environments: c.environments, notes: notes.all() };
}

/** A base environment and its children: each child has the base's variables it does not set. Alone, it takes the collection's name. */
export function layered(name: string, base: EnvVariable[], subs: { name: string; variables: EnvVariable[] }[]): Environment[] {
  const list = subs.length ? subs.map((s) => ({ name: s.name, variables: [...s.variables, ...base.filter((b) => !s.variables.some((v) => v.key === b.key))] })) : base.length ? [{ name, variables: base }] : [];
  return list.map((e) => {
    const map = new Map(e.variables.filter((v) => v.enabled && !v.secret).map((v) => [v.key, v.value]));
    const fill = (s: string, seen: string[]): string => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (w, n: string) => (map.has(n) && !seen.includes(n) && seen.length < 10 ? fill(map.get(n)!, [...seen, n]) : w));
    return { id: uid('e_'), name: e.name || 'Environment', variables: e.variables.map((v) => ({ ...v, value: fill(v.value, [v.key]) })) };
  });
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
/** The fields of a form or multipart body. */
export const formFields = (x: unknown, tx: (s: string) => string, fileOf: (f: Obj) => string | null): KeyValue[] =>
  arr(x)
    .filter((f) => str(f.name))
    .map((f) => {
      const file = fileOf(f);
      return { key: tx(str(f.name)), value: file !== null ? base(file) : tx(str(f.value)), enabled: f.disabled !== true && f.enabled !== false, ...(file !== null ? { type: 'file' as const } : {}) };
    });

/** A text body by its content type; a type the mode does not send by itself is kept as a header. */
export function textBody(type: string, text: string): { body: RequestBody; contentType?: string } {
  const t = type.split(';')[0].trim().toLowerCase();
  if (!t && !text) return { body: emptyBody() };
  if (/json/.test(t)) return { body: { mode: 'json', raw: text, fields: [] }, ...(t !== 'application/json' ? { contentType: type } : {}) };
  if (/xml/.test(t)) return { body: { mode: 'xml', raw: text, fields: [] }, ...(t !== 'application/xml' ? { contentType: type } : {}) };
  return { body: { mode: 'text', raw: text, fields: [] }, ...(t && t !== 'text/plain' ? { contentType: type } : {}) };
}
