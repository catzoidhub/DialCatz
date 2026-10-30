<script setup lang="ts">
import SyncConflicts from './SyncConflicts.vue';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ExportFormat, FolderGitStatus } from '@shared/types';
import { attempt, envDirty, goSection, loadWorkspaces, notify, selectWorkspace, servers, setWorkspace, workspace, workspaces } from '../state';
import NewWorkspaceDialog from './NewWorkspaceDialog.vue';
import PromptDialog from './PromptDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import GitPanel from './GitPanel.vue';
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

async function created(id: string) {
  creating.value = false;
  await loadWorkspaces(id);
  await selectWorkspace(id);
  void refreshGit();
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
/** Closes the dropdown (it stays open while something inside has focus). */
const close = (e: Event) => {
  (e.currentTarget as HTMLElement | null)?.blur();
  (document.activeElement as HTMLElement | null)?.blur();
};

// ---------------------------------------------------------------- rename / delete
const renaming = ref<{ id: string; name: string } | null>(null);
function startRename(id: string, name: string, e: Event) {
  close(e);
  renaming.value = { id, name };
}
async function rename(name: string) {
  const r = renaming.value!;
  renaming.value = null;
  const w = await attempt(() => api.renameWorkspace(r.id, name), 'Workspace renamed');
  if (!w) return;
  await loadWorkspaces();
  if (workspace.value?.id === w.id) setWorkspace(w);
}
/** A team workspace is deleted for every member: in the server's admin panel (Workspaces page). */
async function deleteOnDen(id: string, e: Event) {
  close(e);
  const url = await attempt(() => api.teamAdminUrl(id));
  if (url) {
    await api.openUrl(url);
    notify('info', 'Delete it on the Workspaces page of the admin panel (as the server admin)');
  }
}
const deleting = ref<{ id: string; name: string; folder: boolean } | null>(null);
const typed = ref('');
function startDelete(id: string, name: string, folder: boolean, e: Event) {
  close(e);
  typed.value = '';
  deleting.value = { id, name, folder };
}
async function copyName() {
  await api.copyText(deleting.value!.name);
  notify('info', 'Name copied');
}
async function remove() {
  const d = deleting.value!;
  if (typed.value.trim() !== d.name.trim()) return;
  deleting.value = null;
  const ok = await attempt(() => api.deleteWorkspace(d.id).then(() => true), `“${d.name}” deleted`);
  if (!ok) return;
  await loadWorkspaces(workspace.value?.id === d.id ? undefined : workspace.value?.id);
}

// ---------------------------------------------------------------- folder workspaces (git sharing)

/** ~/… instead of the whole home path, and only the last parts of a long one. */
function shortPath(p: string) {
  const home = p.replace(/^\/Users\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/, '~');
  const parts = home.split(/[\\/]/);
  return parts.length > 4 ? `…/${parts.slice(-3).join('/')}` : home;
}
async function openFolder() {
  const w = await attempt(() => api.openFolderWorkspace());
  if (!w) return;
  await loadWorkspaces();
  await selectWorkspace(w.id);
  notify('success', w.items.length || w.environments.length ? `Opened “${w.name}” from its folder` : `“${w.name}” is ready — what you add is saved as files in the folder`);
}
async function moveToFolder() {
  const w = await attempt(() => api.useFolder(workspace.value!.id));
  if (!w) return;
  setWorkspace(w);
  await loadWorkspaces();
  notify('success', 'Saved as files in the folder — commit them to share with your team');
}
// Git status of the folder: when the workspace or its items change, and when the window comes back (no polling).
const gitSt = ref<FolderGitStatus | null>(null);
const gitOpen = ref(false);
let gitTimer: ReturnType<typeof setTimeout> | null = null;
function refreshGit() {
  if (gitTimer) clearTimeout(gitTimer);
  gitTimer = setTimeout(async () => {
    const w = workspace.value;
    if (!w?.folder) return void (gitSt.value = null);
    try {
      const s = await api.folderGitStatus(w.id);
      if (workspace.value?.id === w.id) gitSt.value = s;
    } catch {
      gitSt.value = null;
    }
  }, 600);
}
watch(() => [workspace.value?.id, workspace.value?.folder, workspace.value?.items, workspace.value?.environments], refreshGit, { immediate: true });
const onFocus = () => refreshGit();
onMounted(() => window.addEventListener('focus', onFocus));
onBeforeUnmount(() => window.removeEventListener('focus', onFocus));
const stopping = ref(false);
async function stopFolder() {
  stopping.value = false;
  const w = await attempt(() => api.stopUsingFolder(workspace.value!.id));
  if (!w) return;
  setWorkspace(w);
  await loadWorkspaces();
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
          <span class="block truncate text-[11px] opacity-50">{{ serverOf ? `${host(serverOf.url)} · ${workspace?.role}` : workspace?.folder ? `Folder · ${shortPath(workspace.folder)}` : 'Personal · this computer' }}</span>
        </span>
        <Icon name="chevronDown" class="size-4 opacity-50" />
      </button>
      <div tabindex="0" class="dropdown-content ws-menu z-40 mt-1 w-[19rem]">
        <p class="ws-menu-title">Personal</p>
        <div v-for="w in groups.personal" :key="w.id" class="ws-row" :class="{ 'is-active': w.id === workspace?.id }">
          <button class="ws-row-main" :title="w.folder" @click="pick(w.id)">
            <span class="ws-row-ico"><Icon :name="w.folder ? 'folder' : 'requests'" class="size-3.5" /></span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm">{{ w.name }}</span>
              <span class="block truncate text-[11px] opacity-50">{{ w.folder ? shortPath(w.folder) : 'This computer' }}</span>
            </span>
            <Icon v-if="w.id === workspace?.id" name="check" class="ws-row-check size-4" />
          </button>
          <span class="ws-row-tools">
            <button class="btn btn-ghost btn-xs btn-square" title="Rename" aria-label="Rename" @click="startRename(w.id, w.name, $event)"><Icon name="pencil" class="size-3.5" /></button>
            <button class="btn btn-ghost btn-xs btn-square hover:text-error" title="Delete…" aria-label="Delete" @click="startDelete(w.id, w.name, !!w.folder, $event)"><Icon name="trash" class="size-3.5" /></button>
          </span>
        </div>
        <template v-for="g in groups.team" :key="g.server.id">
          <p class="ws-menu-title truncate">{{ host(g.server.url) }}</p>
          <div v-for="w in g.list" :key="w.id" class="ws-row" :class="{ 'is-active': w.id === workspace?.id }">
            <button class="ws-row-main" @click="pick(w.id)">
              <span class="ws-row-ico is-team"><Icon name="team" class="size-3.5" /></span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm">{{ w.name }}</span>
                <span class="block truncate text-[11px] capitalize opacity-50">{{ w.role }}</span>
              </span>
              <Icon v-if="w.id === workspace?.id" name="check" class="ws-row-check size-4" />
            </button>
            <span v-if="w.role === 'owner'" class="ws-row-tools">
              <button class="btn btn-ghost btn-xs btn-square" title="Rename (for everyone)" aria-label="Rename" @click="startRename(w.id, w.name, $event)"><Icon name="pencil" class="size-3.5" /></button>
              <button class="btn btn-ghost btn-xs btn-square hover:text-error" title="Delete on DialCatz Den…" aria-label="Delete on DialCatz Den" @click="deleteOnDen(w.id, $event)"><Icon name="trash" class="size-3.5" /></button>
            </span>
          </div>
        </template>

        <div class="ws-menu-rule" />
        <button class="ws-action" @click="close($event); creating = true"><Icon name="plus" class="size-4" />New workspace…</button>
        <button class="ws-action" @click="close($event); openFolder()"><Icon name="folder" class="size-4" />Open a folder as a workspace…</button>
        <button class="ws-action" @click="close($event); goSection('team')"><Icon name="team" class="size-4" />Connect to a team server…</button>

        <template v-if="workspace">
          <div class="ws-menu-rule" />
          <p class="ws-menu-title truncate">{{ workspace.name }}</p>
          <template v-if="!workspace.serverId">
            <button class="ws-action" @click="startRename(workspace.id, workspace.name, $event)"><Icon name="pencil" class="size-4" />Rename…</button>
            <button v-if="!workspace.folder" class="ws-action" @click="close($event); moveToFolder()"><Icon name="folder" class="size-4" />Move to a folder…</button>
            <template v-else>
              <button class="ws-action" @click="close($event); api.revealFolder(workspace.id)"><Icon name="folder" class="size-4" />Show the folder</button>
              <button class="ws-action" @click="close($event); stopping = true"><Icon name="x" class="size-4" />Stop using the folder…</button>
            </template>
          </template>
          <button v-else-if="workspace.role === 'owner'" class="ws-action" @click="startRename(workspace.id, workspace.name, $event)"><Icon name="pencil" class="size-4" />Rename for everyone…</button>
          <button class="ws-action" @click="close($event); exporting = { format: 'dialcatz', values: true, secrets: false }"><Icon name="upload" class="size-4" />Export…</button>
          <button v-if="workspace.serverId && workspace.role === 'owner'" class="ws-action is-danger" title="Deleting a team workspace removes it for every member: it is done in the server's admin panel" @click="deleteOnDen(workspace.id, $event)"><Icon name="trash" class="size-4" />Delete on DialCatz Den…</button>
          <button v-if="!workspace.serverId" class="ws-action is-danger" @click="startDelete(workspace.id, workspace.name, !!workspace.folder, $event)"><Icon name="trash" class="size-4" />Delete…</button>
        </template>
      </div>
    </div>
  </div>
  <div v-if="workspace?.folder" class="mx-3 mb-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px]" :class="workspace.folderError ? 'bg-error/10 text-error' : 'bg-base-content/5'">
    <Icon name="folder" class="size-3.5 shrink-0 opacity-70" />
    <span class="min-w-0 flex-1 truncate" :title="workspace.folderError || workspace.folder">
      <template v-if="workspace.folderError">{{ workspace.folderError }}</template>
      <template v-else-if="gitSt?.repo">
        <span class="font-mono">{{ gitSt.branch }}</span>
        <template v-if="gitSt.conflicts.length"> · <span class="text-error">conflicts</span></template>
        <template v-else> · {{ gitSt.changes.length ? `${gitSt.changes.length} change${gitSt.changes.length === 1 ? '' : 's'}` : 'committed' }}</template>
        <template v-if="gitSt.ahead"> · ↑{{ gitSt.ahead }}</template>
        <template v-if="gitSt.behind"> · ↓{{ gitSt.behind }}</template>
      </template>
      <template v-else>Saved as files in {{ shortPath(workspace.folder) }}</template>
    </span>
    <button class="btn btn-ghost btn-xs" title="Commit, pull and push this workspace's files" @click="gitOpen = true">Git</button>
    <button class="btn btn-ghost btn-xs btn-square" title="Show the folder" aria-label="Show the folder" @click="api.revealFolder(workspace.id)"><Icon name="folder" class="size-3.5" /></button>
  </div>
  <GitPanel v-if="gitOpen && workspace?.folder" :status="gitSt" @status="(s) => (gitSt = s)" @close="((gitOpen = false), refreshGit())" />
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
  <ConfirmDialog v-if="stopping && workspace?.folder" title="Stop using the folder?" :text="`DialCatz stops writing to ${workspace.folder}. The files there stay as they are; this workspace keeps its collections on this computer only.`" confirm="Stop using it" tone="warning" @ok="stopFolder" @cancel="stopping = false" />
  <NewWorkspaceDialog v-if="creating" @close="creating = false" @created="created" />
  <PromptDialog v-if="renaming" :title="workspaces.find((x) => x.id === renaming!.id)?.serverId ? 'Rename team workspace' : 'Rename workspace'" :text="workspaces.find((x) => x.id === renaming!.id)?.serverId ? 'The new name shows for every member.' : ''" :value="renaming.name" confirm="Rename" @ok="rename" @cancel="renaming = null" />
  <ConfirmDialog
    v-if="deleting"
    :title="`Delete “${deleting.name}”?`"
    :text="deleting.folder ? 'Its collections, environments and history go from DialCatz on this computer. The folder and its files stay where they are (open it again any time).' : `Its collections, environments, variable values and history are deleted from this computer. This cannot be undone.${groups.personal.length <= 1 ? ' An empty “Personal” workspace takes its place.' : ''}`"
    confirm="Delete"
    tone="error"
    :blocked="typed.trim() !== deleting.name.trim()"
    @ok="remove"
    @cancel="deleting = null"
  >
    <div class="space-y-1.5">
      <p class="flex flex-wrap items-center gap-1 text-sm">Type <b class="font-mono">{{ deleting.name }}</b><button class="btn btn-ghost btn-xs btn-square" title="Copy the name" aria-label="Copy the name" @click="copyName"><Icon name="copy" class="size-3.5" /></button>to confirm:</p>
      <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="deleting.name" spellcheck="false" autocomplete="off" @keydown.enter="remove" />
    </div>
  </ConfirmDialog>
  <SyncConflicts />
</template>

<style scoped>
.ws-menu {
  max-height: calc(100vh - 9rem);
  overflow-y: auto;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid oklch(from var(--color-base-300) l c h / 0.7);
  background: var(--color-base-100);
  box-shadow: 0 16px 40px -12px oklch(0% 0 0 / 0.45);
}
.ws-menu-title {
  padding: 8px 10px 4px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.45;
}
.ws-menu-rule {
  margin: 6px 4px;
  border-top: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
}
.ws-row {
  position: relative;
  display: flex;
  align-items: center;
  border-radius: 10px;
}
.ws-row:hover {
  background: oklch(from var(--color-base-content) l c h / 0.06);
}
.ws-row.is-active {
  background: color-mix(in oklch, var(--color-primary) 12%, transparent);
}
.ws-row-main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  text-align: left;
}
.ws-row-ico {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: oklch(from var(--color-base-content) l c h / 0.07);
}
.ws-row-ico.is-team {
  color: var(--c-team);
  background: color-mix(in oklch, var(--c-team) 16%, transparent);
}
.ws-row.is-active .ws-row-ico:not(.is-team) {
  color: var(--primary-ink);
  background: color-mix(in oklch, var(--color-primary) 18%, transparent);
}
.ws-row-check {
  flex-shrink: 0;
  color: var(--primary-ink);
}
/* Rename / delete show on hover, over the tick. */
.ws-row-tools {
  display: none;
  gap: 2px;
  padding-right: 4px;
}
.ws-row:hover .ws-row-tools,
.ws-row:focus-within .ws-row-tools {
  display: flex;
}
.ws-row:hover .ws-row-check {
  display: none;
}
.ws-action {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 10px;
  font-size: 13px;
  text-align: left;
}
.ws-action :deep(svg) {
  opacity: 0.6;
}
.ws-action:hover:not(:disabled) {
  background: oklch(from var(--color-base-content) l c h / 0.06);
}
.ws-action:disabled {
  opacity: 0.4;
}
.ws-action.is-danger {
  color: var(--color-error);
}
.ws-action.is-danger :deep(svg) {
  opacity: 0.85;
}
</style>
