import { describe, expect, test } from 'bun:test';
import { newRequest, type RequestSpec, type TreeItem } from '../src/shared/types';
import { mergeRows, specApply, specDiff, withBase } from '../src/main/specsync';

const col: TreeItem = { id: 'c1', kind: 'collection', parentId: null, name: 'API', sort: 0 };
const req = (id: string, name: string, method: RequestSpec['method'], url: string, extra: Partial<RequestSpec> = {}): TreeItem => ({
  id,
  kind: 'request',
  parentId: 'c1',
  name,
  sort: 0,
  request: { ...newRequest(), method, url, ...extra },
});
const spec = (items: TreeItem[]) => ({ root: { ...col, id: 'fresh' }, items: items.map((i) => ({ ...i, parentId: 'fresh' })) });

describe('specDiff', () => {
  test('lists added, changed and removed; hand-made requests never count as removed', () => {
    const imported = withBase([req('r1', 'List users', 'GET', '{{baseUrl}}/users'), req('r2', 'Delete user', 'DELETE', '{{baseUrl}}/users/:id')]);
    const items = [col, ...imported, req('r3', 'My own', 'GET', '{{baseUrl}}/debug')];
    const fresh = spec([req('x1', 'List all users', 'GET', '{{baseUrl}}/users'), req('x2', 'Create user', 'POST', '{{baseUrl}}/users')]);
    const { changes, unchanged } = specDiff(items, col, fresh);
    expect(unchanged).toBe(0);
    expect(changes.map((c) => `${c.kind} ${c.key}`).sort()).toEqual(['added POST /users', 'changed GET /users', 'removed DELETE /users/:']);
    expect(changes.find((c) => c.kind === 'changed')!.parts).toEqual(['name']);
  });

  test('a request the spec did not change is unchanged, whatever the user edited', () => {
    const [r] = withBase([req('r1', 'List users', 'GET', '{{baseUrl}}/users')]);
    const edited = { ...r, request: { ...r.request!, headers: [{ key: 'X-Debug', value: '1', enabled: true }] } };
    const { changes, unchanged } = specDiff([col, edited], col, spec([req('x1', 'List users', 'GET', '{{baseUrl}}/users')]));
    expect(changes).toEqual([]);
    expect(unchanged).toBe(1);
  });
});

describe('specApply', () => {
  test('an update takes the spec where the user left it alone and keeps the user\'s edits', () => {
    const [r] = withBase([req('r1', 'Create user', 'POST', '{{baseUrl}}/users', { body: { mode: 'json', raw: '{"name":""}', fields: [] }, headers: [{ key: 'X-Tenant', value: '', enabled: true }] })]);
    // The user typed a body and a tenant, and added a script.
    const mine: TreeItem = { ...r, request: { ...r.request!, body: { mode: 'json', raw: '{"name":"Ani"}', fields: [] }, headers: [{ key: 'X-Tenant', value: 'acme', enabled: true }], tests: 'pm.test("ok")' } };
    // The spec renamed it, added a query param and a header, and changed the body.
    const fresh = spec([req('x1', 'Create a user', 'POST', '{{baseUrl}}/users?notify=true', { params: [{ key: 'notify', value: 'true', enabled: true }], headers: [{ key: 'X-Tenant', value: '', enabled: true }, { key: 'X-Trace', value: '', enabled: false }], body: { mode: 'json', raw: '{"name":"","email":""}', fields: [] } })]);
    const diff = specDiff([col, mine], col, fresh);
    expect(diff.changes[0].kept).toEqual(['body']);
    const out = specApply([col, mine], col, fresh, { add: [], update: ['POST /users'], remove: [] });
    const saved = out.save.find((i) => i.id === 'r1')!;
    expect(saved.name).toBe('Create a user');
    expect(saved.request!.url).toBe('{{baseUrl}}/users?notify=true');
    expect(saved.request!.body.raw).toBe('{"name":"Ani"}');
    expect(saved.request!.headers.map((h) => `${h.key}=${h.value}`)).toEqual(['X-Tenant=acme', 'X-Trace=']);
    expect(saved.request!.tests).toBe('pm.test("ok")');
    expect(out.updated).toBe(1);
    // Seen now: nothing left to offer.
    const after = [col, ...out.save];
    expect(specDiff(after, col, fresh).changes).toEqual([]);
  });

  test('removed requests are deleted only when ticked; left alone they become the user\'s own', () => {
    const imported = withBase([req('r1', 'Old', 'GET', '{{baseUrl}}/old'), req('r2', 'Older', 'GET', '{{baseUrl}}/older')]);
    const fresh = spec([]);
    const out = specApply([col, ...imported], col, fresh, { add: [], update: [], remove: ['GET /old'] });
    expect(out.remove).toEqual(['r1']);
    const kept = out.save.find((i) => i.id === 'r2')!;
    expect(kept.specBase).toBeUndefined();
    expect(specDiff([col, kept], col, fresh).changes).toEqual([]);
  });

  test('only the ticked new routes are added, each remembering what the spec made', () => {
    const fresh = spec([req('x1', 'A', 'GET', '{{baseUrl}}/a'), req('x2', 'B', 'GET', '{{baseUrl}}/b')]);
    const out = specApply([col], col, fresh, { add: ['GET /b'], update: [], remove: [] });
    expect(out.added).toBe(1);
    const added = out.save.filter((i) => i.kind === 'request');
    expect(added.map((i) => i.name)).toEqual(['B']);
    expect(added[0].specBase?.name).toBe('B');
    expect(added[0].parentId).toBe('c1');
  });
});

describe('mergeRows', () => {
  test('a row the user removed stays removed; a row the spec dropped goes unless the user changed it', () => {
    const base = [{ key: 'a', value: '1', enabled: true }, { key: 'b', value: '', enabled: true }, { key: 'c', value: '', enabled: true }];
    const cur = [{ key: 'b', value: '', enabled: true }, { key: 'c', value: 'mine', enabled: true }, { key: 'd', value: 'own', enabled: true }];
    const fresh = [{ key: 'a', value: '2', enabled: true }, { key: 'e', value: '', enabled: true }];
    expect(mergeRows(cur, base, fresh).map((r) => `${r.key}=${r.value}`)).toEqual(['e=', 'c=mine', 'd=own']);
  });
});
