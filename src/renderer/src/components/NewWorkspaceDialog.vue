<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { GitCloneTask } from '@shared/types';
import { notify } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
import RepoPicker from './RepoPicker.vue';
const api = window.dialcatz;

/**
 * New personal workspace, three ways:
 * - on this computer only (as before);
 * - in a folder: each collection, request and environment name is a small file there, so the folder can live in a
 *   Git repository and be shared through it (values stay on each computer). It can be connected to a repository
 *   right away: one of a connected account's, a new one made on the account, or any URL;
 * - from a Git repository: cloned, then its DialCatz workspace opens (or one starts in its dialcatz/ folder).
 */
const emit = defineEmits<{ close: []; created: [id: string] }>();

type Mode = 'local' | 'folder' | 'git';
const mode = ref<Mode>('local');
/** Step 1 picks how, step 2 is that way's form. */
const step = ref<1 | 2>(1);
const current = computed(() => MODES.find((m) => m.id === mode.value)!);
function choose(m: Mode) {
  mode.value = m;
  error.value = '';
  step.value = 2;
}
const name = ref('');
const parent = ref('');
const folderName = ref('');
const folderTouched = ref(false);
const slug = (s: string) => s.trim().replace(/[^\w .-]+/g, '-').replace(/\s+/g, '-').replace(/^[-.]+|-+$/g, '');
watch(name, (n) => !folderTouched.value && (folderName.value = slug(n)));
onMounted(async () => {
  parent.value = (await api.gitState().catch(() => null))?.cloneDir ?? '';
});

const connectNow = ref(false);
const target = ref<{ url: string; label: string } | null>(null);
const onPick = (url: string, label: string) => {
  target.value = url ? { url, label } : null;
  if (mode.value === 'git' && url) {
    const n = (label.split('/').pop() ?? '').replace(/\.git$/, '') || (url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '');
    if (!folderTouched.value) folderName.value = n.replace(/[^\w.-]+/g, '-');
  }
};
watch(mode, () => (target.value = null));

async function pickParent() {
  const dir = await api.pickFolder(mode.value === 'git' ? 'Clone into this folder' : 'Put the workspace folder in', parent.value);
  if (dir) parent.value = dir;
}

const busy = ref(false);
const error = ref('');
const clone = ref<GitCloneTask | null>(null);
let off: (() => void) | null = null;
onMounted(() => (off = window.dialcatz.onGit((s) => (clone.value = s.clone))));
onBeforeUnmount(() => off?.());
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const ready = computed(() => {
  if (mode.value === 'local') return !!name.value.trim();
  if (mode.value === 'folder') return !!name.value.trim() && !!parent.value.trim() && !!folderName.value.trim() && (!connectNow.value || !!target.value);
  return !!target.value && !!parent.value.trim() && !!folderName.value.trim();
});
const path = computed(() => (parent.value && folderName.value ? `${parent.value.replace(/\/+$/, '')}/${folderName.value}`.replace(/^\/Users\/[^/]+/, '~') : ''));

async function create() {
  if (step.value !== 2 || !ready.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (mode.value === 'local') {
      const w = await api.createWorkspace(name.value.trim());
      emit('created', w.id);
    } else if (mode.value === 'folder') {
      const w = await api.createFolderWorkspace(name.value.trim(), parent.value.trim(), folderName.value.trim());
      if (connectNow.value && target.value) {
        try {
          const r = await api.folderGitConnect(w.id, target.value.url);
          notify(r.conflicts ? 'warning' : 'success', r.conflicts ? `Connected to ${target.value.label}, with conflicts to settle (Git button)` : `Connected to ${target.value.label}: commit and Push with the Git button`);
        } catch (e) {
          // The workspace is there; connecting can be done again from its Git button.
          notify('warning', `Workspace created, but connecting failed: ${clean(e)}`);
        }
      }
      emit('created', w.id);
    } else {
      const dest = await api.gitClone(target.value!.url, parent.value.trim(), folderName.value.trim(), '', false);
      const st = await api.gitState();
      const repo = st.repos.find((r) => r.path === dest);
      if (!repo) throw new Error(`Cloned into ${dest}, but it is not on the Git list`);
      const id = await api.gitOpenWorkspace(repo.id);
      void api.gitDismissClone();
      notify('success', repo.workspaceFolder ? `Cloned ${target.value!.label}: its workspace is open` : `Cloned ${target.value!.label}: a new workspace started in its dialcatz folder`);
      emit('created', id);
    }
  } catch (e) {
    error.value = clean(e);
  } finally {
    busy.value = false;
  }
}

const MODES: { id: Mode; title: string; text: string; icon: 'requests' | 'folder' | 'git'; tile?: string }[] = [
  { id: 'local', title: 'Local', text: 'Kept by DialCatz on this computer only.', icon: 'requests' },
  { id: 'folder', title: 'In a folder', text: 'Saved as files you can share through Git — connect a repository now or later.', icon: 'folder', tile: 'var(--c-environments)' },
  { id: 'git', title: 'From a Git repository', text: 'Clone a repository and open the workspace in it.', icon: 'git', tile: 'var(--c-git)' },
];
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box flex max-h-[90vh] w-[36rem] max-w-[95vw] flex-col gap-4 overflow-y-auto" @submit.prevent="create">
      <div class="flex items-center gap-2">
        <button v-if="step === 2" type="button" class="btn btn-ghost btn-sm btn-square -ml-2" title="Back" aria-label="Back" :disabled="busy" @click="step = 1"><Icon name="chevron" class="size-4 rotate-180" /></button>
        <h3 class="flex-1 text-lg font-semibold tracking-tight">
          <template v-if="step === 1">New personal workspace</template>
          <template v-else>{{ current.id === 'git' ? 'Workspace from a Git repository' : current.id === 'folder' ? 'Workspace in a folder' : 'Local workspace' }}</template>
        </h3>
        <button type="button" class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" aria-label="Close" :disabled="busy" @click="emit('close')">✕</button>
      </div>

      <!-- Step 1: how -->
      <div v-if="step === 1" class="space-y-2">
        <p class="text-sm opacity-70">Where should it live?</p>
        <button v-for="m in MODES" :key="m.id" type="button" class="opt-card" :style="m.tile ? { '--tile': m.tile } : {}" @click="choose(m.id)">
          <span class="opt-card-icon"><Icon :name="m.icon" class="size-5" /></span>
          <span class="min-w-0 flex-1">
            <span class="opt-card-title">{{ m.title }}</span>
            <span class="opt-card-text">{{ m.text }}</span>
          </span>
          <Icon name="chevron" class="size-4 shrink-0 opacity-40" />
        </button>
      </div>

      <!-- Step 2: its form -->
      <template v-else>
      <label v-if="mode !== 'git'" class="block">
        <span class="label-caps mb-1 block">Name</span>
        <input v-model="name" class="input input-sm w-full" placeholder="Side project" :disabled="busy" autofocus />
      </label>

      <p v-if="mode === 'folder'" class="rounded-xl bg-base-200/70 px-3 py-2 text-xs leading-relaxed opacity-80">
        Every collection, request and environment name becomes a small file in this folder. Put it in a Git repository (or connect one below) and your team gets the same requests with Pull, and yours with Push — from the
        <b>Git</b> button above the collections. Variable values stay on each computer, never in the files.
      </p>
      <p v-else-if="mode === 'git'" class="rounded-xl bg-base-200/70 px-3 py-2 text-xs leading-relaxed opacity-80">
        The repository is cloned to this computer. When it holds a DialCatz workspace (made by a teammate, or by DevCatz for a site), that one opens; otherwise a new one starts in its <code>dialcatz</code> folder, ready to commit and Push.
      </p>

      <RepoPicker v-if="mode === 'git'" :allow-new="false" @pick="onPick" />

      <template v-if="mode !== 'local'">
        <div class="grid grid-cols-[minmax(0,1fr)_12rem] gap-2">
          <label class="block min-w-0">
            <span class="label-caps mb-1 block">{{ mode === 'git' ? 'Clone into' : 'Inside' }}</span>
            <span class="flex gap-1.5">
              <input v-model="parent" class="input input-sm min-w-0 flex-1 font-mono" spellcheck="false" :disabled="busy" />
              <button type="button" class="btn btn-sm btn-square" title="Choose the folder" aria-label="Choose the folder" :disabled="busy" @click="pickParent"><Icon name="folder" class="size-4" /></button>
            </span>
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Folder name</span>
            <input v-model="folderName" class="input input-sm w-full font-mono" spellcheck="false" :disabled="busy" @input="folderTouched = true" />
          </label>
        </div>
        <p v-if="path" class="truncate font-mono text-[11px] leading-normal opacity-50" :title="path">{{ path }}</p>
      </template>

      <template v-if="mode === 'folder'">
        <label class="flex items-center gap-2 text-sm"><input v-model="connectNow" type="checkbox" class="toggle toggle-sm toggle-primary" :disabled="busy" />Connect it to a Git repository now</label>
        <RepoPicker v-if="connectNow" :suggested-name="name" @pick="onPick" />
      </template>

      <div v-if="busy && mode === 'git' && clone" class="rounded-xl border border-base-300/70">
        <pre class="selectable max-h-32 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed">{{ clone.lines.join('\n') || 'Starting…' }}</pre>
      </div>
      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="selectable">{{ error }}</span></div>

      </template>

      <div class="modal-action mt-0">
        <button v-if="busy && mode === 'git'" type="button" class="btn btn-ghost btn-sm" @click="api.gitCancelClone()">Cancel clone</button>
        <button v-else type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button v-if="step === 2" class="btn btn-primary btn-sm" :disabled="busy || !ready">
          <span v-if="busy" class="loading loading-spinner loading-xs" />{{ mode === 'git' ? 'Clone & open' : 'Create' }}
        </button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
