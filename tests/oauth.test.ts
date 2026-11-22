import { expect, test } from 'bun:test';
import { authorizeUrl, loopback, oauthProblem, readTokenResponse, tokenFresh, tokenIdentity, tokenRequest } from '../src/shared/oauth';
import { buildVars, resolveOAuth, toWire } from '../src/shared/request';
import { newRequest, OAUTH_REDIRECT, type OAuthSettings } from '../src/shared/types';
import { openApiAuth } from '../src/main/importers';

const code: OAuthSettings = { grant: 'authorization_code', authUrl: 'https://id.example.com/authorize', tokenUrl: 'https://id.example.com/token', clientId: 'app', clientSecret: 's3cret', scope: 'read write', pkce: true, redirectUri: OAUTH_REDIRECT };

test('settings: variables are filled, defaults set, each grant keeps only its own fields', () => {
  const vars = buildVars([{ key: 'id', value: 'my-app', enabled: true, secret: false }, { key: 'sec', value: 'shh', enabled: true, secret: true }]);
  const r = resolveOAuth({ grant: 'client_credentials', tokenUrl: ' https://x/token ', clientId: '{{id}}', clientSecret: '{{sec}}', username: 'ignored' }, vars);
  expect(r).toEqual({ grant: 'client_credentials', tokenUrl: 'https://x/token', clientId: 'my-app', clientSecret: 'shh', scope: '', audience: '', clientAuth: 'basic' });
  expect(resolveOAuth({ grant: 'authorization_code', tokenUrl: 't', clientId: 'c' }, vars).redirectUri).toBe(OAUTH_REDIRECT);
  expect(resolveOAuth({ grant: 'authorization_code', tokenUrl: 't', clientId: 'c' }, vars).pkce).toBe(true);
});

test('what is wrong is said in words; a variable without a value is caught', () => {
  expect(oauthProblem(code)).toBeNull();
  expect(oauthProblem({ ...code, tokenUrl: '' })).toContain('token URL');
  expect(oauthProblem({ ...code, clientId: '{{clientId}}' })).toContain('{{variable}} without a value');
  expect(oauthProblem({ ...code, redirectUri: 'https://example.com/cb' })).toContain('on this computer');
  expect(oauthProblem({ grant: 'client_credentials', tokenUrl: 'https://x/t', clientId: 'a' })).toContain('client secret');
  expect(loopback('http://localhost:8123/cb')).toEqual({ host: '127.0.0.1', port: 8123, path: '/cb' });
  expect(loopback('http://127.0.0.1/cb')).toBeNull();
});

test('the sign-in address carries state and the PKCE challenge', () => {
  const u = new URL(authorizeUrl(code, 'st4te', 'ch4llenge'));
  expect(u.origin + u.pathname).toBe('https://id.example.com/authorize');
  expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'app', redirect_uri: OAUTH_REDIRECT, scope: 'read write', state: 'st4te', code_challenge: 'ch4llenge', code_challenge_method: 'S256' });
  expect(new URL(authorizeUrl({ ...code, authUrl: 'https://id.example.com/authorize?tenant=a' }, 's', null)).searchParams.get('tenant')).toBe('a');
});

test('the token request: Basic header by default, body on request, a public client in the body', () => {
  const a = tokenRequest(code, { kind: 'code', code: 'abc', verifier: 'ver' });
  expect(a.headers).toContainEqual(['Authorization', `Basic ${btoa('app:s3cret')}`]);
  expect(Object.fromEntries(new URLSearchParams(a.body))).toEqual({ grant_type: 'authorization_code', code: 'abc', redirect_uri: OAUTH_REDIRECT, code_verifier: 'ver' });
  const b = tokenRequest({ ...code, clientAuth: 'body' }, { kind: 'refresh', refreshToken: 'r1' });
  expect(b.headers.some(([k]) => k === 'Authorization')).toBe(false);
  expect(Object.fromEntries(new URLSearchParams(b.body))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', scope: 'read write', client_id: 'app', client_secret: 's3cret' });
  const c = tokenRequest({ ...code, clientSecret: '' }, { kind: 'code', code: 'abc', verifier: 'ver' });
  expect(new URLSearchParams(c.body).get('client_id')).toBe('app');
  const d = tokenRequest({ grant: 'password', tokenUrl: 't', clientId: 'a', clientSecret: 'p:w d', username: 'u', password: 'p&=', audience: 'api' }, { kind: 'password' });
  expect(new URLSearchParams(d.body).get('password')).toBe('p&=');
  expect(new URLSearchParams(d.body).get('audience')).toBe('api');
  // RFC 6749 §2.3.1: the secret is form-encoded inside the Basic header.
  expect(d.headers).toContainEqual(['Authorization', `Basic ${btoa('a:p%3Aw+d')}`]);
});

test('the answer: JSON, a form (GitHub), errors in the server\'s words; a refresh keeps its refresh token', () => {
  const t = readTokenResponse(200, '{"access_token":"A","token_type":"bearer","expires_in":3600,"refresh_token":"R","scope":"read"}', 1000);
  expect(t).toEqual({ accessToken: 'A', tokenType: 'bearer', expiresAt: 3_601_000, refreshToken: 'R', scope: 'read', obtainedAt: 1000 });
  expect(readTokenResponse(200, 'access_token=G&scope=repo&token_type=bearer', 0).accessToken).toBe('G');
  expect(readTokenResponse(200, '{"access_token":"B"}', 5, t).refreshToken).toBe('R');
  expect(readTokenResponse(200, '{"access_token":"B"}', 5).expiresAt).toBeNull();
  expect(() => readTokenResponse(400, '{"error":"invalid_client","error_description":"Bad secret"}', 0)).toThrow('400 (invalid_client: Bad secret)');
  expect(() => readTokenResponse(200, '{"error":"invalid_grant"}', 0)).toThrow('invalid_grant');
  expect(() => readTokenResponse(200, '{}', 0)).toThrow('without an access_token');
  expect(tokenFresh(t, 3_601_000 - 31_000)).toBe(true);
  expect(tokenFresh(t, 3_601_000 - 29_000)).toBe(false);
});

test('two settings share a token only when who, where and what match; the secret is not part of it', () => {
  expect(tokenIdentity(code)).toBe(tokenIdentity({ ...code, clientSecret: 'other', pkce: false }));
  expect(tokenIdentity(code)).not.toBe(tokenIdentity({ ...code, scope: 'read' }));
  expect(tokenIdentity(code)).not.toContain('s3cret');
});

test('a request goes out with the token it was given, under the chosen prefix; without one, with nothing', () => {
  const spec = { ...newRequest(), url: 'https://api.example.com/me' };
  const vars = buildVars([]);
  expect(toWire(spec, vars, { mode: 'oauth2', oauth2: code, token: 'TOK' }).headers).toContainEqual(['Authorization', 'Bearer TOK']);
  expect(toWire(spec, vars, { mode: 'oauth2', oauth2: { ...code, headerPrefix: 'token' }, token: 'TOK' }).headers).toContainEqual(['Authorization', 'token TOK']);
  expect(toWire(spec, vars, { mode: 'oauth2', oauth2: code }).headers.some(([k]) => k === 'Authorization')).toBe(false);
});

test('OpenAPI: the scheme the document asks for becomes the collection\'s auth, secrets as variables', () => {
  const doc = (schemes: Record<string, unknown>, security?: unknown) => ({ openapi: '3.0.3', components: { securitySchemes: schemes }, ...(security ? { security } : {}) });
  expect(openApiAuth(doc({ b: { type: 'http', scheme: 'bearer' } }), '')).toEqual({ mode: 'bearer', token: '{{token}}' });
  expect(openApiAuth(doc({ k: { type: 'apiKey', in: 'header', name: 'X-Key' } }), '')).toEqual({ mode: 'apikey', key: 'X-Key', value: '{{apiKey}}', in: 'header' });
  const o = openApiAuth(doc({ k: { type: 'apiKey', in: 'header', name: 'X-Key' }, o: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: '/oauth/authorize', tokenUrl: '/oauth/token', scopes: { read: '', write: '' } } } } }, [{ o: ['read'] }]), 'https://api.example.com/v1');
  expect(o).toEqual({ mode: 'oauth2', oauth2: { grant: 'authorization_code', tokenUrl: 'https://api.example.com/oauth/token', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scope: 'read', authUrl: 'https://api.example.com/oauth/authorize' } });
  // Two schemes and no top-level security: no guess.
  expect(openApiAuth(doc({ a: { type: 'http', scheme: 'bearer' }, b: { type: 'http', scheme: 'basic' } }), '')).toBeNull();
  // Swagger 2
  expect(openApiAuth({ swagger: '2.0', securityDefinitions: { o: { type: 'oauth2', flow: 'application', tokenUrl: 'https://id/token', scopes: { api: '' } } } }, '')?.oauth2).toEqual({ grant: 'client_credentials', tokenUrl: 'https://id/token', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scope: 'api' });
  expect(openApiAuth(doc({ i: { type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://id/a', scopes: {} } } } }), '')).toBeNull();
});
