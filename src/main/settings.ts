import { nativeTheme } from 'electron';
import { AI_FEATURES, AI_PROVIDERS, type AiFeature, type AiProvider, type DialCatzSettings, type DialCatzSettingsPatch, type RequestDefaults, type Theme } from '@shared/types';
import { AUTO_HEADERS } from '@shared/request';
import { store } from './store';
import { readShared, setSharedKey, sharedKey, watchShared, writeShared } from './shared';

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

function local(): Stored {
  const s = store.extra<Partial<Stored>>(KEY) ?? {};
  const ai = s.ai ?? ({} as Partial<Stored['ai']>);
  const r = { ...REQUEST_DEFAULTS, ...(s.requests ?? {}) };
  return {
    theme: THEMES.includes(s.theme as Theme) ? (s.theme as Theme) : 'system',
    ai: { enabled: ai.enabled === true, off: Array.isArray(ai.off) ? ai.off.filter((f): f is AiFeature => FEATURES.includes(f)) : [], provider: PROVIDERS.includes(ai.provider as AiProvider) ? (ai.provider as AiProvider) : 'anthropic', models: ai.models ?? {}, baseUrls: ai.baseUrls ?? {} },
    requests: { timeoutMs: Number(r.timeoutMs) || REQUEST_DEFAULTS.timeoutMs, followRedirects: r.followRedirects !== false, insecure: r.insecure === true, autoHeaders: r.autoHeaders && typeof r.autoHeaders === 'object' ? r.autoHeaders : {} },
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
  store.setExtra(KEY, s);
  const conn = ai && (ai.provider !== undefined || ai.models !== undefined || ai.baseUrls !== undefined);
  if (patch.theme !== undefined || conn) writeShared({ ...(patch.theme !== undefined ? { theme: s.theme } : {}), ...(conn ? { ai: { provider: s.ai.provider, models: s.ai.models, baseUrls: s.ai.baseUrls } } : {}) });
  nativeTheme.themeSource = s.theme;
  return settings();
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
