import { joinUrl, splitUrl } from '@shared/request';
import { emptyBody, HTTP_METHODS, newRequest, uid, type Environment, type EnvVariable, type HttpMethod, type KeyValue, type RequestAuth, type RequestBody, type RequestSpec, type TreeItem } from '@shared/types';
import { gapsNote, Notes, scriptGaps } from './importnotes';

/**
 * Moving from Hoppscotch (#105): a collection exported as JSON (any of its versions) and environments exported as
 * JSON. <<name>> becomes {{name}}. Headers of a collection or folder go into their requests; a folder's and a
 * request's variables are set for that send only by the pre-request script (bru.local); the collection's become an
 * environment named after it, as Postman's do. pw and hopp are in the script sandbox.
 */

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const arr = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []) as Obj[];
const str = (x: unknown): string => (x === null || x === undefined ? '' : typeof x === 'string' ? x : typeof x === 'object' ? JSON.stringify(x) : String(x));
const said = (x: unknown) => str(x).trim() || undefined;

/** A collection: a name with lists of folders and requests (Postman's have info / item). */
export function isHoppscotch(x: unknown): x is Obj {
  const o = obj(x);
  return typeof o.name === 'string' && Array.isArray(o.folders) && Array.isArray(o.requests) && !o.info && !o.openapi && !o.swagger;
}
/** An environment: a name with variables that have a key (and no Postman / DialCatz mark). */
export function isHoppEnvironment(x: unknown): x is Obj {
  const o = obj(x);
  return typeof o.name === 'string' && Array.isArray(o.variables) && !o.folders && o.dialcatz === undefined && !('_postman_variable_scope' in o) && o.variables.every((v) => typeof obj(v).key === 'string');
}

/** <<name>> → {{name}}. */
const ref = (s: string) => s.replace(/<<\s*([\w.$-]+)\s*>>/g, '{{$1}}');
const variable = (v: Obj): EnvVariable => {
  const secret = v.secret === true;
  return { key: str(v.key).trim(), value: secret ? '' : ref(str(v.currentValue) || str(v.initialValue) || str(v.value)), enabled: true, secret };
};
const variables = (x: unknown): EnvVariable[] => arr(x).map(variable).filter((v) => v.key);

/** An environment, its values that name another of its variables written out (DialCatz fills a value in once). */
export function fromHoppEnvironment(x: Obj): Environment {
  const list = variables(x.variables);
  const map = new Map(list.filter((v) => !v.secret).map((v) => [v.key, v.value]));
  const fill = (s: string, seen: string[]): string => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (w, n: string) => (map.has(n) && !seen.includes(n) && seen.length < 10 ? fill(map.get(n)!, [...seen, n]) : w));
  return { id: uid('e_'), name: str(x.name) || 'Environment', variables: list.map((v) => ({ ...v, value: fill(v.value, [v.key]) })) };
}

const rows = (x: unknown): KeyValue[] => arr(x).filter((r) => str(r.key)).map((r) => ({ key: ref(str(r.key)), value: ref(str(r.value)), enabled: r.active !== false, ...(said(r.description) ? { description: said(r.description) } : {}) }));

function auth(a: unknown, where: string, notes: Notes): RequestAuth {
  const o = obj(a);
  const type = str(o.authType);
  if (type === 'inherit') return { mode: 'inherit' };
  if (!type || type === 'none' || o.authActive === false) return { mode: 'none' };
  const g = (x: Obj, k: string) => ref(str(x[k]));
  switch (type) {
    case 'bearer':
      return { mode: 'bearer', token: g(o, 'token') };
    case 'basic':
      return { mode: 'basic', username: g(o, 'username'), password: g(o, 'password') };
    case 'api-key':
      return { mode: 'apikey', key: g(o, 'key'), value: g(o, 'value'), in: /query/i.test(str(o.addTo)) ? 'query' : 'header' };
    case 'oauth-2': {
      const i = o.grantTypeInfo ? obj(o.grantTypeInfo) : { grantType: 'AUTHORIZATION_CODE', authEndpoint: o.authURL, tokenEndpoint: o.accessTokenURL, clientID: o.clientID, scopes: o.scope };
      const grant = str(i.grantType);
      if (!['AUTHORIZATION_CODE', 'CLIENT_CREDENTIALS', 'PASSWORD'].includes(grant)) {
        notes.add(where, `OAuth 2.0 ${grant.toLowerCase() || 'without a grant'} is not supported; the auth was left empty`);
        return { mode: 'none' };
      }
      if (/query/i.test(str(o.addTo))) notes.add(where, 'the OAuth token goes into the Authorization header here, not the URL');
      if ([i.authRequestParams, i.tokenRequestParams].some((l) => arr(l).some((p) => p.active !== false && p.key))) notes.add(where, 'additional OAuth parameters were left out');
      return {
        mode: 'oauth2',
        oauth2: {
          grant: grant === 'CLIENT_CREDENTIALS' ? 'client_credentials' : grant === 'PASSWORD' ? 'password' : 'authorization_code',
          // Its saved token is left behind: DialCatz gets its own.
          tokenUrl: g(i, 'tokenEndpoint') || g(i, 'authEndpoint'),
          clientId: g(i, 'clientID'),
          clientSecret: g(i, 'clientSecret') || undefined,
          scope: g(i, 'scopes') || undefined,
          clientAuth: str(i.clientAuthentication) === 'AS_BASIC_AUTH_HEADERS' ? 'basic' : 'body',
          ...(grant === 'AUTHORIZATION_CODE' ? { authUrl: g(i, 'authEndpoint'), pkce: i.isPKCE === true } : {}),
          ...(grant === 'PASSWORD' ? { username: g(i, 'username'), password: g(i, 'password') } : {}),
        },
      };
    }
    default:
      notes.add(where, `${type} auth is not supported; the auth was left empty`);
      return { mode: 'none' };
  }
}

/** Hoppscotch takes comments out of a JSON body when it sends it: the same here. */
function withoutComments(s: string): string {
  return s.replace(/("(?:[^"\\]|\\.)*"?)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, text?: string) => text ?? '').replace(/[ \t]+$/gm, '');
}
/** A url-encoded body is kept as lines of `key: value`, # before one switched off. */
function formRows(s: string): KeyValue[] {
  const plain = (t: string) => {
    if (!/^".*"$/s.test(t)) return t;
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  };
  return s
    .split('\n')
    .map((l) => /^\s*(#?)\s*("(?:[^"\\]|\\.)*"|[^:]*?)\s*:\s*(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && !!m[2])
    .map((m) => ({ key: ref(plain(m[2])), value: ref(plain(m[3].trim())), enabled: !m[1] }));
}

function body(b: Obj, spec: RequestSpec, where: string, notes: Notes): RequestBody {
  const type = str(b.contentType);
  const own = (t: string) => {
    if (!spec.headers.some((h) => h.enabled && h.key.toLowerCase() === 'content-type')) spec.headers.push({ key: 'Content-Type', value: t, enabled: true });
  };
  if (!type) return emptyBody();
  if (type === 'multipart/form-data') {
    const list = arr(b.body);
    const files = list.filter((f) => f.isFile === true);
    if (files.length) notes.add(where, `choose its file${files.length > 1 ? 's' : ''} again (${files.map((f) => str(f.key)).join(', ')})`);
    return { mode: 'multipart', raw: '', fields: list.filter((f) => str(f.key)).map((f) => ({ key: ref(str(f.key)), value: f.isFile === true ? '' : ref(str(f.value)), enabled: f.active !== false, ...(f.isFile === true ? { type: 'file' as const } : {}) })) };
  }
  if (type === 'application/octet-stream' || type === 'binary') {
    notes.add(where, 'choose its file again');
    return { mode: 'binary', raw: '', fields: [] };
  }
  const raw = ref(str(b.body));
  if (type === 'application/x-www-form-urlencoded') return { mode: 'form', raw: '', fields: formRows(str(b.body)) };
  if (/json/.test(type)) {
    if (type !== 'application/json') own(type);
    const clean = withoutComments(raw);
    if (clean !== raw.replace(/[ \t]+$/gm, '')) notes.add(where, 'the comments in its JSON body were taken out (Hoppscotch does not send them)');
    return { mode: 'json', raw: clean, fields: [] };
  }
  if (/xml/.test(type)) {
    if (type !== 'application/xml') own(type);
    return { mode: 'xml', raw, fields: [] };
  }
  if (type !== 'text/plain') own(type);
  return { mode: 'text', raw, fields: [] };
}

const js = (s: string) => JSON.stringify(s).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
const locals = (list: EnvVariable[]) => list.filter((v) => v.enabled && !v.secret).map((v) => `bru.local(${js(v.key)}, ${js(v.value)});`);
/** Script text: what the app opens an empty script with is no script. */
const code = (x: unknown) => str(x).replace(/^\s*export\s*\{\s*\};?\s*$/gm, '').trim();
function scripts(o: Obj, vars: EnvVariable[], where: string, notes: Notes): { preRequest?: string; tests?: string } {
  const pre = code(o.preRequestScript);
  const tests = code(o.testScript);
  const gaps = scriptGaps(`${pre}\n${tests}`);
  if (gaps.length) notes.add(where, gapsNote(gaps));
  const before = [...locals(vars), ...(pre ? [pre] : [])].join('\n');
  return { ...(before ? { preRequest: before } : {}), ...(tests ? { tests } : {}) };
}

export function fromHoppscotch(doc: Obj): { root: TreeItem; items: TreeItem[]; variables: EnvVariable[]; ownEnvironment: true; notes: string[] } {
  const notes = new Notes();
  let examples = 0;
  const own = variables(doc.variables);
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: str(doc.name) || 'Imported collection', sort: 0, auth: auth(doc.auth, 'Collection', notes), ...(said(doc.description) ? { description: said(doc.description) } : {}), ...scripts(doc, [], 'Collection', notes) };
  if (root.auth?.mode === 'inherit') root.auth = { mode: 'none' };
  const items: TreeItem[] = [];

  const request = (r: Obj, name: string, above: { name: string; headers: KeyValue[] }[]): RequestSpec => {
    const gql = typeof r.query === 'string' && typeof r.url === 'string' && r.endpoint === undefined;
    const spec = newRequest();
    const mine = rows(r.headers);
    const have = new Set(mine.filter((h) => h.enabled).map((h) => h.key.toLowerCase()));
    const inherited: KeyValue[] = [];
    for (const a of above)
      for (const h of a.headers)
        if (h.enabled && !have.has(h.key.toLowerCase())) {
          have.add(h.key.toLowerCase());
          inherited.push({ ...h, description: h.description ?? `From ${a.name}` });
        }
    spec.headers = [...mine, ...inherited];
    spec.auth = auth(r.auth ?? { authType: 'inherit' }, name, notes);
    if (gql) {
      spec.method = 'POST';
      spec.url = ref(str(r.url)).trim();
      spec.params = splitUrl(spec.url).params;
      spec.body = { mode: 'graphql', raw: ref(str(r.query)), variables: ref(str(r.variables)), fields: [] };
    } else {
      const verb = str(r.method).toUpperCase() || 'GET';
      if ((HTTP_METHODS as readonly string[]).includes(verb)) spec.method = verb as HttpMethod;
      else notes.add(name, `the method ${verb} is not supported; it became GET`);
      // v0 kept the address in two parts. The params table adds to what the address already has.
      const url = ref(str(r.endpoint) || `${str(r.url)}${str(r.path)}`).trim();
      const inUrl = splitUrl(url);
      spec.params = [...inUrl.params, ...rows(r.params)];
      spec.url = joinUrl(inUrl.base, spec.params);
      spec.body = r.body ? body(obj(r.body), spec, name, notes) : emptyBody();
      if (spec.body.mode !== 'none' && ['GET', 'HEAD'].includes(spec.method)) notes.add(name, `a ${spec.method} request is sent without its body here`);
    }
    notes.dynamic(name, [spec.url, spec.headers, spec.params, spec.body]);
    Object.assign(spec, scripts(r, rows(r.requestVariables).map((v) => ({ key: v.key, value: v.value, enabled: v.enabled, secret: false })), name, notes));
    examples += Object.keys(obj(r.responses)).length;
    return spec;
  };

  const walk = (o: Obj, parentId: string, above: { name: string; headers: KeyValue[] }[]) => {
    let sort = 0;
    for (const f of arr(o.folders)) {
      const name = str(f.name) || 'Folder';
      const vars = variables(f.variables);
      const a = auth(f.auth ?? { authType: 'inherit' }, `Folder ${name}`, notes);
      const item: TreeItem = { id: uid('f_'), kind: 'folder', parentId, name, sort: sort++, auth: a, ...(said(f.description) ? { description: said(f.description) } : {}), ...scripts(f, vars, `Folder ${name}`, notes) };
      const secret = vars.filter((v) => v.secret).map((v) => v.key);
      if (secret.length) notes.add(`Folder ${name}`, `add its secret variables to an environment: ${secret.join(', ')}`);
      items.push(item);
      walk(f, item.id, [{ name, headers: rows(f.headers) }, ...above]);
    }
    for (const r of arr(o.requests)) {
      const name = str(r.name) || 'Request';
      items.push({ id: uid('r_'), kind: 'request', parentId, name, sort: sort++, request: request(r, name, above), ...(said(r.description) ? { description: said(r.description) } : {}) });
    }
  };
  walk(doc, root.id, [{ name: root.name, headers: rows(doc.headers) }]);
  if (examples) notes.plain(`${examples} saved ${examples === 1 ? 'example was' : 'examples were'} left out`);
  const secret = own.filter((v) => v.secret).map((v) => v.key);
  if (secret.length) notes.plain(`Fill in the secret variables (the export leaves their values out): ${secret.join(', ')}`);
  return { root, items, ownEnvironment: true, variables: fromHoppEnvironment({ name: root.name, variables: arr(doc.variables) }).variables, notes: notes.all() };
}
