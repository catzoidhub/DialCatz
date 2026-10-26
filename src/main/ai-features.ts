import { HTTP_METHODS, type AskAction, type AskAnswer, type AskContext, type AiTurn, type ExplainAnswer, type HttpMethod } from '@shared/types';
import { AiClient } from './ai';
import { needFeature } from './settings';
import * as dbcatz from './dbcatz';

/**
 * DialCatz's AI features, on the shared connection (ai.ts). What goes out is kept small and without secrets:
 * request names, methods and URLs, header names, variable NAMES (never values); Authorization, cookies and
 * key-looking header values are masked, bodies clipped. DBCatz connections go as names, engines, hosts and
 * database names (DBCatz's bridge.json has no passwords). Answers are proposals: nothing is sent, saved or changed
 * until the user clicks it.
 */

const BODY_CLIP = 12_000;
const client = new AiClient();
const running = new Map<string, AbortController>();

export const models = (p: Parameters<AiClient['models']>[0]) => client.models(p);
export const test = () => client.test();
export function cancel(token: string): void {
  running.get(token)?.abort();
}

async function run<T>(token: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  running.set(token, ctl);
  try {
    return await fn(ctl.signal);
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('Stopped');
    throw e;
  } finally {
    if (running.get(token) === ctl) running.delete(token);
  }
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const SECRETISH = /(token|secret|key|password|session)/i;
/** Header lines for the model, secrets masked. */
function headersText(h: [string, string][]): string {
  return h.map(([k, v]) => `${k}: ${SECRET_HEADER.test(k) || SECRETISH.test(k) ? `${v.split(/\s+/)[0].length < v.length && /^(bearer|basic|token)$/i.test(v.split(/\s+/)[0]) ? `${v.split(/\s+/)[0]} ` : ''}••••` : v.slice(0, 300)}`).join('\n');
}
/** Long opaque strings (JWTs, keys) inside a body, shortened so they do not go out whole. */
function maskTokens(text: string): string {
  return text.replace(/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, 'eyJ…(JWT masked)').replace(/\b(sk|pk|ghp|gho|xox[abp]|dct|AKIA)[-_A-Za-z0-9]{12,}\b/g, (m) => `${m.slice(0, 6)}…(masked)`);
}
const clip = (s: string, n = BODY_CLIP) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters not sent)` : s);
const str = (v: unknown, n = 2000) => String(v ?? '').slice(0, n);

// ------------------------------------------------------------------ Ask DialCatz

const ASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'actions'],
  properties: {
    reply: { type: 'string', description: 'A short answer to the user, in their language.' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'name', 'method', 'url', 'headers', 'bodyMode', 'body', 'collectionId', 'collectionName', 'itemId', 'key', 'value', 'secret', 'variables', 'conn', 'db', 'table', 'col', 'val', 'target', 'group', 'ids', 'names'],
        properties: {
          type: { type: 'string', enum: ['createRequest', 'openRequest', 'setVariable', 'openInDbcatz', 'createCollection', 'createFolder', 'createEnvironment', 'groupItems'] },
          target: { type: 'string', enum: ['collections', 'environments', ''], description: 'For groupItems.' },
          group: { type: 'string', description: 'For groupItems: the group name (an existing one, or a new one to make).' },
          ids: { type: 'array', items: { type: 'string' }, description: 'For groupItems: ids of existing collections / environments.' },
          names: { type: 'array', items: { type: 'string' }, description: 'For groupItems: names of collections / environments created in this same answer.' },
          name: { type: 'string' },
          method: { type: 'string', enum: [...HTTP_METHODS, ''] },
          url: { type: 'string' },
          headers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } },
          bodyMode: { type: 'string', enum: ['none', 'json', 'text', 'form'] },
          body: { type: 'string' },
          collectionId: { type: 'string', description: 'For createRequest / createFolder: the id of an existing collection to put it in, or "".' },
          collectionName: { type: 'string', description: 'For createRequest / createFolder: the name of a collection created by a createCollection step in this same answer, or "".' },
          variables: { type: 'array', description: 'For createEnvironment.', items: { type: 'object', additionalProperties: false, required: ['key', 'value', 'secret'], properties: { key: { type: 'string' }, value: { type: 'string' }, secret: { type: 'boolean' } } } },
          itemId: { type: 'string', description: 'For openRequest: the id of an existing request.' },
          key: { type: 'string', description: 'For setVariable.' },
          value: { type: 'string', description: 'For setVariable: only a value the user gave; "" otherwise.' },
          secret: { type: 'boolean' },
          conn: { type: 'string', description: 'For openInDbcatz: a DBCatz connection id from the list, or "" when DBCatz is not installed.' },
          db: { type: 'string', description: 'For openInDbcatz: the database name ("" for the connection\'s default).' },
          table: { type: 'string', description: 'For openInDbcatz: the table (a key for Redis, a collection for MongoDB, an index for Elasticsearch).' },
          col: { type: 'string', description: 'For openInDbcatz: a column to show one row by (e.g. "id"), or "".' },
          val: { type: 'string', description: 'For openInDbcatz: that column\'s value (e.g. "42"), or "".' },
        },
      },
    },
  },
};

type DbInfo = ReturnType<typeof dbcatzInfo>;
function dbcatzInfo() {
  try {
    return { installed: dbcatz.installed(), ...dbcatz.connections() };
  } catch {
    return { installed: false, bridge: false, connections: [] };
  }
}
function dbText(d: DbInfo, c: AskContext): string {
  const head = !d.installed
    ? 'DBCatz (the database viewer of the same family) is NOT installed: when the user wants to look at a database, propose openInDbcatz with conn "" — its button offers to install DBCatz.'
    : !d.bridge
      ? 'DBCatz is installed but too old to share its connections: say the user should update DBCatz; do not propose openInDbcatz.'
      : `DBCatz connections (id — name · engine · host · default database):\n${d.connections.slice(0, 60).map((x) => `  - [${x.id}] ${str(x.name, 80)} · ${x.engine}${x.host ? ` · ${str(x.host, 80)}${x.port ? `:${x.port}` : ''}` : ''}${x.database ? ` · ${str(x.database, 80)}` : ''}${x.source === 'devcatz' ? ' (DevCatz service)' : ''}`).join('\n') || '  none saved yet: tell the user to add the database in DBCatz first.'}`;
  const o = c.open;
  if (!o) return head;
  const db = o.database ? `The open request's collection checks in DBCatz connection [${str(o.database.conn, 200)}], database "${str(o.database.db, 128)}".` : "The open request's collection has no DBCatz database set yet.";
  const t = o.table ? `The table its last call${o.status ? ` (status ${o.status})` : ''} most likely touched: ${str(o.table.name, 128)}${o.table.col && o.table.val ? `, row ${str(o.table.col, 64)} = ${str(o.table.val, 200)}` : ''}.` : '';
  return [head, db, t].filter(Boolean).join('\n');
}

function askSystem(c: AskContext, d: DbInfo): string {
  const cols = c.collections
    .slice(0, 40)
    .map((col) => `Collection "${str(col.name, 120)}" (id ${col.id})\n${col.requests.slice(0, 120).map((r) => `  - [${r.id}] ${r.method} ${str(r.url, 200)} — ${str(r.name, 120)}${r.folder ? ` (folder ${str(r.folder, 80)})` : ''}`).join('\n')}`)
    .join('\n');
  return `You are Ask DialCatz, the assistant inside DialCatz, an API client (like Postman). You help the user with HTTP requests: you answer questions and propose steps the user can apply with one click each.

Steps you can propose (each becomes a button; nothing runs on its own):
- createRequest: a new request (name, method, url, headers, bodyMode none|json|text|form, body; form bodies as "a=1&b=2"), in the collection with collectionId (or "" for a scratch tab). Use {{variable}} placeholders for hosts, tokens and ids, preferring the variables that exist (listed below), e.g. {{baseUrl}}/users.
- openRequest: open an existing request by its id.
- setVariable: add a variable to the active environment. Only put a value the user actually gave; otherwise value "" so they fill it in. Mark tokens, keys and passwords secret.
- createCollection: a new collection (name; body = a short description, or ""). To fill it in the same answer, give later createRequest / createFolder steps its name in collectionName (and collectionId "").
- createFolder: a folder (name) in an existing collection (collectionId) or in one created in this answer (collectionName).
- createEnvironment: a new environment (name) with variables; values only when the user gave them ("" otherwise), tokens, keys and passwords secret.
- groupItems: put collections or environments (target) into a sidebar group (group name; made when it does not exist): existing ones by id (ids), ones created in this answer by name (names). Groups only arrange the sidebar on this computer.
- openInDbcatz: open a table in DBCatz, read-only, when the user wants to check the database ("is the user saved?", "show the orders table", "check the database"): conn from the DBCatz connections below, db, table, and col + val for one row (e.g. id = 42) or "" for the whole table. For the open request, prefer its collection's connection and database and the table its last call touched.

Rules: never invent request ids, collection ids or DBCatz connection ids that are not listed. Keep replies short and practical. If the user only asks a question, answer it with no steps. Fill every field of every step (use "" or false where it does not apply).

Workspace: "${str(c.workspace, 120)}"
Active environment: ${c.environment ? `"${str(c.environment, 120)}"` : 'none'}
Variables (names only): ${c.variables.slice(0, 200).map((v) => str(v, 80)).join(', ') || 'none'}
${cols || 'No collections yet.'}
Environments: ${c.environments.slice(0, 80).map((e) => `[${e.id}] ${str(e.name, 80)}`).join(', ') || 'none'}
Collection groups: ${c.groups.collections.slice(0, 40).map((g) => `"${str(g.name, 80)}" (${g.items.slice(0, 40).map((n) => str(n, 80)).join(', ') || 'empty'})`).join('; ') || 'none'}
Environment groups: ${c.groups.environments.slice(0, 40).map((g) => `"${str(g.name, 80)}" (${g.items.slice(0, 40).map((n) => str(n, 80)).join(', ') || 'empty'})`).join('; ') || 'none'}
${c.open ? `\nThe request open now: ${c.open.method} ${str(c.open.url, 400)} — "${str(c.open.name, 120)}"\nHeaders (names): ${c.open.headers.slice(0, 40).join(', ') || 'none'}${c.open.body ? `\nBody:\n${clip(maskTokens(c.open.body), 4000)}` : ''}` : ''}

${dbText(d, c)}`;
}

const plainText = (v: unknown, n: number) => {
  const t = str(v, n).trim();
  return /[\u0000-\u001f\u007f]/.test(t) ? '' : t;
};

function cleanActions(raw: unknown, c: AskContext, d: DbInfo): AskAction[] {
  if (!Array.isArray(raw)) return [];
  const requestIds = new Set(c.collections.flatMap((col) => col.requests.map((r) => r.id)));
  const colIds = new Set(c.collections.map((col) => col.id));
  const out: AskAction[] = [];
  // Collections this answer creates, so its requests and folders can go into them.
  const created = new Set((raw as Record<string, unknown>[]).filter((a) => a?.type === 'createCollection').map((a) => plainText(a.name, 120)).filter(Boolean));
  const newCollection = (name: string) => (created.has(plainText(name, 120)) ? plainText(name, 120) : '');
  for (const a of raw.slice(0, 24) as Record<string, unknown>[]) {
    if (a.type === 'createRequest') {
      const method = (HTTP_METHODS as readonly string[]).includes(String(a.method)) ? (a.method as HttpMethod) : 'GET';
      out.push({
        type: 'createRequest',
        name: str(a.name, 120) || `${method} request`,
        method,
        url: str(a.url, 2000),
        headers: Array.isArray(a.headers) ? (a.headers as { key: unknown; value: unknown }[]).slice(0, 30).map((h) => ({ key: str(h.key, 200), value: str(h.value, 2000) })).filter((h) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(h.key)) : [],
        bodyMode: ['json', 'text', 'form'].includes(String(a.bodyMode)) ? (a.bodyMode as 'json' | 'text' | 'form') : 'none',
        body: str(a.body, 20_000),
        collectionId: colIds.has(String(a.collectionId)) ? String(a.collectionId) : null,
        ...(!colIds.has(String(a.collectionId)) && newCollection(String(a.collectionName)) ? { collectionName: newCollection(String(a.collectionName)) } : {}),
      });
    } else if (a.type === 'openRequest' && requestIds.has(String(a.itemId))) {
      out.push({ type: 'openRequest', itemId: String(a.itemId), name: str(a.name, 120) });
    } else if (a.type === 'setVariable' && /^[\w.$-]{1,100}$/.test(String(a.key))) {
      out.push({ type: 'setVariable', key: String(a.key), value: str(a.value, 2000), secret: a.secret === true });
    } else if (a.type === 'createCollection' && plainText(a.name, 120)) {
      out.push({ type: 'createCollection', name: plainText(a.name, 120), description: str(a.body, 4000) });
    } else if (a.type === 'createFolder' && plainText(a.name, 120)) {
      const colId = colIds.has(String(a.collectionId)) ? String(a.collectionId) : null;
      const colName = colId ? '' : newCollection(String(a.collectionName));
      if (colId || colName) out.push({ type: 'createFolder', name: plainText(a.name, 120), collectionId: colId, collectionName: colName });
    } else if (a.type === 'createEnvironment' && plainText(a.name, 120)) {
      const vars = Array.isArray(a.variables) ? (a.variables as { key: unknown; value: unknown; secret: unknown }[]).slice(0, 100).filter((v) => /^[\w.$-]{1,100}$/.test(String(v.key))).map((v) => ({ key: String(v.key), value: str(v.value, 2000), secret: v.secret === true })) : [];
      out.push({ type: 'createEnvironment', name: plainText(a.name, 120), variables: vars });
    } else if (a.type === 'groupItems' && (a.target === 'collections' || a.target === 'environments') && plainText(a.group, 120)) {
      const known = new Set(a.target === 'collections' ? c.collections.map((x) => x.id) : c.environments.map((x) => x.id));
      const createdHere = new Set((raw as Record<string, unknown>[]).filter((x) => x?.type === (a.target === 'collections' ? 'createCollection' : 'createEnvironment')).map((x) => plainText(x.name, 120)));
      const ids = Array.isArray(a.ids) ? [...new Set((a.ids as unknown[]).map(String).filter((id) => known.has(id)))] : [];
      const names = Array.isArray(a.names) ? [...new Set((a.names as unknown[]).map((n) => plainText(n, 120)).filter((n) => createdHere.has(n)))] : [];
      if (ids.length || names.length) out.push({ type: 'groupItems', target: a.target, group: plainText(a.group, 120), ids, names });
    } else if (a.type === 'openInDbcatz') {
      // Only a listed connection (or none at all when DBCatz is missing, for its install button).
      const conn = d.installed ? d.connections.find((x) => x.id === String(a.conn)) : null;
      if (d.installed && !conn) continue;
      // Without DBCatz one "Get DBCatz" step is enough.
      if (!d.installed && out.some((x) => x.type === 'openInDbcatz')) continue;
      const table = plainText(a.table, 128);
      const col = /^[A-Za-z_][\w$]{0,63}$/.test(String(a.col)) ? String(a.col) : '';
      const val = col ? plainText(a.val, 200) : '';
      out.push({ type: 'openInDbcatz', conn: conn?.id ?? '', connName: conn?.name ?? '', db: plainText(a.db, 128), table, col: val ? col : '', val });
    }
  }
  return out;
}

export async function ask(prompt: string, history: AiTurn[], context: AskContext, token: string): Promise<AskAnswer> {
  needFeature('ask');
  if (!prompt.trim()) throw new Error('Say what you need');
  const turns: AiTurn[] = [...(history ?? []).slice(-10).map((t) => ({ role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const), text: str(t.text, 6000) })), { role: 'user', text: str(prompt, 6000) }];
  const db = dbcatzInfo();
  const a = await run(token, (signal) => client.complete<{ reply: string; actions: unknown }>(askSystem(context, db), turns, ASK_SCHEMA, { signal }));
  return { reply: str(a.reply, 8000).trim(), actions: cleanActions(a.actions, context, db) };
}

// ------------------------------------------------------------------ explain a response

const EXPLAIN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'cause', 'fixes'],
  properties: { summary: { type: 'string' }, cause: { type: 'string', description: 'The likely cause when it failed; "" when it did not.' }, fixes: { type: 'array', items: { type: 'string' } } },
};

export async function explain(wire: { method: string; url: string; headers: [string, string][] }, res: { status: number; statusText: string; headers: [string, string][]; body: string; time: number }, token: string): Promise<ExplainAnswer> {
  needFeature('explain');
  const system = 'You explain HTTP responses to developers using DialCatz, an API client. Say in plain words what the response means; when it failed (4xx, 5xx, an error body), the most likely cause and concrete things to try (headers, auth, body shape, URL). Short, specific to this response, in the language of any text the user wrote, else English. Secrets in the data are masked on purpose: do not mention the masking.';
  const text = `Request: ${str(wire.method, 20)} ${str(wire.url, 2000)}\n${headersText(wire.headers)}\n\nResponse: ${res.status} ${str(res.statusText, 100)} in ${res.time} ms\n${headersText(res.headers)}\n\n${clip(maskTokens(res.body))}`;
  const a = await run(token, (signal) => client.complete<ExplainAnswer>(system, [{ role: 'user', text }], EXPLAIN_SCHEMA, { signal }));
  return { summary: str(a.summary, 6000), cause: str(a.cause, 4000), fixes: Array.isArray(a.fixes) ? a.fixes.slice(0, 8).map((f) => str(f, 1000)) : [] };
}

// ------------------------------------------------------------------ write tests

const TESTS_SCHEMA = { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string' } } };

export async function tests(wire: { method: string; url: string }, res: { status: number; headers: [string, string][]; body: string; time: number }, current: string, token: string): Promise<string> {
  needFeature('tests');
  const system = `You write DialCatz test scripts (JavaScript, run after the response in a sandbox). The API:
dc.test(name, () => { ... }) — one test; dc.expect(value) with toBe, toEqual, toBeTruthy, toBeFalsy, toBeDefined, toBeNull, toContain, toMatch, toBeGreaterThan, toBeLessThan, toHaveProperty(path[, value]), toHaveLength, and .not;
dc.response.status, .statusText, .headers (lowercase names), .body, .json(), .time (ms), .header(name);
dc.env.set(name, value) to save a value (a token, an id) for later requests; dc.log(...).
No network, no require/import, no async. Write 3–8 useful tests: status, timing under a sensible limit, content type, the important fields and their types from the sample body; save obvious tokens / ids with dc.env.set. Keep the user's existing script and add to it unless it already covers something.`;
  const text = `Request: ${str(wire.method, 20)} ${str(wire.url, 2000)}\nResponse: ${res.status} in ${res.time} ms\n${headersText(res.headers)}\n\n${clip(maskTokens(res.body), 8000)}\n\nCurrent script:\n${str(current, 8000) || '(empty)'}`;
  const a = await run(token, (signal) => client.complete<{ code: string }>(system, [{ role: 'user', text }], TESTS_SCHEMA, { signal }));
  return str(a.code, 20_000).trim();
}

// ------------------------------------------------------------------ generate a body

const BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'body', 'fields'],
  properties: {
    mode: { type: 'string', enum: ['json', 'text', 'xml', 'form'] },
    body: { type: 'string', description: 'json / text / xml: the body text. "" for form.' },
    fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } },
  },
};

export async function body(req: { method: string; url: string; bodyMode: string; body: string }, instruction: string, token: string): Promise<{ mode: 'json' | 'text' | 'xml' | 'form'; body: string; fields: { key: string; value: string }[] }> {
  needFeature('body');
  const system = 'You write request bodies for DialCatz, an API client. From the request and what the user asks, give a realistic body (fake but plausible data, no real personal data). Keep the current body mode unless the user asks for another; JSON pretty-printed with 2 spaces. {{variables}} may stay where the user uses them. Fill every field ("" / [] where it does not apply).';
  const text = `Request: ${str(req.method, 20)} ${str(req.url, 2000)}\nBody mode now: ${str(req.bodyMode, 20)}\nCurrent body:\n${clip(maskTokens(str(req.body, 20_000)), 6000) || '(empty)'}\n\nWhat the user wants: ${str(instruction, 2000)}`;
  const a = await run(token, (signal) => client.complete<{ mode: string; body: string; fields: { key: string; value: string }[] }>(system, [{ role: 'user', text }], BODY_SCHEMA, { signal }));
  const mode = (['json', 'text', 'xml', 'form'].includes(a.mode) ? a.mode : 'json') as 'json' | 'text' | 'xml' | 'form';
  return { mode, body: str(a.body, 50_000), fields: Array.isArray(a.fields) ? a.fields.slice(0, 100).map((f) => ({ key: str(f.key, 200), value: str(f.value, 5000) })) : [] };
}
