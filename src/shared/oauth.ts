import { OAUTH_REDIRECT, type OAuthDevicePrompt, type OAuthDiscovery, type OAuthSettings } from './types';

/**
 * OAuth 2.0 (#100), the parts that are pure text: what is asked of the token address (RFC 6749; PKCE: RFC 7636), how
 * its answer is read, and what makes two settings the same token. The main process (main/oauth.ts) and the CLI do the
 * sending, the browser and the keeping.
 *   authorization_code   browser → authUrl?response_type=code&client_id&redirect_uri&scope&state[&code_challenge…]
 *                        → loopback redirect with ?code → POST tokenUrl grant_type=authorization_code&code&redirect_uri[&code_verifier]
 *   client_credentials   POST tokenUrl grant_type=client_credentials[&scope][&audience]
 *   password             POST tokenUrl grant_type=password&username&password[&scope]
 *   device_code          POST deviceUrl client_id[&scope] → a code to type in at verification_uri → POST tokenUrl
 *                        grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code, asked again every
 *                        `interval` seconds while the answer is authorization_pending (RFC 8628)
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
  for (const [name, value] of [['token URL', c.tokenUrl], ['client ID', c.clientId], ['client secret', c.clientSecret], ['auth URL', c.authUrl], ['device authorization URL', c.deviceUrl], ['username', c.username], ['password', c.password]] as const)
    if (open(value)) return `The ${name} has a {{variable}} without a value: fill it in your environment`;
  if (!c.tokenUrl) return 'Fill in the token URL';
  if (!web(c.tokenUrl)) return 'The token URL starts with http:// or https://';
  if (!c.clientId) return 'Fill in the client ID';
  if (c.grant === 'authorization_code') {
    if (!c.authUrl) return 'Fill in the auth URL (where you sign in)';
    if (!web(c.authUrl)) return 'The auth URL starts with http:// or https://';
    if (!loopback(c.redirectUri || OAUTH_REDIRECT)) return 'The redirect URI must be on this computer: http://127.0.0.1:<port>/… or http://localhost:<port>/…';
  }
  if (c.grant === 'device_code') {
    if (!c.deviceUrl) return 'Fill in the device authorization URL';
    if (!web(c.deviceUrl)) return 'The device authorization URL starts with http:// or https://';
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
export const tokenIdentity = (c: OAuthSettings): string => JSON.stringify([c.grant, c.tokenUrl, c.authUrl ?? c.deviceUrl ?? '', c.clientId, c.scope ?? '', c.audience ?? '', c.grant === 'password' ? (c.username ?? '') : '']);

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

export type TokenAsk = { kind: 'code'; code: string; verifier: string | null } | { kind: 'client' } | { kind: 'password' } | { kind: 'refresh'; refreshToken: string } | { kind: 'device'; deviceCode: string };

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
  } else if (ask.kind === 'device') {
    f.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');
    f.set('device_code', ask.deviceCode);
  } else {
    f.set('grant_type', 'refresh_token');
    f.set('refresh_token', ask.refreshToken);
  }
  const granted = ask.kind === 'code' || ask.kind === 'device'; // the scope was fixed when the person agreed
  if (!granted && c.scope) f.set('scope', c.scope);
  if (!granted && ask.kind !== 'refresh' && c.audience) f.set('audience', c.audience);
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

/** The POST that starts a device sign-in (RFC 8628 §3.1). */
export function deviceRequest(c: OAuthSettings): { headers: [string, string][]; body: string } {
  const f = new URLSearchParams();
  if (c.scope) f.set('scope', c.scope);
  if (c.audience) f.set('audience', c.audience);
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

/** What the device address answered: the code to type in, where, and how often to ask for the token. */
export function readDeviceResponse(status: number, text: string, now: number): OAuthDevicePrompt & { deviceCode: string; intervalMs: number } {
  let o: Record<string, unknown> = {};
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON: said below */
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
  if (o.error || status >= 400) throw new OAuthError(`The device address answered ${status}${o.error ? ` (${[str(o.error), str(o.error_description)].filter(Boolean).join(': ')})` : ''}`, str(o.error));
  const deviceCode = str(o.device_code);
  const userCode = str(o.user_code);
  // Google's older answer calls it verification_url.
  const verificationUri = str(o.verification_uri) || str(o.verification_url);
  if (!deviceCode || !userCode || !verificationUri) throw new OAuthError(`The device address answered ${status} without a code to type in`, '');
  const life = Number(o.expires_in);
  const every = Number(o.interval);
  return { deviceCode, userCode, verificationUri, verificationUriComplete: str(o.verification_uri_complete), expiresAt: now + (Number.isFinite(life) && life > 0 ? life : 600) * 1000, intervalMs: (Number.isFinite(every) && every > 0 ? every : 5) * 1000 };
}

/** Where a provider describes itself, tried in this order: OpenID Connect's document, then OAuth's own (RFC 8414). */
export function discoveryUrls(input: string): string[] {
  const text = input.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(text)) throw new Error('The issuer starts with http:// or https://');
  if (/\/\.well-known\//.test(text)) return [text];
  const u = new URL(text);
  const path = u.pathname.replace(/\/+$/, '');
  return [`${u.origin}${path}/.well-known/openid-configuration`, `${u.origin}/.well-known/oauth-authorization-server${path}`];
}

export function readDiscovery(text: string): OAuthDiscovery {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('That address does not answer with a discovery document (JSON)');
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const d: OAuthDiscovery = { issuer: str(o.issuer), authUrl: str(o.authorization_endpoint), tokenUrl: str(o.token_endpoint), deviceUrl: str(o.device_authorization_endpoint), scopes: Array.isArray(o.scopes_supported) ? o.scopes_supported.filter((x): x is string => typeof x === 'string').slice(0, 200) : [] };
  if (!d.tokenUrl) throw new Error('The discovery document names no token_endpoint');
  return d;
}

/** An answer that said no, with the server's own error code (authorization_pending, slow_down, access_denied …). */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
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
    throw new OAuthError(`The token address answered ${status}${what ? ` (${what})` : text.trim() ? `: ${text.trim().slice(0, 200)}` : ''}`, str(o.error));
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
