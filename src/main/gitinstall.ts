import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';
import { runAsRootLinux } from './linuxadmin';
import { isLinux, isWin } from './platform';
import { gitVersion } from './gitcore';

/**
 * Install Git from the app (user, 2026-11-10; the same in DevCatz and DialCatz). Each OS's own way, with its own prompt:
 * - macOS: `xcode-select --install` opens Apple's installer for the Command Line Tools (git included); it runs on its
 *   own, so DialCatz waits for git to answer (up to 30 minutes).
 * - Windows: winget (`Git.Git`, Windows asks for administrator rights); without winget the download page opens.
 * - Linux: the package manager through pkexec (the desktop's password dialog): apt, dnf, pacman or zypper.
 * The result says whether git answers now; `cancelled` when the password / administrator prompt was dismissed.
 */

export type GitInstallResult = { ok: boolean; cancelled?: boolean; opened?: boolean; message?: string; version: string | null };

const run = (cmd: string, args: string[], timeout: number) =>
  new Promise<{ code: number; out: string }>((resolve) =>
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0, out: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
    ),
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Windows: the folders Git for Windows puts git.exe in, added to this process's Path (it does not see the new one). */
function windowsGitOnPath(): void {
  const dirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
    .filter((d): d is string => !!d)
    .map((d) => join(d, 'Git', 'cmd'))
    .filter((d) => existsSync(join(d, 'git.exe')));
  const path = process.env.Path ?? process.env.PATH ?? '';
  const add = dirs.filter((d) => !path.toLowerCase().split(';').includes(d.toLowerCase()));
  if (add.length) process.env.Path = process.env.PATH = [path, ...add].filter(Boolean).join(';');
}

let running: Promise<GitInstallResult> | null = null;

export function installGit(): Promise<GitInstallResult> {
  running ??= doInstall().finally(() => (running = null));
  return running;
}

async function doInstall(): Promise<GitInstallResult> {
  if (await gitVersion()) return { ok: true, version: await gitVersion() };
  if (isLinux) {
    const r = await runAsRootLinux(
      'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git >/dev/null; ' +
        'elif command -v dnf >/dev/null 2>&1; then dnf install -y -q git >/dev/null; ' +
        'elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed git >/dev/null; ' +
        'elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install git >/dev/null; ' +
        'else echo "No apt, dnf, pacman or zypper here: install git with your package manager" >&2; exit 3; fi',
    );
    if (r.cancelled) return { ok: false, cancelled: true, version: null };
    const v = await gitVersion();
    return v ? { ok: true, version: v } : { ok: false, message: r.message || 'git did not install', version: null };
  }
  if (isWin) {
    const winget = await run('winget', ['--version'], 20_000);
    if (winget.code !== 0) {
      await shell.openExternal('https://git-scm.com/download/win');
      return { ok: false, opened: true, message: 'The Git for Windows download page is open: run the installer, then come back.', version: null };
    }
    const r = await run('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], 20 * 60_000);
    windowsGitOnPath();
    const v = await gitVersion();
    if (v) return { ok: true, version: v };
    // 0x8A150011-ish codes and "cancelled" text when the administrator prompt was dismissed.
    if (/cancel|denied|1223|0x800704c7/i.test(r.out)) return { ok: false, cancelled: true, version: null };
    return { ok: false, message: r.out.split('\n').filter(Boolean).pop() || `winget exit ${r.code}`, version: null };
  }
  // macOS: Apple's installer window; its progress is its own, so wait for git to answer.
  const r = await run('xcode-select', ['--install'], 30_000);
  if (r.code !== 0 && !/already installed|install requested/i.test(r.out)) return { ok: false, message: r.out || 'xcode-select --install failed', version: null };
  // `xcode-select -p` first: /usr/bin/git without the tools would open Apple's prompt again on every try.
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    if ((await run('xcode-select', ['-p'], 10_000)).code !== 0) continue;
    const v = await gitVersion();
    if (v) return { ok: true, version: v };
  }
  return { ok: false, message: 'Git did not answer yet: finish Apple’s installer, then try again.', version: null };
}
