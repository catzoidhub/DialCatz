import { expect, test } from 'bun:test';
import { parseSse } from '../src/shared/sse';
import { mockBody } from '../src/shared/specmock';

test('events across chunks: names, ids, multi-line data, comments and CRLF', () => {
  const got: unknown[] = [];
  const feed = parseSse((e) => got.push(e));
  feed(': keep-alive\n\ndata: hel');
  feed('lo\n\nevent: tick\r\nid: 7\r\ndata: {"n":1}\r\ndata: more\r\n\r\nretry: 3000\ndata\n\n');
  expect(got).toEqual([
    { event: 'message', data: 'hello' },
    { event: 'tick', data: '{"n":1}\nmore', id: '7' },
    { event: 'message', data: '', id: '7', retry: 3000 },
  ]);
});

test('the mock answers an event-stream spec with its example as events', () => {
  expect(mockBody({ status: '200', types: ['text/event-stream'], example: [{ n: 1 }, 'two'] })).toEqual({ contentType: 'text/event-stream', body: 'data: {"n":1}\n\ndata: two\n\n' });
});
