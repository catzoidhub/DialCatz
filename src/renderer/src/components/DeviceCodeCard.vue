<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import type { OAuthDevicePrompt } from '@shared/types';
import { deviceCodeInline, notify } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';

/**
 * OAuth 2.0 device code (#100): the code to type in, wherever the sign-in started (Send, the runner, an AI assistant
 * through MCatzP). The Auth tab shows it in place when its own Get new token started it; this card covers the rest
 * and stays until the sign-in is over.
 */
const prompt = ref<OAuthDevicePrompt | null>(null);
const off = window.dialcatz.onOauthDevice((p) => (prompt.value = p));
onBeforeUnmount(off);

async function copy() {
  if (!prompt.value) return;
  await window.dialcatz.copyText(prompt.value.userCode);
  notify('success', 'Code copied');
}
const open = () => prompt.value && void window.dialcatz.openUrl(prompt.value.verificationUriComplete || prompt.value.verificationUri);
const cancel = () => void window.dialcatz.oauthCancel();
const host = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
</script>

<template>
  <div v-if="prompt && !deviceCodeInline" class="device-card" role="dialog" aria-label="Sign in with a code">
    <div class="flex items-start gap-3">
      <CatMood mood="info" class="size-9 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold">Sign in to get the token</div>
        <div class="mt-0.5 text-xs opacity-65">Type this code in on the page that opened ({{ host(prompt.verificationUri) }}), on this computer or another device. DialCatz carries on by itself once you have.</div>
        <div class="mt-3 flex items-center gap-2">
          <code class="device-code">{{ prompt.userCode }}</code>
          <button class="btn btn-ghost btn-sm btn-square" title="Copy the code" @click="copy"><Icon name="copy" class="size-4" /></button>
        </div>
        <div class="mt-3 flex items-center gap-2">
          <span class="loading loading-dots loading-xs opacity-50"></span>
          <span class="flex-1 text-xs opacity-55">Waiting for the sign-in…</span>
          <button class="btn btn-ghost btn-xs" @click="open">Open the page again</button>
          <button class="btn btn-ghost btn-xs" @click="cancel">Cancel</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.device-card {
  position: fixed;
  right: 1.25rem;
  bottom: 1.25rem;
  z-index: 1050;
  width: min(25rem, calc(100vw - 2.5rem));
  padding: 1rem 1.1rem;
  border-radius: 16px;
  background: var(--surface-raised);
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
  box-shadow: 0 18px 48px -18px oklch(0 0 0 / 0.35);
}
.device-code {
  padding: 0.3rem 0.8rem;
  border-radius: 10px;
  font-size: 1.35rem;
  font-weight: 650;
  letter-spacing: 0.14em;
  color: var(--primary-ink);
  background: oklch(from var(--color-primary) l c h / 0.12);
  user-select: all;
}
</style>
