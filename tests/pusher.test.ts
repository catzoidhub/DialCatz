import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { authText, clientEventFrame, pusherDecode, pusherUrl, subscribeFrame } from '../src/shared/pusher';

test('the address: the key from /app/<key>, protocol 7 added', () => {
  const r = pusherUrl('ws://localhost:8080/app/my-key');
  expect(r.key).toBe('my-key');
  expect(r.url).toBe('ws://localhost:8080/app/my-key?protocol=7&client=DialCatz&version=1.0');
  expect(() => pusherUrl('ws://localhost:8080/')).toThrow('/app/<key>');
});

test('a private channel signs like the Pusher docs example', () => {
  // https://pusher.com/docs/channels/library_auth_reference/auth-signatures (key, secret, socket id from the docs)
  const sig = createHmac('sha256', '7ad3773142a6692b25b8').update(authText('1234.1234', 'private-foobar')).digest('hex');
  expect(`278d425bdf160c739803:${sig}`).toBe('278d425bdf160c739803:58df8b0c36d6982b82c3ecf6b4662e34fe8c25bba48f5369f135bf843651c3a4');
});

test('frames', () => {
  expect(JSON.parse(subscribeFrame('orders'))).toEqual({ event: 'pusher:subscribe', data: { channel: 'orders' } });
  expect(JSON.parse(clientEventFrame('private-chat', 'typing', '{"who":"ani"}'))).toEqual({ event: 'client-typing', channel: 'private-chat', data: { who: 'ani' } });
  expect(() => clientEventFrame('orders', 'typing', '')).toThrow('private- and presence-');
  expect(pusherDecode('{"event":"order.created","channel":"orders","data":"{\\"id\\":7}"}')).toEqual({ event: 'order.created', channel: 'orders', data: { id: 7 } });
});
