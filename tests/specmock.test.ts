import { describe, expect, test } from 'bun:test';
import { exampleFromSchema, matchRoute, methodsOn, mockBody, pickResponse, preferredCode, routePath, type MockRoute } from '../src/shared/specmock';

const routes: MockRoute[] = [
  { method: 'GET', path: routePath('{{baseUrl}}/users'), name: 'List', responses: [] },
  { method: 'GET', path: routePath('{{baseUrl}}/users/{id}?x=1'), name: 'One', responses: [] },
  { method: 'GET', path: routePath('{{baseUrl}}/users/me'), name: 'Me', responses: [] },
  { method: 'DELETE', path: routePath('{{baseUrl}}/users/:id'), name: 'Delete', responses: [] },
];

describe('routes', () => {
  test('paths match by segment; the most literal route wins; HEAD uses GET', () => {
    expect(routes[1].path).toBe('/users/:id');
    expect(matchRoute(routes, 'GET', '/users/42?page=2')?.name).toBe('One');
    expect(matchRoute(routes, 'GET', '/users/me')?.name).toBe('Me');
    expect(matchRoute(routes, 'HEAD', '/users')?.name).toBe('List');
    expect(matchRoute(routes, 'POST', '/users')).toBeNull();
    expect(methodsOn(routes, '/users/7').sort()).toEqual(['DELETE', 'GET']);
  });
});

describe('responses', () => {
  const rs = [
    { status: '404', types: ['application/json'], example: { error: 'nope' } },
    { status: '201', types: ['application/json'], schema: { type: 'object', properties: { id: { type: 'integer' }, at: { type: 'string', format: 'date-time' }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } } } },
    { status: 'DEFAULT', types: [] },
  ];
  test('the first 2xx by default; Prefer: code= picks another', () => {
    expect(pickResponse(rs, null)?.status).toBe(201);
    expect(preferredCode('code=404, example=x')).toBe(404);
    expect(pickResponse(rs, 404)?.response.example).toEqual({ error: 'nope' });
    expect(pickResponse(rs, 500)?.response.status).toBe('DEFAULT');
  });
  test('a body from the example, else from the schema', () => {
    expect(JSON.parse(mockBody(rs[0]).body)).toEqual({ error: 'nope' });
    expect(JSON.parse(mockBody(rs[1]).body)).toEqual({ id: 1, at: '2026-01-01T09:00:00Z', tags: ['a'] });
    expect(mockBody(rs[2])).toEqual({ contentType: '', body: '' });
    expect(exampleFromSchema({ allOf: [{ properties: { a: { type: 'boolean' } } }, { properties: { b: { example: 'x' } } }] })).toEqual({ a: true, b: 'x' });
  });
});
