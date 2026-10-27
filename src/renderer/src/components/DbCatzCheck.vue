<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DbCatzConnection } from '@shared/types';
import type { Tab } from '../state';
import { collectionOf, notify, workspace } from '../state';
import { guessTable } from '../dbguess';
import { openDownload } from '../download';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';
import dbcatzLogo from '../assets/logos/dbcatz.png';

/**
 * "Check in DBCatz" after a call (Catzoid ecosystem, DialCatz → DBCatz): opens the table the call touched, at its
 * row when the URL (or a create call's answer) has an id. The collection remembers its DBCatz connection and
 * database, a request its table when the guess was wrong — both on this computer only. The first time, or from the
 * menu arrow, a small dialog asks; without DBCatz it offers the download.
 */
const props = defineProps<{ tab: Tab }>();
const api = window.dialcatz;

const info = ref<{ installed: boolean; bridge: boolean; connections: DbCatzConnection[] } | null>(null);
const open = ref(false);
const busy = ref(false);
const error = ref('');
const form = ref({ conn: '', db: '', table: '', col: 'id', val: '', row: true });

const collection = computed(() => collectionOf(props.tab.itemId));
const request = computed(() => workspace.value?.items.find((i) => i.id === props.tab.itemId && i.kind === 'request') ?? null);
const guess = computed(() => {
  const res = props.tab.result;
  if (!res?.sent) return null;
  return guessTable(res.sent.url, res.sent.method, res.response && !res.response.binary ? res.response.body : null);
});
const table = computed(() => request.value?.dbTable || guess.value?.table || '');
const conn = computed(() => info.value?.connections.find((c) => c.id === form.value.conn) ?? null);
const label = computed(() => (collection.value?.database && table.value ? `Check ${table.value} in DBCatz` : 'Check in DBCatz'));

async function load() {
  info.value = await api.dbcatzInfo();
}

/** The dialog, filled with what is remembered and guessed. */
async function ask() {
  error.value = '';
  await load();
  const d = collection.value?.database;
  const g = guess.value;
  const first = info.value?.connections[0];
  form.value = {
    conn: d?.conn ?? first?.id ?? '',
    db: d?.db ?? first?.database ?? '',
    table: table.value,
    col: g?.col ?? 'id',
    val: request.value?.dbTable && request.value.dbTable !== g?.table ? '' : (g?.val ?? ''),
    row: !!g?.val,
  };
  open.value = true;
}
function pickConn() {
  if (!form.value.db && conn.value?.database) form.value.db = conn.value.database;
}

async function go(t: { conn: string; db: string; table: string; col?: string; val?: string }) {
  busy.value = true;
  error.value = '';
  try {
    await api.dbcatzOpen({ ...t });
    notify('success', t.table ? `Opened ${t.table} in DBCatz` : 'Opened in DBCatz');
    return true;
  } catch (e) {
    error.value = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (!open.value) notify('error', error.value);
    return false;
  } finally {
    busy.value = false;
  }
}

/** The button: straight to DBCatz when the collection knows its database, else the dialog. */
async function check() {
  if (!info.value) await load();
  const d = collection.value?.database;
  if (!info.value?.installed || !d || !table.value) return ask();
  const g = guess.value;
  const row = g?.val && table.value === g.table ? { col: g.col, val: g.val } : {};
  await go({ conn: d.conn, db: d.db, table: table.value, ...row });
}

async function submit() {
  const f = form.value;
  if (!f.conn) return void (error.value = 'Choose a DBCatz connection');
  const col = collection.value;
  if (col && workspace.value) {
    const remember = f.table.trim() && f.table.trim() !== guess.value?.table ? f.table.trim() : null;
    workspace.value = await api.saveDbTarget(workspace.value.id, col.id, { conn: f.conn, db: f.db.trim() }, request.value?.id ?? null, remember);
  }
  const ok = await go({ conn: f.conn, db: f.db.trim(), table: f.table.trim(), ...(f.row && f.val.trim() ? { col: f.col.trim(), val: f.val.trim() } : {}) });
  if (ok) open.value = false;
}
</script>

<template>
  <div v-if="tab.result?.sent && !tab.result.error" class="join">
    <button class="btn btn-ghost btn-xs join-item gap-1" :disabled="busy" :title="collection?.database ? `${label} (${collection.database.db || 'default database'})` : 'Open the table this call touched in DBCatz'" @click="check">
      <img :src="dbcatzLogo" alt="" class="size-3.5" />{{ label }}
    </button>
    <button class="btn btn-ghost btn-xs btn-square join-item" title="Choose the connection, database and table…" aria-label="Choose the connection, database and table" @click="ask"><Icon name="chevron" class="size-3 rotate-90" /></button>
  </div>

  <dialog v-if="open" open class="modal modal-open" @keydown.esc="!busy && (open = false)">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <h3 class="flex items-center gap-2 text-lg font-semibold tracking-tight"><img :src="dbcatzLogo" alt="" class="size-6" />Check in DBCatz</h3>

      <div v-if="!info?.installed" class="alert alert-info alert-soft text-sm">
        <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
        <span class="flex-1">DBCatz is not installed on this computer. With it, DialCatz opens the table a call just changed.</span>
        <button class="btn btn-primary btn-sm shrink-0 gap-1.5" @click="openDownload('dbcatz', 'DBCatz')"><img :src="dbcatzLogo" alt="" class="size-4" />Get DBCatz</button>
      </div>
      <template v-else>
        <div v-if="!info.bridge" class="alert alert-warning alert-soft text-sm">
          <CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
          <span>This DBCatz does not share its connections yet. Update DBCatz, then open it once.</span>
        </div>
        <div v-else-if="!info.connections.length" class="text-sm opacity-70">DBCatz has no saved connections yet. Add the database in DBCatz first.</div>
        <template v-if="info.connections.length">
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Connection</span><span class="text-xs opacity-50">From DBCatz, for this collection</span></span>
            <select v-model="form.conn" class="select select-sm w-64" @change="pickConn">
              <optgroup v-if="info.connections.some((c) => c.source === 'saved')" label="Saved in DBCatz">
                <option v-for="c in info.connections.filter((x) => x.source === 'saved')" :key="c.id" :value="c.id">{{ c.name }} · {{ c.engine }}</option>
              </optgroup>
              <optgroup v-if="info.connections.some((c) => c.source === 'devcatz')" label="DevCatz services">
                <option v-for="c in info.connections.filter((x) => x.source === 'devcatz')" :key="c.id" :value="c.id">{{ c.name }} · {{ c.engine }}</option>
              </optgroup>
            </select>
          </div>
          <div class="opt-row">
            <span class="label-caps">Database</span>
            <input v-model="form.db" class="input input-sm w-64 font-mono" :placeholder="conn?.database ?? 'shop'" spellcheck="false" autocomplete="off" />
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Table</span><span class="text-xs opacity-50">{{ guess ? `Guessed from the URL: ${guess.table}` : 'Not guessed from this URL' }}</span></span>
            <input v-model="form.table" class="input input-sm w-64 font-mono" placeholder="users" spellcheck="false" autocomplete="off" />
          </div>
          <div class="opt-row">
            <label class="flex cursor-pointer items-center gap-2.5"><input v-model="form.row" type="checkbox" class="toggle toggle-sm toggle-primary" role="switch" /><span class="label-caps">Only this row</span></label>
            <div class="flex w-64 items-center gap-1.5">
              <input v-model="form.col" class="input input-sm w-24 font-mono" placeholder="id" :disabled="!form.row" spellcheck="false" />
              <span class="opacity-50">=</span>
              <input v-model="form.val" class="input input-sm min-w-0 flex-1 font-mono" placeholder="42" :disabled="!form.row" spellcheck="false" />
            </div>
          </div>
          <p class="text-xs opacity-50">Remembered on this computer only: teammates choose their own DBCatz connection. DBCatz just opens the table — nothing is changed.</p>
        </template>
      </template>

      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span>{{ error }}</span></div>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="open = false">Cancel</button>
        <button v-if="info?.installed && info.connections.length" class="btn btn-primary btn-sm gap-1.5" :disabled="busy || !form.conn" @click="submit"><span v-if="busy" class="loading loading-spinner loading-xs" /><img v-else :src="dbcatzLogo" alt="" class="size-4" />Open in DBCatz</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && (open = false)" />
  </dialog>
</template>
