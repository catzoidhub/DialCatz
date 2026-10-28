<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { uid, type Environment, type EnvVariable, type ExportFormat } from '@shared/types';
import { attempt, envDirty, envFocus, notify, pendingSection, plain, readOnly, section, servers, setWorkspace, workspace } from '../state';
import { keyLabel } from '../platform';
import WorkspaceBar from './WorkspaceBar.vue';
import PromptDialog from './PromptDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
import EnvList from './EnvList.vue';

/**
 * Environments (sets of {{variables}}) and the workspace's globals. In a team workspace the names are shared and
 * each member fills in the values on their own computer; values never go to the server.
 */
const api = window.dialcatz;
const GLOBALS = '__globals';
const GLOBALS_HINT = 'Variables every request in this workspace can use; the active environment wins on the same name. Kept on this computer.';
const ENV_HINT = 'Use them as {{name}} in URLs, headers, bodies and auth.';
const selected = ref<string>(GLOBALS);
/** The list row the user clicked while there were unsaved edits (asked first). */
const wanted = ref<string | null>(null);
const draft = ref<EnvVariable[]>([]);
const dirty = ref(false);
const reveal = ref(new Set<number>());
const prompt = ref<{ mode: 'new' | 'rename' } | null>(null);
const deleting = ref<Environment | null>(null);

const env = computed(() => workspace.value?.environments.find((e) => e.id === selected.value) ?? null);
const team = computed(() => !!workspace.value?.serverId);

function load() {
  if (!workspace.value) return;
  if (selected.value !== GLOBALS && !env.value) selected.value = workspace.value.activeEnvironmentId ?? workspace.value.environments[0]?.id ?? GLOBALS;
  draft.value = plain(selected.value === GLOBALS ? workspace.value.globals : (env.value?.variables ?? []));
  dirty.value = false;
  reveal.value = new Set();
}
watch([() => workspace.value?.id, selected], load, { immediate: true });
watch(dirty, (d) => (envDirty.value = d), { immediate: true });

// "Open environment" from a {{variable}}: show where it lives and put the cursor on its value (a new row if unset).
const grid = ref<HTMLElement | null>(null);
watch(
  envFocus,
  async (f) => {
    if (!f || !workspace.value) return;
    envFocus.value = null;
    if (dirty.value) return;
    selected.value = f.envId === GLOBALS || workspace.value.environments.some((e) => e.id === f.envId) ? f.envId : GLOBALS;
    await nextTick();
    let i = draft.value.findIndex((v) => v.key.trim() === f.key);
    if (i < 0 && !namesLocked.value) {
      draft.value.push({ key: f.key, value: '', enabled: true, secret: false });
      dirty.value = true;
      i = draft.value.length - 1;
    }
    await nextTick();
    const input = grid.value?.querySelectorAll<HTMLInputElement>('[data-value]')[i];
    input?.scrollIntoView({ block: 'center' });
    input?.focus();
  },
  { immediate: true },
);
onBeforeUnmount(() => (envDirty.value = false));

function pick(id: string) {
  if (id === selected.value) return;
  if (dirty.value) wanted.value = id;
  else selected.value = id;
}
/** After the unsaved-changes question: go where the user wanted (another environment or another section). */
function proceed() {
  dirty.value = false;
  if (wanted.value) selected.value = wanted.value;
  if (pendingSection.value) section.value = pendingSection.value;
  wanted.value = null;
  pendingSection.value = null;
}
async function saveAndProceed() {
  if (await save()) proceed();
}
function stay() {
  wanted.value = null;
  pendingSection.value = null;
}
watch(
  () => workspace.value,
  () => !dirty.value && load(),
);

const rows = computed(() => [...draft.value, { key: '', value: '', enabled: true, secret: false }]);
function set(i: number, patch: Partial<EnvVariable>) {
  if (i >= draft.value.length) draft.value.push({ key: '', value: '', enabled: true, secret: false, ...patch });
  else draft.value[i] = { ...draft.value[i], ...patch };
  dirty.value = true;
}
function remove(i: number) {
  draft.value.splice(i, 1);
  dirty.value = true;
}

// Selecting several variables (bulk actions). Changes land in the draft like any edit: Save keeps them, Discard
// undoes them.
const picking = ref<Set<number> | null>(null);
watch([() => workspace.value?.id, selected], () => (picking.value = null));
const picked = computed(() => [...(picking.value ?? [])].filter((i) => i < draft.value.length));
const allPicked = computed(() => draft.value.length > 0 && picked.value.length === draft.value.length);
function pickRow(i: number) {
  const s = new Set(picking.value);
  if (s.has(i)) s.delete(i);
  else s.add(i);
  picking.value = s;
}
const pickAll = (on: boolean) => (picking.value = new Set(on ? draft.value.map((_, i) => i) : []));
function setPicked(patch: Partial<EnvVariable>) {
  for (const i of picked.value) draft.value[i] = { ...draft.value[i], ...patch };
  dirty.value = true;
}
function removePicked() {
  const drop = new Set(picked.value);
  draft.value = draft.value.filter((_, i) => !drop.has(i));
  dirty.value = true;
  picking.value = new Set();
  notify('info', `${drop.size} variable${drop.size === 1 ? '' : 's'} removed — Save to keep it, or discard the changes`);
}
/** Names may only be changed where the user may change the environment; values always (they are local). */
const namesLocked = computed(() => readOnly.value && selected.value !== GLOBALS);

async function save(): Promise<boolean> {
  if (!dirty.value) return true;
  const vars = draft.value.filter((v) => v.key.trim());
  const w = await attempt(() => (selected.value === GLOBALS ? api.saveGlobals(workspace.value!.id, plain(vars)) : api.saveEnvironment(workspace.value!.id, plain({ ...env.value!, variables: vars }))), 'Saved');
  if (!w) return false;
  dirty.value = false;
  setWorkspace(w);
  return true;
}
defineExpose({ save });

async function named(name: string) {
  const mode = prompt.value?.mode;
  prompt.value = null;
  if (mode === 'new') {
    const id = uid('e_');
    const w = await attempt(() => api.saveEnvironment(workspace.value!.id, { id, name, variables: [] }));
    if (w) {
      setWorkspace(w);
      selected.value = id;
    }
  } else if (env.value) {
    const w = await attempt(() => api.saveEnvironment(workspace.value!.id, plain({ ...env.value!, name, variables: draft.value })));
    if (w) setWorkspace(w);
  }
}
// Deleting asks for the environment's name typed out (a copy button saves typing it).
const typed = ref('');
watch(deleting, () => (typed.value = ''));
async function copyName() {
  await window.dialcatz.copyText(deleting.value?.name ?? '');
  notify('success', 'Name copied');
}
async function confirmDelete() {
  if (typed.value.trim() !== deleting.value?.name.trim()) return;
  const e = deleting.value!;
  deleting.value = null;
  const w = await attempt(() => api.deleteEnvironment(workspace.value!.id, e.id));
  if (w) {
    setWorkspace(w);
    selected.value = GLOBALS;
  }
}
// ---------------------------------------------------------------- selecting several environments (bulk delete)

const envPicking = ref<Set<string> | null>(null);
const envList = ref<InstanceType<typeof EnvList> | null>(null);
const envSort = computed(() => workspace.value?.layout.env?.sortBy ?? 'default');
watch(() => workspace.value?.id, () => (envPicking.value = null));
const envs = computed(() => workspace.value?.environments ?? []);
const envPicked = computed(() => envs.value.filter((e) => envPicking.value?.has(e.id)));
const allEnvsPicked = computed(() => envs.value.length > 0 && envPicked.value.length === envs.value.length);
function pickEnv(id: string) {
  const s = new Set(envPicking.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  envPicking.value = s;
}
const pickAllEnvs = (on: boolean) => (envPicking.value = new Set(on ? envs.value.map((e) => e.id) : []));
/** Several at once ask for "delete N environments" typed out; one asks for its name, as always. */
const bulkDeleting = ref<Environment[] | null>(null);
const bulkText = computed(() => (bulkDeleting.value ? `delete ${bulkDeleting.value.length} environments` : ''));
watch(bulkDeleting, () => (typed.value = ''));
function deletePicked() {
  const list = envPicked.value;
  if (list.length === 1) deleting.value = list[0];
  else if (list.length) bulkDeleting.value = list;
}
async function copyBulkText() {
  await window.dialcatz.copyText(bulkText.value);
  notify('success', 'Text copied');
}
async function confirmBulkDelete() {
  if (!bulkDeleting.value || typed.value.trim() !== bulkText.value) return;
  const list = bulkDeleting.value;
  bulkDeleting.value = null;
  let w = null;
  for (const e of list) w = (await attempt(() => api.deleteEnvironment(workspace.value!.id, e.id))) ?? w;
  if (!w) return;
  setWorkspace(w);
  if (!w.environments.some((e) => e.id === selected.value)) selected.value = GLOBALS;
  envPicking.value = null;
  notify('success', `Deleted ${list.length} environments`);
}

// ---------------------------------------------------------------- duplicate, export, import

/** A copy with the same variables and values, named "<name> copy" (or "copy 2" …), opened at once. */
async function duplicate(e: Environment) {
  const w = workspace.value;
  if (!w) return;
  const names = new Set(w.environments.map((x) => x.name.toLowerCase()));
  let name = `${e.name} copy`;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${e.name} copy ${n}`;
  const id = uid('e_');
  const saved = await attempt(() => api.saveEnvironment(w.id, plain({ id, name, variables: e.variables })), `“${name}” made`);
  if (!saved) return;
  setWorkspace(saved);
  pick(id);
}
/** Export: values are optional, secret values off unless chosen (the file can travel). */
const exporting = ref<{ env: Environment; values: boolean; secrets: boolean; format: ExportFormat } | null>(null);
async function doExport() {
  const x = exporting.value!;
  exporting.value = null;
  if (await attempt(() => api.exportEnvironment(workspace.value!.id, x.env.id, { values: x.values, secrets: x.values && x.secrets, format: x.format }))) notify('success', `“${x.env.name}” exported`);
}
async function importEnvs() {
  const r = await attempt(() => api.importEnvironments(workspace.value!.id));
  if (!r) return;
  setWorkspace(r.workspace);
  const last = r.workspace.environments.find((e) => e.name === r.names[r.names.length - 1]);
  if (last) pick(last.id);
  notify('success', r.names.length === 1 ? `“${r.names[0]}” imported` : `${r.names.length} environments imported`);
}

// ---------------------------------------------------------------- sharing values with the team (opt-in)

const me = computed(() => servers.value.find((x) => x.id === workspace.value?.serverId)?.identity?.member ?? null);
const shared = computed(() => (team.value ? (env.value?.shared ?? null) : null));
const sharedByMe = computed(() => !!shared.value && shared.value.byId === me.value?.id);
const sharing = ref<Set<string> | null>(null);
const loading = ref(false);
const ago = (iso: string) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
function startSharing() {
  // Secrets stay unticked unless the user ticks them.
  sharing.value = new Set(draft.value.filter((v) => v.key.trim() && !v.secret && v.value !== '').map((v) => v.key.trim()));
}
async function saveShared(next: Environment['shared']) {
  const w = await attempt(() => api.saveEnvironment(workspace.value!.id, plain({ ...env.value!, variables: draft.value.filter((v) => v.key.trim()), shared: next })));
  if (!w) return false;
  dirty.value = false;
  setWorkspace(w);
  // Send it now rather than at the next sync.
  const synced = await attempt(() => api.syncWorkspace(w.id));
  if (synced) setWorkspace(synced);
  return true;
}
async function confirmShare() {
  const keys = sharing.value!;
  sharing.value = null;
  const values = Object.fromEntries(draft.value.filter((v) => keys.has(v.key.trim())).map((v) => [v.key.trim(), v.value]));
  if (await saveShared({ by: me.value?.name ?? 'Someone', byId: me.value?.id ?? '', at: new Date().toISOString(), values })) notify('success', `Shared ${Object.keys(values).length} value(s) with your team`);
}
async function stopSharing() {
  if (await saveShared(undefined)) notify('success', 'Shared values removed from the server');
}
/** What loading the shared values would change here. */
const incoming = computed(() =>
  shared.value
    ? Object.entries(shared.value.values).map(([k, v]) => {
        const cur = draft.value.find((x) => x.key.trim() === k);
        return { key: k, value: v, current: cur?.value ?? null, secret: !!cur?.secret };
      })
    : [],
);
async function loadShared() {
  loading.value = false;
  for (const i of incoming.value) {
    const row = draft.value.find((x) => x.key.trim() === i.key);
    if (row) row.value = i.value;
    else draft.value.push({ key: i.key, value: i.value, enabled: true, secret: false });
  }
  dirty.value = true;
  if (await save()) notify('success', `Loaded ${incoming.value.length} value(s) shared by ${shared.value?.by}`);
}

/** Collections that picked this environment as their own. */
const usedBy = computed(() => (workspace.value?.items ?? []).filter((i) => i.kind === 'collection' && env.value && i.environmentId === env.value.id).map((i) => i.name));
async function activate() {
  const w = await attempt(() => api.setActiveEnvironment(workspace.value!.id, env.value!.id));
  if (w) setWorkspace(w);
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="sidebar flex w-72 shrink-0 flex-col">
      <WorkspaceBar />
      <div v-if="envPicking" class="select-bar mx-2 mb-2">
        <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="allEnvsPicked" :indeterminate="envPicked.length > 0 && !allEnvsPicked" aria-label="Select all environments" @change="pickAllEnvs(($event.target as HTMLInputElement).checked)" />
        <span class="flex-1 truncate text-sm"><b>{{ envPicked.length }}</b> of {{ envs.length }} selected</span>
        <button class="btn btn-ghost btn-xs btn-square text-error" title="Delete the selected environments…" aria-label="Delete the selected environments" :disabled="!envPicked.length || readOnly" @click="deletePicked"><Icon name="trash" class="size-4" /></button>
        <button class="btn btn-ghost btn-xs" @click="envPicking = null">Done</button>
      </div>
      <div v-else class="flex items-center gap-1 px-4 pt-1 pb-2">
        <span class="label-caps flex-1">Environments</span>
        <div class="dropdown dropdown-end">
          <button tabindex="0" class="btn btn-ghost btn-xs btn-square" :class="{ 'text-primary': envSort !== 'default' }" :title="`Sort by: ${envSort === 'name' ? 'Name' : 'Default (your order)'}`" aria-label="Sort environments" :disabled="!envs.length"><Icon name="sort" class="size-4" /></button>
          <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-56 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-lg">
            <li class="menu-title">Sort by</li>
            <li><button :class="{ 'menu-active': envSort === 'default' }" @click="(envList?.setSort('default'), ($event.currentTarget as HTMLElement).blur())">Default (your order)</button></li>
            <li><button :class="{ 'menu-active': envSort === 'name' }" @click="(envList?.setSort('name'), ($event.currentTarget as HTMLElement).blur())">Name</button></li>
          </ul>
        </div>
        <button class="btn btn-ghost btn-xs btn-square" title="Select environments (delete several at once)" aria-label="Select environments" :disabled="!envs.length || readOnly" @click="envPicking = new Set()"><Icon name="check" class="size-4" /></button>
        <div class="dropdown dropdown-end">
          <button tabindex="0" class="btn btn-ghost btn-xs btn-square" title="New" aria-label="New"><Icon name="plus" class="size-4" /></button>
          <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-48 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-lg">
            <li><button :disabled="readOnly" @click="((prompt = { mode: 'new' }), ($event.currentTarget as HTMLElement).blur())">New environment</button></li>
            <li><button @click="(envList?.newGroup(), ($event.currentTarget as HTMLElement).blur())">New group</button></li>
            <li><button :disabled="readOnly" @click="(importEnvs(), ($event.currentTarget as HTMLElement).blur())">Import environment…</button></li>
          </ul>
        </div>
      </div>
      <EnvList ref="envList" :selected="selected" :picking="envPicking" @pick="pick" @tick="pickEnv" @remove="(e) => (deleting = e)" @duplicate="duplicate" @export="(e) => (exporting = { env: e, values: true, secrets: false, format: 'dialcatz' })" />
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      <header class="drag flex items-center gap-3 border-b border-base-300/60 px-6 pt-5 pb-4">
        <div class="min-w-0 flex-1">
          <h1 class="text-lg font-semibold tracking-tight">{{ selected === GLOBALS ? 'Globals' : env?.name }}</h1>
          <p class="text-xs opacity-60">{{ selected === GLOBALS ? GLOBALS_HINT : ENV_HINT }}</p>
          <p v-if="env && usedBy.length" class="mt-0.5 truncate text-xs opacity-60">Used by {{ usedBy.join(', ') }}</p>
        </div>
        <template v-if="env">
          <button v-if="env.id !== workspace?.activeEnvironmentId" class="btn btn-sm" title="The environment for scratch tabs and collections that do not pick their own" @click="activate">Make default</button>
          <span v-else class="badge badge-soft badge-success" title="The environment for scratch tabs and collections that do not pick their own">Default</span>
          <button v-if="team && !readOnly" class="btn btn-ghost btn-sm" title="Store a copy of the values on the server for your team" @click="startSharing">Share values…</button>
          <button class="btn btn-ghost btn-sm btn-square" title="Duplicate" aria-label="Duplicate" :disabled="readOnly" @click="duplicate(env)"><Icon name="copy" class="size-4" /></button>
          <button class="btn btn-ghost btn-sm btn-square" title="Export…" aria-label="Export" @click="exporting = { env, values: true, secrets: false, format: 'dialcatz' }"><Icon name="upload" class="size-4" /></button>
          <button class="btn btn-ghost btn-sm btn-square" title="Rename" :disabled="readOnly" @click="prompt = { mode: 'rename' }"><Icon name="pencil" class="size-4" /></button>
          <button class="btn btn-ghost btn-sm btn-square text-error" title="Delete" :disabled="readOnly" @click="deleting = env"><Icon name="trash" class="size-4" /></button>
        </template>
        <button class="btn btn-primary btn-sm" :disabled="!dirty" :title="`Save (${keyLabel('mod+S')})`" @click="save">Save</button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div v-if="team && selected !== GLOBALS" class="alert alert-info alert-soft mb-4 text-sm">
          <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
          <span>Team environment: the variable <b>names</b> are shared with your team; the <b>values</b> you type stay on this computer. Each member fills in their own.</span>
        </div>
        <div v-if="shared" class="alert alert-soft mb-4 text-sm" :class="sharedByMe ? 'alert-success' : 'alert-info'">
          <CatMood :mood="sharedByMe ? 'success' : 'info'" class="size-7 shrink-0 -my-0.5" />
          <span class="flex-1">
            <template v-if="sharedByMe">You shared {{ Object.keys(shared.values).length }} value(s) with your team · {{ ago(shared.at) }}</template>
            <template v-else><b>{{ shared.by }}</b> shared {{ Object.keys(shared.values).length }} value(s) · {{ ago(shared.at) }}</template>
          </span>
          <template v-if="sharedByMe && !readOnly">
            <button class="btn btn-ghost btn-xs" @click="startSharing">Update</button>
            <button class="btn btn-ghost btn-xs" @click="stopSharing">Stop sharing</button>
          </template>
          <button v-else-if="!sharedByMe" class="btn btn-primary btn-xs" @click="loading = true">Load shared values from {{ shared.by }}</button>
        </div>
        <div v-if="draft.length && !namesLocked" class="mb-3 flex min-h-8 flex-wrap items-center gap-2">
          <template v-if="picking">
            <div class="select-bar flex-1">
              <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="allPicked" :indeterminate="picked.length > 0 && !allPicked" aria-label="Select all variables" @change="pickAll(($event.target as HTMLInputElement).checked)" />
              <span class="flex-1 truncate text-sm"><b>{{ picked.length }}</b> of {{ draft.length }} selected</span>
              <button class="btn btn-ghost btn-xs" :disabled="!picked.length" @click="setPicked({ enabled: true })">Turn on</button>
              <button class="btn btn-ghost btn-xs" :disabled="!picked.length" @click="setPicked({ enabled: false })">Turn off</button>
              <button class="btn btn-ghost btn-xs" :disabled="!picked.length" @click="setPicked({ secret: true })">Secret</button>
              <button class="btn btn-ghost btn-xs" :disabled="!picked.length" @click="setPicked({ secret: false })">Not secret</button>
              <button class="btn btn-ghost btn-xs text-error gap-1" :disabled="!picked.length" @click="removePicked"><Icon name="trash" class="size-3.5" />Remove</button>
              <button class="btn btn-ghost btn-xs" @click="picking = null">Done</button>
            </div>
          </template>
          <template v-else>
            <span class="flex-1 text-xs opacity-60">{{ draft.length }} variable{{ draft.length === 1 ? '' : 's' }}</span>
            <button class="btn btn-ghost btn-xs gap-1" title="Select variables to turn on or off, mark secret or remove several at once" @click="picking = new Set()"><Icon name="check" class="size-3.5" />Select</button>
          </template>
        </div>
        <div ref="grid" class="env-grid" :class="{ 'is-picking': picking }">
          <span v-if="picking" />
          <span />
          <span class="label-caps">Variable</span>
          <span class="label-caps">Value</span>
          <span class="label-caps text-center" title="Secret values are hidden on screen">Secret</span>
          <span />
          <template v-for="(v, i) in rows" :key="i">
            <template v-if="picking">
              <input v-if="i < draft.length" type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="picking.has(i)" :aria-label="`Select ${v.key || 'this variable'}`" @change="pickRow(i)" />
              <span v-else />
            </template>
            <input v-if="i < draft.length" type="checkbox" class="toggle toggle-xs toggle-primary" :checked="v.enabled" :disabled="namesLocked" title="Use this variable" @change="set(i, { enabled: ($event.target as HTMLInputElement).checked })" />
            <span v-else />
            <input class="input input-sm font-mono" :value="v.key" placeholder="name" :readonly="namesLocked" spellcheck="false" @input="set(i, { key: ($event.target as HTMLInputElement).value })" />
            <div class="relative">
              <input data-value class="input input-sm w-full font-mono" :type="v.secret && !reveal.has(i) ? 'password' : 'text'" :value="v.value" placeholder="value" spellcheck="false" @input="set(i, { value: ($event.target as HTMLInputElement).value })" />
              <button v-if="v.secret" class="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-50 hover:opacity-100" @click="reveal.has(i) ? reveal.delete(i) : reveal.add(i)"><Icon :name="reveal.has(i) ? 'eyeOff' : 'eye'" class="size-4" /></button>
            </div>
            <div class="flex justify-center"><input v-if="i < draft.length" type="checkbox" class="toggle toggle-xs" :checked="v.secret" :disabled="namesLocked" @change="set(i, { secret: ($event.target as HTMLInputElement).checked })" /></div>
            <button v-if="i < draft.length && !namesLocked" class="kv-del" title="Remove" @click="remove(i)"><Icon name="x" class="size-3.5" /></button>
            <span v-else />
          </template>
        </div>
      </div>
    </section>

    <ConfirmDialog v-if="wanted || pendingSection" title="Save your changes?" text="These variables have changes that are not saved yet." confirm="Save" tone="primary" @ok="saveAndProceed" @cancel="stay">
      <div class="flex justify-end"><button class="btn btn-ghost btn-sm text-error" @click="proceed">Discard changes</button></div>
    </ConfirmDialog>
    <dialog v-if="sharing" open class="modal modal-open" @keydown.esc="sharing = null">
      <div class="modal-box w-[34rem] max-w-[95vw] space-y-3">
        <h3 class="text-lg font-semibold tracking-tight">Share values with your team</h3>
        <div class="alert alert-warning alert-soft text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" /><span>The values you tick are stored on the team’s server and every member of this workspace can load them. Leave out passwords and personal tokens.</span></div>
        <div class="max-h-72 overflow-auto rounded-xl border border-base-300/70">
          <label v-for="v in draft.filter((x) => x.key.trim())" :key="v.key" class="flex items-center gap-3 border-b border-base-300/50 px-3 py-1.5 last:border-0">
            <input type="checkbox" class="checkbox checkbox-xs" :checked="sharing.has(v.key.trim())" @change="($event.target as HTMLInputElement).checked ? sharing.add(v.key.trim()) : sharing.delete(v.key.trim())" />
            <span class="w-40 truncate font-mono text-sm">{{ v.key }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs opacity-60">{{ v.secret ? '•••••• (secret)' : v.value || '(empty)' }}</span>
          </label>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="sharing = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="!sharing.size" @click="confirmShare">Share {{ sharing.size }} value(s)</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="sharing = null" />
    </dialog>

    <dialog v-if="loading && shared" open class="modal modal-open" @keydown.esc="loading = false">
      <div class="modal-box w-[36rem] max-w-[95vw] space-y-3">
        <h3 class="text-lg font-semibold tracking-tight">Load values shared by {{ shared.by }}?</h3>
        <p class="text-sm opacity-70">These replace your own values on this computer for “{{ env?.name }}”.</p>
        <div class="max-h-72 overflow-auto rounded-xl border border-base-300/70">
          <div v-for="i in incoming" :key="i.key" class="grid grid-cols-[10rem_1fr] gap-2 border-b border-base-300/50 px-3 py-1.5 text-sm last:border-0">
            <span class="truncate font-mono">{{ i.key }}</span>
            <span class="min-w-0 truncate font-mono text-xs">
              <span v-if="i.current === null" class="text-success">new: </span>
              <span v-else-if="i.current === i.value" class="opacity-50">same · </span>
              <span v-else-if="i.current === ''" class="text-success">fills in · </span>
              <span v-else class="text-warning">changes · </span>
              {{ i.secret ? '••••••' : i.value || '(empty)' }}
            </span>
          </div>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="loading = false">Cancel</button>
          <button class="btn btn-primary btn-sm" @click="loadShared">Load {{ incoming.length }} value(s)</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="loading = false" />
    </dialog>

    <PromptDialog v-if="prompt" :title="prompt.mode === 'new' ? 'New environment' : 'Rename environment'" :value="prompt.mode === 'new' ? 'Local' : (env?.name ?? '')" :confirm="prompt.mode === 'new' ? 'Create' : 'Rename'" @ok="named" @cancel="prompt = null" />
    <dialog v-if="exporting" open class="modal modal-open" @keydown.esc="exporting = null">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <h3 class="text-lg font-semibold tracking-tight">Export “{{ exporting.env.name }}”</h3>
        <div class="seg seg-choice w-full" role="radiogroup" aria-label="Format">
          <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': exporting.format === 'dialcatz' }" :aria-checked="exporting.format === 'dialcatz'" @click="exporting.format = 'dialcatz'">DialCatz format</button>
          <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': exporting.format === 'postman' }" :aria-checked="exporting.format === 'postman'" @click="exporting.format = 'postman'">Postman format</button>
        </div>
        <p class="text-sm opacity-70">
          <template v-if="exporting.format === 'dialcatz'"><span class="font-mono text-xs">{{ exporting.env.name }}.dialcatz_environment.json</span> — for DialCatz (Variables → + → Import environment).</template>
          <template v-else><span class="font-mono text-xs">{{ exporting.env.name }}.postman_environment.json</span> — for Postman; DialCatz imports it too.</template>
          {{ exporting.env.variables.length }} variable{{ exporting.env.variables.length === 1 ? '' : 's' }}.
        </p>
        <div class="opt-row">
          <span class="flex flex-col"><span class="label-caps">Include values</span><span class="text-xs opacity-50">Off: names only, each person fills in their own</span></span>
          <input v-model="exporting.values" type="checkbox" class="toggle toggle-sm toggle-primary" />
        </div>
        <div class="opt-row">
          <span class="flex flex-col"><span class="label-caps">Include secret values</span><span class="text-xs opacity-50">Tokens, keys, passwords — the file is plain text</span></span>
          <input v-model="exporting.secrets" type="checkbox" class="toggle toggle-sm toggle-warning" :disabled="!exporting.values" />
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="exporting = null">Cancel</button>
          <button class="btn btn-primary btn-sm gap-1.5" @click="doExport"><Icon name="upload" class="size-4" />Export…</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="exporting = null" />
    </dialog>
    <ConfirmDialog
      v-if="deleting"
      :title="`Delete “${deleting.name}”?`"
      :text="`Its ${deleting.variables.length} variable(s) are removed${team ? ' for the whole team' : ''}. This cannot be undone.`"
      confirm="Delete environment"
      tone="error"
      :blocked="typed.trim() !== deleting.name.trim()"
      @ok="confirmDelete"
      @cancel="deleting = null"
    >
      <div class="space-y-1.5">
        <p class="flex flex-wrap items-center gap-1 text-sm">Type <b class="font-mono">{{ deleting.name }}</b><button class="btn btn-ghost btn-xs btn-square" title="Copy the name" aria-label="Copy the name" @click="copyName"><Icon name="copy" class="size-3.5" /></button>to confirm:</p>
        <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="deleting.name" spellcheck="false" autocomplete="off" @keydown.enter="confirmDelete" />
      </div>
    </ConfirmDialog>
    <ConfirmDialog
      v-if="bulkDeleting"
      :title="`Delete ${bulkDeleting.length} environments?`"
      :text="`They and their variables are removed${team ? ' for the whole team' : ''}. This cannot be undone.`"
      confirm="Delete environments"
      tone="error"
      :blocked="typed.trim() !== bulkText"
      @ok="confirmBulkDelete"
      @cancel="bulkDeleting = null"
    >
      <ul class="max-h-40 space-y-0.5 overflow-auto rounded-lg border border-base-300/70 p-2 text-sm">
        <li v-for="e in bulkDeleting" :key="e.id" class="flex items-center gap-2"><Icon name="environments" class="size-3.5 shrink-0 opacity-60" /><span class="flex-1 truncate">{{ e.name }}</span><span class="text-xs opacity-50">{{ e.variables.length }} variable{{ e.variables.length === 1 ? '' : 's' }}</span></li>
      </ul>
      <div class="space-y-1.5">
        <p class="flex flex-wrap items-center gap-1 text-sm">Type <b class="font-mono">{{ bulkText }}</b><button class="btn btn-ghost btn-xs btn-square" title="Copy the text" aria-label="Copy the text" @click="copyBulkText"><Icon name="copy" class="size-3.5" /></button>to confirm:</p>
        <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="bulkText" spellcheck="false" autocomplete="off" @keydown.enter="confirmBulkDelete" />
      </div>
    </ConfirmDialog>
  </div>
</template>
