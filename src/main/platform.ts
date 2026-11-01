/** The OS DialCatz runs on, for the main process (the renderer and shared code use @shared/platform). */
export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';
