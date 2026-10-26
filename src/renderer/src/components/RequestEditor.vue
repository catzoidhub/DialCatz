<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { HTTP_METHODS, type BodyMode, type KeyValue, type RequestAuth } from '@shared/types';
import { AUTO_HEADERS, joinUrl, parseCurl, prettyJson, splitUrl, toCurl, toFetch, effectiveAuth } from '@shared/request';
import { activeTab, aiOn, appVersion, inheritedAuth, isWs, knownVar, notify, plain, readOnly, sendTab, sendWs, wireFor, workspace, type Tab } from '../state';
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
  if (/^\s*curl\s/.test(url)) {
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
  const label = { none: 'no auth', bearer: 'a Bearer token', basic: 'Basic auth', apikey: 'an API key', inherit: 'no auth' }[a.mode];
  return props.tab.itemId ? `Uses the auth of the folder or collection above: ${label}.` : 'Not saved in a collection yet: nothing to inherit (no auth).';
});

const codeLang = ref<'curl' | 'fetch'>('curl');
const code = computed(() => {
  const w = wireFor(props.tab);
  return codeLang.value === 'curl' ? toCurl(w) : toFetch(w);
});
async function copyCode() {
  await window.dialcatz.copyText(code.value);
  notify('success', 'Copied');
}

const methodClass = computed(() => `m-${spec.value.method.toLowerCase()}`);
const ws = computed(() => isWs(props.tab));
const wsState = computed(() => props.tab.ws?.state ?? 'idle');
function draft(v: string) {
  props.tab.ws ??= { state: 'idle', log: [], draft: '' };
  props.tab.ws.draft = v;
}
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
        <select class="method-select font-mono" :class="methodClass" :value="spec.method" :disabled="readOnly" @change="((spec.method = ($event.target as HTMLSelectElement).value as typeof spec.method), touch())">
          <option v-for="m in HTTP_METHODS" :key="m" :value="m">{{ m }}</option>
        </select>
        <VarInput ref="urlInput" class="url-input" :model-value="spec.url" placeholder="https://api.example.com/users or {{baseUrl}}/users — or paste a cURL command" @update:model-value="setUrl" @enter="sendTab(tab)" />
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
        <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'params' }" @click="pane = 'params'">Params<span v-if="count(spec.params)" class="pane-count">{{ count(spec.params) }}</span></button>
        <button role="tab" class="seg-item" :class="{ 'is-active': pane === 'headers' }" @click="pane = 'headers'">Headers<span v-if="count(spec.headers)" class="pane-count">{{ count(spec.headers) }}</span></button>
        <button v-if="ws" role="tab" class="seg-item" :class="{ 'is-active': pane === 'body' }" @click="pane = 'body'">Message</button>
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

      <div v-else-if="pane === 'body' && ws" class="flex h-full min-h-40 flex-col gap-2">
        <CodeEditor :model-value="tab.ws?.draft ?? ''" :language="/^\s*[[{]/.test(tab.ws?.draft ?? '') ? 'json' : 'text'" :known="knownVar" class="min-h-28 flex-1 rounded-xl border border-base-300/70" placeholder="A message to send ({{variables}} work here too)" @update:model-value="draft" @run="sendWs(tab)" />
        <div class="flex items-center gap-2">
          <span class="text-xs opacity-50">{{ wsState === 'open' ? `Connected. ${keyLabel('mod+enter')} sends.` : 'Connect first. The request’s headers and auth go with the handshake; set Sec-WebSocket-Protocol for subprotocols.' }}</span>
          <span class="flex-1" />
          <button class="btn btn-primary btn-sm gap-1.5" :disabled="wsState !== 'open' || !tab.ws?.draft" @click="sendWs(tab)"><Icon name="send" class="size-4" />Send message</button>
        </div>
      </div>

      <div v-else-if="pane === 'body'" class="flex h-full min-h-48 flex-col gap-2">
        <div class="flex items-center gap-2">
          <div class="seg seg-xs seg-choice">
            <button v-for="m in (['none', 'json', 'text', 'xml', 'form', 'multipart', 'graphql', 'binary'] as BodyMode[])" :key="m" role="tab" class="seg-item normal-case" :class="{ 'is-active': spec.body.mode === m }" @click="setBodyMode(m)">
              {{ { none: 'None', json: 'JSON', text: 'Text', xml: 'XML', form: 'Form URL-encoded', multipart: 'Multipart', graphql: 'GraphQL', binary: 'Binary' }[m] }}
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

      <AuthEditor v-else-if="pane === 'auth'" class="max-w-2xl pt-1" :model-value="spec.auth" :inherited-label="inherited" @update:model-value="setAuth" />

      <div v-else class="flex h-full min-h-48 flex-col gap-2">
        <div class="flex items-center gap-2">
          <div class="seg seg-xs seg-choice">
            <button role="tab" class="seg-item normal-case" :class="{ 'is-active': codeLang === 'curl' }" @click="codeLang = 'curl'">cURL</button>
            <button role="tab" class="seg-item normal-case" :class="{ 'is-active': codeLang === 'fetch' }" @click="codeLang = 'fetch'">JavaScript fetch</button>
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
