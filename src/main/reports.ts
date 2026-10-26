import { app, crashReporter } from 'electron';
import { randomUUID } from 'node:crypto';
import { homedir, release } from 'node:os';
import type { ReportDraft, ReportPrefs, ReportShot } from '@shared/types';
import { siteBase } from './shared';
import { store } from './store';
import { prefs as updatePrefs } from './updates';

/**
 * Bug reports, feedback and opt-in crash / error reports (Catzoid family #65, the in-app side of #28) to the Catzoid
 * site's `POST <site>/api/reports` (native crashes: `<site>/api/reports/minidump` through Electron's crashReporter).
 * Every report carries the app, version, channel, OS, arch and a random install id — never tokens, request or
 * response bodies, environment values or hosts (DialCatz TODO #53): `scrub` takes those out of messages and stacks.
 * A report that cannot be sent (offline, the site down) waits in a small queue and goes later.
 */

const PREFS = 'reports';
const QUEUE = 'reportQueue';
const SENT = 'reportSent';
const MAX_QUEUE = 20;
/** Screenshots on a bug report (Catzoid #67): how many, how large, and how many queued reports may keep theirs. */
const SHOTS_MAX = 3;
const SHOT_BYTES = 2.5 * 1024 * 1024;
const QUEUED_WITH_SHOTS = 3;

/** The screenshots that may go: PNG / JPEG by their bytes, at most SHOTS_MAX of at most SHOT_BYTES each. */
function checkShots(shots: unknown[]): ReportShot[] {
  if (shots.length > SHOTS_MAX) throw new Error(`At most ${SHOTS_MAX} screenshots`);
  return shots.map((x) => {
    const s = x as Partial<ReportShot>;
    const bytes = Buffer.from(String(s.data ?? ''), 'base64');
    const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!png && !jpeg) throw new Error('Screenshots must be PNG or JPEG');
    if (bytes.length > SHOT_BYTES) throw new Error('A screenshot is too large — try a smaller window');
    return { type: png ? 'image/png' : 'image/jpeg', data: String(s.data) };
  });
}

type Input = Record<string, unknown> & { type: 'crash' | 'error' | 'feedback'; message: string };

/** A random id for this install (no personal data), shared by reports and update checks. */
export function installId(): string {
  let id = store.extra<string>('installId');
  if (!id) {
    id = randomUUID();
    store.setExtra('installId', id);
  }
  return id;
}

export function prefs(): ReportPrefs {
  const p = store.extra<Partial<ReportPrefs>>(PREFS) ?? {};
  return { crashReports: p.crashReports === true, askCrash: p.askCrash === true };
}
export function setPrefs(patch: Partial<ReportPrefs>): ReportPrefs {
  const next = { ...prefs() };
  if (typeof patch.crashReports === 'boolean') {
    next.crashReports = patch.crashReports;
    next.askCrash = false;
  }
  if (typeof patch.askCrash === 'boolean') next.askCrash = patch.askCrash;
  store.setExtra(PREFS, next);
  crashReporter.setUploadToServer(next.crashReports);
  return next;
}

/** Takes secrets and private details out of text that goes in a report. */
export function scrub(text: string): string {
  return text
    .replace(/(authorization|cookie|x-api-key|api[_-]?key|token|secret|password|passwd|bearer)(["'\s:=]+)([^\s"',;]+)/gi, '$1$2<redacted>')
    .replace(/\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<jwt>')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (u) => (/^file:/i.test(u) ? '<file>' : `${u.split(':')[0]}://<host>`))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .split(homedir())
    .join('~');
}

const osName = () => (process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux');

/** The exact JSON a report sends (also what "Preview what is sent" shows). */
function body(input: Input): Record<string, unknown> {
  return {
    app: 'dialcatz',
    version: app.getVersion(),
    channel: updatePrefs().channel,
    os: osName(),
    osVersion: process.getSystemVersion?.() ?? release(),
    arch: process.arch,
    installId: installId(),
    ...input,
  };
}

function draftInput(d: ReportDraft): Input {
  const kind = d.kind === 'idea' || d.kind === 'question' ? d.kind : 'bug';
  const email = typeof d.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim()) ? d.email.trim().slice(0, 200) : undefined;
  // Scrubbed too: a pasted token or server address should not leave the computer by accident (the preview shows it).
  return { type: 'feedback', message: scrub(String(d.message ?? '')).slice(0, 10_000), ...(email ? { email } : {}), extra: { kind } };
}

export function preview(d: ReportDraft): string {
  const b = body(draftInput(d));
  const n = Math.min(Number(d.shotCount ?? d.shots?.length ?? 0) || 0, SHOTS_MAX);
  if (d.kind === 'bug' && n > 0) b.screenshots = `${n} image(s), sent as separate parts — exactly as shown in the dialog`;
  return JSON.stringify(b, null, 2);
}

async function post(payload: Record<string, unknown>): Promise<'sent' | 'retry' | 'refused'> {
  try {
    const { _shots, ...report } = payload as Record<string, unknown> & { _shots?: ReportShot[] };
    const headers: Record<string, string> = { 'X-Catzoid-Install': String(report.installId), 'X-Catzoid-Version': app.getVersion(), 'X-Catzoid-Channel': String(report.channel) };
    let data: string | FormData;
    if (_shots?.length) {
      // with screenshots: the same JSON in `report`, each image in an `image` part (Catzoid #67)
      const form = new FormData();
      form.append('report', JSON.stringify(report));
      _shots.forEach((s, i) => form.append('image', new Blob([Buffer.from(s.data, 'base64')], { type: s.type }), `screenshot-${i + 1}.${s.type === 'image/png' ? 'png' : 'jpg'}`));
      data = form;
    } else {
      headers['Content-Type'] = 'application/json';
      data = JSON.stringify(report);
    }
    const r = await fetch(`${siteBase()}/api/reports`, { method: 'POST', headers, body: data, signal: AbortSignal.timeout(_shots?.length ? 60_000 : 15_000) });
    if (r.ok) return 'sent';
    // Too many, too big or not accepted: sending again would not help. The site down: later.
    return r.status >= 500 || r.status === 404 ? 'retry' : 'refused';
  } catch {
    return 'retry';
  }
}

function enqueue(payload: Record<string, unknown>) {
  const q = [...(store.extra<Record<string, unknown>[]>(QUEUE) ?? []), payload].slice(-MAX_QUEUE);
  // screenshots are heavy: only the newest few queued reports keep theirs, older ones go without
  let withShots = 0;
  for (let i = q.length - 1; i >= 0; i--) {
    if (!(q[i]._shots as unknown[] | undefined)?.length) continue;
    if (++withShots > QUEUED_WITH_SHOTS) {
      const { _shots: _dropped, ...rest } = q[i];
      q[i] = rest;
    }
  }
  store.setExtra(QUEUE, q);
}

/** Sends what waited in the queue (at start and every 10 minutes). */
export async function flush(): Promise<void> {
  const q = store.extra<Record<string, unknown>[]>(QUEUE) ?? [];
  if (!q.length) return;
  const left: Record<string, unknown>[] = [];
  for (const p of q) if ((await post(p)) === 'retry') left.push(p);
  store.setExtra(QUEUE, left);
}

/** A bug report, idea or question the user wrote. Throws on a refusal (too many reports …); queued when offline. */
export async function send(d: ReportDraft): Promise<{ queued: boolean }> {
  const input = draftInput(d);
  if (!input.message.trim()) throw new Error('Write a few words first');
  const payload: Record<string, unknown> = body(input);
  if (d.kind === 'bug' && Array.isArray(d.shots) && d.shots.length) payload._shots = checkShots(d.shots);
  const r = await post(payload);
  if (r === 'refused') throw new Error('The Catzoid site did not accept the report (too many in a short time?). Try again in a few minutes.');
  if (r === 'retry') enqueue(payload);
  return { queued: r === 'retry' };
}

/** An uncaught error (main or window): sent when crash reports are on, at most once per kind per version per day. */
export async function error(message: string, stack: string, where: 'main' | 'renderer'): Promise<void> {
  const p = prefs();
  if (!p.crashReports) {
    if (!p.askCrash && store.extra<boolean>('askedCrash') !== true) {
      store.setExtra('askedCrash', true);
      store.setExtra(PREFS, { ...p, askCrash: true });
    }
    return;
  }
  const msg = scrub(String(message)).slice(0, 2000);
  const key = `${app.getVersion()}|${new Date().toISOString().slice(0, 10)}|${msg.split('\n')[0].slice(0, 200)}`;
  const sent = store.extra<string[]>(SENT) ?? [];
  if (sent.includes(key)) return;
  store.setExtra(SENT, [...sent, key].slice(-200));
  const payload = body({ type: 'error', message: msg, stack: scrub(String(stack ?? '')).slice(0, 20_000), process: where });
  if ((await post(payload)) === 'retry') enqueue(payload);
}

/** Native crashes through crashReporter (uploads only while crash reports are on) and uncaught errors in main. */
export function init(): void {
  crashReporter.start({ productName: 'DialCatz', submitURL: `${siteBase()}/api/reports/minidump`, uploadToServer: prefs().crashReports, compress: true, globalExtra: { ver: app.getVersion(), prod: 'dialcatz' } });
  process.on('uncaughtException', (e) => void error(e.message, e.stack ?? '', 'main'));
  process.on('unhandledRejection', (e) => void error(String((e as Error)?.message ?? e), (e as Error)?.stack ?? '', 'main'));
  setTimeout(() => void flush(), 20_000);
  setInterval(() => void flush(), 10 * 60_000);
}
