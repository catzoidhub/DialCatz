import { emptyBody, type Environment, type EnvVariable, type RequestAuth, type RequestBody } from '@shared/types';
import { arr, buildCollection, formFields, layered, obj, rowsOf, said, str, textBody, type AppImported, type AppNode, type AppRequest, type Obj } from './appimport';
import { Notes } from './importnotes';

/**
 * Moving from Insomnia (#106): its v5 YAML files (a collection or a design document, with its environments) and the
 * older v4 JSON export. {{ _.name }} and {{ name }} become {{name}}; an object in an environment becomes a.b names.
 * Template tags ({% … %}) stay as text and are listed, apart from the ones DialCatz has a value for.
 */

/** What Insomnia calls a template, as DialCatz writes it. */
function templates(notes: Notes, where: string) {
  return (s: string): string => {
    if (!s.includes('{')) return s;
    const tagged = s.replace(/\{%-?\s*([\w]+)\b([^%]*)-?%\}/g, (whole, tag: string, rest: string) => {
      if (tag === 'uuid') return '{{$guid}}';
      if (tag === 'now') return /unix/i.test(rest) ? '{{$timestamp}}' : /iso/i.test(rest) || !rest.trim() ? '{{$isoTimestamp}}' : (notes.add(where, `the template tag ${whole.slice(0, 60)} is not supported`), whole);
      if (tag === 'timestamp') return '{{$timestamp}}';
      notes.add(where, `the template tag {% ${tag} … %} is not supported`);
      return whole;
    });
    return tagged.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (whole, expr: string) => {
      if (/^\$\w+$/.test(expr)) return whole;
      const name = variableName(expr);
      if (name) return `{{${name}}}`;
      notes.add(where, `the template ${whole.slice(0, 60)} is not supported`);
      return whole;
    });
  };
}
/** `_.a.b`, `_['a-b']`, `a[0].b` → a.b, a-b, a.0.b; null for anything that is more than a name. */
function variableName(expr: string): string | null {
  let e = expr.trim();
  if (!/^[A-Za-z_$][\w$-]*(\.[\w$-]+|\[\d+\]|\[\s*(['"])[^'"\]]+\2\s*\])*$/.test(e)) return null;
  e = e.replace(/\[\s*(?:['"])([^'"\]]+)['"]\s*\]/g, '.$1').replace(/\[(\d+)\]/g, '.$1');
  const name = e.replace(/^_\./, '');
  return /^[\w.$-]+$/.test(name) ? name : null;
}

/** An environment's data: objects and lists by their path (a.b, list.0). */
function flatten(data: unknown, tx: (s: string) => string, secret: Set<string>, prefix = ''): EnvVariable[] {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).flatMap(([k, v]): EnvVariable[] => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') return flatten(v, tx, secret, key);
    const hidden = secret.has(key) || secret.has(key.split('.')[0]);
    return [{ key, value: hidden ? '' : tx(str(v)), enabled: true, secret: hidden }];
  });
}
/** Both kinds of an environment: JSON data, or a table (whose secret values are encrypted). */
function envVariables(e: Obj, tx: (s: string) => string): EnvVariable[] {
  const table = arr(e.kvPairData);
  if (str(e.environmentType) === 'kv' && table.length)
    return table
      .filter((v) => str(v.name))
      .flatMap((v): EnvVariable[] => {
        const enabled = v.enabled !== false;
        if (str(v.type) === 'secret') return [{ key: str(v.name), value: '', enabled, secret: true }];
        if (str(v.type) === 'json') {
          try {
            const inner = JSON.parse(str(v.value));
            if (inner && typeof inner === 'object') return flatten(inner, tx, new Set(), str(v.name)).map((x) => ({ ...x, enabled }));
          } catch {
            /* kept as its text */
          }
        }
        return [{ key: str(v.name), value: tx(str(v.value)), enabled, secret: false }];
      });
  const vault = obj(obj(e.data).__insomnia_vault);
  const secret = new Set([...(Array.isArray(e.confidentialKeys) ? e.confidentialKeys.map(str) : []), '__insomnia_vault']);
  return [...flatten(e.data, tx, secret).filter((v) => !v.key.startsWith('__insomnia_vault')), ...Object.keys(vault).map((k) => ({ key: `vault.${k}`, value: '', enabled: true, secret: true }))];
}

function auth(a: unknown, where: string, notes: Notes, tx: (s: string) => string): RequestAuth {
  const o = obj(a);
  const type = str(o.type);
  // Nothing chosen is Inherit; "No auth" is a choice of its own.
  if (!type) return { mode: 'inherit' };
  if (type === 'none' || o.disabled === true) return { mode: 'none' };
  const g = (k: string) => tx(typeof o[k] === 'object' ? '' : str(o[k]));
  switch (type) {
    case 'bearer': {
      const prefix = g('prefix').trim();
      if (prefix && prefix !== 'Bearer') return { mode: 'apikey', key: 'Authorization', value: prefix === 'NO_PREFIX' ? g('token') : `${prefix} ${g('token')}`, in: 'header' };
      return { mode: 'bearer', token: g('token') };
    }
    case 'basic':
      return { mode: 'basic', username: g('username'), password: g('password') };
    case 'apikey':
      if (/cookie/i.test(str(o.addTo))) return { mode: 'apikey', key: 'Cookie', value: `${g('key')}=${g('value')}`, in: 'header' };
      return { mode: 'apikey', key: g('key'), value: g('value'), in: /query/i.test(str(o.addTo)) ? 'query' : 'header' };
    case 'oauth2': {
      const grant = str(o.grantType);
      if (!['authorization_code', 'client_credentials', 'password'].includes(grant)) {
        notes.add(where, `OAuth 2.0 ${grant.replace(/_/g, ' ') || 'without a grant'} is not supported; the auth was left empty`);
        return { mode: 'none' };
      }
      const cb = g('redirectUrl').trim();
      const prefix = g('tokenPrefix').trim();
      return {
        mode: 'oauth2',
        oauth2: {
          grant: grant as 'authorization_code',
          tokenUrl: g('accessTokenUrl'),
          clientId: g('clientId'),
          clientSecret: g('clientSecret') || undefined,
          scope: g('scope') || undefined,
          audience: g('audience') || undefined,
          clientAuth: o.credentialsInBody === true ? 'body' : 'basic',
          ...(grant === 'authorization_code' ? { authUrl: g('authorizationUrl'), pkce: o.usePkce === true, ...(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(cb) ? { redirectUri: cb } : {}) } : {}),
          ...(grant === 'password' ? { username: g('username'), password: g('password') } : {}),
          ...(prefix && prefix !== 'Bearer' ? { headerPrefix: prefix } : {}),
        },
      };
    }
    default:
      notes.add(where, `${type} auth is not supported; the auth was left empty`);
      return { mode: 'none' };
  }
}

function body(b: Obj, tx: (s: string) => string): { body: RequestBody; contentType?: string } {
  const type = str(b.mimeType).split(';')[0].trim().toLowerCase();
  const text = tx(str(b.text));
  if (type === 'application/x-www-form-urlencoded') return { body: { mode: 'form', raw: '', fields: formFields(b.params, tx, () => null) } };
  if (type === 'multipart/form-data') return { body: { mode: 'multipart', raw: '', fields: formFields(b.params, tx, (f) => (str(f.type) === 'file' ? str(f.fileName) : null)) } };
  if (type === 'application/octet-stream') return { body: { mode: 'binary', raw: '', fields: [] } };
  if (type === 'application/graphql') {
    let query = text;
    let variables = '';
    try {
      const g = JSON.parse(str(b.text)) as Obj;
      if (typeof g.query === 'string') {
        query = tx(g.query);
        variables = g.variables === undefined || g.variables === null ? '' : tx(typeof g.variables === 'string' ? g.variables : JSON.stringify(g.variables, null, 2));
      }
    } catch {
      /* a plain query */
    }
    return { body: { mode: 'graphql', raw: query, variables, fields: [] } };
  }
  if (!type && !text) return { body: emptyBody() };
  return textBody(str(b.mimeType), text);
}

/** One node of either format; `kids` gives a folder's children. */
function node(n: Obj, type: string, notes: Notes, kids: () => AppNode[], payload: Obj | undefined): AppNode | null {
  const name = str(n.name) || (type === 'folder' ? 'Folder' : 'Request');
  const where = type === 'folder' ? `Folder ${name}` : name;
  const tx = templates(notes, where);
  const meta = obj(n.meta);
  const scripts = obj(n.scripts);
  const common = { name, docs: said(n.description) ?? said(meta.description), headers: rowsOf(n.headers, tx), auth: auth(n.authentication, where, notes, tx), pre: str(scripts.preRequest ?? n.preRequestScript), post: str(scripts.afterResponse ?? n.afterResponseScript) };
  if (type === 'folder') return { kind: 'folder', ...common, locals: envVariables({ ...n, data: n.environment }, tx), children: kids() };
  const r: AppRequest = { kind: 'request', ...common, type: 'http', method: str(n.method) || 'GET', url: tx(str(n.url)), query: rowsOf(n.parameters, tx), path: arr(n.pathParameters).map((p) => ({ name: str(p.name), value: tx(str(p.value)) })), body: emptyBody() };
  if (type === 'grpc') {
    const [service, method] = str(n.protoMethodName).replace(/^\//, '').split('/');
    if (str(n.protoFileId)) notes.add(name, 'choose its .proto file again, or use server reflection');
    return { ...r, type: 'grpc', headers: rowsOf(n.metadata, tx), grpc: { service: service ?? '', method: method ?? '' }, message: { text: tx(str(obj(n.body).text)) } };
  }
  if (type === 'ws') return { ...r, type: 'ws', message: { text: tx(str(payload?.value ?? payload?.text)) } };
  if (type === 'socketio') {
    const args = arr(payload?.args);
    const path = str(obj(n.settings).path ?? n.settingPath) || '/socket.io/';
    if (args.length > 1) notes.add(name, 'only the first argument of its saved message came along');
    const u = /^([a-z]+:\/\/[^/?#]+)\/?$/i.exec(r.url);
    return { ...r, type: 'socketio', url: u ? `${u[1]}${path.startsWith('/') ? '' : '/'}${path}` : r.url, message: { text: tx(str(args[0]?.value)), event: str(payload?.eventName) || undefined } };
  }
  return { ...r, ...body(obj(n.body), tx) };
}

const by = (a: Obj, b: Obj) => Number(obj(a.meta).sortKey ?? a.metaSortKey ?? 0) - Number(obj(b.meta).sortKey ?? b.metaSortKey ?? 0);

// ------------------------------------------------------------------ v5 (YAML)

export const isInsomniaV5 = (x: unknown): x is Obj => /^(collection|spec)\.insomnia\.rest\/5/.test(str(obj(x).type));
export const isInsomniaV5Environment = (x: unknown): x is Obj => /^environment\.insomnia\.rest\/5/.test(str(obj(x).type));

function environmentsOf(e: Obj, name: string, notes: Notes): Environment[] {
  const tx = templates(notes, 'Environment');
  return layered(name, envVariables(e, tx), arr(e.subEnvironments).sort(by).map((s) => ({ name: str(s.name) || 'Environment', variables: envVariables(s, tx) })));
}
export function fromInsomniaV5(doc: Obj): AppImported {
  const notes = new Notes();
  const name = str(doc.name) || 'Imported collection';
  const kids = (list: unknown): AppNode[] =>
    arr(list)
      .sort(by)
      .map((n) => {
        const id = str(obj(n.meta).id ?? n._id);
        const type = Array.isArray(n.children) || /^fld_/.test(id) ? 'folder' : /^(greq|grpc)/.test(id) || n.protoMethodName !== undefined ? 'grpc' : /^ws-req/.test(id) ? 'ws' : /^socketio/.test(id) ? 'socketio' : /^mcp/.test(id) || n.transportType !== undefined ? 'mcp' : n.method || n.body || !/^wss?:/i.test(str(n.url)) ? 'http' : 'ws';
        if (type === 'mcp') {
          notes.add(str(n.name), 'an MCP client has no place in DialCatz; it was left out');
          return null;
        }
        return node(n, type, notes, () => kids(n.children), obj(n.body));
      })
      .filter((x): x is AppNode => !!x);
  if (arr(obj(doc.testSuites)).length || arr(doc.testSuites).length) notes.plain('Its unit test suites were left out');
  if (doc.spec && str(obj(obj(doc.spec).contents).openapi ?? obj(doc.spec).file)) notes.plain('Its API document was left out: import it as OpenAPI');
  const tx = templates(notes, 'Collection');
  const scripts = obj(doc.scripts);
  return buildCollection({ name, docs: said(obj(doc.meta).description), headers: rowsOf(doc.headers, tx), auth: auth(doc.authentication, 'Collection', notes, tx), pre: str(scripts.preRequest), post: str(scripts.afterResponse), children: kids(doc.collection), environments: environmentsOf(obj(doc.environments), name, notes) }, notes);
}
export const insomniaEnvironments = (doc: Obj): Environment[] => environmentsOf(obj(doc.environments), str(doc.name) || 'Environment', new Notes());

// ------------------------------------------------------------------ v4 (JSON)

export const isInsomniaV4 = (x: unknown): x is Obj => str(obj(x)._type) === 'export' && Array.isArray(obj(x).resources) && obj(x).__export_format !== undefined;

export function fromInsomniaV4(doc: Obj): AppImported[] {
  const all = arr(doc.resources);
  const of = (parentId: unknown, ...types: string[]) => all.filter((r) => r.parentId === parentId && types.includes(str(r._type)));
  const KIND: Record<string, string> = { request_group: 'folder', request: 'http', grpc_request: 'grpc', websocket_request: 'ws', socketio_request: 'socketio' };
  return all
    .filter((r) => r._type === 'workspace')
    .flatMap((w) => {
      const notes = new Notes();
      const name = str(w.name) || 'Imported collection';
      const seen = new Set<unknown>();
      const kids = (id: unknown): AppNode[] => {
        if (seen.has(id)) return [];
        seen.add(id);
        return of(id, ...Object.keys(KIND))
          .sort(by)
          .map((r) => node(r, KIND[str(r._type)], notes, () => kids(r._id), of(r._id, 'websocket_payload', 'socketio_payload', 'socket_io_payload')[0]))
          .filter((x): x is AppNode => !!x);
      };
      const tx = templates(notes, 'Environment');
      const bases = of(w._id, 'environment');
      const environments = layered(name, bases.flatMap((b) => envVariables(b, tx)), bases.flatMap((b) => of(b._id, 'environment').sort(by)).map((s) => ({ name: str(s.name) || 'Environment', variables: envVariables(s, tx) })));
      if (of(w._id, 'unit_test_suite').length) notes.plain('Its unit test suites were left out');
      if (of(w._id, 'api_spec').some((s) => str(s.contents).trim())) notes.plain('Its API document was left out: import it as OpenAPI');
      const children = kids(w._id);
      if (!children.length && !environments.length) return [];
      return [buildCollection({ name, docs: said(w.description), headers: rowsOf(w.headers, tx), auth: auth(w.authentication, 'Collection', notes, tx), pre: str(w.preRequestScript), post: str(w.afterResponseScript), children, environments }, notes)];
    });
}
