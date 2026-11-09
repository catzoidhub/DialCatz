import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Linux (DialCatz #87, as DevCatz's and DoCatz's linuxadmin.ts): a shell script as root through polkit — `pkexec` shows
 * the desktop's own password dialog (GNOME, KDE …), like macOS's admin prompt and Windows' UAC. The script goes in a
 * fresh private temp folder for the one run. pkexec answers 126 when the dialog was dismissed and 127 when the user is
 * not allowed.
 */
export async function runAsRootLinux(script: string): Promise<{ ok: boolean; cancelled: boolean; message: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dialcatz-admin-'));
  const file = join(dir, 'step.sh');
  try {
    writeFileSync(file, `set -e\n${script}\n`, { mode: 0o600 });
    const r = await new Promise<{ code: number; out: string }>((resolve) =>
      execFile('pkexec', ['/bin/sh', file], { timeout: 600_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0, out: String(stderr || stdout || '').trim() }),
      ),
    );
    const cancelled = r.code === 126 || r.code === 127;
    return { ok: r.code === 0, cancelled, message: cancelled ? 'Cancelled' : r.out || (r.code === 0 ? '' : `exit ${r.code}`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Single quotes for a value in a root script. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
