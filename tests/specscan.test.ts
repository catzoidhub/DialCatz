import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanFolder } from '../src/main/specscan';

const root = mkdtempSync(join(tmpdir(), 'specscan-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

test('finds OpenAPI and Swagger files, leaves out dependencies and other JSON / YAML', () => {
  put('apps/api/openapi.yaml', "openapi: 3.1.0\ninfo: { title: Shop API, version: '2' }\npaths:\n  /users: { get: {}, post: {} }\n");
  put('docs/legacy.json', JSON.stringify({ swagger: '2.0', info: { title: 'Old API', version: '1' }, paths: { '/x': { get: {} } } }));
  put('node_modules/pkg/openapi.yaml', 'openapi: 3.0.0\ninfo: { title: Dep }\npaths: {}\n');
  put('package.json', JSON.stringify({ name: 'x', openapi: '3' }));
  put('config/app.yaml', 'name: app\nport: 3000\n');
  const found = scanFolder(root);
  expect(found.map((f) => [f.rel, f.title, f.format, f.operations])).toEqual([
    ['docs/legacy.json', 'Old API', 'Swagger 2.0', 1],
    ['apps/api/openapi.yaml', 'Shop API', 'OpenAPI 3.1.0', 2],
  ]);
});
