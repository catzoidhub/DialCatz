import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** The OS DialCatz runs on, for the main process (the renderer and shared code use @shared/platform). */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

const found = new Map<string, string>();
/**
 * A program's full path from the Path (Windows: `<name>.exe`, absolute Path entries only). Windows looks in the
 * current folder before the Path, so spawning a bare "git" with cwd set to a cloned repository would run a git.exe
 * planted in it: DialCatz spawns the full path instead. Elsewhere (and when not found) the name as given.
 */
export function exePath(name: string): string {
  if (!isWin) return name;
  const hit = found.get(name);
  if (hit) return hit;
  for (const dir of (process.env.Path ?? process.env.PATH ?? '').split(';')) {
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir.replace(/^"|"$/g, ''), `${name}.exe`);
    if (existsSync(file)) {
      found.set(name, file);
      return file;
    }
  }
  return name;
}

/** Ends a process and what it started: on Windows a launcher (git.exe → git-remote-https) keeps its children alive. */
export function killTree(child: ChildProcess): void {
  if (isWin && child.pid) spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
  else child.kill('SIGTERM');
}

/** The user set up their own SSH for git (GIT_SSH, GIT_SSH_COMMAND or core.sshCommand): DialCatz leaves it alone. */
let ownSsh: boolean | null = null;
export function userSsh(): boolean {
  if (ownSsh === null) {
    if (process.env.GIT_SSH || process.env.GIT_SSH_COMMAND) ownSsh = true;
    else {
      const r = spawnSync(exePath('git'), ['config', '--get', 'core.sshCommand'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      ownSsh = r.status === 0 && !!r.stdout.trim();
    }
  }
  return ownSsh;
}
