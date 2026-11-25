import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importAll, importText } from '../src/main/importers';
import { read } from '../src/main/postman';

const DIR = join(import.meta.dir, 'hoppscotch');
const [c, old] = importAll(readFileSync(join(DIR, 'collections.json'), 'utf8'));
const named = (n: string) => c.items.find((i) => i.name === n)!;

test('Hoppscotch: collections, folders, variables, headers from above', () => {
  expect(c.root).toMatchObject({ name: 'Hopp shop', description: 'Docs', auth: { mode: 'bearer', token: '{{token}}' } });
  expect(c.variables).toEqual([{ key: 'baseURL', value: 'http://127.0.0.1:47412/api', enabled: true, secret: false }, { key: 'token', value: '', enabled: true, secret: true }]);
  const g = named('Get user').request!;
  expect(g.url).toStartWith('{{baseURL}}/users/{{id}}?full=1&a={{who}}');
  expect(g.params.map((p) => [p.key, p.value, p.enabled])).toEqual([['full', '1', true], ['a', '{{who}}', true], ['off', '1', false]]);
  expect(g.headers.map((h) => [h.key, h.value])).toEqual([['X-Echo', '{{who}}'], ['X-Team', 'cats']]);
  expect(g.preRequest).toBe('bru.local("id", "42");\npw.env.set(\'made\', \'x\');');
  expect(named('Users').preRequest).toBe('bru.local("who", "ann");');
  expect(named('Off').request!.preRequest).toBeUndefined();
  expect(old.items[0].request!.url).toBe('http://127.0.0.1:47412/api/echo');
});

test('Hoppscotch: bodies, auth, GraphQL', () => {
  expect(JSON.parse(named('Create').request!.body.raw)).toEqual({ a: 'http://x', n: 1 });
  expect(named('Form').request!.body.fields.map((f) => [f.key, f.value, f.enabled])).toEqual([['a', '1', true], ['b', '2', false], ['c:d', 'x y', true]]);
  expect(named('Digest').request!.auth).toEqual({ mode: 'none' });
  expect(named('Off').request!.auth).toEqual({ mode: 'none' });
  expect(named('OAuth').request!.auth).toMatchObject({ mode: 'oauth2', oauth2: { grant: 'client_credentials', tokenUrl: 'https://id.test/token', clientSecret: '{{cs}}', clientAuth: 'body' } });
  expect(JSON.stringify(c.items)).not.toContain('SAVED-TOKEN');
  expect(named('GQL').request).toMatchObject({ method: 'POST', url: '{{baseURL}}/gql', body: { mode: 'graphql', raw: 'query { me }', variables: '{"a":1}' } });
  const n = c.notes!.join('\n');
  for (const s of ['Digest: digest auth is not supported', 'hopp.fetch', 'comments in its JSON body', '1 saved example was left out', 'secret variables (the export leaves their values out): token']) expect(n).toContain(s);
});

test('Hoppscotch: environments and globals, values that name another written out', async () => {
  const f = await read([join(DIR, 'environments.json'), join(DIR, 'collections.json')]);
  expect(f.environments.map((e) => e.name)).toEqual(['Staging']);
  expect(f.environments[0].variables.map((v) => [v.key, v.value, v.secret])).toEqual([['host', 'http://h', false], ['api', 'http://h/v1', false], ['key', '', true]]);
  expect(f.globals).toEqual([{ key: 'g1', value: '2', enabled: true, secret: false }]);
  expect(f.collections.map((x) => x.root.name)).toEqual(['Hopp shop', 'Old one']);
  expect(f.skipped).toEqual([]);
});

const pm = (item: unknown, more: object = {}) => importText(JSON.stringify({ info: { name: 'P', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item, ...more }));

test('Postman: an auth DialCatz does not have never becomes the collection\'s token', () => {
  const r = pm([{ name: 'A', request: { method: 'GET', url: 'http://x', auth: { type: 'awsv4', awsv4: [] } } }, { name: 'I', request: { method: 'GET', url: 'http://x', auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'implicit' }] } } }, { name: 'Plain', request: { method: 'GET', url: 'http://x' } }, { name: 'F', auth: { type: 'digest' }, item: [] }], { auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] } });
  expect(r.items.map((i) => (i.request?.auth ?? i.auth)!.mode)).toEqual(['none', 'none', 'inherit', 'none']);
  expect(r.notes).toEqual(['A: awsv4 auth is not supported; the auth was left empty', 'I: OAuth 2.0 implicit is not supported; the auth was left empty', 'Folder F: digest auth is not supported; the auth was left empty']);
});

test('Postman: path variables, URLs in parts, and what did not come along', () => {
  const r = pm([
    { name: 'V', request: { method: 'GET', url: { raw: '{{b}}/cats/:id/:x/:idle?y=:id', variable: [{ key: 'id', value: '7' }, { key: 'x', value: '' }], query: [{ key: 'y', value: ':id' }] } } },
    { name: 'P', request: { method: 'GET', url: { protocol: 'https', host: ['a', 'test'], port: '8', path: ['v1', ':id'], variable: [{ key: 'id', value: '1' }] } } },
    { name: 'M', request: { method: 'PURGE', url: 'http://x/{{$randomCity}}' }, response: [{}, {}], event: [{ listen: 'test', script: { exec: ["// pm.cookies in a comment", "pm.sendRequest('x'); const _x = require('lodash');"] } }] },
  ]);
  expect(r.items[0].request!.url).toBe('{{b}}/cats/7/{{x}}/:idle?y=:id');
  expect(r.items[1].request!.url).toBe('https://a.test:8/v1/1');
  expect(r.notes).toEqual(['M: the method PURGE is not supported; it became GET', 'M: {{$randomCity}} is not a value DialCatz makes', "M: its scripts use require('lodash'), pm.sendRequest, which DialCatz scripts do not have", '2 saved examples were left out']);
});
