import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { CI_MARK, ciFile, ciLiterals, ciProblem, ciSlug, ciTested, ciText, ciVariables, SECRET_LIKE, type CiSetup, type CiTarget } from '@shared/ci';
import type { CiPlan, CiSaved, TreeItem, Workspace } from '@shared/types';
import { exportCollection } from './importers';

/**
 * "Run in CI" (#103): writes the workflow file into the collection's repository. A folder workspace already lives in
 * one; another workspace's collection is written next to the workflow as a DialCatz file. Only DialCatz's own files
 * are replaced, and only after asking.
 */

const slash = (p: string) => p.split(sep).join('/');
/** Both sides with links resolved (git answers /private/var for /var). */
const real = (p: string) => (existsSync(p) ? realpathSync.native(p) : p);

export function collectionOf(w: Workspace, id: string): TreeItem {
  const c = w.items.find((i) => i.id === id && i.kind === 'collection');
  if (!c) throw new Error('That collection is gone');
  return c;
}

export function target(w: Workspace, c: TreeItem, root: string | null): CiTarget {
  const names = { slug: ciSlug(c.name, c.id), title: c.name };
  if (w.folder) {
    const rel = root ? slash(relative(real(root), real(w.folder))) : '';
    const inside = (p: string) => {
      const r = slash(relative(real(root!), real(p)));
      return r && !r.startsWith('..') && !isAbsolute(r) ? r : '';
    };
    const spec = root && c.spec?.kind === 'file' && isAbsolute(c.spec.path) && existsSync(c.spec.path) ? inside(c.spec.path) : '';
    return { ...names, path: rel ? `./${rel}` : '.', collection: c.name, spec: spec ? `./${spec}` : '' };
  }
  return { ...names, path: `./api-tests/${names.slug}.dialcatz_collection.json`, collection: '', spec: '' };
}

export function plan(w: Workspace, collectionId: string, root: string | null): CiPlan {
  const c = collectionOf(w, collectionId);
  const envId = c.environmentId === undefined ? w.activeEnvironmentId : c.environmentId;
  const known = new Map([...(w.globals ?? []), ...(w.environments.find((e) => e.id === envId)?.variables ?? [])].filter((v) => v.enabled).map((v) => [v.key.trim(), v]));
  return {
    inRepo: !!w.folder,
    root: w.folder ? root : null,
    target: target(w, c, root),
    // A value goes into the file only when it is not a secret by its mark or its name; the dialog shows it first.
    variables: ciVariables(w.items, collectionId).map((name) => {
      const v = known.get(name);
      const secret = v?.secret === true || SECRET_LIKE.test(name);
      return { name, kind: secret ? ('secret' as const) : ('plain' as const), value: secret ? '' : (v?.value ?? '') };
    }),
    literals: ciLiterals(w.items, collectionId),
    ...ciTested(w.items, collectionId),
  };
}

/** A path under the root, refusing links that lead elsewhere. */
function inside(root: string, rel: string): string {
  let at = root;
  for (const part of rel.split('/').filter((p) => p && p !== '.')) {
    if (part === '..') throw new Error('That path leaves the repository');
    at = join(at, part);
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error(`${rel} goes through a link, so DialCatz does not write there`);
  }
  return at;
}

export function save(w: Workspace, collectionId: string, root: string, setup: CiSetup, overwrite: boolean): CiSaved {
  const c = collectionOf(w, collectionId);
  const problem = ciProblem(setup);
  if (problem) throw new Error(problem);
  const t = target(w, c, root);
  const main = ciFile(setup.provider, t.slug);
  const files = new Map<string, string>([[main, ciText(t, setup)]]);
  if (!w.folder) files.set(t.path.slice(2), `${JSON.stringify(exportCollection(w.items, collectionId), null, 2)}\n`);
  const notes: string[] = [];
  // GitLab reads one file: a new one includes ours, an existing one stays the user's.
  if (setup.provider === 'gitlab') {
    const top = inside(root, '.gitlab-ci.yml');
    const line = `include:\n  - local: ${main}\n`;
    if (!existsSync(top)) files.set('.gitlab-ci.yml', line);
    else if (!readFileSync(top, 'utf8').includes(main)) notes.push(`Add this to .gitlab-ci.yml (under the include it has, if any):\n${line}`);
  }
  const clash: string[] = [];
  for (const [rel, text] of files) {
    const abs = inside(root, rel);
    if (existsSync(abs) && readFileSync(abs, 'utf8') !== text) {
      if (rel === main && !readFileSync(abs, 'utf8').startsWith(CI_MARK)) throw new Error(`${rel} exists and was not made by DialCatz. Rename it first, or copy the text instead.`);
      clash.push(rel);
    }
  }
  if (clash.length && !overwrite) return { root, files: [], notes: [], exists: clash };
  for (const [rel, text] of files) {
    const abs = inside(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return { root, files: [...files.keys()], notes, exists: [] };
}
