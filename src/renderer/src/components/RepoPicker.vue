<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { GitAccount, GitHostKind, GitRepo } from '@shared/types';
import { GIT_HOST_ICONS } from '../githosticons';
import { goSection } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
const api = window.dialcatz;

/**
 * Picks a Git repository: one of a connected account's (searchable), a new empty one made on the account, or any
 * URL. Accounts are the shared Catzoid ones (Git → Accounts). Emits the clone URL (HTTPS, or SSH when asked).
 */
const props = withDefaults(defineProps<{ allowNew?: boolean; suggestedName?: string }>(), { allowNew: true, suggestedName: '' });
const emit = defineEmits<{ pick: [url: string, label: string] }>();

const accounts = ref<GitAccount[] | null>(null);
const accountId = ref('');
const mode = ref<'list' | 'new' | 'url'>('list');
onMounted(async () => {
  accounts.value = await api.gitAccounts().catch(() => []);
  accountId.value = accounts.value[0]?.id ?? '';
  if (!accounts.value.length) mode.value = 'url';
});
const account = computed(() => accounts.value?.find((a) => a.id === accountId.value) ?? null);
const NAME: Record<GitHostKind, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket' };
const useSsh = ref(false);
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---- the account's repositories
const list = ref<GitRepo[]>([]);
const query = ref('');
const busy = ref(false);
const error = ref('');
async function load() {
  if (!accountId.value) return;
  busy.value = true;
  try {
    list.value = await api.gitRepos(accountId.value, query.value);
    error.value = '';
  } catch (e) {
    error.value = clean(e);
    list.value = [];
  }
  busy.value = false;
}
let timer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 350);
});
watch(accountId, () => mode.value !== 'url' && void load());
const picked = ref('');
function pick(r: GitRepo) {
  picked.value = r.fullName;
  emit('pick', useSsh.value && r.cloneSsh ? r.cloneSsh : r.cloneHttps, r.fullName);
}

// ---- a new repository
const newName = ref(props.suggestedName.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, ''));
const newPrivate = ref(true);
const creating = ref(false);
async function create() {
  creating.value = true;
  error.value = '';
  try {
    const r = await api.gitCreateRemoteRepo(accountId.value, newName.value.trim(), newPrivate.value, 'DialCatz workspace');
    list.value = [r, ...list.value];
    mode.value = 'list';
    pick(r);
  } catch (e) {
    error.value = clean(e);
  }
  creating.value = false;
}

// ---- any URL
const url = ref('');
watch(url, (u) => emit('pick', u.trim(), u.trim()));
</script>

<template>
  <div class="space-y-2">
    <div v-if="accounts === null" class="py-3 text-center"><span class="loading loading-dots loading-sm" /></div>
    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <div role="tablist" class="seg seg-xs">
          <a v-if="accounts.length" role="tab" class="seg-item" :class="{ 'is-active': mode === 'list' }" @click="mode = 'list'; load()">Your repositories</a>
          <a v-if="accounts.length && allowNew" role="tab" class="seg-item" :class="{ 'is-active': mode === 'new' }" @click="mode = 'new'">New repository</a>
          <a role="tab" class="seg-item" :class="{ 'is-active': mode === 'url' }" @click="mode = 'url'">URL</a>
        </div>
        <span class="flex-1" />
        <select v-if="accounts.length > 1 && mode !== 'url'" v-model="accountId" class="select select-xs w-52">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ NAME[a.kind] }} · {{ a.username }}</option>
        </select>
        <span v-else-if="account && mode !== 'url'" class="flex items-center gap-1 text-xs opacity-70">
          <svg class="size-3.5" viewBox="0 0 24 24" :style="{ color: GIT_HOST_ICONS[account.kind].color }"><path :d="GIT_HOST_ICONS[account.kind].d" fill="currentColor" /></svg>{{ account.username }}
        </span>
      </div>

      <p v-if="!accounts.length" class="text-xs opacity-70">
        No Git account is connected. Paste the repository's URL, or
        <a class="link" @click="goSection('git')">connect GitHub, GitLab, Gitea or Bitbucket</a> to pick from your repositories (connected once for every Catzoid app).
      </p>

      <template v-if="mode === 'list'">
        <div class="flex items-center gap-2">
          <label class="search-box flex-1">
            <Icon name="search" class="size-3.5 shrink-0 opacity-50" />
            <input v-model="query" type="text" placeholder="Search your repositories" spellcheck="false" />
          </label>
          <label class="flex items-center gap-1.5 text-xs" title="Use git@… (needs an SSH key on the account)"><input v-model="useSsh" type="checkbox" class="toggle toggle-xs" />SSH</label>
          <span v-if="busy" class="loading loading-spinner loading-xs" />
        </div>
        <div class="max-h-52 overflow-y-auto rounded-xl border border-base-300/70 p-1">
          <button
            v-for="r in list"
            :key="r.fullName"
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-base-200/70"
            :class="{ 'bg-primary/10': picked === r.fullName }"
            @click="pick(r)"
          >
            <span class="min-w-0 flex-1 truncate font-medium">{{ r.fullName }}</span>
            <span v-if="r.private" class="badge badge-ghost badge-xs">private</span>
            <Icon v-if="picked === r.fullName" name="check" class="size-4 text-primary" />
          </button>
          <p v-if="!list.length && !busy" class="px-3 py-4 text-center text-xs opacity-60">{{ query ? 'No repository matches.' : 'No repositories.' }}</p>
        </div>
      </template>

      <div v-else-if="mode === 'new'" class="flex flex-wrap items-center gap-2" @keydown.enter.prevent="create">
        <input v-model="newName" class="input input-sm w-60 font-mono" placeholder="repository-name" spellcheck="false" />
        <label class="flex items-center gap-1.5 text-xs"><input v-model="newPrivate" type="checkbox" class="toggle toggle-xs" />Private</label>
        <span class="flex-1" />
        <button type="button" class="btn btn-sm" :disabled="creating || !newName.trim() || !account" @click="create"><span v-if="creating" class="loading loading-spinner loading-xs" />Create on {{ account ? NAME[account.kind] : '…' }}</button>
      </div>

      <input v-else v-model="url" @keydown.enter.prevent class="input input-sm w-full font-mono" placeholder="https://github.com/you/repo.git or git@github.com:you/repo.git" spellcheck="false" />

      <div v-if="error" class="alert alert-error alert-soft py-2 text-sm"><CatMood mood="error" class="size-6 shrink-0 -my-0.5" /><span class="selectable">{{ error }}</span></div>
    </template>
  </div>
</template>
