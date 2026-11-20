import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { DevCatzSite, DevcatzLink, TreeItem } from '@shared/types';
import * as devcatz from './devcatz';
import { git } from './gitcore';

/**
 * The pairing between a DialCatz collection and a DevCatz site (and one of its apps). One link, kept on the collection,
 * that every DevCatz feature matches on: importing the site's routes again, DevCatz's "Open in DialCatz", "Create mock
 * server", and the mocks listed in bridge.json.
 *   siteId    DevCatz's id for the site on this computer
 *   app       the app's folder in the site ('' = the site itself)
 *   specFile  the OpenAPI file DevCatz lists for that app, relative to the site, forward slashes
 *   repo      the site's Git remote ("github.com/owner/repo"): the same on every computer, so a teammate's DialCatz
 *             finds the site in their DevCatz, whose id differs there
 * Collections imported before the link existed carry it in `origin` (devcatz:<site>:<app>); linkOf reads both.
 */

/** "git@github.com:Owner/Repo.git", "https://user@github.com/owner/repo/" → "github.com/owner/repo". */
export function repoKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/^([^/:]+):\d+\//, '$1/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

const repos = new Map<string, { at: number; key: string | null }>();
/** The site folder's Git remote as a key (origin's, else the first remote); null when it has none. Cached a minute. */
export async function repoOf(path: string): Promise<string | null> {
  const hit = repos.get(path);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  let key: string | null = null;
  try {
    const r = await git(path, ['remote', '-v'], { timeout: 5000 });
    const lines = r.code === 0 ? r.stdout.split('\n').filter((l) => /\(fetch\)\s*$/.test(l)) : [];
    const pick = lines.find((l) => l.startsWith('origin\t')) ?? lines[0];
    const url = pick?.split(/\s+/)[1];
    key = url ? repoKey(url) : null;
  } catch {
    key = null;
  }
  repos.set(path, { at: Date.now(), key });
  return key;
}

/** The link a collection carries: its own, else the one an older import left in `origin`. */
export function linkOf(col: TreeItem): DevcatzLink | null {
  if (col.devcatz?.siteId) return col.devcatz;
  const m = col.origin?.match(/^devcatz:(.*):([^:]*)$/);
  return m ? { siteId: m[1], app: m[2] } : null;
}

/** The app folder a link means, as DevCatz picks it ('' left for DevCatz to choose = its API app). */
export const appDir = (site: DevCatzSite, app: string) => devcatz.pickApp(site, app || undefined)?.dir ?? app;

const rel = (root: string, file: string): string | null => {
  const r = relative(resolve(root), resolve(file));
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null;
};

/** The OpenAPI file DevCatz lists for an app of the site, relative to the site; undefined when none. */
export function specFileOf(site: DevCatzSite, app: string): string | undefined {
  const dir = appDir(site, app);
  const file = site.openapi.find((o) => o.file && o.app === dir)?.file;
  return file ? (rel(site.path, file) ?? undefined) : undefined;
}

/** The app a spec file of the site belongs to: the one DevCatz lists it for, else the app folder it sits in. */
export function appOfSpec(site: DevCatzSite, specFile: string): string {
  const listed = site.openapi.find((o) => o.file && rel(site.path, o.file) === specFile)?.app;
  if (listed !== undefined) return listed;
  return [...site.apps].sort((a, b) => b.dir.length - a.dir.length).find((a) => a.dir && (specFile === a.dir || specFile.startsWith(`${a.dir}/`)))?.dir ?? '';
}

/** A fresh link to a site and app (with its spec file and Git remote). */
export async function makeLink(site: DevCatzSite, app: string): Promise<DevcatzLink> {
  const dir = appDir(site, app);
  const specFile = specFileOf(site, dir);
  const repo = await repoOf(site.path);
  return { siteId: site.id, app: dir, ...(specFile ? { specFile } : {}), ...(repo ? { repo } : {}) };
}

/** The DevCatz site a link points at on this computer: by id, else (a teammate's link) by Git remote. */
export async function siteOf(link: DevcatzLink): Promise<DevCatzSite | null> {
  const sites = devcatz.sites();
  const byId = sites.find((s) => s.id === link.siteId);
  if (byId) return byId;
  if (!link.repo) return null;
  for (const s of sites) if ((await repoOf(s.path)) === link.repo) return s;
  return null;
}

/** Whether a collection is linked to this site's app (its id here, or the same Git remote anywhere). */
export async function linkedTo(col: TreeItem, site: DevCatzSite, app: string): Promise<boolean> {
  const l = linkOf(col);
  if (!l) return false;
  if (appDir(site, l.app) !== appDir(site, app)) return false;
  if (l.siteId === site.id) return true;
  return !!l.repo && l.repo === (await repoOf(site.path));
}
