<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Tab } from '../state';
import { aiOn, history, isWs, notify, plain, section } from '../state';
import type { ExplainAnswer } from '@shared/types';
import { prettyJson, prettyXml } from '../highlight';
import { base64ToBytes, bytesAsText, decodeBase64, hexDump, parseSetCookies, prettyHtml, sniff, tableOf } from '../formats';
import { keyLabel, modKey } from '../platform';
import CatMood, { type CatMoodKind } from './CatMood.vue';
import CodeEditor from './CodeEditor.vue';
import DbCatzCheck from './DbCatzCheck.vue';
import JsonViewer from './JsonViewer.vue';
import Icon from './Icon.vue';
import WsLog from './WsLog.vue';

/**
 * The response half. The cat answers the call: it purrs (happy) on 2xx, looks things up (glasses) on 3xx, is
 * alarmed on 4xx and sad on 5xx or a network failure — "200 purrs. 500 hisses."
 * Views per kind of body: JSON as a tree (fold, search, copy paths), pretty or raw; XML / HTML pretty, HTML and
 * SVG previews; images and PDFs previewed; CSV / NDJSON / arrays of objects as a table; base64 decoded; a hex dump
 * for anything binary. "As" overrides a wrong content type. ⌘F searches the body.
 */
const props = defineProps<{ tab: Tab }>();

type Pane = 'body' | 'headers' | 'cookies' | 'tests' | 'sent';
type View = 'tree' | 'pretty' | 'raw' | 'preview' | 'table' | 'base64' | 'hex';
type Kind = 'json' | 'xml' | 'html' | 'image' | 'pdf' | 'text' | 'binary';
const pane = ref<Pane>('body');
const view = ref<View>('tree');
const as = ref<'auto' | Kind>('auto');
const wrap = ref(false);

const r = computed(() => props.tab.result?.response ?? null);
const error = computed(() => props.tab.result?.error ?? null);

const mood = computed<CatMoodKind>(() => {
  if (error.value) return 'error';
  const s = r.value?.status ?? 0;
  if (s >= 200 && s < 300) return 'success';
  if (s >= 300 && s < 400) return 'info';
  if (s >= 400 && s < 500) return 'warning';
  return 'error';
});
const statusTone = computed(() => ({ success: 'is-ok', info: 'is-info', warning: 'is-warn', error: 'is-bad', question: '' })[mood.value]);
const sayings: Record<CatMoodKind, string> = { success: 'Purr.', info: 'Over there…', warning: 'Hiss!', error: 'HISS!', question: '' };

// ---------------------------------------------------------------- what the body is

const bytes = computed(() => (r.value?.bodyBase64 ? base64ToBytes(r.value.bodyBase64) : null));
const detected = computed<Kind>(() => {
  const resp = r.value;
  if (!resp) return 'text';
  const ct = resp.contentType;
  if (resp.binary) {
    const m = (bytes.value && sniff(bytes.value)) || ct;
    return /^image\//.test(m) ? 'image' : /pdf/.test(m) ? 'pdf' : 'binary';
  }
  if (/json/.test(ct) || (!ct && /^\s*[[{]/.test(resp.body))) return 'json';
  // JSON sent as text/html or text/plain (common with PHP backends): still JSON when it parses.
  if (/^text\/(html|plain)/.test(ct) && /^\s*[[{]/.test(resp.body)) {
    try {
      JSON.parse(resp.body);
      return 'json';
    } catch {
      /* really text / HTML */
    }
  }
  if (/svg/.test(ct)) return 'image';
  if (/html/.test(ct) || (/^\s*<!doctype html|^\s*<html/i.test(resp.body) && !ct)) return 'html';
  if (/xml/.test(ct)) return 'xml';
  return 'text';
});
const kind = computed<Kind>(() => (as.value === 'auto' ? detected.value : as.value));
const json = computed<unknown>(() => {
  if (kind.value !== 'json' || !r.value) return undefined;
  try {
    return JSON.parse(r.value.body);
  } catch {
    return undefined;
  }
});
const table = computed(() => (r.value && !r.value.binary ? tableOf(r.value.body, r.value.contentType, json.value) : null));
const b64 = computed(() => (r.value && !r.value.binary && r.value.body.length < 20_000_000 ? decodeBase64(r.value.body) : null));
const b64Text = computed(() => (b64.value ? bytesAsText(b64.value.bytes) : null));
const b64Mime = computed(() => (b64.value ? b64.value.mime || sniff(b64.value.bytes) : null));

const views = computed<{ id: View; label: string }[]>(() => {
  const k = kind.value;
  const out: { id: View; label: string }[] = [];
  if (k === 'json' && json.value !== undefined) out.push({ id: 'tree', label: 'Tree' });
  if (['json', 'xml', 'html'].includes(k)) out.push({ id: 'pretty', label: 'Pretty' });
  if (k === 'html' || k === 'image' || k === 'pdf') out.push({ id: 'preview', label: 'Preview' });
  if (k !== 'binary' && k !== 'image' && k !== 'pdf') out.push({ id: 'raw', label: 'Raw' });
  if (table.value) out.push({ id: 'table', label: 'Table' });
  if (b64.value && (b64Text.value || b64Mime.value)) out.push({ id: 'base64', label: 'Base64' });
  if (bytes.value || (r.value && r.value.body)) out.push({ id: 'hex', label: 'Hex' });
  return out;
});
// The first view that fits whenever a new response (or "As") comes in.
watch([r, kind], () => {
  if (!views.value.some((v) => v.id === view.value) || props.tab.result?.response !== lastResp) view.value = views.value[0]?.id ?? 'raw';
  lastResp = props.tab.result?.response ?? null;
});
let lastResp: unknown = null;

const text = computed(() => {
  const resp = r.value;
  if (!resp) return '';
  if (view.value === 'raw') return resp.body;
  if (view.value === 'pretty') {
    if (kind.value === 'json') return prettyJson(resp.body) ?? resp.body;
    if (kind.value === 'html') return prettyHtml(resp.body);
    if (kind.value === 'xml') return prettyXml(resp.body);
  }
  if (view.value === 'base64') return b64Text.value ?? '';
  if (view.value === 'hex') return hexDump(bytes.value ?? new TextEncoder().encode(resp.body));
  return resp.body;
});
const language = computed(() => {
  if (view.value === 'hex' || view.value === 'raw') return 'text' as const;
  if (view.value === 'base64') return b64Text.value && /^\s*[[{]/.test(b64Text.value) ? ('json' as const) : ('text' as const);
  return kind.value === 'json' ? ('json' as const) : kind.value === 'xml' || kind.value === 'html' ? ('xml' as const) : ('text' as const);
});

// Previews: HTML in a sandboxed frame (no scripts), images / PDFs from the bytes, SVG as an image.
const previewUrl = ref('');
const previewKind = ref<'frame' | 'image' | 'pdf' | ''>('');
function makePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = '';
  previewKind.value = '';
  const resp = r.value;
  if (!resp) return;
  const fromBytes = (b: Uint8Array, type: string) => URL.createObjectURL(new Blob([b.slice().buffer as ArrayBuffer], { type }));
  if (view.value === 'preview') {
    if (kind.value === 'html') {
      previewUrl.value = URL.createObjectURL(new Blob([resp.body], { type: 'text/html' }));
      previewKind.value = 'frame';
    } else if (kind.value === 'image') {
      previewUrl.value = bytes.value ? fromBytes(bytes.value, sniff(bytes.value) ?? resp.contentType) : URL.createObjectURL(new Blob([resp.body], { type: 'image/svg+xml' }));
      previewKind.value = 'image';
    } else if (kind.value === 'pdf' && bytes.value) {
      previewUrl.value = fromBytes(bytes.value, 'application/pdf');
      previewKind.value = 'pdf';
    }
  } else if (view.value === 'base64' && b64.value && b64Mime.value && !b64Text.value) {
    previewUrl.value = fromBytes(b64.value.bytes, b64Mime.value);
    previewKind.value = /pdf/.test(b64Mime.value) ? 'pdf' : 'image';
  }
}
watch([r, view, kind], makePreview);
onBeforeUnmount(() => previewUrl.value && URL.revokeObjectURL(previewUrl.value));

// ---------------------------------------------------------------- search

const search = ref('');
const searchOpen = ref(false);
const matchCount = ref(0);
const activeIndex = ref(0);
const searchInput = ref<HTMLInputElement | null>(null);
const jsonViewer = ref<InstanceType<typeof JsonViewer> | null>(null);
watch(search, () => (activeIndex.value = 0));
async function openSearch() {
  pane.value = 'body';
  searchOpen.value = true;
  await nextTick();
  searchInput.value?.select();
}
const step = (d: number) => matchCount.value && (activeIndex.value = (activeIndex.value + d + matchCount.value) % matchCount.value);
function onKey(e: KeyboardEvent) {
  if (section.value !== 'requests' || !r.value) return;
  if (modKey(e) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    void openSearch();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// ---------------------------------------------------------------- other panes

const cookies = computed(() => (r.value ? parseSetCookies(r.value.headers) : []));
const scriptTests = computed(() => [...(props.tab.scripts?.pre?.tests ?? []), ...(props.tab.scripts?.tests?.tests ?? [])]);
const passed = computed(() => scriptTests.value.filter((t) => t.pass).length);
const hasScripts = computed(() => !!(props.tab.scripts?.pre || props.tab.scripts?.tests));
watch(
  () => props.tab.scripts,
  (sc) => {
    // A failing test or a broken script opens the Tests pane.
    if (sc && (scriptTests.value.some((t) => !t.pass) || sc.pre?.error || sc.tests?.error)) pane.value = 'tests';
  },
);
/** The last sends of this saved request (oldest first) for the timing sparkline. */
const timings = computed(() => {
  if (!props.tab.itemId) return [];
  return history.value
    .filter((h) => h.itemId === props.tab.itemId && h.status !== null)
    .slice(0, 20)
    .reverse();
});
const maxTime = computed(() => Math.max(1, ...timings.value.map((t) => t.timeMs)));
const tone = (s: number | null) => (s === null || s >= 500 ? 'is-bad' : s >= 400 ? 'is-warn' : '');

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
const time = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);

async function copyBody() {
  await window.dialcatz.copyText(view.value === 'tree' ? (prettyJson(r.value?.body ?? '') ?? '') : text.value);
  notify('success', 'Response copied');
}
async function saveBody() {
  const ext = r.value?.contentType.split('/')[1]?.replace(/[^\w]+.*/, '') || 'txt';
  if (await window.dialcatz.saveResponse(props.tab.id, `response.${ext}`)) notify('success', 'Response saved');
}

// ✦ Explain: what the response means / why it failed (AI, Settings → AI → Explain a response).
const explaining = ref(false);
const explanation = ref<ExplainAnswer | null>(null);
const explainError = ref('');
watch(() => props.tab.result, () => ((explanation.value = null), (explainError.value = '')));
async function explain() {
  const res = props.tab.result;
  if (!res?.response) return;
  explaining.value = true;
  explainError.value = '';
  try {
    explanation.value = await window.dialcatz.aiExplain(plain({ method: res.sent.method, url: res.sent.url, headers: res.sent.headers }), plain({ status: res.response.status, statusText: res.response.statusText, headers: res.response.headers, body: res.response.binary ? `(binary, ${res.response.size} bytes, ${res.response.contentType})` : res.response.body, time: res.response.timings.total }), `explain_${props.tab.id}`);
  } catch (e) {
    explainError.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    explaining.value = false;
  }
}

// Decode a selected piece of text as base64 (tokens, data: URLs in a JSON body …).
const decoded = ref<{ text: string | null; url: string; mime: string | null } | null>(null);
function decodeSelection() {
  const sel = window.getSelection()?.toString() ?? '';
  const d = sel ? decodeBase64(sel) : null;
  if (!d) return notify('warning', sel ? 'The selected text is not base64' : 'Select some base64 text in the response first');
  const t = bytesAsText(d.bytes);
  const mime = d.mime || sniff(d.bytes);
  decoded.value = { text: t, mime, url: !t && mime ? URL.createObjectURL(new Blob([d.bytes.slice().buffer as ArrayBuffer], { type: mime })) : '' };
}
async function copyDecoded() {
  if (decoded.value?.text == null) return;
  await window.dialcatz.copyText(decoded.value.text);
  notify('success', 'Copied');
}
function closeDecoded() {
  if (decoded.value?.url) URL.revokeObjectURL(decoded.value.url);
  decoded.value = null;
}
</script>

<template>
  <WsLog v-if="isWs(tab)" :tab="tab" />
  <div v-else class="flex min-h-0 flex-1 flex-col">
    <!-- Nothing sent yet -->
    <div v-if="!tab.result && !tab.sending" class="grid flex-1 place-items-center p-6 text-center">
      <div class="space-y-2 opacity-70">
        <img src="../assets/icon.png" alt="" class="mx-auto size-16 opacity-80" />
        <p class="text-sm font-medium">Dial an endpoint. Hear it purr.</p>
        <p class="text-xs opacity-60">Press Send or {{ keyLabel('mod+enter') }} to see the response here.</p>
      </div>
    </div>

    <div v-else-if="tab.sending && !tab.result" class="grid flex-1 place-items-center">
      <div class="flex items-center gap-3 text-sm opacity-70"><span class="loading loading-dots loading-md" />Calling…</div>
    </div>

    <!-- Network failure -->
    <div v-else-if="error" class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <CatMood mood="error" class="size-16" />
      <div>
        <p class="font-semibold">{{ error === 'Cancelled' ? 'Request cancelled' : 'The call did not go through' }}</p>
        <p class="selectable mt-1 max-w-xl text-sm opacity-70">{{ error }}</p>
      </div>
      <code class="selectable max-w-full truncate text-xs opacity-50">{{ tab.result?.sent.method }} {{ tab.result?.sent.url }}</code>
    </div>

    <template v-else-if="r">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-base-300/60 px-4 py-2">
        <div :key="`${tab.sentAt}`" class="status-chip" :class="statusTone">
          <CatMood :mood="mood" class="cat-pop size-6" />
          <span class="font-mono font-semibold">{{ r.status }}</span>
          <span class="opacity-80">{{ r.statusText }}</span>
          <span class="status-say">{{ sayings[mood] }}</span>
        </div>
        <span class="resp-meta" title="Total time (time to first byte)"><b>{{ time(r.timings.total) }}</b><span class="opacity-50"> · TTFB {{ time(r.timings.ttfb) }}</span></span>
        <span v-if="timings.length > 1" class="spark" :title="`Last ${timings.length} sends: ${timings.map((t) => `${t.timeMs} ms`).join(', ')}`">
          <i v-for="(t, n) in timings" :key="t.id" :class="[tone(t.status), { 'is-now': n === timings.length - 1 }]" :style="{ height: `${Math.max(3, (t.timeMs / maxTime) * 18)}px` }" />
        </span>
        <span class="resp-meta"><b>{{ size(r.size) }}</b></span>
        <span v-if="r.redirected" class="badge badge-soft badge-info badge-sm" :title="r.url">redirected</span>
        <span v-if="r.truncated" class="badge badge-soft badge-warning badge-sm">cut at 25 MB</span>
        <span v-if="tab.sending" class="loading loading-spinner loading-xs" />
        <span class="flex-1" />
        <DbCatzCheck :tab="tab" />
        <button v-if="aiOn('explain')" class="btn btn-ghost btn-xs gap-1" :disabled="explaining" title="Explain this response (AI)" @click="explain"><span v-if="explaining" class="loading loading-spinner loading-xs" /><span v-else class="text-primary">✦</span>Explain</button>
        <div class="seg seg-xs" role="tablist">
          <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'body' }" @click="pane = 'body'">Body</button>
          <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'headers' }" @click="pane = 'headers'">Headers<span class="pane-count">{{ r.headers.length }}</span></button>
          <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'cookies' }" @click="pane = 'cookies'">Cookies<span v-if="cookies.length" class="pane-count">{{ cookies.length }}</span></button>
          <button v-if="hasScripts" role="tab" class="seg-item" :class="{ 'is-active': pane === 'tests' }" @click="pane = 'tests'">
            Tests<span v-if="scriptTests.length" class="pane-count" :class="{ 'is-bad': passed < scriptTests.length }">{{ passed }}/{{ scriptTests.length }}</span>
          </button>
          <button role="tab" class="seg-item normal-case" :class="{ 'is-active': pane === 'sent' }" @click="pane = 'sent'">Sent request</button>
        </div>
      </div>

      <div v-if="explanation || explainError" class="mx-4 mt-2 rounded-xl border border-base-300/70 bg-base-200/50 p-3 text-sm">
        <div class="flex items-start gap-2">
          <CatMood :mood="explainError ? 'error' : explanation?.cause ? 'warning' : 'info'" class="size-7 shrink-0" />
          <div class="min-w-0 flex-1 space-y-1.5">
            <p v-if="explainError" class="text-error">{{ explainError }}</p>
            <template v-else-if="explanation">
              <p class="selectable">{{ explanation.summary }}</p>
              <p v-if="explanation.cause" class="selectable"><b>Likely cause:</b> {{ explanation.cause }}</p>
              <ul v-if="explanation.fixes.length" class="selectable list-disc space-y-0.5 pl-5">
                <li v-for="(f, i) in explanation.fixes" :key="i">{{ f }}</li>
              </ul>
            </template>
          </div>
          <button class="btn btn-ghost btn-xs btn-square" title="Close" @click="((explanation = null), (explainError = ''))">✕</button>
        </div>
      </div>

      <div v-if="pane === 'body'" class="flex min-h-0 flex-1 flex-col gap-2 px-4 py-2">
        <div class="flex flex-wrap items-center gap-2">
          <div class="seg seg-xs seg-choice">
            <button v-for="v in views" :key="v.id" role="tab" class="seg-item" :class="{ 'is-active': view === v.id }" @click="view = v.id">{{ v.label }}</button>
          </div>
          <select v-model="as" class="select select-xs w-auto" title="Read the body as (when the content type is wrong)">
            <option value="auto">As: {{ r.contentType || 'auto' }}</option>
            <option value="json">As JSON</option>
            <option value="xml">As XML</option>
            <option value="html">As HTML</option>
            <option value="text">As text</option>
          </select>
          <span class="flex-1" />
          <template v-if="view === 'tree'">
            <button class="btn btn-ghost btn-xs" @click="jsonViewer?.expandAll()">Expand all</button>
            <button class="btn btn-ghost btn-xs" @click="jsonViewer?.collapseAll()">Collapse all</button>
          </template>
          <div v-if="searchOpen" class="resp-search">
            <Icon name="search" class="size-3.5 opacity-50" />
            <input ref="searchInput" v-model="search" placeholder="Search the response" @keydown.enter.exact="step(1)" @keydown.shift.enter="step(-1)" @keydown.esc="((searchOpen = false), (search = ''))" />
            <span class="font-mono text-[11px] opacity-60">{{ search ? `${matchCount ? activeIndex + 1 : 0}/${matchCount}` : '' }}</span>
            <button class="btn btn-ghost btn-xs btn-square" title="Previous (⇧↩)" :disabled="!matchCount" @click="step(-1)">↑</button>
            <button class="btn btn-ghost btn-xs btn-square" title="Next (↩)" :disabled="!matchCount" @click="step(1)">↓</button>
            <button class="btn btn-ghost btn-xs btn-square" title="Close" @click="((searchOpen = false), (search = ''))">×</button>
          </div>
          <button v-else class="btn btn-ghost btn-xs btn-square" :title="`Search (${keyLabel('mod+F')})`" @click="openSearch"><Icon name="search" class="size-3.5" /></button>
          <button v-if="!['tree', 'preview', 'table'].includes(view)" class="btn btn-ghost btn-xs btn-square" :class="{ 'btn-active': wrap }" title="Wrap long lines" @click="wrap = !wrap"><Icon name="wrap" class="size-3.5" /></button>
          <button v-if="!r.binary" class="btn btn-ghost btn-xs" title="Decode the selected text as base64" @click="decodeSelection">Decode selection</button>
          <button class="btn btn-ghost btn-xs gap-1" :disabled="r.binary && view !== 'hex'" @click="copyBody"><Icon name="copy" class="size-3.5" />Copy</button>
          <button class="btn btn-ghost btn-xs gap-1" @click="saveBody"><Icon name="download" class="size-3.5" />Save</button>
        </div>

        <div v-if="!views.length" class="grid flex-1 place-items-center text-sm opacity-60">{{ r.binary ? `Binary response (${size(r.size)}), too large to show here. Use Save to keep it as a file.` : 'Empty body' }}</div>
        <JsonViewer v-else-if="view === 'tree' && json !== undefined" ref="jsonViewer" :value="json" :search="search" :active-index="activeIndex" class="min-h-24 flex-1 rounded-xl border border-base-300/70" @matches="(n) => (matchCount = n)" />
        <template v-else-if="view === 'preview' || (view === 'base64' && previewKind)">
          <iframe v-if="previewKind === 'frame'" :src="previewUrl" sandbox="" class="flex-1 rounded-xl border border-base-300/70 bg-white" />
          <div v-else-if="previewKind === 'image'" class="preview-checker grid flex-1 place-items-center overflow-auto rounded-xl border border-base-300/70 p-4"><img :src="previewUrl" alt="Response image" class="max-h-full max-w-full object-contain" /></div>
          <iframe v-else-if="previewKind === 'pdf'" :src="previewUrl" class="flex-1 rounded-xl border border-base-300/70 bg-white" />
          <div v-else class="grid flex-1 place-items-center text-sm opacity-60">Nothing to preview.</div>
        </template>
        <div v-else-if="view === 'table' && table" class="min-h-24 flex-1 overflow-auto rounded-xl border border-base-300/70">
          <table class="table table-xs table-pin-rows selectable">
            <thead><tr><th class="w-10">#</th><th v-for="c in table.columns" :key="c" class="font-mono">{{ c }}</th></tr></thead>
            <tbody>
              <tr v-for="(row, i) in table.rows" :key="i">
                <td class="opacity-40">{{ i + 1 }}</td>
                <td v-for="(cell, j) in row" :key="j" class="max-w-80 truncate font-mono" :title="cell">{{ cell }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <CodeEditor v-else :model-value="text" :language="language" readonly :wrap="wrap || view === 'base64'" :search="search" :active-index="activeIndex" class="min-h-24 flex-1 rounded-xl border border-base-300/70" @matches="(n) => (matchCount = n)" />
      </div>

      <div v-else-if="pane === 'headers'" class="min-h-0 flex-1 overflow-auto px-4 py-2">
        <table class="table table-sm selectable">
          <tbody>
            <tr v-for="([k, v], i) in r.headers" :key="i">
              <td class="w-1/3 font-mono text-xs font-semibold">{{ k }}</td>
              <td class="font-mono text-xs break-all">{{ v }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="pane === 'tests'" class="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3">
        <template v-for="part in (['pre', 'tests'] as const)" :key="part">
          <div v-if="tab.scripts?.[part]" class="space-y-2">
            <h3 class="label-caps">{{ part === 'pre' ? 'Pre-request script' : 'Tests' }}</h3>
            <div v-if="tab.scripts[part]!.error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="font-mono text-xs">{{ tab.scripts[part]!.error }}</span></div>
            <div v-for="(t, i) in tab.scripts[part]!.tests" :key="i" class="test-row" :class="t.pass ? 'is-pass' : 'is-fail'">
              <span class="test-badge">{{ t.pass ? 'PASS' : 'FAIL' }}</span>
              <span class="min-w-0 flex-1"><span class="font-medium">{{ t.name }}</span><span v-if="t.error" class="block font-mono text-xs opacity-70">{{ t.error }}</span></span>
            </div>
            <p v-if="!tab.scripts[part]!.tests.length && !tab.scripts[part]!.error" class="text-sm opacity-50">Ran without tests.</p>
            <template v-if="Object.keys(tab.scripts[part]!.changes).length">
              <p class="text-xs opacity-60">Variables set: <code v-for="(v, k) in tab.scripts[part]!.changes" :key="k" class="mr-2">{{ k }}{{ v === null ? ' (removed)' : '' }}</code></p>
            </template>
            <pre v-if="tab.scripts[part]!.logs.length" class="selectable rounded-xl bg-base-200 p-3 font-mono text-xs whitespace-pre-wrap">{{ tab.scripts[part]!.logs.join('\n') }}</pre>
          </div>
        </template>
      </div>

      <div v-else-if="pane === 'cookies'" class="min-h-0 flex-1 overflow-auto px-4 py-2">
        <p v-if="!cookies.length" class="py-10 text-center text-sm opacity-50">This response set no cookies.</p>
        <table v-else class="table table-sm selectable">
          <thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>Expires</th><th>Flags</th></tr></thead>
          <tbody>
            <tr v-for="(c, i) in cookies" :key="i">
              <td class="font-mono text-xs font-semibold">{{ c.name }}</td>
              <td class="max-w-72 font-mono text-xs break-all">{{ c.value }}</td>
              <td class="text-xs">{{ c.domain || '(this host)' }}</td>
              <td class="font-mono text-xs">{{ c.path || '/' }}</td>
              <td class="text-xs">{{ c.maxAge ? `in ${c.maxAge} s` : c.expires || 'session' }}</td>
              <td class="space-x-1 text-xs">
                <span v-if="c.httpOnly" class="badge badge-ghost badge-xs">HttpOnly</span>
                <span v-if="c.secure" class="badge badge-ghost badge-xs">Secure</span>
                <span v-if="c.sameSite" class="badge badge-ghost badge-xs">SameSite={{ c.sameSite }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else class="min-h-0 flex-1 overflow-auto px-4 py-2">
        <p class="selectable font-mono text-xs"><b>{{ tab.result?.sent.method }}</b> {{ tab.result?.sent.url }}</p>
        <table class="table table-sm selectable mt-2">
          <tbody>
            <tr v-for="([k, v], i) in tab.result?.sent.headers" :key="i">
              <td class="w-1/3 font-mono text-xs font-semibold">{{ k }}</td>
              <td class="font-mono text-xs break-all">{{ /^authorization$/i.test(k) ? v.replace(/^(\w+\s+).*/, '$1••••••') : v }}</td>
            </tr>
          </tbody>
        </table>
        <pre v-if="tab.result?.sent.body" class="selectable mt-3 rounded-xl bg-base-200 p-3 font-mono text-xs whitespace-pre-wrap">{{ tab.result.sent.body }}</pre>
      </div>
    </template>

    <dialog v-if="decoded" open class="modal modal-open" @keydown.esc="closeDecoded">
      <div class="modal-box w-[44rem] max-w-[95vw] space-y-3">
        <h3 class="text-lg font-semibold tracking-tight">Decoded base64<span v-if="decoded.mime" class="ml-2 font-mono text-sm opacity-60">{{ decoded.mime }}</span></h3>
        <pre v-if="decoded.text !== null" class="selectable max-h-96 overflow-auto rounded-xl bg-base-200 p-3 font-mono text-xs whitespace-pre-wrap">{{ prettyJson(decoded.text) ?? decoded.text }}</pre>
        <img v-else-if="decoded.url && decoded.mime?.startsWith('image/')" :src="decoded.url" alt="Decoded image" class="max-h-96 rounded-xl" />
        <p v-else class="text-sm opacity-60">Binary data ({{ decoded.mime || 'unknown type' }}) that is not text or an image.</p>
        <div class="modal-action">
          <button v-if="decoded.text !== null" class="btn btn-ghost btn-sm" @click="copyDecoded">Copy</button>
          <button class="btn btn-sm" @click="closeDecoded">Close</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="closeDecoded" />
    </dialog>
  </div>
</template>
