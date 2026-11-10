import { dialog, type BrowserWindow, type MessageBoxOptions, type MessageBoxReturnValue, type OpenDialogOptions, type OpenDialogReturnValue, type SaveDialogOptions, type SaveDialogReturnValue } from 'electron';
import { isLinux } from './platform';

/**
 * File dialogs (open / save) attached to DialCatz's window.
 *
 * Linux (Wayland, GNOME 50 on Ubuntu 26.04, Electron 44): a dialog for a window that is not the active one kills the
 * app — Chromium exports the window for the dialog (xdg-foreign), mutter refuses ("zxdg_exporter_v2: exported surface
 * had an invalid role"), drops the connection and the app dies (SIGTRAP), with no dialog shown. It happens whenever the
 * dialog comes while another app is in front: an MCatzP client asking for an export, a link, a menu shortcut right
 * after switching apps. Found in DBCatz (464a976) and DialCatz in the Hyper-V VM, 2026-11-10. So on Linux the window
 * comes to the front first; when the desktop will not give it the focus (focus stealing prevention), the dialog opens
 * on its own instead — no parent, nothing to export, no crash.
 */
async function parent(w: BrowserWindow | null | undefined): Promise<BrowserWindow | null> {
  if (!w || w.isDestroyed()) return null;
  if (!isLinux || w.isFocused()) return w;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  const focused = await new Promise<boolean>((resolve) => {
    if (w.isFocused()) return resolve(true);
    const done = (v: boolean) => {
      clearTimeout(timer);
      w.off('focus', onFocus);
      resolve(v);
    };
    const onFocus = () => done(true);
    const timer = setTimeout(() => done(w.isFocused()), 1500);
    w.on('focus', onFocus);
  });
  return focused && !w.isDestroyed() ? w : null;
}

export async function openDialog(win: BrowserWindow | null | undefined, options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const w = await parent(win);
  return w ? dialog.showOpenDialog(w, options) : dialog.showOpenDialog(options);
}

export async function messageBox(win: BrowserWindow | null | undefined, options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const w = await parent(win);
  return w ? dialog.showMessageBox(w, options) : dialog.showMessageBox(options);
}

export async function saveDialog(win: BrowserWindow | null | undefined, options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const w = await parent(win);
  return w ? dialog.showSaveDialog(w, options) : dialog.showSaveDialog(options);
}
