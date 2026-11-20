<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { DoCatzProject, TreeItem } from '@shared/types';
import { attempt, notify, refreshDevcatzLinks, setWorkspace, workspace } from '../state';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * Pairs a collection with a DoCatz compose project's service (main/docatzlink.ts): from then on importing that
 * service's routes, DoCatz's "Open in DialCatz" and "Create mock server" all find this collection.
 */
const props = defineProps<{ collection: TreeItem }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

const loading = ref(true);
const installed = ref(false);
const projects = ref<DoCatzProject[]>([]);
const name = ref('');
const service = ref('');
const project = computed(() => projects.value.find((p) => p.name === name.value) ?? null);
watch(project, (p) => (service.value = (p?.services.find((s) => s.api && s.url) ?? p?.services[0])?.service ?? ''));

onMounted(async () => {
  const r = await attempt(() => api.docatzProjects());
  loading.value = false;
  if (!r) return;
  installed.value = r.installed;
  projects.value = r.projects;
  const guess = r.projects.find((p) => props.collection.origin?.startsWith(`docatz:${p.name}:`)) ?? r.projects.find((p) => props.collection.name.toLowerCase().startsWith(p.name.toLowerCase()));
  name.value = guess?.name ?? r.projects[0]?.name ?? '';
});

const busy = ref(false);
async function link() {
  busy.value = true;
  const w = await attempt(() => api.docatzLinkSet(workspace.value!.id, props.collection.id, name.value, service.value));
  busy.value = false;
  if (!w) return;
  setWorkspace(w);
  await refreshDevcatzLinks();
  notify('success', `“${props.collection.name}” is linked to ${name.value}${service.value ? ` · ${service.value}` : ''}`);
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('close')">
    <div class="modal-box w-[32rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10"><img :src="docatzLogo" alt="" class="size-7 rounded-md" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">Link “{{ collection.name }}” to DoCatz</h3>
          <p class="text-sm opacity-70">Pairs it with a compose project's service, so importing its routes, Open in DialCatz and Create mock server in DoCatz all use this collection.</p>
        </div>
      </div>

      <p v-if="loading" class="text-sm opacity-60"><span class="loading loading-spinner loading-xs" /> Looking at DoCatz…</p>
      <p v-else-if="!installed" class="text-sm">DoCatz is not installed on this computer.</p>
      <p v-else-if="!projects.length" class="text-sm">DoCatz has no compose project with an API yet.</p>
      <template v-else>
        <label class="block space-y-1">
          <span class="label-caps">Project</span>
          <select v-model="name" class="select select-sm w-full">
            <option v-for="p in projects" :key="p.name" :value="p.name">{{ p.name }}{{ p.running ? '' : ' (stopped)' }}</option>
          </select>
        </label>
        <label v-if="(project?.services.length ?? 0) > 1" class="block space-y-1">
          <span class="label-caps">Service</span>
          <select v-model="service" class="select select-sm w-full">
            <option v-for="s in project!.services" :key="s.service" :value="s.service">{{ s.service }}{{ s.framework ? ` · ${s.framework}` : '' }}</option>
          </select>
        </label>
        <p class="text-xs opacity-60">Copies on other computers find the project through its Git remote.</p>
      </template>

      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !project" @click="link"><span v-if="busy" class="loading loading-spinner loading-xs" />Link</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>
