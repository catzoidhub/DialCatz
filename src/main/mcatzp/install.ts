import { approvalsAcrossApps, type McatzpApproval, addToClient as add, install as run, type McatzpInstallProgress, type McatzpSetup, type McatzpTarget, removeFromClient as remove, setupState as state, targets as list, type McatzpTargetId, type SetupOptions, uninstall as hostUninstall } from '@catzoid/mcatzp-host';
import { installPath } from '@catzoid/mcatzp-host/setup';
import type { McatzpUninstallResult } from '@shared/types';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
/**
 * Windows (MCatzP #29, 2026-11-10, as DBCatz 887513b): an AI assistant running MCatzP keeps mcatzp.exe locked, and the
 * host's install gave up with "MCatzP is in use: close the AI assistant using it". Windows lets a running .exe be moved,
 * not replaced: it goes into the temp folder under the name the host sweeps once it has stopped (mcatzp-<hex>.exe.old,
 * as its uninstall does since 1.0.4), the new copy is written, and the assistants already running keep the old one
 * until they restart. Put back when the install fails.
 */
function moveAsideIfRunning(target: string): string | null {
  if (process.platform !== 'win32' || !existsSync(target)) return null;
  try {
    closeSync(openSync(target, 'r+'));
    return null; // not running: the host replaces it itself
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM') return null;
  }
  const aside = join(process.env.TEMP || tmpdir(), `mcatzp-${randomBytes(4).toString('hex')}.exe.old`);
  renameSync(target, aside);
  return aside;
}

/** Installs or updates MCatzP. True when a copy an assistant was running had to be moved aside (Windows). */
export async function install(progress: (p: McatzpInstallProgress) => void, signal: AbortSignal): Promise<boolean> {
  const o = await options();
  const target = installPath(o);
  const aside = moveAsideIfRunning(target);
  try {
    await run(o, progress, signal);
  } catch (e) {
    if (aside && !existsSync(target)) {
      try {
        renameSync(aside, target);
      } catch {
        /* the host's next install writes a new one */
      }
    }
    throw e;
  }
  return aside !== null;
}
export const targets = async (): Promise<McatzpTarget[]> => list(await options());
export const addToClient = async (id: McatzpTargetId): Promise<void> => add(await options(), id);
export const removeFromClient = async (id: McatzpTargetId): Promise<void> => remove(await options(), id);
export const approvals = async (): Promise<McatzpApproval[]> => approvalsAcrossApps(await options());

/**
 * Uninstall MCatzP (user, 2026-11-10, the same in every Catzoid app), through the host package (MCatzP 1.0.4): the entries
 * that run the copy in use leave their clients, the shared copy goes (and its bin folder when empty; on Windows a copy
 * an assistant still runs is moved aside), a Homebrew / npm / bun copy stays with the command that removes it, an
 * `npx` entry is left alone. The other Catzoid apps lose MCatzP too: the window asks first.
 */
export const uninstall = async (): Promise<McatzpUninstallResult> => hostUninstall(await options());

/** The version to update to: only a copy these apps installed, a Homebrew or npm copy updates its own way. Null when up to date. */
export async function availableUpdate(): Promise<string | null> {
  const { source, version, latest } = await setupState();
  return source === 'catzoid' && version && latest && version.localeCompare(latest, undefined, { numeric: true }) < 0 ? latest : null;
}
