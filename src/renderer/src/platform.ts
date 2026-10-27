/**
 * Platform-aware words and shortcut labels live in @shared/platform (Catzoid rule: never write ⌘, Keychain, Finder … unconditionally).
 * This file re-exports them for the window and adds the window-only bits.
 */
import { currentOS } from '@shared/platform';

export { keyLabel, words } from '@shared/platform';

export const isMac = currentOS === 'mac';

/** Is the event's main modifier down (⌘ on macOS, Ctrl elsewhere). */
export const modKey = (e: KeyboardEvent | MouseEvent) => (isMac ? e.metaKey : e.ctrlKey);
