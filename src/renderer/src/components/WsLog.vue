<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { WsEvent } from '@shared/types';
import { prettyJson } from '../highlight';
import { notify, type Tab } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';

/** The message log of a WebSocket tab: what went out, what came in, and the connection's own events. */
const props = defineProps<{ tab: Tab }>();
const filter = ref('');
const only = ref<'all' | 'in' | 'out'>('all');
const follow = ref(true);
const open = ref<WsEvent | null>(null);
const box = ref<HTMLElement | null>(null);

const log = computed(() => props.tab.ws?.log ?? []);
const shown = computed(() => {
  const f = filter.value.toLowerCase();
  return log.value.filter((e) => (only.value === 'all' || e.type === only.value) && (!f || e.data.toLowerCase().includes(f)));
});
const counts = computed(() => ({ in: log.value.filter((e) => e.type === 'in').length, out: log.value.filter((e) => e.type === 'out').length }));
const state = computed(() => props.tab.ws?.state ?? 'idle');

watch(
  () => log.value.length,
  async () => {
    if (!follow.value) return;
    await nextTick();
    box.value?.scrollTo({ top: box.value.scrollHeight });
  },
);

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
const label: Record<WsEvent['type'], string> = { connecting: 'Connecting', open: 'Connected', in: '', out: '', error: 'Error', close: 'Closed' };
const preview = (e: WsEvent) => (e.binary ? `binary, ${e.size} bytes` : e.data.length > 300 ? `${e.data.slice(0, 300)}…` : e.data);
async function copy(e: WsEvent) {
  await window.dialcatz.copyText(e.data);
  notify('success', 'Message copied');
}
function clear() {
  if (props.tab.ws) props.tab.ws.log = [];
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex flex-wrap items-center gap-3 border-b border-base-300/60 px-4 py-2">
      <span class="ws-state" :class="`is-${state}`"><span />{{ { idle: 'Not connected', connecting: 'Connecting…', open: 'Connected', closed: 'Closed' }[state] }}</span>
      <span class="text-xs opacity-60">↓ {{ counts.in }} · ↑ {{ counts.out }}</span>
      <span class="flex-1" />
      <div class="seg seg-xs seg-choice">
        <button v-for="o in (['all', 'in', 'out'] as const)" :key="o" role="tab" class="seg-item" :class="{ 'is-active': only === o }" @click="only = o">{{ { all: 'All', in: 'Received', out: 'Sent' }[o] }}</button>
      </div>
      <label class="resp-search"><Icon name="search" class="size-3.5 opacity-50" /><input v-model="filter" placeholder="Filter messages" /></label>
      <label class="flex items-center gap-1.5 text-xs"><input v-model="follow" type="checkbox" class="toggle toggle-xs toggle-primary" />Follow</label>
      <button class="btn btn-ghost btn-xs" :disabled="!log.length" @click="clear">Clear</button>
    </div>
    <div v-if="!log.length" class="grid flex-1 place-items-center p-6 text-center text-sm opacity-60">
      <div class="space-y-2">
        <img src="../assets/icon.png" alt="" class="mx-auto size-14 opacity-80" />
        <p>Connect to start the conversation; messages show up here as they come and go.</p>
      </div>
    </div>
    <div v-else ref="box" class="min-h-0 flex-1 overflow-auto px-3 py-2 selectable">
      <div v-for="(e, i) in shown" :key="i" class="ws-msg" :class="`is-${e.type}`" @click="e.type === 'in' || e.type === 'out' ? (open = e) : null">
        <span class="ws-time">{{ time(e.at) }}</span>
        <span class="ws-dir">
          <CatMood v-if="e.type === 'error'" mood="error" class="size-5" />
          <template v-else>{{ e.type === 'in' ? '↓' : e.type === 'out' ? '↑' : '•' }}</template>
        </span>
        <span class="ws-text font-mono"><b v-if="label[e.type]">{{ `${label[e.type]} ` }}</b>{{ preview(e) }}</span>
        <button v-if="e.type === 'in' || e.type === 'out'" class="ws-copy" title="Copy" @click.stop="copy(e)"><Icon name="copy" class="size-3.5" /></button>
      </div>
    </div>

    <dialog v-if="open" open class="modal modal-open" @keydown.esc="open = null">
      <div class="modal-box w-[48rem] max-w-[95vw] space-y-3">
        <h3 class="font-semibold">{{ open.type === 'in' ? 'Received' : 'Sent' }} at {{ time(open.at) }}<span class="ml-2 text-xs font-normal opacity-60">{{ open.size }} bytes</span></h3>
        <pre class="selectable max-h-[60vh] overflow-auto rounded-xl bg-base-200 p-3 font-mono text-xs whitespace-pre-wrap">{{ open.binary ? `(binary, base64 of the first 4 KB)\n${open.data}` : (prettyJson(open.data) ?? open.data) }}</pre>
        <div class="modal-action"><button class="btn btn-ghost btn-sm" @click="copy(open)">Copy</button><button class="btn btn-sm" @click="open = null">Close</button></div>
      </div>
      <div class="modal-backdrop" @click="open = null" />
    </dialog>
  </div>
</template>
