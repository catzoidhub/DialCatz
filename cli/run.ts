import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { HttpResponse, OAuthSettings, RequestAuth, RequestSpec, SpecResponse, TreeItem, WireRequest, WsEvent } from '@shared/types';
import { effectiveAuth, interpolate, missingVars, resolveOAuth, toWire, type Vars } from '@shared/request';
import { deviceRequest, OAuthError, oauthProblem, readDeviceResponse, readTokenResponse, tokenFresh, tokenIdentity, tokenRequest, type TokenAsk, type TokenSet } from '@shared/oauth';
import { checkResponse } from '@shared/speccheck';
import { allowFile, send } from '../src/main/http';
import * as grpcClient from '../src/main/grpc';
import * as sockets from '../src/main/ws';
import { runScript, type ScriptContext, type ScriptResult } from './scripts';
import { requestsOf, specFor, specKey } from './plan';

/**
 * One run of the CLI (#101): the requests of a collection in the order the app's runner takes them (sort, then name,
 * folders in place), each the way the Send button does it — pre-request scripts from the collection down, the
 * request, test scripts in the same order, and with --spec the response checked against the contract. Variables a
 * script sets are seen by the requests after it. With a data file the collection runs once per row, the row's values
 * winning over the other variables. gRPC requests are called; WebSocket, Socket.IO and Pusher ones connect, send
 * their saved first message, listen for a moment and hand what arrived to the tests (dc.messages).
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
  /** Files for multipart fields and binary bodies: field name (or "body") → path. */
  files: Map<string, string>;
  /** Where relative file paths start: the workspace folder, or the collection file's folder. */
  baseDir: string;
  /** --proto: .proto files for gRPC requests whose server has no reflection. */
  protoFiles: string[];
  /** How long a WebSocket request listens after it connected (and sent its message). */
  wsWaitMs: number;
  /** A person is at the terminal: an OAuth device sign-in may be asked for. */
  interactive: boolean;
  /** What a device sign-in asks of the person. */
  say: (text: string) => void;
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
  outcome: 'passed' | 'failed' | 'skipped';
  /** Why it failed apart from its tests: no answer, a script that threw, a variable without a value. */
  error: string | null;
  tests: TestResult[];
  logs: string[];
}
export interface RunResult {
  collection: string;
  /** With a data file: which row this run was (1-based). */
  iteration?: number;
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

// ------------------------------------------------------------------ OAuth 2.0

const tokens = new Map<string, TokenSet>();
async function tokenAsk(c: OAuthSettings, what: TokenAsk, o: { insecure: boolean; timeoutMs: number }): Promise<TokenSet> {
  const { headers, body } = tokenRequest(c, what);
  const r = await send({ method: 'POST', url: c.tokenUrl, headers: [...headers, ['User-Agent', 'DialCatz-CLI']], body }, `oauth-${randomBytes(6).toString('hex')}`, { insecure: o.insecure, timeoutMs: o.timeoutMs });
  if (r.error || !r.response) throw new Error(`OAuth 2.0: the token address could not be reached: ${r.error ?? 'no answer'}`);
  return readTokenResponse(r.response.status, r.response.body, Date.now());
}

/**
 * Client credentials and password grants get their token by themselves. A device code sign-in is offered when a
 * person is at the terminal; the authorization code grant needs the app (its browser round trip).
 */
async function oauthToken(c: OAuthSettings, o: RunOptions & { insecureNow: boolean }): Promise<string> {
  const problem = oauthProblem(c);
  if (problem) throw new Error(`OAuth 2.0: ${problem}`);
  const net = { insecure: o.insecureNow, timeoutMs: o.timeoutMs };
  const id = tokenIdentity(c);
  const have = tokens.get(id);
  if (have && tokenFresh(have, Date.now())) return have.accessToken;
  let t: TokenSet;
  if (c.grant === 'client_credentials') t = await tokenAsk(c, { kind: 'client' }, net);
  else if (c.grant === 'password') t = await tokenAsk(c, { kind: 'password' }, net);
  else if (c.grant === 'device_code') {
    if (!o.interactive) throw new Error('OAuth 2.0: a device code sign-in needs a person at the terminal. For a run without one, give the collection client credentials (or a token in a {{variable}} with Bearer auth).');
    const { headers, body } = deviceRequest(c);
    const r = await send({ method: 'POST', url: c.deviceUrl!, headers: [...headers, ['User-Agent', 'DialCatz-CLI']], body }, `oauth-${randomBytes(6).toString('hex')}`, net);
    if (r.error || !r.response) throw new Error(`OAuth 2.0: the device address could not be reached: ${r.error ?? 'no answer'}`);
    const d = readDeviceResponse(r.response.status, r.response.body, Date.now());
    o.say(`\n  Sign in to continue: open ${d.verificationUriComplete || d.verificationUri}${d.verificationUriComplete ? '' : ` and type the code ${d.userCode}`}\n  (code ${d.userCode}, waiting…)\n`);
    let every = d.intervalMs;
    for (;;) {
      await new Promise((done) => setTimeout(done, every));
      if (Date.now() > d.expiresAt) throw new Error('OAuth 2.0: the code ended before anyone signed in');
      try {
        t = await tokenAsk(c, { kind: 'device', deviceCode: d.deviceCode }, net);
        break;
      } catch (e) {
        const code = e instanceof OAuthError ? e.code : '';
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') every += 5000;
        else if (code === 'access_denied') throw new Error('OAuth 2.0: the sign-in was refused');
        else throw e;
      }
    }
  } else throw new Error('OAuth 2.0: the authorization code grant signs in through the app\'s browser round trip. For the CLI, use the device code grant (a person at the terminal) or client credentials (a run without one).');
  tokens.set(id, t);
  return t.accessToken;
}

// ------------------------------------------------------------------ scripts

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

// ------------------------------------------------------------------ files, gRPC, WebSocket

/** The request with its file fields pointing at real files: --file, the path saved with it, or a path typed as the field's value. */
function withFiles(spec: RequestSpec, o: RunOptions): RequestSpec {
  const at = (p: string) => (isAbsolute(p) ? p : resolve(o.baseDir, p));
  const pick = (name: string, ...candidates: (string | undefined)[]) => {
    const given = o.files.get(name);
    const path = given ? resolve(given) : candidates.filter((c): c is string => !!c).map(at).find((p) => existsSync(p));
    if (!path || !existsSync(path)) throw new Error(`No file for ${name === 'body' ? 'the body' : `the field ${name}`}${given ? ` (${given} does not exist)` : ''}: pass --file ${name}=<path>`);
    allowFile(path);
    return path;
  };
  if (spec.body.mode === 'multipart') return { ...spec, body: { ...spec.body, fields: spec.body.fields.map((f) => (f.enabled && f.key && f.type === 'file' ? { ...f, src: pick(f.key, f.src, f.value) } : f)) } };
  if (spec.body.mode === 'binary' && !['GET', 'HEAD'].includes(spec.method)) return { ...spec, body: { ...spec.body, file: pick('body', spec.body.file) } };
  return spec;
}

const AUTO = /^(user-agent|accept|accept-encoding|connection|cache-control|content-type|content-length|host)$/i;

async function grpcCall(spec: RequestSpec, wire: WireRequest, item: TreeItem, o: RunOptions, insecure: boolean): Promise<{ response?: HttpResponse; error?: string }> {
  const started = performance.now();
  const files = o.protoFiles.length ? o.protoFiles : (spec.grpc?.protoFiles ?? []).filter((f) => existsSync(f));
  try {
    const r = await grpcClient.call({ url: wire.url.split('?')[0], service: spec.grpc?.service ?? '', method: spec.grpc?.method ?? '', message: interpolate(spec.body.raw, o.vars), metadata: wire.headers.filter(([k]) => !AUTO.test(k)), ...(files.length ? { protoFiles: files } : {}), insecure, timeoutMs: o.timeoutMs, token: `cli-${item.id}` });
    const body = r.messages.length === 1 ? JSON.stringify(r.messages[0], null, 2) : r.messages.length ? JSON.stringify(r.messages, null, 2) : '';
    const name = grpcClient.CODES[r.code] ?? `CODE_${r.code}`;
    return { response: { ok: r.code === 0, status: grpcClient.HTTP_OF[r.code] ?? 500, statusText: r.code === 0 ? 'OK' : `${name}${r.details ? `: ${r.details}` : ''}`, headers: r.headers, body, binary: false, contentType: 'application/json', size: Buffer.byteLength(body), timings: { total: Math.round(performance.now() - started), ttfb: Math.round(r.ttfb) }, url: wire.url } as unknown as HttpResponse };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export interface WsMessage {
  data: string;
  /** Socket.IO: the event's name. Pusher: the event, with its channel in `channel`. */
  event?: string;
  channel?: string;
}
const wsWaiters = new Map<string, (e: WsEvent) => void>();
sockets.onEvent((e) => wsWaiters.get(e.token)?.(e));

/**
 * A WebSocket request in a run: connect, join the saved Pusher channels, send the saved first message, listen for
 * wsWaitMs, close. It passes when it connected (and its tests do).
 */
async function wsExchange(spec: RequestSpec, wire: WireRequest, item: TreeItem, o: RunOptions, insecure: boolean): Promise<{ messages: WsMessage[]; ms: number; error: string | null }> {
  const token = `cli-ws-${item.id}-${randomBytes(4).toString('hex')}`;
  const started = performance.now();
  const messages: WsMessage[] = [];
  const hop = /^(connection|upgrade|sec-websocket-(key|version|extensions)|accept-encoding|cache-control|content-type|content-length)$/i;
  const protocols = (wire.headers.find(([k]) => /^sec-websocket-protocol$/i.test(k))?.[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  const first = spec.wsMessage;
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`No connection within ${Math.round(o.timeoutMs / 1000)} s`)), o.timeoutMs);
      let ready = false;
      let sent = false;
      const channels = spec.pusher ? (spec.pusher.channels ?? []).map((ch) => interpolate(ch, o.vars)) : [];
      const joined = new Set<string>();
      const sendFirst = () => {
        if (sent) return;
        sent = true;
        try {
          if (first && (first.text.trim() || first.event?.trim())) sockets.send(token, interpolate(first.text, o.vars), first.event?.trim() ? interpolate(first.event, o.vars) : undefined, first.channel?.trim() ? interpolate(first.channel, o.vars) : undefined);
        } catch (err) {
          return fail(err as Error);
        }
        setTimeout(done, o.wsWaitMs);
      };
      // Raw and Socket.IO are ready when the connection opens; Pusher when the server has given the socket id.
      const start = () => {
        ready = true;
        clearTimeout(timer);
        if (!spec.pusher) return sendFirst();
        try {
          for (const ch of channels) sockets.pusherChannel(token, 'subscribe', ch, { secret: interpolate(spec.pusher.secret ?? '', o.vars) || undefined, userId: interpolate(spec.pusher.userId ?? '', o.vars) || undefined });
        } catch (err) {
          return fail(err as Error);
        }
        // A client event goes out once its channels are joined (or after a moment, when one was refused).
        if (!channels.length) sendFirst();
        else setTimeout(sendFirst, 2000);
      };
      wsWaiters.set(token, (e) => {
        if (e.type === 'error') {
          clearTimeout(timer);
          fail(new Error(e.data || 'The connection failed'));
        } else if (e.type === 'close' && !ready) {
          clearTimeout(timer);
          fail(new Error(`The server closed the connection (${e.data || 'no reason'})`));
        } else if (e.type === 'in') {
          // As the app's log names them: "channel · event" for a Pusher event, "subscribed <channel>", "connected".
          const pair = / · /.test(e.event ?? '') ? /^(.*?) · (.*)$/.exec(e.event!) : null;
          const sub = /^subscribed (.+)$/.exec(e.event ?? '');
          messages.push({ data: e.data, ...(pair ? { channel: pair[1], event: pair[2] } : sub ? { channel: sub[1], event: 'subscribed' } : e.event ? { event: e.event } : {}) });
          if (spec.pusher && !ready && e.event === 'connected') start();
          if (sub) {
            joined.add(sub[1]);
            if (ready && channels.every((c) => joined.has(c))) sendFirst();
          }
        } else if (e.type === 'open' && !ready && !spec.pusher) start();
      });
      try {
        sockets.connect(token, wire.url, wire.headers.filter(([k]) => !hop.test(k) && !/^sec-websocket-protocol$/i.test(k)), protocols, { socketIo: spec.socketIo === true, pusher: !!spec.pusher, insecure });
      } catch (err) {
        clearTimeout(timer);
        fail(err as Error);
      }
    });
    return { messages, ms: Math.round(performance.now() - started), error: null };
  } catch (e) {
    return { messages, ms: Math.round(performance.now() - started), error: (e as Error).message };
  } finally {
    wsWaiters.delete(token);
    sockets.close(token);
  }
}

// ------------------------------------------------------------------ one request

async function one(items: TreeItem[], item: TreeItem, collection: TreeItem, o: RunOptions, data: Record<string, string> | undefined): Promise<RequestResult> {
  let spec = item.request as RequestSpec;
  const above = chainOf(items, item);
  const place = [...above].reverse().map((i) => i.name);
  // A data row wins over the other variables; what a script sets goes into the run's own.
  const vars = (): Vars => (data ? new Map([...o.vars, ...Object.entries(data)]) : o.vars);
  const url0 = interpolate(spec.url.trim(), vars());
  const isWs = /^wss?:\/\//i.test(url0);
  const isGrpc = /^grpcs?:\/\//i.test(url0);
  const base: RequestResult = { id: item.id, name: item.name, place, method: isWs ? (spec.pusher ? 'PSH' : spec.socketIo ? 'SIO' : 'WS') : isGrpc ? 'gRPC' : spec.method, url: url0, status: null, timeMs: null, size: null, outcome: 'failed', error: null, tests: [], logs: [] };

  const scripts = (kind: 'preRequest' | 'tests') => [
    ...[...above].reverse().flatMap((i) => (i[kind]?.trim() ? [{ from: `${i.kind === 'collection' ? 'Collection' : 'Folder'} ${i.name}`, code: i[kind]! }] : [])),
    ...(spec[kind]?.trim() ? [{ from: null, code: spec[kind]! }] : []),
  ];
  const auth = (): RequestAuth => effectiveAuth(spec.auth, above.flatMap((i) => (i.auth ? [i.auth] : [])));
  const wireNow = (a: RequestAuth) => toWire(spec, vars(), a, { version: o.version });
  const insecure = o.insecure || collection.insecure === true;

  const pre = await runChain(scripts('preRequest'), () => ({ request: requestContext(wireNow(auth())), vars: Object.fromEntries(vars()), data }), o.vars);
  base.tests.push(...pre.tests);
  base.logs.push(...pre.logs);
  if (pre.error) return { ...base, error: `Pre-request script: ${pre.error}` };

  // A {{variable}} nobody gave a value: said here, not sent as text to the server.
  const a0 = auth();
  const texts = [spec.url, ...spec.params.filter((p) => p.enabled).map((p) => p.value), ...spec.headers.filter((h) => h.enabled).map((h) => h.value), spec.body.raw, ...spec.body.fields.filter((f) => f.enabled && f.type !== 'file').map((f) => f.value), a0.token ?? '', a0.username ?? '', a0.password ?? '', a0.value ?? '', spec.wsMessage?.text ?? ''];
  const missing = [...new Set(texts.flatMap((t) => missingVars(t ?? '', vars())))];
  if (missing.length) return { ...base, error: `No value for ${missing.map((m) => `{{${m}}}`).join(', ')}: pass --var name=value, --env-file, a data file column, or set an environment variable of that name` };

  let wire: WireRequest;
  try {
    spec = withFiles(spec, o);
    let a = a0;
    if (a.mode === 'oauth2') a = { ...a, token: await oauthToken(resolveOAuth(a.oauth2, vars()), { ...o, insecureNow: insecure }) };
    wire = wireNow(a);
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
  base.url = wire.url;

  let res: HttpResponse;
  let messages: WsMessage[] | undefined;
  if (isWs) {
    const x = await wsExchange(spec, wire, item, o, insecure);
    base.timeMs = x.ms;
    if (x.error) return { ...base, error: x.error };
    messages = x.messages;
    const body = JSON.stringify(messages);
    base.status = 101;
    base.size = Buffer.byteLength(body);
    res = { ok: true, status: 101, statusText: 'Switching Protocols', headers: [], body, binary: false, contentType: 'application/json', size: base.size, timings: { total: x.ms, ttfb: x.ms }, url: wire.url } as unknown as HttpResponse;
  } else {
    const r = isGrpc ? await grpcCall(spec, wire, item, o, insecure) : await send(wire, `cli-${item.id}`, { insecure, timeoutMs: o.timeoutMs, followRedirects: true });
    if (r.error || !r.response) return { ...base, error: r.error ?? 'No answer' };
    res = r.response;
    base.method = isGrpc ? 'gRPC' : wire.method;
    base.status = res.status;
    base.timeMs = Math.round(res.timings.total);
    base.size = res.size;
    if (isGrpc && !res.ok) base.error = `gRPC ${res.statusText}`;
  }

  const tests = await runChain(scripts('tests'), () => ({ request: requestContext(wire), response: { status: res.status, statusText: res.statusText, headers: headerObject(res.headers), body: res.body, time: res.timings.total, size: res.size }, vars: Object.fromEntries(vars()), data, ...(messages ? { messages } : {}) }), o.vars);
  base.tests.push(...tests.tests);
  base.logs.push(...tests.logs);
  if (tests.error) base.error = `Test script: ${tests.error}`;

  if (o.spec && !isWs && !isGrpc) {
    const responses = specFor(o.spec, spec.method, spec.url);
    if (!responses) base.tests.push({ name: 'Response matches the spec', pass: false, error: `The spec has no ${specKey(spec.method, spec.url)}` });
    else if (responses.length) {
      const c = checkResponse(responses, res);
      base.tests.push({ name: 'Response matches the spec', pass: !c.issues.length, ...(c.issues.length ? { error: c.issues.slice(0, 5).join('; ') + (c.issues.length > 5 ? ` (and ${c.issues.length - 5} more)` : '') } : {}) });
    }
  }
  base.outcome = !base.error && base.tests.every((t) => t.pass) ? 'passed' : 'failed';
  return base;
}

export async function runCollection(items: TreeItem[], collection: TreeItem, o: RunOptions, data?: Record<string, string>, iteration?: number): Promise<RunResult> {
  const started = Date.now();
  let list = requestsOf(items, collection.id);
  if (o.folder) {
    const want = o.folder.toLowerCase();
    list = list.filter((i) => i.name.toLowerCase() === want || chainOf(items, i).some((x) => x.kind === 'folder' && x.name.toLowerCase() === want));
  }
  const requests: RequestResult[] = [];
  for (const item of list) {
    const r = await one(items, item, collection, o, data);
    requests.push(r);
    o.onResult?.(r);
    if (o.bail && r.outcome === 'failed') break;
  }
  return { collection: collection.name, ...(iteration !== undefined ? { iteration } : {}), requests, ms: Date.now() - started };
}

/** Connections a run may have left open (a server that never closed): let the process end. */
export const closeAll = (): void => sockets.closeAll();
