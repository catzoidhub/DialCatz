import { randomBytes } from 'node:crypto';
import type { OAuthSettings, RequestAuth, RequestSpec, SpecResponse, TreeItem, WireRequest } from '@shared/types';
import { effectiveAuth, interpolate, missingVars, resolveOAuth, toWire, type Vars } from '@shared/request';
import { oauthProblem, readTokenResponse, tokenFresh, tokenIdentity, tokenRequest, type TokenSet } from '@shared/oauth';
import { checkResponse } from '@shared/speccheck';
import { send } from '../src/main/http';
import { runScript, type ScriptContext, type ScriptResult } from './scripts';
import { requestsOf, specFor, specKey } from './plan';

/**
 * One run of the CLI (#101): the requests of a collection in the order the app's runner takes them (sort, then name,
 * folders in place), each the way the Send button does it — pre-request scripts from the collection down, the
 * request, test scripts in the same order, and with --spec the response checked against the contract. Variables a
 * script sets are seen by the requests after it.
 */

export interface RunOptions {
  version: string;
  vars: Vars;
  insecure: boolean;
  timeoutMs: number;
  bail: boolean;
  /** --spec: what the contract says each operation answers, by "METHOD /path/{}". */
  spec: Map<string, SpecResponse[]> | null;
  /** Only requests under a folder of this name (or a request of this name). */
  folder: string | null;
  onResult?: (r: RequestResult) => void;
}

export interface TestResult {
  name: string;
  pass: boolean;
  error?: string;
}
export interface RequestResult {
  id: string;
  name: string;
  /** The collection, then the folders down to the request. */
  place: string[];
  method: string;
  url: string;
  status: number | null;
  timeMs: number | null;
  size: number | null;
  /** skipped: a kind the CLI does not speak (WebSocket, gRPC). */
  outcome: 'passed' | 'failed' | 'skipped';
  /** Why it failed apart from its tests: no answer, a script that threw, a variable without a value. */
  error: string | null;
  tests: TestResult[];
  logs: string[];
}
export interface RunResult {
  collection: string;
  requests: RequestResult[];
  ms: number;
}

const headerObject = (h: [string, string][]) => Object.fromEntries(h.map(([k, v]) => [k.toLowerCase(), v]));
const requestContext = (w: WireRequest) => ({ method: w.method, url: w.url, headers: headerObject(w.headers) });

function chainOf(items: TreeItem[], item: TreeItem): TreeItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out: TreeItem[] = [];
  const seen = new Set<string>();
  for (let cur = item.parentId ? byId.get(item.parentId) : undefined; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    out.push(cur);
  }
  return out; // nearest first
}

// ------------------------------------------------------------------ OAuth 2.0 without a person

const tokens = new Map<string, TokenSet>();
/** Client credentials and password grants get their token by themselves; nobody can sign in in a browser here. */
async function oauthToken(c: OAuthSettings, o: { insecure: boolean; timeoutMs: number }): Promise<string> {
  const problem = oauthProblem(c);
  if (problem) throw new Error(`OAuth 2.0: ${problem}`);
  if (c.grant === 'authorization_code') throw new Error('OAuth 2.0: the authorization code grant needs a person and a browser. For a run without one, give the collection client credentials (or a token in a {{variable}} with Bearer auth).');
  const id = tokenIdentity(c);
  const have = tokens.get(id);
  if (have && tokenFresh(have, Date.now())) return have.accessToken;
  const { headers, body } = tokenRequest(c, c.grant === 'client_credentials' ? { kind: 'client' } : { kind: 'password' });
  const r = await send({ method: 'POST', url: c.tokenUrl, headers: [...headers, ['User-Agent', 'DialCatz-CLI']], body }, `oauth-${randomBytes(6).toString('hex')}`, { insecure: o.insecure, timeoutMs: o.timeoutMs });
  if (r.error || !r.response) throw new Error(`OAuth 2.0: the token address could not be reached: ${r.error ?? 'no answer'}`);
  const t = readTokenResponse(r.response.status, r.response.body, Date.now());
  tokens.set(id, t);
  return t.accessToken;
}

// ------------------------------------------------------------------ one request

async function runChain(chain: { from: string | null; code: string }[], ctx: () => ScriptContext, vars: Vars): Promise<ScriptResult> {
  const merged: ScriptResult = { tests: [], logs: [], changes: {}, error: null };
  for (const s of chain) {
    const r = await runScript(s.code, ctx());
    for (const [k, v] of Object.entries(r.changes)) v === null ? vars.delete(k) : vars.set(k, v);
    const tag = s.from ? `${s.from} · ` : '';
    merged.tests.push(...r.tests.map((t) => ({ ...t, name: tag + t.name })));
    merged.logs.push(...r.logs.map((l) => tag + l));
    if (r.error && !merged.error) merged.error = tag + r.error;
  }
  return merged;
}

async function one(items: TreeItem[], item: TreeItem, collection: TreeItem, o: RunOptions): Promise<RequestResult> {
  const spec = item.request as RequestSpec;
  const above = chainOf(items, item);
  const place = [...above].reverse().map((i) => i.name);
  const base: RequestResult = { id: item.id, name: item.name, place, method: spec.method, url: interpolate(spec.url.trim(), o.vars), status: null, timeMs: null, size: null, outcome: 'failed', error: null, tests: [], logs: [] };
  if (/^wss?:\/\//i.test(base.url)) return { ...base, method: 'WS', outcome: 'skipped', error: 'WebSocket requests are not run by the CLI' };
  if (/^grpcs?:\/\//i.test(base.url)) return { ...base, method: 'gRPC', outcome: 'skipped', error: 'gRPC requests are not run by the CLI' };

  const scripts = (kind: 'preRequest' | 'tests') => [
    ...[...above].reverse().flatMap((i) => (i[kind]?.trim() ? [{ from: `${i.kind === 'collection' ? 'Collection' : 'Folder'} ${i.name}`, code: i[kind]! }] : [])),
    ...(spec[kind]?.trim() ? [{ from: null, code: spec[kind]! }] : []),
  ];
  const auth = (): RequestAuth => effectiveAuth(spec.auth, above.flatMap((i) => (i.auth ? [i.auth] : [])));
  const wireNow = (a: RequestAuth) => toWire(spec, o.vars, a, { version: o.version });
  const insecure = o.insecure || collection.insecure === true;

  const pre = await runChain(scripts('preRequest'), () => ({ request: requestContext(wireNow(auth())), vars: Object.fromEntries(o.vars) }), o.vars);
  base.tests.push(...pre.tests);
  base.logs.push(...pre.logs);
  if (pre.error) return { ...base, error: `Pre-request script: ${pre.error}` };

  // A {{variable}} nobody gave a value: said here, not sent as text to the server.
  const texts = [spec.url, ...spec.params.filter((p) => p.enabled).map((p) => p.value), ...spec.headers.filter((h) => h.enabled).map((h) => h.value), spec.body.raw, ...spec.body.fields.filter((f) => f.enabled).map((f) => f.value)];
  const a0 = auth();
  texts.push(a0.token ?? '', a0.username ?? '', a0.password ?? '', a0.value ?? '');
  const missing = [...new Set(texts.flatMap((t) => missingVars(t ?? '', o.vars)))];
  if (missing.length) return { ...base, error: `No value for ${missing.map((m) => `{{${m}}}`).join(', ')}: pass --var name=value, --env-file, or set an environment variable of that name` };

  let wire: WireRequest;
  try {
    let a = a0;
    if (a.mode === 'oauth2') a = { ...a, token: await oauthToken(resolveOAuth(a.oauth2, o.vars), { insecure, timeoutMs: o.timeoutMs }) };
    wire = wireNow(a);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  base.method = wire.method;
  base.url = wire.url;
  const r = await send(wire, `cli-${item.id}`, { insecure, timeoutMs: o.timeoutMs, followRedirects: true });
  if (r.error || !r.response) return { ...base, error: r.error ?? 'No answer' };
  const res = r.response;
  base.status = res.status;
  base.timeMs = Math.round(res.timings.total);
  base.size = res.size;

  const tests = await runChain(scripts('tests'), () => ({ request: requestContext(wire), response: { status: res.status, statusText: res.statusText, headers: headerObject(res.headers), body: res.body, time: res.timings.total, size: res.size }, vars: Object.fromEntries(o.vars) }), o.vars);
  base.tests.push(...tests.tests);
  base.logs.push(...tests.logs);
  if (tests.error) base.error = `Test script: ${tests.error}`;

  const responses = o.spec ? (specFor(o.spec, spec.method, spec.url) ?? null) : null;
  if (o.spec && !responses) base.tests.push({ name: 'Response matches the spec', pass: false, error: `The spec has no ${specKey(spec.method, spec.url)}` });
  else if (responses?.length) {
    const c = checkResponse(responses, res);
    base.tests.push({ name: 'Response matches the spec', pass: !c.issues.length, ...(c.issues.length ? { error: c.issues.slice(0, 5).join('; ') + (c.issues.length > 5 ? ` (and ${c.issues.length - 5} more)` : '') } : {}) });
  }
  base.outcome = !base.error && base.tests.every((t) => t.pass) ? 'passed' : 'failed';
  return base;
}

export async function runCollection(items: TreeItem[], collection: TreeItem, o: RunOptions): Promise<RunResult> {
  const started = Date.now();
  let list = requestsOf(items, collection.id);
  if (o.folder) {
    const want = o.folder.toLowerCase();
    list = list.filter((i) => i.name.toLowerCase() === want || chainOf(items, i).some((x) => x.kind === 'folder' && x.name.toLowerCase() === want));
  }
  const requests: RequestResult[] = [];
  for (const item of list) {
    const r = await one(items, item, collection, o);
    requests.push(r);
    o.onResult?.(r);
    if (o.bail && r.outcome === 'failed') break;
  }
  return { collection: collection.name, requests, ms: Date.now() - started };
}
