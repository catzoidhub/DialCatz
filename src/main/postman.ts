import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uid, type Environment, type EnvVariable, type TreeItem } from '@shared/types';
import { importText } from './importers';

/**
 * Moving from Postman: its full data export (Settings → Account → Export data: a zip with collection/,
 * environment/ and globals), a folder of exported files, or single collection / environment JSON files. Every
 * collection becomes a DialCatz collection, every environment an environment, globals the workspace's globals.
 * Postman "secret" values stay marked secret.
 */

export interface PostmanFound {
  collections: { root: TreeItem; items: TreeItem[] }[];
  environments: Environment[];
  globals: EnvVariable[];
  skipped: string[];
}

const MAX_FILES = 2000;

/** Unpacks a zip with the system's tar (bsdtar reads zip on macOS and Windows 10+). */
function unzip(zip: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dialcatz-postman-'));
  return new Promise((resolve, reject) =>
    execFile(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-xf', zip, '-C', dir], { timeout: 120_000 }, (err) => (err ? (rmSync(dir, { recursive: true, force: true }), reject(new Error(`Could not open ${zip}: ${err.message}`))) : resolve(dir))),
  );
}

function jsonFiles(path: string, out: string[] = []): string[] {
  const st = statSync(path);
  if (st.isFile()) {
    if (/\.json$/i.test(path)) out.push(path);
    return out;
  }
  for (const name of readdirSync(path)) {
    if (out.length >= MAX_FILES) break;
    if (name.startsWith('.') || name === '__MACOSX') continue;
    jsonFiles(join(path, name), out);
  }
  return out;
}

type PmVar = { key?: string; value?: unknown; enabled?: boolean; type?: string };
const vars = (list: PmVar[]): EnvVariable[] => list.filter((v) => v?.key).map((v) => ({ key: String(v.key), value: v.value == null ? '' : String(v.value), enabled: v.enabled !== false, secret: v.type === 'secret' }));

function classify(file: string, found: PostmanFound): void {
  let doc: Record<string, unknown>;
  const text = readFileSync(file, 'utf8');
  try {
    doc = JSON.parse(text);
  } catch {
    found.skipped.push(`${file} (not JSON)`);
    return;
  }
  // Postman's dump has an archive.json index: nothing to import from it.
  if (/archive\.json$/i.test(file)) return;
  const scope = doc._postman_variable_scope;
  if (Array.isArray(doc.values) && (scope === 'environment' || (typeof doc.name === 'string' && scope !== 'globals'))) {
    found.environments.push({ id: uid('e_'), name: String(doc.name || 'Environment'), variables: vars(doc.values as PmVar[]) });
    return;
  }
  if (Array.isArray(doc.values) && scope === 'globals') {
    found.globals.push(...vars(doc.values as PmVar[]));
    return;
  }
  // A dump's collection files can be wrapped: { collection: {...} }.
  const col = doc.info ? doc : (doc.collection as Record<string, unknown> | undefined);
  if (col?.info && Array.isArray(col.item)) {
    try {
      found.collections.push(importText(JSON.stringify(col)));
    } catch (e) {
      found.skipped.push(`${file} (${(e as Error).message})`);
    }
    return;
  }
  found.skipped.push(`${file} (not a Postman collection or environment)`);
}

/** Reads everything Postman-shaped in the given files, folders or zips. */
export async function read(paths: string[]): Promise<PostmanFound> {
  const found: PostmanFound = { collections: [], environments: [], globals: [], skipped: [] };
  const temps: string[] = [];
  try {
    for (const p of paths) {
      const root = /\.zip$/i.test(p) ? await unzip(p) : p;
      if (root !== p) temps.push(root);
      for (const f of jsonFiles(root)) classify(f, found);
    }
  } finally {
    for (const t of temps) rmSync(t, { recursive: true, force: true });
  }
  return found;
}
