import { approvalsAcrossApps, installPath, type McatzpApproval, addToClient as add, install as run, type McatzpInstallProgress, type McatzpSetup, type McatzpTarget, removeFromClient as remove, setupState as state, targets as list, type McatzpTargetId, type SetupOptions } from '@catzoid/mcatzp-host';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { siteBase } from '../shared';

/** An app opened from the desktop has a bare PATH on a Mac; Homebrew's or npm's copy is only found with the login shell's. */
let shellEnv: Promise<NodeJS.ProcessEnv> | null = null;
function loginEnv(): Promise<NodeJS.ProcessEnv> {
  if (process.platform === 'win32') return Promise.resolve(process.env);
  shellEnv ??= new Promise((done) => {
    const marker = '__DIALCATZ_ENV__';
    execFile(process.env.SHELL || '/bin/zsh', ['-ilc', `echo ${marker}; env; echo ${marker}`], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (_e, out) => {
      const body = String(out ?? '').split(marker)[1] ?? '';
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const line of body.split('\n')) {
        const at = line.indexOf('=');
        if (at > 0 && line.slice(0, at) === 'PATH') env.PATH = line.slice(at + 1);
      }
      done(env);
    });
  });
  return shellEnv;
}

/** The shared copy of MCatzP and the assistants' entries: the rules live in the shared package, for every Catzoid app. */
const options = async (): Promise<SetupOptions> => ({ site: siteBase(), env: await loginEnv() });

export const setupState = async (askSite = true): Promise<McatzpSetup> => state(await options(), askSite);
export const install = async (progress: (p: McatzpInstallProgress) => void, signal: AbortSignal): Promise<void> => run(await options(), progress, signal);
export const targets = async (): Promise<McatzpTarget[]> => list(await options());
export const addToClient = async (id: McatzpTargetId): Promise<void> => add(await options(), id);
export const removeFromClient = async (id: McatzpTargetId): Promise<void> => remove(await options(), id);
export const approvals = async (): Promise<McatzpApproval[]> => approvalsAcrossApps(await options());

/**
 * Uninstall MCatzP (user, 2026-11-10, the same in every Catzoid app; as DevCatz c0a4291): its entry is taken out of
 * every AI assistant that has one, and the shared copy goes when a Catzoid app installed it (~/.catzoid/bin/mcatzp,
 * %LOCALAPPDATA%\Catzoid\bin); a Homebrew / npm / other copy is left to the tool that put it there, and its path is
 * returned to say so. The other Catzoid apps lose MCatzP too: the window asks first.
 */
export async function uninstall(): Promise<{ removedFrom: string[]; binary: 'removed' | 'kept' | 'none'; keptPath: string | null }> {
  const o = await options();
  const removedFrom: string[] = [];
  for (const t of await list(o)) {
    if (!t.current) continue;
    await remove(o, t.id);
    removedFrom.push(t.label);
  }
  const s = await state(o, false);
  if (!s.path) return { removedFrom, binary: 'none', keptPath: null };
  if (s.source !== 'catzoid') return { removedFrom, binary: 'kept', keptPath: s.path };
  const file = installPath(o);
  rmSync(file, { force: true });
  // The bin folder too, when MCatzP was all it held.
  try {
    if (existsSync(dirname(file)) && !readdirSync(dirname(file)).length) rmSync(dirname(file), { recursive: true, force: true });
  } catch {
    /* in use or not ours to clear */
  }
  return { removedFrom, binary: 'removed', keptPath: null };
}

/** The version to update to: only a copy these apps installed, a Homebrew or npm copy updates its own way. Null when up to date. */
export async function availableUpdate(): Promise<string | null> {
  const { source, version, latest } = await setupState();
  return source === 'catzoid' && version && latest && version.localeCompare(latest, undefined, { numeric: true }) < 0 ? latest : null;
}
