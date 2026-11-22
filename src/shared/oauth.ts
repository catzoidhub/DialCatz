import { OAUTH_REDIRECT, type OAuthSettings } from './types';

/**
 * OAuth 2.0 (#100), the parts that are pure text: what is asked of the token address (RFC 6749; PKCE: RFC 7636), how
 * its answer is read, and what makes two settings the same token. The main process (main/oauth.ts) and the CLI do the
 * sending, the browser and the keeping.
 *   authorization_code   browser → authUrl?response_type=code&client_id&redirect_uri&scope&state[&code_challenge…]
 *                        → loopback redirect with ?code → POST tokenUrl grant_type=authorization_code&code&redirect_uri[&code_verifier]
 *   client_credentials   POST tokenUrl grant_type=client_credentials[&scope][&audience]
 *   password             POST tokenUrl grant_type=password&username&password[&scope]
 *   refresh              POST tokenUrl grant_type=refresh_token&refresh_token[&scope]
 * The client's id and secret go in a Basic header (default) or in the body; a public client (no secret) always sends
 * client_id in the body.
 */

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  /** ms since the epoch; null when the server gave no lifetime. */
  expiresAt: number | null;
  refreshToken: string;
  scope: string;
  obtainedAt: number;
}

/** What is wrong with the settings, in words for the user; null when a token can be asked for. */
export function oauthProblem(c: OAuthSettings): string | null {
  const web = (u: string | undefined) => /^https?:\/\/[^\s]+$/i.test(u ?? '');
  const open = (s: string | undefined) => /\{\{[^}]*\}\}/.test(s ?? '');
  for (const [name, value] of [['token URL', c.tokenUrl], ['client ID', c.clientId], ['client secret', c.clientSecret], ['auth URL', c.authUrl], ['username', c.username], ['password', c.password]] as const)
    if (open(value)) return `The ${name} has a {{variable}} without a value: fill it in your environment`;
  if (!c.tokenUrl) return 'Fill in the token URL';
  if (!web(c.tokenUrl)) return 'The token URL starts with http:// or https://';
  if (!c.clientId) return 'Fill in the client ID';
  if (c.grant === 'authorization_code') {
    if (!c.authUrl) return 'Fill in the auth URL (where you sign in)';
    if (!web(c.authUrl)) return 'The auth URL starts with http:// or https://';
    if (!loopback(c.redirectUri || OAUTH_REDIRECT)) return 'The redirect URI must be on this computer: http://127.0.0.1:<port>/… or http://localhost:<port>/…';
  }
  if (c.grant === 'client_credentials' && !c.clientSecret) return 'Client credentials needs the client secret';
  if (c.grant === 'password' && !c.username) return 'Fill in the username';
  return null;
}

/** A redirect address DialCatz can listen on: plain http on this computer, with a port. */
export function loopback(uri: string): { host: string; port: number; path: string } | null {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !u.port) return null;
    return { host: u.hostname === 'localhost' ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port), path: u.pathname || '/' };
  } catch {
    return null;
  }
}

/** What tells one kept token from another: who asks, where, for what. (The secret is not part of it.) */
export const tokenIdentity = (c: OAuthSettings): string => JSON.stringify([c.grant, c.tokenUrl, c.authUrl ?? '', c.clientId, c.scope ?? '', c.audience ?? '', c.grant === 'password' ? (c.username ?? '') : '']);

export function authorizeUrl(c: OAuthSettings, state: string, challenge: string | null): string {
  const u = new URL(c.authUrl!);
  const set = (k: string, v: string | undefined) => v && u.searchParams.set(k, v);
  set('response_type', 'code');
  set('client_id', c.clientId);
  set('redirect_uri', c.redirectUri || OAUTH_REDIRECT);
  set('scope', c.scope);
  set('audience', c.audience);
  set('state', state);
  if (challenge) {
    set('code_challenge', challenge);
    set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export type TokenAsk = { kind: 'code'; code: string; verifier: string | null } | { kind: 'client' } | { kind: 'password' } | { kind: 'refresh'; refreshToken: string };

/** The POST to the token address: its headers and form body. */
export function tokenRequest(c: OAuthSettings, ask: TokenAsk): { headers: [string, string][]; body: string } {
  const f = new URLSearchParams();
  if (ask.kind === 'code') {
    f.set('grant_type', 'authorization_code');
    f.set('code', ask.code);
    f.set('redirect_uri', c.redirectUri || OAUTH_REDIRECT);
    if (ask.verifier) f.set('code_verifier', ask.verifier);
  } else if (ask.kind === 'client') {
    f.set('grant_type', 'client_credentials');
  } else if (ask.kind === 'password') {
    f.set('grant_type', 'password');
    f.set('username', c.username ?? '');
    f.set('password', c.password ?? '');
  } else {
    f.set('grant_type', 'refresh_token');
    f.set('refresh_token', ask.refreshToken);
  }
  if (ask.kind !== 'code' && c.scope) f.set('scope', c.scope);
  if (ask.kind !== 'code' && ask.kind !== 'refresh' && c.audience) f.set('audience', c.audience);
  const headers: [string, string][] = [
    ['Content-Type', 'application/x-www-form-urlencoded'],
    ['Accept', 'application/json'],
  ];
  if (c.clientSecret && c.clientAuth !== 'body') headers.push(['Authorization', `Basic ${base64(`${formEncode(c.clientId)}:${formEncode(c.clientSecret)}`)}`]);
  else {
    f.set('client_id', c.clientId);
    if (c.clientSecret) f.set('client_secret', c.clientSecret);
  }
  return { headers, body: f.toString() };
}

// RFC 6749 §2.3.1: the id and secret are form-encoded before they go into the Basic header.
const formEncode = (s: string) => encodeURIComponent(s).replace(/%20/g, '+').replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
function base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The token address's answer. JSON as the RFC says; some servers (GitHub without an Accept header) answer as a form.
 * An error names what the server said (error, error_description), never the request.
 */
export function readTokenResponse(status: number, text: string, now: number, before?: TokenSet): TokenSet {
  let o: Record<string, unknown> = {};
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (/(^|&)(access_token|error)=/.test(text)) o = Object.fromEntries(new URLSearchParams(text));
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  if (o.error || status >= 400) {
    const what = [str(o.error), str(o.error_description) || str(o.message)].filter(Boolean).join(': ');
    throw new Error(`The token address answered ${status}${what ? ` (${what})` : text.trim() ? `: ${text.trim().slice(0, 200)}` : ''}`);
  }
  const accessToken = str(o.access_token);
  if (!accessToken) throw new Error(`The token address answered ${status} without an access_token`);
  const life = Number(o.expires_in);
  return {
    accessToken,
    tokenType: str(o.token_type) || 'Bearer',
    expiresAt: Number.isFinite(life) && life > 0 ? now + life * 1000 : null,
    // A refresh usually keeps the refresh token it was made with unless the server rotates it.
    refreshToken: str(o.refresh_token) || before?.refreshToken || '',
    scope: str(o.scope) || before?.scope || '',
    obtainedAt: now,
  };
}

/** A token is used until 30 s before it ends, so a request never leaves with one that dies on the way. */
export const tokenFresh = (t: TokenSet, now: number): boolean => t.expiresAt === null || t.expiresAt - now > 30_000;
