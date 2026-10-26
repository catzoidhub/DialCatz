import { emptyBody, HTTP_METHODS, newRequest, uid, type HttpMethod, type KeyValue, type RequestAuth, type RequestSpec, type TreeItem } from '@shared/types';
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

function fromPostman(doc: Record<string, unknown>): { root: TreeItem; items: TreeItem[] } {
  const info = doc.info as { name?: string; description?: string } | undefined;
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: info?.name || 'Imported collection', sort: 0, auth: pmAuth(doc.auth as PmAuth), description: typeof info?.description === 'string' ? info.description : undefined };
  if (root.auth?.mode === 'inherit') root.auth = { mode: 'none' };
  const items: TreeItem[] = [];
  const walk = (list: unknown, parentId: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((it: Record<string, unknown>, n) => {
      if (Array.isArray(it.item)) {
        const f: TreeItem = { id: uid('f_'), kind: 'folder', parentId, name: String(it.name ?? 'Folder'), sort: n, auth: pmAuth(it.auth as PmAuth) };
        items.push(f);
        walk(it.item, f.id);
      } else if (it.request) {
        items.push({ id: uid('r_'), kind: 'request', parentId, name: String(it.name ?? 'Request'), sort: n, request: pmRequest(it.request as Record<string, unknown>) });
      }
    });
  };
  walk(doc.item, root.id);
  return { root, items };
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
function isWebOp(op: Record<string, unknown>): boolean {
  const responses = Object.entries((op.responses ?? {}) as Record<string, { content?: Record<string, unknown> }>);
  if (!responses.length) return false;
  const types = responses.flatMap(([, r]) => Object.keys(r?.content ?? {}));
  const produces = (op.produces as string[] | undefined) ?? [];
  if ([...types, ...produces].some((t) => /json|xml/i.test(t))) return false;
  if ([...types, ...produces].some((t) => /text\/html/i.test(t))) return true;
  return responses.every(([code]) => /^3/.test(code));
}

function fromOpenApi(doc: Record<string, unknown>): { root: TreeItem; items: TreeItem[]; baseUrl?: string } {
  const info = (doc.info ?? {}) as { title?: string; description?: string };
  const servers = doc.servers as { url: string }[] | undefined;
  const swaggerBase = doc.host ? `${(doc.schemes as string[] | undefined)?.[0] ?? 'https'}://${doc.host}${doc.basePath ?? ''}` : '';
  const base = servers?.[0]?.url ?? swaggerBase;
  const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name: info.title || 'API', sort: 0, auth: { mode: 'none' }, description: [info.description, base ? `Base URL: ${base} (variable {{baseUrl}})` : ''].filter(Boolean).join('\n\n') };
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
    items.push({ id: uid('r_'), kind: 'request', parentId, name: String(op.summary ?? op.operationId ?? `${m.toUpperCase()} ${path}`).slice(0, 200), sort: n++, request: spec, description: op.description as string | undefined });
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

export function importText(text: string): { root: TreeItem; items: TreeItem[]; baseUrl?: string } {
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
  if (typeof doc.openapi === 'string' || typeof doc.swagger === 'string') return fromOpenApi(doc);
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
