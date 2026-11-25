import type { BrunoChange, Environment, RequestSpec, TreeItem } from '@shared/types';
import { uid } from '@shared/types';
import { joinUrl, splitUrl } from '@shared/request';
import { parts, type BrunoCollection } from './bruno';

/**
 * A collection that came from Bruno, compared with its folder as it is now (#104), item by item, by file. One way only:
 * Bruno's files are never written. A part changed in Bruno is taken when the user left it as it was imported; a part
 * the user edited here stays. Nothing changes until the user picks it.
 */

type Part = string;
const under = (items: TreeItem[], rootId: string): Set<string> => {
  const ids = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) (ids.add(i.id), (grew = true));
  }
  return ids;
};
const keyOf = (i: TreeItem) => `${i.kind}:${i.bruno?.file ?? ''}`;

function match(items: TreeItem[], col: TreeItem, fresh: BrunoCollection) {
  const ids = under(items, col.id);
  const mine = new Map<string, TreeItem>();
  for (const i of items) if (ids.has(i.id) && i.bruno && !mine.has(keyOf(i))) mine.set(keyOf(i), i);
  const now = new Map([fresh.root, ...fresh.items].map((i) => [keyOf(i), i]));
  return { ids, mine, now };
}
/** The parts Bruno changed since the import, and which of them the user edited here. */
function changed(mine: TreeItem, f: TreeItem): { parts: Part[]; kept: Part[] } {
  const base = mine.bruno!.base;
  const cur = parts(mine);
  const fb = f.bruno!.base;
  const list = Object.keys(fb).filter((p) => fb[p] !== base[p] && fb[p] !== cur[p]);
  return { parts: list, kept: list.filter((p) => cur[p] !== base[p]) };
}

export function brunoDiff(items: TreeItem[], col: TreeItem, fresh: BrunoCollection): { changes: BrunoChange[]; unchanged: number } {
  const { mine, now } = match(items, col, fresh);
  const changes: BrunoChange[] = [];
  let unchanged = 0;
  const line = (i: TreeItem) => ({ key: keyOf(i), item: i.kind, name: i.name, method: i.request ? (/^wss?:/i.test(i.request.url) ? 'WS' : /^grpcs?:/i.test(i.request.url) ? 'gRPC' : i.request.method) : '' });
  for (const [k, f] of now) {
    const m = mine.get(k);
    if (!m) {
      changes.push({ ...line(f), kind: 'added' });
      continue;
    }
    const c = changed(m, f);
    if (!c.parts.length) unchanged += f.kind === 'request' ? 1 : 0;
    else changes.push({ ...line(m), kind: 'changed', parts: c.parts, ...(c.kept.length ? { kept: c.kept } : {}) });
  }
  for (const [k, m] of mine) if (!now.has(k) && m.kind !== 'collection') changes.push({ ...line(m), kind: 'removed' });
  return { changes, unchanged };
}

/** The environments and variable names Bruno has and the workspace lacks; a value already here is never touched. */
export function newVariables(have: Environment[], fresh: Environment[]): { save: Environment[]; says: string[] } {
  const save: Environment[] = [];
  const says: string[] = [];
  for (const f of fresh) {
    const mine = have.find((e) => e.name === f.name);
    if (!mine) {
      save.push({ ...f, id: uid('e_') });
      says.push(`${f.name} (new)`);
      continue;
    }
    const add = f.variables.filter((v) => !mine.variables.some((x) => x.key.trim() === v.key));
    if (add.length) {
      save.push({ ...mine, variables: [...mine.variables, ...add] });
      says.push(`${f.name}: ${add.map((v) => v.key).join(', ')}`);
    }
  }
  return { save, says };
}

function take(mine: TreeItem, f: TreeItem, list: Part[]): TreeItem {
  const has = (p: Part) => list.includes(p);
  const out: TreeItem = { ...mine, ...(has('name') ? { name: f.name } : {}), ...(has('description') ? { description: f.description } : {}) };
  if (!f.request || !mine.request) return { ...out, ...(has('auth') ? { auth: f.auth } : {}), ...(has('preRequest') ? { preRequest: f.preRequest } : {}), ...(has('tests') ? { tests: f.tests } : {}) };
  const m = mine.request;
  const n = f.request;
  const url = has('url') ? { params: n.params, url: joinUrl(splitUrl(n.url).base, n.params) } : {};
  // A file the user picked again here stays picked for the same field.
  const body = { ...n.body, file: n.body.mode === 'binary' ? m.body.file : undefined, fields: (n.body.fields ?? []).map((x) => (x.type === 'file' ? { ...x, src: m.body.fields?.find((y) => y.key === x.key && y.type === 'file')?.src } : x)) };
  const request: RequestSpec = { ...m, ...(has('method') ? { method: n.method } : {}), ...url, ...(has('headers') ? { headers: n.headers } : {}), ...(has('body') ? { body } : {}), ...(has('auth') ? { auth: n.auth } : {}), ...(has('preRequest') ? { preRequest: n.preRequest } : {}), ...(has('tests') ? { tests: n.tests } : {}), ...(has('other') ? { wsMessage: n.wsMessage, grpc: n.grpc ? { ...n.grpc, protoFiles: m.grpc?.protoFiles } : m.grpc } : {}) };
  return { ...out, request };
}

export function brunoApply(items: TreeItem[], col: TreeItem, fresh: BrunoCollection, pick: { add: string[]; update: string[]; remove: string[] }): { save: TreeItem[]; remove: string[]; added: number; updated: number; removed: number } {
  const { mine, now } = match(items, col, fresh);
  const { changes } = brunoDiff(items, col, fresh);
  const add = new Set(pick.add);
  const update = new Set(pick.update);
  const drop = new Set(pick.remove);
  const save = new Map<string, TreeItem>();
  let updatedN = 0;
  for (const [k, f] of now) {
    const m = mine.get(k);
    if (!m) continue;
    const c = changed(m, f);
    const yes = c.parts.length > 0 && update.has(k);
    if (yes) updatedN++;
    // Seen either way: what was left out is not offered again until Bruno changes it.
    const next = yes ? take(m, f, c.parts.filter((p) => !c.kept.includes(p))) : m;
    if (yes || JSON.stringify(m.bruno!.base) !== JSON.stringify(f.bruno!.base)) save.set(m.id, { ...next, bruno: { ...m.bruno!, base: f.bruno!.base } });
  }
  // Added items, with the folders above them.
  const byId = new Map([fresh.root, ...fresh.items].map((i) => [i.id, i]));
  const idOf = new Map<string, string>([[fresh.root.id, col.id]]);
  let added = 0;
  const bring = (f: TreeItem): string => {
    const known = idOf.get(f.id) ?? mine.get(keyOf(f))?.id;
    if (known) return known;
    const parentId = bring(byId.get(f.parentId!)!);
    idOf.set(f.id, f.id);
    // After what is there already, in Bruno's order among the new ones.
    const last = Math.max(-1, ...items.filter((i) => i.parentId === parentId).map((i) => i.sort));
    save.set(f.id, { ...f, parentId, sort: last + 1 + f.sort / 1000 });
    if (f.kind === 'request') added++;
    return f.id;
  };
  for (const c of changes) if (c.kind === 'added' && add.has(c.key)) bring(now.get(c.key)!);
  // Gone from Bruno: deleted when picked (a folder only when nothing of the user's own stays in it), else the user's own.
  const gone = changes.filter((c) => c.kind === 'removed').map((c) => mine.get(c.key)!);
  const remove = new Set(gone.filter((i) => drop.has(keyOf(i))).map((i) => i.id));
  for (const i of gone.filter((x) => x.kind === 'folder' && remove.has(x.id))) for (const id of under(items, i.id)) if (id !== i.id && !remove.has(id)) remove.delete(i.id);
  // A folder kept keeps the folders above it.
  for (let again = true; again; ) {
    again = false;
    for (const id of [...remove]) if (items.some((x) => x.parentId === id && !remove.has(x.id))) (remove.delete(id), (again = true));
  }
  for (const i of gone) {
    if (remove.has(i.id)) continue;
    const { bruno: _, ...own } = i;
    save.set(i.id, own as TreeItem);
  }
  return { save: [...save.values()], remove: [...remove], added, updated: updatedN, removed: gone.filter((i) => i.kind === 'request' && remove.has(i.id)).length };
}
