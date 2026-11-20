import type { DoCatzProject, DocatzLink, TreeItem } from '@shared/types';
import * as docatz from './docatz';
import { repoOf } from './devcatzlink';

/**
 * The pairing between a DialCatz collection and a DoCatz compose project's service, as devcatzlink.ts does for DevCatz
 * sites: the service import, DoCatz's "Open in DialCatz", "Create mock server" (dialcatz://mock?docatz=) and the mocks
 * in bridge.json all match on it. `repo` (the compose folder's Git remote) finds the project on another computer,
 * where it may have another name. Older imports carry it in `origin` (docatz:<project>:<service>).
 */

export function linkOf(col: TreeItem): DocatzLink | null {
  if (col.docatz?.project) return col.docatz;
  const m = col.origin?.match(/^docatz:(.*):([^:]*)$/);
  return m ? { project: m[1], service: m[2] } : null;
}

/** The service a link means, as DoCatz picks it ('' left for DoCatz to choose). */
export const serviceOf = (p: DoCatzProject, service: string) => docatz.pickService(p, service || undefined)?.service ?? service;

export async function makeLink(p: DoCatzProject, service: string): Promise<DocatzLink> {
  const svc = serviceOf(p, service);
  const specFile = docatz.specFileOf(p, svc) ?? undefined;
  const repo = p.dir ? await repoOf(p.dir) : null;
  return { project: p.name, service: svc, ...(specFile ? { specFile } : {}), ...(repo ? { repo } : {}) };
}

/** The DoCatz project a link points at on this computer: by name, else by Git remote. */
export async function projectOf(link: DocatzLink): Promise<DoCatzProject | null> {
  const all = docatz.projects();
  const byName = all.find((p) => p.name === link.project);
  if (byName) return byName;
  if (!link.repo) return null;
  for (const p of all) if (p.dir && (await repoOf(p.dir)) === link.repo) return p;
  return null;
}

export async function linkedTo(col: TreeItem, p: DoCatzProject, service: string): Promise<boolean> {
  const l = linkOf(col);
  if (!l || serviceOf(p, l.service) !== serviceOf(p, service)) return false;
  if (l.project === p.name) return true;
  return !!l.repo && !!p.dir && l.repo === (await repoOf(p.dir));
}
