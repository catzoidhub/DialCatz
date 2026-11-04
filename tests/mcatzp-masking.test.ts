import { expect, test } from 'bun:test';
import { MASK, maskBody, maskHeaders, maskText, maskUrl, maskValue, secretValues } from '../src/main/mcatzp/mask';
import type { Workspace } from '@shared/types';

const w = {
  id: 'w',
  name: 'W',
  serverId: null,
  items: [
    { id: 'r', kind: 'request', parentId: 'c', name: 'R', sort: 0, request: { method: 'GET', url: '', params: [], headers: [], body: { mode: 'none', raw: '', fields: [] }, auth: { mode: 'basic', username: 'alice', password: 'hunter22-pass' } } },
    { id: 'c', kind: 'collection', parentId: null, name: 'C', sort: 0, auth: { mode: 'bearer', token: 'plain-collection-tok' } },
  ],
  layout: {},
  environments: [{ id: 'e', name: 'E', variables: [{ key: 'theKey', value: 'SECRET-flagged-value', enabled: true, secret: true }, { key: 'db_password', value: 'named-not-flagged', enabled: true, secret: false }, { key: 'host', value: 'example.test', enabled: true, secret: false }] }],
  activeEnvironmentId: null,
  globals: [{ key: 'g', value: 'global-secret-val', enabled: true, secret: true }],
} as unknown as Workspace;
const secrets = secretValues([w]);

test('a known secret goes wherever it appears, under any name', () => {
  for (const v of ['SECRET-flagged-value', 'named-not-flagged', 'global-secret-val', 'plain-collection-tok', 'hunter22-pass']) {
    expect(maskText(`echo ${v} done`, secrets)).toBe(`echo ${MASK} done`);
    expect(maskBody(JSON.stringify({ harmless: v }), secrets)).not.toContain(v);
    expect(maskUrl(`https://a.test/x?q=${v}`, secrets)).not.toContain(v);
  }
  expect(maskText('host is example.test', secrets)).toBe('host is example.test');
});

test('also URL-encoded and in base64: Basic auth echoed back by a server', () => {
  const basic = Buffer.from('alice:hunter22-pass').toString('base64');
  expect(maskBody(JSON.stringify({ headers: { Echo: `Basic ${basic}` } }), secrets)).not.toContain(basic);
  const s = secretValues([{ ...w, globals: [{ key: 'g', value: 'a b/c+d=', enabled: true, secret: true }] }]);
  expect(maskText(`x=${encodeURIComponent('a b/c+d=')}`, s)).not.toContain(encodeURIComponent('a b/c+d='));
});

test('bodies with no helpful key names', () => {
  const body = maskBody(JSON.stringify([{ name: 'password', value: 'unknown-1' }, { key: 'API_KEY', val: 'unknown-2' }, ['Authorization', 'unknown-3'], { password: { nested: 'unknown-4' } }, { user: 'kept' }]), []);
  for (const v of ['unknown-1', 'unknown-2', 'unknown-3', 'unknown-4']) expect(body).not.toContain(v);
  expect(body).toContain('kept');
});

test('text bodies: forms, XML, tokens by their shape', () => {
  expect(maskBody('user=a&password=unknown-5&x=1', [])).toBe(`user=a&password=${MASK}&x=1`);
  expect(maskBody('<a><token>unknown-6</token></a>', [])).not.toContain('unknown-6');
  expect(maskBody('see eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdEFGH1234 end', [])).not.toContain('eyJ');
  expect(maskBody('postgres://u:unknown-7@host/db', [])).not.toContain('unknown-7');
  expect(maskBody('auth: Bearer abcdefgh12345678', [])).not.toContain('abcdefgh12345678');
  expect(maskText('const key = "unknown-9"; // key=unknown-10', [])).not.toContain('unknown-');
  expect(maskText('monkey=banana', [])).toBe('monkey=banana');
});

test('headers and query strings by name; variables stay readable', () => {
  expect(maskHeaders([['Authorization', 'Bearer real-value-here'], ['Accept', '*/*']], [])).toEqual([['Authorization', MASK], ['Accept', '*/*']]);
  expect(maskValue('Authorization', 'Bearer {{token}}', [])).toBe('Bearer {{token}}');
  expect(maskUrl('https://a.test/?api_key=unknown-8&page=2', [])).toBe(`https://a.test/?api_key=${MASK}&page=2`);
  expect(maskUrl('{{baseUrl}}/x?token={{token}}', [])).toBe('{{baseUrl}}/x?token={{token}}');
  expect(maskText('"token": "{{token}}"', [])).toBe('"token": "{{token}}"');
});
