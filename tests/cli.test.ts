import { expect, test } from 'bun:test';
import { readEnvFile, requestsOf, specFor, specKey } from '../cli/plan';
import { junit, json, paint, plainMarks, requestLines, summaryLine, totals } from '../cli/report';
import type { RequestResult } from '../cli/run';
import { newRequest, type SpecResponse, type TreeItem } from '../src/shared/types';

const req = (id: string, parentId: string, name: string, sort: number): TreeItem => ({ id, kind: 'request', parentId, name, sort, request: newRequest() });

test('requests run in the app runner\'s order: sort, then name, folders in place', () => {
  const items: TreeItem[] = [
    { id: 'c', kind: 'collection', parentId: null, name: 'C', sort: 0 },
    req('r3', 'c', 'Zed', 2),
    { id: 'f', kind: 'folder', parentId: 'c', name: 'Folder', sort: 1 },
    req('r2b', 'f', 'b', 0),
    req('r2a', 'f', 'a', 0),
    req('r1', 'c', 'First', 0),
    req('other', 'x', 'Elsewhere', 0),
  ];
  expect(requestsOf(items, 'c').map((i) => i.id)).toEqual(['r1', 'r2a', 'r2b', 'r3']);
});

test('the contract is found whatever the parameters are called, and for a URL with real values', () => {
  const a: SpecResponse[] = [{ status: '200', types: [] }];
  const b: SpecResponse[] = [{ status: '204', types: [] }];
  const spec = new Map([
    [specKey('GET', '{{baseUrl}}/items/:id'), a],
    [specKey('GET', '{{baseUrl}}/items/mine'), b],
  ]);
  expect(specKey('get', 'https://x.test/items/{itemId}?q=1')).toBe('GET /items/{}');
  expect(specFor(spec, 'GET', '{{api}}/items/{{id}}')).toBe(a);
  expect(specFor(spec, 'GET', 'https://x.test/items/42')).toBe(a);
  // A literal path wins over a parameter.
  expect(specFor(spec, 'GET', 'https://x.test/items/mine')).toBe(b);
  expect(specFor(spec, 'POST', 'https://x.test/items/42')).toBeNull();
  expect(specFor(spec, 'GET', 'https://x.test/items/42/parts')).toBeNull();
});

test('an env file: NAME=value lines, quotes dropped, comments left out', () => {
  expect(readEnvFile('A=1\n# note\nexport B = "two words"\nC=\'x#y\'\nD=plain # trailing\nnot a line\nE=')).toEqual([
    ['A', '1'],
    ['B', 'two words'],
    ['C', 'x#y'],
    ['D', 'plain'],
    ['E', ''],
  ]);
});

const r = (over: Partial<RequestResult>): RequestResult => ({ id: 'r', name: 'Get <one>', place: ['Shop', 'Items'], method: 'GET', url: 'https://x.test/items/1', status: 200, timeMs: 12, size: 10, outcome: 'passed', error: null, tests: [], logs: [], ...over });
const runs = [
  {
    collection: 'Shop & co',
    ms: 1500,
    requests: [
      r({ tests: [{ name: 'ok', pass: true }], logs: ['hello'] }),
      r({ name: 'Broken', outcome: 'failed', status: 500, tests: [{ name: 'status is 200', pass: false, error: 'Expected: 500 to be 200' }] }),
      r({ name: 'Down', outcome: 'failed', status: null, timeMs: null, error: 'connect ECONNREFUSED' }),
      r({ name: 'Socket', method: 'WS', outcome: 'skipped', status: null, timeMs: null, error: 'WebSocket requests are not run by the CLI' }),
    ],
  },
];

test('totals and the summary line', () => {
  expect(totals(runs)).toEqual({ requests: 4, failed: 2, skipped: 1, tests: 2, testsFailed: 1, ms: 1500 });
  expect(summaryLine(totals(runs), paint(false))).toBe('4 requests · 2 failed · 1 skipped · 2 tests, 1 failed · 1.50 s');
  expect(requestLines(runs[0].requests[1], paint(false), false)).toEqual(['  ✗ GET    Items / Broken  500  12 ms', '      ✗ status is 200: Expected: 500 to be 200']);
  // Passed tests show only with --verbose.
  expect(requestLines(runs[0].requests[0], paint(false), false)).toHaveLength(1);
  expect(requestLines(runs[0].requests[0], paint(false), true)).toHaveLength(3);
});

test('JUnit: a case per request, failures and skips marked, text escaped', () => {
  const x = junit(runs);
  expect(x).toContain('<testsuites name="DialCatz" tests="4" failures="2" skipped="1" time="1.500">');
  expect(x).toContain('<testsuite name="Shop &amp; co" tests="4" failures="2" skipped="1"');
  expect(x).toContain('<testcase classname="Shop / Items" name="GET Get &lt;one&gt;" time="0.012">');
  expect(x).toContain('<failure message="status is 200: Expected: 500 to be 200">');
  expect(x).toContain('<failure message="connect ECONNREFUSED">GET https://x.test/items/1\nNo response');
  expect(x).toContain('<skipped message="WebSocket requests are not run by the CLI"/>');
  expect(JSON.parse(json(runs, '9.9.9'))).toMatchObject({ dialcatz: '9.9.9', requests: 4, failed: 2, passed: false });
});

test('a classic Windows console gets marks its font has', () => {
  expect(plainMarks({}, 'win32', true)).toBe(true);
  expect(plainMarks({ WT_SESSION: '1' }, 'win32', true)).toBe(false);
  expect(plainMarks({}, 'win32', false)).toBe(false); // piped: a log file or a CI, UTF-8
  expect(plainMarks({}, 'darwin', true)).toBe(false);
  expect(requestLines(runs[0].requests[1], paint(false, true), false)[0]).toBe('  × GET    Items / Broken  500  12 ms');
});
