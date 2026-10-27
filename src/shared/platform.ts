/**
 * Platform-aware words and shortcut labels (Catzoid rule: never write ⌘, Keychain, Finder … unconditionally in UI text).
 * Works in the main process and the window. Electron menu accelerators stay CmdOrCtrl+…, this is for visible text only.
 */

export type OS = 'mac' | 'windows' | 'linux';

function detect(): OS {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux';
  }
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return ua.includes('Windows') ? 'windows' : ua.includes('Mac') ? 'mac' : 'linux';
}

export const currentOS: OS = detect();

export function wordsFor(os: OS) {
  return {
    os: os === 'mac' ? 'macOS' : os === 'windows' ? 'Windows' : 'Linux',
    computer: os === 'mac' ? 'Mac' : os === 'windows' ? 'PC' : 'computer',
    secretStore: os === 'mac' ? 'Keychain' : os === 'windows' ? 'Windows Credential Manager' : 'the system keyring',
    fileManager: os === 'mac' ? 'Finder' : os === 'windows' ? 'File Explorer' : 'the file manager',
  } as const;
}

export const words = wordsFor(currentOS);

/** 'mod+shift+P' → ⌘⇧P on macOS, Ctrl+Shift+P elsewhere. Key names pass through (single letters upper-cased). */
export function keyLabel(combo: string, os: OS = currentOS): string {
  const parts = combo.split('+');
  const key = (p: string) => (p.length === 1 ? p.toUpperCase() : p);
  if (os === 'mac') {
    const map: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↩' };
    return parts.map((p) => map[p.toLowerCase()] ?? key(p)).join('');
  }
  const map: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', enter: 'Enter' };
  return parts.map((p) => map[p.toLowerCase()] ?? key(p)).join('+');
}
