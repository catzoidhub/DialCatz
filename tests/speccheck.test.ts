import { describe, expect, test } from 'bun:test';
import { checkResponse } from '../src/shared/speccheck';
import type { SpecResponse } from '../src/shared/types';

const user = { type: 'object', required: ['id', 'email'], properties: { id: { type: 'integer' }, email: { type: 'string' }, role: { type: 'string', enum: ['admin', 'member'] }, team: { type: 'object', nullable: true, properties: { name: { type: 'string' } } } } };
const responses: SpecResponse[] = [
  { status: '200', types: ['application/json'], schema: { type: 'array', items: user } },
  { status: '4XX', types: ['application/problem+json'], schema: { type: 'object', required: ['title'] } },
];
const res = (status: number, body: unknown, contentType = 'application/json') => ({ status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body), binary: false, truncated: false });

describe('checkResponse', () => {
  test('a body that fits passes', () => {
    expect(checkResponse(responses, res(200, [{ id: 1, email: 'a@b.c', role: 'admin', team: null }]))).toEqual({ matched: '200', issues: [] });
  });
  test('wrong types, missing fields and values outside the enum are listed with their path', () => {
    const r = checkResponse(responses, res(200, [{ id: '1', role: 'owner', team: { name: 3 } }]));
    expect(r.issues).toEqual(['body[0].email: missing (required)', 'body[0].id: a string, the spec says integer', 'body[0].role: "owner" is not one of "admin", "member"', 'body[0].team.name: a number, the spec says string']);
  });
  test('status classes and content types', () => {
    expect(checkResponse(responses, res(404, { title: 'Not found' }, 'application/problem+json'))).toEqual({ matched: '4XX', issues: [] });
    expect(checkResponse(responses, res(500, 'oops', 'text/plain')).issues[0]).toBe('Status 500 is not in the spec (it lists 200, 4XX)');
    expect(checkResponse(responses, res(200, '<html></html>', 'text/html')).issues).toEqual(['Content type text/html; the spec says application/json']);
  });
  test('additionalProperties: false and anyOf', () => {
    const r = checkResponse([{ status: '200', types: ['application/json'], schema: { type: 'object', additionalProperties: false, properties: { v: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } } }], res(200, { v: true, extra: 1 }));
    expect(r.issues).toEqual(['body.v: matches none of the 2 shapes the spec allows', 'body.extra: not in the spec']);
  });
});
