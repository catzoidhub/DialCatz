<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { ClientCert, ClientCertInput } from '@shared/types';
import { notify } from '../state';
import Icon from './Icon.vue';

/**
 * Settings → Client certificates (#102): the certificate DialCatz shows a host that asks who is calling (mutual
 * TLS). One per host: a PEM certificate with its key, or a PKCS#12 file. They stay on this computer.
 */
const certs = ref<ClientCert[]>([]);
const form = ref<(ClientCertInput & { passphraseText: string; passphraseTouched: boolean }) | null>(null);
const failed = ref('');
const busy = ref(false);
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

onMounted(async () => (certs.value = await window.dialcatz.clientCerts()));

function add() {
  failed.value = '';
  form.value = { host: '', kind: 'pem', certFile: '', keyFile: '', pfxFile: '', passphraseText: '', passphraseTouched: true };
}
function edit(c: ClientCert) {
  failed.value = '';
  form.value = { id: c.id, host: c.host, kind: c.kind, certFile: c.certFile, keyFile: c.keyFile, pfxFile: c.pfxFile, passphraseText: '', passphraseTouched: false };
}
async function pick(what: 'cert' | 'key' | 'pfx') {
  const f = await window.dialcatz.clientCertPick(what);
  if (!f || !form.value) return;
  if (what === 'cert') form.value.certFile = f;
  else if (what === 'key') form.value.keyFile = f;
  else form.value.pfxFile = f;
}
async function save() {
  const f = form.value;
  if (!f) return;
  failed.value = '';
  busy.value = true;
  try {
    certs.value = await window.dialcatz.clientCertSave({ ...(f.id ? { id: f.id } : {}), host: f.host, kind: f.kind, certFile: f.certFile, keyFile: f.keyFile, pfxFile: f.pfxFile, ...(f.passphraseTouched ? { passphrase: f.passphraseText } : {}) });
    form.value = null;
    notify('success', `Requests to ${f.host.trim()} now show this certificate`);
  } catch (e) {
    failed.value = clean(e);
  } finally {
    busy.value = false;
  }
}
async function remove(c: ClientCert) {
  certs.value = await window.dialcatz.clientCertRemove(c.id);
  if (form.value?.id === c.id) form.value = null;
}
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2>Client certificates</h2>
          <p class="mt-1 text-sm opacity-60">For APIs that ask who is calling (mutual TLS). Requests, WebSocket and gRPC connections to a host show its certificate. They stay on this computer and are never part of a workspace.</p>
        </div>
        <button v-if="!form" class="btn btn-sm shrink-0" @click="add"><Icon name="plus" class="size-4" />Add</button>
      </div>

      <ul v-if="certs.length" class="cc-list">
        <li v-for="c in certs" :key="c.id" class="cc-row">
          <span class="cc-dot" :class="c.problem ? 'is-bad' : 'is-ok'"></span>
          <div class="min-w-0 flex-1">
            <div class="truncate font-mono text-sm">{{ c.host }}</div>
            <div class="truncate text-xs" :class="c.problem ? 'text-error' : 'opacity-55'">{{ c.problem ?? (c.kind === 'pfx' ? base(c.pfxFile) : `${base(c.certFile)} + ${base(c.keyFile)}`) + (c.hasPassphrase ? ' · passphrase kept' : '') }}</div>
          </div>
          <button class="btn btn-ghost btn-xs" @click="edit(c)">Change</button>
          <button class="btn btn-ghost btn-xs btn-square" title="Remove" @click="remove(c)"><Icon name="trash" class="size-3.5" /></button>
        </li>
      </ul>
      <p v-else-if="!form" class="text-sm opacity-50">None yet.</p>

      <div v-if="form" class="cc-form">
        <div class="opt-row">
          <span class="label-caps">Host</span>
          <input v-model="form.host" class="input input-sm flex-1 font-mono" placeholder="api.example.com   or   *.example.com" spellcheck="false" @keydown.enter="save" />
        </div>
        <div class="opt-row">
          <span class="label-caps">Format</span>
          <div class="seg seg-choice">
            <button role="tab" class="seg-item normal-case" :class="{ 'is-active': form.kind === 'pem' }" @click="form.kind = 'pem'">PEM (certificate + key)</button>
            <button role="tab" class="seg-item normal-case" :class="{ 'is-active': form.kind === 'pfx' }" @click="form.kind = 'pfx'">PKCS#12 (.p12 / .pfx)</button>
          </div>
        </div>
        <template v-if="form.kind === 'pem'">
          <div class="opt-row">
            <span class="label-caps">Certificate</span>
            <span class="flex min-w-0 flex-1 items-center justify-end gap-2"><span class="truncate font-mono text-xs opacity-70" :title="form.certFile">{{ form.certFile ? base(form.certFile) : 'not chosen' }}</span><button class="btn btn-sm" @click="pick('cert')">Choose…</button></span>
          </div>
          <div class="opt-row">
            <span class="label-caps">Key</span>
            <span class="flex min-w-0 flex-1 items-center justify-end gap-2"><span class="truncate font-mono text-xs opacity-70" :title="form.keyFile">{{ form.keyFile ? base(form.keyFile) : 'not chosen' }}</span><button class="btn btn-sm" @click="pick('key')">Choose…</button></span>
          </div>
        </template>
        <div v-else class="opt-row">
          <span class="label-caps">File</span>
          <span class="flex min-w-0 flex-1 items-center justify-end gap-2"><span class="truncate font-mono text-xs opacity-70" :title="form.pfxFile">{{ form.pfxFile ? base(form.pfxFile) : 'not chosen' }}</span><button class="btn btn-sm" @click="pick('pfx')">Choose…</button></span>
        </div>
        <div class="opt-row">
          <span class="flex flex-col"><span class="label-caps">Passphrase</span><span class="text-xs opacity-50">Only when the key has one</span></span>
          <input v-model="form.passphraseText" type="password" class="input input-sm w-64" :placeholder="form.id && !form.passphraseTouched ? 'unchanged' : ''" autocomplete="off" @input="form.passphraseTouched = true" @keydown.enter="save" />
        </div>
        <p v-if="failed" class="text-xs text-error">{{ failed }}</p>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-sm" @click="form = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy || !form.host.trim()" @click="save">{{ form.id ? 'Save' : 'Add certificate' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cc-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.cc-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.5rem 0.65rem;
  border-radius: 10px;
  background: oklch(from var(--color-base-content) l c h / 0.04);
}
.cc-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 999px;
  flex-shrink: 0;
}
.cc-dot.is-ok {
  background: var(--color-success);
}
.cc-dot.is-bad {
  background: var(--color-error);
}
.cc-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.9rem;
  border-radius: 12px;
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
}
</style>
