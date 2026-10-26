import { uid, type EnvVariable, type PostmanChoice, type PostmanPick } from '@shared/types';
import { importText } from './importers';
import type { PostmanFound } from './postman';

/**
 * Moving from Postman with the user's own Postman API key instead of an export file (DialCatz TODO #52). The key
 * comes from Postman → Settings → API keys; it is used for this move only, in the main process, and never stored.
 * Postman API: /me (whose key), /workspaces, /workspaces/{id} (its collections and environments),
 * /collections/{uid} (v2.1 collection), /environments/{uid}, /workspaces/{id}/global-variables. Requests go one at a
 * time and wait when Postman says "too many" (429 + Retry-After). DIALCATZ_POSTMAN_API points elsewhere for tests.
 */

const BASE = () => (process.env.DIALCATZ_POSTMAN_API || 'https://api.getpostman.com').replace(/\/+$/, '');
const TIMEOUT = 30_000;

export interface PostmanWorkspace {
  id: string;
  name: string;
  type: string;
}

async function get<T>(key: string, path: string, tries = 4): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE()}${path}`, { headers: { 'X-Api-Key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new Error('DialCatz could not reach Postman (api.getpostman.com). Check the internet connection and try again.');
  }
  if (r.status === 429 && tries > 1) {
    const wait = Math.min(60, Number(r.headers.get('retry-after')) || 10);
    await new Promise((res) => setTimeout(res, wait * 1000));
    return get<T>(key, path, tries - 1);
  }
  if (r.status === 401 || r.status === 403) throw new Error('Postman did not accept this API key. Check it, or make a new one in Postman → Settings → API keys.');
  if (r.status === 429) throw new Error('Postman says too many requests for now. Wait a few minutes and try again (the free plan also has a monthly limit).');
  if (!r.ok) throw new Error(`Postman answered ${r.status} for ${path.split('?')[0]}`);
  return (await r.json()) as T;
}

const clean = (key: string) => {
  const k = String(key ?? '').trim();
  if (!/^[\w-]{10,200}$/.test(k)) throw new Error('That does not look like a Postman API key (it starts with PMAK-)');
  return k;
};

/** Whose key it is, and the workspaces it can see. */
export async function workspaces(key: string): Promise<{ user: string; workspaces: PostmanWorkspace[] }> {
  const k = clean(key);
  const me = await get<{ user?: { username?: string; fullName?: string; email?: string } }>(k, '/me');
  const list = await get<{ workspaces?: { id: string; name: string; type?: string }[] }>(k, '/workspaces');
  return {
    user: me.user?.fullName || me.user?.username || me.user?.email || 'your Postman account',
    workspaces: (list.workspaces ?? []).map((w) => ({ id: String(w.id), name: String(w.name ?? 'Workspace'), type: String(w.type ?? 'personal') })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

type PmVar = { key?: string; value?: unknown; enabled?: boolean; type?: string };
const vars = (list: PmVar[] | undefined): EnvVariable[] => (list ?? []).filter((v) => v?.key).map((v) => ({ key: String(v.key), value: v.value == null ? '' : String(v.value), enabled: v.enabled !== false, secret: v.type === 'secret' }));

type Ref = { id?: string; uid?: string; name?: string };
const refOf = (r: Ref) => String(r.uid ?? r.id ?? '');

/** What the chosen workspaces hold, to pick from before moving (names only: nothing is read in full yet). */
export async function contents(key: string, ids: string[]): Promise<PostmanChoice> {
  const k = clean(key);
  const groups: PostmanChoice['groups'] = [];
  for (const id of ids) {
    const w = await get<{ workspace?: { name?: string; collections?: Ref[]; environments?: Ref[] } }>(k, `/workspaces/${encodeURIComponent(id)}`);
    const named = (list: Ref[] | undefined, fallback: string) => (list ?? []).filter(refOf).map((r) => ({ id: refOf(r), name: String(r.name ?? fallback) })).sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ name: w.workspace?.name ?? 'Workspace', collections: named(w.workspace?.collections, 'Collection'), environments: named(w.workspace?.environments, 'Environment') });
  }
  return { token: '', groups, globals: true, skipped: [] };
}

/**
 * The picked collections and environments of the chosen workspaces (and their globals when `pick.globals`), in the
 * shape the export import produces. `progress` reports each step. With more than one workspace, environment names
 * get the workspace's name in front (they would clash otherwise).
 */
export async function pull(key: string, ids: string[], pick: PostmanPick, progress: (p: { done: number; total: number; label: string }) => void): Promise<PostmanFound> {
  const k = clean(key);
  const found: PostmanFound = { collections: [], environments: [], globals: [], skipped: [] };
  const wantC = new Set(pick.collections);
  const wantE = new Set(pick.environments);
  const plans: { ws: string; collections: Ref[]; environments: Ref[] }[] = [];
  for (const id of ids) {
    const w = await get<{ workspace?: { name?: string; collections?: Ref[]; environments?: Ref[] } }>(k, `/workspaces/${encodeURIComponent(id)}`);
    plans.push({ ws: w.workspace?.name ?? 'Workspace', collections: (w.workspace?.collections ?? []).filter((c) => wantC.has(refOf(c))), environments: (w.workspace?.environments ?? []).filter((e) => wantE.has(refOf(e))) });
  }
  const total = plans.reduce((n, p) => n + p.collections.length + p.environments.length + (pick.globals ? 1 : 0), 0);
  let done = 0;
  const step = (label: string) => progress({ done: ++done, total, label });
  for (const [i, p] of plans.entries()) {
    for (const c of p.collections) {
      const ref = refOf(c);
      try {
        const r = await get<{ collection?: Record<string, unknown> }>(k, `/collections/${encodeURIComponent(ref)}`);
        if (r.collection) found.collections.push(importText(JSON.stringify(r.collection)));
      } catch (e) {
        found.skipped.push(`${p.ws} / ${c.name ?? ref} (${(e as Error).message})`);
      }
      step(`${p.ws} / ${c.name ?? 'collection'}`);
    }
    for (const e of p.environments) {
      const ref = refOf(e);
      try {
        const r = await get<{ environment?: { name?: string; values?: PmVar[] } }>(k, `/environments/${encodeURIComponent(ref)}`);
        const name = r.environment?.name ?? e.name ?? 'Environment';
        found.environments.push({ id: uid('e_'), name: plans.length > 1 ? `${p.ws} · ${name}` : name, variables: vars(r.environment?.values) });
      } catch (err) {
        found.skipped.push(`${p.ws} / ${e.name ?? ref} (${(err as Error).message})`);
      }
      step(`${p.ws} / ${e.name ?? 'environment'}`);
    }
    if (!pick.globals) continue;
    try {
      const g = await get<{ values?: PmVar[] }>(k, `/workspaces/${encodeURIComponent(ids[i])}/global-variables`);
      found.globals.push(...vars(g.values).filter((v) => !found.globals.some((x) => x.key === v.key)));
    } catch {
      /* globals are optional: some plans and old workspaces have none */
    }
    step(`${p.ws} / globals`);
  }
  return found;
}
