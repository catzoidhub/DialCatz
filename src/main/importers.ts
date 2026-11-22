import { emptyBody, HTTP_METHODS, newRequest, uid, type HttpMethod, type KeyValue, type RequestAuth, type RequestSpec, type SpecResponse, type TreeItem, type EnvVariable } from '@shared/types';
import { parse as parseYaml } from 'yaml';
import { joinUrl, parseCurl, splitUrl, stripLocalFiles } from '@shared/request';

/**
 * Collection imports: a DialCatz export, a Postman v2 / v2.1 collection, an OpenAPI 3 (or Swagger 2) document in
 * JSON or YAML, or a single cURL command. Each becomes one new collection with fresh ids.
 */

export interface DialCatzExport {
  dialcatz: 1;
  collection: TreeItem;
  items: TreeItem[];
}

export function exportCollection(items: TreeItem[], collectionId: string): DialCatzExport {
  const root = items.find((i) => i.id === collectionId);
  if (!root) throw new Error('That collection does not exist any more');
  const out: TreeItem[] = [];
  const walk = (parent: string) => {
    for (const i of items.filter((x) => x.parentId === parent)) {
      out.push(strip(i));
      walk(i.id);
    }
  };
  walk(collectionId);
  return { dialcatz: 1, collection: strip(root), items: out };
}

function strip(i: TreeItem): TreeItem {
  // database / dbTable: "Check in DBCatz" settings of this computer, not part of a shared file
  const { rev: _r, dirty: _d, updatedBy: _u, updatedAt: _a, database: _db, dbTable: _t, ...rest } = i;
  return { ...rest, request: stripLocalFiles(rest.request) };
}

const method = (m: unknown): HttpMethod => {
  const up = String(m ?? 'GET').toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(up) ? (up as HttpMethod) : 'GET';
};

/** Postman writes a description as text or as { content, type }. */
const describe = (d: unknown): string | undefined => {
  const t = typeof d === 'string' ? d : d && typeof d === 'object' && typeof (d as { content?: unknown }).content === 'string' ? (d as { content: string }).content : '';
  return t.trim() ? t : undefined;
};
const kv = (list: unknown): KeyValue[] =>
  Array.isArray(list) ? list.filter((x) => x && typeof x === 'object' && 'key' in x).map((x) => ({ key: String(x.key ?? ''), value: String(x.value ?? ''), enabled: !x.disabled, description: describe(x.description) })) : [];

// ------------------------------------------------------------------ Postman

type PmAuth = { type?: string; [k: string]: unknown };
function pmAuth(a: PmAuth | undefined): RequestAuth {
  if (!a?.type) return { mode: 'inherit' };
  const get = (kind: string, key: string) => {
    const arr = a[kind];
    if (Array.isArray(arr)) return String(arr.find((x: { key: string }) => x.key === key)?.value ?? '');
    if (arr && typeof arr === 'object') return String((arr as Record<string, unknown>)[key] ?? '');
    return '';
  };
  switch (a.type) {
    case 'noauth':
      return { mode: 'none' };
    case 'bearer':
      return { mode: 'bearer', token: get('bearer', 'token') };
    case 'basic':
      return { mode: 'basic', username: get('basic', 'username'), password: get('basic', 'password') };
    case 'apikey':
      return { mode: 'apikey', key: get('apikey', 'key'), value: get('apikey', 'value'), in: get('apikey', 'in') === 'query' ? 'query' : 'header' };
    case 'oauth2': {
      // Postman's settings (its own token, if one was saved in the export, is left behind).
      const g = get('oauth2', 'grant_type');
      const grant = g === 'client_credentials' ? 'client_credentials' : g === 'password_credentials' ? 'password' : 'authorization_code';
      const prefix = get('oauth2', 'headerPrefix').trim();
      return {
        mode: 'oauth2',
        oauth2: {
          grant,
          tokenUrl: get('oauth2', 'accessTokenUrl'),
          clientId: get('oauth2', 'clientId'),
          clientSecret: get('oauth2', 'clientSecret') || undefined,
          scope: get('oauth2', 'scope') || undefined,
          audience: get('oauth2', 'audience') || undefined,
          clientAuth: get('oauth2', 'client_authentication') === 'body' ? 'body' : 'basic',
          ...(grant === 'authorization_code' ? { authUrl: get('oauth2', 'authUrl'), pkce: g !== 'authorization_code' } : {}),
          ...(grant === 'password' ? { username: get('oauth2', 'username'), password: get('oauth2', 'password') } : {}),
          ...(prefix && prefix !== 'Bearer' ? { headerPrefix: prefix } : {}),
        },
      };
    }
    default:
      return { mode: 'inherit' };
  }
}

function pmRequest(r: Record<string, unknown> | string): RequestSpec {
  if (typeof r === 'string') return { ...newRequest(), url: r, params: splitUrl(r).params };
  const urlObj = r.url as string | { raw?: string; query?: unknown } | undefined;
  const url = typeof urlObj === 'string' ? urlObj : urlObj?.raw ?? '';
  // Postman's own query list keeps each parameter's description and the ones switched off; the raw URL does not.
  const query = typeof urlObj === 'object' && Array.isArray(urlObj?.query) && urlObj.query.length ? kv(urlObj.query) : splitUrl(url).params;
  const spec: RequestSpec = { ...newRequest(), method: method(r.method), url, params: query, headers: kv(r.header), auth: pmAuth(r.auth as PmAuth) };
  const b = r.body as { mode?: string; raw?: string; urlencoded?: unknown; formdata?: unknown; options?: { raw?: { language?: string } } } | undefined;
  if (b?.mode === 'raw') {
    const lang = b.options?.raw?.language;
    const raw = b.raw ?? '';
    spec.body = { mode: lang === 'json' || /^\s*[[{]/.test(raw) ? 'json' : lang === 'xml' ? 'xml' : 'text', raw, fields: [] };
  } else if (b?.mode === 'urlencoded') spec.body = { mode: 'form', raw: '', fields: kv(b.urlencoded) };
  else if (b?.mode === 'formdata') {
    // File fields come without their file (a path on someone else's computer): the user picks it again.
    const types = Array.isArray(b.formdata) ? (b.formdata as { type?: string }[]).map((f) => f?.type) : [];
    spec.body = { mode: 'multipart', raw: '', fields: kv(b.formdata).map((f, n) => (types[n] === 'file' ? { ...f, type: 'file' as const, value: '' } : f)) };
  } else if (b?.mode === 'graphql') {
    const g = (b as { graphql?: { query?: string; variables?: string } }).graphql;
    spec.body = { mode: 'graphql', raw: g?.query ?? '', variables: g?.variables ?? '', fields: [] };
  }
  return spec;
}

/** Postman's `event` list: the pre-request and test scripts (`exec` is text or a list of lines). */
function pmScripts(ev: unknown): { preRequest?: string; tests?: string } {
  const out: { preRequest?: string; tests?: string } = {};
  if (!Array.isArray(ev)) return out;
  for (const e of ev as { listen?: string; script?: { exec?: unknown } }[]) {
    const x = e?.script?.exec;
    const text = Array.isArray(x) ? x.map(String).join('\n') : typeof x === 'string' ? x : '';
    if (!text.trim()) continue;
    if (e.listen === 'prerequest') out.preRequest = text;
    else if (e.listen === 'test') out.tests = text;
  }
  return out;
}

/**
 * A Postman collection's own variables (`variable`): DialCatz has no collection scope, so they come in as an environment
 * named after the collection (doImport / applyPostman). Disabled rows stay disabled; secret-typed ones stay secret.
 */
function pmVariables(list: unknown): EnvVariable[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string' && !!(v as { key: string }).key)
    .map((v) => ({ key: String(v.key), value: v.value === undefined || v.value === null ? '' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value), enabled: v.disabled !== true, secret: v.type === 'secret' }));
}

function fromPostman(doc: Record<string, unknown>): { root: TreeItem; items: TreeItem[]; variables: EnvVariable[] } {
  const info = doc.info as { name?: string; description?: string } | undefined;
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: info?.name || 'Imported collection', sort: 0, auth: pmAuth(doc.auth as PmAuth), description: describe(info?.description), ...pmScripts(doc.event) };
  if (root.auth?.mode === 'inherit') root.auth = { mode: 'none' };
  const items: TreeItem[] = [];
  const walk = (list: unknown, parentId: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((it: Record<string, unknown>, n) => {
      if (Array.isArray(it.item)) {
        const f: TreeItem = { id: uid('f_'), kind: 'folder', parentId, name: String(it.name ?? 'Folder'), sort: n, auth: pmAuth(it.auth as PmAuth), description: describe(it.description), ...pmScripts(it.event) };
        items.push(f);
        walk(it.item, f.id);
      } else if (it.request) {
        const req = it.request as Record<string, unknown>;
        items.push({ id: uid('r_'), kind: 'request', parentId, name: String(it.name ?? 'Request'), sort: n, request: { ...pmRequest(req), ...pmScripts(it.event) }, description: describe(typeof req === 'object' ? req.description : undefined) });
      }
    });
  };
  walk(doc.item, root.id);
  return { root, items, variables: pmVariables(doc.variable) };
}

// ------------------------------------------------------------------ OpenAPI

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; description?: string; items?: Schema; example?: unknown; default?: unknown; enum?: unknown[]; $ref?: string; format?: string; allOf?: Schema[]; oneOf?: Schema[]; anyOf?: Schema[] };

function exampleOf(s: Schema | undefined, doc: Record<string, unknown>, depth = 0): unknown {
  if (!s || depth > 6) return null;
  if (s.$ref) {
    const target = s.$ref.replace(/^#\//, '').split('/').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc) as Schema;
    return exampleOf(target, doc, depth + 1);
  }
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => exampleOf(x, doc, depth + 1)).filter((x) => x && typeof x === 'object'));
  if (s.oneOf?.length || s.anyOf?.length) return exampleOf((s.oneOf ?? s.anyOf)![0], doc, depth + 1);
  switch (s.type) {
    case 'object':
    case undefined:
      if (!s.properties) return s.type ? {} : null;
      return Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, exampleOf(v, doc, depth + 1)]));
    case 'array':
      return [exampleOf(s.items, doc, depth + 1)];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return s.format === 'date-time' ? new Date(0).toISOString() : s.format === 'email' ? 'user@example.com' : 'string';
  }
}

/** A schema with its $ref followed and its allOf parts merged (properties and required lists). */
function resolve(s: Schema | undefined, doc: Record<string, unknown>, depth = 0): Schema | undefined {
  if (!s || depth > 6) return s;
  if (s.$ref) return resolve(s.$ref.replace(/^#\//, '').split('/').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc) as Schema, doc, depth + 1);
  if (s.allOf) {
    const parts = s.allOf.map((x) => resolve(x, doc, depth + 1) ?? {});
    return { ...s, allOf: undefined, type: 'object', properties: Object.assign({}, s.properties, ...parts.map((x) => x.properties)), required: [...(s.required ?? []), ...parts.flatMap((x) => x.required ?? [])] };
  }
  return s;
}

const isFile = (s: Schema | undefined, doc: Record<string, unknown>): boolean => {
  const r = resolve(s, doc);
  return !!r && ((r.type === 'string' && (r.format === 'binary' || r.format === 'base64')) || r.type === 'file' || (r.type === 'array' && isFile(r.items, doc)));
};

/**
 * Form fields (urlencoded or multipart) from an object schema: files as file fields. Values come only from the
 * spec's examples / defaults / enums (no "string" placeholders that would be sent); when the schema lists
 * required fields, only those start ticked.
 */
function formFields(schema: Schema | undefined, example: unknown, doc: Record<string, unknown>, files: boolean): KeyValue[] {
  const s = resolve(schema, doc);
  const ex = (example && typeof example === 'object' ? example : {}) as Record<string, unknown>;
  const props = s?.properties ?? {};
  const required = s?.required ?? [];
  return [...new Set([...Object.keys(props), ...Object.keys(ex)])].map((k) => {
    const p = resolve(props[k], doc);
    const extra = { enabled: !required.length || required.includes(k), ...(p?.description ? { description: p.description } : {}) };
    if (files && isFile(p, doc)) return { key: k, value: '', type: 'file' as const, ...extra };
    const v = ex[k] ?? p?.example ?? p?.default ?? p?.enum?.[0];
    return { key: k, value: v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v), ...(files ? { type: 'text' as const } : {}), ...extra };
  });
}

/** The request body an operation documents: JSON, form (urlencoded), multipart, XML / text; OpenAPI 3 or Swagger 2. */
function openApiBody(op: Record<string, unknown>, params: Record<string, unknown>[], doc: Record<string, unknown>): RequestSpec['body'] {
  type Media = { schema?: Schema; example?: unknown; examples?: Record<string, { value?: unknown }> };
  const content = ((op.requestBody as { content?: Record<string, Media> } | undefined)?.content ?? {}) as Record<string, Media>;
  const types = Object.keys(content);
  const pick = (re: RegExp) => types.find((t) => re.test(t));
  const exampleIn = (m: Media) => m.example ?? Object.values(m.examples ?? {})[0]?.value;
  const json = pick(/json/i);
  if (json) {
    const m = content[json];
    return { mode: 'json', raw: JSON.stringify(exampleIn(m) ?? exampleOf(m.schema, doc), null, 2), fields: [] };
  }
  const multipart = pick(/^multipart\//i);
  if (multipart) return { mode: 'multipart', raw: '', fields: formFields(content[multipart].schema, exampleIn(content[multipart]), doc, true) };
  const form = pick(/x-www-form-urlencoded/i);
  if (form) return { mode: 'form', raw: '', fields: formFields(content[form].schema, exampleIn(content[form]), doc, false) };
  const xml = pick(/xml/i);
  if (xml) return { mode: 'xml', raw: String(exampleIn(content[xml]) ?? ''), fields: [] };
  const text = pick(/^text\//i);
  if (text) return { mode: 'text', raw: String(exampleIn(content[text]) ?? ''), fields: [] };
  if (pick(/octet-stream|^image\/|^application\/pdf/i)) return { ...emptyBody(), mode: 'binary' };

  // Swagger 2: the body is a parameter (in: body), or form fields (in: formData) — multipart when one is a file
  // or the operation consumes multipart/form-data.
  const body = params.find((p) => p.in === 'body');
  if (body) return { mode: 'json', raw: JSON.stringify(exampleOf(body.schema as Schema, doc), null, 2), fields: [] };
  const formData = params.filter((p) => p.in === 'formData');
  if (formData.length) {
    const consumes = [...((op.consumes as string[]) ?? []), ...((doc.consumes as string[]) ?? [])];
    const multi = formData.some((p) => p.type === 'file') || consumes.some((c) => /multipart/i.test(c));
    const fields: KeyValue[] = formData.map((p) => ({
      key: String(p.name),
      value: p.type === 'file' ? '' : String(p.example ?? p.default ?? (p.enum as unknown[] | undefined)?.[0] ?? ''),
      enabled: p.required === true || !formData.some((x) => x.required === true),
      ...(multi ? { type: p.type === 'file' ? ('file' as const) : ('text' as const) } : {}),
      ...(p.description ? { description: String(p.description) } : {}),
    }));
    return { mode: multi ? 'multipart' : 'form', raw: '', fields };
  }
  return emptyBody();
}

/** An operation for the browser: it answers with an HTML page, or only redirects (a form post). */
/**
 * A schema with every $ref replaced by what it points to (#93), so it can be checked without the document. Deeper than
 * 12 levels, or a $ref back into itself, becomes {} (anything goes there).
 */
function inline(s: unknown, doc: Record<string, unknown>, depth = 0, seen: string[] = []): unknown {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map((x) => inline(x, doc, depth + 1, seen));
  const o = s as Record<string, unknown>;
  if (typeof o.$ref === 'string') {
    if (depth > 12 || seen.includes(o.$ref) || !o.$ref.startsWith('#/')) return {};
    const target = o.$ref.slice(2).split('/').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return inline(target, doc, depth + 1, [...seen, o.$ref]);
  }
  if (depth > 12) return {};
  // Only what a check reads: documentation (description, example, xml …) stays out.
  const keep = ['type', 'nullable', 'properties', 'required', 'items', 'enum', 'const', 'additionalProperties', 'allOf', 'oneOf', 'anyOf', 'format', 'example', 'default'];
  // Values (example, default, enum, const) are data, not schemas: kept as they are.
  const data = ['example', 'default', 'enum', 'const'];
  return Object.fromEntries(Object.entries(o).filter(([k]) => keep.includes(k)).map(([k, v]) => [k, data.includes(k) ? v : k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, inline(pv, doc, depth + 1, seen)])) : inline(v, doc, depth + 1, seen)]));
}

/** An object with its $ref followed (one level: an example in components/examples). */
function follow(o: unknown, doc: Record<string, unknown>): unknown {
  const ref = (o as { $ref?: unknown } | undefined)?.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return o;
  return ref.slice(2).split('/').reduce<unknown>((x, k) => (x as Record<string, unknown>)?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
}

/** The responses an operation describes (#93): OpenAPI 3 `content`, or Swagger 2 `schema` with `produces`. */
function specResponses(op: Record<string, unknown>, doc: Record<string, unknown>): SpecResponse[] {
  const produces = ((op.produces ?? doc.produces) as string[] | undefined) ?? [];
  return Object.entries((op.responses ?? {}) as Record<string, Record<string, unknown>>).map(([status, r0]) => {
    const r = follow(r0, doc) as Record<string, unknown> | undefined;
    const content = (r?.content ?? null) as Record<string, { schema?: unknown }> | null;
    const types = content ? Object.keys(content) : r?.schema ? produces : [];
    const raw = content ? (Object.entries(content).find(([t]) => /json/i.test(t))?.[1]?.schema ?? Object.values(content)[0]?.schema) : r?.schema;
    let schema = raw ? (inline(raw, doc) as Record<string, unknown>) : undefined;
    // A schema too big to keep next to every request is left out: the status and content type are still checked.
    if (schema && JSON.stringify(schema).length > 200_000) schema = undefined;
    // The spec's own example body (#94, the mock's answer): OpenAPI 3 example / the first of examples, Swagger 2 examples.
    const media = content ? (Object.entries(content).find(([t]) => /json/i.test(t))?.[1] ?? Object.values(content)[0]) : undefined;
    const examples = (media as { examples?: Record<string, { value?: unknown }> } | undefined)?.examples;
    const first = examples ? (follow(Object.values(examples)[0], doc) as { value?: unknown } | undefined) : undefined;
    const ex0 = media && 'example' in (media as object) ? (media as { example: unknown }).example : first ? first.value : (r?.examples as Record<string, unknown> | undefined)?.[types.find((t) => /json/i.test(t)) ?? types[0] ?? ''];
    const example = ex0 !== undefined && (JSON.stringify(ex0)?.length ?? 0) <= 100_000 ? ex0 : undefined;
    return { status: String(status).toUpperCase(), types, ...(schema ? { schema } : {}), ...(example !== undefined ? { example } : {}) };
  });
}

function isWebOp(op: Record<string, unknown>): boolean {
  const responses = Object.entries((op.responses ?? {}) as Record<string, { content?: Record<string, unknown> }>);
  if (!responses.length) return false;
  const types = responses.flatMap(([, r]) => Object.keys(r?.content ?? {}));
  const produces = (op.produces as string[] | undefined) ?? [];
  if ([...types, ...produces].some((t) => /json|xml/i.test(t))) return false;
  if ([...types, ...produces].some((t) => /text\/html/i.test(t))) return true;
  return responses.every(([code]) => /^3/.test(code));
}

/**
 * How the API says it is called (OpenAPI 3 components.securitySchemes, Swagger 2 securityDefinitions): the scheme the
 * document asks for everywhere (its top-level `security`), or its only one. Secrets become {{variables}} the user fills
 * in. OpenID Connect and the implicit flow have no counterpart here and are left out.
 */
export function openApiAuth(doc: Record<string, unknown>, base: string): RequestAuth | null {
  const schemes = ((doc.components as { securitySchemes?: Record<string, Record<string, unknown>> } | undefined)?.securitySchemes ?? doc.securityDefinitions ?? {}) as Record<string, Record<string, unknown>>;
  const names = Object.keys(schemes);
  if (!names.length) return null;
  const asked = (Array.isArray(doc.security) ? doc.security : []).flatMap((r) => Object.entries((r ?? {}) as Record<string, unknown>));
  const [name, scopesAsked] = asked.find(([n]) => schemes[n]) ?? (names.length === 1 ? [names[0], undefined] : []);
  const sc = name ? (follow(schemes[name], doc) as Record<string, unknown>) : null;
  if (!sc) return null;
  const abs = (u: unknown) => {
    if (typeof u !== 'string' || !u) return '';
    try {
      return new URL(u, base || undefined).toString();
    } catch {
      return u;
    }
  };
  const type = String(sc.type ?? '').toLowerCase();
  if (type === 'http' && String(sc.scheme ?? '').toLowerCase() === 'bearer') return { mode: 'bearer', token: '{{token}}' };
  if ((type === 'http' && String(sc.scheme ?? '').toLowerCase() === 'basic') || type === 'basic') return { mode: 'basic', username: '{{username}}', password: '{{password}}' };
  if (type === 'apikey' && (sc.in === 'header' || sc.in === 'query') && sc.name) return { mode: 'apikey', key: String(sc.name), value: '{{apiKey}}', in: sc.in };
  if (type !== 'oauth2') return null;
  // OpenAPI 3: flows.{authorizationCode, clientCredentials, password}; Swagger 2: flow accessCode / application / password.
  const flows = (sc.flows ?? {}) as Record<string, Record<string, unknown>>;
  const v2 = typeof sc.flow === 'string' ? sc.flow : '';
  const pick = (v3: string, old: string) => flows[v3] ?? (v2 === old ? sc : undefined);
  const code = pick('authorizationCode', 'accessCode');
  const client = pick('clientCredentials', 'application');
  const password = pick('password', 'password');
  const flow = code ?? client ?? password;
  if (!flow) return null;
  const scopes = Array.isArray(scopesAsked) && scopesAsked.length ? (scopesAsked as unknown[]).map(String) : Object.keys((flow.scopes ?? {}) as Record<string, unknown>);
  return {
    mode: 'oauth2',
    oauth2: {
      grant: code ? 'authorization_code' : client ? 'client_credentials' : 'password',
      tokenUrl: abs(flow.tokenUrl),
      clientId: '{{clientId}}',
      clientSecret: '{{clientSecret}}',
      ...(scopes.length ? { scope: scopes.join(' ') } : {}),
      ...(code ? { authUrl: abs(flow.authorizationUrl) } : {}),
      ...(!code && !client ? { username: '{{username}}', password: '{{password}}' } : {}),
    },
  };
}

function fromOpenApi(doc: Record<string, unknown>): { root: TreeItem; items: TreeItem[]; baseUrl?: string } {
  const info = (doc.info ?? {}) as { title?: string; description?: string };
  const servers = doc.servers as { url: string }[] | undefined;
  const swaggerBase = doc.host ? `${(doc.schemes as string[] | undefined)?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}` : '';
  const base = servers?.[0]?.url ?? swaggerBase;
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: info.title || 'API', sort: 0, auth: openApiAuth(doc, base) ?? { mode: 'none' }, description: [info.description, base ? `Base URL: ${base} (variable {{baseUrl}})` : ''].filter(Boolean).join('\n\n') };
  const items: TreeItem[] = [];
  const ops = Object.entries((doc.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>).flatMap(([path, o]) =>
    Object.entries(o)
      .filter(([m]) => (HTTP_METHODS as readonly string[]).includes(m.toUpperCase()))
      .map(([m, op]) => ({ path, m, op, pathParams: (o.parameters as unknown as Record<string, unknown>[]) ?? [] })),
  );
  // Pages for the browser (HTML or only redirects) go in a "web" folder, the rest in "api" — only when there are both.
  const kinds = ops.map((x) => (isWebOp(x.op) ? 'web' : 'api'));
  const split = kinds.includes('web') && kinds.includes('api');
  const folders = new Map<string, string>();
  const folderFor = (key: string, name: string, parentId: string, sort?: number): string => {
    if (!folders.has(key)) {
      const f: TreeItem = { id: uid('f_'), kind: 'folder', parentId, name, sort: sort ?? [...folders.keys()].filter((k) => k.startsWith(parentId)).length, auth: { mode: 'inherit' } };
      folders.set(key, f.id);
      items.push(f);
    }
    return folders.get(key)!;
  };
  // Without tags, a long list is grouped by its first path segment (past /api and /v1).
  const grouped = ops.length > 12;
  let n = 0;
  for (const [idx, { path, m, op, pathParams }] of ops.entries()) {
    const top = split ? folderFor(`${root.id}:${kinds[idx]}`, kinds[idx], root.id, kinds[idx] === 'api' ? 0 : 1) : root.id;
    const segment = path.split('/').filter((x) => x && !/^(api|v\d+)$/i.test(x) && !x.startsWith('{'))[0];
    const group = (op.tags as string[] | undefined)?.[0] ?? (grouped ? segment : undefined);
    const parentId = group ? folderFor(`${top}:${group}`, group, top) : top;
    const params = [...pathParams, ...((op.parameters as Record<string, unknown>[]) ?? [])];
    const query: KeyValue[] = params.filter((p) => p.in === 'query').map((p) => ({ key: String(p.name), value: String((p.example ?? (p.schema as Schema)?.example ?? '') as string), enabled: p.required === true, description: p.description as string | undefined }));
    const headers: KeyValue[] = params.filter((p) => p.in === 'header').map((p) => ({ key: String(p.name), value: '', enabled: p.required === true }));
    const urlPath = path.replace(/\{([^}]+)\}/g, ':$1');
    const spec: RequestSpec = { ...newRequest(), method: method(m), url: joinUrl(`{{baseUrl}}${urlPath}`, query), params: query, headers };
    spec.body = openApiBody(op, params, doc);
    // `security: []` on an operation: open to everyone, whatever the collection logs in with.
    if (Array.isArray(op.security) && !op.security.length && root.auth?.mode !== 'none') spec.auth = { mode: 'none' };
    const responses = specResponses(op, doc);
    items.push({ id: uid('r_'), kind: 'request', parentId, name: String(op.summary ?? op.operationId ?? `${m.toUpperCase()} ${path}`).slice(0, 200), sort: n++, request: spec, description: op.description as string | undefined, ...(responses.length ? { specResponses: responses } : {}) });
  }
  return { root, items, baseUrl: base || undefined };
}

// ------------------------------------------------------------------ entry

/** Fresh ids for an imported DialCatz export, parents remapped. */
function fromDialCatz(doc: DialCatzExport): { root: TreeItem; items: TreeItem[] } {
  const map = new Map<string, string>();
  const fresh = (i: TreeItem) => {
    const id = uid(i.kind === 'collection' ? 'c_' : i.kind === 'folder' ? 'f_' : 'r_');
    map.set(i.id, id);
    return id;
  };
  const root = { ...strip(doc.collection), id: fresh(doc.collection), parentId: null };
  for (const i of doc.items) fresh(i);
  const items = doc.items.map((i) => ({ ...strip(i), id: map.get(i.id)!, parentId: map.get(i.parentId ?? '') ?? root.id }));
  return { root, items };
}

export function importText(text: string): { root: TreeItem; items: TreeItem[]; baseUrl?: string; variables?: EnvVariable[]; openapi?: boolean } {
  const trimmed = text.trim();
  if (trimmed.startsWith('curl')) {
    const spec = parseCurl(trimmed);
    if (!spec) throw new Error('That cURL command has no URL');
    const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: 'Imported from cURL', sort: 0, auth: { mode: 'none' } };
    return { root, items: [{ id: uid('r_'), kind: 'request', parentId: root.id, name: 'Request', sort: 0, request: spec }] };
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    try {
      // YAML (OpenAPI / Swagger are often written in it); aliases capped against "billion laughs" files.
      doc = parseYaml(trimmed, { maxAliasCount: 200 }) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Neither JSON nor YAML: ${(e as Error).message.split('\n')[0]}`);
    }
    if (!doc || typeof doc !== 'object') throw new Error('Not a format DialCatz knows (Postman v2 collection, OpenAPI 3 / Swagger 2 in JSON or YAML, DialCatz export, cURL)');
  }
  if (doc.dialcatz === 1) return fromDialCatz(doc as unknown as DialCatzExport);
  if (typeof doc.openapi === 'string' || typeof doc.swagger === 'string') return { ...fromOpenApi(doc), openapi: true };
  if (doc.info && Array.isArray(doc.item)) return fromPostman(doc);
  throw new Error('Not a format DialCatz knows (Postman v2 collection, OpenAPI 3 / Swagger 2, DialCatz export)');
}

// ------------------------------------------------------------------ copy a collection to another workspace

export type CopyMode = 'new' | 'replace' | 'merge';

/**
 * Items to write into the target workspace for a copied collection (and ids to delete first).
 *   new      a fresh copy (new ids) under `name`
 *   replace  the target's collection of the same name is deleted and the copy takes its place (and its position)
 *   merge    folders and requests are matched by their path of names: matching requests are updated in place
 *            (their ids kept, so open tabs and team history follow), missing ones added, the rest left alone
 */
export function copyPlan(target: TreeItem[], data: DialCatzExport, mode: CopyMode, name: string): { save: TreeItem[]; remove: string[]; collectionId: string } {
  const existing = target.find((i) => i.kind === 'collection' && i.name === data.collection.name);
  const rootSort = target.filter((i) => i.kind === 'collection').length;
  if (mode === 'merge' && existing) {
    const save: TreeItem[] = [{ ...existing, auth: data.collection.auth, description: data.collection.description }];
    const walk = (srcParent: string, dstParent: string) => {
      const kids = data.items.filter((i) => i.parentId === srcParent).sort((a, b) => a.sort - b.sort);
      for (const k of kids) {
        const pool = [...target, ...save].filter((t) => t.parentId === dstParent);
        const match = pool.find((t) => t.kind === k.kind && t.name === k.name);
        const id = match?.id ?? uid(k.kind === 'folder' ? 'f_' : 'r_');
        const sort = match?.sort ?? pool.length;
        const item: TreeItem = { ...strip(k), id, parentId: dstParent, sort };
        const at = save.findIndex((x) => x.id === id);
        if (at >= 0) save[at] = item;
        else save.push(item);
        if (k.kind === 'folder') walk(k.id, id);
      }
    };
    walk(data.collection.id, existing.id);
    return { save, remove: [], collectionId: existing.id };
  }
  const fresh = fromDialCatz(data);
  fresh.root.name = name.trim().slice(0, 200) || data.collection.name;
  if (mode === 'replace' && existing) {
    fresh.root.sort = existing.sort;
    return { save: [fresh.root, ...fresh.items], remove: [existing.id], collectionId: fresh.root.id };
  }
  fresh.root.sort = rootSort;
  return { save: [fresh.root, ...fresh.items], remove: [], collectionId: fresh.root.id };
}

/** An OpenAPI 3 / Swagger 2 document (JSON or YAML) as a collection; anything else is an error (#92). */
export function importSpec(text: string): { root: TreeItem; items: TreeItem[]; baseUrl?: string } {
  if (/^\s*curl\b/.test(text)) throw new Error('Not an OpenAPI or Swagger document');
  const r = importText(text);
  if (!r.openapi) throw new Error('Not an OpenAPI or Swagger document');
  return r;
}
