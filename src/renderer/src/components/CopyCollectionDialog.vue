<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { TreeItem, Workspace } from '@shared/types';
import { attempt, notify, servers, workspace, workspaces } from '../state';
import CatMood from './CatMood.vue';

/**
 * Copy a collection to another workspace (personal → team, team → personal, …). When the target already has a
 * collection of that name: replace it, merge into it (same-named requests updated, new ones added), or duplicate
 * under another name ("Name (2)" by default, editable).
 */
const props = defineProps<{ collection: TreeItem }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

/** Workspaces the user may write to, other than this one. */
const targets = computed(() => workspaces.value.filter((w) => w.id !== workspace.value?.id && !(w.serverId && w.role === 'viewer')));
const host = (serverId: string | null) => servers.value.find((s) => s.id === serverId)?.url.replace(/^https?:\/\//, '') ?? '';
const toId = ref(targets.value[0]?.id ?? '');
const target = ref<Workspace | null>(null);
const mode = ref<'replace' | 'merge' | 'duplicate'>('merge');
const name = ref(props.collection.name);
const busy = ref(false);

const clash = computed(() => target.value?.items.some((i) => i.kind === 'collection' && i.name === props.collection.name) ?? false);
/** "Name (2)", "Name (3)" … the first that is free in the target. */
function freeName(): string {
  const taken = new Set(target.value?.items.filter((i) => i.kind === 'collection').map((i) => i.name));
  const base = props.collection.name.replace(/ \(\d+\)$/, '');
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}
watch(
  toId,
  async (id) => {
    target.value = id ? ((await attempt(() => api.workspace(id))) ?? null) : null;
    name.value = clash.value ? freeName() : props.collection.name;
  },
  { immediate: true },
);
const nameTaken = computed(() => (!clash.value || mode.value === 'duplicate') && target.value?.items.some((i) => i.kind === 'collection' && i.name === name.value.trim()));

async function copy() {
  busy.value = true;
  const m = !clash.value || mode.value === 'duplicate' ? 'new' : mode.value;
  const r = await attempt(() => api.copyCollection(workspace.value!.id, props.collection.id, toId.value, m, name.value));
  busy.value = false;
  if (!r) return;
  const to = targets.value.find((w) => w.id === toId.value)?.name;
  notify('success', m === 'merge' ? `Merged into “${props.collection.name}” in ${to}` : m === 'replace' ? `Replaced “${props.collection.name}” in ${to}` : `Copied to ${to} as “${name.value.trim()}”`);
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <h3 class="text-lg font-semibold tracking-tight">Copy “{{ collection.name }}” to another workspace</h3>

      <div v-if="!targets.length" class="alert alert-info alert-soft text-sm"><CatMood mood="info" class="size-7 shrink-0 -my-0.5" /><span>There is no other workspace you can write to. Make a personal workspace, or connect to a team server.</span></div>
      <template v-else>
        <div class="opt-row">
          <span class="label-caps">To</span>
          <select v-model="toId" class="select select-sm flex-1">
            <option v-for="w in targets" :key="w.id" :value="w.id">{{ w.name }}{{ w.serverId ? ` — team · ${host(w.serverId)}` : ' — personal' }}</option>
          </select>
        </div>

        <template v-if="clash">
          <div class="alert alert-warning alert-soft text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" /><span>That workspace already has a collection called “{{ collection.name }}”.</span></div>
          <div class="space-y-2">
            <label class="copy-choice" :class="{ 'is-on': mode === 'merge' }">
              <input v-model="mode" type="radio" value="merge" class="radio radio-sm radio-primary" />
              <span><b>Merge</b><span class="block text-xs opacity-60">Requests with the same name and folder are updated, new ones added; the rest stays.</span></span>
            </label>
            <label class="copy-choice" :class="{ 'is-on': mode === 'replace' }">
              <input v-model="mode" type="radio" value="replace" class="radio radio-sm radio-primary" />
              <span><b>Replace</b><span class="block text-xs opacity-60">The collection there is deleted and this copy takes its place.</span></span>
            </label>
            <label class="copy-choice" :class="{ 'is-on': mode === 'duplicate' }">
              <input v-model="mode" type="radio" value="duplicate" class="radio radio-sm radio-primary" />
              <span><b>Duplicate</b><span class="block text-xs opacity-60">Keep both: this copy gets another name.</span></span>
            </label>
          </div>
        </template>

        <div v-if="!clash || mode === 'duplicate'" class="opt-row">
          <span class="label-caps">Name</span>
          <input v-model="name" class="input input-sm flex-1" @keydown.enter="copy" />
        </div>
        <p v-if="nameTaken" class="text-xs text-warning">A collection with this name is already there; both will show.</p>
        <p v-if="target?.serverId" class="text-xs opacity-60">Copied into a team workspace, it is shared with that team at once. Files picked for requests stay on this computer.</p>
      </template>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !toId || !target || ((!clash || mode === 'duplicate') && !name.trim())" @click="copy">
          <span v-if="busy" class="loading loading-spinner loading-xs" />{{ clash ? { merge: 'Merge', replace: 'Replace', duplicate: 'Duplicate' }[mode] : 'Copy' }}
        </button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
