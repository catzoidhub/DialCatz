<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { FolderGitChange, FolderGitStatus } from '@shared/types';
import { notify, reloadWorkspace, workspace } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
import RepoPicker from './RepoPicker.vue';

/**
 * Git for a folder workspace (git sharing, phase 2): what changed in the workspace's files, each file's diff, commit
 * (this workspace's files only), pull and push — with the system's git and the user's own credentials. A pull that
 * cannot merge on its own leaves the conflicts for the user (fix the files, then commit), or Abort merge.
 */
const props = defineProps<{ status: FolderGitStatus | null }>();
const emit = defineEmits<{ close: []; status: [s: FolderGitStatus] }>();
const api = window.dialcatz;

const st = ref<FolderGitStatus | null>(props.status);
const busy = ref<'' | 'fetch' | 'commit' | 'pull' | 'push' | 'init' | 'abort' | 'connect'>('');
const error = ref('');
const message = ref('');
const picked = ref<FolderGitChange | null>(null);
const diffText = ref('');

const id = () => workspace.value!.id;
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function set(s: FolderGitStatus) {
  st.value = s;
  emit('status', s);
  if (picked.value && !s.changes.some((c) => c.path === picked.value!.path)) picked.value = null;
}
async function run<T>(what: typeof busy.value, fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = what;
  error.value = '';
  try {
    return await fn();
  } catch (e) {
    error.value = clean(e);
    return undefined;
  } finally {
    busy.value = '';
  }
}
const refresh = (fetch = false) => run(fetch ? 'fetch' : '', async () => set(await api.folderGitStatus(id(), fetch)));
onMounted(() => void refresh(true));

async function pick(c: FolderGitChange) {
  picked.value = c;
  diffText.value = '';
  diffText.value = (await run('', () => api.folderGitDiff(id(), c.path))) ?? '';
}
const diffLines = computed(() =>
  diffText.value
    .split('\n')
    .filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l))
    .map((l) => ({ text: l, kind: l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' })),
);

async function commit() {
  const s = await run('commit', () => api.folderGitCommit(id(), message.value));
  if (!s) return;
  set(s);
  message.value = '';
  notify('success', s.upstream || s.hasRemote ? 'Committed — Push to share it' : 'Committed');
}
async function pull() {
  const r = await run('pull', () => api.folderGitPull(id()));
  if (!r) return;
  set(r.status);
  await reloadWorkspace();
  notify(r.conflicts ? 'warning' : 'success', r.conflicts ? 'Pulled, with conflicts to settle' : r.merged ? 'Pulled and merged' : 'Up to date with the remote');
}
async function push() {
  const s = await run('push', () => api.folderGitPush(id()));
  if (!s) return;
  set(s);
  notify('success', 'Pushed');
}
async function init() {
  const s = await run('init', () => api.folderGitInit(id()));
  if (s) set(s);
}
async function abort() {
  const s = await run('abort', () => api.folderGitAbortMerge(id()));
  if (!s) return;
  set(s);
  await reloadWorkspace();
}

// ---- connect to a remote repository
const connecting = ref(false);
const target = ref<{ url: string; label: string } | null>(null);
async function connect() {
  const t = target.value;
  if (!t?.url) return;
  const r = await run('connect', () => api.folderGitConnect(id(), t.url));
  if (!r) return;
  set(r.status);
  connecting.value = false;
  target.value = null;
  await reloadWorkspace();
  notify(r.conflicts ? 'warning' : 'success', r.conflicts ? `Connected to ${t.label}, with conflicts to settle` : r.merged ? `Connected to ${t.label} and merged its commits` : `Connected to ${t.label}${r.status.changes.length ? ' — Commit, then Push' : ''}`);
}

const MARK: Record<FolderGitChange['kind'], { letter: string; tone: string; title: string }> = {
  added: { letter: 'A', tone: 'text-success', title: 'Added' },
  modified: { letter: 'M', tone: 'text-warning', title: 'Changed' },
  deleted: { letter: 'D', tone: 'text-error', title: 'Deleted' },
  renamed: { letter: 'R', tone: 'text-info', title: 'Renamed' },
  conflict: { letter: 'U', tone: 'text-error', title: 'Conflict' },
};
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box flex max-h-[85vh] w-[56rem] max-w-[95vw] min-w-0 flex-col gap-3 overflow-hidden">
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="flex items-center gap-2 text-lg font-semibold tracking-tight"><Icon name="code" class="size-5 opacity-70" />Git</h3>
        <template v-if="st?.repo">
          <span class="badge badge-ghost font-mono">{{ st.branch }}</span>
          <span v-if="st.upstream" class="text-xs opacity-50" :title="st.remoteUrl">→ {{ st.upstream }}</span>
          <span v-else-if="st.hasRemote" class="text-xs opacity-50">not pushed yet</span>
          <span v-else class="text-xs opacity-50">no remote</span>
        </template>
        <span class="flex-1" />
        <template v-if="st?.repo">
          <button class="btn btn-ghost btn-sm btn-square" title="Check the remote again" :disabled="!!busy" @click="refresh(true)"><Icon name="refresh" class="size-4" :class="{ 'animate-spin': busy === 'fetch' }" /></button>
          <button class="btn btn-sm gap-1.5" :disabled="!!busy || !st.hasRemote" title="Get your team's commits" @click="pull"><span v-if="busy === 'pull'" class="loading loading-spinner loading-xs" />Pull<span v-if="st.behind" class="badge badge-sm badge-primary">{{ st.behind }}</span></button>
          <button class="btn btn-sm gap-1.5" :disabled="!!busy || !st.hasRemote || st.merging" title="Send your commits" @click="push"><span v-if="busy === 'push'" class="loading loading-spinner loading-xs" />Push<span v-if="st.ahead" class="badge badge-sm badge-primary">{{ st.ahead }}</span></button>
        </template>
        <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" aria-label="Close" :disabled="!!busy" @click="emit('close')">✕</button>
      </div>

      <div v-if="!st" class="py-10 text-center"><span class="loading loading-dots" /></div>

      <template v-else-if="!st.repo">
        <div class="alert alert-soft text-sm" :class="st.gitMissing ? 'alert-warning' : 'alert-info'">
          <CatMood :mood="st.gitMissing ? 'warning' : 'info'" class="size-7 shrink-0 -my-0.5" />
          <span class="flex-1">{{ st.gitMissing ? st.error : 'This folder is not in a Git repository yet. Start one here, or move the workspace into a folder of an existing repository.' }}</span>
          <button v-if="!st.gitMissing" class="btn btn-sm" :disabled="!!busy" @click="init"><span v-if="busy === 'init'" class="loading loading-spinner loading-xs" />Start Git here</button>
          <button v-if="!st.gitMissing" class="btn btn-primary btn-sm" :disabled="!!busy" @click="connecting = true">Connect to a repository…</button>
        </div>
      </template>

      <template v-if="st && !st.gitMissing && (connecting || (st.repo && !st.hasRemote))">
        <div class="rounded-xl border border-base-300/70 p-3" :class="{ 'border-primary/50': connecting }">
          <div class="flex items-center gap-2">
            <CatMood :mood="connecting ? 'question' : 'info'" class="size-7 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="font-medium">{{ st.hasRemote ? 'Connect to another repository' : 'Not connected to a remote repository yet' }}</div>
              <div class="text-xs opacity-70">Connect one to Push your commits and Pull your team's. A new empty repository is fine: the first Push fills it. One that already has commits is merged with yours.</div>
            </div>
            <button v-if="!connecting" class="btn btn-primary btn-sm" :disabled="!!busy" @click="connecting = true">Connect to a repository…</button>
            <button v-else class="btn btn-ghost btn-sm" :disabled="!!busy" @click="connecting = false; target = null">Cancel</button>
          </div>
          <template v-if="connecting">
            <RepoPicker class="mt-3" :suggested-name="workspace?.name ?? ''" @pick="(url: string, label: string) => (target = url ? { url, label } : null)" />
            <div class="mt-3 flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-xs opacity-70">{{ target ? `origin → ${target.url}` : 'Pick a repository above.' }}</span>
              <button class="btn btn-primary btn-sm" :disabled="!!busy || !target" @click="connect"><span v-if="busy === 'connect'" class="loading loading-spinner loading-xs" />Connect</button>
            </div>
          </template>
        </div>
      </template>

      <template v-if="st?.repo">
        <div v-if="st.merging || st.conflicts.length" class="alert alert-warning alert-soft text-sm">
          <CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
          <span class="flex-1">
            <template v-if="st.conflicts.length">{{ st.conflicts.length }} file{{ st.conflicts.length === 1 ? '' : 's' }} changed on both sides. Open the folder, keep the right lines in each file (between &lt;&lt;&lt;&lt;&lt;&lt;&lt; and &gt;&gt;&gt;&gt;&gt;&gt;&gt;), then Commit.</template>
            <template v-else>The merge is ready: Commit to finish it.</template>
          </span>
          <button class="btn btn-ghost btn-sm" @click="api.revealFolder(workspace!.id)">Show folder</button>
          <button class="btn btn-sm" :disabled="!!busy" @click="abort"><span v-if="busy === 'abort'" class="loading loading-spinner loading-xs" />Abort merge</button>
        </div>

        <div class="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-3" :class="{ 'md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]': picked }">
          <div class="flex min-h-0 min-w-0 flex-col gap-2">
            <p class="label-caps">Changes in this workspace <span class="normal-case tracking-normal opacity-60">({{ st.changes.length }})</span></p>
            <div class="min-h-24 min-w-0 flex-1 overflow-y-auto overflow-x-hidden rounded-xl border border-base-300/70 p-1">
              <p v-if="!st.changes.length" class="px-3 py-6 text-center text-sm opacity-60">Nothing to commit.{{ st.ahead ? ` ${st.ahead} commit${st.ahead === 1 ? '' : 's'} to push.` : '' }}</p>
              <button v-for="c in st.changes" :key="c.path" class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-base-200/70" :class="{ 'bg-base-200': picked?.path === c.path }" :title="c.path" @click="pick(c)">
                <span class="w-4 shrink-0 text-center font-mono text-xs font-bold" :class="MARK[c.kind].tone" :title="MARK[c.kind].title">{{ MARK[c.kind].letter }}</span>
                <span class="min-w-0 flex-1 truncate">{{ c.label }}</span>
                <span class="hidden min-w-0 max-w-[50%] shrink truncate font-mono text-[11px] opacity-40 sm:block">{{ c.path }}</span>
              </button>
            </div>
            <textarea v-model="message" class="textarea textarea-sm h-16 w-full" placeholder="What changed? e.g. Add the order endpoints" :disabled="!!busy" @keydown.meta.enter="commit" @keydown.ctrl.enter="commit" />
            <div class="flex items-center gap-2">
              <span class="flex-1 text-xs opacity-50">Commits this workspace's files only — the rest of the repository is left as it is.</span>
              <button class="btn btn-primary btn-sm" :disabled="!!busy || !message.trim() || (!st.changes.length && !st.merging)" @click="commit"><span v-if="busy === 'commit'" class="loading loading-spinner loading-xs" />Commit{{ st.changes.length ? ` ${st.changes.length}` : '' }}</button>
            </div>
          </div>
          <div v-if="picked" class="flex min-h-0 min-w-0 flex-col gap-2">
            <div class="flex items-center gap-2">
              <p class="label-caps min-w-0 flex-1 truncate">{{ picked.label }}</p>
              <button class="btn btn-ghost btn-xs btn-square" aria-label="Close the diff" @click="picked = null">✕</button>
            </div>
            <pre class="git-diff selectable min-h-24 flex-1 overflow-auto rounded-xl border border-base-300/70"><span v-for="(l, i) in diffLines" :key="i" :class="l.kind ? `is-${l.kind}` : ''">{{ l.text || ' ' }}</span></pre>
          </div>
        </div>
        <p v-if="st.error" class="text-xs text-warning">{{ st.error }}</p>
        <p v-if="st.remoteUrl && !connecting" class="flex items-center gap-2 text-xs opacity-60">
          <span class="min-w-0 flex-1 truncate font-mono">origin: {{ st.remoteUrl }}</span>
          <a class="link shrink-0" @click="connecting = true">Change…</a>
        </p>
      </template>

      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="selectable">{{ error }}</span></div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
