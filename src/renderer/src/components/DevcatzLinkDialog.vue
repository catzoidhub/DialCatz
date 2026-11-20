<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DevCatzSite, TreeItem } from '@shared/types';
import { attempt, notify, refreshDevcatzLinks, setWorkspace, workspace } from '../state';
import devcatzLogo from '../assets/logos/devcatz.svg';

/**
 * Pairs a collection with a DevCatz site's app (main/devcatzlink.ts): from then on importing that site's routes,
 * DevCatz's "Open in DialCatz" and "Create mock server" all find this collection.
 */
const props = defineProps<{ collection: TreeItem }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

const loading = ref(true);
const installed = ref(false);
const sites = ref<DevCatzSite[]>([]);
const siteId = ref('');
const app = ref('');
const site = computed(() => sites.value.find((s) => s.id === siteId.value) ?? null);
const apps = computed(() => site.value?.apps.filter((a) => a.kind !== 'assets') ?? []);
watch(site, (s) => (app.value = (s?.apps.find((a) => a.kind === 'api') ?? s?.apps.find((a) => a.kind !== 'assets'))?.dir ?? ''));
const spec = computed(() => site.value?.openapi.find((o) => o.file && o.app === app.value)?.file?.replace(site.value!.path, '').replace(/^[\\/]/, ''));

onMounted(async () => {
  const r = await attempt(() => api.devcatzSites());
  loading.value = false;
  if (!r) return;
  installed.value = r.installed;
  sites.value = r.sites;
  // A collection imported from a site, or named after one, starts there.
  const guess = r.sites.find((s) => props.collection.origin?.startsWith(`devcatz:${s.id}:`)) ?? r.sites.find((s) => props.collection.name.toLowerCase().startsWith(s.name.toLowerCase()));
  siteId.value = guess?.id ?? r.sites[0]?.id ?? '';
});

const busy = ref(false);
async function link() {
  busy.value = true;
  const w = await attempt(() => api.devcatzLinkSet(workspace.value!.id, props.collection.id, siteId.value, app.value));
  busy.value = false;
  if (!w) return;
  setWorkspace(w);
  await refreshDevcatzLinks();
  notify('success', `“${props.collection.name}” is linked to ${site.value?.name}${app.value ? ` (${app.value})` : ''}`);
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('close')">
    <div class="modal-box w-[32rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10"><img :src="devcatzLogo" alt="" class="size-7" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">Link “{{ collection.name }}” to DevCatz</h3>
          <p class="text-sm opacity-70">Pairs it with a site, so importing the site's routes, Open in DialCatz and Create mock server in DevCatz all use this collection.</p>
        </div>
      </div>

      <p v-if="loading" class="text-sm opacity-60"><span class="loading loading-spinner loading-xs" /> Looking at DevCatz…</p>
      <p v-else-if="!installed" class="text-sm">DevCatz is not installed on this computer.</p>
      <p v-else-if="!sites.length" class="text-sm">DevCatz has no sites yet.</p>
      <template v-else>
        <label class="block space-y-1">
          <span class="label-caps">Site</span>
          <select v-model="siteId" class="select select-sm w-full">
            <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }} · {{ s.domain }}</option>
          </select>
        </label>
        <label v-if="apps.length > 1" class="block space-y-1">
          <span class="label-caps">App</span>
          <select v-model="app" class="select select-sm w-full">
            <option v-for="a in apps" :key="a.dir" :value="a.dir">{{ a.dir || a.name }} · {{ a.kind }}</option>
          </select>
        </label>
        <p class="text-xs opacity-60">
          <template v-if="spec">Its OpenAPI file: <code>{{ spec }}</code>.</template>
          <template v-else>DevCatz lists no OpenAPI file for it; the link still pairs routes and Open in DialCatz.</template>
          Teammates' copies find the site through its Git remote.
        </p>
      </template>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !site" @click="link"><span v-if="busy" class="loading loading-spinner loading-xs" />Link</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>
