import { joinUrl } from '@shared/request';
import type { KeyValue, RequestBody, SpecBase, SpecChange, TreeItem } from '@shared/types';
import { mergeRoutes, routeKey } from './routemerge';

/**
 * A collection that follows its spec (#92). The spec (an OpenAPI / Swagger document, or the routes DevCatz / DoCatz
 * read) is compared with the collection request by request, by route (method and path, routeKey):
 *   added    the spec has a route the collection lacks
 *   changed  the spec made the request differently than last time (the request's `specBase`)
 *   removed  a request the spec once made whose route is gone (requests made by hand are never listed)
 * Nothing changes until the user picks what to take. An update takes the spec's new version of each part the user
 * left as the spec made it and keeps every part the user edited; auth, scripts, folders and the request's place are
 * always the user's. A removed request is deleted only when ticked; left alone it becomes the user's own.
 */

export interface Fresh {
  root: TreeItem;
  items: TreeItem[];
}

export interface SpecPick {
  add: string[];
  update: string[];
  remove: string[];
}

const PARTS = ['name', 'method', 'url', 'params', 'headers', 'body', 'description'] as const;
type Part = (typeof PARTS)[number];

const row = (r: KeyValue): KeyValue => ({ key: r.key, value: r.value, enabled: r.enabled, ...(r.description ? { description: r.description } : {}), ...(r.type ? { type: r.type } : {}) });
const body = (b: RequestBody): RequestBody => ({ mode: b.mode, raw: b.raw ?? '', fields: (b.fields ?? []).map(row), ...(b.variables ? { variables: b.variables } : {}) });

/** The parts of a request a spec decides, as they are now. */
export function baseOf(i: TreeItem): SpecBase {
  const r = i.request!;
  return { name: i.name, method: r.method, url: r.url, params: r.params.map(row), headers: r.headers.map(row), body: body(r.body), ...(i.description ? { description: i.description } : {}) };
}

const pathOf = (url: string) => url.split('?')[0];
const rowKey = (r: KeyValue) => [r.key, r.value, r.enabled];
/** One part in a comparable form: the query lives in `params`, so `url` compares the path only. */
function part(b: SpecBase, p: Part): string {
  switch (p) {
    case 'url':
      return pathOf(b.url);
    case 'params':
    case 'headers':
      return JSON.stringify(b[p].map(rowKey));
    case 'body':
      return JSON.stringify([b.body.mode, b.body.mode === 'none' ? '' : b.body.raw, b.body.fields.map((f) => [...rowKey(f), f.type ?? 'text']), b.body.variables ?? '']);
    default:
      return String(b[p] ?? '');
  }
}
const samePart = (a: SpecBase, b: SpecBase, p: Part) => part(a, p) === part(b, p);

/** The ids of an item and everything under it. */
function under(items: TreeItem[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) (ids.add(i.id), (grew = true));
  }
  return ids;
}

const keyOf = (i: TreeItem) => routeKey(i.request!.method, i.request!.url);

interface Match {
  mine: Map<string, TreeItem>;
  fresh: Map<string, TreeItem>;
  /** Requests the spec once made, by id. */
  spec: TreeItem[];
}

function match(items: TreeItem[], collection: TreeItem, fresh: Fresh): Match {
  const ids = under(items, collection.id);
  const requests = items.filter((i) => ids.has(i.id) && i.kind === 'request' && i.request);
  const mine = new Map<string, TreeItem>();
  // Two requests with the same route (a duplicate the user made): the one the spec made is the spec's.
  for (const r of [...requests.filter((i) => i.specBase), ...requests.filter((i) => !i.specBase)]) if (!mine.has(keyOf(r))) mine.set(keyOf(r), r);
  const freshMap = new Map<string, TreeItem>();
  for (const r of fresh.items) if (r.kind === 'request' && r.request && !freshMap.has(keyOf(r))) freshMap.set(keyOf(r), r);
  return { mine, fresh: freshMap, spec: requests.filter((i) => i.specBase) };
}

/** What differs between a collection and its spec. */
export function specDiff(items: TreeItem[], collection: TreeItem, fresh: Fresh): { changes: SpecChange[]; unchanged: number } {
  const m = match(items, collection, fresh);
  const changes: SpecChange[] = [];
  let unchanged = 0;
  for (const [key, f] of m.fresh) {
    const mine = m.mine.get(key);
    const fb = baseOf(f);
    if (!mine) {
      changes.push({ key, kind: 'added', name: f.name, method: f.request!.method, url: f.request!.url });
      continue;
    }
    const cur = baseOf(mine);
    if (mine.specBase) {
      const parts = PARTS.filter((p) => !samePart(mine.specBase!, fb, p));
      if (!parts.length) {
        unchanged++;
        continue;
      }
      // Params and headers merge row by row, so only whole parts the user edited stay entirely theirs.
      const kept = parts.filter((p) => p !== 'params' && p !== 'headers' && !samePart(cur, mine.specBase!, p));
      changes.push({ key, kind: 'changed', name: mine.name, method: mine.request!.method, url: mine.request!.url, requestId: mine.id, parts, ...(kept.length ? { kept } : {}) });
    } else {
      // Imported before the collection kept what the spec made: only the request's shape counts, not its name.
      const parts = PARTS.filter((p) => p !== 'name' && p !== 'description' && !samePart(cur, fb, p));
      if (!parts.length) {
        unchanged++;
        continue;
      }
      changes.push({ key, kind: 'changed', name: mine.name, method: mine.request!.method, url: mine.request!.url, requestId: mine.id, parts, noBase: true });
    }
  }
  for (const r of m.spec) {
    const key = keyOf(r);
    if (m.fresh.has(key) || m.mine.get(key) !== r) continue;
    changes.push({ key, kind: 'removed', name: r.name, method: r.request!.method, url: r.request!.url, requestId: r.id });
  }
  return { changes, unchanged };
}

/**
 * Rows of a table (params, headers): the spec's rows, except where the user changed or removed one the spec made, and
 * the user's own rows kept. `base` missing (imported before #92): the user's values for rows the spec also has.
 */
export function mergeRows(cur: KeyValue[], base: KeyValue[] | undefined, fresh: KeyValue[]): KeyValue[] {
  const find = (list: KeyValue[] | undefined, k: string) => list?.find((r) => r.key === k);
  const same = (a: KeyValue, b: KeyValue) => a.key === b.key && a.value === b.value && a.enabled === b.enabled;
  const out: KeyValue[] = [];
  for (const f of fresh) {
    const c = find(cur, f.key);
    const b = find(base, f.key);
    if (!base) out.push(c ? { ...f, value: c.value, enabled: c.enabled } : f);
    else if (c && b && !same(c, b)) out.push(c);
    else if (c && !b) out.push(c);
    else if (!c && b) continue;
    else out.push(f);
  }
  for (const c of cur) {
    if (find(fresh, c.key)) continue;
    const b = find(base, c.key);
    if (b && same(c, b)) continue;
    out.push(c);
  }
  return out;
}

/** The request after taking the spec's new version, keeping the user's edits (see the top of the file). */
function updated(mine: TreeItem, f: TreeItem): TreeItem {
  const base = mine.specBase;
  const cur = baseOf(mine);
  const fb = baseOf(f);
  const take = (p: Part) => (base ? samePart(cur, base, p) : p !== 'name' && p !== 'description');
  const r = mine.request!;
  const params = mergeRows(r.params, base?.params, fb.params);
  const path = take('url') ? pathOf(fb.url) : pathOf(r.url);
  return {
    ...mine,
    name: take('name') ? fb.name : mine.name,
    ...(take('description') ? { description: fb.description } : {}),
    request: {
      ...r,
      method: take('method') ? fb.method : r.method,
      url: joinUrl(path, params),
      params,
      headers: mergeRows(r.headers, base?.headers, fb.headers),
      body: take('body') ? f.request!.body : r.body,
    },
    specBase: fb,
    specResponses: f.specResponses,
  };
}

/** What to save and delete for the user's picks; every other request the spec made is marked as seen. */
export function specApply(items: TreeItem[], collection: TreeItem, fresh: Fresh, pick: SpecPick): { save: TreeItem[]; remove: string[]; added: number; updated: number; removed: number } {
  const m = match(items, collection, fresh);
  const { changes } = specDiff(items, collection, fresh);
  const add = new Set(pick.add);
  const update = new Set(pick.update);
  const drop = new Set(pick.remove);
  const save: TreeItem[] = [];
  const remove: string[] = [];
  let updatedN = 0;
  for (const c of changes) {
    const mine = c.requestId ? items.find((i) => i.id === c.requestId) : undefined;
    if (!mine) continue;
    if (c.kind === 'changed') {
      const f = m.fresh.get(c.key)!;
      if (update.has(c.key)) {
        save.push(updated(mine, f));
        updatedN++;
      } else save.push({ ...mine, specBase: baseOf(f), specResponses: f.specResponses }); // seen: not offered again until the spec changes it
    } else if (c.kind === 'removed') {
      if (drop.has(c.key)) remove.push(mine.id);
      else save.push({ ...mine, specBase: undefined, specResponses: undefined }); // kept: from now on the user's own
    }
  }
  // Requests that match the spec but were imported before #92: remember what the spec made.
  for (const [key, mine] of m.mine) {
    const f = m.fresh.get(key);
    if (f && !mine.specBase && !changes.some((c) => c.requestId === mine.id)) save.push({ ...mine, specBase: baseOf(f), specResponses: f.specResponses });
  }
  // The responses the spec describes are the spec's alone (#93): refreshed on every request it still has.
  for (const [key, mine] of m.mine) {
    const f = m.fresh.get(key);
    if (!f || save.some((i) => i.id === mine.id) || JSON.stringify(mine.specResponses ?? null) === JSON.stringify(f.specResponses ?? null)) continue;
    save.push({ ...mine, specResponses: f.specResponses });
  }
  const picked = { root: fresh.root, items: fresh.items.filter((i) => i.kind !== 'request' || (i.request && add.has(keyOf(i)) && changes.some((c) => c.kind === 'added' && c.key === keyOf(i)))) };
  const merged = mergeRoutes(items, collection, picked);
  for (const i of merged.save) save.push(i.kind === 'request' && i.request ? { ...i, specBase: baseOf(i) } : i);
  return { save, remove, added: merged.added, updated: updatedN, removed: remove.length };
}

/** Requests of a freshly imported spec, each remembering what the spec made. */
export const withBase = (items: TreeItem[]): TreeItem[] => items.map((i) => (i.kind === 'request' && i.request ? { ...i, specBase: baseOf(i) } : i));
