<script setup lang="ts">
import { currentOS, words } from '@shared/platform';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { GitAccount, GitHostKind, GitRepo, GitRepoEntry, GitSshKey } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import GitCloneDialog from './GitCloneDialog.vue';
import RepoGit from './RepoGit.vue';
import Icon from './Icon.vue';
import CatMood from './CatMood.vue';
import { GIT_HOST_ICONS } from '../githosticons';
import { cloneRequest, gitState } from '../gitstate';
import { attempt, notify } from '../state';
const api = window.dialcatz;
/** Template alias (vue-tsc reads an imported binding inside template arrow functions as a ref). */
const H = api;

/**
 * Git (rail), with the features of DevCatz's Git page: the repositories (the folder workspaces' ones, folders the user
 * added, clones) each with its full Git view, the connected hosting accounts (GitHub, GitLab, Gitea / Forgejo,
 * Bitbucket, self-hosted too) with their repositories to clone, and SSH keys. Accounts are shared with the Catzoid
 * apps: one connected in DevCatz is here too, and the other way round.
 */
type View = { kind: 'repo'; id: string } | { kind: 'keys' } | { kind: 'add' } | { kind: 'account'; id: string } | { kind: 'empty' };
const view = ref<View>({ kind: 'empty' });
const repos = computed<GitRepoEntry[]>(() => gitState.value?.repos ?? []);
const accounts = computed(() => gitState.value?.accounts ?? []);
const repo = computed(() => (view.value.kind === 'repo' ? (repos.value.find((r) => r.id === (view.value as { id: string }).id) ?? null) : null));
const account = computed(() => (view.value.kind === 'account' ? (accounts.value.find((a) => a.id === (view.value as { id: string }).id) ?? null) : null));
// Something removed under the view (here or in another app): show the first repository instead.
watch([repos, accounts], () => {
  if ((view.value.kind === 'repo' && !repo.value) || (view.value.kind === 'account' && !account.value) || view.value.kind === 'empty') view.value = repos.value[0] ? { kind: 'repo', id: repos.value[0].id } : { kind: 'empty' };
});

let off: (() => void) | null = null;
const onFocus = () => void api.gitState().then((s) => (gitState.value = s));
onMounted(async () => {
  off = window.dialcatz.onGit((s) => (gitState.value = s));
  gitState.value = await api.gitWatch(true);
  gitState.value = await api.gitState();
  window.addEventListener('focus', onFocus);
});
onBeforeUnmount(() => {
  off?.();
  void api.gitWatch(false);
  window.removeEventListener('focus', onFocus);
});

const NAME: Record<GitHostKind, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea / Forgejo', bitbucket: 'Bitbucket' };
const DEFAULT_URL: Record<GitHostKind, string> = { github: 'https://github.com', gitlab: 'https://gitlab.com', gitea: 'https://codeberg.org', bitbucket: 'https://bitbucket.org' };
const host = (u: string) => u.replace(/^https?:\/\//, '');
const short = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

// ---- accounts DevCatz has that are not shared yet
const fromDevCatz = ref<GitAccount[]>([]);
const loadDevCatz = async () => (fromDevCatz.value = await api.gitDevCatzAccounts().catch(() => []));
watch(accounts, () => void loadDevCatz(), { immediate: true });
const importing = ref(false);
async function importDevCatz() {
  importing.value = true;
  const n = await attempt(() => api.gitImportDevCatz());
  importing.value = false;
  if (n) notify('success', `${n} account${n === 1 ? '' : 's'} brought over from DevCatz`);
  gitState.value = await api.gitState();
  await loadDevCatz();
}

// ---- repositories
async function addRepo() {
  const id = await attempt(() => api.gitRepoAdd());
  if (id) view.value = { kind: 'repo', id };
}
const forgetting = ref<GitRepoEntry | null>(null);
async function forget() {
  const r = forgetting.value!;
  forgetting.value = null;
  await attempt(() => api.gitRepoRemove(r.id).then(() => true), `${r.name} is off the list (its files stay)`);
}
function onCloned(id: string | null) {
  if (id) view.value = { kind: 'repo', id };
}

// ---- add account
const form = ref({ kind: 'github' as GitHostKind, baseUrl: DEFAULT_URL.github, username: '', token: '' });
watch(
  () => form.value.kind,
  (k, old) => {
    if (!form.value.baseUrl || form.value.baseUrl === DEFAULT_URL[old]) form.value.baseUrl = DEFAULT_URL[k];
  },
);
/** Where to make a token, with the scopes the Catzoid apps need. */
const tokenUrl = computed(() => {
  const b = form.value.baseUrl.replace(/\/+$/, '');
  switch (form.value.kind) {
    case 'github':
      return `${b}/settings/tokens/new?description=Catzoid&scopes=repo,read:org,admin:public_key,workflow`;
    case 'gitlab':
      return `${b}/-/user_settings/personal_access_tokens?name=Catzoid&scopes=api,read_user,write_repository`;
    case 'gitea':
      return `${b}/user/settings/applications`;
    default:
      return /bitbucket\.org/.test(b) ? 'https://id.atlassian.com/manage-profile/security/api-tokens' : `${b}/plugins/servlet/access-tokens/manage`;
  }
});
const scopes = computed(
  () =>
    ({
      github: 'Classic token with repo, read:org, admin:public_key (fine-grained: Contents, Pull requests, Metadata).',
      gitlab: 'Scopes api, read_user, write_repository.',
      gitea: 'Scopes repository (read & write), user (read & write for SSH keys).',
      bitbucket: 'Bitbucket Cloud: your username (or Atlassian email) and an API token / app password with repository and pull request access.',
    })[form.value.kind],
);
const adding = ref(false);
async function add() {
  adding.value = true;
  const a = await attempt(() => api.gitAddAccount(form.value.kind, form.value.baseUrl, form.value.token, form.value.username));
  adding.value = false;
  if (!a) return;
  notify('success', `${NAME[a.kind]} connected as ${a.username}`);
  form.value.token = '';
  gitState.value = await api.gitState();
  view.value = { kind: 'account', id: a.id };
}
const removing = ref<GitAccount | null>(null);
async function remove() {
  const a = removing.value!;
  removing.value = null;
  await attempt(() => api.gitRemoveAccount(a.id).then(() => true), `${NAME[a.kind]} account removed`);
}

// ---- an account's repositories
const hostRepos = ref<GitRepo[]>([]);
const repoQuery = ref('');
const reposBusy = ref(false);
const reposError = ref('');
async function loadRepos() {
  const a = account.value;
  if (!a) return;
  reposBusy.value = true;
  try {
    hostRepos.value = await api.gitRepos(a.id, repoQuery.value);
    reposError.value = '';
  } catch (e) {
    reposError.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    hostRepos.value = [];
  }
  reposBusy.value = false;
}
let timer: ReturnType<typeof setTimeout> | null = null;
watch(repoQuery, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loadRepos, 350);
});
watch(account, (a, b) => a && a.id !== b?.id && ((repoQuery.value = ''), void loadRepos()), { immediate: true });
const useSsh = ref(false);
function clone(r: GitRepo) {
  cloneRequest.value = { url: useSsh.value && r.cloneSsh ? r.cloneSsh : r.cloneHttps, name: r.name, branch: r.defaultBranch ?? '' };
}
/** Already cloned here: open it instead. */
const clonedAs = (r: GitRepo) => repos.value.find((x) => x.name === r.name) ?? null;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');

// ---- SSH keys
const keys = ref<GitSshKey[]>([]);
const keyEmail = ref('');
const keyTarget = ref<Record<string, string>>({});
async function loadKeys() {
  keys.value = (await api.gitSshKeys().catch(() => [])) ?? [];
}
watch(view, (v) => v.kind === 'keys' && void loadKeys(), { immediate: true });
async function generate() {
  const k = await attempt(() => api.gitSshGenerate(keyEmail.value));
  if (k) {
    notify('success', `Key created: ${k.path}`);
    await loadKeys();
  }
}
async function upload(k: GitSshKey) {
  const id = keyTarget.value[k.path] ?? accounts.value[0]?.id;
  if (!id) return;
  const a = accounts.value.find((x) => x.id === id)!;
  await attempt(() => api.gitSshAddToAccount(id, k.path, `Catzoid · ${k.comment || 'this computer'}`).then(() => true), `Key added to ${NAME[a.kind]} (${a.username})`);
}
async function copy(t: string) {
  await navigator.clipboard.writeText(t).catch(() => undefined);
  notify('info', 'Public key copied');
}

const ICON = (k: GitHostKind) => GIT_HOST_ICONS[k];
/** Avatars that failed to load show the host's mark instead. */
const broken = reactive(new Set<string>());
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="sidebar flex w-72 shrink-0 flex-col">
      <div class="drag flex shrink-0 items-center gap-1 px-4 pt-11 pb-2">
        <span class="label-caps flex-1">Repositories</span>
        <button class="btn btn-ghost btn-xs btn-square no-drag" title="Clone a repository…" aria-label="Clone a repository" @click="cloneRequest = { url: '', name: '', branch: '' }"><Icon name="download" class="size-4" /></button>
        <button class="btn btn-ghost btn-xs btn-square no-drag" title="Add a folder…" aria-label="Add a folder" @click="addRepo"><Icon name="plus" class="size-4" /></button>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap gap-0.5 overflow-y-auto px-2 pb-2">
        <li v-for="r in repos" :key="r.id">
          <a :class="{ 'menu-active': repo?.id === r.id }" :title="r.path" @click="view = { kind: 'repo', id: r.id }">
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-300/70"><svg class="size-4" viewBox="0 0 24 24" :style="{ color: GIT_HOST_ICONS.git.color }"><path :d="GIT_HOST_ICONS.git.d" fill="currentColor" /></svg></span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate font-medium">{{ r.name }}</span>
                <span v-if="r.busy" class="loading loading-spinner loading-xs shrink-0 opacity-60" />
              </div>
              <div class="flex items-center gap-1.5 truncate text-[11px] opacity-60">
                <template v-if="r.summary">
                  <span class="truncate font-mono">{{ r.summary.branch ?? 'detached' }}</span>
                  <span v-if="r.summary.changed" class="text-warning">● {{ r.summary.changed }}</span>
                  <span v-if="r.summary.ahead" class="text-info">↑{{ r.summary.ahead }}</span>
                  <span v-if="r.summary.behind" class="text-warning">↓{{ r.summary.behind }}</span>
                  <span v-if="r.summary.operation" class="text-warning">{{ r.summary.operation }}</span>
                </template>
                <span v-else>not in Git yet</span>
              </div>
            </div>
            <span v-if="r.workspaces.length" class="shrink-0 opacity-50" title="A DialCatz workspace is in it"><Icon name="requests" class="size-3.5" /></span>
          </a>
        </li>
        <li v-if="!repos.length" class="px-3 py-2 text-xs opacity-60">No repositories yet. Clone one, or add a folder.</li>

        <li class="menu-title mt-3 px-2"><span class="label-caps">Accounts</span></li>
        <li v-for="a in accounts" :key="a.id">
          <a :class="{ 'menu-active': account?.id === a.id }" @click="view = { kind: 'account', id: a.id }">
            <img v-if="a.avatarUrl && !broken.has(a.id)" :src="a.avatarUrl" alt="" class="size-7 shrink-0 rounded-full bg-base-300/70" draggable="false" @error="broken.add(a.id)" />
            <span v-else class="grid size-7 shrink-0 place-items-center rounded-full bg-base-300/70"><svg class="size-4" viewBox="0 0 24 24" :style="{ color: ICON(a.kind).color }"><path :d="ICON(a.kind).d" fill="currentColor" /></svg></span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ a.username }}</div>
              <div class="flex items-center gap-1 truncate text-[11px] opacity-60">
                <svg class="size-3 shrink-0" viewBox="0 0 24 24" :style="{ color: ICON(a.kind).color }"><path :d="ICON(a.kind).d" fill="currentColor" /></svg>{{ host(a.baseUrl) }}
              </div>
            </div>
          </a>
        </li>
        <li v-if="fromDevCatz.length" class="mx-1 my-1 rounded-xl border border-dashed border-base-content/20 p-2.5 text-xs">
          <div class="block p-0 hover:bg-transparent">
            <div class="font-medium">In DevCatz: {{ fromDevCatz.map((a) => `${a.username} (${NAME[a.kind].split(' ')[0]})`).join(', ') }}</div>
            <p class="mt-1 opacity-70">Bring {{ fromDevCatz.length === 1 ? 'it' : 'them' }} over once: macOS asks to let DialCatz read DevCatz's key. After that every Catzoid app shares {{ fromDevCatz.length === 1 ? 'it' : 'them' }}.</p>
            <button class="btn btn-primary btn-xs mt-2" :disabled="importing" @click="importDevCatz"><span v-if="importing" class="loading loading-spinner loading-xs" />Bring over</button>
          </div>
        </li>
        <li>
          <a :class="{ 'menu-active': view.kind === 'add' }" @click="view = { kind: 'add' }">
            <span class="grid size-7 shrink-0 place-items-center rounded-full border border-dashed border-base-content/30 text-base">+</span>
            <span class="opacity-80">Connect an account</span>
          </a>
        </li>
        <li class="menu-title mt-3 px-2"><span class="label-caps">This computer</span></li>
        <li>
          <a :class="{ 'menu-active': view.kind === 'keys' }" @click="view = { kind: 'keys' }">
            <span class="grid size-7 shrink-0 place-items-center rounded-lg bg-base-300/70 font-mono text-[10px] font-bold">SSH</span>
            <div class="min-w-0 flex-1">
              <div class="font-medium">SSH keys</div>
              <div class="text-[11px] opacity-60">~/.ssh</div>
            </div>
          </a>
        </li>
      </ul>
      <div class="border-t border-base-300/60 px-4 py-3 text-xs opacity-60">
        <template v-if="gitState?.version">git {{ gitState.version }} · your own config and credentials. Accounts are shared with the Catzoid apps.</template>
        <span v-else-if="gitState" class="text-warning">git is missing: {{ words.installGit }}</span>
      </div>
    </aside>

    <section class="flex min-w-0 flex-1 flex-col">
      <!-- A repository -->
      <template v-if="repo">
        <header class="drag flex items-center gap-3 border-b border-base-300/60 px-6 pt-11 pb-4">
          <span class="grid size-9 shrink-0 place-items-center rounded-xl" style="color: var(--c-git); background: color-mix(in oklch, var(--c-git) 16%, transparent)"><Icon name="git" class="size-5" /></span>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-lg font-semibold tracking-tight">{{ repo.name }}</h1>
            <div class="truncate font-mono text-xs opacity-60" :title="repo.path">{{ short(repo.path) }}</div>
          </div>
          <button class="btn btn-ghost btn-sm no-drag gap-1.5" :title="`Show in ${words.fileManager}`" @click="H.gitRevealRepo(repo.id)"><Icon name="folder" class="size-4" />Show folder</button>
          <button v-if="repo.added" class="btn btn-ghost btn-sm no-drag" title="Take it off this list (its files stay)" @click="forgetting = repo">Remove…</button>
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <RepoGit :repo="repo" @accounts="view = { kind: 'add' }" />
        </div>
      </template>

      <!-- No repository yet -->
      <template v-else-if="view.kind === 'empty'">
        <header class="drag border-b border-base-300/60 px-6 pt-11 pb-4"><h1 class="text-lg font-semibold tracking-tight">Git</h1></header>
        <div class="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <CatMood mood="info" class="size-20" />
          <div class="text-base font-semibold">No repositories yet</div>
          <p class="text-sm opacity-70">
            Clone one from a connected account (GitHub, GitLab, Gitea, Bitbucket) or by its URL, or add a folder that is already a repository. A folder workspace's repository shows up here on its own.
          </p>
          <div class="flex gap-2">
            <button class="btn btn-primary btn-sm" @click="cloneRequest = { url: '', name: '', branch: '' }">Clone a repository…</button>
            <button class="btn btn-sm" @click="addRepo">Add a folder…</button>
          </div>
          <button v-if="!accounts.length" class="btn btn-ghost btn-sm" @click="view = { kind: 'add' }">Connect an account</button>
        </div>
      </template>

      <!-- SSH keys -->
      <template v-else-if="view.kind === 'keys'">
        <header class="drag border-b border-base-300/60 px-6 pt-11 pb-4">
          <h1 class="text-lg font-semibold tracking-tight">SSH keys</h1>
          <div class="text-xs opacity-60">Keys in ~/.ssh, used for git@… remotes. Add one to an account so pushes over SSH work.</div>
        </header>
        <div class="flex-1 space-y-4 overflow-y-auto p-6">
          <div v-for="k in keys" :key="k.path" class="card">
            <div class="card-body gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="badge badge-ghost badge-sm font-mono">{{ k.type }}</span>
                <span class="font-medium">{{ k.comment || '(no comment)' }}</span>
                <span class="flex-1 truncate font-mono text-xs opacity-60">{{ k.path }}</span>
                <button class="btn btn-ghost btn-xs" @click="copy(k.publicKey)">Copy public key</button>
              </div>
              <div class="font-mono text-[11px] opacity-60">{{ k.fingerprint }}</div>
              <div v-if="accounts.length" class="flex items-center gap-2">
                <select v-model="keyTarget[k.path]" class="select select-xs w-56">
                  <option v-for="a in accounts" :key="a.id" :value="a.id">{{ NAME[a.kind] }} · {{ a.username }}</option>
                </select>
                <button class="btn btn-xs" @click="upload(k)">Add to account</button>
              </div>
            </div>
          </div>
          <p v-if="!keys.length" class="text-sm opacity-70">No SSH key yet.</p>
          <form class="card" @submit.prevent="generate">
            <div class="card-body gap-2">
              <div class="font-semibold">New key</div>
              <p class="text-xs opacity-70">
                ed25519 without a passphrase: <code>~/.ssh/id_ed25519</code> when free (ssh uses it by default), else <code>id_ed25519_dialcatz</code> (add an
                <code>IdentityFile</code> line to ~/.ssh/config for it).
              </p>
              <div class="flex gap-2">
                <input v-model="keyEmail" class="input input-sm w-72" placeholder="you@example.com (key comment)" />
                <button class="btn btn-sm">Generate</button>
              </div>
            </div>
          </form>
        </div>
      </template>

      <!-- Add account -->
      <template v-else-if="view.kind === 'add'">
        <header class="drag border-b border-base-300/60 px-6 pt-11 pb-4">
          <h1 class="text-lg font-semibold tracking-tight">Connect an account</h1>
          <div class="text-xs opacity-60">
            For repositories to clone, pull requests and SSH keys. Shared with the Catzoid apps; the token is kept in your {{ currentOS === 'mac' ? 'macOS Keychain' : words.secretStore }}.
          </div>
        </header>
        <form class="mx-auto w-full max-w-xl flex-1 space-y-4 overflow-y-auto p-6" @submit.prevent="add">
          <div class="grid grid-cols-4 gap-2">
            <button
              v-for="k in ['github', 'gitlab', 'gitea', 'bitbucket'] as GitHostKind[]"
              :key="k"
              type="button"
              class="flex flex-col items-center gap-1.5 rounded-box border p-3 text-xs"
              :class="form.kind === k ? 'border-[var(--c-git)] bg-[var(--c-git)]/10' : 'border-base-300/60'"
              @click="form.kind = k"
            >
              <svg class="size-6" viewBox="0 0 24 24" :style="{ color: ICON(k).color }"><path :d="ICON(k).d" fill="currentColor" /></svg>
              {{ NAME[k] }}
            </button>
          </div>
          <label class="block">
            <span class="label-caps mb-1 block">Server</span>
            <input v-model="form.baseUrl" class="input input-sm w-full font-mono" spellcheck="false" />
            <span class="mt-1 block text-xs opacity-60">Change it for a self-hosted {{ NAME[form.kind] }} (e.g. https://git.company.com).</span>
          </label>
          <label v-if="form.kind === 'bitbucket'" class="block">
            <span class="label-caps mb-1 block">Username</span>
            <input v-model="form.username" class="input input-sm w-full" spellcheck="false" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Personal access token</span>
            <input v-model="form.token" type="password" class="input input-sm w-full font-mono" autocomplete="off" spellcheck="false" />
            <span class="mt-1 block text-xs opacity-60">{{ scopes }} <a class="link" @click="H.openUrl(tokenUrl)">Create one ↗</a></span>
          </label>
          <button class="btn btn-primary btn-sm" :disabled="adding || !form.token.trim()"><span v-if="adding" class="loading loading-spinner loading-xs" />Connect</button>
        </form>
      </template>

      <!-- Account -->
      <template v-else-if="account">
        <header class="drag border-b border-base-300/60 px-6 pt-11 pb-4">
          <div class="flex items-center gap-3">
            <img v-if="account.avatarUrl && !broken.has(account.id)" :src="account.avatarUrl" alt="" class="size-11 rounded-full bg-base-300/70" draggable="false" @error="broken.add(account.id)" />
            <span v-else class="grid size-11 place-items-center rounded-full bg-base-300/70"><svg class="size-6" viewBox="0 0 24 24" :style="{ color: ICON(account.kind).color }"><path :d="ICON(account.kind).d" fill="currentColor" /></svg></span>
            <div class="min-w-0 flex-1">
              <h1 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <svg class="size-5" viewBox="0 0 24 24" :style="{ color: ICON(account.kind).color }"><path :d="ICON(account.kind).d" fill="currentColor" /></svg>
                {{ account.name || account.username }}
              </h1>
              <div class="text-xs opacity-60">@{{ account.username }} · {{ host(account.baseUrl) }}</div>
            </div>
            <button class="btn btn-sm no-drag" @click="H.openUrl(account.baseUrl)">Open {{ NAME[account.kind].split(' ')[0] }}</button>
            <button class="btn btn-ghost btn-sm text-error no-drag" @click="removing = account">Remove…</button>
          </div>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-6">
          <div class="flex items-center gap-2">
            <label class="search-box flex-1">
              <Icon name="search" class="size-3.5 shrink-0 opacity-50" />
              <input v-model="repoQuery" type="text" placeholder="Search your repositories" spellcheck="false" />
            </label>
            <label class="flex items-center gap-1.5 text-xs" title="Clone with git@… (needs an SSH key on the account)"><input v-model="useSsh" type="checkbox" class="toggle toggle-xs" />SSH</label>
            <span v-if="reposBusy" class="loading loading-spinner loading-xs" />
          </div>
          <div v-if="reposError" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ reposError }}</div>
          <div class="overflow-x-auto rounded-box border border-base-300/60">
            <table class="table table-sm">
              <tbody>
                <tr v-for="r in hostRepos" :key="r.fullName">
                  <td>
                    <div class="flex items-center gap-2">
                      <a class="link link-hover font-medium" @click="H.openUrl(r.webUrl)">{{ r.fullName }}</a>
                      <span v-if="r.private" class="badge badge-ghost badge-xs">private</span>
                      <span v-if="r.fork" class="badge badge-ghost badge-xs">fork</span>
                    </div>
                    <div v-if="r.description" class="max-w-xl truncate text-xs opacity-60">{{ r.description }}</div>
                  </td>
                  <td class="text-right text-xs whitespace-nowrap opacity-60">{{ when(r.updatedAt) }}</td>
                  <td class="text-right whitespace-nowrap">
                    <button v-if="clonedAs(r)" class="btn btn-ghost btn-sm" title="Already on this computer" @click="view = { kind: 'repo', id: clonedAs(r)!.id }">Open</button>
                    <button class="btn btn-sm" @click="clone(r)">Clone…</button>
                  </td>
                </tr>
                <tr v-if="!hostRepos.length && !reposBusy">
                  <td colspan="3" class="py-5 text-center text-xs opacity-60">{{ repoQuery ? 'No repository matches.' : 'No repositories.' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </section>

    <GitCloneDialog v-if="cloneRequest" v-bind="cloneRequest" @close="cloneRequest = null" @cloned="onCloned" />
    <ConfirmDialog
      v-if="removing"
      :title="`Remove ${NAME[removing.kind]} account ${removing.username}?`"
      text="It is removed from every Catzoid app on this computer, and its token from the Keychain. Repositories stay; revoke the token on the host too if you no longer need it."
      confirm="Remove"
      tone="error"
      @cancel="removing = null"
      @ok="remove"
    />
    <ConfirmDialog
      v-if="forgetting"
      :title="`Take ${forgetting.name} off the list?`"
      text="Only from this list: the folder and its files stay as they are. Add it again any time."
      confirm="Remove"
      @cancel="forgetting = null"
      @ok="forget"
    />
  </div>
</template>
