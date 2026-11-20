import { expect, test } from 'bun:test';
import { newRequest, type TreeItem } from '../src/shared/types';
import { pathOf, toOpenApi } from '../src/main/openapi-export';

test('paths turn :id, {id} and {{id}} into path parameters and drop the base', () => {
  expect(pathOf('{{baseUrl}}/users/:id/posts/{{postId}}?x=1')).toEqual({ path: '/users/{id}/posts/{postId}', params: ['id', 'postId'] });
  expect(pathOf('https://api.example.com/v1/items/{id}').path).toBe('/v1/items/{id}');
});

test('a collection becomes operations with parameters, bodies, auth and tags', () => {
  const col: TreeItem = { id: 'c', kind: 'collection', parentId: null, name: 'Shop', sort: 0, auth: { mode: 'bearer', token: 'secret' } };
  const folder: TreeItem = { id: 'f', kind: 'folder', parentId: 'c', name: 'users', sort: 0, auth: { mode: 'inherit' } };
  const list: TreeItem = { id: 'r1', kind: 'request', parentId: 'f', name: 'List users', sort: 0, request: { ...newRequest(), method: 'GET', url: '{{baseUrl}}/users?page=1', params: [{ key: 'page', value: '1', enabled: true }], headers: [{ key: 'X-Tenant', value: '{{tenant}}', enabled: true }, { key: 'Accept', value: 'application/json', enabled: true }], auth: { mode: 'inherit' } } };
  const create: TreeItem = { id: 'r2', kind: 'request', parentId: 'f', name: 'Create user', sort: 1, request: { ...newRequest(), method: 'POST', url: '{{baseUrl}}/users', body: { mode: 'json', raw: '{"name":"Ani","age":30,"tags":["a"],"org":"{{org}}"}', fields: [] }, auth: { mode: 'inherit' } } };
  const dup: TreeItem = { ...list, id: 'r3', name: 'List users again' };
  const out = toOpenApi([col, folder, list, create, dup], 'c', new Map([['baseUrl', 'https://api.shop.test']]));
  const doc = out.doc as any;
  expect(out.operations).toBe(2);
  expect(out.duplicates).toBe(1);
  expect(doc.servers).toEqual([{ url: 'https://api.shop.test' }]);
  const get = doc.paths['/users'].get;
  expect(get.tags).toEqual(['users']);
  expect(get.parameters.map((p: any) => `${p.in}:${p.name}:${p.example ?? ''}`)).toEqual(['query:page:1', 'header:X-Tenant:']);
  expect(get.security).toEqual([{ bearerAuth: [] }]);
  const post = doc.paths['/users'].post;
  expect(post.requestBody.content['application/json'].schema).toEqual({ type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } }, org: { type: 'string' } } });
  expect(doc.components.securitySchemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
  expect(JSON.stringify(doc)).not.toContain('secret');
});
