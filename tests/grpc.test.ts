import { expect, test } from 'bun:test';
import { CODES, HTTP_OF, target } from '../src/main/grpc';

test('addresses: plain and TLS, default ports', () => {
  expect(target('grpc://localhost:50051')).toEqual({ address: 'localhost:50051', tls: false });
  expect(target('grpcs://api.example.com/x')).toEqual({ address: 'api.example.com:443', tls: true });
  expect(() => target('http://x')).toThrow('grpc://');
});

test('every gRPC code has a name and an HTTP status', () => {
  expect(CODES.length).toBe(17);
  expect(HTTP_OF.length).toBe(17);
  expect([CODES[5], HTTP_OF[5]]).toEqual(['NOT_FOUND', 404]);
  expect([CODES[16], HTTP_OF[16]]).toEqual(['UNAUTHENTICATED', 401]);
});
