<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { BrunoChoice, BrunoSummary, DevCatzSite, DoCatzProject, PostmanChoice, PostmanPick, PostmanSummary, Workspace } from '@shared/types';
import { loadWorkspaces, notify, selectWorkspace, syncTabsWithWorkspace, workspace } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
import devcatzLogo from '../assets/logos/devcatz.svg';
import docatzLogo from '../assets/logos/docatz.png';
import { openDownload } from '../download';
import { BRUNO_MARK, HOPPSCOTCH_MARK, INSOMNIA_MARK, YAAK_MARK } from '../marks';

/**
 * Bringing requests in: a file or pasted text (Postman collection, OpenAPI / Swagger in JSON or YAML, DialCatz
 * export, cURL); everything from Postman at once (its data export); a DevCatz site or a DoCatz compose project (an
 * environment for it and its routes as a collection). It opens on a choice (File or paste, From DevCatz, From DoCatz,
 * and Postman last) and shows the form once one is picked; a link from DevCatz / DoCatz or the Postman shortcut opens
 * its form straight away.
 */
type Mode = 'choose' | 'file' | 'project' | 'postman' | 'bruno' | 'hoppscotch' | 'insomnia' | 'yaak' | 'notes' | 'devcatz' | 'docatz';
const props = withDefaults(defineProps<{ tab?: Mode; siteId?: string; project?: string; service?: string }>(), { tab: 'choose', siteId: '', project: '', service: '' });
const emit = defineEmits<{ done: [collectionId: string | null]; cancel: [] }>();
const api = window.dialcatz;
const mode = ref(props.tab);
function pickMode(m: Mode) {
  mode.value = m;
  error.value = '';
  bundle.value = false;
  if (m === 'choose') pmChoice.value = null;
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

/** One collection came in with things to look at: they stay on screen. */
const oneDone = ref<{ collectionId: string; count: number; notes: string[] } | null>(null);
async function finish(r: { workspace: Workspace; collectionId: string; count: number; notes: string[] } | null | undefined) {
  if (!r) return;
  use(r.workspace);
  if (r.notes.length) {
    oneDone.value = { collectionId: r.collectionId, count: r.count, notes: r.notes };
    mode.value = 'notes';
    return;
  }
  notify('success', `Imported ${r.count} request${r.count === 1 ? '' : 's'}`);
  emit('done', r.collectionId);
}
/** One collection file goes straight in; an export zip, several files or an environment open the pick list. */
async function fromFile() {
  const r = await guard(() => api.importFile(workspace.value!.id));
  if (!r) return;
  if (r.kind === 'collection') return finish(r);
  bundle.value = true;
  mode.value = 'postman';
  choose(r.choice);
}
const fromText = () => guard(async () => finish(await api.importText(workspace.value!.id, text.value)));

// ---------------------------------------------------------------- OpenAPI in a project (no DevCatz needed)

type Found = NonNullable<Awaited<ReturnType<typeof api.specScanFolder>>>;
const scan = ref<Found | null>(null);
const picked = ref(new Set<string>());
async function pickFolder() {
  const r = await guard(() => api.specScanFolder(workspace.value!.id));
  if (!r) return;
  scan.value = r;
  // New ones start ticked; one the workspace already follows does not.
  picked.value = new Set(r.found.filter((f) => !f.collection).map((f) => f.file));
}
function tick(file: string) {
  const s = new Set(picked.value);
  if (s.has(file)) s.delete(file);
  else s.add(file);
  picked.value = s;
}
async function importPicked() {
  let last: string | null = null;
  let n = 0;
  for (const f of scan.value!.found.filter((x) => picked.value.has(x.file))) {
    const r = await guard(() => api.specImportFile(workspace.value!.id, f.file));
    if (!r) return;
    use(r.workspace);
    last = r.collectionId;
    n++;
  }
  if (!n) return;
  notify('success', n === 1 ? 'Imported: the collection keeps following its OpenAPI file' : `Imported ${n} collections: each keeps following its OpenAPI file`);
  emit('done', last);
}

// ---------------------------------------------------------------- Postman

const summary = ref<PostmanSummary | null>(null);
async function migrate(how: 'files' | 'folder') {
  const r = await guard(() => api.postmanReadExport(how));
  if (r) choose(r);
}
const TITLES = { choose: 'Import', file: 'Import a file or text', project: 'OpenAPI in a project', postman: 'Move from Postman', bruno: 'Move from Bruno', hoppscotch: 'Move from Hoppscotch', insomnia: 'Move from Insomnia', yaak: 'Move from Yaak', notes: 'Imported', devcatz: 'Import from DevCatz', docatz: 'Import from DoCatz' } as const;
/** Files picked under "File or paste" that hold more than one collection: the same pick-what-comes-in list. */
const bundle = ref(false);
const title = computed(() => (bundle.value && mode.value === 'postman' ? 'Import — choose what comes in' : TITLES[mode.value]));
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
  // A workspace export goes back to the first choice (it has no Postman steps behind it).
  if (bundle.value) {
    bundle.value = false;
    mode.value = 'choose';
  }
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

// ---------------------------------------------------------------- Hoppscotch, Insomnia, Yaak (#105, #106)

/** Their files open the same pick-what-comes-in list as a Postman export. */
async function appPick(how: 'files' | 'folder') {
  const r = await guard(() => api.appExportRead(mode.value as 'hoppscotch' | 'insomnia' | 'yaak', how));
  if (!r) return;
  bundle.value = true;
  mode.value = 'postman';
  choose(r);
}

// ---------------------------------------------------------------- Bruno (#104)

const brChoice = ref<BrunoChoice | null>(null);
const brPicked = ref<string[]>([]);
const brSummary = ref<BrunoSummary | null>(null);
async function brPick() {
  const r = await guard(() => api.brunoRead());
  if (!r) return;
  brChoice.value = r;
  brPicked.value = r.collections.map((c) => c.id);
}
const brNotes = computed(() => brChoice.value?.collections.filter((c) => brPicked.value.includes(c.id)).reduce((n, c) => n + c.notes.length, 0) ?? 0);
async function brImport() {
  const r = await guard(() => api.brunoImport(workspace.value!.id, brChoice.value!.token, [...brPicked.value]));
  if (!r) return;
  use(r.workspace);
  brSummary.value = r.summary;
}
/** The list of what to look at, whichever import made it. */
async function copyNotes() {
  const all = oneDone.value ? [{ name: '', notes: oneDone.value.notes }] : (brSummary.value ?? summary.value)!.collections;
  await navigator.clipboard.writeText(all.filter((c) => c.notes.length).flatMap((c) => [...(c.name ? [`${c.name}:`] : []), ...c.notes.map((n) => `- ${n}`)]).join('\n'));
  notify('success', 'List copied');
}

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
// "Get DevCatz" when it is not installed: the site's download for this computer (download.ts).
const notInstalled = computed(() => devcatz.value !== null && !devcatz.value.installed);
onMounted(async () => {
  devcatz.value = await api.devcatzSites();
  if (!siteId.value) siteId.value = devcatz.value.sites[0]?.id ?? '';
});
const FW: Record<DevCatzSite['framework'], string> = { laravel: 'Laravel', nestjs: 'NestJS', node: 'Node', web: 'Web app', go: 'Go', python: 'Python', other: 'Other' };
// Imported before into this workspace: per app / service, the collection the new routes join (the user's requests
// there stay as they are) or a new one. Imported more than once (a new collection was chosen), the user picks which.
type Earlier = { collectionId: string; name: string; key: string; requests: number };
const firstOf = (list: Earlier[]) => Object.fromEntries([...new Set(list.map((b) => b.key))].map((k) => [k, list.find((b) => b.key === k)!.collectionId]));
const groupsOf = (list: Earlier[]) => [...new Set(list.map((b) => b.key))].map((key) => ({ key, list: list.filter((b) => b.key === key) }));
const earlierLabel = (b: Earlier, list: Earlier[]) => `Add new routes to “${b.name}”${list.filter((x) => x.name === b.name).length > 1 ? ` (${b.requests} requests)` : ''}`;
const dvBefore = ref<Earlier[]>([]);
const dvInto = ref<Record<string, string>>({});
watch([siteId, () => workspace.value?.id], async ([s, w]) => ((dvBefore.value = s && w ? await api.importedBefore(w, 'devcatz', s).catch(() => []) : []), (dvInto.value = firstOf(dvBefore.value))), { immediate: true });
const dvGroups = computed(() => groupsOf(dvBefore.value.filter((b) => b.key === (app.value?.dir ?? b.key))));
// Git sharing: the site's requests can live in its own repository (`<site folder>/dialcatz`, a folder workspace).
const inRepo = ref(false);
watch(site, (x) => (inRepo.value = !!x?.workspace), { immediate: true });
const repoFolder = computed(() => (site.value ? `${site.value.path.replace(/\/+$/, '')}/dialcatz` : ''));
/** Switches to the site's repository workspace (made when it has none yet). */
async function toSiteWorkspace(create: boolean) {
  const w = await guard(() => api.devcatzWorkspace(siteId.value, create));
  if (!w) return null;
  await loadWorkspaces();
  await selectWorkspace(w.id);
  return w;
}
async function openSiteWorkspace() {
  if (await toSiteWorkspace(false)) {
    notify('success', `Opened ${site.value?.name}'s workspace from its repository`);
    emit('done', null);
  }
}
async function importSite() {
  if (inRepo.value && !(await toSiteWorkspace(true))) return;
  const r = await guard(() => api.devcatzImport(workspace.value!.id, siteId.value, { environment: withEnv.value, envVars: withEnv.value && withEnvVars.value, routes: withRoutes.value, app: app.value?.dir, into: { ...dvInto.value } }));
  if (!r) return;
  use(r.workspace);
  notify('success', importedText(r, withEnv.value ? `DevCatz · ${site.value?.name}` : ''));
  emit('done', r.collectionId);
}

// ---------------------------------------------------------------- DoCatz

const docatz = ref<{ installed: boolean; engine: boolean; projects: DoCatzProject[] } | null>(null);
const dcName = ref(props.project);
const dcWithEnv = ref(true);
const dcWithEnvVars = ref(false);
const dcWithRoutes = ref(true);
const dcProject = computed(() => docatz.value?.projects.find((p) => p.name === dcName.value) ?? null);
const dcNotInstalled = computed(() => docatz.value !== null && !docatz.value.installed);
// Which service requests go to (baseUrl): the one DoCatz's link names (on its project); else, with more than one API
// service, all of them ('*': a collection each, sending to its own {{<service>Url}}); else the only one.
const dcService = ref('');
const dcDefault = (p: DoCatzProject | null) => p?.services.find((s) => s.url) ?? p?.services[0] ?? null;
watch(dcProject, (p) => (dcService.value = p?.services.find((s) => p.name === props.project && s.service === props.service)?.service ?? ((p?.services.length ?? 0) > 1 ? '*' : (dcDefault(p)?.service ?? ''))), { immediate: true });
const dcAll = computed(() => dcService.value === '*');
const dcPicked = computed(() => dcProject.value?.services.find((s) => s.service === dcService.value) ?? null);
const dcAllText = computed(() => `One collection per service (${dcProject.value?.services.map((s) => s.service).join(', ')}), each sending to its own ${dcProject.value?.services.map((s) => `{{${dcVar(s.service)}}}`).join(', ')}.`);
const dcBase = computed(() => (dcAll.value ? dcDefault(dcProject.value) : dcPicked.value)?.url ?? '');
const dcVar = (s: string) => `${s.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))}Url`;
const dcUrls = computed(() => dcProject.value?.services.filter((s) => s.url) ?? []);
const dcLaravel = computed(() => !dcAll.value && dcPicked.value?.framework === 'laravel');
const FW_NAMES: Record<string, string> = { nestjs: 'NestJS', laravel: 'Laravel', nuxt: 'Nuxt', next: 'Next.js', go: 'Go', gin: 'Gin', echo: 'Echo', fiber: 'Fiber', chi: 'chi', fastapi: 'FastAPI', django: 'Django', flask: 'Flask', express: 'Express', fastify: 'Fastify', hono: 'Hono', koa: 'Koa', rust: 'Rust', axum: 'Axum', actix: 'Actix', symfony: 'Symfony', php: 'PHP', python: 'Python', node: 'Node', wordpress: 'WordPress' };
const fwName = (s: { framework: string | null; library: string | null }) => (s.library ? (FW_NAMES[s.library] ?? s.library) : s.framework ? (FW_NAMES[s.framework] ?? s.framework) : '');
const dcBefore = ref<Earlier[]>([]);
const dcInto = ref<Record<string, string>>({});
watch([dcName, () => workspace.value?.id], async ([n, w]) => ((dcBefore.value = n && w ? await api.importedBefore(w, 'docatz', n).catch(() => []) : []), (dcInto.value = firstOf(dcBefore.value))), { immediate: true });
const dcGroups = computed(() => groupsOf(dcBefore.value.filter((b) => dcAll.value || b.key === dcService.value)));
/** What an import did: new collections, or new routes added to the ones imported before (with the environment). */
function importedText(r: { requests: number; source: string | null; collectionId: string | null; merged: boolean }, env: string): string {
  const routes = !r.collectionId ? '' : r.merged ? (r.requests ? `${r.requests} new route(s) added` : 'No new routes — every route was already there') : `${r.requests} route(s) from ${r.source}`;
  return [env ? `Environment “${env}” ${r.merged ? 'updated' : 'added'}` : '', routes].filter(Boolean).join(' · ');
}
async function loadDoCatz() {
  docatz.value = await api.docatzProjects();
  if (!dcProject.value) dcName.value = docatz.value.projects.find((p) => p.running)?.name ?? docatz.value.projects[0]?.name ?? '';
}
onMounted(loadDoCatz);
async function importProject() {
  const p = dcProject.value;
  if (!p) return;
  const r = await guard(() => api.docatzImport(workspace.value!.id, p.name, { environment: dcWithEnv.value, envVars: dcWithEnv.value && dcWithEnvVars.value, routes: dcWithRoutes.value, service: dcService.value || undefined, into: { ...dcInto.value } }));
  if (!r) return;
  use(r.workspace);
  notify('success', importedText(r, dcWithEnv.value ? `DoCatz · ${p.name}` : ''));
  if (r.skipped.length) notify('warning', `Not imported — ${r.skipped.join(' · ')}`);
  emit('done', r.collectionId);
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('cancel')">
    <div class="modal-box w-[46rem] max-w-[95vw] space-y-4">
      <div class="flex items-center gap-2">
        <button v-if="mode !== 'choose' && !summary && !brSummary && !oneDone" class="btn btn-ghost btn-sm btn-square -ml-2" title="Other ways to import" aria-label="Other ways to import" :disabled="busy" @click="pickMode('choose')"><Icon name="chevron" class="size-4 rotate-180" /></button>
        <h3 class="flex-1 text-lg font-semibold tracking-tight">{{ title }}<span class="font-normal opacity-50"> · {{ workspace?.name }}</span></h3>
      </div>

      <!-- The choice: what it comes from, in three groups -->
      <template v-if="mode === 'choose'">
        <section class="imp-group">
          <h4 class="label-caps">From a file or project</h4>
          <div class="imp-grid">
            <button class="opt-card" @click="pickMode('file')">
              <span class="opt-card-icon"><Icon name="file" class="size-5" /></span>
              <span class="min-w-0 flex-1">
                <span class="opt-card-title">File or paste</span>
                <span class="opt-card-text">A collection, an export, OpenAPI or cURL</span>
              </span>
            </button>
            <button class="opt-card" @click="pickMode('project')">
              <span class="opt-card-icon"><Icon name="folder" class="size-5" /></span>
              <span class="min-w-0 flex-1">
                <span class="opt-card-title">OpenAPI in a project</span>
                <span class="opt-card-text">Found in a folder, and followed from then on</span>
              </span>
            </button>
          </div>
        </section>
        <section class="imp-group">
          <h4 class="label-caps">From your Catzoid apps</h4>
          <div class="imp-grid">
            <button class="opt-card" @click="pickMode('devcatz')">
              <span class="opt-card-icon"><img :src="devcatzLogo" alt="" draggable="false" /></span>
              <span class="min-w-0 flex-1">
                <span class="opt-card-title">DevCatz<span v-if="notInstalled" class="badge badge-ghost badge-xs font-normal">not installed</span></span>
                <span class="opt-card-text">A site's environment and its routes</span>
              </span>
            </button>
            <button class="opt-card" @click="pickMode('docatz')">
              <span class="opt-card-icon"><img :src="docatzLogo" alt="" draggable="false" /></span>
              <span class="min-w-0 flex-1">
                <span class="opt-card-title">DoCatz<span v-if="dcNotInstalled" class="badge badge-ghost badge-xs font-normal">not installed</span></span>
                <span class="opt-card-text">A compose project's services and routes</span>
              </span>
            </button>
          </div>
        </section>
        <section class="imp-group">
          <h4 class="label-caps">Move from another app</h4>
          <div class="imp-grid is-apps">
            <button class="opt-card" @click="pickMode('postman')">
              <span class="opt-card-icon" style="--tile: #ff6c37"><svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true"><path :d="POSTMAN_MARK" /></svg></span>
              <span class="min-w-0">
                <span class="opt-card-title">Postman</span>
                <span class="opt-card-text">An export, or your API key</span>
              </span>
            </button>
            <button class="opt-card" @click="pickMode('insomnia')">
              <span class="opt-card-icon" style="--tile: #8b5cf6"><svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true"><path :d="INSOMNIA_MARK" /></svg></span>
              <span class="min-w-0">
                <span class="opt-card-title">Insomnia</span>
                <span class="opt-card-text">Exported YAML or JSON</span>
              </span>
            </button>
            <button class="opt-card" @click="pickMode('bruno')">
              <span class="opt-card-icon" style="--tile: #f4aa41"><svg viewBox="0 0 24 24" class="size-6" fill="currentColor" aria-hidden="true"><path :d="BRUNO_MARK" /></svg></span>
              <span class="min-w-0">
                <span class="opt-card-title">Bruno</span>
                <span class="opt-card-text">A folder, .bru or YAML</span>
              </span>
            </button>
            <button class="opt-card" @click="pickMode('hoppscotch')">
              <span class="opt-card-icon" style="--tile: #10b981"><svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true"><path :d="HOPPSCOTCH_MARK" /></svg></span>
              <span class="min-w-0">
                <span class="opt-card-title">Hoppscotch</span>
                <span class="opt-card-text">Exported JSON files</span>
              </span>
            </button>
            <button class="opt-card" @click="pickMode('yaak')">
              <span class="opt-card-icon" style="--tile: #a27bf0"><svg viewBox="0 0 24 24" class="size-5" fill="currentColor" aria-hidden="true"><path :d="YAAK_MARK" /></svg></span>
              <span class="min-w-0">
                <span class="opt-card-title">Yaak</span>
                <span class="opt-card-text">An export, or a folder</span>
              </span>
            </button>
          </div>
        </section>
      </template>

      <!-- After an import: what did not come along whole -->
      <template v-else-if="mode === 'notes'">
        <div class="flex items-center gap-3"><CatMood mood="info" class="size-10" /><p class="text-sm">Imported {{ plural(oneDone!.count, 'request') }}. A few things are worth a look.</p></div>
        <div class="imp-notes"><ul class="selectable"><li v-for="n in oneDone!.notes" :key="n">{{ n }}</li></ul></div>
      </template>

      <!-- File or paste -->
      <template v-else-if="mode === 'file'">
        <p class="text-sm opacity-70">Postman, Insomnia, Hoppscotch and Yaak exports, OpenAPI 3 or Swagger 2 (JSON or YAML), DialCatz exports, or a single cURL command. One collection goes straight in; an export zip (DialCatz or Postman), several files or environment files let you choose what comes in.</p>
        <button class="btn btn-sm gap-2" :disabled="busy" @click="fromFile"><Icon name="file" class="size-4" />Choose a file…</button>
        <div class="divider my-0 text-xs opacity-50">or paste</div>
        <textarea v-model="text" class="textarea selectable h-44 w-full font-mono text-xs" placeholder="{ &quot;info&quot;: …, &quot;item&quot;: [ … ] }   openapi: 3.0.0 …   curl https://api.example.com/users" spellcheck="false" />
      </template>

      <!-- OpenAPI in a project -->
      <template v-else-if="mode === 'project'">
        <p class="text-sm opacity-70">DialCatz looks through the folder for OpenAPI 3 and Swagger 2 files (JSON or YAML), leaving out dependencies and build output. Each one you import becomes a collection that follows its file: when the file changes, DialCatz offers the changes.</p>
        <button class="btn btn-sm gap-2" :disabled="busy" @click="pickFolder"><span v-if="busy && !scan" class="loading loading-spinner loading-xs" /><Icon v-else name="folder" class="size-4" />{{ scan ? 'Choose another folder…' : 'Choose a project folder…' }}</button>
        <template v-if="scan">
          <p class="truncate font-mono text-xs opacity-60" :title="scan.folder">{{ scan.folder }}</p>
          <p v-if="!scan.found.length" class="text-sm">No OpenAPI or Swagger file in there. If the API serves one (for example <code>/openapi.json</code>), paste its address under File or paste.</p>
          <div v-else class="max-h-72 space-y-1 overflow-y-auto">
            <label v-for="f in scan.found" :key="f.file" class="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-base-200">
              <input type="checkbox" class="checkbox checkbox-sm checkbox-primary mt-0.5" :checked="picked.has(f.file)" @change="tick(f.file)" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium">{{ f.title }}<span v-if="f.version" class="font-normal opacity-50"> · {{ f.version }}</span></span>
                <span class="block truncate font-mono text-xs opacity-60">{{ f.rel }}</span>
                <span class="block text-xs opacity-50">{{ f.format }} · {{ f.operations }} {{ f.operations === 1 ? 'request' : 'requests' }}<template v-if="f.collection"> · already followed by “{{ f.collection }}”</template></span>
              </span>
            </label>
          </div>
        </template>
      </template>

      <!-- Postman -->
      <template v-else-if="mode === 'hoppscotch'">
        <p class="text-sm opacity-70">In Hoppscotch, open <b>Collections → Import / Export → Export as JSON</b>, and the same under <b>Environments</b>. Choose all those files here at once, then pick what comes in.</p>
        <button class="btn btn-sm gap-2" :disabled="busy" @click="appPick('files')"><span v-if="busy" class="loading loading-spinner loading-xs" /><Icon v-else name="file" class="size-4" />Choose Hoppscotch files…</button>
        <p class="text-xs opacity-60">Requests, GraphQL, folders, auth, headers, variables and scripts (<code>pw</code>, <code>hopp</code>, <code>pm</code>) come in. Values of secret variables are not in the export: you fill them in once.</p>
      </template>

      <template v-else-if="mode === 'insomnia'">
        <p class="text-sm opacity-70">In Insomnia, open a collection's menu and choose <b>Export</b> (Insomnia v5 YAML), or use an older JSON export. Choose the files here, or the folder of a project kept in Git.</p>
        <div class="flex gap-2">
          <button class="btn btn-sm gap-2" :disabled="busy" @click="appPick('files')"><span v-if="busy" class="loading loading-spinner loading-xs" /><Icon v-else name="file" class="size-4" />Choose Insomnia files…</button>
          <button class="btn btn-ghost btn-sm gap-2" :disabled="busy" @click="appPick('folder')"><Icon name="folder" class="size-4" />Choose a folder…</button>
        </div>
        <p class="text-xs opacity-60">Requests, GraphQL, gRPC, WebSocket and Socket.IO, folders, auth, environments and scripts (<code>insomnia</code>, <code>pm</code>) come in. Encrypted values are not in the export, and template tags are listed for you to replace.</p>
      </template>

      <template v-else-if="mode === 'yaak'">
        <p class="text-sm opacity-70">In Yaak, use <b>Export Data</b> for a JSON file, or choose the folder a workspace syncs to.</p>
        <div class="flex gap-2">
          <button class="btn btn-sm gap-2" :disabled="busy" @click="appPick('files')"><span v-if="busy" class="loading loading-spinner loading-xs" /><Icon v-else name="file" class="size-4" />Choose Yaak files…</button>
          <button class="btn btn-ghost btn-sm gap-2" :disabled="busy" @click="appPick('folder')"><Icon name="folder" class="size-4" />Choose a sync folder…</button>
        </div>
        <p class="text-xs opacity-60">Requests, GraphQL, gRPC and WebSocket, folders, auth and environments come in. A sync folder holds shared environments only. Encrypted values stay in Yaak, and template functions are listed for you to replace.</p>
      </template>

      <template v-else-if="mode === 'bruno'">
        <template v-if="brSummary">
          <div class="flex items-center gap-3"><CatMood :mood="brSummary.collections.some((c) => c.notes.length) ? 'info' : 'success'" class="size-10" /><p class="text-sm">Imported {{ plural(brSummary.collections.reduce((n, c) => n + c.requests, 0), 'request') }} in {{ plural(brSummary.collections.length, 'collection') }}<template v-if="brSummary.environments.length"> and {{ plural(brSummary.environments.length, 'environment') }}</template>. Your Bruno files are as they were.</p></div>
          <div v-for="c in brSummary.collections.filter((x) => x.notes.length)" :key="c.id" class="rounded-box border border-base-300/60 p-3">
            <p class="text-sm font-semibold">{{ c.name }} <span class="font-normal opacity-50">· {{ plural(c.notes.length, 'thing') }} to look at</span></p>
            <ul class="selectable mt-1 max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-sm opacity-80"><li v-for="n in c.notes" :key="n">{{ n }}</li></ul>
          </div>
          <p class="text-xs opacity-60">When the team still works in Bruno: the collection's menu → Bruno → Check for changes brings in what changed there. Nothing goes back to Bruno.</p>
        </template>
        <template v-else>
          <p class="text-sm opacity-70">Pick a Bruno collection, or a folder that holds several. Requests, folders, auth, environments, scripts, assertions and notes come in; your Bruno files are only read. Bruno's scripts (<code>bru</code>, <code>req</code>, <code>res</code>, <code>test</code>) run here as they are.</p>
          <button class="btn btn-sm gap-2" :disabled="busy" @click="brPick"><span v-if="busy && !brChoice" class="loading loading-spinner loading-xs" /><Icon v-else name="folder" class="size-4" />{{ brChoice ? 'Choose another folder…' : 'Choose a Bruno folder…' }}</button>
          <template v-if="brChoice">
            <p class="truncate font-mono text-xs opacity-60" :title="brChoice.folder">{{ brChoice.folder }}</p>
            <div class="max-h-72 space-y-1.5 overflow-y-auto">
              <label v-for="c in brChoice.collections" :key="c.id" class="flex cursor-pointer items-start gap-3 rounded-box border border-base-300/60 px-3 py-2.5">
                <input v-model="brPicked" type="checkbox" :value="c.id" class="checkbox checkbox-sm checkbox-primary mt-0.5" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ c.name }} <span class="font-normal opacity-50">· {{ plural(c.requests, 'request') }}<template v-if="c.environments.length"> · {{ plural(c.environments.length, 'environment') }}</template></span></span>
                  <span class="block truncate font-mono text-xs opacity-50">{{ c.path }} · {{ c.format === 'bru' ? '.bru' : 'OpenCollection YAML' }}</span>
                  <details v-if="c.notes.length" class="mt-1 text-xs" @click.stop><summary class="cursor-pointer opacity-70">{{ plural(c.notes.length, 'thing') }} to look at afterwards</summary><ul class="mt-1 list-disc space-y-0.5 pl-4 opacity-70"><li v-for="n in c.notes" :key="n">{{ n }}</li></ul></details>
                </span>
              </label>
            </div>
            <p v-if="brNotes" class="text-xs opacity-60">Everything else comes in as it is. The list stays on screen after the import.</p>
          </template>
        </template>
      </template>

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
          <div class="alert alert-success alert-soft text-sm"><CatMood mood="success" class="size-7 shrink-0 -my-0.5" /><span>{{ bundle ? 'Imported' : 'Moved' }} {{ plural(summary.collections.length, 'collection') }} with {{ plural(totalRequests, 'request') }}<template v-if="summary.environments.length">, {{ plural(summary.environments.length, 'environment') }}</template><template v-if="summary.globals"> and {{ plural(summary.globals, 'global') }}</template>.</span></div>
          <div class="max-h-60 space-y-1 overflow-auto text-sm">
            <p v-for="c in summary.collections" :key="c.name"><Icon name="collection" class="inline size-4 opacity-60" /> {{ c.name }} <span class="opacity-50">· {{ plural(c.requests, 'request') }}</span></p>
            <p v-for="e in summary.environments" :key="e"><Icon name="environments" class="inline size-4 opacity-60" /> {{ e }}</p>
          </div>
          <div v-for="c in summary.collections.filter((x) => x.notes.length)" :key="`n-${c.name}`" class="imp-notes">
            <p class="text-sm font-semibold">{{ c.name }} <span class="font-normal opacity-50">· {{ plural(c.notes.length, 'thing') }} to look at</span></p>
            <ul class="selectable"><li v-for="n in c.notes" :key="n">{{ n }}</li></ul>
          </div>
          <details v-if="summary.skipped.length" class="text-xs opacity-70"><summary>{{ summary.skipped.length }} {{ pmHow === 'key' ? 'item(s)' : 'file(s)' }} skipped</summary><p v-for="f in summary.skipped" :key="f" class="font-mono">{{ f }}</p></details>
        </template>
      </template>

      <!-- DevCatz -->
      <template v-else-if="mode === 'devcatz'">
        <div v-if="notInstalled" class="alert alert-info alert-soft text-sm">
          <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
          <span class="flex-1">DevCatz is not installed on this computer. With it, your local sites show up here with their environments and routes.</span>
          <button class="btn btn-primary btn-sm shrink-0 gap-1.5" @click="openDownload('devcatz', 'DevCatz')"><img :src="devcatzLogo" alt="" class="size-4" />Get DevCatz</button>
        </div>
        <div v-else-if="devcatz && !devcatz.sites.length" class="text-sm opacity-60">DevCatz has no sites yet.</div>
        <template v-else-if="devcatz">
          <div class="opt-row">
            <span class="label-caps">Site</span>
            <select v-model="siteId" class="select select-sm flex-1">
              <option v-for="s in devcatz.sites" :key="s.id" :value="s.id">{{ s.name }} — {{ s.domain }} ({{ FW[s.framework] }}){{ s.running ? ' · running' : '' }}</option>
            </select>
          </div>
          <div v-if="site?.workspace" class="alert alert-soft alert-success text-sm">
            <Icon name="folder" class="size-5 shrink-0" />
            <span class="flex-1">{{ site.name }} keeps a DialCatz workspace in its repository — your team's requests, shared with Git.</span>
            <button class="btn btn-primary btn-sm shrink-0" :disabled="busy" @click="openSiteWorkspace">Open its workspace</button>
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
            <span class="flex flex-col"><span class="label-caps">Save in the site's repository</span><span class="text-xs opacity-50">{{ inRepo ? `As files in ${repoFolder} — commit them to share with your team (Git panel)` : `Into “${workspace?.name}”, on this computer` }}</span></span>
            <input v-model="inRepo" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </div>
          <div v-for="g in dvGroups" v-show="withRoutes" :key="g.key" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Imported before<template v-if="dvGroups.length > 1"> · {{ g.key }}</template></span><span class="text-xs opacity-50">{{ dvInto[g.key] === 'new' ? 'A new collection, next to the one(s) already here' : 'Only routes it does not have yet are added — your saved requests stay as they are' }}</span></span>
            <select v-model="dvInto[g.key]" class="select select-sm w-72 max-w-[50%]">
              <option v-for="b in g.list" :key="b.collectionId" :value="b.collectionId">{{ earlierLabel(b, g.list) }}</option>
              <option v-if="g.list.length > 1" value="all">Add new routes to all {{ g.list.length }}</option>
              <option value="new">New collection</option>
            </select>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Routes as a collection</span><span class="text-xs opacity-50">{{ isLaravel ? 'Runs php artisan route:list in the project (its code runs to list them).' : specs.length ? `From ${specs.map((o) => (o.file ? fileName(o.file) : o.url)).join(', ')} (found by DevCatz).` : site?.running ? `From the OpenAPI document ${base} serves.` : 'DevCatz found no OpenAPI file, and the site is not running — start it in DevCatz first.' }}</span></span>
            <input v-model="withRoutes" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </div>
        </template>
        <div v-else class="py-6 text-center"><span class="loading loading-dots" /></div>
      </template>

      <!-- DoCatz -->
      <template v-else-if="mode === 'docatz'">
        <div v-if="dcNotInstalled" class="alert alert-info alert-soft text-sm">
          <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
          <span class="flex-1">DoCatz is not installed on this computer. With it, your compose projects show up here with their services and routes.</span>
          <button class="btn btn-primary btn-sm shrink-0 gap-1.5" @click="openDownload('docatz', 'DoCatz')"><img :src="docatzLogo" alt="" class="size-4" />Get DoCatz</button>
        </div>
        <div v-else-if="docatz && !docatz.projects.length" class="text-sm opacity-60">DoCatz has no compose projects with an API service yet (Laravel, NestJS, Go … — front ends and plain images have no routes to import).</div>
        <template v-else-if="docatz">
          <div class="opt-row">
            <span class="label-caps">Project</span>
            <select v-model="dcName" class="select select-sm flex-1">
              <option v-for="p in docatz.projects" :key="p.name" :value="p.name">{{ p.name }} — {{ p.services.map((s) => s.service).join(', ') }}{{ p.running ? ' · running' : ' · stopped' }}</option>
            </select>
          </div>
          <div v-if="dcProject && !dcProject.running" class="alert alert-warning alert-soft text-sm">
            <CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
            <span class="flex-1">{{ dcProject.name }} is not running{{ docatz.engine ? '' : ' (DoCatz is stopped)' }}, so its services have no addresses yet. Start it in DoCatz, then come back.</span>
            <button class="btn btn-sm shrink-0 gap-1.5" @click="api.docatzOpen(dcProject.name)"><img :src="docatzLogo" alt="" class="size-4" />Open in DoCatz</button>
            <button class="btn btn-ghost btn-sm btn-square shrink-0" title="Read DoCatz again" aria-label="Read DoCatz again" @click="loadDoCatz"><Icon name="refresh" class="size-4" /></button>
          </div>
          <div v-if="(dcProject?.services.length ?? 0) > 1" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Service</span><span class="text-xs opacity-50">Where requests go (baseUrl)</span></span>
            <div class="seg seg-xs seg-choice">
              <button class="seg-item normal-case" :class="{ 'is-active': dcAll }" title="Every API service, a collection each" @click="dcService = '*'">All</button>
              <button v-for="s in dcProject!.services" :key="s.service" class="seg-item normal-case" :class="{ 'is-active': dcService === s.service }" :title="s.url ?? 'no address'" @click="dcService = s.service">{{ s.service }}<span v-if="fwName(s)" class="opacity-50"> {{ fwName(s) }}</span></button>
            </div>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Environment</span><span class="text-xs opacity-50">“DoCatz · {{ dcProject?.name }}”<template v-if="dcBase"> with baseUrl = {{ dcBase }}</template><template v-if="dcUrls.length"> and {{ dcUrls.map((s) => dcVar(s.service)).join(', ') }}</template></span></span>
            <input v-model="dcWithEnv" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </div>
          <div v-if="dcWithEnv" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Add its .env variables</span><span class="text-xs opacity-50">{{ dcProject?.hasEnv ? 'The project’s .env in DoCatz. Keys, passwords and tokens are marked secret; values stay on this computer.' : 'This project has no .env.' }}</span></span>
            <input v-model="dcWithEnvVars" type="checkbox" class="toggle toggle-sm toggle-primary" :disabled="!dcProject?.hasEnv" />
          </div>
          <div v-for="g in dcGroups" v-show="dcWithRoutes" :key="g.key" class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Imported before<template v-if="dcGroups.length > 1"> · {{ g.key }}</template></span><span class="text-xs opacity-50">{{ dcInto[g.key] === 'new' ? 'A new collection, next to the one(s) already here' : 'Only routes it does not have yet are added — your saved requests stay as they are' }}</span></span>
            <select v-model="dcInto[g.key]" class="select select-sm w-72 max-w-[50%]">
              <option v-for="b in g.list" :key="b.collectionId" :value="b.collectionId">{{ earlierLabel(b, g.list) }}</option>
              <option v-if="g.list.length > 1" value="all">Add new routes to all {{ g.list.length }}</option>
              <option value="new">New collection</option>
            </select>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">{{ dcAll ? 'Routes as collections' : 'Routes as a collection' }}</span><span class="text-xs opacity-50">{{ dcAll ? dcAllText : dcLaravel ? `Runs php artisan route:list inside the ${dcPicked?.service} container (its code runs to list them).` : dcProject?.running ? `From an OpenAPI file in the compose folder, or the one ${dcPicked?.url ?? 'the service'} serves.` : 'From an OpenAPI file in the compose folder — or start the project in DoCatz first.' }}</span></span>
            <input v-model="dcWithRoutes" type="checkbox" class="toggle toggle-sm toggle-primary" />
          </div>
        </template>
        <div v-else class="py-6 text-center"><span class="loading loading-dots" /></div>
      </template>

      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span>{{ error }}</span></div>
      <div class="modal-action">
        <button v-if="mode === 'postman' && pmChoice && !summary" class="btn btn-ghost btn-sm mr-auto" :disabled="busy" @click="pmBack">Back</button>
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="oneDone ? emit('done', oneDone.collectionId) : brSummary ? emit('done', brSummary.collections[0]?.id ?? null) : emit('cancel')">{{ summary || brSummary || oneDone ? 'Close' : 'Cancel' }}</button>
        <button v-if="mode === 'file'" class="btn btn-primary btn-sm" :disabled="busy || !text.trim()" @click="fromText"><span v-if="busy" class="loading loading-spinner loading-xs" />Import</button>
        <button v-if="mode === 'project' && scan?.found.length" class="btn btn-primary btn-sm" :disabled="busy || !picked.size" @click="importPicked"><span v-if="busy" class="loading loading-spinner loading-xs" />Import {{ picked.size || '' }}</button>
        <button v-else-if="mode === 'bruno' && brSummary" class="btn btn-sm" :disabled="!brSummary.collections.some((c) => c.notes.length)" @click="copyNotes"><Icon name="copy" class="size-4" />Copy the list</button>
        <button v-else-if="mode === 'bruno' && brChoice" class="btn btn-primary btn-sm" :disabled="busy || !brPicked.length" @click="brImport"><span v-if="busy" class="loading loading-spinner loading-xs" />Import {{ plural(brPicked.length, 'collection') }}</button>
        <button v-if="(mode === 'postman' && summary?.collections.some((c) => c.notes.length)) || mode === 'notes'" class="btn btn-sm gap-1.5" @click="copyNotes"><Icon name="copy" class="size-4" />Copy the list</button>
        <button v-if="mode === 'postman' && summary" class="btn btn-primary btn-sm" @click="emit('done', null)">Done</button>
        <button v-else-if="mode === 'postman' && pmChoice" class="btn btn-primary btn-sm" :disabled="busy || pmNothing" @click="pmImport">
          <span v-if="busy" class="loading loading-spinner loading-xs" />{{ pmChoice.token ? 'Import' : 'Move' }} {{ plural(pmPick.collections.length, 'collection') }}<template v-if="pmPick.environments.length"> and {{ plural(pmPick.environments.length, 'environment') }}</template>
        </button>
        <button v-else-if="mode === 'docatz' && !dcNotInstalled" class="btn btn-primary btn-sm" :disabled="busy || !dcProject?.running || (!dcWithEnv && !dcWithRoutes)" @click="importProject"><span v-if="busy" class="loading loading-spinner loading-xs" />Import</button>
        <button v-else-if="mode === 'devcatz' && !notInstalled" class="btn btn-primary btn-sm" :disabled="busy || !site || (!withEnv && !withRoutes)" @click="importSite"><span v-if="busy" class="loading loading-spinner loading-xs" />Import</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>

<style scoped>
.imp-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.imp-group + .imp-group {
  margin-top: 1.25rem;
}
.imp-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.625rem;
}
.imp-grid > .opt-card {
  height: 100%;
}
/* Apps side by side: the mark above the name. */
.imp-grid.is-apps {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}
.imp-grid.is-apps > .opt-card {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.75rem;
}
@media (max-width: 44rem) {
  .imp-grid,
  .imp-grid.is-apps {
    grid-template-columns: 1fr;
  }
  .imp-grid.is-apps > .opt-card {
    flex-direction: row;
    align-items: center;
  }
}
.imp-notes {
  padding: 0.75rem 0.875rem;
  border-radius: 0.875rem;
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.1);
}
.imp-notes ul {
  max-height: 14rem;
  margin-top: 0.25rem;
  padding-left: 1.25rem;
  overflow-y: auto;
  list-style: disc;
  font-size: 0.875rem;
  line-height: 1.5;
  opacity: 0.8;
}
</style>
