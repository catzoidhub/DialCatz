import { app } from 'electron';
import type { SupportRating } from '@shared/types';
import { isLinux, isWin } from './platform';
import { installId } from './reports';
import { setSupport, settings } from './settings';
import { siteBase } from './shared';

/**
 * Rate and review DialCatz (Catzoid #96, as DevCatz's reviews.ts), from the Support Catzoid card and Settings → About:
 *  · `POST <site>/api/dialcatz/reviews` with the install id (#90: catzoid.com only), the stars, an optional text, the
 *    version and the build; one rating per install — sending again replaces it;
 *  · the answer (the cleaned text and its moderation status) is kept in settings as "Your rating": there is no GET for
 *    one's own review;
 *  · no connection / the site busy → kept as `support.ratingQueued` and sent again quietly (launch + every hour);
 *  · every rating goes the same way, whatever the stars (no gating).
 */

const PLATFORM = isWin ? 'win-x64' : isLinux ? (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64') : process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
const HOUR = 60 * 60 * 1000;

type Review = { rating: number; text: string | null; status: SupportRating['status']; version: string; reply?: string | null; repliedAt?: string | null };
type Answer = { review?: Review };
const DAY = 24 * HOUR;

let onChange: () => void = () => undefined;
let timer: ReturnType<typeof setInterval> | null = null;

/** Sends a queued rating a minute after launch, then every hour while one waits. `changed` tells the window. */
export function start(changed: () => void): void {
  onChange = changed;
  if (timer) return;
  setTimeout(() => void flush().then(() => refresh()), 60_000);
  timer = setInterval(() => void flush(), HOUR);
  setInterval(() => void refresh(), DAY);
}

/** Keeps what the site says about this install's review (the reply, the status) in "Your rating". */
function keep(v: Review, sentAt?: number): void {
  const old = settings().support.rating;
  setSupport({ rating: { rating: v.rating, text: v.text, status: v.status, version: v.version, sentAt: sentAt ?? old?.sentAt ?? Date.now(), reply: v.reply ?? null, repliedAt: v.repliedAt ?? null } });
  onChange();
}

/**
 * `GET <site>/api/dialcatz/reviews/mine` with the install id in a header (never in the URL): the team's reply and the
 * status reach the app. Only for an install that rated; once a day, and when Settings → About opens. Quiet on errors.
 */
export async function refresh(): Promise<void> {
  if (!settings().support.rating) return;
  try {
    const res = await fetch(`${siteBase()}/api/dialcatz/reviews/mine`, { headers: { 'X-Catzoid-Install': installId() }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return;
    const body = (await res.json().catch(() => null)) as Answer | null;
    if (body?.review) keep(body.review);
  } catch {
    /* offline: the next time */
  }
}

/** Sends the stars (1–5) and the optional text. `queued`: no connection, it goes later by itself. */
export async function send(rating: number, text: string | null): Promise<{ sent: boolean; queued: boolean }> {
  const stars = Math.round(Number(rating));
  if (!(stars >= 1 && stars <= 5)) throw new Error('Pick from 1 to 5 stars');
  const t = (text ?? '').trim().slice(0, 1000) || null;
  const r = await post(stars, t);
  if (r === 'retry') {
    setSupport({ ratingQueued: { rating: stars, text: t, at: Date.now() } });
    onChange();
    return { sent: false, queued: true };
  }
  if (typeof r === 'string') throw new Error(r);
  return { sent: true, queued: false };
}

async function flush(): Promise<void> {
  const q = settings().support.ratingQueued;
  if (!q) return;
  const r = await post(q.rating, q.text);
  // Refused for good (e.g. the text): drop it rather than retry forever; the card offers to rate again.
  if (r !== 'retry' && typeof r === 'string') {
    setSupport({ ratingQueued: null });
    onChange();
  }
}

/** True when the answer is stored, 'retry' (no connection, busy, the site down) or the site's reason in plain words. */
async function post(rating: number, text: string | null): Promise<'retry' | string | true> {
  try {
    const res = await fetch(`${siteBase()}/api/dialcatz/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installId: installId(), rating, text, version: app.getVersion(), platform: PLATFORM, os: process.platform, arch: process.arch }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as (Answer & { error?: string; issues?: string[] }) | null;
    if (res.ok && body?.review) {
      setSupport({ ratingQueued: null, off: true });
      keep(body.review, Date.now());
      return true;
    }
    // The site down or busy, or an older site without reviews yet (a 404 that is not "unknown app"): later.
    if (res.status >= 500 || (res.status === 429 && /right now/.test(body?.error ?? '')) || (res.status === 404 && body?.error !== 'unknown app')) return 'retry';
    if (res.status === 429) return 'You rated a few times already: try again in an hour.';
    const issues = (body?.issues ?? []).map((i) => i.replace(/^text: /, 'Your review: '));
    return [body?.error === 'invalid review' ? '' : body?.error, ...issues].filter(Boolean).join('; ') || `The site answered HTTP ${res.status}`;
  } catch {
    return 'retry';
  }
}
