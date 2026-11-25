import { afterAll, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseBru } from '../src/main/brulang';
import { findCollections, parts, readCollection } from '../src/main/bruno';
import { brunoApply, brunoDiff, newVariables } from '../src/main/brunosync';
import { exportCollection } from '../src/main/importers';
import { applyPatch, readPatch } from '../src/shared/scriptpatch';
import type { TreeItem } from '../src/shared/types';

const DIR = join(import.meta.dir, 'bruno');
const bru = readCollection(join(DIR, 'bru'));
const yml = readCollection(join(DIR, 'yml'));
const named = (c: typeof bru, n: string) => c.items.find((i) => i.name === n)!;

test('.bru: blocks, quoted keys, disabled rows, multiline values, text with braces', () => {
  const f = parseBru("headers {\n  \"a:b \\\"c\\\"\": v:1\n  ~off: x\n  @description('''\n    two\n    lines\n  ''')\n  k: '''\n    one\n      two\n  '''\n}\n\nbody:json {\n  {\n    \"a\": { }\n  }\n}\r\n\nassert {\n  res('a:b').x[0]: eq a: b\n}\nvars:secret [\n  a,\n  ~b\n]\n");
  expect(f.dict.get('headers')).toMatchObject([{ key: 'a:b "c"', value: 'v:1', enabled: true }, { key: 'off', enabled: false }, { key: 'k', value: 'one\n  two', description: 'two\nlines' }]);
  expect(f.text.get('body:json')).toBe('{\n  "a": { }\n}');
  expect(f.dict.get('assert')).toMatchObject([{ key: "res('a:b').x[0]", value: 'eq a: b' }]);
  expect(f.list.get('vars:secret')).toEqual([{ name: 'a', enabled: true }, { name: 'b', enabled: false }]);
});

test('.bru collection: order, headers from above, path parameters, auth, environments', () => {
  expect(findCollections(DIR).map((f) => f.format)).toEqual(['bru', 'yml']);
  const top = bru.items.filter((i) => i.parentId === bru.root.id).sort((a, b) => a.sort - b.sort);
  expect(top.map((i) => i.name)).toEqual(['Users', 'Create', 'Upload', 'Digest']);
  expect(bru.root).toMatchObject({ name: 'Shop bru', auth: { mode: 'bearer', token: '{{token}}' }, description: 'Shop docs' });
  const g = named(bru, 'Get user').request!;
  expect(g.url).toContain('{{baseUrl}}/users/42?full=1');
  expect(g.params).toMatchObject([{ key: 'full', enabled: true }, { key: 'skip', enabled: false }]);
  expect(g.headers.map((h) => [h.key, h.value, h.enabled])).toEqual([['X-Off', '1', false], ['X-Quoted', 'v', true], ['X-Both', 'folder', true], ['X-Team', 'cats', true]]);
  expect(g.auth.mode).toBe('inherit');
  expect(named(bru, 'Get user').description).toBe('# Get one\n{\n  braces }');
  expect(named(bru, 'Create').request!.auth).toEqual({ mode: 'basic', username: 'john', password: '{{SHOP_PASS}}' });
  expect(named(bru, 'Upload').request!.body.fields).toMatchObject([{ key: 'title', value: 'hi' }, { key: 'pic', type: 'file', value: 'pics/cat.png' }]);
  const e = bru.environments[0];
  expect(Object.fromEntries(e.variables.map((v) => [v.key, v.value]))).toEqual({ host: 'http://127.0.0.1:47412', baseUrl: 'http://127.0.0.1:47412/api', fromEnv: '{{SHOP_KEY}}', off: 'x', token: '', old: '', region: 'eu', SHOP_PASS: '', SHOP_KEY: '' });
  expect(e.variables.filter((v) => v.secret).map((v) => v.key)).toEqual(['token', 'old', 'SHOP_PASS', 'SHOP_KEY']);
});

test('what DialCatz has no place for is said', () => {
  const n = bru.notes.join('\n');
  expect(n).toContain("Upload: its scripts use require('fs')");
  expect(n).toContain('Digest: digest auth is not supported');
  expect(n).toContain('Upload: choose its file again (cat.png)');
  expect(n).toContain('SHOP_PASS');
});

test('OpenCollection YAML: HTTP, GraphQL with OAuth, gRPC, WebSocket', () => {
  expect(yml.notes.filter((x) => !/Fill in|proto/.test(x))).toEqual([]);
  const g = named(yml, 'Get user').request!;
  expect(g.url).toBe('{{baseUrl}}/users/42?full=1');
  expect(g.headers.map((h) => [h.key, h.enabled])).toEqual([['X-Echo', true], ['X-Off', false], ['X-Team', true]]);
  expect(g.tests).toContain('bru.assert("res.status eq 200", () => (res.status), "eq", "200");');
  expect(g.tests).toContain('bru.capture("userName", () => (res.body.name));');
  const q = named(yml, 'Query').request!;
  expect(q.body).toMatchObject({ mode: 'graphql', raw: 'query { me { id } }', variables: '{"n": 1}' });
  expect(q.auth).toMatchObject({ mode: 'oauth2', oauth2: { grant: 'client_credentials', tokenUrl: 'https://id.test/token', clientId: 'c', clientSecret: '{{secret}}', scope: 'read', clientAuth: 'basic' } });
  expect(named(yml, 'Call').request).toMatchObject({ url: 'grpcs://grpc.test:443', grpc: { service: 'pkg.Greeter', method: 'Hello' } });
  expect(named(yml, 'Sock').request).toMatchObject({ url: 'wss://ws.test/x', wsMessage: { text: '{"hi":1}' } });
});

const tmp = mkdtempSync(join(tmpdir(), 'dc-bruno-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('importing again: Bruno\'s changes, the user\'s edits kept, gone items, new variables', () => {
  const dir = join(tmp, 'c');
  cpSync(join(DIR, 'bru'), dir, { recursive: true });
  // What macOS leaves beside files in an archive is no environment or request.
  writeFileSync(join(dir, 'environments', '._Local.bru'), '\0\x05\x16');
  writeFileSync(join(dir, '._Create.bru'), '\0\x05\x16');
  const first = readCollection(dir);
  expect([first.environments.length, first.items.length]).toEqual([bru.environments.length, bru.items.length]);
  let items: TreeItem[] = [first.root, ...first.items];
  expect(brunoDiff(items, first.root, readCollection(dir)).changes).toEqual([]);
  // Bruno: a header and the tests change, one request goes, a folder with a request comes, a variable comes.
  const file = join(dir, 'users', 'Get user.bru');
  writeFileSync(file, readFileSync(file, 'utf8').replace('~X-Off: 1', 'X-New: 1').replace('"query"', '"query 2"'));
  rmSync(join(dir, 'Digest.bru'));
  cpSync(join(dir, 'users'), join(dir, 'more'), { recursive: true });
  writeFileSync(join(dir, 'environments', 'Local.bru'), 'vars {\n  host: other\n  fresh: 1\n}\n');
  // Here: the user edited the tests and their own request.
  items = items.map((i) => (i.name === 'Get user' ? { ...i, request: { ...i.request!, tests: 'mine' } } : i));
  const fresh = readCollection(dir);
  const d = brunoDiff(items, first.root, fresh);
  expect(d.changes.map((c) => [c.kind, c.key]).sort()).toEqual([['added', 'folder:more'], ['added', 'request:more/Get user.bru'], ['changed', 'request:users/Get user.bru'], ['removed', 'request:Digest.bru']]);
  expect(d.changes.find((c) => c.kind === 'changed')).toMatchObject({ parts: ['headers', 'tests'], kept: ['tests'] });
  const v = newVariables([{ ...first.environments[0] }], fresh.environments);
  expect(v.says).toEqual(['Local: fresh']);
  expect(v.save[0].variables.find((x) => x.key === 'host')!.value).toBe('http://127.0.0.1:47412');
  const out = brunoApply(items, first.root, fresh, { add: ['request:more/Get user.bru'], update: ['request:users/Get user.bru'], remove: [] });
  expect([out.added, out.updated, out.removed, out.remove]).toEqual([1, 1, 0, []]);
  const after = [...items.filter((i) => !out.save.some((s) => s.id === i.id)), ...out.save];
  const mine = after.find((i) => i.bruno?.file === 'users/Get user.bru')!;
  expect(mine.request!.tests).toBe('mine');
  expect(mine.request!.headers.some((h) => h.key === 'X-New')).toBe(true);
  const added = after.find((i) => i.bruno?.file === 'more/Get user.bru')!;
  expect(after.find((i) => i.id === added.parentId)!.parentId).toBe(first.root.id);
  // Kept though gone from Bruno: the user's own from now on. And nothing is offered twice.
  expect(after.find((i) => i.name === 'Digest')!.bruno).toBeUndefined();
  expect(brunoDiff(after, after.find((i) => i.id === first.root.id)!, fresh).changes).toEqual([]);
});

test('where it came from stays on this computer', () => {
  expect(JSON.stringify(exportCollection([bru.root, ...bru.items], bru.root.id))).not.toContain('"bruno":');
  expect(parts(bru.root)).toEqual(bru.root.bruno!.base);
});

test('a script\'s changes to the request: only well-formed ones', () => {
  const p = readPatch({ method: 'PUT', headers: { A: '{{x}}', 'bad name': '1', B: 'a\r\nb', C: null }, body: 5, extra: 1 });
  expect(p).toEqual({ method: 'PUT', headers: { A: '{{x}}', C: null } });
  expect(applyPatch({ method: 'GET', url: 'u', headers: [['a', '0'], ['c', '1'], ['d', '2']] }, [p!], new Map([['x', 'y']]))).toMatchObject({ method: 'PUT', headers: [['A', 'y'], ['d', '2']] });
});
