<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DevCatzSite, PostmanChoice, PostmanPick, PostmanSummary, Workspace } from '@shared/types';
import { notify, syncTabsWithWorkspace, workspace } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
import devcatzLogo from '../assets/logos/devcatz.svg';

/**
 * Bringing requests in: a file or pasted text (Postman collection, OpenAPI / Swagger in JSON or YAML, DialCatz
 * export, cURL); everything from Postman at once (its data export); or a DevCatz site (an environment for it and
 * its routes as a collection). It opens on a choice (File or paste, From DevCatz, and Postman less prominent) and
 * shows the form once one is picked; a link from DevCatz or the Postman shortcut opens its form straight away.
 */
const props = withDefaults(defineProps<{ tab?: 'choose' | 'file' | 'postman' | 'devcatz'; siteId?: string }>(), { tab: 'choose', siteId: '' });
const emit = defineEmits<{ done: [collectionId: string | null]; cancel: [] }>();
const api = window.dialcatz;
const mode = ref(props.tab);
function pickMode(m: 'choose' | 'file' | 'postman' | 'devcatz') {
  mode.value = m;
  error.value = '';
}
const text = ref('');
const busy = ref(false);
const error = ref('');
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function use(w: Workspace) {
  workspace.value = w;
  syncTabsWithWorkspace(w);
}
async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  error.value = '';
  try {
    return await fn();
  } catch (e) {
    error.value = clean(e);
    return undefined;
  } finally {
    busy.value = false;
  }
}

// ---------------------------------------------------------------- file / paste

async function finish(r: { workspace: Workspace; collectionId: string; count: number } | null | undefined) {
  if (!r) return;
  use(r.workspace);
  notify('success', `Imported ${r.count} request${r.count === 1 ? '' : 's'}`);
  emit('done', r.collectionId);
}
const fromFile = () => guard(async () => finish(await api.importFile(workspace.value!.id)));
const fromText = () => guard(async () => finish(await api.importText(workspace.value!.id, text.value)));

// ---------------------------------------------------------------- Postman

const summary = ref<PostmanSummary | null>(null);
async function migrate(how: 'files' | 'folder') {
  const r = await guard(() => api.postmanReadExport(how));
  if (r) choose(r);
}
const TITLES = { choose: 'Import', file: 'Import a file or text', postman: 'Move from Postman', devcatz: 'Import from DevCatz' } as const;
/** Postman's mark (Simple Icons, CC0), drawn in the text colour: a pointer, not a coloured logo. */
const POSTMAN_MARK = 'M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.485a.855.855 0 0 0-.593.25l-4.453 4.453-.307-.307-.643-.643c4.389-4.376 5.18-4.418 5.996-3.753zm-4.863 4.861l4.44-4.44a.62.62 0 1 1 .847.903l-4.699 4.125-.588-.588zm.33.694l-1.1.238a.06.06 0 0 1-.067-.032.06.06 0 0 1 .01-.073l.645-.645.512.512zm-2.803-.459l1.172-1.172.879.878-1.979.426a.074.074 0 0 1-.085-.039.072.072 0 0 1 .013-.093zm-3.646 6.058a.076.076 0 0 1-.069-.083.077.077 0 0 1 .022-.046h.002l.946-.946 1.222 1.222-2.123-.147zm2.425-1.256a.228.228 0 0 0-.117.256l.203.865a.125.125 0 0 1-.211.117h-.003l-.934-.934-.294-.295 3.762-3.758 1.82-.393.874.874c-1.255 1.102-2.971 2.201-5.1 3.268zm5.279-3.428h-.002l-.839-.839 4.699-4.125a.952.952 0 0 0 .119-.127c-.148 1.345-2.029 3.245-3.977 5.091zm3.657-6.46l-.003-.002a1.822 1.822 0 0 1 2.459-2.684l-1.61 1.613a.119.119 0 0 0 0 .169l1.247 1.247a1.817 1.817 0 0 1-2.093-.343zm2.578 0a1.714 1.714 0 0 1-.271.218h-.001l-1.207-1.207 1.533-1.533c.661.72.637 1.832-.054 2.522zM18.855 6.05a.143.143 0 0 0-.053.157.416.416 0 0 1-.053.45.14.14 0 0 0 .023.197.141.141 0 0 0 .084.03.14.14 0 0 0 .106-.05.691.691 0 0 0 .087-.751.138.138 0 0 0-.194-.033z';
/** Moving from Postman: its export file, or the user's own Postman API key (nothing to wait for). */
const pmHow = ref<'export' | 'key'>('key');
const pmKey = ref('');
const pmUser = ref('');
const pmWorkspaces = ref<{ id: string; name: string; type: string }[] | null>(null);
const pmPicked = ref<string[]>([]);
const pmProgress = ref<{ done: number; total: number; label: string } | null>(null);
async function pmConnect() {
  const r = await guard(() => api.postmanWorkspaces(pmKey.value));
  if (!r) return;
  pmUser.value = r.user;
  pmWorkspaces.value = r.workspaces;
  pmPicked.value = r.workspaces.map((w) => w.id);
}
/** API key: the chosen workspaces' collections and environments, to pick from. */
async function pmNext() {
  const r = await guard(() => api.postmanContents(pmKey.value, [...pmPicked.value]));
  if (r) choose(r);
}
function pmToggle(id: string) {
  pmPicked.value = pmPicked.value.includes(id) ? pmPicked.value.filter((x) => x !== id) : [...pmPicked.value, id];
}

// Picking what to bring over (export and API key alike): every collection and environment, checked to start with.
type PmGroup = PostmanChoice['groups'][number];
const pmChoice = ref<PostmanChoice | null>(null);
const pmSel = ref<Record<string, boolean>>({});
const pmGlobals = ref(true);
const pmFilter = ref('');
const cKey = (id: string) => `c:${id}`;
const eKey = (id: string) => `e:${id}`;
const keysOf = (g: PmGroup) => [...g.collections.map((c) => cKey(c.id)), ...g.environments.map((e) => eKey(e.id))];
function choose(c: PostmanChoice) {
  pmChoice.value = c;
  pmSel.value = Object.fromEntries(c.groups.flatMap(keysOf).map((k) => [k, true]));
  pmGlobals.value = c.globals;
  pmFilter.value = '';
}
const pmTotals = computed(() => ({ c: pmChoice.value?.groups.reduce((n, g) => n + g.collections.length, 0) ?? 0, e: pmChoice.value?.groups.reduce((n, g) => n + g.environments.length, 0) ?? 0 }));
const pmPick = computed<PostmanPick>(() => ({
  collections: pmChoice.value?.groups.flatMap((g) => g.collections.filter((c) => pmSel.value[cKey(c.id)]).map((c) => c.id)) ?? [],
  environments: pmChoice.value?.groups.flatMap((g) => g.environments.filter((e) => pmSel.value[eKey(e.id)]).map((e) => e.id)) ?? [],
  globals: !!pmChoice.value?.globals && pmGlobals.value,
}));
const pmNothing = computed(() => !pmPick.value.collections.length && !pmPick.value.environments.length && !pmPick.value.globals);
/** The groups with only what matches the search. */
const pmShown = computed<PmGroup[]>(() => {
  const q = pmFilter.value.trim().toLowerCase();
  const groups = pmChoice.value?.groups ?? [];
  if (!q) return groups.filter((g) => g.collections.length || g.environments.length);
  const hit = (n: string) => n.toLowerCase().includes(q);
  return groups
    .map((g) => (hit(g.name) ? g : { ...g, collections: g.collections.filter((c) => hit(c.name)), environments: g.environments.filter((e) => hit(e.name)) }))
    .filter((g) => g.collections.length || g.environments.length);
});
const shownKeys = computed(() => pmShown.value.flatMap(keysOf));
/** The list in two sections, collections then environments, each by Postman workspace. */
const pmSections = computed(() =>
  (['c', 'e'] as const)
    .map((kind) => ({
      kind,
      label: kind === 'c' ? 'Collections' : 'Environments',
      icon: kind === 'c' ? ('collection' as const) : ('environments' as const),
      total: kind === 'c' ? pmTotals.value.c : pmTotals.value.e,
      groups: pmShown.value
        .map((g) => ({
          name: g.name,
          items: kind === 'c' ? g.collections.map((c) => ({ key: cKey(c.id), name: c.name, note: c.requests === undefined ? '' : plural(c.requests, 'request') })) : g.environments.map((e) => ({ key: eKey(e.id), name: e.name, note: '' })),
        }))
        .filter((g) => g.items.length),
    }))
    .filter((sec) => sec.groups.length),
);
const keysIn = (groups: { items: { key: string }[] }[]) => groups.flatMap((g) => g.items.map((i) => i.key));
const stateOf = (keys: string[]) => {
  const on = keys.filter((k) => pmSel.value[k]).length;
  return on === 0 ? 'none' : on === keys.length ? 'all' : 'some';
};
const onIn = (keys: string[]) => keys.filter((k) => pmSel.value[k]).length;
function setKeys(keys: string[], on: boolean) {
  pmSel.value = { ...pmSel.value, ...Object.fromEntries(keys.map((k) => [k, on])) };
}
const allShownOn = computed(() => shownKeys.value.length > 0 && shownKeys.value.every((k) => pmSel.value[k]));
function pmBack() {
  pmChoice.value = null;
  error.value = '';
}
async function pmImport() {
  const pick: PostmanPick = { collections: [...pmPick.value.collections], environments: [...pmPick.value.environments], globals: pmPick.value.globals };
  let r: { workspace: Workspace; summary: PostmanSummary } | undefined;
  if (pmChoice.value!.token) {
    r = await guard(() => api.migratePostman(workspace.value!.id, pmChoice.value!.token, pick));
  } else {
    pmProgress.value = { done: 0, total: 0, label: 'Reading the workspaces…' };
    const off = api.onPostmanProgress((p) => (pmProgress.value = p));
    r = await guard(() => api.migratePostmanApi(workspace.value!.id, pmKey.value, [...pmPicked.value], pick));
    off();
    pmProgress.value = null;
    if (r) pmKey.value = '';
  }
  if (!r) return;
  use(r.workspace);
  summary.value = r.summary;
  pmChoice.value = null;
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const totalRequests = computed(() => summary.value?.collections.reduce((n, c) => n + c.requests, 0) ?? 0);

// ---------------------------------------------------------------- DevCatz

const devcatz = ref<{ installed: boolean; sites: DevCatzSite[] } | null>(null);
const siteId = ref(props.siteId);
const withEnv = ref(true);
const withEnvVars = ref(false);
const withRoutes = ref(true);
const site = computed(() => devcatz.value?.sites.find((s) => s.id === siteId.value) ?? null);
// A site with more than one app (monorepo: web + api …) picks which one requests go to; the API app by default.
const apps = computed(() => site.value?.apps.filter((a) => a.kind !== 'assets') ?? []);
const appDir = ref('');
watch(site, () => (appDir.value = (apps.value.find((a) => a.kind === 'api' && a.url) ?? apps.value.find((a) => a.url))?.dir ?? ''), { immediate: true });
const app = computed(() => apps.value.find((a) => a.dir === appDir.value) ?? null);
const base = computed(() => (app.value?.url ?? site.value?.url ?? '').replace(/\/+$/, ''));
const specs = computed(() => (site.value?.openapi ?? []).filter((o) => !app.value || o.app === app.value.dir));
const isLaravel = computed(() => (app.value ? app.value.framework === 'laravel' : site.value?.framework === 'laravel'));
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
/**
 * "Get DevCatz" when it is not installed: the Catzoid site's download link for this computer,
 * `<shared site address>/download/devcatz/<platform>` (mac-arm64 / mac-x64 / win-x64; the site redirects to the
 * newest installer).
 */
const devcatzPage = ref('https://catzoid.com/download/devcatz/mac-arm64');
const platformSlug = (platform: string, arch: string) => (platform === 'win32' ? 'win-x64' : arch === 'x64' ? 'mac-x64' : 'mac-arm64');
const notInstalled = computed(() => devcatz.value !== null && !devcatz.value.installed);
onMounted(async () => {
  void api.appInfo().then((i) => (devcatzPage.value = `${i.site}/download/devcatz/${platformSlug(i.platform, i.arch)}`)).catch(() => {});
  devcatz.value = await api.devcatzSites();
  if (!siteId.value) siteId.value = devcatz.value.sites[0]?.id ?? '';
});
const FW: Record<DevCatzSite['framework'], string> = { laravel: 'Laravel', nestjs: 'NestJS', node: 'Node', web: 'Web app', go: 'Go', python: 'Python', other: 'Other' };
async function importSite() {
  const r = await guard(() => api.devcatzImport(workspace.value!.id, siteId.value, { environment: withEnv.value, envVars: withEnv.value && withEnvVars.value, routes: withRoutes.value, app: app.value?.dir }));
  if (!r) return;
  use(r.workspace);
  notify('success', [withEnv.value ? `Environment “DevCatz · ${site.value?.name}”` : '', r.collectionId ? `${r.requests} route(s) from ${r.source}` : ''].filter(Boolean).join(' and ') + ' added');
  emit('done', r.collectionId);
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <div class="modal-box w-[46rem] max-w-[95vw] space-y-4">
      <div class="flex items-center gap-2">
        <button v-if="mode !== 'choose' && !summary" class="btn btn-ghost btn-sm btn-square -ml-2" title="Other ways to import" aria-label="Other ways to import" :disabled="busy" @click="pickMode('choose')"><Icon name="chevron" class="size-4 rotate-180" /></button>
        <h3 class="flex-1 text-lg font-semibold tracking-tight">{{ TITLES[mode] }}<span class="font-normal opacity-50"> · {{ workspace?.name }}</span></h3>
      </div>

      <!-- The choice -->
      <template v-if="mode === 'choose'">
        <div class="grid grid-cols-2 gap-3">
          <button class="import-choice" @click="pickMode('file')">
            <span class="import-choice-icon"><Icon name="file" class="size-7" /></span>
            <span class="font-semibold">File or paste</span>
            <span class="text-xs opacity-60">Postman collection, OpenAPI / Swagger, a DialCatz export or a cURL command</span>
          </button>
          <button class="import-choice" @click="pickMode('devcatz')">
            <img :src="devcatzLogo" alt="" class="size-12" draggable="false" />
            <span class="flex items-center gap-1.5 font-semibold">From DevCatz<span v-if="notInstalled" class="badge badge-ghost badge-xs font-normal">not installed</span></span>
            <span class="text-xs opacity-60">A local site's environment and its routes, ready to send</span>
          </button>
        </div>
        <div>
          <button class="import-postman" @click="pickMode('postman')">
            <svg viewBox="0 0 24 24" class="size-5 shrink-0" fill="currentColor" aria-hidden="true"><path :d="POSTMAN_MARK" /></svg>
            <span class="flex-1 text-left"><span class="font-medium">Move everything from Postman</span><span class="block text-xs opacity-60">Collections, environments and globals, picked one by one — from an export or with your Postman API key</span></span>
            <Icon name="chevron" class="size-4 opacity-50" />
          </button>
        </div>
      </template>

      <!-- File or paste -->
      <template v-else-if="mode === 'file'">
        <p class="text-sm opacity-70">Postman collections (v2 / v2.1), OpenAPI 3 or Swagger 2 (JSON or YAML), DialCatz exports, or a single cURL command. It becomes a new collection.</p>
        <button class="btn btn-sm gap-2" :disabled="busy" @click="fromFile"><Icon name="file" class="size-4" />Choose a file…</button>
        <div class="divider my-0 text-xs opacity-50">or paste</div>
        <textarea v-model="text" class="textarea selectable h-44 w-full font-mono text-xs" placeholder="{ &quot;info&quot;: …, &quot;item&quot;: [ … ] }   openapi: 3.0.0 …   curl https://api.example.com/users" spellcheck="false" />
      </template>

      <!-- Postman -->
      <template v-else-if="mode === 'postman'">
        <template v-if="!summary && pmChoice">
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span class="flex-1">
              Choose what to bring over:
              <b>{{ pmPick.collections.length }}</b> of {{ plural(pmTotals.c, 'collection') }}<template v-if="pmTotals.e">, <b>{{ pmPick.environments.length }}</b> of {{ plural(pmTotals.e, 'environment') }}</template>
            </span>
            <button class="btn btn-ghost btn-xs" :disabled="busy || !shownKeys.length" @click="setKeys(shownKeys, !allShownOn)">{{ allShownOn ? 'None' : 'All' }}</button>
          </div>
          <input v-if="pmTotals.c + pmTotals.e > 8" v-model="pmFilter" type="search" class="input input-sm w-full" placeholder="Find a collection, environment or workspace" :disabled="busy" />
          <div class="grid gap-3" :class="{ 'sm:grid-cols-2': pmSections.length > 1 }">
            <p v-if="!pmShown.length" class="rounded-xl border border-base-300/70 px-3 py-4 text-sm opacity-60">{{ pmFilter.trim() ? 'Nothing matches.' : 'There is nothing in there.' }}</p>
            <section v-for="sec in pmSections" :key="sec.kind" class="h-80 overflow-auto rounded-xl border border-base-300/70 p-1.5">
              <label class="sticky top-0 z-10 flex cursor-pointer items-center gap-2.5 rounded-lg bg-base-200 px-2 py-1.5 text-sm">
                <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" :checked="stateOf(keysIn(sec.groups)) === 'all'" :indeterminate="stateOf(keysIn(sec.groups)) === 'some'" :disabled="busy" @change="setKeys(keysIn(sec.groups), ($event.target as HTMLInputElement).checked)" />
                <Icon :name="sec.icon" class="size-4 shrink-0 opacity-70" />
                <span class="flex-1 font-semibold">{{ sec.label }}</span>
                <span class="text-xs tabular-nums opacity-60">{{ onIn(keysIn(sec.groups)) }} of {{ keysIn(sec.groups).length }}</span>
              </label>
              <div v-for="(g, gi) in sec.groups" :key="gi" class="mt-1">
                <label v-if="pmChoice.groups.length > 1" class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 pb-0.5 pt-1.5 hover:bg-base-200/70">
                  <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="stateOf(keysIn([g])) === 'all'" :indeterminate="stateOf(keysIn([g])) === 'some'" :disabled="busy" @change="setKeys(keysIn([g]), ($event.target as HTMLInputElement).checked)" />
                  <span class="label-caps flex-1 truncate">{{ g.name }}</span>
                  <span class="text-xs tabular-nums opacity-50">{{ onIn(keysIn([g])) }} / {{ g.items.length }}</span>
                </label>
                <div :class="{ 'pl-5': pmChoice.groups.length > 1 }">
                  <label v-for="it in g.items" :key="it.key" class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-sm hover:bg-base-200/70">
                    <input v-model="pmSel[it.key]" type="checkbox" class="checkbox checkbox-sm checkbox-primary" :disabled="busy" />
                    <span class="flex-1 truncate">{{ it.name }}</span>
                    <span v-if="it.note" class="text-xs opacity-50">{{ it.note }}</span>
                  </label>
                </div>
              </div>
            </section>
          </div>
          <label v-if="pmChoice.globals" class="flex cursor-pointer items-center gap-2.5 px-2 text-sm">
            <input v-model="pmGlobals" type="checkbox" class="checkbox checkbox-sm checkbox-primary" :disabled="busy" />
            <span>Globals too <span class="opacity-50">— added to this workspace's globals</span></span>
          </label>
          <details v-if="pmChoice.skipped.length" class="text-xs opacity-70"><summary>{{ plural(pmChoice.skipped.length, 'file') }} skipped</summary><p v-for="f in pmChoice.skipped" :key="f" class="font-mono">{{ f }}</p></details>
          <div v-if="pmProgress" class="space-y-1">
            <progress class="progress progress-primary w-full" :value="pmProgress.total ? pmProgress.done : undefined" :max="pmProgress.total || 1" />
            <p class="truncate text-xs opacity-60">{{ pmProgress.total ? `${pmProgress.done} of ${pmProgress.total} · ` : '' }}{{ pmProgress.label }}</p>
          </div>
        </template>
        <template v-else-if="!summary">
          <p class="text-sm opacity-70">Bring your collections, environments and globals over — you choose which ones. Choose how:</p>
          <div class="grid grid-cols-2 gap-3" role="radiogroup" aria-label="How">
            <button type="button" role="radio" class="pm-how" :class="{ 'is-on': pmHow === 'key' }" :aria-checked="pmHow === 'key'" :disabled="busy" @click="((pmHow = 'key'), (error = ''))">
              <span class="pm-how-icon"><Icon name="lock" class="size-4" /></span>
              <span class="min-w-0 flex-1 text-left">
                <span class="flex items-center gap-1.5 font-medium">With an API key<span class="badge badge-soft badge-primary badge-xs">No waiting</span></span>
                <span class="block text-xs opacity-60">Straight from your Postman account</span>
              </span>
            </button>
            <button type="button" role="radio" class="pm-how" :class="{ 'is-on': pmHow === 'export' }" :aria-checked="pmHow === 'export'" :disabled="busy" @click="((pmHow = 'export'), (error = ''))">
              <span class="pm-how-icon"><Icon name="file" class="size-4" /></span>
              <span class="min-w-0 flex-1 text-left">
                <span class="block font-medium">From an export file</span>
                <span class="block text-xs opacity-60">Postman's data export zip, or JSON files</span>
              </span>
            </button>
          </div>
          <template v-if="pmHow === 'export'">
            <ol class="list-decimal space-y-1 pl-5 text-sm opacity-80">
              <li>In Postman: <b>Settings → Account → Export data</b>, pick collections and environments, and wait for the email with the zip.</li>
              <li>Choose that zip here (or the unzipped folder, or collection / environment JSON files you exported one by one), then tick what to bring over.</li>
            </ol>
            <div class="flex gap-2">
              <button class="btn btn-primary btn-sm gap-2" :disabled="busy" @click="migrate('files')"><span v-if="busy" class="loading loading-spinner loading-xs" /><Icon name="file" class="size-4" />Choose the zip or JSON files…</button>
              <button class="btn btn-sm gap-2" :disabled="busy" @click="migrate('folder')">Choose a folder…</button>
            </div>
          </template>
          <template v-else>
            <ol class="list-decimal space-y-1 pl-5 text-sm opacity-80">
              <li>In Postman: your avatar → <b>Settings → API keys → Generate API key</b> (name it “DialCatz”), and copy it.</li>
              <li>Paste it here, pick the workspaces, then tick the collections to move. No export, no email to wait for.</li>
            </ol>
            <form v-if="!pmWorkspaces" class="flex gap-2" @submit.prevent="pmConnect">
              <input v-model="pmKey" type="password" class="input input-sm flex-1 font-mono" placeholder="PMAK-…" autocomplete="off" spellcheck="false" />
              <button class="btn btn-primary btn-sm" :disabled="busy || !pmKey.trim()"><span v-if="busy" class="loading loading-spinner loading-xs" />Connect</button>
            </form>
            <template v-else>
              <div class="flex items-center gap-2 text-sm">
                <span class="flex-1">Connected to Postman as <b>{{ pmUser }}</b> · {{ pmPicked.length }} of {{ pmWorkspaces.length }} workspaces</span>
                <button class="btn btn-ghost btn-xs" :disabled="busy" @click="pmPicked = pmPicked.length === pmWorkspaces.length ? [] : pmWorkspaces.map((w) => w.id)">{{ pmPicked.length === pmWorkspaces.length ? 'None' : 'All' }}</button>
                <button class="btn btn-ghost btn-xs" :disabled="busy" @click="((pmWorkspaces = null), (pmKey = ''))">Use another key</button>
              </div>
              <div class="max-h-48 space-y-0.5 overflow-auto rounded-xl border border-base-300/70 p-1.5">
                <p v-if="!pmWorkspaces.length" class="px-2 py-3 text-sm opacity-60">This key sees no workspaces.</p>
                <label v-for="w in pmWorkspaces" :key="w.id" class="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-base-200/70">
                  <input type="checkbox" class="checkbox checkbox-sm checkbox-primary" :checked="pmPicked.includes(w.id)" :disabled="busy" @change="pmToggle(w.id)" />
                  <span class="flex-1 truncate">{{ w.name }}</span>
                  <span class="badge badge-ghost badge-sm">{{ w.type }}</span>
                </label>
              </div>
              <div class="flex justify-end"><button class="btn btn-primary btn-sm" :disabled="busy || !pmPicked.length" @click="pmNext"><span v-if="busy" class="loading loading-spinner loading-xs" />Next: choose collections</button></div>
            </template>
            <p class="text-xs opacity-50">The key is used for this move only and is not kept. Delete it in Postman afterwards if you like.</p>
          </template>
          <p class="text-xs opacity-50">Postman “secret” values stay marked secret. Variable values stay on this computer{{ workspace?.serverId ? ' (team environments share only the names)' : '' }}.</p>
        </template>
        <template v-else>
          <div class="alert alert-success alert-soft text-sm"><CatMood mood="success" class="size-7 shrink-0 -my-0.5" /><span>Moved {{ plural(summary.collections.length, 'collection') }} with {{ plural(totalRequests, 'request') }}<template v-if="summary.environments.length">, {{ plural(summary.environments.length, 'environment') }}</template><template v-if="summary.globals"> and {{ plural(summary.globals, 'global') }}</template>.</span></div>
          <div class="max-h-60 space-y-1 overflow-auto text-sm">
            <p v-for="c in summary.collections" :key="c.name"><Icon name="collection" class="inline size-4 opacity-60" /> {{ c.name }} <span class="opacity-50">· {{ plural(c.requests, 'request') }}</span></p>
            <p v-for="e in summary.environments" :key="e"><Icon name="environments" class="inline size-4 opacity-60" /> {{ e }}</p>
          </div>
          <details v-if="summary.skipped.length" class="text-xs opacity-70"><summary>{{ summary.skipped.length }} {{ pmHow === 'key' ? 'item(s)' : 'file(s)' }} skipped</summary><p v-for="f in summary.skipped" :key="f" class="font-mono">{{ f }}</p></details>
        </template>
      </template>

      <!-- DevCatz -->
      <template v-else-if="mode === 'devcatz'">
        <div v-if="notInstalled" class="alert alert-info alert-soft text-sm">
          <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
          <span class="flex-1">DevCatz is not installed on this computer. With it, your local sites show up here with their environments and routes.</span>
          <button class="btn btn-primary btn-sm shrink-0 gap-1.5" @click="api.openUrl(devcatzPage)"><img :src="devcatzLogo" alt="" class="size-4" />Get DevCatz</button>
        </div>
        <div v-else-if="devcatz && !devcatz.sites.length" class="text-sm opacity-60">DevCatz has no sites yet.</div>
        <template v-else-if="devcatz">
          <div class="opt-row">
            <span class="label-caps">Site</span>
            <select v-model="siteId" class="select select-sm flex-1">
              <option v-for="s in devcatz.sites" :key="s.id" :value="s.id">{{ s.name }} — {{ s.domain }} ({{ FW[s.framework] }}){{ s.running ? ' · running' : '' }}</option>
            </select>
          </div>
          <div v-if="apps.length > 1" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">App</span><span class="text-xs opacity-50">Where requests go</span></span>
            <div class="seg seg-xs seg-choice">
              <button v-for="a in apps" :key="a.dir" class="seg-item normal-case" :class="{ 'is-active': appDir === a.dir }" :title="a.url ?? 'no address'" @click="appDir = a.dir">{{ a.name.split('/').pop() || a.dir }}<span v-if="(a.name.split('/').pop() || a.dir) !== a.kind" class="opacity-50"> {{ a.kind }}</span></button>
            </div>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Environment</span><span class="text-xs opacity-50">“DevCatz · {{ site?.name }}” with baseUrl = {{ base }}{{ base !== site?.url ? ` (and siteUrl = ${site?.url})` : '' }}</span></span>
            <input v-model="withEnv" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </div>
          <div v-if="withEnv" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Add its .env variables</span><span class="text-xs opacity-50">{{ site?.hasEnv ? 'Keys, passwords and tokens are marked secret; values stay on this computer.' : 'This site has no .env.' }}</span></span>
            <input v-model="withEnvVars" type="checkbox" class="toggle toggle-sm toggle-primary" :disabled="!site?.hasEnv" />
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Routes as a collection</span><span class="text-xs opacity-50">{{ isLaravel ? 'Runs php artisan route:list in the project (its code runs to list them).' : specs.length ? `From ${specs.map((o) => (o.file ? fileName(o.file) : o.url)).join(', ')} (found by DevCatz).` : site?.running ? `From the OpenAPI document ${base} serves.` : 'DevCatz found no OpenAPI file, and the site is not running — start it in DevCatz first.' }}</span></span>
            <input v-model="withRoutes" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </div>
        </template>
        <div v-else class="py-6 text-center"><span class="loading loading-dots" /></div>
      </template>

      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span>{{ error }}</span></div>
      <div class="modal-action">
        <button v-if="mode === 'postman' && pmChoice && !summary" class="btn btn-ghost btn-sm mr-auto" :disabled="busy" @click="pmBack">Back</button>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">{{ summary ? 'Close' : 'Cancel' }}</button>
        <button v-if="mode === 'file'" class="btn btn-primary btn-sm" :disabled="busy || !text.trim()" @click="fromText"><span v-if="busy" class="loading loading-spinner loading-xs" />Import</button>
        <button v-else-if="mode === 'postman' && summary" class="btn btn-primary btn-sm" @click="emit('done', null)">Done</button>
        <button v-else-if="mode === 'postman' && pmChoice" class="btn btn-primary btn-sm" :disabled="busy || pmNothing" @click="pmImport">
          <span v-if="busy" class="loading loading-spinner loading-xs" />{{ pmChoice.token ? 'Import' : 'Move' }} {{ plural(pmPick.collections.length, 'collection') }}<template v-if="pmPick.environments.length"> and {{ plural(pmPick.environments.length, 'environment') }}</template>
        </button>
        <button v-else-if="mode === 'devcatz' && !notInstalled" class="btn btn-primary btn-sm" :disabled="busy || !site || (!withEnv && !withRoutes)" @click="importSite"><span v-if="busy" class="loading loading-spinner loading-xs" />Import</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
