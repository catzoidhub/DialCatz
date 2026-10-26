<script setup lang="ts">
import { computed, ref } from 'vue';
import { uid, type TreeItem } from '@shared/types';
import { envFor, execute, notify, plain, workspace } from '../state';
import CatMood from './CatMood.vue';

/**
 * The collection runner: every request of a collection or folder in the tree's order (folders depth first),
 * each with its scripts (collection, folders, its own), for a number of iterations, with an optional delay; variables
 * set by one request's scripts are there for the next. A data file (CSV / JSON) gives one row per iteration, its
 * columns as {{variables}} and pm.iterationData. Results stream in as rows and export as JSON or JUnit XML.
 */
const props = defineProps<{ root: TreeItem }>();
const emit = defineEmits<{ close: [] }>();

interface Row {
  key: string;
  iteration: number;
  name: string;
  method: string;
  status: number | null;
  time: number;
  passed: number;
  failed: number;
  error?: string;
  failures: string[];
  tests: { name: string; pass: boolean; error?: string }[];
  url: string;
  at: string;
}

const requests = computed(() => {
  const items = workspace.value?.items ?? [];
  const out: TreeItem[] = [];
  const walk = (parentId: string) => {
    for (const i of items.filter((x) => x.parentId === parentId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
      if (i.kind === 'request') out.push(i);
      else walk(i.id);
    }
  };
  walk(props.root.id);
  return out;
});
const picked = ref(new Set(requests.value.map((r) => r.id)));
const iterations = ref(1);
/** The data file: one row per iteration (its row count sets the iterations). */
const DATA_HINT = 'One iteration per row; its columns are {{variables}} and pm.iterationData.';
const data = ref<{ name: string; rows: Record<string, string>[]; columns: string[] } | null>(null);
const dataError = ref('');
async function pickData() {
  dataError.value = '';
  try {
    const d = await window.dialcatz.pickDataFile();
    if (!d) return;
    data.value = d;
    iterations.value = d.rows.length;
  } catch (e) {
    dataError.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}
function dropData() {
  data.value = null;
  iterations.value = 1;
}
const delay = ref(0);
const stopOnFail = ref(false);
const running = ref(false);
const stop = ref(false);
const rows = ref<Row[]>([]);
const token = uid('run_');

const totals = computed(() => ({
  requests: rows.value.length,
  passed: rows.value.reduce((n, r) => n + r.passed, 0),
  failed: rows.value.reduce((n, r) => n + r.failed, 0),
  errors: rows.value.filter((r) => r.error || (r.status ?? 0) >= 400).length,
  time: rows.value.reduce((n, r) => n + r.time, 0),
}));
const done = computed(() => !running.value && rows.value.length > 0);

async function run() {
  running.value = true;
  stop.value = false;
  rows.value = [];
  const list = requests.value.filter((r) => picked.value.has(r.id));
  outer: for (let it = 1; it <= iterations.value; it++) {
    for (const item of list) {
      if (stop.value) break outer;
      const row0 = data.value?.rows[(it - 1) % data.value.rows.length];
      const at = new Date().toISOString();
      const { result, scripts } = await execute(plain(item.request!), item.id, token, row0);
      const tests = [...(scripts.pre?.tests ?? []), ...(scripts.tests?.tests ?? [])];
      const row: Row = {
        key: `${it}-${item.id}`,
        iteration: it,
        name: item.name,
        method: item.request!.method,
        status: result.response?.status ?? null,
        time: result.response?.timings.total ?? 0,
        passed: tests.filter((t) => t.pass).length,
        failed: tests.filter((t) => !t.pass).length,
        error: result.error ?? scripts.pre?.error ?? scripts.tests?.error ?? undefined,
        failures: tests.filter((t) => !t.pass).map((t) => `${t.name}: ${t.error}`),
        tests,
        url: result.sent?.url ?? item.request!.url,
        at,
      };
      rows.value.push(row);
      if (stopOnFail.value && (row.failed || row.error)) break outer;
      if (delay.value > 0) await new Promise((r) => setTimeout(r, delay.value));
    }
  }
  running.value = false;
}
function cancel() {
  stop.value = true;
  void window.dialcatz.cancel(token);
}
function toggle(id: string, on: boolean) {
  const s = new Set(picked.value);
  if (on) s.add(id);
  else s.delete(id);
  picked.value = s;
}
// ---- export: JSON (everything) or JUnit XML (one test case per request and iteration, for CI tools).
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const file = (ext: string) => `${props.root.name.replace(/[^\w.-]+/g, '-')}-run-${stamp()}.${ext}`;
async function exportJson() {
  const out = {
    collection: props.root.name,
    environment: envFor(props.root.id)?.name ?? null,
    dataFile: data.value?.name ?? null,
    finishedAt: new Date().toISOString(),
    totals: totals.value,
    results: rows.value.map(({ key: _k, ...r }) => r),
  };
  if (await window.dialcatz.saveText(file('json'), JSON.stringify(out, null, 2))) notify('success', 'Results saved');
}
const xml = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function exportJunit() {
  const cases = rows.value.map((r) => {
    const name = `${r.method} ${r.name}${iterations.value > 1 ? ` [${r.iteration}]` : ''}`;
    const fails = [...(r.error ? [`Request: ${r.error}`] : []), ...r.failures];
    const body = fails.length ? `\n      <failure message="${xml(fails[0])}">${xml(fails.join('\n'))}</failure>\n    ` : '';
    return `    <testcase classname="${xml(props.root.name)}" name="${xml(name)}" time="${(r.time / 1000).toFixed(3)}">${body}</testcase>`;
  });
  const failures = rows.value.filter((r) => r.failed || r.error).length;
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="DialCatz" tests="${rows.value.length}" failures="${failures}" time="${(totals.value.time / 1000).toFixed(3)}">\n  <testsuite name="${xml(props.root.name)}" tests="${rows.value.length}" failures="${failures}" timestamp="${new Date().toISOString()}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
  if (await window.dialcatz.saveText(file('xml'), text)) notify('success', 'Results saved');
}

const tone = (r: Row) => (r.error || r.failed ? 'is-bad' : (r.status ?? 0) >= 400 ? 'is-warn' : 'is-ok');
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!running && emit('close')">
    <div class="modal-box flex max-h-[88vh] w-[56rem] max-w-[96vw] flex-col gap-4">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">Run “{{ root.name }}”</h3>
        <p class="text-sm opacity-60">{{ requests.length }} request{{ requests.length === 1 ? '' : 's' }} in tree order · environment: {{ envFor(root.id)?.name ?? 'none' }}. Variables a script sets are there for the next request.</p>
      </div>

      <div v-if="!rows.length && !running" class="grid min-h-0 gap-4 md:grid-cols-[1fr_16rem]">
        <div class="min-h-0 overflow-auto rounded-xl border border-base-300/70">
          <label v-for="r in requests" :key="r.id" class="flex items-center gap-3 border-b border-base-300/50 px-3 py-1.5 last:border-0">
            <input type="checkbox" class="checkbox checkbox-xs" :checked="picked.has(r.id)" @change="toggle(r.id, ($event.target as HTMLInputElement).checked)" />
            <span class="tree-method w-12 font-mono" :class="`m-${r.request?.method.toLowerCase()}`">{{ r.request?.method }}</span>
            <span class="min-w-0 flex-1 truncate text-sm">{{ r.name }}</span>
            <span v-if="r.request?.tests?.trim()" class="badge badge-ghost badge-xs">tests</span>
          </label>
          <p v-if="!requests.length" class="p-6 text-center text-sm opacity-50">No requests in here.</p>
        </div>
        <div class="space-y-3">
          <div class="space-y-1">
            <span class="label-caps">Data file</span>
            <div v-if="data" class="flex items-center gap-2 rounded-lg border border-base-300/70 px-2 py-1.5 text-xs">
              <span class="min-w-0 flex-1"><span class="block truncate font-medium">{{ data.name }}</span><span class="block truncate opacity-60">{{ data.rows.length }} rows · {{ data.columns.join(', ') }}</span></span>
              <button class="btn btn-ghost btn-xs btn-square" title="Remove the data file" @click="dropData">✕</button>
            </div>
            <button v-else class="btn btn-sm w-full" @click="pickData">Choose CSV or JSON…</button>
            <p v-if="dataError" class="text-xs text-error">{{ dataError }}</p>
            <p v-else class="text-xs opacity-50">{{ DATA_HINT }}</p>
          </div>
          <div class="opt-row"><span class="label-caps">Iterations</span><input v-model.number="iterations" type="number" min="1" :max="data ? 10000 : 100" class="input input-sm w-20" /></div>
          <div class="opt-row"><span class="label-caps">Delay (ms)</span><input v-model.number="delay" type="number" min="0" max="60000" step="100" class="input input-sm w-20" /></div>
          <div class="opt-row"><span class="label-caps">Stop on failure</span><input v-model="stopOnFail" type="checkbox" class="toggle toggle-sm toggle-primary" /></div>
        </div>
      </div>

      <template v-else>
        <div class="flex flex-wrap items-center gap-4 text-sm">
          <span v-if="running" class="flex items-center gap-2"><span class="loading loading-spinner loading-xs" />Running… {{ rows.length }} done</span>
          <span v-else-if="done" class="flex items-center gap-2"><CatMood :mood="totals.failed || totals.errors ? 'warning' : 'success'" class="size-7" />{{ totals.failed || totals.errors ? 'Finished with problems' : 'All good' }}</span>
          <span class="opacity-70">{{ totals.requests }} sent</span>
          <span class="text-success">{{ totals.passed }} passed</span>
          <span :class="totals.failed ? 'text-error' : 'opacity-50'">{{ totals.failed }} failed</span>
          <span class="opacity-60">{{ totals.time }} ms total</span>
        </div>
        <div class="min-h-0 flex-1 overflow-auto rounded-xl border border-base-300/70">
          <table class="table table-sm">
            <thead><tr><th v-if="iterations > 1">#</th><th>Request</th><th>Status</th><th>Time</th><th>Tests</th></tr></thead>
            <tbody>
              <tr v-for="r in rows" :key="r.key">
                <td v-if="iterations > 1" class="opacity-50">{{ r.iteration }}</td>
                <td>
                  <span class="tree-method mr-2 font-mono" :class="`m-${r.method.toLowerCase()}`">{{ r.method }}</span>{{ r.name }}
                  <span v-if="r.error" class="block font-mono text-xs text-error">{{ r.error }}</span>
                  <span v-for="(f, i) in r.failures" :key="i" class="block font-mono text-xs text-error">✗ {{ f }}</span>
                </td>
                <td><span class="status-mini font-mono" :class="tone(r)">{{ r.status ?? 'failed' }}</span></td>
                <td class="font-mono text-xs">{{ r.time }} ms</td>
                <td class="text-xs"><span class="text-success">{{ r.passed }}</span> / <span :class="r.failed ? 'text-error' : ''">{{ r.failed }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div class="modal-action mt-0">
        <button v-if="running" class="btn btn-sm btn-error btn-soft" @click="cancel">Stop</button>
        <template v-else>
          <button class="btn btn-ghost btn-sm" @click="emit('close')">Close</button>
          <div v-if="done" class="dropdown dropdown-top mr-auto">
            <button tabindex="0" class="btn btn-sm">Export results</button>
            <ul tabindex="0" class="dropdown-content menu z-50 mb-1 w-56 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl">
              <li><button @click="exportJson">JSON <span class="text-xs opacity-50">everything</span></button></li>
              <li><button @click="exportJunit">JUnit XML <span class="text-xs opacity-50">for CI tools</span></button></li>
            </ul>
          </div>
          <button v-if="done" class="btn btn-sm" @click="rows = []">Change selection</button>
          <button class="btn btn-primary btn-sm" :disabled="!picked.size" @click="run">{{ done ? 'Run again' : `Run ${picked.size} request${picked.size === 1 ? '' : 's'}` }}</button>
        </template>
      </div>
    </div>
    <div class="modal-backdrop" @click="!running && emit('close')" />
  </dialog>
</template>
