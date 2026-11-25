import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importAll } from '../src/main/importers';
import { read } from '../src/main/postman';
import { fromYaak, readYaakFolder } from '../src/main/yaak';

const file = (...p: string[]) => readFileSync(join(import.meta.dir, ...p), 'utf8');
const [ins] = importAll(file('insomnia', 'shop.yaml'));
const [yk] = importAll(file('yaak', 'export.json'));
const req = (c: typeof ins, n: string) => c.items.find((i) => i.name === n)!.request!;

test('Insomnia v5: order, templates, headers, path parameters, environments', () => {
  expect(ins.root).toMatchObject({ name: 'Ins shop', description: 'Docs', auth: { mode: 'bearer', token: '{{token}}' } });
  expect(ins.items.filter((i) => i.parentId === ins.root.id).sort((a, b) => a.sort - b.sort).map((i) => i.name)).toEqual(['Users', 'Second', 'GQL', 'Form', 'Tag', 'Sock', 'SIO', 'Call']);
  const g = req(ins, 'Get user');
  expect(g.url).toStartWith('{{base_url}}/users/42?full=1');
  expect(g.auth.mode).toBe('inherit');
  expect(g.headers.map((h) => [h.key, h.value])).toEqual([['X-Echo', '{{who}}'], ['X-Team', 'cats']]);
  expect(ins.items.find((i) => i.name === 'Users')!.preRequest).toBe('bru.local("who", "ann");');
  expect(req(ins, 'Second').body.raw).toBe('{"a":"{{nested.deep}}","b":"{{$guid}}","c":"{{list.1}}"}');
  expect(req(ins, 'Second').auth).toEqual({ mode: 'basic', username: 'u', password: '{{pass-word}}' });
  expect(ins.environments!.map((e) => e.name)).toEqual(['Staging', 'Local']);
  const staging = Object.fromEntries(ins.environments![0].variables.map((v) => [v.key, v.value]));
  expect(staging).toEqual({ base_url: 'http://staging/v1', host: 'http://staging', 'nested.deep': 'd', 'list.0': 'one', 'list.1': 'two', token: 'tk', 'pass-word': 'p', hidden: '' });
  expect(ins.environments![0].variables.find((v) => v.key === 'hidden')!.secret).toBe(true);
});

test('Insomnia v5: bodies, sockets, gRPC, and what is said', () => {
  expect(req(ins, 'GQL')).toMatchObject({ auth: { mode: 'none' }, body: { mode: 'graphql', raw: 'query { me }', variables: '{\n  "a": 1\n}' } });
  expect(req(ins, 'Form').body.fields).toMatchObject([{ key: 't', value: 'v' }, { key: 'f', type: 'file', value: 'cat.png' }]);
  expect(req(ins, 'Form').auth).toEqual({ mode: 'none' });
  expect(req(ins, 'Tag').auth).toMatchObject({ mode: 'apikey', in: 'query' });
  expect(req(ins, 'Sock')).toMatchObject({ url: 'wss://ws.test/x', wsMessage: { text: 'hi' } });
  expect(req(ins, 'SIO')).toMatchObject({ url: 'wss://s.test/socket.io/', socketIo: true, wsMessage: { text: '{"x":1}', event: 'ping' } });
  expect(req(ins, 'Call')).toMatchObject({ url: 'grpc://grpc.test:50051', grpc: { service: 'pkg.Svc', method: 'Hello' }, body: { raw: '{"n":1}' } });
  const n = ins.notes!.join('\n');
  for (const s of ['Form: digest auth is not supported', 'choose its file again (cat.png)', 'the template tag {% response … %} is not supported', 'Call: choose its .proto file again', 'Second: its scripts use insomnia.sendRequest', 'hidden']) expect(n).toContain(s);
  expect(JSON.stringify(ins)).not.toContain('s3cr3t');
});

test('Insomnia v4: workspaces, folders, payloads', () => {
  const list = importAll(file('insomnia', 'old.json'));
  expect(list.map((c) => c.root.name)).toEqual(['Old ins']);
  expect(list[0].items.map((i) => i.name)).toEqual(['F', 'A', 'W']);
  expect(req(list[0], 'A')).toMatchObject({ url: '{{url}}/api/echo', auth: { mode: 'inherit' } });
  expect(req(list[0], 'W').wsMessage).toEqual({ text: 'hello' });
  expect(list[0].environments!.map((e) => e.name)).toEqual(['Old ins']);
  expect(list[0].notes).toContain('Its unit test suites were left out');
});

test('Yaak: the JSON export', () => {
  expect(yk.root).toMatchObject({ name: 'Yaak shop', auth: { mode: 'bearer', token: '{{token}}' } });
  const g = req(yk, '{{base_url}}/users/:id');
  expect(g.url).toStartWith('{{base_url}}/users/42?full=1');
  expect(g.headers.map((h) => h.key)).toEqual(['X-Echo', 'X-Team']);
  expect(req(yk, 'Create').auth).toEqual({ mode: 'basic', username: 'u', password: '' });
  expect(req(yk, 'Create').body.raw).toContain('"id":"{{$guid}}"');
  expect(req(yk, 'GQL')).toMatchObject({ auth: { mode: 'none' }, body: { mode: 'graphql', raw: 'query { me }' } });
  expect(req(yk, 'Call')).toMatchObject({ url: 'grpcs://g.test', grpc: { service: 'pkg.Svc', method: 'Hello' } });
  expect(req(yk, 'Sock')).toMatchObject({ url: 'wss://w.test', wsMessage: { text: 'hi' } });
  expect(yk.environments![0].variables.map((v) => [v.key, v.value, v.secret])).toEqual([['base_url', 'http://127.0.0.1:47412/api', false], ['token', 'tk', false], ['sealed', '', true]]);
  const n = yk.notes!.join('\n');
  for (const s of ['awsv4 auth is not supported', 'response.body.path(…) is not supported', 'encrypted in Yaak', 'sealed']) expect(n).toContain(s);
});

test('Yaak: the folder it syncs to is the same collection', () => {
  const [c] = fromYaak(readYaakFolder(join(import.meta.dir, 'yaak', 'sync'))!);
  const shape = (x: { items: { name: string; request?: unknown }[] }) => x.items.map((i) => [i.name, JSON.stringify(i.request ?? null)]);
  expect(shape(c)).toEqual(shape(yk));
  expect(readYaakFolder(join(import.meta.dir, 'bruno'))).toBeNull();
});

test('picked files and folders land in one list', async () => {
  const d = import.meta.dir;
  const f = await read([join(d, 'insomnia'), join(d, 'yaak', 'sync'), join(d, 'yaak', 'export.json')]);
  expect(f.collections.map((c) => c.root.name)).toEqual(['Old ins', 'Ins shop', 'Yaak shop', 'Yaak shop']);
  expect(f.skipped).toEqual([]);
});
