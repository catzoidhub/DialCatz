import { expect, test } from 'bun:test';
import { sioConnect, sioDecode, sioEvent, sioUrl } from '../src/shared/socketio';

test('the address becomes the Engine.IO endpoint and a namespace', () => {
  expect(sioUrl('ws://localhost:3000/chat?token=1')).toEqual({ url: 'ws://localhost:3000/socket.io/?token=1&EIO=4&transport=websocket', namespace: '/chat' });
  expect(sioUrl('wss://x.test/socket.io/')).toEqual({ url: 'wss://x.test/socket.io/?EIO=4&transport=websocket', namespace: '/' });
});

test('packets out', () => {
  expect(sioConnect('/')).toBe('40');
  expect(sioConnect('/chat')).toBe('40/chat,');
  expect(sioEvent('/', 'chat message', '"hi"')).toBe('42["chat message","hi"]');
  expect(sioEvent('/chat', 'move', '[1, {"x":2}]')).toBe('42/chat,["move",1,{"x":2}]');
  expect(sioEvent('/', 'ping', '')).toBe('42["ping"]');
  expect(sioEvent('/', 'say', 'plain text')).toBe('42["say","plain text"]');
});

test('frames in', () => {
  expect(sioDecode('0{"sid":"a","pingInterval":25000}')).toEqual({ kind: 'open', sid: 'a', pingInterval: 25000 });
  expect(sioDecode('2')).toEqual({ kind: 'ping' });
  expect(sioDecode('40{"sid":"b"}')).toEqual({ kind: 'connect', namespace: '/', sid: 'b' });
  expect(sioDecode('42/chat,["hello",{"n":1}]')).toEqual({ kind: 'event', namespace: '/chat', name: 'hello', args: [{ n: 1 }] });
  expect(sioDecode('4312["ok"]')).toEqual({ kind: 'ack', namespace: '/', ackId: 12, args: ['ok'] });
  expect(sioDecode('44{"message":"Not authorized"}')).toEqual({ kind: 'connect_error', namespace: '/', message: 'Not authorized' });
});
