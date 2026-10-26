import { app, Notification } from 'electron';
import updaterPkg, { CancellationToken, type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { ReleaseNote, UpdatePrefs, UpdateState } from '@shared/types';
import { installId } from './reports';
import { siteBase } from './shared';
import { store } from './store';

/**
 * In-app updates (Catzoid family #54) with electron-updater. The feed is the Catzoid site's
 * `<site>/updates/dialcatz/` (generic provider: latest-mac.yml / beta-mac.yml from the newest GitHub release, the zip
 * redirected to its asset); the site address is the one shared by the Catzoid apps, so dev.catzoid.tech → catzoid.com
 * needs no new build. The repo is private, so there is no GitHub fallback in the app (it would need a token).
 * Nothing downloads without the user: a check finds a version, the What's New dialog offers it, the download is
 * checked (SHA-512 from the yml, then Squirrel.Mac checks the Developer ID signature) and installs on restart or quit.
 * DIALCATZ_UPDATE_FEED points the feed elsewhere for tests.
 */

const { autoUpdater } = updaterPkg;
const KEY = 'updates';
const FIRST_CHECK = 30_000;
const EVERY = 6 * 60 * 60_000;
const DEFAULTS: UpdatePrefs = { auto: true, channel: 'stable', notify: true, skipped: null, lastChecked: null };

let state: UpdateState = { kind: 'idle' };
let manual = false;
let cancel: CancellationToken | null = null;
let notified: string | null = null;
let timer: NodeJS.Timeout | null = null;
let send: (s: UpdateState) => void = () => {};
let onOpen: () => void = () => {};

export function prefs(): UpdatePrefs {
  const p = store.extra<Partial<UpdatePrefs>>(KEY) ?? {};
  return {
    auto: p.auto !== false,
    channel: p.channel === 'beta' ? 'beta' : 'stable',
    notify: p.notify !== false,
    skipped: typeof p.skipped === 'string' ? p.skipped : null,
    lastChecked: typeof p.lastChecked === 'number' ? p.lastChecked : null,
  };
}
function savePrefs(patch: Partial<UpdatePrefs>): UpdatePrefs {
  const next = { ...prefs(), ...patch };
  store.setExtra(KEY, next);
  return next;
}

export function setPrefs(patch: Partial<Pick<UpdatePrefs, 'auto' | 'channel' | 'notify'>>): UpdatePrefs {
  const clean: Partial<UpdatePrefs> = {};
  if (typeof patch.auto === 'boolean') clean.auto = patch.auto;
  if (patch.channel === 'stable' || patch.channel === 'beta') clean.channel = patch.channel;
  if (typeof patch.notify === 'boolean') clean.notify = patch.notify;
  const next = savePrefs(clean);
  schedule();
  return next;
}

const feed = () => process.env.DIALCATZ_UPDATE_FEED || `${siteBase()}/updates/dialcatz/`;
const platform = () => (process.platform === 'win32' ? 'win-x64' : process.arch === 'x64' ? 'mac-x64' : 'mac-arm64');
/** The site's download link, for when an update fails ("Download from the site"). */
const downloadPage = () => `${siteBase()}/download/dialcatz/${platform()}`;

function set(next: UpdateState) {
  state = next;
  send(state);
}

export const current = () => state;

/** Plain words for what went wrong, with the host the user can check. */
function friendly(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  const host = (() => {
    try {
      return new URL(feed()).host;
    } catch {
      return 'the Catzoid site';
    }
  })();
  if (/\b404\b|Cannot find latest|No update feed|Not found/i.test(msg)) return `${host} has no DialCatz update feed yet. Try again later, or download DialCatz from the site.`;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|net::ERR_|getaddrinfo|socket hang up/i.test(msg)) return `DialCatz could not reach ${host}. Check the internet connection and try again.`;
  if (/sha512|checksum|signature|code ?sign|not signed|Could not get code signature/i.test(msg)) return 'The downloaded update could not be verified, so it was not installed. Try again, or download DialCatz from the site.';
  if (/cancel/i.test(msg)) return 'The download was cancelled.';
  return `The update did not work: ${msg.split('\n')[0].slice(0, 200)}`;
}

/** Compares x.y.z versions (pre-release tags sort before the release). */
function cmp(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/);
  const pb = b.replace(/^v/, '').split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x === y) continue;
    if (i >= 3) return x === '' ? 1 : y === '' ? -1 : x.localeCompare(y);
    return (Number(x) || 0) - (Number(y) || 0);
  }
  return 0;
}

/** The notes of every version after the installed one up to the new one (the site's releases list), newest first. */
async function notesBetween(from: string, to: string, info: UpdateInfo): Promise<ReleaseNote[]> {
  try {
    const r = await fetch(`${siteBase()}/api/dialcatz/releases`, { signal: AbortSignal.timeout(10_000) });
    if (r.ok) {
      const list = (await r.json()) as { version: string; date: string; notes: string }[];
      const picked = list.filter((x) => cmp(x.version, from) > 0 && cmp(x.version, to) <= 0).map((x) => ({ version: x.version, date: x.date, notes: x.notes ?? '' }));
      if (picked.length) return picked.sort((a, b) => cmp(b.version, a.version));
    }
  } catch {
    /* the site's list is a nicety: the yml's own notes below */
  }
  const own = typeof info.releaseNotes === 'string' ? info.releaseNotes : Array.isArray(info.releaseNotes) ? info.releaseNotes.map((n) => n.note ?? '').join('\n\n') : '';
  return [{ version: info.version, date: info.releaseDate ?? '', notes: own.replace(/<[^>]+>/g, '') }];
}

function notify(version: string) {
  const p = prefs();
  if (manual || !p.notify || notified === version || !Notification.isSupported()) return;
  notified = version;
  const n = new Notification({ title: `DialCatz ${version} is available`, body: 'Click to see what’s new.' });
  n.on('click', () => onOpen());
  n.show();
}

export async function check(byUser: boolean): Promise<UpdateState> {
  if (state.kind === 'downloading' || state.kind === 'verifying' || state.kind === 'downloaded' || state.kind === 'checking') return state;
  manual = byUser;
  autoUpdater.setFeedURL({ provider: 'generic', url: feed(), channel: prefs().channel === 'beta' ? 'beta' : 'latest' });
  autoUpdater.allowPrerelease = prefs().channel === 'beta';
  // X-Catzoid-Install / -Version / -Channel on every feed request, like the other Catzoid apps (Catzoid #28 / #65)
  autoUpdater.requestHeaders = { 'X-Catzoid-Install': installId(), 'X-Catzoid-Version': app.getVersion(), 'X-Catzoid-Channel': String(prefs().channel) };
  set({ kind: 'checking', manual: byUser });
  try {
    const r = await autoUpdater.checkForUpdates();
    savePrefs({ lastChecked: Date.now() });
    const info = r?.updateInfo;
    if (!info || !r?.isUpdateAvailable || cmp(info.version, app.getVersion()) <= 0) {
      set({ kind: 'none', version: app.getVersion(), manual: byUser });
    } else if (!byUser && prefs().skipped === info.version) {
      set({ kind: 'idle' });
    } else {
      const zip = info.files?.find((f) => f.url.endsWith('.zip')) ?? info.files?.[0];
      set({ kind: 'available', version: info.version, current: app.getVersion(), size: zip?.size ?? null, notes: await notesBetween(app.getVersion(), info.version, info) });
      notify(info.version);
    }
  } catch (e) {
    savePrefs({ lastChecked: Date.now() });
    set(byUser ? { kind: 'error', message: friendly(e), manual: true, download: downloadPage() } : { kind: 'idle' });
  }
  return state;
}

export async function download(): Promise<void> {
  if (state.kind !== 'available') return;
  const version = state.version;
  const back = state;
  cancel = new CancellationToken();
  set({ kind: 'downloading', version, percent: 0, transferred: 0, total: back.size ?? 0, bytesPerSecond: 0 });
  try {
    await autoUpdater.downloadUpdate(cancel);
  } catch (e) {
    if (cancel?.cancelled) set(back);
    else set({ kind: 'error', message: friendly(e), manual: true, download: downloadPage() });
  } finally {
    cancel = null;
  }
}

export function cancelDownload(): void {
  cancel?.cancel();
}

export function install(when: 'now' | 'quit'): void {
  if (state.kind !== 'downloaded') return;
  if (when === 'now') {
    // isSilent false, isForceRunAfter true: the new version opens after the swap.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  } else {
    autoUpdater.autoInstallOnAppQuit = true;
    set({ ...state, onQuit: true });
  }
}

export function skip(version: string): void {
  savePrefs({ skipped: String(version) });
  if (state.kind === 'available') set({ kind: 'idle' });
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!prefs().auto) return;
  timer = setInterval(() => void check(false), EVERY);
}

/** Wires the updater: `onState` reaches the window, `open` shows it with the What's New dialog (a notification click). */
export function init(onState: (s: UpdateState) => void, open: () => void): void {
  send = onState;
  onOpen = open;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;
  // A build folder (`electron .`) has no app-update.yml; checks there only run against a test feed.
  if (!app.isPackaged) {
    if (!process.env.DIALCATZ_UPDATE_FEED) return;
    autoUpdater.forceDevUpdateConfig = true;
  }
  autoUpdater.on('download-progress', (p: ProgressInfo) => {
    if (state.kind !== 'downloading') return;
    if (p.percent >= 100) set({ kind: 'verifying', version: state.version });
    else set({ ...state, percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => set({ kind: 'downloaded', version: info.version, onQuit: false }));
  setTimeout(() => {
    if (prefs().auto) void check(false);
  }, FIRST_CHECK);
  schedule();
}
