<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { OAUTH_REDIRECT, type AuthMode, type OAuthDevicePrompt, type OAuthGrant, type OAuthSettings, type OAuthStatus, type RequestAuth } from '@shared/types';
import { resolveOAuth } from '@shared/request';
import { oauthProblem } from '@shared/oauth';
import { deviceCodeInline, insecureFor, notify, plain, varsFor } from '../state';
import VarInput from './VarInput.vue';
import Icon from './Icon.vue';

/**
 * Auth of a request, folder or collection. `inherit` is offered unless this is a collection (the top). `itemId`: whose
 * environment fills the {{variables}} of OAuth 2.0's settings when a token is asked for (null: the workspace's).
 */
const props = withDefaults(defineProps<{ modelValue: RequestAuth; allowInherit?: boolean; inheritedLabel?: string; readonly?: boolean; itemId?: string | null }>(), { allowInherit: true, inheritedLabel: '', readonly: false, itemId: null });
const emit = defineEmits<{ 'update:modelValue': [a: RequestAuth] }>();

const MODES: { id: AuthMode; label: string }[] = [
  { id: 'inherit', label: 'Inherit' },
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic' },
  { id: 'apikey', label: 'API key' },
  { id: 'oauth2', label: 'OAuth 2.0' },
];
const show = ref(false);
const set = (patch: Partial<RequestAuth>) => emit('update:modelValue', { ...props.modelValue, ...patch });

// ---------------------------------------------------------------- OAuth 2.0 (#100)

const GRANTS: { id: OAuthGrant; label: string; hint: string }[] = [
  { id: 'authorization_code', label: 'Authorization code', hint: 'You sign in in the browser; the usual choice for an API used on behalf of a person.' },
  { id: 'client_credentials', label: 'Client credentials', hint: 'The app signs in as itself with its client secret; no person, no browser.' },
  { id: 'device_code', label: 'Device code', hint: 'DialCatz shows a short code; you type it in on the provider\'s page, on this computer or your phone.' },
  { id: 'password', label: 'Password', hint: 'A username and password are sent to the token address. Older; use it only when the server offers nothing else.' },
];
const o = computed<OAuthSettings>(() => props.modelValue.oauth2 ?? { grant: 'authorization_code', tokenUrl: '', clientId: '' });
const setO = (patch: Partial<OAuthSettings>) => set({ oauth2: { ...o.value, ...patch } });
const resolved = computed(() => resolveOAuth(o.value, varsFor(props.itemId)));
const problem = computed(() => oauthProblem(resolved.value));
const status = ref<OAuthStatus | null>(null);
const busy = ref(false);
const failed = ref('');
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 15_000);
let timer: ReturnType<typeof setTimeout> | null = null;
onBeforeUnmount(() => {
  offDevice();
  // Left while its sign-in still waits: the global card takes over.
  if (busy.value) deviceCodeInline.value = false;
  clearInterval(tick);
  if (timer) clearTimeout(timer);
});
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^OAuth 2\.0: /, '');
async function refreshStatus() {
  status.value = await window.dialcatz.oauthStatus(plain(resolved.value)).catch(() => null);
}
watch(
  [() => props.modelValue.mode, () => JSON.stringify(resolved.value)],
  () => {
    if (timer) clearTimeout(timer);
    if (props.modelValue.mode !== 'oauth2') return;
    timer = setTimeout(() => void refreshStatus(), 250);
  },
  { immediate: true },
);
async function getToken() {
  failed.value = '';
  busy.value = true;
  // A device code started here shows in this tab; the global card stays away.
  if (o.value.grant === 'device_code') deviceCodeInline.value = true;
  try {
    const r = await window.dialcatz.oauthToken(plain(resolved.value), { interactive: true, fresh: true, ...(insecureFor(props.itemId) ? { insecure: true } : {}) });
    status.value = r.status;
    notify('success', 'Token received: requests with this auth now use it');
  } catch (e) {
    failed.value = clean(e);
  } finally {
    busy.value = false;
    deviceCodeInline.value = false;
  }
}
const cancelSignIn = () => void window.dialcatz.oauthCancel();
const window_open = (url: string) => void window.dialcatz.openUrl(url);
// Device code: the code to type in while DialCatz waits for the sign-in.
const device = ref<OAuthDevicePrompt | null>(null);
const offDevice = window.dialcatz.onOauthDevice((p) => (device.value = p));
async function copyCode() {
  if (!device.value) return;
  await window.dialcatz.copyText(device.value.userCode);
  notify('success', 'Code copied');
}
// OpenID Connect discovery: the provider's addresses from its issuer.
const finding = ref(false);
async function discover() {
  const issuer = (resolveOAuth({ ...o.value, tokenUrl: o.value.issuer ?? '' }, varsFor(props.itemId)).tokenUrl || '').trim();
  if (!issuer) return;
  finding.value = true;
  failed.value = '';
  try {
    const d = await window.dialcatz.oauthDiscover(issuer, insecureFor(props.itemId) ? { insecure: true } : {});
    setO({ tokenUrl: d.tokenUrl, ...(d.authUrl ? { authUrl: d.authUrl } : {}), ...(d.deviceUrl ? { deviceUrl: d.deviceUrl } : {}) });
    notify('success', `Addresses filled in from ${d.issuer || issuer}`);
  } catch (e) {
    failed.value = clean(e);
  } finally {
    finding.value = false;
  }
}
async function clearToken() {
  await window.dialcatz.oauthClear(plain(resolved.value));
  failed.value = '';
  await refreshStatus();
}
const span = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? 'less than a minute' : m < 90 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
};
const tokenLine = computed(() => {
  const s = status.value;
  if (!s?.has) return { tone: 'none' as const, text: 'No token yet' };
  const left = s.expiresAt === null ? null : s.expiresAt - now.value;
  if (left !== null && left <= 30_000) return s.refreshable ? { tone: 'ok' as const, text: 'Token ended; DialCatz renews it on the next send' } : { tone: 'warn' as const, text: 'Token ended' };
  return { tone: 'ok' as const, text: left === null ? 'Token ready' : `Token ready, ${span(left)} left${s.refreshable ? ' (renews by itself)' : ''}` };
});
const redirect = computed(() => resolved.value.redirectUri || OAUTH_REDIRECT);
async function copyRedirect() {
  await window.dialcatz.copyText(redirect.value);
  notify('success', 'Redirect URI copied');
}
</script>

<template>
  <div class="space-y-4">
    <div class="opt-row">
      <span class="label-caps">Type</span>
      <div class="seg seg-choice">
        <button v-for="m in MODES.filter((x) => allowInherit || x.id !== 'inherit')" :key="m.id" role="tab" class="seg-item" :class="{ 'is-active': modelValue.mode === m.id }" :disabled="readonly" @click="set({ mode: m.id })">{{ m.label }}</button>
      </div>
    </div>

    <p v-if="modelValue.mode === 'inherit'" class="text-sm opacity-60">{{ inheritedLabel || 'Uses the auth of the folder or collection above.' }}</p>
    <p v-else-if="modelValue.mode === 'none'" class="text-sm opacity-60">No Authorization header is added.</p>

    <template v-else-if="modelValue.mode === 'bearer'">
      <div class="opt-row">
        <span class="label-caps">Token</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="modelValue.token ?? ''" placeholder="{{token}}" :readonly="readonly" @update:model-value="(v) => set({ token: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
      <p class="text-xs opacity-50">Sent as <code>Authorization: Bearer …</code>. Put real tokens in an environment variable marked secret.</p>
    </template>

    <template v-else-if="modelValue.mode === 'basic'">
      <div class="opt-row">
        <span class="label-caps">Username</span>
        <VarInput class="field-box flex-1" :model-value="modelValue.username ?? ''" :readonly="readonly" @update:model-value="(v) => set({ username: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Password</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="modelValue.password ?? ''" :readonly="readonly" @update:model-value="(v) => set({ password: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
    </template>

    <template v-else-if="modelValue.mode === 'oauth2'">
      <div class="opt-row">
        <span class="label-caps">Grant</span>
        <div class="seg seg-choice">
          <button v-for="g in GRANTS" :key="g.id" role="tab" class="seg-item normal-case" :class="{ 'is-active': o.grant === g.id }" :disabled="readonly" @click="setO({ grant: g.id })">{{ g.label }}</button>
        </div>
      </div>
      <p class="-mt-2 text-xs opacity-50">{{ GRANTS.find((g) => g.id === o.grant)?.hint }}</p>

      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Issuer</span><span class="text-xs opacity-50">Optional</span></span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :model-value="o.issuer ?? ''" placeholder="https://id.example.com  (fills in the addresses below)" :readonly="readonly" @update:model-value="(v: string) => setO({ issuer: v })" />
          <button class="btn btn-ghost btn-sm" :disabled="readonly || finding || !(o.issuer ?? '').trim()" title="Reads the provider's discovery document (.well-known/openid-configuration)" @click="discover"><span v-if="finding" class="loading loading-spinner loading-xs"></span>Find addresses</button>
        </div>
      </div>
      <div v-if="o.grant === 'authorization_code'" class="opt-row">
        <span class="label-caps">Auth URL</span>
        <VarInput class="field-box flex-1" :model-value="o.authUrl ?? ''" placeholder="https://example.com/oauth/authorize" :readonly="readonly" @update:model-value="(v: string) => setO({ authUrl: v })" />
      </div>
      <div v-if="o.grant === 'device_code'" class="opt-row">
        <span class="label-caps">Device URL</span>
        <VarInput class="field-box flex-1" :model-value="o.deviceUrl ?? ''" placeholder="https://example.com/oauth/device/code" :readonly="readonly" @update:model-value="(v: string) => setO({ deviceUrl: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Token URL</span>
        <VarInput class="field-box flex-1" :model-value="o.tokenUrl" placeholder="https://example.com/oauth/token" :readonly="readonly" @update:model-value="(v) => setO({ tokenUrl: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Client ID</span>
        <VarInput class="field-box flex-1" :model-value="o.clientId" placeholder="{{clientId}}" :readonly="readonly" @update:model-value="(v) => setO({ clientId: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Client secret</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="o.clientSecret ?? ''" :placeholder="o.grant === 'authorization_code' || o.grant === 'device_code' ? '{{clientSecret}} (empty for a public client)' : '{{clientSecret}}'" :readonly="readonly" @update:model-value="(v) => setO({ clientSecret: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
      <template v-if="o.grant === 'password'">
        <div class="opt-row">
          <span class="label-caps">Username</span>
          <VarInput class="field-box flex-1" :model-value="o.username ?? ''" :readonly="readonly" @update:model-value="(v) => setO({ username: v })" />
        </div>
        <div class="opt-row">
          <span class="label-caps">Password</span>
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="o.password ?? ''" placeholder="{{password}}" :readonly="readonly" @update:model-value="(v) => setO({ password: v })" />
        </div>
      </template>
      <div class="opt-row">
        <span class="label-caps">Scope</span>
        <VarInput class="field-box flex-1" :model-value="o.scope ?? ''" placeholder="read write (space between scopes)" :readonly="readonly" @update:model-value="(v) => setO({ scope: v })" />
      </div>

      <div v-if="o.grant === 'authorization_code'" class="oauth-note">
        <div class="flex items-center gap-2">
          <span class="label-caps shrink-0">Redirect URI</span>
          <code class="min-w-0 flex-1 truncate text-xs">{{ redirect }}</code>
          <button class="btn btn-ghost btn-xs btn-square" title="Copy" @click="copyRedirect"><Icon name="copy" class="size-3.5" /></button>
        </div>
        <p class="mt-1 text-xs opacity-60">Register this address with your provider as an allowed redirect (callback) URI: the browser comes back to DialCatz through it.</p>
      </div>

      <details class="oauth-more">
        <summary>More options</summary>
        <div class="space-y-4 pt-3">
          <div class="opt-row">
            <span class="label-caps">Client sent as</span>
            <div class="seg seg-choice">
              <button role="tab" class="seg-item normal-case" :class="{ 'is-active': o.clientAuth !== 'body' }" :disabled="readonly" @click="setO({ clientAuth: 'basic' })">Basic header</button>
              <button role="tab" class="seg-item normal-case" :class="{ 'is-active': o.clientAuth === 'body' }" :disabled="readonly" @click="setO({ clientAuth: 'body' })">In the body</button>
            </div>
          </div>
          <div v-if="o.grant === 'authorization_code'" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">PKCE</span><span class="text-xs opacity-50">Protects the sign-in (S256). Leave on unless the server refuses it.</span></span>
            <input type="checkbox" class="toggle toggle-primary toggle-sm" :checked="o.pkce !== false" :disabled="readonly" @change="setO({ pkce: ($event.target as HTMLInputElement).checked })" />
          </div>
          <div v-if="o.grant === 'authorization_code'" class="opt-row">
            <span class="label-caps">Redirect URI</span>
            <VarInput class="field-box flex-1" :model-value="o.redirectUri ?? ''" :placeholder="OAUTH_REDIRECT" :readonly="readonly" @update:model-value="(v) => setO({ redirectUri: v })" />
          </div>
          <div class="opt-row">
            <span class="label-caps">Audience</span>
            <VarInput class="field-box flex-1" :model-value="o.audience ?? ''" placeholder="Only when the provider asks for one (Auth0)" :readonly="readonly" @update:model-value="(v) => setO({ audience: v })" />
          </div>
          <div class="opt-row">
            <span class="label-caps">Header prefix</span>
            <VarInput class="field-box flex-1" :model-value="o.headerPrefix ?? ''" placeholder="Bearer" :readonly="readonly" @update:model-value="(v) => setO({ headerPrefix: v })" />
          </div>
        </div>
      </details>

      <div class="oauth-token">
        <div v-if="busy && device" class="oauth-device">
          <div class="text-xs opacity-60">Type this code in on the page that opened ({{ device.verificationUri.replace(/^https?:\/\//, '') }}), on this computer or another device:</div>
          <div class="mt-2 flex items-center gap-2">
            <code class="oauth-code">{{ device.userCode }}</code>
            <button class="btn btn-ghost btn-sm btn-square" title="Copy the code" @click="copyCode"><Icon name="copy" class="size-4" /></button>
            <button class="btn btn-ghost btn-sm" @click="window_open(device.verificationUriComplete || device.verificationUri)">Open the page again</button>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="oauth-dot" :class="`is-${tokenLine.tone}`"></span>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ busy && o.grant === 'authorization_code' ? 'Waiting for the sign-in in your browser…' : busy && o.grant === 'device_code' ? (device ? 'Waiting for the code to be typed in…' : 'Asking for a code…') : busy ? 'Asking for a token…' : tokenLine.text }}</div>
            <div v-if="status?.has && status.scope && !busy" class="truncate text-xs opacity-60">Scope: {{ status.scope }}</div>
          </div>
          <button v-if="busy && (o.grant === 'authorization_code' || o.grant === 'device_code')" class="btn btn-ghost btn-sm" @click="cancelSignIn">Cancel</button>
          <template v-else>
            <button v-if="status?.has" class="btn btn-ghost btn-sm" :disabled="busy" @click="clearToken">Forget token</button>
            <button class="btn btn-primary btn-sm" :disabled="busy || !!problem" :title="problem ?? ''" @click="getToken"><span v-if="busy" class="loading loading-spinner loading-xs"></span>Get new token</button>
          </template>
        </div>
        <p v-if="failed" class="mt-2 text-xs text-error">{{ failed }}</p>
        <p v-else-if="problem" class="mt-2 text-xs opacity-60">{{ problem }}.</p>
      </div>
      <p class="text-xs opacity-50">Sent as <code>Authorization: {{ o.headerPrefix?.trim() || 'Bearer' }} …</code>. DialCatz gets the token when you send and renews it by itself. {{ status && !status.lasting ? 'This system has no secret store, so the token is kept only until DialCatz quits' : 'Tokens stay on this computer, encrypted' }}; they are never saved with the collection or shared with your team.</p>
    </template>

    <template v-else-if="modelValue.mode === 'apikey'">
      <div class="opt-row">
        <span class="label-caps">Name</span>
        <VarInput class="field-box flex-1" :model-value="modelValue.key ?? ''" placeholder="X-API-Key" :readonly="readonly" @update:model-value="(v) => set({ key: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Value</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="modelValue.value ?? ''" :readonly="readonly" @update:model-value="(v) => set({ value: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
      <div class="opt-row">
        <span class="label-caps">Add to</span>
        <div class="seg seg-choice">
          <button role="tab" class="seg-item" :class="{ 'is-active': modelValue.in !== 'query' }" :disabled="readonly" @click="set({ in: 'header' })">Header</button>
          <button role="tab" class="seg-item" :class="{ 'is-active': modelValue.in === 'query' }" :disabled="readonly" @click="set({ in: 'query' })">Query params</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.oauth-note,
.oauth-token {
  padding: 0.75rem 0.9rem;
  border-radius: 12px;
  background: oklch(from var(--color-base-content) l c h / 0.04);
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.07);
}
.oauth-device {
  margin-bottom: 0.75rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
}
.oauth-code {
  padding: 0.3rem 0.8rem;
  border-radius: 10px;
  font-size: 1.35rem;
  font-weight: 650;
  letter-spacing: 0.14em;
  color: var(--primary-ink);
  background: oklch(from var(--color-primary) l c h / 0.12);
  user-select: all;
}
.oauth-more > summary {
  cursor: pointer;
  font-size: 0.8rem;
  opacity: 0.7;
  width: fit-content;
}
.oauth-more > summary:hover {
  opacity: 1;
}
.oauth-dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 999px;
  flex-shrink: 0;
  background: oklch(from var(--color-base-content) l c h / 0.25);
}
.oauth-dot.is-ok {
  background: var(--color-success);
}
.oauth-dot.is-warn {
  background: var(--color-warning);
}
</style>
