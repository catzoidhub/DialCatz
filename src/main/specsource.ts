import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { TreeItem } from '@shared/types';
import * as devcatz from './devcatz';
import * as docatz from './docatz';
import { importSpec } from './importers';
import type { Fresh } from './specsync';

/** Where a collection's spec comes from (#92): its file or URL, or the DevCatz site / DoCatz service it was imported from. */

export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');

const MAX = 20 * 1024 * 1024;

/** An OpenAPI document served at an http(s) address. */
export async function fetchSpecText(url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('That is not a web address');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http and https addresses');
  const res = await fetch(u, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json, application/yaml, text/yaml, */*' } });
  if (!res.ok) throw new Error(`${u.host} answered ${res.status} for the spec`);
  const text = await res.text();
  if (text.length > MAX) throw new Error('The spec is larger than 20 MB');
  return text;
}

export function readSpecFile(path: string): string {
  if (!existsSync(path)) throw new Error(`${basename(path)} is not at ${path} on this computer. Choose “Follow a spec file…” to pick where it is now.`);
  return readFileSync(path, 'utf8');
}

/** The spec as it is now, made into a collection the same way an import makes one. */
export async function freshFor(col: TreeItem): Promise<{ fresh: Fresh; source: string; hash?: string }> {
  if (col.spec) {
    const text = col.spec.kind === 'file' ? readSpecFile(col.spec.path) : await fetchSpecText(col.spec.path);
    const r = importSpec(text);
    return { fresh: { root: r.root, items: r.items }, source: col.spec.kind === 'file' ? basename(col.spec.path) : col.spec.path, hash: hashText(text) };
  }
  const dc = col.origin?.match(/^devcatz:(.*):([^:]*)$/);
  if (dc) {
    const site = devcatz.site(dc[1]);
    const r = await devcatz.routes(site, dc[2] || undefined);
    return { fresh: { root: r.root, items: r.items }, source: `DevCatz · ${site.name}` };
  }
  const dk = col.origin?.match(/^docatz:(.*):([^:]*)$/);
  if (dk) {
    const p = docatz.project(dk[1]);
    if (!p.running) throw new Error(`${p.name} is not running, so DialCatz cannot read its routes. Start it in DoCatz, then check again.`);
    const r = await docatz.routes(p, dk[2] || undefined);
    return { fresh: { root: r.root, items: r.items }, source: `DoCatz · ${p.name}` };
  }
  throw new Error('This collection does not follow a spec');
}
