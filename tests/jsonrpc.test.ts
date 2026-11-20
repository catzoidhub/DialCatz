import { expect, test } from 'bun:test';
import { rpcEnvelope, rpcReplies } from '../src/shared/jsonrpc';
import { newRequest, type RequestSpec } from '../src/shared/types';
import { toWire } from '../src/shared/request';

test('a call, a notification and a batch', () => {
  expect(rpcEnvelope({ method: 'user.get', params: '{"id":1}' })).toEqual({ jsonrpc: '2.0', method: 'user.get', params: { id: 1 }, id: 1 });
  expect(rpcEnvelope({ method: 'log', params: '', notify: true })).toEqual({ jsonrpc: '2.0', method: 'log' });
  expect(rpcEnvelope({ method: '', params: '[{"method":"a","params":[1]},{"method":"b","notify":true}]', batch: true })).toEqual([
    { jsonrpc: '2.0', method: 'a', params: [1], id: 1 },
    { jsonrpc: '2.0', method: 'b' },
  ]);
  expect(() => rpcEnvelope({ method: 'x', params: '{bad' })).toThrow('not JSON');
});

test('the wire body fills variables and sets JSON', () => {
  const spec: RequestSpec = { ...newRequest(), method: 'POST', url: 'http://x/rpc', body: { mode: 'jsonrpc', raw: '{"id":"{{uid}}"}', fields: [], rpcMethod: 'user.{{op}}' } };
  const w = toWire(spec, new Map([['uid', '42'], ['op', 'get']]));
  expect(JSON.parse(w.body!)).toEqual({ jsonrpc: '2.0', method: 'user.get', params: { id: '42' }, id: 1 });
  expect(w.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1]).toBe('application/json');
});

test('replies are matched to their calls by id, errors explained', () => {
  const sent = JSON.stringify([{ jsonrpc: '2.0', method: 'a', id: 1 }, { jsonrpc: '2.0', method: 'b', id: 2 }]);
  const res = JSON.stringify([{ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } }, { jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  expect(rpcReplies(sent, res)).toEqual([
    { id: 2, method: 'b', ok: false, error: { code: -32601, message: 'nope', meaning: 'Method not found' } },
    { id: 1, method: 'a', ok: true, result: { ok: true } },
  ]);
  expect(rpcReplies(sent, '{"hello":1}')).toBeNull();
});
