<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ConnectRequest } from '@shared/types';
import { loadWorkspaces, notify, section } from '../state';
import { words } from '../platform';
import CatMood from './CatMood.vue';

/**
 * A dialcatz://connect link asks to join a server. Any web page can open such a link, so nothing is sent before
 * the user has seen the server's address and said yes (phishing a user onto someone else's server).
 */
const props = defineProps<{ request: ConnectRequest }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

const probe = ref<{ ok: boolean; version?: string; error?: string } | null>(null);
const device = ref('');
const busy = ref(false);
const error = ref('');
const host = (() => {
  try {
    return new URL(props.request.server).host;
  } catch {
    return props.request.server;
  }
})();

onMounted(async () => {
  device.value = await api.hostName();
  probe.value = await api.probeServer(props.request.server);
});

async function connect() {
  busy.value = true;
  error.value = '';
  try {
    await api.connectWithCode(props.request.server, props.request.code, device.value);
    await loadWorkspaces();
    notify('success', `Connected to ${host}`);
    section.value = 'team';
    emit('close');
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  await window.dialcatz.dismissConnect();
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="cancel">
    <div class="modal-box w-[32rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood mood="question" class="size-8" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">Connect to this team server?</h3>
          <p class="text-sm opacity-70">An invite link asks DialCatz to join a server. Only continue if you expected an invite to this address.</p>
        </div>
      </div>
      <div class="rounded-xl border border-base-300/70 bg-base-200/60 p-3">
        <p class="label-caps mb-1">Server</p>
        <p class="selectable font-mono text-base font-semibold break-all">{{ host }}</p>
        <p class="selectable font-mono text-xs opacity-60 break-all">{{ request.server }}</p>
        <p class="mt-2 text-xs">
          <span v-if="!probe" class="opacity-60"><span class="loading loading-spinner loading-xs" /> Checking…</span>
          <span v-else-if="probe.ok" class="text-success">DialCatz Den {{ probe.version }} answered.</span>
          <span v-else class="text-error">{{ probe.error }}</span>
        </p>
      </div>
      <div class="opt-row">
        <span class="label-caps">This device</span>
        <input v-model="device" class="input input-sm flex-1" placeholder="e.g. Andi – MacBook" />
      </div>
      <p class="text-xs opacity-50">The one-time code is exchanged for your own token, kept in {{ words.secretStore }}. The admin sees this device name and can revoke it alone.</p>
      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span>{{ error }}</span></div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="cancel">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !probe?.ok" @click="connect"><span v-if="busy" class="loading loading-spinner loading-xs" />Connect</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && cancel()" />
  </dialog>
</template>
