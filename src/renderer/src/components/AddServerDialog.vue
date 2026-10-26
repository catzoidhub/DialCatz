<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { connectRequest, loadWorkspaces, notify } from '../state';
import { words } from '../platform';
import CatMood from './CatMood.vue';

/**
 * "Connect to a server": paste the invite link the admin sent (it then goes through the same "connect to this
 * server?" question as an opened link), or the server address and a token made by hand in the admin panel.
 */
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;
const how = ref<'link' | 'token'>('link');
const link = ref('');
const url = ref('');
const token = ref('');
const busy = ref(false);
const error = ref('');
const first = ref<HTMLInputElement | null>(null);
onMounted(() => nextTick(() => first.value?.focus()));

function useLink() {
  error.value = '';
  try {
    const u = new URL(link.value.trim());
    const server = u.searchParams.get('server') ?? '';
    const code = u.searchParams.get('code') ?? '';
    if (u.protocol !== 'dialcatz:' || u.hostname !== 'connect' || !server || !/^[\w-]{6,128}$/.test(code)) throw new Error();
    connectRequest.value = { server, code };
    emit('close');
  } catch {
    error.value = 'That is not a DialCatz invite link (dialcatz://connect?server=…&code=…)';
  }
}

async function useToken() {
  busy.value = true;
  error.value = '';
  try {
    const probe = await api.probeServer(url.value);
    if (!probe.ok) throw new Error(probe.error);
    await api.connectWithToken(url.value, token.value);
    await loadWorkspaces();
    notify('success', 'Connected');
    emit('close');
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <h3 class="text-lg font-semibold tracking-tight">Connect to a server</h3>
      <div class="seg seg-choice">
        <button role="tab" class="seg-item normal-case" :class="{ 'is-active': how === 'link' }" @click="((how = 'link'), (error = ''))">Invite link</button>
        <button role="tab" class="seg-item normal-case" :class="{ 'is-active': how === 'token' }" @click="((how = 'token'), (error = ''))">Address and token</button>
      </div>

      <template v-if="how === 'link'">
        <p class="text-sm opacity-70">Paste the invite link your admin sent you. (Opening the link connects too — DialCatz asks first.)</p>
        <input ref="first" v-model="link" class="input input-sm w-full font-mono" placeholder="dialcatz://connect?server=…&amp;code=…" spellcheck="false" @keydown.enter="useLink" />
      </template>
      <template v-else>
        <p class="text-sm opacity-70">For a token your admin made by hand in the admin panel.</p>
        <div class="opt-row">
          <span class="label-caps">Server</span>
          <input v-model="url" class="input input-sm flex-1 font-mono" placeholder="https://dialcatz.your-team.com" spellcheck="false" />
        </div>
        <div class="opt-row">
          <span class="label-caps">Token</span>
          <input v-model="token" type="password" class="input input-sm flex-1 font-mono" placeholder="dct_…" spellcheck="false" @keydown.enter="useToken" />
        </div>
      </template>
      <p class="text-xs opacity-50">Your token is kept in {{ words.secretStore }}, never in DialCatz’s files. It belongs to you and this device only.</p>
      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span>{{ error }}</span></div>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button v-if="how === 'link'" class="btn btn-primary btn-sm" :disabled="!link.trim()" @click="useLink">Continue</button>
        <button v-else class="btn btn-primary btn-sm" :disabled="busy || !url.trim() || !token.trim()" @click="useToken"><span v-if="busy" class="loading loading-spinner loading-xs" />Connect</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
