import { app, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AI_PROVIDERS, type UninstallPlan } from '@shared/types';
import { deleteToken } from './secrets';
import { servers } from './servers';
import { SHARED_DIR, setSharedKey } from './shared';

/**
 * Uninstall DialCatz (Catzoid family #55; the list is DialCatz TODO #53 and the Homebrew cask's `zap`): its data folder
 * (collections, environments, history, settings), the Keychain items with DialCatz Den tokens, caches, logs, saved
 * window state and preferences. The shared Catzoid settings and the "Catzoid AI" key go only when the user says so
 * (default: kept while another Catzoid app is installed). Never the user's own files (exports, saved responses).
 * The app bundle goes to the Trash and the app quits; the data folder is removed right after the quit (Electron
 * still writes to it while running). DIALCATZ_UNINSTALL_DRY_RUN=1 removes nothing (tests).
 */

const ID = 'com.mrcatz.dialcatz';
const LIB = join(homedir(), 'Library');
const SIBLINGS = ['DevCatz', 'DBCatz', 'DoCatz'];

function bundle(): string | null {
  // …/DialCatz.app/Contents/MacOS/DialCatz → …/DialCatz.app
  const p = dirname(dirname(dirname(app.getPath('exe'))));
  return app.isPackaged && p.endsWith('.app') ? p : null;
}

/** Folders and files DialCatz (or macOS on its behalf) put on this Mac, the data folder first. */
function paths(): string[] {
  return [
    app.getPath('userData'),
    join(LIB, 'Caches', ID),
    join(LIB, 'Caches', `${ID}.ShipIt`),
    join(LIB, 'Caches', `${app.getName()}-updater`),
    join(LIB, 'Caches', 'dialcatz-updater'),
    join(LIB, 'Logs', app.getName()),
    join(LIB, 'HTTPStorages', ID),
    join(LIB, 'Saved Application State', `${ID}.savedState`),
    join(LIB, 'Preferences', `${ID}.plist`),
    join(LIB, 'Application Support', 'CrashReporter', `${app.getName()}_*`),
  ];
}

function otherApps(): string[] {
  return SIBLINGS.filter((n) => [join('/Applications', `${n}.app`), join(homedir(), 'Applications', `${n}.app`)].some(existsSync));
}

function brew(): string | null {
  return ['/opt/homebrew/Caskroom/dialcatz', '/usr/local/Caskroom/dialcatz'].some(existsSync) ? 'brew uninstall --cask dialcatz' : null;
}

export function plan(): UninstallPlan {
  const tokens = servers().length;
  const home = (p: string) => p.replace(homedir(), '~');
  const b = bundle();
  return {
    items: [
      { label: 'Collections, environments, history and settings', detail: home(app.getPath('userData')) },
      ...(tokens ? [{ label: `${tokens} DialCatz Den token${tokens === 1 ? '' : 's'}`, detail: 'Keychain items “DialCatz Den”' }] : []),
      { label: 'Caches, logs and saved window state', detail: '~/Library/Caches, Logs, Saved Application State, Preferences' },
      ...(b ? [{ label: 'The app', detail: `${home(b)} → Trash` }] : []),
    ],
    otherApps: otherApps(),
    brew: brew(),
    dev: !b,
  };
}

export async function run(removeShared: boolean): Promise<void> {
  const dry = !!process.env.DIALCATZ_UNINSTALL_DRY_RUN;
  if (dry) return;
  // Secrets first, while the app still knows its server list.
  for (const s of servers()) await deleteToken(s.id).catch(() => {});
  if (removeShared) {
    for (const p of AI_PROVIDERS) await setSharedKey(p.id, '').catch(() => {});
  }
  const remove = [...paths(), ...(removeShared ? [SHARED_DIR] : [])];
  const b = bundle();
  if (b) await shell.trashItem(b).catch(() => {});
  // After the quit (the running app keeps writing to its data folder): a detached shell waits for this process to end.
  const quoted = remove.map((p) => (p.endsWith('*') ? `"${p.slice(0, -1)}"*` : `"${p}"`)).join(' ');
  const child = spawn('/bin/sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done; rm -rf ${quoted}`], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => app.exit(0), 300);
}
