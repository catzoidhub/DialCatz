<script setup lang="ts">
import { rpcEnvelope } from '@shared/jsonrpc';
import { computed, ref, watch } from 'vue';
import { HTTP_METHODS, type BodyMode, type KeyValue, type RequestAuth } from '@shared/types';
import { AUTO_HEADERS, joinUrl, parseCurl, prettyJson, splitUrl, toCurl, toCurlCmd, toFetch, toPowerShell, effectiveAuth } from '@shared/request';
import { currentOS } from '@shared/platform';
import { activeTab, aiOn, appVersion, inheritedAuth, isGrpc, isWs, pusherChannel, knownVar, notify, plain, readOnly, sendTab, sendWs, wireFor, workspace, type Tab } from '../state';
import { keyLabel } from '../platform';
import KeyValueTable from './KeyValueTable.vue';
import AuthEditor from './AuthEditor.vue';
import CodeEditor from './CodeEditor.vue';
import VarInput from './VarInput.vue';
import Icon from './Icon.vue';

/** The request half: method + address bar + Send, then Params / Headers / Body / Auth / Code tabs. */
const props = defineProps<{ tab: Tab }>();
const emit = defineEmits<{ save: [] }>();

type Pane = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'code';
const pane = ref<Pane>('params');
const urlInput = ref<InstanceType<typeof VarInput> | null>(null);
const spec = computed(() => props.tab.spec);
const touch = () => (props.tab.dirty = true);

const COMMON_HEADERS = ['Accept', 'Accept-Language', 'Authorization', 'Cache-Control', 'Content-Type', 'Cookie', 'If-None-Match', 'Origin', 'Referer', 'User-Agent', 'X-Requested-With', 'X-API-Key'];

// The URL's query and the Params table are one thing: editing either updates the other.
function setUrl(url: string) {
  // A pasted cURL command fills the whole request.
  if (/^\s*curl(\.exe)?\s/i.test(url)) {
    const parsed = parseCurl(url);
    if (parsed) {
      props.tab.spec = parsed;
      touch();
      notify('success', 'cURL command imported');
      return;
    }
  }
  spec.value.url = url;
  const disabled = spec.value.params.filter((p) => !p.enabled);
  // A parameter keeps its description while its key stays in the URL.
  const notes = spec.value.params.filter((p) => p.enabled && p.description);
  const parsed = splitUrl(url).params.map((p) => {
    const i = notes.findIndex((n) => n.key === p.key);
    return i < 0 ? p : { ...p, description: notes.splice(i, 1)[0].description };
  });
  spec.value.params = [...parsed, ...disabled];
  touch();
}
function setParams(rows: KeyValue[]) {
  spec.value.params = rows;
  spec.value.url = joinUrl(splitUrl(spec.value.url).base, rows);
  touch();
}
function setHeaders(rows: KeyValue[]) {
  spec.value.headers = rows;
  touch();
}
function setAuth(a: RequestAuth) {
  spec.value.auth = a;
  touch();
}
function setBodyMode(mode: BodyMode) {
  spec.value.body.mode = mode;
  touch();
}

const count = (rows: KeyValue[]) => rows.filter((r) => r.enabled && r.key).length;
/** JSON-RPC params (or a batch's calls) that would not build an envelope. */
const rpcBad = computed(() => {
  const b = spec.value.body;
  if (b.mode !== 'jsonrpc') return null;
  try {
    rpcEnvelope({ method: b.rpcMethod || 'x', params: b.raw.replace(/\{\{[^}]+\}\}/g, '0'), batch: b.rpcBatch, notify: b.rpcNotify });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});
const bodyIsJsonBad = computed(() => {
  if (spec.value.body.mode !== 'json' || !spec.value.body.raw.trim()) return null;
  // {{vars}} inside JSON are fine once filled; test with placeholders.
  try {
    JSON.parse(spec.value.body.raw.replace(/\{\{[^}]+\}\}/g, '0'));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});
// Auto headers: listed under the user's own; a switch turns one off for this request, a same-named header wins.
const showAuto = ref(false);
const autoRows = computed(() => {
  const own = new Set(spec.value.headers.filter((h) => h.enabled && h.key.trim()).map((h) => h.key.trim().toLowerCase()));
  const off = new Set((spec.value.autoOff ?? []).map((k) => k.toLowerCase()));
  const wire = wireFor(props.tab);
  const type = wire.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  return [
    ...AUTO_HEADERS.map((a) => ({ key: a.key, value: a.value({ version: appVersion.value }), on: !off.has(a.key.toLowerCase()), over: own.has(a.key.toLowerCase()), computed: false })),
    { key: 'Host', value: 'from the URL', on: true, over: false, computed: true },
    ...(type && !own.has('content-type') ? [{ key: 'Content-Type', value: wire.multipart ? 'multipart/form-data; boundary=…' : type, on: true, over: false, computed: true }] : []),
    ...(wire.body !== undefined || wire.multipart || wire.bodyFile !== undefined ? [{ key: 'Content-Length', value: 'calculated when sent', on: true, over: false, computed: true }] : []),
  ];
});
const autoOnCount = computed(() => autoRows.value.filter((r) => r.on && !r.over).length);
function setAuto(key: string, on: boolean) {
  const off = new Set(spec.value.autoOff ?? []);
  if (on) off.delete(key);
  else off.add(key);
  spec.value.autoOff = [...off];
  touch();
}

// Scripts: before the request (set variables) and after it (tests). Snippets to start from.
const scriptTab = ref<'pre' | 'tests'>('tests');
const SNIPPETS: Record<'pre' | 'tests', { label: string; code: string }[]> = {
  pre: [
    { label: 'Set a variable', code: "dc.env.set('requestId', crypto.randomUUID());" },
    { label: 'Timestamp', code: "dc.env.set('now', new Date().toISOString());" },
  ],
  tests: [
    { label: 'Status is 200', code: "dc.test('status is 200', () => dc.expect(dc.response.status).toBe(200));" },
    { label: 'Faster than 500 ms', code: "dc.test('responds in under 500 ms', () => dc.expect(dc.response.time).toBeLessThan(500));" },
    { label: 'JSON has a field', code: "dc.test('has an id', () => dc.expect(dc.response.json()).toHaveProperty('id'));" },
    { label: 'Save a token', code: "dc.env.set('token', dc.response.json().token);" },
  ],
};
function addSnippet(code: string) {
  const key = scriptTab.value === 'pre' ? 'preRequest' : 'tests';
  const cur = spec.value[key] ?? '';
  spec.value[key] = cur.trim() ? `${cur.replace(/\s*$/, '')}\n${code}\n` : `${code}\n`;
  touch();
}

// ✦ AI helpers: tests from the last response, a body from a sentence.
const aiBusy = ref<'' | 'tests' | 'body'>('');
const bodyAsk = ref<string | null>(null);
const aiErr = (e: unknown) => notify('error', String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
async function writeTests() {
  const res = props.tab.result?.response;
  if (!res) return notify('warning', 'Send the request once first: the tests are written from its response');
  aiBusy.value = 'tests';
  try {
    const code = await window.dialcatz.aiTests(plain({ method: spec.value.method, url: spec.value.url }), plain({ status: res.status, headers: res.headers, body: res.binary ? '' : res.body, time: res.timings.total }), spec.value.tests ?? '', `tests_${props.tab.id}`);
    spec.value.tests = code.endsWith('\n') ? code : `${code}\n`;
    scriptTab.value = 'tests';
    touch();
    notify('success', 'Tests written — read them, then Send to run them');
  } catch (e) {
    aiErr(e);
  } finally {
    aiBusy.value = '';
  }
}
async function generateBody() {
  const what = bodyAsk.value?.trim();
  if (!what) return;
  aiBusy.value = 'body';
  try {
    const b = spec.value.body;
    const r = await window.dialcatz.aiBody(plain({ method: spec.value.method, url: spec.value.url, bodyMode: b.mode, body: b.mode === 'form' || b.mode === 'multipart' ? b.fields.map((f) => `${f.key}=${f.value}`).join('&') : b.raw }), what, `body_${props.tab.id}`);
    if (r.mode === 'form') spec.value.body = { ...b, mode: b.mode === 'multipart' ? 'multipart' : 'form', fields: r.fields.map((f) => ({ ...f, enabled: true })) };
    else spec.value.body = { ...b, mode: r.mode, raw: r.body };
    bodyAsk.value = null;
    touch();
  } catch (e) {
    aiErr(e);
  } finally {
    aiBusy.value = '';
  }
}

async function pickBinary() {
  const path = await window.dialcatz.pickFile('Choose the file to send as the body');
  if (path) {
    spec.value.body.file = path;
    touch();
  }
}
const varsBad = computed(() => {
  const v = spec.value.body.variables?.trim();
  if (spec.value.body.mode !== 'graphql' || !v) return null;
  try {
    JSON.parse(v.replace(/\{\{[^}]+\}\}/g, '0'));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
});

function beautify() {
  spec.value.body.raw = prettyJson(spec.value.body.raw);
  touch();
}

const inherited = computed(() => {
  const a = effectiveAuth({ mode: 'inherit' }, inheritedAuth(props.tab.itemId));
  const label = { none: 'no auth', bearer: 'a Bearer token', basic: 'Basic auth', apikey: 'an API key', oauth2: 'OAuth 2.0', inherit: 'no auth' }[a.mode];
  return props.tab.itemId ? `Uses the auth of the folder or collection above: ${label}.` : 'Not saved in a collection yet: nothing to inherit (no auth).';
});

/** Windows: cURL for cmd (curl.exe) first, PowerShell, and bash (Git Bash, WSL); a Mac: cURL for its shell. */
const codeLangs = currentOS === 'windows' ? (['cmd', 'powershell', 'curl', 'fetch'] as const) : (['curl', 'fetch'] as const);
type CodeLang = 'curl' | 'cmd' | 'powershell' | 'fetch';
const CODE_LABEL: Record<CodeLang, string> = { curl: currentOS === 'windows' ? 'cURL (bash)' : 'cURL', cmd: 'cURL (cmd)', powershell: 'PowerShell', fetch: 'JavaScript fetch' };
const codeLang = ref<CodeLang>(codeLangs[0]);
const code = computed(() => {
  const w = wireFor(props.tab);
  return codeLang.value === 'curl' ? toCurl(w) : codeLang.value === 'cmd' ? toCurlCmd(w) : codeLang.value === 'powershell' ? toPowerShell(w) : toFetch(w);
});
async function copyCode() {
  await window.dialcatz.copyText(code.value);
  notify('success', 'Copied');
}

const methodClass = computed(() => `m-${spec.value.method.toLowerCase()}`);
const ws = computed(() => isWs(props.tab));
/**
 * The kind of request (#98): an HTTP method, or ~ws / ~sio / ~grpc. Picking another kind turns the address into that
 * scheme (https://api.x → wss://api.x or grpc://api.x and back) and sets its mode, so a WebSocket, Socket.IO or gRPC
 * request starts from the same New request.
 */
const kind = computed(() => (grpcOn.value ? '~grpc' : ws.value ? (spec.value.pusher ? '~pusher' : spec.value.socketIo ? '~sio' : '~ws') : spec.value.method));
const KIND_HINT: Record<string, string> = { '~pusher': 'ws://localhost:8080/app/{{REVERB_APP_KEY}} (Reverb, Sockudo, Soketi or Pusher) — then Connect', '~ws': 'wss://echo.example.com/socket — then Connect', '~sio': 'ws://localhost:3000 (add /namespace for one) — then Connect', '~grpc': 'grpc://localhost:50051 (grpcs:// for TLS)' };
function setKind(k: string) {
  const url = spec.value.url.trim();
  // The address keeps its host and port; only the scheme changes ({{variables}} at the start stay as they are).
  const swap = (scheme: (secure: boolean) => string, keepPath: boolean) => {
    const m = url.match(/^([a-z][\w+.-]*):\/\/([^/?#]*)(.*)$/i);
    if (!m) return url ? url : `${scheme(false)}://`;
    const secure = /^(https|wss|grpcs)$/i.test(m[1]);
    return `${scheme(secure)}://${m[2]}${keepPath ? m[3] : ''}`;
  };
  if (k === '~ws' || k === '~sio' || k === '~pusher') {
    spec.value.url = swap((s) => (s ? 'wss' : 'ws'), true);
    if (k === '~pusher' && !/\/app\//.test(spec.value.url)) spec.value.url = spec.value.url.replace(/\/*$/, '') + (spec.value.url.endsWith('://') ? 'localhost:8080/app/{{REVERB_APP_KEY}}' : '/app/{{REVERB_APP_KEY}}');
    spec.value.socketIo = k === '~sio' || undefined;
    spec.value.pusher = k === '~pusher' ? (spec.value.pusher ?? { channels: [], secret: '{{REVERB_APP_SECRET}}' }) : undefined;
    spec.value.method = 'GET';
  } else if (k === '~grpc') {
    spec.value.url = swap((s) => (s ? 'grpcs' : 'grpc'), false);
    spec.value.socketIo = undefined;
    spec.value.pusher = undefined;
    spec.value.method = 'POST';
    if (spec.value.body.mode !== 'json') spec.value.body.mode = 'json';
    pane.value = 'body';
  } else {
    if (/^(wss?|grpcs?):\/\//i.test(url)) spec.value.url = swap((s) => (s ? 'https' : 'http'), !/^grpcs?:/i.test(url));
    spec.value.socketIo = undefined;
    spec.value.pusher = undefined;
    spec.value.grpc = undefined;
    spec.value.method = k as typeof spec.value.method;
  }
  touch();
}
// ---- gRPC (#98): the server's services (reflection, or the .proto files picked), and the method this request calls.
const grpcOn = computed(() => isGrpc(props.tab));
const grpcServices = ref<import('@shared/types').GrpcServiceInfo[]>([]);
const grpcSource = ref<'reflection' | 'files' | null>(null);
const grpcBusy = ref(false);
const grpcError = ref('');
const grpcService = computed(() => grpcServices.value.find((s) => s.name === spec.value.grpc?.service) ?? null);
const grpcMethod = computed(() => grpcService.value?.methods.find((m) => m.name === spec.value.grpc?.method) ?? null);
function setGrpc(patch: { service?: string; method?: string; protoFiles?: string[] }) {
  spec.value.grpc = { ...(spec.value.grpc ?? {}), ...patch };
  touch();
}
async function loadGrpc(files?: string[]) {
  grpcBusy.value = true;
  grpcError.value = '';
  try {
    const url = wireFor(props.tab).url.split('?')[0];
    const protoFiles = files ?? spec.value.grpc?.protoFiles;
    const r = await window.dialcatz.grpcDescribe(url, plain({ protoFiles, metadata: wireFor(props.tab).headers }));
    grpcServices.value = r.services;
    grpcSource.value = r.source;
    // Nothing picked yet (or gone): the first service and method.
    if (!r.services.some((s) => s.name === spec.value.grpc?.service)) setGrpc({ service: r.services[0]?.name, method: r.services[0]?.methods[0]?.name });
  } catch (e) {
    grpcError.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    grpcBusy.value = false;
  }
}
async function pickProto() {
  const files = await window.dialcatz.grpcPickProto();
  if (!files) return;
  setGrpc({ protoFiles: files });
  await loadGrpc(files);
}
function grpcExample() {
  if (!grpcMethod.value) return;
  spec.value.body.raw = grpcMethod.value.example;
  spec.value.body.mode = 'json';
  touch();
}
watch(grpcOn, (on) => {
  if (on) {
    if (spec.value.body.mode !== 'json') spec.value.body.mode = 'json';
    if (pane.value === 'params' || pane.value === 'scripts') pane.value = 'body';
  }
}, { immediate: true });
const wsState = computed(() => props.tab.ws?.state ?? 'idle');
// ---- Pusher (#99): channels joined on this connection, and the ones the request joins on Connect.
const newChannel = ref('');
const keepChannel = ref(true);
const joined = computed(() => props.tab.ws?.channels ?? []);
const saved = computed(() => spec.value.pusher?.channels ?? []);
async function joinChannel() {
  const c = newChannel.value.trim();
  if (!c) return;
  if (keepChannel.value && spec.value.pusher && !saved.value.includes(c)) {
    spec.value.pusher.channels = [...saved.value, c];
    touch();
  }
  await pusherChannel(props.tab, 'subscribe', c);
  newChannel.value = '';
}
function dropSaved(c: string) {
  if (!spec.value.pusher) return;
  spec.value.pusher.channels = saved.value.filter((x) => x !== c);
  touch();
}
function draft(v: string) {
  props.tab.ws ??= { state: 'idle', log: [], draft: '' };
  props.tab.ws.draft = v;
}
// The first message kept with the request: what a run on its own (the CLI, dialcatz run) sends once connected.
const keptMessage = computed(() => spec.value.wsMessage ?? null);
const messageIsKept = computed(() => {
  const k = keptMessage.value;
  return !!k && k.text === (props.tab.ws?.draft ?? '') && (k.event ?? '') === (props.tab.ws?.event ?? '') && (k.channel ?? '') === (props.tab.ws?.channel ?? '');
});
function keepMessage() {
  const w = props.tab.ws;
  spec.value.wsMessage = { text: w?.draft ?? '', ...(w?.event?.trim() ? { event: w.event.trim() } : {}), ...(w?.channel ? { channel: w.channel } : {}) };
  touch();
}
function dropMessage() {
  delete spec.value.wsMessage;
  touch();
}
// A tab opened on a request with a kept message starts with it in the Message pane.
watch(
  () => props.tab.id,
  () => {
    const k = spec.value.wsMessage;
    if (k && !props.tab.ws) props.tab.ws = { state: 'idle', log: [], draft: k.text, ...(k.event ? { event: k.event } : {}), ...(k.channel ? { channel: k.channel } : {}) };
  },
  { immediate: true },
);
watch(
  () => activeTab.value?.id,
  () => (pane.value = spec.value.body.mode !== 'none' && !['GET', 'HEAD'].includes(spec.value.method) ? 'body' : 'params'),
  { immediate: true },
);
defineExpose({ focusUrl: () => urlInput.value?.select() });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- Address bar -->
    <div class="flex items-center gap-2 px-4 pt-3 pb-2">
      <div class="url-bar flex-1">
        <select class="method-select font-mono" :class="kind.startsWith('~') ? '' : methodClass" :style="`field-sizing: content;${kind.startsWith('~') ? ' color: var(--color-primary)' : ''}`" :value="kind" :disabled="readOnly" title="An HTTP method, or another kind of request" @change="setKind(($event.target as HTMLSelectElement).value)">
          <optgroup label="HTTP">
            <option v-for="m in HTTP_METHODS" :key="m" :value="m">{{ m }}</option>
          </optgroup>
          <optgroup label="Other protocols">
            <option value="~ws">{{ kind === '~ws' ? 'WS' : 'WebSocket' }}</option>
            <option value="~sio">{{ kind === '~sio' ? 'SIO' : 'Socket.IO' }}</option>
            <option value="~pusher">{{ kind === '~pusher' ? 'PSH' : 'Pusher (Reverb)' }}</option>
            <option value="~grpc">gRPC</option>
          </optgroup>
        </select>
        <VarInput ref="urlInput" class="url-input" :model-value="spec.url" :placeholder="KIND_HINT[kind] ?? 'https://api.example.com/users or {{baseUrl}}/users — or paste a cURL command'" @update:model-value="setUrl" @enter="sendTab(tab)" />
      </div>
      <button v-if="ws" class="btn btn-sm h-9 min-w-28 gap-1.5" :class="wsState === 'open' || wsState === 'connecting' ? 'btn-error btn-soft' : 'btn-primary'" @click="sendTab(tab)">
        <template v-if="wsState === 'connecting'"><span class="loading loading-spinner loading-xs" />Cancel</template>
        <template v-else-if="wsState === 'open'">Disconnect</template>
        <template v-else><Icon name="link" class="size-4" />Connect</template>
      </button>
      <button v-else class="btn btn-primary btn-sm h-9 min-w-24 gap-1.5" :title="`Send (${keyLabel('mod+enter')})`" @click="sendTab(tab)">
        <template v-if="tab.sending"><span class="loading loading-spinner loading-xs" />Cancel</template>
        <template v-else><Icon name="send" class="size-4" />Send</template>
      </button>
      <button class="btn btn-ghost btn-sm h-9 gap-1.5" :disabled="readOnly || (!tab.dirty && !!tab.itemId)" :title="`Save (${keyLabel('mod+S')})`" @click="emit('save')"><Icon name="save" class="size-4" />Save</button>
    </div>

    <!-- Request parts -->
    <div class="flex items-center gap-3 px-4 pb-2">
      <div class="seg seg-xs" role="tablist">
        <button v-if="!grpcOn" role="tab" class="seg-item" :class="{ 'is-active': pane === 'params' }" @click="pane = 'params'">Params<span v-if="count(spec.params)" class="pane-count">{{ count(spec.params) }}</span></button>
        <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'headers' }" @click="pane = 'headers'">{{ grpcOn ? 'Metadata' : 'Headers' }}<span v-if="count(spec.headers)" class="pane-count">{{ count(spec.headers) }}</span></button>
        <button v-if="ws || grpcOn" role="tab" class="seg-item" :class="{ 'is-active': pane === 'body' }" @click="pane = 'body'">Message</button>
        <button v-else role="tab" class="seg-item" :class="{ 'is-active': pane === 'body' }" @click="pane = 'body'">Body<span v-if="spec.body.mode !== 'none'" class="pane-dot" /></button>
        <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'auth' }" @click="pane = 'auth'">Auth<span v-if="!['none', 'inherit'].includes(spec.auth.mode)" class="pane-dot" /></button>
        <button v-if="!ws" role="tab" class="seg-item" :class="{ 'is-active': pane === 'scripts' }" @click="pane = 'scripts'">Scripts<span v-if="spec.preRequest?.trim() || spec.tests?.trim()" class="pane-dot" /></button>
        <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'code' }" @click="pane = 'code'">Code</button>
      </div>
      <span v-if="readOnly" class="badge badge-soft badge-sm gap-1"><Icon name="lock" class="size-3" />View only</span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto px-4 pb-3">
      <KeyValueTable v-if="pane === 'params'" :model-value="spec.params" key-placeholder="Parameter" @update:model-value="setParams" />
      <template v-else-if="pane === 'headers'">
        <KeyValueTable :model-value="spec.headers" key-placeholder="Header" :suggestions="COMMON_HEADERS" @update:model-value="setHeaders" />
        <button class="auto-head" @click="showAuto = !showAuto">
          <Icon name="chevron" class="tree-chev size-3.5" :class="{ 'is-open': showAuto }" />Auto headers<span class="pane-count">{{ autoOnCount }}</span>
          <span class="font-normal opacity-70">— added when sent; switch one off, or add the same header above to change it</span>
        </button>
        <div v-if="showAuto" class="kv-table mt-2">
          <div v-for="r in autoRows" :key="r.key" class="auto-row" :class="{ 'is-off': !r.on, 'is-over': r.over }">
            <input v-if="!r.computed" type="checkbox" class="toggle toggle-xs toggle-primary" :checked="r.on" :disabled="readOnly" :title="r.on ? 'Sent' : 'Not sent'" @change="setAuto(r.key, ($event.target as HTMLInputElement).checked)" />
            <Icon v-else name="lock" class="size-3.5 opacity-40" />
            <span class="truncate font-mono">{{ r.key }}</span>
            <span class="truncate font-mono" :class="{ italic: r.computed }">{{ r.value }}</span>
            <span class="pr-3 text-[11px] opacity-50">{{ r.over ? 'overridden above' : r.computed ? 'calculated' : '' }}</span>
          </div>
        </div>
      </template>

      <div v-else-if="pane === 'body' && grpcOn" class="flex h-full min-h-48 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <select class="select select-sm min-w-48 flex-1 font-mono" :value="spec.grpc?.service ?? ''" :disabled="readOnly || !grpcServices.length" @change="(e) => { const s = grpcServices.find((x) => x.name === (e.target as HTMLSelectElement).value); setGrpc({ service: s?.name, method: s?.methods[0]?.name }); }">
            <option v-if="!grpcServices.length" :value="spec.grpc?.service ?? ''">{{ spec.grpc?.service || 'Service' }}</option>
            <option v-for="s in grpcServices" :key="s.name" :value="s.name">{{ s.name }}</option>
          </select>
          <select class="select select-sm min-w-40 flex-1 font-mono" :value="spec.grpc?.method ?? ''" :disabled="readOnly || !grpcService" @change="(e) => setGrpc({ method: (e.target as HTMLSelectElement).value })">
            <option v-if="!grpcService" :value="spec.grpc?.method ?? ''">{{ spec.grpc?.method || 'Method' }}</option>
            <option v-for="m in grpcService?.methods ?? []" :key="m.name" :value="m.name" :disabled="m.clientStreaming">{{ m.name }}{{ m.serverStreaming ? ' (server stream)' : m.clientStreaming ? ' (client stream: not supported)' : '' }}</option>
          </select>
          <button class="btn btn-ghost btn-sm gap-1.5" :disabled="grpcBusy" title="Ask the server for its services (server reflection)" @click="loadGrpc()"><span v-if="grpcBusy" class="loading loading-spinner loading-xs" /><Icon v-else name="refresh" class="size-4" />{{ grpcServices.length ? 'Reload' : 'Load from server' }}</button>
          <button class="btn btn-ghost btn-sm gap-1.5" :disabled="readOnly" title="The server has no reflection: use its .proto files" @click="pickProto"><Icon name="file" class="size-4" />.proto files…</button>
          <button v-if="grpcMethod" class="btn btn-ghost btn-xs" :disabled="readOnly" title="A message with every field of the request type" @click="grpcExample">Example</button>
        </div>
        <p v-if="grpcError" class="text-xs text-error">{{ grpcError }}</p>
        <p v-else-if="grpcMethod" class="text-xs opacity-60"><span class="font-mono">{{ grpcMethod.requestType }}</span> → <span class="font-mono">{{ grpcMethod.responseType }}</span><template v-if="grpcSource === 'files'"> · from {{ spec.grpc?.protoFiles?.length }} .proto file{{ (spec.grpc?.protoFiles?.length ?? 0) > 1 ? 's' : '' }}</template><template v-else-if="grpcSource"> · from the server's reflection</template></p>
        <p v-else-if="!grpcServices.length" class="text-xs opacity-60">Load the server's services (reflection), or choose its .proto files. Metadata goes in the Metadata tab; auth (bearer) is sent as authorization metadata.</p>
        <CodeEditor v-model="spec.body.raw" language="json" class="min-h-40 flex-1 rounded-xl border border-base-300/70" :known="knownVar" placeholder="{ &quot;name&quot;: &quot;{{name}}&quot; }" @update:model-value="touch" @run="sendTab(tab)" />
      </div>

      <div v-else-if="pane === 'body' && ws" class="flex h-full min-h-40 flex-col gap-2">
        <!-- Pusher (#99): channels to join (the request's own join on Connect), the secret for private / presence ones. -->
        <div v-if="spec.pusher" class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="label-caps shrink-0">Channel</span>
            <input v-model="newChannel" class="input input-sm min-w-48 flex-1 font-mono" placeholder="orders · private-user.1 · presence-room" spellcheck="false" @keydown.enter="joinChannel" />
            <button class="btn btn-sm" :disabled="wsState !== 'open' || !newChannel.trim()" @click="joinChannel">Subscribe</button>
            <label class="flex cursor-pointer items-center gap-1.5 text-xs" title="Join this channel every time the request connects"><input v-model="keepChannel" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />Save in the request</label>
          </div>
          <div v-if="joined.length || saved.length" class="flex flex-wrap gap-1.5">
            <span v-for="c in [...new Set([...saved, ...joined])]" :key="c" class="pusher-chip" :class="{ 'is-on': joined.includes(c) }" :title="joined.includes(c) ? 'Subscribed' : 'Joins on Connect'">
              <span class="font-mono">{{ c }}</span>
              <button v-if="joined.includes(c)" title="Unsubscribe" @click="pusherChannel(tab, 'unsubscribe', c)"><Icon name="x" class="size-3" /></button>
              <button v-else-if="saved.includes(c)" title="Stop joining it" @click="dropSaved(c)"><Icon name="x" class="size-3" /></button>
            </span>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <span class="label-caps shrink-0">App secret</span>
            <input :value="spec.pusher.secret ?? ''" class="input input-sm min-w-48 flex-1 font-mono" placeholder="{{REVERB_APP_SECRET}}" spellcheck="false" :disabled="readOnly" @input="(e) => ((spec.pusher!.secret = (e.target as HTMLInputElement).value), touch())" />
            <span class="label-caps shrink-0">Presence user</span>
            <input :value="spec.pusher.userId ?? ''" class="input input-sm w-32 font-mono" placeholder="dialcatz" spellcheck="false" :disabled="readOnly" @input="(e) => ((spec.pusher!.userId = (e.target as HTMLInputElement).value || undefined), touch())" />
          </div>
          <p v-if="spec.pusher.secret && !/^\s*\{\{[^}]+\}\}\s*$/.test(spec.pusher.secret)" class="text-xs text-warning">Use a <code v-pre>{{variable}}</code> for the secret, so it stays in your environment and not in the request.</p>
          <div class="flex flex-wrap items-center gap-2">
            <span class="label-caps shrink-0">Client event</span>
            <select class="select select-sm w-48 font-mono" :value="tab.ws?.channel ?? ''" @change="(e) => ((tab.ws ??= { state: 'idle', log: [], draft: '' }), (tab.ws.channel = (e.target as HTMLSelectElement).value))">
              <option value="">Channel…</option>
              <option v-for="c in joined.filter((x) => /^(private|presence)-/.test(x))" :key="c" :value="c">{{ c }}</option>
            </select>
            <input :value="tab.ws?.event ?? ''" class="input input-sm min-w-40 flex-1 font-mono" placeholder="client-typing" spellcheck="false" @input="(e) => ((tab.ws ??= { state: 'idle', log: [], draft: '' }), (tab.ws.event = (e.target as HTMLInputElement).value))" />
          </div>
        </div>
        <div v-if="spec.socketIo" class="flex flex-wrap items-center gap-3">
          <label class="flex min-w-60 flex-1 items-center gap-2">
            <span class="label-caps shrink-0">Event</span>
            <input :value="tab.ws?.event ?? ''" class="input input-sm flex-1 font-mono" placeholder="chat message" spellcheck="false" @input="(e) => ((tab.ws ??= { state: 'idle', log: [], draft: '' }), (tab.ws.event = (e.target as HTMLInputElement).value))" @keydown.enter="sendWs(tab)" />
          </label>
        </div>
        <CodeEditor :model-value="tab.ws?.draft ?? ''" :language="/^\s*[[{]/.test(tab.ws?.draft ?? '') ? 'json' : 'text'" :known="knownVar" class="min-h-28 flex-1 rounded-xl border border-base-300/70" :placeholder="spec.pusher ? 'The client event’s data (JSON)' : spec.socketIo ? 'The event’s args: a JSON list sends several, other JSON or text sends one (optional)' : 'A message to send ({{variables}} work here too)'" @update:model-value="draft" @run="sendWs(tab)" />
        <div class="flex items-center gap-2">
          <span class="text-xs opacity-50">{{ wsState === 'open' ? `Connected. ${keyLabel('mod+enter')} sends.` : spec.pusher ? 'Connect first. The address ends in /app/<key>; private and presence channels are signed with the app secret.' : spec.socketIo ? 'Connect first. The address is the server and namespace (ws://host:3000/chat); DialCatz adds /socket.io/ and answers the pings.' : 'Connect first. The request’s headers and auth go with the handshake; set Sec-WebSocket-Protocol for subprotocols.' }}</span>
          <span class="flex-1" />
          <button v-if="keptMessage && messageIsKept" class="btn btn-ghost btn-sm" title="Runs of this request on their own (the CLI, dialcatz run) send this message once connected. Click to stop keeping it." @click="dropMessage"><Icon name="check" class="size-4" />Kept with the request</button>
          <button v-else class="btn btn-ghost btn-sm" :disabled="spec.pusher ? !tab.ws?.event?.trim() || !tab.ws?.channel : spec.socketIo ? !tab.ws?.event?.trim() : !tab.ws?.draft" title="Keeps this message with the request: the CLI (dialcatz run) sends it once connected" @click="keepMessage">Keep with the request</button>
          <button class="btn btn-primary btn-sm gap-1.5" :disabled="wsState !== 'open' || (spec.pusher ? !tab.ws?.event?.trim() || !tab.ws?.channel : spec.socketIo ? !tab.ws?.event?.trim() : !tab.ws?.draft)" @click="sendWs(tab)"><Icon name="send" class="size-4" />{{ spec.pusher ? 'Trigger client event' : spec.socketIo ? 'Emit event' : 'Send message' }}</button>
        </div>
      </div>

      <div v-else-if="pane === 'body'" class="flex h-full min-h-48 flex-col gap-2">
        <div class="flex items-center gap-2">
          <div class="seg seg-xs seg-choice">
            <button v-for="m in (['none', 'json', 'text', 'xml', 'form', 'multipart', 'graphql', 'jsonrpc', 'binary'] as BodyMode[])" :key="m" role="tab" class="seg-item normal-case" :class="{ 'is-active': spec.body.mode === m }" @click="setBodyMode(m)">
              {{ { none: 'None', json: 'JSON', text: 'Text', xml: 'XML', form: 'Form URL-encoded', multipart: 'Multipart', graphql: 'GraphQL', jsonrpc: 'JSON-RPC', binary: 'Binary' }[m] }}
            </button>
          </div>
          <span class="flex-1" />
          <span v-if="bodyIsJsonBad" class="truncate text-xs text-error" :title="bodyIsJsonBad">Not valid JSON</span>
          <button v-if="aiOn('body') && !readOnly && ['json', 'text', 'xml', 'form', 'multipart'].includes(spec.body.mode)" class="btn btn-ghost btn-xs gap-1" :disabled="aiBusy === 'body'" title="Write a body from a sentence (AI)" @click="bodyAsk = bodyAsk === null ? '' : null"><span v-if="aiBusy === 'body'" class="loading loading-spinner loading-xs" /><span v-else class="text-primary">✦</span>Generate</button>
          <button v-if="spec.body.mode === 'json'" class="btn btn-ghost btn-xs" @click="beautify">Beautify</button>
        </div>
        <div v-if="bodyAsk !== null" class="flex items-center gap-2">
          <input v-model="bodyAsk" class="input input-sm flex-1" placeholder="Describe the body, e.g. “a new user with name, email and two addresses”" autofocus @keydown.enter="generateBody" @keydown.esc="bodyAsk = null" />
          <button class="btn btn-primary btn-sm" :disabled="!bodyAsk.trim() || aiBusy === 'body'" @click="generateBody">Write it</button>
        </div>
        <p v-if="['GET', 'HEAD'].includes(spec.method) && spec.body.mode !== 'none'" class="text-xs opacity-60">{{ spec.method }} requests are sent without a body.</p>
        <p v-if="spec.body.mode === 'none'" class="py-6 text-center text-sm opacity-50">This request has no body.</p>
        <CodeEditor
          v-else-if="['json', 'text', 'xml'].includes(spec.body.mode)"
          v-model="spec.body.raw"
          class="min-h-40 flex-1 rounded-xl border border-base-300/70"
          :language="spec.body.mode === 'json' ? 'json' : spec.body.mode === 'xml' ? 'xml' : 'text'"
          :known="knownVar"
          :placeholder="spec.body.mode === 'json' ? '{ &quot;name&quot;: &quot;{{name}}&quot; }' : ''"
          @update:model-value="touch"
          @run="sendTab(tab)"
        />
        <template v-else-if="spec.body.mode === 'graphql'">
          <div class="flex min-h-0 flex-1 gap-3">
            <div class="flex min-w-0 flex-[3] flex-col gap-1">
              <span class="label-caps">Query</span>
              <CodeEditor v-model="spec.body.raw" class="min-h-40 flex-1 rounded-xl border border-base-300/70" :known="knownVar" placeholder="query { users { id name } }" @update:model-value="touch" @run="sendTab(tab)" />
            </div>
            <div class="flex min-w-0 flex-[2] flex-col gap-1">
              <span class="label-caps">Variables (JSON)<span v-if="varsBad" class="ml-2 normal-case text-error" :title="varsBad">not valid JSON</span></span>
              <CodeEditor :model-value="spec.body.variables ?? ''" language="json" class="min-h-40 flex-1 rounded-xl border border-base-300/70" :known="knownVar" placeholder="{ &quot;id&quot;: 1 }" @update:model-value="(v) => ((spec.body.variables = v), touch())" @run="sendTab(tab)" />
            </div>
          </div>
          <p class="text-xs opacity-50">Sent as JSON: <code>{ "query": …, "variables": … }</code> (usually with POST).</p>
        </template>
        <template v-else-if="spec.body.mode === 'jsonrpc'">
          <div class="flex flex-wrap items-center gap-3">
            <label v-if="!spec.body.rpcBatch" class="flex min-w-60 flex-1 items-center gap-2">
              <span class="label-caps shrink-0">Method</span>
              <input :value="spec.body.rpcMethod ?? ''" class="input input-sm flex-1 font-mono" placeholder="user.get" spellcheck="false" :disabled="readOnly" @input="(e) => ((spec.body.rpcMethod = (e.target as HTMLInputElement).value), touch())" />
            </label>
            <label class="flex cursor-pointer items-center gap-1.5 text-xs" title="Send a list of calls in one request; each gets its own id">
              <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="spec.body.rpcBatch === true" :disabled="readOnly" @change="(e) => ((spec.body.rpcBatch = (e.target as HTMLInputElement).checked || undefined), touch())" />Batch
            </label>
            <label v-if="!spec.body.rpcBatch" class="flex cursor-pointer items-center gap-1.5 text-xs" title="No id: the server does not answer it">
              <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="spec.body.rpcNotify === true" :disabled="readOnly" @change="(e) => ((spec.body.rpcNotify = (e.target as HTMLInputElement).checked || undefined), touch())" />Notification
            </label>
          </div>
          <span class="label-caps">{{ spec.body.rpcBatch ? 'Calls (JSON list)' : 'Params (JSON)' }}<span v-if="rpcBad" class="ml-2 normal-case text-error" :title="rpcBad">{{ rpcBad }}</span></span>
          <CodeEditor v-model="spec.body.raw" language="json" class="min-h-40 flex-1 rounded-xl border border-base-300/70" :known="knownVar" :placeholder="spec.body.rpcBatch ? '[{ &quot;method&quot;: &quot;user.get&quot;, &quot;params&quot;: { &quot;id&quot;: 1 } }, { &quot;method&quot;: &quot;user.list&quot; }]' : '{ &quot;id&quot;: 1 }'" @update:model-value="touch" @run="sendTab(tab)" />
          <p class="text-xs opacity-50">Sent as <code>{ "jsonrpc": "2.0", "method": …, "params": …, "id": … }</code><template v-if="spec.body.rpcBatch"> for each call, ids 1, 2, …</template> (usually with POST). Replies are matched to their call by id.</p>
        </template>
        <div v-else-if="spec.body.mode === 'binary'" class="flex flex-col items-start gap-2 py-4">
          <button class="btn btn-sm gap-2" :disabled="readOnly" @click="pickBinary"><Icon name="file" class="size-4" />{{ spec.body.file ? 'Change file…' : 'Choose a file…' }}</button>
          <span class="font-mono text-xs" :class="spec.body.file ? '' : 'opacity-50'">{{ spec.body.file || 'No file picked on this computer. The file is sent as it is (Content-Type application/octet-stream unless you set one).' }}</span>
        </div>
        <template v-else>
          <KeyValueTable :model-value="spec.body.fields" key-placeholder="Field" :allow-files="spec.body.mode === 'multipart'" @update:model-value="(rows) => ((spec.body.fields = rows), touch())" />
          <p class="text-xs opacity-50">Arrays: repeat a key — <code>tags[]</code> = a, <code>tags[]</code> = b. Objects: <code>user[name]</code>, <code>user[email]</code>.<template v-if="spec.body.mode === 'multipart'"> Switch a row to File to send a file.</template></p>
        </template>
      </div>

      <div v-else-if="pane === 'scripts'" class="flex h-full min-h-48 flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <div class="seg seg-xs seg-choice">
            <button role="tab" class="seg-item normal-case" :class="{ 'is-active': scriptTab === 'pre' }" @click="scriptTab = 'pre'">Pre-request<span v-if="spec.preRequest?.trim()" class="pane-dot" /></button>
            <button role="tab" class="seg-item normal-case" :class="{ 'is-active': scriptTab === 'tests' }" @click="scriptTab = 'tests'">Tests<span v-if="spec.tests?.trim()" class="pane-dot" /></button>
          </div>
          <span class="flex-1" />
          <button v-for="sn in SNIPPETS[scriptTab]" :key="sn.label" class="btn btn-ghost btn-xs" :disabled="readOnly" @click="addSnippet(sn.code)">+ {{ sn.label }}</button>
          <button v-if="aiOn('tests') && scriptTab === 'tests' && !readOnly" class="btn btn-ghost btn-xs gap-1" :disabled="aiBusy === 'tests'" title="Write tests from the last response (AI)" @click="writeTests"><span v-if="aiBusy === 'tests'" class="loading loading-spinner loading-xs" /><span v-else class="text-primary">✦</span>Write tests</button>
        </div>
        <CodeEditor
          :model-value="(scriptTab === 'pre' ? spec.preRequest : spec.tests) ?? ''"
          :readonly="readOnly"
          class="min-h-40 flex-1 rounded-xl border border-base-300/70"
          :placeholder="scriptTab === 'pre' ? '// Runs before the request is built. dc.env.set(name, value) sets a variable for it.' : '// Runs after the response. dc.test(name, () => dc.expect(dc.response.status).toBe(200))'"
          @update:model-value="(v: string) => ((scriptTab === 'pre' ? (spec.preRequest = v) : (spec.tests = v)), touch())"
          @run="sendTab(tab)"
        />
        <p class="text-xs opacity-50">JavaScript in a sandbox (no network, no access to DialCatz). <code>dc.response</code> (status, headers, body, json(), time), <code>dc.env.get/set</code>, <code>dc.test</code>, <code>dc.expect</code>, <code>dc.log</code>. Basic Postman <code>pm.*</code> scripts work too.</p>
      </div>

      <AuthEditor v-else-if="pane === 'auth'" class="max-w-2xl pt-1" :model-value="spec.auth" :inherited-label="inherited" :item-id="tab.itemId" @update:model-value="setAuth" />

      <div v-else class="flex h-full min-h-48 flex-col gap-2">
        <div class="flex items-center gap-2">
          <div class="seg seg-xs seg-choice">
            <button v-for="l in codeLangs" :key="l" role="tab" class="seg-item normal-case" :class="{ 'is-active': codeLang === l }" @click="codeLang = l">{{ CODE_LABEL[l] }}</button>
          </div>
          <span class="flex-1 text-xs opacity-50">With the active environment’s values filled in.</span>
          <button class="btn btn-ghost btn-xs gap-1" @click="copyCode"><Icon name="copy" class="size-3.5" />Copy</button>
        </div>
        <CodeEditor :model-value="code" readonly class="min-h-40 flex-1 rounded-xl border border-base-300/70" />
      </div>
    </div>
    <p v-if="!workspace" class="p-4 text-sm opacity-60">No workspace.</p>
  </div>
</template>

<style scoped>
.pusher-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  border-radius: 999px;
  font-size: 12px;
  background: oklch(from var(--color-base-content) l c h / 0.07);
}
.pusher-chip.is-on {
  color: var(--primary-ink, var(--color-primary));
  background: oklch(from var(--color-primary) l c h / 0.14);
}
</style>
