<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SyncConflict } from '@shared/types';
import { attempt, setWorkspace, workspace } from '../state';
import CatMood from './CatMood.vue';

/**
 * Sync conflicts on folders, collections and environments (TODO #41): a teammate changed the same thing first, so
 * their version is in the workspace and mine waits here. A bar under the workspace picker while any wait, and a
 * dialog to keep theirs or use mine, one by one.
 */
const list = computed(() => workspace.value?.conflicts ?? []);
const open = ref(false);
const busy = ref<string | null>(null);

/** The name it has in the workspace now (theirs), when it differs from mine. */
function now(c: SyncConflict): string | null {
  const w = workspace.value;
  const cur = c.kind === 'environment' ? w?.environments.find((e) => e.id === c.id) : w?.items.find((i) => i.id === c.id);
  return cur && cur.name !== c.name ? cur.name : null;
}
const KIND = { collection: 'Collection', folder: 'Folder', environment: 'Environment' } as const;
const when = (at: string | null) => (at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
function what(c: SyncConflict): string {
  const who = c.by ?? 'A teammate';
  if (c.fields.includes('deleted')) return `${who} deleted it while you were changing it.`;
  return `${who} changed it at the same time${c.at ? ` (${when(c.at)})` : ''}: ${c.fields.join(', ')}. Their version is in the workspace now.`;
}
async function settle(c: SyncConflict, keep: 'mine' | 'theirs') {
  busy.value = c.id;
  const w = await attempt(() => window.dialcatz.resolveConflict(workspace.value!.id, c.id, keep), keep === 'mine' ? 'Your version is back' : undefined);
  busy.value = null;
  if (w) setWorkspace(w);
  if (!list.value.length) open.value = false;
}
</script>

<template>
  <div v-if="list.length" class="px-3 pb-2">
    <button class="flex w-full items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-left text-xs" @click="open = true">
      <span class="size-2 shrink-0 rounded-full bg-warning" />
      <span class="min-w-0 flex-1 truncate">{{ list.length === 1 ? 'Changed by a teammate too' : `${list.length} changes met a teammate's` }}</span>
      <span class="font-medium">Review</span>
    </button>
  </div>
  <dialog v-if="open" open class="modal modal-open" @keydown.esc="open = false">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-3">
      <div class="flex items-start gap-3">
        <CatMood mood="warning" class="size-10 shrink-0" />
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Changed by a teammate too</h3>
          <p class="text-sm opacity-70">Nothing was lost: keep their version, or put yours back on top of it.</p>
        </div>
      </div>
      <div v-for="c in list" :key="c.id" class="space-y-2 rounded-xl border border-base-300/70 bg-base-200/40 p-3">
        <p class="text-sm"><span class="badge badge-ghost badge-sm mr-1.5">{{ KIND[c.kind] }}</span><b>{{ c.name }}</b><span v-if="now(c)" class="opacity-60"> — now “{{ now(c) }}”</span></p>
        <p class="text-sm opacity-75">{{ what(c) }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-xs" :disabled="busy === c.id" @click="settle(c, 'theirs')">Keep theirs</button>
          <button class="btn btn-primary btn-xs" :disabled="busy === c.id" @click="settle(c, 'mine')"><span v-if="busy === c.id" class="loading loading-spinner loading-xs" />{{ c.fields.includes('deleted') ? 'Bring mine back' : 'Use mine' }}</button>
        </div>
      </div>
      <div class="modal-action mt-0"><button class="btn btn-ghost btn-sm" @click="open = false">Later</button></div>
    </div>
    <div class="modal-backdrop" @click="open = false" />
  </dialog>
</template>
