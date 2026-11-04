import { expect, test } from 'bun:test';
import { goravelCommand, laravelTree, parseGoravelRoutes, routesTree } from '../src/main/routetree';

// Printed by goravel-demo (framework v1.18.0) inside its container, without colours and with them.
const PLAIN = `
  GET|HEAD     / .................................... goravel/routes.Web.func1
  STATIC       public ........................................................
  GET|HEAD     users .... goravel/app/http/controllers.(*UserController).Index

                                                            Showing [3] routes
`;
const COLOURED = '\u001b[39m\u001b[0m\u001b[39m  \u001b[34mGET\u001b[0m\u001b[39m\u001b[90m|\u001b[0m\u001b[39m\u001b[90mHEAD\u001b[0m\u001b[39m     users \u001b[90m....\u001b[0m\u001b[39m goravel/x.Index\n';

test('the list: STATIC and the Showing line go, handlers kept', () => {
  expect(parseGoravelRoutes(PLAIN)).toEqual([
    { method: 'GET|HEAD', uri: '/', name: null, action: 'goravel/routes.Web.func1' },
    { method: 'GET|HEAD', uri: 'users', name: null, action: 'goravel/app/http/controllers.(*UserController).Index' },
  ]);
});

test('colours are stripped, and a name is read when it prints one', () => {
  expect(parseGoravelRoutes(COLOURED)[0].uri).toBe('users');
  expect(parseGoravelRoutes('  POST  users/{id} ... users.update › goravel/x.Update')[0]).toEqual({ method: 'POST', uri: 'users/{id}', name: 'users.update', action: 'goravel/x.Update' });
  expect(parseGoravelRoutes('  POST  users/{id}')[0].action).toBe('');
});

test('requests as Laravel routes become: the first method that is not HEAD, {id} as :id', () => {
  const items = routesTree([...parseGoravelRoutes(PLAIN), ...parseGoravelRoutes('  HEAD|DELETE  api/users/{id} .... x.Destroy')], 'c');
  const reqs = items.filter((i) => i.kind === 'request');
  expect(reqs.map((i) => `${i.request!.method} ${i.request!.url}`).sort()).toEqual(['DELETE {{baseUrl}}/api/users/:id', 'GET {{baseUrl}}/', 'GET {{baseUrl}}/users']);
  expect(items.filter((i) => i.kind === 'folder').map((f) => f.name)).toContain('api');
});

test('the command comes from how the image starts', () => {
  const args = ['artisan', 'route:list', '--no-ansi'];
  expect(goravelCommand(['/www/main'], null)).toEqual(['/www/main', ...args]);
  expect(goravelCommand(null, ['./app'])).toEqual(['./app', ...args]);
  expect(goravelCommand(['/bin/sh', '-c', '/www/main'], null)).toEqual(['/www/main', ...args]);
  for (const source of [['go', 'run', '.'], ['air'], ['/usr/local/bin/air', '-c', '.air.toml'], ['sh', '-c', 'go run .'], null]) expect(goravelCommand(source, null)).toEqual(['go', 'run', '.', ...args]);
});

test("Laravel's list still goes the same way", () => {
  const out = `warning first\n${JSON.stringify([{ method: 'GET|HEAD', uri: 'api/users/{id?}', name: 'users.show', action: 'x', middleware: ['api'] }, { method: 'GET|HEAD', uri: 'telescope/x', name: null, action: 'y' }])}`;
  const reqs = laravelTree(out, 'c').filter((i) => i.kind === 'request');
  expect(reqs.map((i) => [i.name, i.request!.url])).toEqual([['users.show', '{{baseUrl}}/api/users/:id']]);
});
