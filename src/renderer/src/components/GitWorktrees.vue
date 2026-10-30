<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GitBranch, GitRepoEntry, GitStatus, GitWorktree } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import { attempt } from '../state';
const herd = window.dialcatz;

/**
 * Working trees of the repository (git worktree): the main one and the linked ones with their branch, a new one in a
 * folder the user picks (a new branch, or an existing one), remove (asking first when it has changes or commits that
 * are on no other branch) and prune. DevCatz makes each worktree a site; here they are a plain list.
 */
const props = defineProps<{ repo: GitRepoEntry; status: GitStatus }>();
const emit = defineEmits<{ changed: [] }>();
const id = computed(() => props.repo.id);

const list = ref<GitWorktree[]>([]);
const branches = ref<GitBranch[]>([]);
const loading = ref(false);
async function load() {
  loading.value = true;
  [list.value, branches.value] = await Promise.all([herd.gitWorktrees(id.value).catch(() => []), herd.gitBranches(id.value).catch(() => [])]);
  loading.value = false;
}
void load();
watch(() => [props.status.head, props.status.branch], () => void load());

/** Branches not checked out anywhere (git refuses one that is). */
const free = computed(() => branches.value.filter((b) => !b.remote && !list.value.some((w) => w.branch === b.name)));
const mode = ref<'new' | 'existing'>('new');
const name = ref('');
const from = ref('');
const existing = ref('');
watch(free, (f) => !existing.value && (existing.value = f[0]?.name ?? ''), { immediate: true });

async function add() {
  const create = mode.value === 'new';
  const branch = create ? name.value.trim() : existing.value;
  const dest = await attempt(() => herd.gitWorktreeAdd(id.value, branch, create, create ? from.value || undefined : undefined));
  if (!dest) return;
  name.value = '';
  emit('changed');
  await load();
}

const removing = ref<GitWorktree | null>(null);
const force = ref(false);
async function remove() {
  const w = removing.value!;
  removing.value = null;
  const ok = await attempt(() => herd.gitWorktreeRemove(id.value, w.path, force.value).then(() => true), `Worktree ${w.branch ?? w.path} removed`);
  // Changes in it: ask again, this time to throw them away.
  if (ok === undefined && !force.value) {
    force.value = true;
    removing.value = w;
  } else force.value = false;
  await load();
}
const prune = async () => {
  await attempt(() => herd.gitWorktreePrune(id.value).then(() => true), 'Worktree records pruned');
  await load();
};
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');
</script>

<template>
  <div class="space-y-4">
    <div class="overflow-x-auto rounded-box border border-base-300/60">
      <table class="table table-sm">
        <thead>
          <tr><th>Folder</th><th>Branch</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="w in list" :key="w.path">
            <td class="max-w-md truncate font-mono text-xs" :title="w.path">{{ short(w.path) }}</td>
            <td class="font-mono text-xs">
              {{ w.branch ?? `detached @ ${w.head?.slice(0, 7)}` }}
              <span v-if="w.main" class="badge badge-ghost badge-xs ml-1">main</span>
              <span v-if="w.locked" class="badge badge-ghost badge-xs ml-1">locked</span>
              <span v-if="w.prunable" class="badge badge-warning badge-soft badge-xs ml-1">folder gone</span>
              <span v-if="w.unpushed" class="ml-1 text-info" :title="`${w.unpushed} commit(s) on no other branch or remote`">↑{{ w.unpushed }}</span>
            </td>
            <td class="text-right whitespace-nowrap">
              <button v-if="!w.main && !w.prunable" class="btn btn-ghost btn-xs text-error" :disabled="!!repo.busy" @click="force = false; removing = w">Remove…</button>
            </td>
          </tr>
          <tr v-if="!list.length && !loading">
            <td colspan="3" class="py-5 text-center text-xs opacity-60">No working trees.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="flex items-center gap-2">
      <span class="flex-1 text-xs opacity-60">A worktree is a second folder of the same repository on another branch: work on two branches at once without stashing.</span>
      <button v-if="list.some((w) => w.prunable)" class="btn btn-ghost btn-xs" @click="prune">Prune</button>
    </div>

    <form class="card" @submit.prevent="add">
      <div class="card-body gap-2">
        <div class="font-semibold">New worktree</div>
        <div role="tablist" class="seg seg-xs self-start">
          <a role="tab" class="seg-item" :class="{ 'is-active': mode === 'new' }" @click="mode = 'new'">New branch</a>
          <a role="tab" class="seg-item" :class="{ 'is-active': mode === 'existing' }" @click="mode = 'existing'">Existing branch</a>
        </div>
        <div v-if="mode === 'new'" class="flex flex-wrap items-center gap-2">
          <input v-model="name" class="input input-sm w-56 font-mono" placeholder="feature/new-thing" spellcheck="false" />
          <select v-model="from" class="select select-sm w-48" title="Start from">
            <option value="">from {{ status.branch ?? 'HEAD' }}</option>
            <option v-for="b in branches.filter((x) => !x.current)" :key="b.name" :value="b.name">from {{ b.name }}</option>
          </select>
        </div>
        <div v-else class="flex flex-wrap items-center gap-2">
          <select v-model="existing" class="select select-sm w-56" :disabled="!free.length">
            <option v-for="b in free" :key="b.name" :value="b.name">{{ b.name }}</option>
          </select>
          <span v-if="!free.length" class="text-xs opacity-60">Every local branch is checked out already.</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="flex-1 text-xs opacity-60">You pick the folder next.</span>
          <button class="btn btn-sm" :disabled="!!repo.busy || (mode === 'new' ? !name.trim() : !existing)">Choose folder &amp; create…</button>
        </div>
      </div>
    </form>

    <ConfirmDialog
      v-if="removing"
      :title="force ? `${removing.branch ?? 'This worktree'} has changes` : `Remove the worktree ${removing.branch ?? ''}?`"
      :text="
        force
          ? 'Its uncommitted changes and new files are thrown away with the folder.'
          : `The folder ${short(removing.path)} is deleted; the branch stays.${removing.unpushed ? ` ${removing.unpushed} commit(s) are only on this branch: they stay on it.` : ''}`
      "
      :confirm="force ? 'Remove anyway' : 'Remove'"
      tone="error"
      @cancel="removing = null; force = false"
      @ok="remove"
    />
  </div>
</template>
