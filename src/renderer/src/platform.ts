/**
 * Platform-aware words and shortcut labels (Catzoid rule: never write ⌘, Keychain, Finder … unconditionally).
 * Later a shared @catzoid/* package.
 */

export const isMac = navigator.userAgent.includes('Mac OS X');

/** 'mod+Enter' → ⌘↩ on macOS, Ctrl+Enter elsewhere. */
export function keyLabel(combo: string): string {
  const parts = combo.split('+');
  if (isMac) {
    const map: Record<string, string> = { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↩' };
    return parts.map((p) => map[p.toLowerCase()] ?? p.toUpperCase()).join('');
  }
  const map: Record<string, string> = { mod: 'Ctrl', shift: 'Shift', alt: 'Alt', ctrl: 'Ctrl', enter: 'Enter' };
  return parts.map((p) => map[p.toLowerCase()] ?? p.toUpperCase()).join('+');
}

export const words = {
  secretStore: isMac ? 'Keychain' : 'the system’s secret store',
  fileManager: isMac ? 'Finder' : 'File Explorer',
  os: isMac ? 'macOS' : navigator.userAgent.includes('Windows') ? 'Windows' : 'Linux',
};

/** Is the event's main modifier down (⌘ on macOS, Ctrl elsewhere). */
export const modKey = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
