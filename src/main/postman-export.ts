import type { KeyValue, RequestAuth, RequestSpec, TreeItem } from '@shared/types';
import { splitUrl, stripLocalFiles } from '@shared/request';

/**
 * A DialCatz collection as a Postman Collection v2.1 file, for people who open it in Postman: folders and requests in
 * order, URLs with their query parameters (switched-off ones and descriptions too), headers, every body kind, auth,
 * pre-request and test scripts (`pm.*` scripts run in both apps), descriptions. Picked files stay out (they are paths
 * on this computer); a file field keeps its name for the user to pick again.
 */

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

type Pm = Record<string, unknown>;

const kv = (list: KeyValue[]) => list.filter((r) => r.key || r.value).map((r) => ({ key: r.key, value: r.value, ...(r.enabled ? {} : { disabled: true }), ...(r.description ? { description: r.description } : {}) }));

function auth(a: RequestAuth | undefined, top: boolean): Pm | undefined {
  const s = (key: string, value: string | undefined) => ({ key, value: value ?? '', type: 'string' });
  switch (a?.mode) {
    case 'bearer':
      return { type: 'bearer', bearer: [s('token', a.token)] };
    case 'basic':
      return { type: 'basic', basic: [s('username', a.username), s('password', a.password)] };
    case 'apikey':
      return { type: 'apikey', apikey: [s('key', a.key), s('value', a.value), s('in', a.in === 'query' ? 'query' : 'header')] };
    case 'none':
      return { type: 'noauth' };
    default:
      // inherit (or nothing set): Postman inherits when there is no auth; a collection has nothing to inherit from
      return top ? { type: 'noauth' } : undefined;
  }
}

function events(pre: string | undefined, tests: string | undefined): Pm[] | undefined {
  const out: Pm[] = [];
  if (pre?.trim()) out.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.split('\n') } });
  if (tests?.trim()) out.push({ listen: 'test', script: { type: 'text/javascript', exec: tests.split('\n') } });
  return out.length ? out : undefined;
}

/** Postman's URL object: the raw text, plus host / path where they can be read, and the query list. */
function url(spec: RequestSpec): Pm {
  const { base } = splitUrl(spec.url);
  const u: Pm = { raw: spec.url };
  const m = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/i.exec(base) ?? /^()(\{\{[^}]+\}\}[^/?#]*)(\/[^?#]*)?$/.exec(base);
  if (m) {
    if (m[1]) u.protocol = m[1].toLowerCase();
    u.host = m[2].startsWith('{{') ? [m[2]] : m[2].split('.');
    const path = (m[3] ?? '').split('/').filter(Boolean);
    if (path.length) u.path = path;
  }
  if (spec.params.length) u.query = kv(spec.params);
  return u;
}

function body(spec: RequestSpec): Pm | undefined {
  const b = spec.body;
  switch (b.mode) {
    case 'json':
    case 'text':
    case 'xml':
      return { mode: 'raw', raw: b.raw, options: { raw: { language: b.mode } } };
    case 'form':
      return { mode: 'urlencoded', urlencoded: kv(b.fields).map((f) => ({ ...f, type: 'text' })) };
    case 'multipart':
      return {
        mode: 'formdata',
        formdata: b.fields
          .filter((f) => f.key || f.value)
          .map((f) => ({ key: f.key, ...(f.type === 'file' ? { type: 'file', src: [] } : { type: 'text', value: f.value }), ...(f.enabled ? {} : { disabled: true }), ...(f.description ? { description: f.description } : {}) })),
      };
    case 'graphql':
      return { mode: 'graphql', graphql: { query: b.raw, variables: b.variables ?? '' } };
    case 'binary':
      return { mode: 'file', file: {} };
    default:
      return undefined;
  }
}

function request(item: TreeItem): Pm {
  const spec = stripLocalFiles(item.request!);
  const r: Pm = { method: spec.method, header: kv(spec.headers), url: url(spec) };
  const b = body(spec);
  if (b) r.body = b;
  const a = auth(spec.auth, false);
  if (a) r.auth = a;
  if (item.description) r.description = item.description;
  const ev = events(spec.preRequest, spec.tests);
  return { name: item.name, ...(ev ? { event: ev } : {}), request: r, response: [] };
}

export function toPostman(items: TreeItem[], collectionId: string): Pm {
  const root = items.find((i) => i.id === collectionId && i.kind === 'collection');
  if (!root) throw new Error('That collection does not exist any more');
  const children = (parent: string): Pm[] =>
    items
      .filter((i) => i.parentId === parent)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
      .map((i) => {
        if (i.kind === 'request' && i.request) return request(i);
        const a = auth(i.auth, false);
        const ev = events(i.preRequest, i.tests);
        return { name: i.name, ...(i.description ? { description: i.description } : {}), item: children(i.id), ...(a ? { auth: a } : {}), ...(ev ? { event: ev } : {}) };
      });
  const ev = events(root.preRequest, root.tests);
  return {
    info: { name: root.name, ...(root.description ? { description: root.description } : {}), schema: SCHEMA },
    item: children(root.id),
    auth: auth(root.auth, true),
    ...(ev ? { event: ev } : {}),
  };
}
