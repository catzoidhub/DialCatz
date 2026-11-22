import { safeStorage } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { OAuthDevicePrompt, OAuthDiscovery, OAuthSettings, OAuthStatus } from '@shared/types';
import { OAUTH_REDIRECT } from '@shared/types';
import { authorizeUrl, deviceRequest, discoveryUrls, loopback, OAuthError, oauthProblem, readDeviceResponse, readDiscovery, readTokenResponse, tokenFresh, tokenIdentity, tokenRequest, type TokenAsk, type TokenSet } from '@shared/oauth';
import { send } from './http';
import { store } from './store';
import { oauthPage } from './oauthpage';

/**
 * OAuth 2.0 tokens (#100). The settings (addresses, client, scope) live with the request or collection and may hold
 * {{variables}}; the window hands them over with the variables filled. The tokens stay on this computer only:
 * config.json → oauthTokens, each encrypted for this user (safeStorage: Keychain / DPAPI / the keyring), keyed by who
 * asks, where and for what, so a collection shared with the team never carries one. Where nothing can encrypt them
 * they are not written at all: they last until DialCatz quits.
 *   token(c)      the kept token while it lasts; else a refresh; else a new one (client credentials / password by
 *                 itself; authorization code only when `interactive`, through the browser)
 *   Authorization code: the browser opens the auth address; it comes back to a loopback address DialCatz listens on
 *   for that sign-in only (state checked, PKCE S256 unless switched off), then the code is exchanged.
 */

const KEY = 'oauthTokens';
type Kept = { access: string; refresh: string; expiresAt: number | null; scope: string; tokenType: string; obtainedAt: number };

// Tests keep them readable in config.json (DIALCATZ_NO_KEYCHAIN). Otherwise a token is written only when it can be
// encrypted; on a system without a secret store (a Linux session with no keyring) it lives in memory until DialCatz
// quits, and the user signs in again next time.
const testStore = !!process.env.DIALCATZ_NO_KEYCHAIN;
const canEncrypt = () => !testStore && safeStorage.isEncryptionAvailable();
const onDisk = () => testStore || canEncrypt();
const memory = new Map<string, Kept>();
const seal = (s: string) => (!s ? '' : canEncrypt() ? `enc:${safeStorage.encryptString(s).toString('base64')}` : `raw:${s}`);
function open(s: string): string {
  if (!s) return '';
  if (s.startsWith('raw:')) return s.slice(4);
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
  } catch {
    return ''; // another user's or another computer's: as good as none
  }
}
const idOf = (c: OAuthSettings) => createHash('sha256').update(tokenIdentity(c)).digest('hex').slice(0, 32);
let swept = false;
/** Tokens a build before this rule left readable in config.json: removed, once. */
function sweep(): void {
  if (swept || testStore) return;
  swept = true;
  const a = store.extra<Record<string, Kept>>(KEY) ?? {};
  const good = Object.fromEntries(Object.entries(a).filter(([, k]) => !k.access.startsWith('raw:') && !k.refresh.startsWith('raw:')));
  if (Object.keys(good).length !== Object.keys(a).length) store.setExtra(KEY, good);
}
function all(): Record<string, Kept> {
  sweep();
  if (!onDisk()) return Object.fromEntries(memory);
  return { ...(store.extra<Record<string, Kept>>(KEY) ?? {}) };
}
function save(a: Record<string, Kept>): void {
  if (onDisk()) return store.setExtra(KEY, a);
  memory.clear();
  for (const [id, k] of Object.entries(a)) memory.set(id, k);
}
/** Kept across restarts (encrypted), or only while DialCatz runs (no secret store on this system). */
export const lasting = (): boolean => onDisk();

function kept(c: OAuthSettings): TokenSet | null {
  const k = all()[idOf(c)];
  if (!k) return null;
  const accessToken = open(k.access);
  if (!accessToken) return null;
  return { accessToken, refreshToken: open(k.refresh), expiresAt: k.expiresAt, scope: k.scope, tokenType: k.tokenType, obtainedAt: k.obtainedAt };
}
function keep(c: OAuthSettings, t: TokenSet): void {
  const a = all();
  a[idOf(c)] = { access: seal(t.accessToken), refresh: seal(t.refreshToken), expiresAt: t.expiresAt, scope: t.scope, tokenType: t.tokenType, obtainedAt: t.obtainedAt };
  // Tokens nobody asked about for 60 days go (settings that changed leave their old token behind).
  for (const [id, k] of Object.entries(a)) if (Date.now() - k.obtainedAt > 60 * 86_400_000) delete a[id];
  save(a);
}

export function clear(c: OAuthSettings): void {
  const a = all();
  delete a[idOf(c)];
  save(a);
}

export function status(c: OAuthSettings): OAuthStatus {
  const t = kept(c);
  if (!t) return { has: false, expiresAt: null, expired: false, scope: '', tokenType: '', refreshable: false, obtainedAt: null, lasting: lasting() };
  return { has: true, expiresAt: t.expiresAt, expired: !tokenFresh(t, Date.now()), scope: t.scope, tokenType: t.tokenType, refreshable: !!t.refreshToken, obtainedAt: t.obtainedAt, lasting: lasting() };
}

export interface OAuthOptions {
  insecure?: boolean;
  /** May open the browser for a sign-in (the Auth tab's button, a request the user sends by hand). */
  interactive?: boolean;
  /** Never the kept token: ask again. */
  fresh?: boolean;
}

/** One request to the token address. */
async function ask(c: OAuthSettings, what: TokenAsk, o: OAuthOptions, before?: TokenSet): Promise<TokenSet> {
  const { headers, body } = tokenRequest(c, what);
  const r = await send({ method: 'POST', url: c.tokenUrl, headers: [...headers, ['User-Agent', 'DialCatz']], body }, `oauth-${randomBytes(6).toString('hex')}`, { insecure: o.insecure === true, timeoutMs: 30_000 });
  if (r.error || !r.response) throw new Error(`The token address could not be reached: ${r.error ?? 'no answer'}`);
  return readTokenResponse(r.response.status, r.response.body, Date.now(), before);
}

// Two sends at once (a runner, two tabs) share one request for the same token.
const pending = new Map<string, Promise<TokenSet>>();

/** A token that can be used now. */
export function token(c: OAuthSettings, o: OAuthOptions = {}): Promise<TokenSet> {
  const problem = oauthProblem(c);
  if (problem) return Promise.reject(new Error(`OAuth 2.0: ${problem}`));
  const id = idOf(c) + (o.fresh ? ':fresh' : '');
  const running = pending.get(id);
  if (running) return running;
  const p = get(c, o).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

async function get(c: OAuthSettings, o: OAuthOptions): Promise<TokenSet> {
  const have = o.fresh ? null : kept(c);
  if (have && tokenFresh(have, Date.now())) return have;
  if (have?.refreshToken) {
    try {
      const t = await ask(c, { kind: 'refresh', refreshToken: have.refreshToken }, o, have);
      keep(c, t);
      return t;
    } catch (e) {
      // A refresh token that ended: the grant itself is tried next (a sign-in when that is allowed).
      if ((c.grant === 'authorization_code' || c.grant === 'device_code') && !o.interactive) throw new Error(`OAuth 2.0: the token ended and could not be renewed (${(e as Error).message}). Get a new token in the Auth tab.`);
    }
  }
  let t: TokenSet;
  if (c.grant === 'client_credentials') t = await ask(c, { kind: 'client' }, o);
  else if (c.grant === 'password') t = await ask(c, { kind: 'password' }, o);
  else {
    if (!o.interactive) throw new Error('OAuth 2.0: sign in first. Open the Auth tab and choose Get new token.');
    t = c.grant === 'device_code' ? await deviceSignIn(c, o) : await signIn(c, o);
  }
  keep(c, t);
  return t;
}

// ------------------------------------------------------------------ authorization code: the browser and back

let openBrowser: (url: string) => Promise<void> = async () => undefined;
/** How a sign-in page is opened (the browser chosen in Settings). */
export const setBrowser = (fn: (url: string) => Promise<void>) => (openBrowser = fn);

let signing: { cancel: (why: string) => void } | null = null;
/** Stops a sign-in that waits for the browser. */
export function cancel(): void {
  const s = signing;
  signing = null;
  s?.cancel('The sign-in was cancelled');
}
export const waiting = () => signing !== null;

// The listener of the sign-in before leaves a moment after its "Signed in" page: the next one waits for the port.
let released: Promise<void> = Promise.resolve();

async function signIn(c: OAuthSettings, o: OAuthOptions): Promise<TokenSet> {
  if (signing) throw new Error('OAuth 2.0: another sign-in is waiting for the browser. Finish or cancel it first.');
  signing = { cancel: () => undefined };
  await released;
  const at = loopback(c.redirectUri || OAUTH_REDIRECT)!;
  const state = randomBytes(16).toString('base64url');
  const verifier = c.pkce === false ? null : randomBytes(48).toString('base64url');
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
  let server: Server | null = null;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      // Cancelled while it waited for the port.
      if (!signing) return reject(new Error('OAuth 2.0: The sign-in was cancelled'));
      const timer = setTimeout(() => reject(new Error('OAuth 2.0: nobody signed in within 5 minutes')), 300_000);
      signing = { cancel: (why) => reject(new Error(`OAuth 2.0: ${why}`)) };
      server = createServer((req, res) => {
        const u = new URL(req.url ?? '/', `http://${at.host}:${at.port}`);
        if (u.pathname !== at.path) {
          res.writeHead(404).end();
          return;
        }
        const html = (ok: boolean, title: string, text: string, detail = '') => res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(oauthPage(ok, title, text, detail));
        const err = u.searchParams.get('error');
        if (err) {
          const why = [err, u.searchParams.get('error_description')].filter(Boolean).join(': ');
          html(false, 'The sign-in did not finish', 'The provider sent you back without a sign-in. You can close this tab and try again from DialCatz.', why);
          clearTimeout(timer);
          reject(new Error(`OAuth 2.0: the sign-in page answered ${why}`));
        } else if (u.searchParams.get('state') !== state) {
          html(false, 'Not the sign-in DialCatz started', 'Go back to DialCatz and choose Get new token again.');
        } else if (!u.searchParams.get('code')) {
          html(false, 'The sign-in came back without a code', 'Go back to DialCatz and try again.');
        } else {
          html(true, 'You are signed in', 'DialCatz has what it needs. You can close this tab.');
          clearTimeout(timer);
          resolve(u.searchParams.get('code')!);
        }
      });
      server.once('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(new Error(e.code === 'EADDRINUSE' ? `OAuth 2.0: port ${at.port} is in use, so the browser could not come back. Close what uses it, or change the redirect URI (and register the new one with the provider).` : `OAuth 2.0: could not listen on ${at.host}:${at.port} (${e.message})`));
      });
      server.listen(at.port, at.host, () => void openBrowser(authorizeUrl(c, state, challenge)).catch((e: Error) => reject(new Error(`OAuth 2.0: the browser could not be opened (${e.message})`))));
    });
    return await ask(c, { kind: 'code', code, verifier }, o);
  } finally {
    signing = null;
    // Let the "Signed in" page leave before the listener goes.
    const s = server as Server | null;
    released = new Promise((done) =>
      setTimeout(() => {
        if (!s?.listening) return done();
        s.close(() => done());
        s.closeAllConnections?.();
      }, 500),
    );
  }
}

// ------------------------------------------------------------------ device code: a code typed in on any device

let devicePrompt: (p: OAuthDevicePrompt | null) => void = () => undefined;
/** Where the code to type in is shown while DialCatz waits (null: the wait is over). */
export const setDevicePrompt = (fn: (p: OAuthDevicePrompt | null) => void) => (devicePrompt = fn);

async function deviceSignIn(c: OAuthSettings, o: OAuthOptions): Promise<TokenSet> {
  if (signing) throw new Error('OAuth 2.0: another sign-in is waiting. Finish or cancel it first.');
  let stopNow: (e: Error) => void = () => undefined;
  const stop = new Promise<never>((_, reject) => (stopNow = reject));
  stop.catch(() => undefined);
  signing = { cancel: (why) => stopNow(new Error(`OAuth 2.0: ${why}`)) };
  try {
    const { headers, body } = deviceRequest(c);
    const r = await send({ method: 'POST', url: c.deviceUrl!, headers: [...headers, ['User-Agent', 'DialCatz']], body }, `oauth-${randomBytes(6).toString('hex')}`, { insecure: o.insecure === true, timeoutMs: 30_000 });
    if (r.error || !r.response) throw new Error(`OAuth 2.0: the device address could not be reached: ${r.error ?? 'no answer'}`);
    const d = readDeviceResponse(r.response.status, r.response.body, Date.now());
    devicePrompt({ userCode: d.userCode, verificationUri: d.verificationUri, verificationUriComplete: d.verificationUriComplete, expiresAt: d.expiresAt });
    void openBrowser(d.verificationUriComplete || d.verificationUri).catch(() => undefined);
    let every = d.intervalMs;
    for (;;) {
      await Promise.race([new Promise((done) => setTimeout(done, every)), stop]);
      if (Date.now() > d.expiresAt) throw new Error('OAuth 2.0: the code ended before anyone signed in. Choose Get new token for a new one.');
      try {
        return await ask(c, { kind: 'device', deviceCode: d.deviceCode }, o);
      } catch (e) {
        const code = e instanceof OAuthError ? e.code : '';
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') every += 5000;
        else if (code === 'access_denied') throw new Error('OAuth 2.0: the sign-in was refused');
        else if (code === 'expired_token') throw new Error('OAuth 2.0: the code ended before anyone signed in. Choose Get new token for a new one.');
        else throw e;
      }
    }
  } finally {
    signing = null;
    devicePrompt(null);
  }
}

// ------------------------------------------------------------------ discovery

/** The provider's addresses from its issuer (OpenID Connect discovery, then RFC 8414's own address). */
export async function discover(issuer: string, o: { insecure?: boolean } = {}): Promise<OAuthDiscovery> {
  let last = '';
  for (const url of discoveryUrls(issuer)) {
    const r = await send({ method: 'GET', url, headers: [['Accept', 'application/json'], ['User-Agent', 'DialCatz']] }, `oauth-${randomBytes(6).toString('hex')}`, { insecure: o.insecure === true, timeoutMs: 20_000 });
    if (r.error || !r.response) last = r.error ?? 'no answer';
    else if (r.response.status !== 200) last = `${new URL(url).pathname} answered ${r.response.status}`;
    else return readDiscovery(r.response.body);
  }
  throw new Error(`No discovery document at that issuer (${last}). Fill in the addresses by hand.`);
}
