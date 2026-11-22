import { expect, test } from 'bun:test';
import { hostMatches, identityFor, setIdentityFinder } from '../src/main/tlsidentity';
import { importText } from '../src/main/importers';

test('a client certificate goes to its host, a wildcard to the subdomains, a port only to that port', () => {
  expect(hostMatches('api.example.com', 'api.example.com', '443')).toBe(true);
  expect(hostMatches('API.Example.com', 'api.example.com', '8443')).toBe(true);
  expect(hostMatches('api.example.com', 'www.example.com', '443')).toBe(false);
  expect(hostMatches('*.example.com', 'api.example.com', '443')).toBe(true);
  expect(hostMatches('*.example.com', 'a.b.example.com', '443')).toBe(true);
  // The wildcard is for names below it: not the bare domain, not a look-alike.
  expect(hostMatches('*.example.com', 'example.com', '443')).toBe(false);
  expect(hostMatches('*.example.com', 'badexample.com', '443')).toBe(false);
  expect(hostMatches('api.example.com:8443', 'api.example.com', '8443')).toBe(true);
  expect(hostMatches('api.example.com:8443', 'api.example.com', '443')).toBe(false);
  expect(hostMatches('https://api.example.com/path', 'api.example.com', '443')).toBe(true);
  expect(hostMatches('', 'api.example.com', '443')).toBe(false);
});

test('only TLS connections ask for one, with the default port filled in', () => {
  const asked: string[] = [];
  setIdentityFinder((host, port) => (asked.push(`${host}:${port}`), { passphrase: 'x' }));
  expect(identityFor('https://API.example.com/a')).toEqual({ passphrase: 'x' });
  expect(identityFor('wss://ws.example.com:9000/socket')).toEqual({ passphrase: 'x' });
  expect(identityFor('grpcs://rpc.example.com:8443')).toEqual({ passphrase: 'x' });
  expect(identityFor('http://api.example.com')).toEqual({});
  expect(identityFor('not a url')).toEqual({});
  expect(asked).toEqual(['api.example.com:443', 'ws.example.com:9000', 'rpc.example.com:8443']);
  setIdentityFinder(() => undefined);
});

test('a Postman file field keeps its file\'s name (a relative path whole), never a path on someone else\'s disk', () => {
  const pm = { info: { name: 'F', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [{ name: 'Up', request: { method: 'POST', url: 'https://x.test/up', body: { mode: 'formdata', formdata: [{ key: 'a', type: 'file', src: 'fixtures/cat.png' }, { key: 'b', type: 'file', src: '/Users/someone/secret/dog.png' }, { key: 'c', type: 'file', src: 'C:\\\\Users\\\\me\\\\x.bin' }, { key: 'd', value: 'text', type: 'text' }] } } }, { name: 'Raw', request: { method: 'PUT', url: 'https://x.test/raw', body: { mode: 'file', file: { src: '/tmp/a.bin' } } } }] };
  const items = importText(JSON.stringify(pm)).items;
  expect(items[0].request!.body.fields.map((f) => [f.key, f.type ?? 'text', f.value])).toEqual([
    ['a', 'file', 'fixtures/cat.png'],
    ['b', 'file', 'dog.png'],
    ['c', 'file', 'x.bin'],
    ['d', 'text', 'text'],
  ]);
  expect(items[0].request!.body.fields.some((f) => f.src)).toBe(false);
  expect(items[1].request!.body.mode).toBe('binary');
  expect(items[1].request!.body.file).toBeUndefined();
});
