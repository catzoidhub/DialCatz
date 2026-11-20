import type { KeyValue, RequestAuth, TreeItem } from '@shared/types';

/**
 * A collection as an OpenAPI 3.0 document (#95): for collections made by hand, the start of a contract. Each request
 * becomes an operation on its path (`:id`, `{id}` and `{{id}}` segments as path parameters; the URL's leading
 * {{baseUrl}} or host dropped, its value as the server), with its query parameters and headers, its body (a JSON body
 * as its example plus a schema read from it; form fields as properties), its auth as a security scheme, and the
 * responses its spec describes when it came from one (else a plain 200). The folder a request sits in is its tag.
 * Two requests on the same method and path: the first one wins (the others are counted).
 */

type Schema = Record<string, unknown>;
// Headers DialCatz adds itself, or ones auth and the body type stand for: not parameters of the API.
const NOT_PARAMS = new Set(['authorization', 'content-type', 'accept', 'user-agent', 'accept-encoding', 'connection', 'cache-control', 'cookie', 'host', 'content-length']);

/** A JSON value's schema: types, object properties, an array's first item. */
export function schemaOf(v: unknown, depth = 0): Schema {
  if (depth > 12) return {};
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOf(v[0], depth + 1) : {} };
  switch (typeof v) {
    case 'object':
      return { type: 'object', properties: Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, schemaOf(x, depth + 1)])) };
    case 'number':
      return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v) ? { type: 'string', format: 'date-time' } : { type: 'string' };
  }
}

/** `{{baseUrl}}/users/:id/posts/{{postId}}?x=1` → `/users/{id}/posts/{postId}` and the path parameters. */
export function pathOf(url: string): { path: string; params: string[] } {
  const raw = url
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '')
    .split(/[?#]/)[0];
  const params: string[] = [];
  const path =
    '/' +
    raw
      .split('/')
      .filter(Boolean)
      .map((seg) => {
        const m = seg.match(/^:([\w-]+)$|^\{\{?([\w-]+)\}?\}$/);
        if (!m) return seg;
        const name = m[1] ?? m[2];
        params.push(name);
        return `{${name}}`;
      })
      .join('/');
  return { path, params };
}

/** A value that is a {{variable}} carries no example. */
const example = (v: string) => (!v || /\{\{[^}]+\}\}/.test(v) ? undefined : v);
const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^[A-Z]/, (c) => c.toLowerCase()) || 'operation';

function securityOf(auth: RequestAuth | undefined): { name: string; scheme: Schema } | null {
  switch (auth?.mode) {
    case 'bearer':
      return { name: 'bearerAuth', scheme: { type: 'http', scheme: 'bearer' } };
    case 'basic':
      return { name: 'basicAuth', scheme: { type: 'http', scheme: 'basic' } };
    case 'apikey':
      return auth.key ? { name: `apiKey_${camel(auth.key)}`, scheme: { type: 'apiKey', name: auth.key, in: auth.in === 'query' ? 'query' : 'header' } } : null;
    default:
      return null;
  }
}

function bodyOf(r: NonNullable<TreeItem['request']>): Schema | null {
  const b = r.body;
  const fields = (list: KeyValue[], files: boolean) => {
    const on = list.filter((f) => f.key);
    return { type: 'object', properties: Object.fromEntries(on.map((f) => [f.key, files && f.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string', ...(example(f.value) !== undefined ? { example: f.value } : {}), ...(f.description ? { description: f.description } : {}) }])), ...(on.some((f) => f.enabled) ? { required: on.filter((f) => f.enabled).map((f) => f.key) } : {}) };
  };
  switch (b.mode) {
    case 'json': {
      // {{variables}} inside a JSON body are text there: turned into placeholders so the body still parses.
      const text = b.raw.replace(/("?)\{\{([^}]+)\}\}("?)/g, (_m, a: string, name: string, c: string) => (a && c ? `"<${name}>"` : `"<${name}>"`));
      try {
        const value = JSON.parse(text);
        return { content: { 'application/json': { schema: schemaOf(value), example: value } } };
      } catch {
        return { content: { 'application/json': { schema: {}, ...(b.raw.trim() ? { example: b.raw } : {}) } } };
      }
    }
    case 'form':
      return { content: { 'application/x-www-form-urlencoded': { schema: fields(b.fields, false) } } };
    case 'multipart':
      return { content: { 'multipart/form-data': { schema: fields(b.fields, true) } } };
    case 'xml':
      return { content: { 'application/xml': { schema: { type: 'string' }, ...(b.raw.trim() ? { example: b.raw } : {}) } } };
    case 'text':
      return { content: { 'text/plain': { schema: { type: 'string' }, ...(b.raw.trim() ? { example: b.raw } : {}) } } };
    case 'graphql':
      return { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } } }, example: { query: b.raw } } } };
    case 'binary':
      return { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    default:
      return null;
  }
}

export interface OpenApiExport {
  doc: Record<string, unknown>;
  operations: number;
  /** Requests left out because another one already has their method and path. */
  duplicates: number;
}

/**
 * The collection's OpenAPI document. `vars`: the collection's environment, to turn the URL's leading {{variable}}
 * into the server address (left out when it has no value).
 */
export function toOpenApi(items: TreeItem[], collectionId: string, vars: Map<string, string> = new Map()): OpenApiExport {
  const col = items.find((i) => i.id === collectionId)!;
  const byParent = (id: string) => items.filter((i) => i.parentId === id).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const requests: { item: TreeItem; tag: string | null; auth: RequestAuth | undefined }[] = [];
  const walk = (id: string, tag: string | null, auth: RequestAuth | undefined) => {
    for (const i of byParent(id)) {
      const own = i.auth && i.auth.mode !== 'inherit' ? i.auth : auth;
      if (i.kind === 'request' && i.request) requests.push({ item: i, tag, auth: i.request.auth && i.request.auth.mode !== 'inherit' ? i.request.auth : own });
      else if (i.kind === 'folder') walk(i.id, tag ? `${tag} / ${i.name}` : i.name, own);
    }
  };
  walk(col.id, null, col.auth && col.auth.mode !== 'inherit' ? col.auth : undefined);

  const paths: Record<string, Record<string, unknown>> = {};
  const schemes: Record<string, Schema> = {};
  const ids = new Set<string>();
  let operations = 0;
  let duplicates = 0;
  const servers = new Set<string>();
  for (const { item, tag, auth } of requests) {
    const r = item.request!;
    const lead = r.url.match(/^\{\{([^}]+)\}\}/)?.[1];
    const server = lead ? vars.get(lead) : r.url.match(/^([a-z][\w+.-]*:\/\/[^/]+)/i)?.[1];
    if (server && /^https?:\/\//i.test(server)) servers.add(server.replace(/\/+$/, ''));
    const { path, params } = pathOf(r.url);
    const method = r.method.toLowerCase();
    const at = (paths[path] ??= {});
    if (at[method]) {
      duplicates++;
      continue;
    }
    let opId = camel(item.name);
    for (let n = 2; ids.has(opId); n++) opId = `${camel(item.name)}${n}`;
    ids.add(opId);
    const parameters = [
      ...params.map((p) => ({ name: p, in: 'path', required: true, schema: { type: 'string' } })),
      ...r.params.filter((p) => p.key).map((p) => ({ name: p.key, in: 'query', required: p.enabled, schema: { type: 'string' }, ...(example(p.value) !== undefined ? { example: p.value } : {}), ...(p.description ? { description: p.description } : {}) })),
      ...r.headers.filter((h) => h.key && h.enabled && !NOT_PARAMS.has(h.key.toLowerCase())).map((h) => ({ name: h.key, in: 'header', required: false, schema: { type: 'string' }, ...(example(h.value) !== undefined ? { example: h.value } : {}) })),
    ];
    const sec = securityOf(auth);
    if (sec) schemes[sec.name] = sec.scheme;
    const responses = item.specResponses?.length
      ? Object.fromEntries(
          item.specResponses.map((s) => [
            s.status === 'DEFAULT' ? 'default' : s.status,
            { description: s.status === 'DEFAULT' ? 'Default' : s.status, ...(s.types.length ? { content: Object.fromEntries(s.types.map((t) => [t, { ...(s.schema ? { schema: s.schema } : {}), ...(s.example !== undefined ? { example: s.example } : {}) }])) } : {}) },
          ]),
        )
      : { '200': { description: 'OK' } };
    const body = ['get', 'head', 'delete', 'options'].includes(method) ? null : bodyOf(r);
    at[method] = {
      operationId: opId,
      summary: item.name,
      ...(item.description ? { description: item.description } : {}),
      ...(tag ? { tags: [tag] } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: body } : {}),
      responses,
      ...(sec ? { security: [{ [sec.name]: [] }] } : {}),
    };
    operations++;
  }
  const tags = [...new Set(requests.map((x) => x.tag).filter((t): t is string => !!t))];
  const doc: Record<string, unknown> = {
    openapi: '3.0.3',
    info: { title: col.name, version: '1.0.0', ...(col.description ? { description: col.description } : {}) },
    ...(servers.size ? { servers: [...servers].map((url) => ({ url })) } : {}),
    ...(tags.length ? { tags: tags.map((name) => ({ name })) } : {}),
    paths,
    ...(Object.keys(schemes).length ? { components: { securitySchemes: schemes } } : {}),
  };
  return { doc, operations, duplicates };
}
