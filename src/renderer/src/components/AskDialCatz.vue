<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { aiProvider, emptyEnvLayout, newRequest, uid, type AskAction, type AskAnswer, type AskContext, type AiTurn, type RequestSpec } from '@shared/types';
import { splitUrl } from '@shared/request';
import { activeEnvironment, activeTab, attempt, collectionOf as collectionOfItem, newTab, notify, openItem, plain, setVarValue, setWorkspace, settings, workspace } from '../state';
import { guessTable } from '../dbguess';
import { openDownload } from '../download';
import { keyLabel } from '../platform';
import CatMood from './CatMood.vue';
import askMark from '../assets/logos/ask-catzoid.svg';
import dbcatzLogo from '../assets/logos/dbcatz.png';

/**
 * Ask DialCatz (⌘K): plain words in, proposed steps out (a new collection, folder, environment or request,
 * opening one, a variable, a table to check in DBCatz). Nothing is created until the user presses the step's
 * button. What goes out: request names / methods / URLs, variable names — no values, no auth — and DBCatz
 * connection names (no passwords).
 */
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

interface Exchange {
  prompt: string;
  answer: AskAnswer | null;
  error: string | null;
  done: Record<number, string>;
  /** Collections / environments this answer's steps created, by name (what is proposed for them goes there). */
  cols: Record<string, string>;
  envs: Record<string, string>;
}
const thread = ref<Exchange[]>([]);
const prompt = ref('');
const busy = ref(false);
const token = uid('ask_');
const input = ref<HTMLTextAreaElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
const model = computed(() => {
  const ai = settings.value?.ai;
  return ai ? `${aiProvider(ai.provider).name} · ${ai.models[ai.provider] || aiProvider(ai.provider).models[0] || ''}` : '';
});
const SUGGESTIONS = ['Add a request that logs in and saves the token', 'Make a Shop API collection with CRUD requests for products', 'Check in the database whether the last call saved the row', 'Add a staging environment with baseUrl and token'];
onMounted(() => nextTick(() => input.value?.focus()));

/** What the model sees of the workspace: names, methods, URLs; variable names only. */
function context(): AskContext {
  const w = workspace.value!;
  const folderName = (id: string | null) => w.items.find((i) => i.id === id && i.kind === 'folder')?.name ?? '';
  const collectionOf = (id: string): string | null => {
    let cur = w.items.find((i) => i.id === id);
    while (cur && cur.parentId) cur = w.items.find((i) => i.id === cur!.parentId);
    return cur?.id ?? null;
  };
  const t = activeTab.value;
  return {
    workspace: w.name,
    environment: activeEnvironment.value?.name ?? null,
    variables: [...new Set([...(activeEnvironment.value?.variables ?? []), ...w.globals].map((v) => v.key).filter(Boolean))],
    collections: w.items
      .filter((i) => i.kind === 'collection')
      .map((c) => ({ id: c.id, name: c.name, requests: w.items.filter((r) => r.kind === 'request' && collectionOf(r.id) === c.id).map((r) => ({ id: r.id, name: r.name, method: r.request?.method ?? 'GET', url: r.request?.url ?? '', folder: folderName(r.parentId) })) })),
    environments: w.environments.map((e) => ({ id: e.id, name: e.name })),
    groups: {
      collections: w.layout.groups.map((g) => ({ name: g.name, items: w.items.filter((i) => i.kind === 'collection' && w.layout.groupOf[i.id] === g.id).map((i) => i.name) })),
      environments: (w.layout.env?.groups ?? []).map((g) => ({ name: g.name, items: w.environments.filter((e) => w.layout.env?.groupOf[e.id] === g.id).map((e) => e.name) })),
    },
    open: t && t.workspaceId === w.id ? { name: t.name, method: t.spec.method, url: t.spec.url, headers: t.spec.headers.filter((h) => h.enabled && h.key).map((h) => h.key), body: ['json', 'text', 'xml'].includes(t.spec.body.mode) ? t.spec.body.raw : '', ...openDb(t) } : null,
  };
}
/** For "check the database": the open request's DBCatz database and the table its last call touched. */
function openDb(t: NonNullable<typeof activeTab.value>) {
  const col = collectionOfItem(t.itemId);
  const own = workspace.value?.items.find((i) => i.id === t.itemId)?.dbTable;
  const sent = t.result?.sent;
  const g = sent ? guessTable(sent.url, sent.method, t.result?.response && !t.result.response.binary ? t.result.response.body : null) : null;
  const table = own ? { name: own } : g ? { name: g.table, ...(g.val ? { col: g.col, val: g.val } : {}) } : null;
  return { database: col?.database ?? null, table, status: t.result?.response?.status ?? null };
}

async function send(text = prompt.value) {
  const p = text.trim();
  if (!p || busy.value) return;
  const history: AiTurn[] = thread.value.flatMap((x) => (x.answer ? [{ role: 'user' as const, text: x.prompt }, { role: 'assistant' as const, text: x.answer.reply }] : []));
  const ex: Exchange = { prompt: p, answer: null, error: null, done: {}, cols: {}, envs: {} };
  thread.value.push(ex);
  prompt.value = '';
  busy.value = true;
  scrollDown();
  try {
    const a = await api.aiAsk(p, history, plain(context()), token);
    thread.value[thread.value.length - 1].answer = a;
  } catch (e) {
    thread.value[thread.value.length - 1].error = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy.value = false;
    scrollDown();
    nextTick(() => input.value?.focus());
  }
}
function stop() {
  void api.aiCancel(token);
}
function scrollDown() {
  nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' }));
}
function keydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}

function label(a: AskAction): string {
  switch (a.type) {
    case 'createRequest':
      return `New request: ${a.method} ${a.name}`;
    case 'openRequest':
      return `Open “${a.name}”`;
    case 'setVariable':
      return `Set variable ${a.key}${a.secret ? ' (secret)' : ''}`;
    case 'createCollection':
      return `New collection: ${a.name}`;
    case 'createFolder':
      return `New folder: ${a.name}`;
    case 'createEnvironment':
      return `New environment: ${a.name}`;
    case 'openInDbcatz':
      return a.conn ? `Check ${a.table || a.db || 'the database'} in DBCatz` : 'Check it in DBCatz';
    case 'groupItems':
      return `Put ${a.ids.length + a.names.length} ${a.target === 'collections' ? 'collection' : 'environment'}${a.ids.length + a.names.length === 1 ? '' : 's'} in group “${a.group}”`;
  }
}
function detail(a: AskAction): string {
  const colName = (id: string | null, name?: string) => name || workspace.value?.items.find((i) => i.id === id)?.name || '';
  switch (a.type) {
    case 'createRequest':
      return `${a.url}${a.collectionId || a.collectionName ? ` · in ${colName(a.collectionId, a.collectionName)}` : ''}`;
    case 'setVariable':
      return a.value ? (a.secret ? '••••••' : a.value) : 'no value yet — fill it in Variables';
    case 'createCollection':
      return a.description;
    case 'createFolder':
      return `in ${colName(a.collectionId, a.collectionName)}`;
    case 'createEnvironment':
      return a.variables.map((v) => v.key).join(', ') || 'no variables yet';
    case 'groupItems': {
      const w = workspace.value;
      const named = a.ids.map((id) => (a.target === 'collections' ? w?.items.find((i) => i.id === id)?.name : w?.environments.find((e) => e.id === id)?.name) ?? '').filter(Boolean);
      return [...named, ...a.names].join(', ');
    }
    case 'openInDbcatz':
      return a.conn ? [a.connName, a.db, a.table, a.col && a.val ? `${a.col} = ${a.val}` : ''].filter(Boolean).join(' · ') : 'DBCatz is not installed on this computer';
    default:
      return '';
  }
}
const BUTTON: Record<AskAction['type'], string> = { createRequest: 'Add', openRequest: 'Open', setVariable: 'Set', createCollection: 'Create', createFolder: 'Create', createEnvironment: 'Create', openInDbcatz: 'Open in DBCatz', groupItems: 'Group' };
const button = (a: AskAction) => (a.type === 'openInDbcatz' && !a.conn ? 'Get DBCatz' : BUTTON[a.type]);

/** A collection this answer proposed: the one already created from it, else created now. */
async function ensureCollection(ex: Exchange, name: string): Promise<string | null> {
  if (ex.cols[name] && workspace.value?.items.some((i) => i.id === ex.cols[name])) return ex.cols[name];
  const w = workspace.value!;
  const id = uid('c_');
  const proposed = ex.answer?.actions.find((x) => x.type === 'createCollection' && x.name === name);
  const item = { id, kind: 'collection' as const, parentId: null, name, sort: w.items.filter((i) => i.kind === 'collection').length, description: proposed?.type === 'createCollection' && proposed.description ? proposed.description : undefined };
  const saved = await attempt(() => api.saveItems(w.id, plain([item])));
  if (!saved) return null;
  setWorkspace(saved);
  ex.cols[name] = id;
  const i = ex.answer?.actions.indexOf(proposed!) ?? -1;
  if (i >= 0) ex.done[i] = 'Collection created';
  return id;
}
/** An environment this answer proposed: the one already created from it, else created now (with its variables). */
async function ensureEnvironment(ex: Exchange, name: string): Promise<string | null> {
  if (ex.envs[name] && workspace.value?.environments.some((e) => e.id === ex.envs[name])) return ex.envs[name];
  const w = workspace.value!;
  const proposed = ex.answer?.actions.find((x) => x.type === 'createEnvironment' && x.name === name);
  const id = uid('e_');
  const saved = await attempt(() => api.saveEnvironment(w.id, plain({ id, name, variables: proposed?.type === 'createEnvironment' ? proposed.variables.map((v) => ({ ...v, enabled: true })) : [] })));
  if (!saved) return null;
  setWorkspace(saved);
  ex.envs[name] = id;
  const i = ex.answer?.actions.indexOf(proposed!) ?? -1;
  if (i >= 0) ex.done[i] = 'Environment created — fill in its values in Variables';
  return id;
}

async function apply(xi: number, i: number, a: AskAction) {
  const ex = thread.value[xi];
  if (a.type === 'openRequest') {
    const it = workspace.value?.items.find((x) => x.id === a.itemId);
    if (it) openItem(it);
    ex.done[i] = 'Opened';
    emit('close');
    return;
  }
  if (a.type === 'setVariable') {
    if (await setVarValue(a.key, a.value)) ex.done[i] = `Set in ${activeEnvironment.value?.name ?? 'Globals'}`;
    return;
  }
  if (a.type === 'createCollection') {
    await ensureCollection(ex, a.name);
    return;
  }
  if (a.type === 'createFolder') {
    const parent = a.collectionId ?? (await ensureCollection(ex, a.collectionName));
    const w = workspace.value;
    if (!parent || !w) return;
    const saved = await attempt(() => api.saveItems(w.id, plain([{ id: uid('f_'), kind: 'folder' as const, parentId: parent, name: a.name, sort: w.items.filter((x) => x.parentId === parent).length }])));
    if (!saved) return;
    setWorkspace(saved);
    ex.done[i] = 'Folder created';
    return;
  }
  if (a.type === 'createEnvironment') {
    if (await ensureEnvironment(ex, a.name)) ex.done[i] = 'Environment created — fill in its values in Variables';
    return;
  }
  if (a.type === 'groupItems') {
    const ids = [...a.ids];
    for (const n of a.names) {
      const id = a.target === 'collections' ? await ensureCollection(ex, n) : await ensureEnvironment(ex, n);
      if (id) ids.push(id);
    }
    const w = workspace.value;
    if (!w || !ids.length) return;
    const lay = a.target === 'collections' ? w.layout : (w.layout.env ?? emptyEnvLayout());
    const existing = lay.groups.find((g) => g.name.toLowerCase() === a.group.toLowerCase());
    const gid = existing?.id ?? uid('g_');
    const groups = existing ? lay.groups : [...lay.groups, { id: gid, name: a.group }];
    const groupOf = { ...lay.groupOf, ...Object.fromEntries(ids.map((id) => [id, gid])) };
    const layout = a.target === 'collections' ? { ...w.layout, groups, groupOf } : { ...w.layout, env: { ...(w.layout.env ?? emptyEnvLayout()), groups, groupOf } };
    const saved = await attempt(() => api.saveLayout(w.id, plain(layout)));
    if (!saved) return;
    setWorkspace(saved);
    ex.done[i] = existing ? `Moved into “${a.group}”` : `Group “${a.group}” made`;
    return;
  }
  if (a.type === 'openInDbcatz') {
    if (!a.conn) {
      if (await openDownload('dbcatz', 'DBCatz')) ex.done[i] = 'Opened the DBCatz download';
      return;
    }
    const ok = await attempt(async () => (await api.dbcatzOpen({ conn: a.conn, db: a.db, table: a.table || undefined, ...(a.col && a.val ? { col: a.col, val: a.val } : {}) }), true));
    if (!ok) return;
    // The open request's collection remembers the connection when it has none yet.
    const t = activeTab.value;
    const col = t ? collectionOfItem(t.itemId) : null;
    if (col && !col.database && workspace.value) setWorkspace(await api.saveDbTarget(workspace.value.id, col.id, { conn: a.conn, db: a.db }, null, null));
    ex.done[i] = 'Opened in DBCatz';
    return;
  }
  const spec: RequestSpec = { ...newRequest(), method: a.method, url: a.url, params: splitUrl(a.url).params, headers: a.headers.map((h) => ({ key: h.key, value: h.value, enabled: true })) };
  if (a.bodyMode === 'form') spec.body = { mode: 'form', raw: '', fields: splitUrl(`?${a.body}`).params };
  else if (a.bodyMode !== 'none') spec.body = { mode: a.bodyMode, raw: a.body, fields: [] };
  const target = a.collectionId ?? (a.collectionName ? await ensureCollection(ex, a.collectionName) : null);
  if (target && workspace.value) {
    const w = workspace.value;
    const item = { id: uid('r_'), kind: 'request' as const, parentId: target, name: a.name, sort: w.items.filter((x) => x.parentId === target).length, request: spec };
    const saved = await attempt(() => api.saveItems(w.id, plain([item])));
    if (!saved) return;
    setWorkspace(saved);
    openItem(saved.items.find((x) => x.id === item.id)!);
    ex.done[i] = 'Added to the collection';
  } else {
    newTab(spec, a.name);
    ex.done[i] = 'Opened in a new tab';
  }
  notify('success', `“${a.name}” is ready — check it, then Send`);
}
</script>

<template>
  <dialog open class="modal modal-open items-start pt-[10vh]" @keydown.esc="emit('close')">
    <div class="ask-panel modal-box flex max-h-[76vh] w-[42rem] max-w-[94vw] flex-col p-0">
      <header class="flex items-center gap-3 px-5 pt-4 pb-3">
        <span class="ask-mark" aria-hidden="true"><span><img :src="askMark" alt="" /></span></span>
        <div class="min-w-0 flex-1">
          <h3 class="text-[15px] leading-tight font-semibold tracking-tight">Ask DialCatz</h3>
          <p class="truncate text-xs opacity-55">{{ model }}</p>
        </div>
        <button v-if="thread.length" class="btn btn-ghost btn-xs" :disabled="busy" @click="thread = []">New chat</button>
        <button class="btn btn-ghost btn-xs btn-square" title="Close (Esc)" aria-label="Close" @click="emit('close')">✕</button>
      </header>

      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-5">
        <div v-if="!thread.length" class="pt-2 pb-5">
          <p class="text-sm opacity-70">Say what you need in plain words. DialCatz proposes collections, requests, environments and variables, or a table to check in DBCatz; nothing is added until you press its button, and nothing is sent until you press Send.</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button v-for="s in SUGGESTIONS" :key="s" class="ask-chip" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <div v-for="(ex, xi) in thread" :key="xi" class="space-y-3 pb-5">
          <div class="flex justify-end"><div class="ask-bubble selectable">{{ ex.prompt }}</div></div>
          <div class="flex gap-3">
            <span class="ask-avatar" aria-hidden="true"><img :src="askMark" alt="" /></span>
            <div class="min-w-0 flex-1 space-y-3 pt-0.5">
              <div v-if="!ex.answer && !ex.error" class="ask-thinking"><span /><span /><span /><em>Thinking it through…</em></div>
              <div v-else-if="ex.error" class="ask-error selectable flex items-start gap-2"><CatMood mood="error" class="size-6 shrink-0" /><span class="min-w-0">{{ ex.error }}</span></div>
              <template v-else-if="ex.answer">
                <p class="selectable text-sm leading-relaxed whitespace-pre-wrap">{{ ex.answer.reply }}</p>
                <ol v-if="ex.answer.actions.length" class="ai-steps">
                  <li v-for="(a, i) in ex.answer.actions" :key="i" class="ai-step" :class="{ 'is-done': ex.done[i] }">
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span v-if="ex.answer.actions.length > 1" class="ai-step-num">{{ i + 1 }}</span>
                        <span class="truncate text-sm font-medium">{{ label(a) }}</span>
                      </div>
                      <div v-if="ex.done[i]" class="mt-0.5 text-xs text-success">{{ ex.done[i] }}</div>
                      <div v-else-if="detail(a)" class="mt-0.5 truncate font-mono text-[11px] opacity-55">{{ detail(a) }}</div>
                      <pre v-if="a.type === 'createRequest' && a.body && !ex.done[i]" class="mt-1 max-h-24 overflow-auto rounded bg-base-200/60 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap opacity-80">{{ a.body }}</pre>
                    </div>
                    <button class="btn btn-sm shrink-0 gap-1.5" :class="ex.done[i] ? 'btn-ghost' : 'btn-primary'" @click="apply(xi, i, a)"><img v-if="a.type === 'openInDbcatz' && !ex.done[i]" :src="dbcatzLogo" alt="" class="size-4" />{{ ex.done[i] ? 'Again' : button(a) }}</button>
                  </li>
                </ol>
              </template>
            </div>
          </div>
        </div>
      </div>

      <footer class="px-4 pt-1 pb-4">
        <div class="ask-composer">
          <textarea ref="input" v-model="prompt" rows="1" class="ask-input" :placeholder="thread.length ? 'Ask a follow-up…' : 'What do you need? e.g. “a request that creates an order”'" :disabled="busy" spellcheck="false" @keydown="keydown" />
          <button v-if="busy" class="ask-send is-stop" title="Stop" aria-label="Stop" @click="stop">
            <svg viewBox="0 0 20 20" fill="currentColor"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /></svg>
          </button>
          <button v-else class="ask-send" :disabled="!prompt.trim()" title="Send (⏎)" aria-label="Send" @click="send()">
            <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 3.5 4.6 8.9l1.1 1.1 3.5-3.5V16.5h1.6V6.5l3.5 3.5 1.1-1.1L10 3.5Z" /></svg>
          </button>
        </div>
        <p class="mt-2 px-1 text-[11px] opacity-45">⏎ send · {{ keyLabel('shift+enter').replace('↩', '⏎') }} new line · Esc close · {{ keyLabel('mod+K') }} opens this · names and URLs only: no variable values, no auth</p>
      </footer>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>
