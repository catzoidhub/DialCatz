import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** The OS version for About: on Linux the distribution (/etc/os-release, e.g. "Ubuntu 24.04.3 LTS"), not the kernel (as DBCatz). */
export function systemVersion(): string {
  if (process.platform !== 'linux') return process.getSystemVersion();
  try {
    const name = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1];
    if (name) return `${name} (kernel ${process.getSystemVersion()})`;
  } catch {
    /* no os-release */
  }
  return process.getSystemVersion();
}

/**
 * The computer DialCatz runs on, for AI prompts (as DevCatz §39: a Linux user was answered with Mac paths), e.g.
 * "Linux x64, Ubuntu 26.04.1 LTS (kernel …); shell bash". Only what is really there, never a guessed path.
 */
export function systemLabel(): string {
  const arch = process.arch === 'arm64' ? 'ARM64' : process.arch;
  const shell =
    process.platform === 'win32' ? 'PowerShell / Command Prompt' : basename(process.env.SHELL || (process.platform === 'darwin' ? 'zsh' : 'sh'));
  if (process.platform === 'darwin') return `macOS ${process.getSystemVersion()} (${process.arch === 'arm64' ? 'Apple silicon' : 'Intel'}); shell ${shell}`;
  if (process.platform === 'win32') return `Windows ${process.getSystemVersion()} ${arch}; shell ${shell}`;
  return `Linux ${arch}, ${systemVersion()}; shell ${shell}`;
}
