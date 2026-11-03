import { uid, type TreeItem } from '@shared/types';

/**
 * Importing a DevCatz site's or DoCatz project's routes again (or Open in DialCatz on one already imported) merges
 * them into the collection made the first time: routes it does not have yet are added, in the folder of the same name
 * (made when missing); requests it has stay exactly as they are — the user's params, bodies, headers, scripts and
 * names — and requests whose route is gone stay too (only counted). A route is its method and path: the host part
 * ({{baseUrl}}, {{apiUrl}} …) and the query are left out, and :id / {id} path parameters count as one.
 */

/** `GET {{baseUrl}}/users/{id}?page=1` → `GET /users/:`. */
export function routeKey(method: string, url: string): string {
  const path = url
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '')
    .split(/[?#]/)[0]
    .replace(/\/(:[\w-]+|\{[^}/]+\}|\{\{[^}/]+\}\})(?=\/|$)/g, '/:')
    .replace(/\/+$/, '');
  return `${method.toUpperCase()} ${path || '/'}`;
}

/** The ids of an item and everything under it. */
function under(items: TreeItem[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) (ids.add(i.id), (grew = true));
  }
  return ids;
}

/**
 * What to save so `existing` (a collection in `items`) also has the routes of `fresh` it lacks. `added`: new requests;
 * `gone`: requests of the collection whose route `fresh` no longer has (kept).
 */
export function mergeRoutes(items: TreeItem[], existing: TreeItem, fresh: { root: TreeItem; items: TreeItem[] }): { save: TreeItem[]; added: number; gone: number } {
  const mineIds = under(items, existing.id);
  const mine = items.filter((i) => mineIds.has(i.id) && i.id !== existing.id);
  const have = new Set(mine.filter((i) => i.kind === 'request' && i.request).map((i) => routeKey(i.request!.method, i.request!.url)));
  const freshById = new Map(fresh.items.map((i) => [i.id, i]));
  const save: TreeItem[] = [];
  // Folder paths (names from the collection down) → the folder in the existing collection.
  const folders = new Map<string, TreeItem>();
  const pathOf = (id: string | null, byId: Map<string, TreeItem>, stop: string): string[] => {
    const names: string[] = [];
    for (let cur = id ? byId.get(id) : undefined; cur && cur.id !== stop; cur = cur.parentId ? byId.get(cur.parentId) : undefined) names.unshift(cur.name);
    return names;
  };
  const mineById = new Map(mine.map((i) => [i.id, i]));
  for (const f of mine) if (f.kind === 'folder') folders.set(pathOf(f.id, mineById, existing.id).join('\u0000'), f);
  const nextSort = (parentId: string) => Math.max(-1, ...[...mine, ...save].filter((i) => i.parentId === parentId).map((i) => i.sort)) + 1;
  const folderFor = (names: string[]): string => {
    let parentId = existing.id;
    for (let n = 1; n <= names.length; n++) {
      const key = names.slice(0, n).join('\u0000');
      let f = folders.get(key);
      if (!f) {
        f = { id: uid('f_'), kind: 'folder', parentId, name: names[n - 1], sort: nextSort(parentId), auth: { mode: 'inherit' } };
        folders.set(key, f);
        save.push(f);
      }
      parentId = f.id;
    }
    return parentId;
  };
  let added = 0;
  const seen = new Set<string>();
  for (const r of fresh.items) {
    if (r.kind !== 'request' || !r.request) continue;
    const key = routeKey(r.request.method, r.request.url);
    seen.add(key);
    if (have.has(key)) continue;
    have.add(key);
    const parentId = folderFor(pathOf(r.parentId, freshById, fresh.root.id));
    save.push({ ...r, id: uid('r_'), parentId, sort: nextSort(parentId) });
    added++;
  }
  const gone = mine.filter((i) => i.kind === 'request' && i.request && !seen.has(routeKey(i.request.method, i.request.url))).length;
  return { save, added, gone };
}
