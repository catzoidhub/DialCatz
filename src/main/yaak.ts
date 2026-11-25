import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { emptyBody, type EnvVariable, type RequestAuth, type RequestBody } from '@shared/types';
import { arr, buildCollection, formFields, layered, obj, rowsOf, said, str, textBody, type AppImported, type AppNode, type AppRequest, type Obj } from './appimport';
import { Notes } from './importnotes';

/**
 * Moving from Yaak (#106): its JSON export, or the folder it syncs to (one yaak.<id>.yaml per workspace, folder,
 * request and shared environment). ${[ name ]} becomes {{name}}; other template functions stay as text and are listed.
 */

function templates(notes: Notes, where: string) {
  return (s: string): string =>
    s.replace(/\$\{\[\s*([\s\S]*?)\s*\]\}/g, (whole, expr: string) => {
      if (/^[A-Za-z_][\w.-]*$/.test(expr)) return `{{${expr}}}`;
      if (/^uuid\.v\d\(/.test(expr)) return '{{$guid}}';
      if (/^timestamp\.unix\(/.test(expr)) return '{{$timestamp}}';
      if (/^timestamp\.iso8601\(/.test(expr)) return '{{$isoTimestamp}}';
      notes.add(where, `the template ${/^[\w.]+/.exec(expr)?.[0] ?? 'function'}(…) is not supported`);
      return whole;
    });
}
/** A variable kept encrypted has no value that can be read. */
function variables(x: unknown, tx: (s: string) => string): EnvVariable[] {
  return arr(x)
    .filter((v) => str(v.name))
    .map((v) => {
      const secret = /\$\{\[\s*secure\(/.test(str(v.value));
      return { key: str(v.name), value: secret ? '' : tx(str(v.value)), enabled: v.enabled !== false, secret };
    });
}

function auth(type: unknown, x: unknown, where: string, notes: Notes, tx: (s: string) => string): RequestAuth {
  const o = obj(x);
  const t = str(type);
  if (!t) return { mode: 'inherit' };
  if (t === 'none' || o.disabled === true) return { mode: 'none' };
  const g = (k: string) => (/\$\{\[\s*secure\(/.test(str(o[k])) ? (notes.add(where, `fill in its ${k} (it is encrypted in Yaak)`), '') : tx(str(o[k])));
  switch (t) {
    case 'basic':
      return { mode: 'basic', username: g('username'), password: g('password') };
    case 'bearer': {
      const prefix = o.prefix === undefined ? 'Bearer' : g('prefix').trim();
      return prefix === 'Bearer' ? { mode: 'bearer', token: g('token') } : { mode: 'apikey', key: 'Authorization', value: `${prefix} ${g('token')}`.trim(), in: 'header' };
    }
    case 'apikey':
      return { mode: 'apikey', key: g('key') || 'X-Api-Key', value: g('value'), in: str(o.location) === 'query' ? 'query' : 'header' };
    case 'oauth2': {
      const grant = str(o.grantType) || 'authorization_code';
      if (!['authorization_code', 'client_credentials', 'password'].includes(grant)) {
        notes.add(where, `OAuth 2.0 ${grant} is not supported; the auth was left empty`);
        return { mode: 'none' };
      }
      const cb = g('redirectUri').trim();
      const prefix = g('headerPrefix').trim();
      return {
        mode: 'oauth2',
        oauth2: {
          grant: grant as 'authorization_code',
          tokenUrl: g('accessTokenUrl'),
          clientId: g('clientId'),
          clientSecret: g('clientSecret') || undefined,
          scope: g('scope') || undefined,
          audience: g('audience') || undefined,
          clientAuth: str(o.credentials) === 'basic' ? 'basic' : 'body',
          ...(grant === 'authorization_code' ? { authUrl: g('authorizationUrl'), pkce: o.usePkce === true, ...(/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(cb) ? { redirectUri: cb } : {}) } : {}),
          ...(grant === 'password' ? { username: g('username'), password: g('password') } : {}),
          ...(prefix && prefix !== 'Bearer' ? { headerPrefix: prefix } : {}),
        },
      };
    }
    default:
      notes.add(where, `${t} auth is not supported; the auth was left empty`);
      return { mode: 'none' };
  }
}

function body(type: string, b: Obj, tx: (s: string) => string): { body: RequestBody; contentType?: string } {
  if (!type) return { body: emptyBody() };
  if (type === 'graphql') return { body: { mode: 'graphql', raw: tx(str(b.query)), variables: tx(str(b.variables)), fields: [] } };
  if (type === 'application/x-www-form-urlencoded') return { body: { mode: 'form', raw: '', fields: formFields(b.form, tx, () => null) } };
  if (type === 'multipart/form-data') return { body: { mode: 'multipart', raw: '', fields: formFields(b.form, tx, (f) => (str(f.file) ? str(f.file) : null)) } };
  if (type === 'binary') return { body: { mode: 'binary', raw: '', fields: [] } };
  return textBody(type === 'other' ? '' : type, tx(str(b.text)));
}

const isExport = (x: unknown): x is Obj => obj(x).yaakSchema !== undefined && !!obj(x).resources;
export const isYaak = isExport;

export function fromYaak(doc: Obj): AppImported[] {
  const res = obj(doc.resources);
  const http = arr(res.httpRequests ?? res.requests);
  const all: { model: string; o: Obj }[] = [...arr(res.folders).map((o) => ({ model: 'folder', o })), ...http.map((o) => ({ model: 'http', o })), ...arr(res.grpcRequests).map((o) => ({ model: 'grpc', o })), ...arr(res.websocketRequests).map((o) => ({ model: 'ws', o }))];
  const environments = arr(res.environments);
  return arr(res.workspaces).map((w) => {
    const notes = new Notes();
    const name = str(w.name) || 'Imported workspace';
    const mine = all.filter((x) => x.o.workspaceId === w.id);
    const envs = environments.filter((e) => e.workspaceId === w.id);
    const seen = new Set<unknown>();
    const kids = (folderId: unknown): AppNode[] => {
      if (seen.has(folderId ?? null)) return [];
      seen.add(folderId ?? null);
      return mine
        .filter((x) => (x.o.folderId ?? null) === (folderId ?? null))
        .sort((a, b) => Number(a.o.sortPriority ?? 0) - Number(b.o.sortPriority ?? 0))
        .map((x) => make(x.model, x.o));
    };
    const make = (model: string, o: Obj): AppNode => {
      const url0 = str(o.url);
      const nm = str(o.name) || (model === 'folder' ? 'Folder' : url0.replace(/\$\{\[\s*(.*?)\s*\]\}/g, '{{$1}}') || 'Request');
      const where = model === 'folder' ? `Folder ${nm}` : nm;
      const tx = templates(notes, where);
      const common = { name: nm, docs: said(o.description), headers: rowsOf(model === 'grpc' ? o.metadata : o.headers, tx), auth: auth(o.authenticationType, o.authentication, where, notes, tx) };
      if (model === 'folder') return { kind: 'folder', ...common, locals: envs.filter((e) => e.parentModel === 'folder' && e.parentId === o.id).flatMap((e) => variables(e.variables, tx)), children: kids(o.id) };
      const params = arr(o.urlParameters);
      const r: AppRequest = { kind: 'request', ...common, type: 'http', method: str(o.method) || 'GET', url: tx(url0), query: rowsOf(params.filter((p) => !str(p.name).startsWith(':')), tx), path: params.filter((p) => str(p.name).startsWith(':')).map((p) => ({ name: str(p.name).slice(1), value: tx(str(p.value)) })), body: emptyBody() };
      if (model === 'grpc') return { ...r, type: 'grpc', grpc: { service: str(o.service), method: str(o.method) }, message: { text: tx(str(o.message)) } };
      if (model === 'ws') return { ...r, type: 'ws', message: { text: tx(str(o.message)) } };
      return { ...r, ...body(str(o.bodyType), obj(o.body), tx) };
    };
    const tx = templates(notes, 'Environment');
    const parent = (e: Obj) => str(e.parentModel) || (e.base === true ? 'workspace' : 'environment');
    const base = [...variables(w.variables, tx), ...envs.filter((e) => parent(e) === 'workspace').flatMap((e) => variables(e.variables, tx))];
    const subs = envs.filter((e) => parent(e) === 'environment').map((e) => ({ name: str(e.name) || 'Environment', variables: variables(e.variables, tx) }));
    const cx = templates(notes, 'Collection');
    return buildCollection({ name, docs: said(w.description), headers: rowsOf(w.headers, cx), auth: auth(w.authenticationType, w.authentication, 'Collection', notes, cx), children: kids(null), environments: layered(name, base, subs) }, notes);
  });
}

/** The folder Yaak syncs to: its files as one export. null when there are none. */
export function readYaakFolder(dir: string): Obj | null {
  const res: Record<string, Obj[]> = { workspaces: [], environments: [], folders: [], httpRequests: [], grpcRequests: [], websocketRequests: [] };
  const INTO: Record<string, string> = { workspace: 'workspaces', environment: 'environments', folder: 'folders', http_request: 'httpRequests', grpc_request: 'grpcRequests', websocket_request: 'websocketRequests' };
  let n = 0;
  const walk = (d: string, depth: number) => {
    for (const f of readdirSync(d)) {
      if (f.startsWith('.') || f === 'node_modules') continue;
      const p = join(d, f);
      const st = lstatSync(p);
      if (st.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (st.isFile() && /^yaak\..+\.(ya?ml|json)$/.test(f) && st.size < 5_000_000 && n++ < 10_000) {
        try {
          const o = obj(parseYaml(readFileSync(p, 'utf8'), { maxAliasCount: 100 }));
          const into = INTO[str(o.model ?? o.type)];
          if (into) res[into].push(o);
        } catch {
          /* not a file of Yaak's */
        }
      }
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return res.workspaces.length ? { yaakSchema: 5, resources: res } : null;
}
