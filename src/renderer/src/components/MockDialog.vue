<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { TreeItem } from '@shared/types';
import { attempt, mocks, notify, refreshMocks, setWorkspace, workspace } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';

/**
 * A mock server made from a collection's spec (#94): a stand-in for the API on this computer, so a frontend can work
 * before the real one exists. Start / Stop, its address, an environment that points DialCatz at it, and the latest
 * calls (refreshed while the dialog is open).
 */
const props = defineProps<{ collection: TreeItem }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

const ws = computed(() => workspace.value!.id);
const m = computed(() => mocks.value.find((x) => x.workspaceId === ws.value && x.collectionId === props.collection.id) ?? null);

/** Requests of the collection that carry the spec's responses (the ones the mock answers). */
const routes = computed(() => {
  const items = workspace.value?.items ?? [];
  const ids = new Set([props.collection.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) (ids.add(i.id), (grew = true));
  }
  const reqs = items.filter((i) => ids.has(i.id) && i.kind === 'request' && i.request);
  return { answered: reqs.filter((i) => i.specResponses?.length), all: reqs.length };
});
const path = (url: string) => url.replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '').split('?')[0] || '/';
const sample = computed(() => {
  const r = routes.value.answered.find((i) => i.request!.method === 'GET') ?? routes.value.answered[0];
  return r ? path(r.request!.url).replace(/:[^/]+|\{[^}]+\}/g, '1') : '/';
});

const port = ref('');
const busy = ref(false);
async function start() {
  busy.value = true;
  const p = port.value.trim() ? Number(port.value.trim()) : undefined;
  const r = await attempt(() => api.mockStart(ws.value, props.collection.id, p));
  busy.value = false;
  if (r) await refreshMocks();
}
async function stop() {
  busy.value = true;
  await attempt(() => api.mockStop(ws.value, props.collection.id));
  busy.value = false;
  await refreshMocks();
}
async function useIt() {
  const w = await attempt(() => api.mockEnvironment(ws.value, props.collection.id));
  if (!w) return;
  setWorkspace(w);
  const pinned = props.collection.environmentId ? w.environments.find((e) => e.id === props.collection.environmentId)?.name : null;
  notify('success', pinned ? `“Mock · ${props.collection.name}” is ready. This collection uses “${pinned}”: pick the mock in its Settings to send there.` : `Requests now go to the mock (environment “Mock · ${props.collection.name}”)`);
}
async function copy() {
  await navigator.clipboard.writeText(m.value!.url);
  notify('success', 'Address copied');
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 5 ? 'now' : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const tone = (s: number) => (s < 300 ? 'is-ok' : s < 400 ? 'is-info' : s < 500 ? 'is-warn' : 'is-bad');

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refreshMocks();
  timer = setInterval(() => void refreshMocks(), 1500);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('close')">
    <div class="modal-box flex max-h-[85vh] w-[38rem] max-w-[95vw] flex-col gap-4">
      <div class="flex items-start gap-3">
        <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood :mood="m ? 'success' : 'info'" class="size-8" /></span>
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-semibold tracking-tight">Mock server for “{{ collection.name }}”</h3>
          <p class="text-sm opacity-70">A stand-in for this API on your computer. It answers with the spec's examples, so a frontend can be built before the real API is ready.</p>
        </div>
      </div>

      <!-- Nothing to answer with -->
      <div v-if="!routes.answered.length && !m" class="mock-card text-sm">
        <p class="font-medium">No request here has responses from a spec yet.</p>
        <p class="mt-1 text-xs opacity-70">Import the API from an OpenAPI or Swagger document, or, for a collection that already follows one, use Spec → Check for changes once.</p>
      </div>

      <!-- Stopped -->
      <div v-else-if="!m" class="mock-card space-y-3">
        <p class="text-sm"><b>{{ routes.answered.length }}</b> of {{ routes.all }} {{ routes.all === 1 ? 'request' : 'requests' }} can be answered (the ones that came from the spec).</p>
        <div class="flex items-end gap-2">
          <label class="flex-1 space-y-1">
            <span class="label-caps">Port</span>
            <input v-model="port" class="input input-sm w-full font-mono" inputmode="numeric" placeholder="4010, or the next free one" @keydown.enter="start" />
          </label>
          <button class="btn btn-primary btn-sm gap-1.5" :disabled="busy" @click="start"><span v-if="busy" class="loading loading-spinner loading-xs" /><Icon v-else name="server" class="size-4" />Start</button>
        </div>
        <p class="text-xs opacity-60">It listens on this computer only (127.0.0.1) and stops when DialCatz quits.</p>
      </div>

      <!-- Running -->
      <template v-else>
        <div class="mock-card space-y-3">
          <div class="flex items-center gap-2">
            <span class="mock-live" />
            <span class="text-sm font-medium">Running</span>
            <span class="text-xs opacity-60">· answers {{ m.routes }} {{ m.routes === 1 ? 'request' : 'requests' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <code class="selectable min-w-0 flex-1 truncate rounded-lg bg-base-200 px-3 py-2 font-mono text-sm">{{ m.url }}</code>
            <button class="btn btn-ghost btn-sm" title="Copy the address" @click="copy"><Icon name="copy" class="size-4" /></button>
          </div>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-primary btn-sm" @click="useIt">Use in DialCatz</button>
            <button class="btn btn-ghost btn-sm" :disabled="busy" @click="stop">Stop</button>
          </div>
          <p class="text-xs opacity-60">Point your frontend at this address, or choose <b>Use in DialCatz</b> to send this collection's requests here. Add the header <code>Prefer: code=404</code> to get another response the spec describes.</p>
        </div>

        <section class="min-h-0 space-y-1.5 overflow-y-auto">
          <h4 class="label-caps">Latest calls</h4>
          <p v-if="!m.hits.length" class="text-sm opacity-60">None yet. Try <code class="selectable">{{ m.url }}{{ sample }}</code></p>
          <div v-for="(h, i) in m.hits" :key="i" class="mock-hit">
            <span class="mock-status font-mono" :class="tone(h.status)">{{ h.status }}</span>
            <span class="w-14 shrink-0 font-mono text-xs font-bold" :class="`m-${h.method.toLowerCase()}`" style="color: var(--m)">{{ h.method }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ h.path }}</span>
            <span class="max-w-40 shrink-0 truncate text-xs opacity-60">{{ h.route ?? 'no such request' }}</span>
            <span class="w-8 shrink-0 text-right text-xs opacity-40">{{ ago(h.at) }}</span>
          </div>
        </section>
      </template>

      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" @click="emit('close')">Close</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>

<style scoped>
.mock-card {
  padding: 0.875rem 1rem;
  border-radius: 0.875rem;
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
  background: oklch(from var(--color-base-content) l c h / 0.025);
}
.mock-live {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-success);
  box-shadow: 0 0 0 4px oklch(from var(--color-success) l c h / 0.18);
}
.mock-hit {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.3rem 0.5rem;
  border-radius: 0.5rem;
}
.mock-hit:hover {
  background: oklch(from var(--color-base-content) l c h / 0.04);
}
.mock-status {
  flex-shrink: 0;
  min-width: 2.25rem;
  padding: 0 0.375rem;
  border-radius: 0.375rem;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}
.mock-status.is-ok {
  color: var(--color-success);
  background: oklch(from var(--color-success) l c h / 0.12);
}
.mock-status.is-info {
  color: var(--color-info);
  background: oklch(from var(--color-info) l c h / 0.12);
}
.mock-status.is-warn {
  color: var(--color-warning);
  background: oklch(from var(--color-warning) l c h / 0.12);
}
.mock-status.is-bad {
  color: var(--color-error);
  background: oklch(from var(--color-error) l c h / 0.12);
}
</style>
