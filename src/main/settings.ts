import { nativeTheme } from 'electron';
import { AI_FEATURES, AI_PROVIDERS, type AiFeature, type AiProvider, type DialCatzSettings, type DialCatzSettingsPatch, type McatzpSettings, type RequestDefaults, type SupportRating, type SupportState, type Theme } from '@shared/types';
import { AUTO_HEADERS } from '@shared/request';
import { cleanClients } from './mcatzp/clients';
import { store } from './store';
import { readShared, setSharedKey, sharedKey, watchShared, writeShared } from './shared';
import { validBrowser } from './browsers';

/**
 * The Settings page's values. The theme and the AI connection (provider, models, addresses, API keys) are shared
 * with all Catzoid apps (shared.ts: Catzoid/shared.json + the "Catzoid AI" secret store item), so a key entered in
 * one app works in all; AI on / off and the request defaults stay DialCatz's own. Checked here: the window is not
 * trusted with the shape. Keys never leave the main process.
 */

const KEY = 'settings';
const THEMES: Theme[] = ['system', 'light', 'dark'];
const PROVIDERS = AI_PROVIDERS.map((p) => p.id);
const FEATURES = AI_FEATURES.map((f) => f.id);
const REQUEST_DEFAULTS: RequestDefaults = { timeoutMs: 30_000, followRedirects: true, insecure: false, autoHeaders: {} };

type Stored = Omit<DialCatzSettings, 'ai'> & { ai: Omit<DialCatzSettings['ai'], 'keys'> };

const ids = (a: unknown) => (Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 300))] : []);
function mcatzpOf(m: Partial<McatzpSettings> | undefined): McatzpSettings {
  const clients = cleanClients(m?.clients);
  return { on: m?.on === true, all: m?.all === true, workspaces: ids(m?.workspaces), values: m?.values !== false, responses: m?.responses !== false, git: m?.git === true, changes: m?.changes !== false, clients };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const STATUSES: SupportRating['status'][] = ['none', 'pending', 'approved', 'hidden'];
const stars = (v: unknown) => Math.round(Number(v)) >= 1 && Math.round(Number(v)) <= 5;
function supportOf(x: Partial<SupportState> | undefined): SupportState {
  const r = x?.rating;
  const q = x?.ratingQueued;
  return {
    since: num(x?.since),
    later: Math.min(9, Math.max(0, Math.round(Number(x?.later) || 0))),
    laterAt: num(x?.laterAt),
    off: x?.off === true,
    rating: r && stars(r.rating) ? { rating: Math.round(r.rating), text: typeof r.text === 'string' ? r.text : null, status: STATUSES.includes(r.status) ? r.status : 'pending', version: String(r.version ?? ''), sentAt: num(r.sentAt) ?? Date.now(), reply: typeof r.reply === 'string' ? r.reply.slice(0, 2000) : null, repliedAt: typeof r.repliedAt === 'string' ? r.repliedAt : null } : null,
    replySeen: typeof x?.replySeen === 'string' ? x.replySeen.slice(0, 64) : null,
    ratingQueued: q && stars(q.rating) ? { rating: Math.round(q.rating), text: typeof q.text === 'string' ? q.text : null, at: num(q.at) ?? Date.now() } : null,
  };
}

function local(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  const ai = s.ai ?? ({} as Partial<Stored['ai']>);
  const r = { ...REQUEST_DEFAULTS, ...(s.requests ?? {}) };
  return {
    theme: THEMES.includes(s.theme as Theme) ? (s.theme as Theme) : 'system',
    browser: typeof s.browser === 'string' ? s.browser : '',
    ai: { enabled: ai.enabled === true, off: Array.isArray(ai.off) ? ai.off.filter((f): f is AiFeature => FEATURES.includes(f)) : [], provider: PROVIDERS.includes(ai.provider as AiProvider) ? (ai.provider as AiProvider) : 'anthropic', models: ai.models ?? {}, baseUrls: ai.baseUrls ?? {} },
    requests: { timeoutMs: Number(r.timeoutMs) || REQUEST_DEFAULTS.timeoutMs, followRedirects: r.followRedirects !== false, insecure: r.insecure === true, autoHeaders: r.autoHeaders && typeof r.autoHeaders === 'object' ? r.autoHeaders : {} },
    mcatzp: mcatzpOf(s.mcatzp),
    support: supportOf(s.support),
  };
}

/** The shared values win where they are set. */
function stored(): Stored {
  const s = local();
  const sh = readShared();
  const provider = sh.ai?.provider ?? s.ai.provider;
  return {
    ...s,
    theme: sh.theme && THEMES.includes(sh.theme) ? sh.theme : s.theme,
    browser: typeof sh.browser === 'string' ? sh.browser : s.browser,
    ai: { enabled: s.ai.enabled, off: s.ai.off, provider: PROVIDERS.includes(provider) ? provider : 'anthropic', models: sh.ai?.models ?? s.ai.models, baseUrls: sh.ai?.baseUrls ?? s.ai.baseUrls },
  };
}

export function settings(): DialCatzSettings {
  const s = stored();
  const shared = new Set(readShared().ai?.keys ?? []);
  return { ...s, ai: { ...s.ai, keys: PROVIDERS.filter((p) => shared.has(p)) } };
}

export function setSettings(patch: DialCatzSettingsPatch): DialCatzSettings {
  const s = stored();
  if (patch.theme !== undefined) {
    if (!THEMES.includes(patch.theme)) throw new Error(`Unknown theme ${patch.theme}`);
    s.theme = patch.theme;
  }
  if (patch.browser !== undefined) {
    const b = String(patch.browser);
    if (!validBrowser(b)) throw new Error('That browser is not installed here');
    s.browser = b;
  }
  const ai = patch.ai;
  if (ai) {
    if (ai.enabled !== undefined) s.ai.enabled = ai.enabled === true;
    if (ai.off !== undefined) s.ai.off = Array.isArray(ai.off) ? [...new Set(ai.off)].filter((f) => FEATURES.includes(f)) : [];
    if (ai.provider !== undefined) {
      if (!PROVIDERS.includes(ai.provider)) throw new Error(`Unknown AI provider ${ai.provider}`);
      s.ai.provider = ai.provider;
    }
    for (const [p, m] of Object.entries(ai.models ?? {})) {
      if (!PROVIDERS.includes(p as AiProvider)) continue;
      const id = String(m ?? '').trim().slice(0, 200);
      if (id) s.ai.models[p as AiProvider] = id;
      else delete s.ai.models[p as AiProvider];
    }
    for (const [p, u] of Object.entries(ai.baseUrls ?? {})) {
      if (!PROVIDERS.includes(p as AiProvider)) continue;
      const url = String(u ?? '').trim().replace(/\/+$/, '');
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('The address must start with http:// or https://');
      if (url) s.ai.baseUrls[p as AiProvider] = url.slice(0, 500);
      else delete s.ai.baseUrls[p as AiProvider];
    }
  }
  const r = patch.requests;
  if (r) {
    if (r.timeoutMs !== undefined) s.requests.timeoutMs = Math.min(600_000, Math.max(1000, Math.round(Number(r.timeoutMs) || 30_000)));
    if (r.followRedirects !== undefined) s.requests.followRedirects = r.followRedirects === true;
    if (r.insecure !== undefined) s.requests.insecure = r.insecure === true;
    if (r.autoHeaders !== undefined) s.requests.autoHeaders = Object.fromEntries(Object.entries(r.autoHeaders ?? {}).filter(([k]) => AUTO_HEADERS.some((a) => a.key === k)).map(([k, v]) => [k, v === true]));
  }
  const m = patch.mcatzp;
  if (m) {
    if (m.on !== undefined) s.mcatzp.on = m.on === true;
    if (m.all !== undefined) s.mcatzp.all = m.all === true;
    if (m.values !== undefined) s.mcatzp.values = m.values === true;
    if (m.responses !== undefined) s.mcatzp.responses = m.responses === true;
    if (m.git !== undefined) s.mcatzp.git = m.git === true;
    if (m.changes !== undefined) s.mcatzp.changes = m.changes === true;
    if (m.workspaces !== undefined) s.mcatzp.workspaces = ids(m.workspaces);
  }
  const sp = patch.support;
  if (sp) s.support = supportOf({ ...s.support, ...(sp.later !== undefined ? { later: sp.later } : {}), ...(sp.laterAt !== undefined ? { laterAt: sp.laterAt } : {}), ...(sp.off !== undefined ? { off: sp.off } : {}), ...(sp.replySeen !== undefined ? { replySeen: sp.replySeen } : {}) });
  store.setExtra(KEY, s);
  const conn = ai && (ai.provider !== undefined || ai.models !== undefined || ai.baseUrls !== undefined);
  if (patch.theme !== undefined || patch.browser !== undefined || conn) writeShared({ ...(patch.theme !== undefined ? { theme: s.theme } : {}), ...(patch.browser !== undefined ? { browser: s.browser } : {}), ...(conn ? { ai: { provider: s.ai.provider, models: s.ai.models, baseUrls: s.ai.baseUrls } } : {}) });
  nativeTheme.themeSource = s.theme;
  return settings();
}

/** Support Catzoid (#94): the corner card counts its 7 days from the first run that knows about it. */
export function startSupportClock(): void {
  const s = stored();
  if (s.support.since) return;
  s.support = { ...s.support, since: Date.now() };
  store.setExtra(KEY, s);
}

/** Support Catzoid's rating state (Catzoid #96): only the main process writes it (reviews.ts). */
export function setSupport(patch: Partial<SupportState>): void {
  const s = stored();
  s.support = supportOf({ ...s.support, ...patch });
  store.setExtra(KEY, s);
}

/** Approved MCatzP clients: only the main process changes them (a pairing answered, Revoke). */
export function setMcatzpClients(clients: McatzpSettings['clients']): void {
  const s = stored();
  s.mcatzp.clients = clients;
  store.setExtra(KEY, s);
}

export async function setAiKey(provider: AiProvider, key: string): Promise<DialCatzSettings> {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown AI provider ${provider}`);
  await setSharedKey(provider, key);
  return settings();
}

/** The provider's key ('' = none). Main process only. */
export const aiKey = (provider: AiProvider) => sharedKey(provider);

/** Throws unless AI and this feature are on (Settings → AI). */
export function needFeature(feature: AiFeature): void {
  const ai = settings().ai;
  const label = AI_FEATURES.find((f) => f.id === feature)?.label ?? feature;
  if (!ai.enabled) throw new Error('AI is off in DialCatz: turn it on in Settings → AI');
  if (ai.off.includes(feature)) throw new Error(`${label} is switched off in Settings → AI`);
}

/** Applies the saved appearance before the window opens, and follows the other apps' changes. */
export function applySettings(onChange: (s: DialCatzSettings) => void): void {
  nativeTheme.themeSource = stored().theme;
  watchShared(() => {
    nativeTheme.themeSource = stored().theme;
    onChange(settings());
  });
}
