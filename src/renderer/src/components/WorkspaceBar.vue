<script setup lang="ts">
import SyncConflicts from './SyncConflicts.vue';
import { computed, ref } from 'vue';
import type { ExportFormat } from '@shared/types';
import { attempt, envDirty, goSection, loadWorkspaces, notify, selectWorkspace, servers, setWorkspace, workspace, workspaces } from '../state';
import PromptDialog from './PromptDialog.vue';
import Icon from './Icon.vue';

/** Sidebar head: which workspace is on screen (personal or team), and its sync state for team ones. */
const api = window.dialcatz;
const creating = ref(false);
const syncing = ref(false);

const groups = computed(() => {
  const personal = workspaces.value.filter((w) => !w.serverId);
  const team = servers.value.map((s) => ({ server: s, list: workspaces.value.filter((w) => w.serverId === s.id) })).filter((g) => g.list.length);
  return { personal, team };
});
const serverOf = computed(() => servers.value.find((s) => s.id === workspace.value?.serverId) ?? null);
const host = (url: string) => url.replace(/^https?:\/\//, '');

async function create(name: string) {
  creating.value = false;
  const w = await attempt(() => api.createWorkspace(name));
  if (w) {
    await loadWorkspaces(w.id);
    await selectWorkspace(w.id);
  }
}
async function sync() {
  if (!workspace.value) return;
  syncing.value = true;
  const w = await attempt(() => api.syncWorkspace(workspace.value!.id));
  syncing.value = false;
  if (w) setWorkspace(w);
}
function pick(id: string) {
  (document.activeElement as HTMLElement | null)?.blur();
  if (envDirty.value) return notify('warning', 'Save or discard the variable changes first');
  void selectWorkspace(id);
}
// ---------------------------------------------------------------- Export all (one zip: DialCatz or Postman format)

const exporting = ref<{ format: ExportFormat; values: boolean; secrets: boolean } | null>(null);
const exportBusy = ref(false);
const counts = computed(() => ({ collections: workspace.value?.items.filter((i) => i.kind === 'collection').length ?? 0, environments: workspace.value?.environments.length ?? 0 }));
async function doExport() {
  const x = exporting.value!;
  exportBusy.value = true;
  const r = await attempt(() => api.exportWorkspace(workspace.value!.id, { format: x.format, values: x.values, secrets: x.values && x.secrets }));
  exportBusy.value = false;
  if (r === undefined) return;
  exporting.value = null;
  if (r) notify('success', `Exported ${r.collections} collection${r.collections === 1 ? '' : 's'} and ${r.environments} environment${r.environments === 1 ? '' : 's'}`);
}

const ago = (iso?: string) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(iso).toLocaleString();
};
</script>

<template>
  <div class="drag flex shrink-0 items-end px-3 pt-11 pb-2">
    <div class="dropdown w-full">
      <button tabindex="0" class="ws-pick no-drag">
        <img v-if="serverOf?.avatar" :src="serverOf.avatar" alt="" class="ws-dot object-cover" :title="serverOf.identity?.member.name" />
        <span v-else class="ws-dot" :class="workspace?.serverId ? 'is-team' : ''"><Icon :name="workspace?.serverId ? 'team' : 'requests'" class="size-3.5" /></span>
        <span class="min-w-0 flex-1 text-left">
          <span class="block truncate text-sm font-semibold">{{ workspace?.name ?? 'No workspace' }}</span>
          <span class="block truncate text-[11px] opacity-50">{{ serverOf ? `${host(serverOf.url)} · ${workspace?.role}` : 'Personal · this computer' }}</span>
        </span>
        <Icon name="chevronDown" class="size-4 opacity-50" />
      </button>
      <ul tabindex="0" class="dropdown-content menu z-40 mt-1 w-full rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl">
        <li class="menu-title">Personal</li>
        <li v-for="w in groups.personal" :key="w.id"><button :class="{ 'menu-active': w.id === workspace?.id }" @click="pick(w.id)">{{ w.name }}</button></li>
        <template v-for="g in groups.team" :key="g.server.id">
          <li class="menu-title truncate">{{ host(g.server.url) }}</li>
          <li v-for="w in g.list" :key="w.id">
            <button :class="{ 'menu-active': w.id === workspace?.id }" @click="pick(w.id)">
              <span class="flex-1 truncate">{{ w.name }}</span><span class="badge badge-ghost badge-xs">{{ w.role }}</span>
            </button>
          </li>
        </template>
        <div class="my-1 border-t border-base-300/60" />
        <li><button @click="creating = true">New personal workspace…</button></li>
        <li><button @click="goSection('team')">Connect to a team server…</button></li>
        <div class="my-1 border-t border-base-300/60" />
        <li><button :disabled="!workspace" @click="(exporting = { format: 'dialcatz', values: true, secrets: false }), ($event.currentTarget as HTMLElement).blur()">Export workspace…</button></li>
      </ul>
    </div>
  </div>
  <div v-if="workspace?.serverId" class="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-base-content/5 px-2.5 py-1.5 text-[11px]">
    <span class="status status-xs" :class="workspace.syncError ? 'status-error' : 'status-success'" />
    <span class="min-w-0 flex-1 truncate" :title="workspace.syncError || undefined">{{ workspace.syncError ? 'Sync failed' : `Synced ${ago(workspace.syncedAt)}` }}</span>
    <button class="btn btn-ghost btn-xs btn-square" title="Sync now" :disabled="syncing" @click="sync"><Icon name="refresh" class="size-3.5" :class="{ 'animate-spin': syncing }" /></button>
  </div>
  <dialog v-if="exporting && workspace" open class="modal modal-open" @keydown.esc="exporting = null">
    <div class="modal-box w-[32rem] max-w-[95vw] space-y-4">
      <h3 class="text-lg font-semibold tracking-tight">Export “{{ workspace.name }}”</h3>
      <p class="text-sm opacity-70">
        One zip with every collection ({{ counts.collections }}), environment ({{ counts.environments }}){{ workspace.globals.length ? ' and the globals' : '' }}.
        Import it in DialCatz with Import → File or paste{{ exporting.format === 'postman' ? ', or in Postman (Import → the zip)' : '' }}.
      </p>
      <div class="seg seg-choice w-full" role="radiogroup" aria-label="Format">
        <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': exporting.format === 'dialcatz' }" :aria-checked="exporting.format === 'dialcatz'" @click="exporting.format = 'dialcatz'">DialCatz format</button>
        <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': exporting.format === 'postman' }" :aria-checked="exporting.format === 'postman'" @click="exporting.format = 'postman'">Postman format</button>
      </div>
      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Include variable values</span><span class="text-xs opacity-50">Off: names only, each person fills in their own</span></span>
        <input v-model="exporting.values" type="checkbox" class="toggle toggle-sm toggle-primary" />
      </div>
      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Include secret values</span><span class="text-xs opacity-50">Tokens, keys, passwords — the zip is plain text inside</span></span>
        <input v-model="exporting.secrets" type="checkbox" class="toggle toggle-sm toggle-warning" :disabled="!exporting.values" />
      </div>
      <p class="text-xs opacity-50">Auth values in collections go in as they are. Files picked for request bodies stay out.</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="exportBusy" @click="exporting = null">Cancel</button>
        <button class="btn btn-primary btn-sm gap-1.5" :disabled="exportBusy" @click="doExport"><span v-if="exportBusy" class="loading loading-spinner loading-xs" /><Icon v-else name="upload" class="size-4" />Export…</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!exportBusy && (exporting = null)" />
  </dialog>
  <PromptDialog v-if="creating" title="New personal workspace" text="Kept on this computer only." value="Side project" confirm="Create" @ok="create" @cancel="creating = false" />
  <SyncConflicts />
</template>
