<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { attempt, goSection, loadWorkspaces, notify } from '../state';
import { cloneRequest, gitState } from '../gitstate';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
const api = window.dialcatz;

/**
 * Clone a repository (Git → an account's repository, or any URL): the folder it goes into, its name, a branch and a
 * shallow clone, with git's progress and Cancel. When it is done, a DialCatz workspace in it opens with one click (or
 * a new one starts in its dialcatz/ folder).
 */
const props = defineProps<{ url: string; name: string; branch: string }>();
const emit = defineEmits<{ close: []; cloned: [repoId: string | null] }>();

const url = ref(props.url);
const name = ref(props.name);
const branch = ref(props.branch);
const parent = ref(gitState.value?.cloneDir ?? '');
const shallow = ref(false);
/** The folder name from the URL, until the user types one. */
watch(url, (u, old) => {
  const from = (x: string) => x.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
  if (!name.value || name.value === from(old)) name.value = from(u).replace(/[^\w.-]+/g, '-');
});

const clone = computed(() => gitState.value?.clone ?? null);
const running = ref(false);
const done = ref<string | null>(null);
const repo = computed(() => (done.value ? (gitState.value?.repos.find((r) => r.path === done.value) ?? null) : null));

async function pick() {
  const dir = await api.gitPickFolder(parent.value);
  if (dir) parent.value = dir;
}
async function start() {
  running.value = true;
  done.value = null;
  try {
    done.value = await api.gitClone(url.value, parent.value, name.value.trim(), branch.value.trim(), shallow.value);
    notify('success', `Cloned into ${done.value}`);
  } catch (e) {
    // The error is in the clone's state (shown below).
    void e;
  } finally {
    running.value = false;
  }
}
async function openWorkspace() {
  if (!repo.value) return;
  const id = await attempt(() => api.gitOpenWorkspace(repo.value!.id));
  if (!id) return;
  await loadWorkspaces(id);
  goSection('requests');
  close();
}
function close() {
  if (running.value) return;
  void api.gitDismissClone();
  emit('cloned', repo.value?.id ?? null);
  cloneRequest.value = null;
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="close">
    <div class="modal-box flex w-[38rem] max-w-[95vw] flex-col gap-3">
      <div class="flex items-center gap-2">
        <h3 class="flex-1 text-lg font-semibold tracking-tight">Clone a repository</h3>
        <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" aria-label="Close" :disabled="running" @click="close">✕</button>
      </div>

      <template v-if="!done">
        <label class="block">
          <span class="label-caps mb-1 block">Repository URL</span>
          <input v-model="url" class="input input-sm w-full font-mono" placeholder="https://github.com/you/repo.git or git@github.com:you/repo.git" spellcheck="false" :disabled="running" />
        </label>
        <div class="grid grid-cols-[minmax(0,1fr)_12rem] gap-2">
          <label class="block min-w-0">
            <span class="label-caps mb-1 block">Into</span>
            <span class="flex gap-1.5">
              <input v-model="parent" class="input input-sm min-w-0 flex-1 font-mono" spellcheck="false" :disabled="running" />
              <button type="button" class="btn btn-sm btn-square" title="Choose the folder" aria-label="Choose the folder" :disabled="running" @click="pick"><Icon name="folder" class="size-4" /></button>
            </span>
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Folder name</span>
            <input v-model="name" class="input input-sm w-full font-mono" spellcheck="false" :disabled="running" />
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <input v-model="branch" class="input input-sm w-48 font-mono" placeholder="Branch (default)" spellcheck="false" :disabled="running" />
          <label class="flex items-center gap-1.5 text-xs" title="Only the latest commit (faster for big repositories); fetch the rest later"><input v-model="shallow" type="checkbox" class="toggle toggle-xs" :disabled="running" />Latest commit only</label>
        </div>
      </template>

      <div v-if="clone && (running || clone.error)" class="rounded-xl border border-base-300/70">
        <pre class="selectable max-h-48 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed">{{ clone.lines.join('\n') || 'Starting…' }}</pre>
      </div>
      <div v-if="clone?.error && !running" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="selectable">{{ clone.error }}</span></div>

      <div v-if="done" class="alert alert-success alert-soft text-sm">
        <CatMood mood="success" class="size-7 shrink-0 -my-0.5" />
        <span class="flex-1">
          Cloned into <code class="break-all">{{ done }}</code>.
          <template v-if="repo?.workspaceFolder"> It holds a DialCatz workspace.</template>
          <template v-else> Start a DialCatz workspace in it (its <code>dialcatz/</code> folder) to share collections through this repository.</template>
        </span>
      </div>

      <div class="modal-action mt-1">
        <template v-if="done">
          <button class="btn btn-ghost btn-sm" @click="close">Close</button>
          <button class="btn btn-primary btn-sm" :disabled="!repo" @click="openWorkspace">{{ repo?.workspaceFolder ? 'Open its workspace' : 'Start a workspace in it' }}</button>
        </template>
        <template v-else>
          <button v-if="running" class="btn btn-ghost btn-sm" @click="api.gitCancelClone()">Cancel</button>
          <button v-else class="btn btn-ghost btn-sm" @click="close">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="running || !url.trim() || !name.trim() || !parent.trim()" @click="start"><span v-if="running" class="loading loading-spinner loading-xs" />Clone</button>
        </template>
      </div>
    </div>
    <div class="modal-backdrop" @click="close" />
  </dialog>
</template>
