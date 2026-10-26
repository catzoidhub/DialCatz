<script setup lang="ts">
import { computed } from 'vue';
import { activeEnvironment, activeTab, attempt, collectionOf, defaultEnvironment, goSection, plain, readOnly, setWorkspace, workspace } from '../state';
import Icon from './Icon.vue';

/**
 * The environment in effect, top right of the request tabs. In a collection's tab it picks that collection's own
 * environment (or the workspace default); in a scratch tab it picks the workspace default.
 */
const collection = computed(() => {
  const t = activeTab.value;
  return t && t.workspaceId === workspace.value?.id && !readOnly.value ? collectionOf(t.itemId) : null;
});
const own = computed(() => collection.value?.environmentId !== undefined);

async function pickDefault(id: string | null) {
  (document.activeElement as HTMLElement | null)?.blur();
  const w = await attempt(() => window.dialcatz.setActiveEnvironment(workspace.value!.id, id));
  if (w) setWorkspace(w);
}
async function pickForCollection(id: string | null | undefined) {
  (document.activeElement as HTMLElement | null)?.blur();
  const c = collection.value!;
  const next = plain({ ...c, environmentId: id });
  if (id === undefined) delete next.environmentId;
  const w = await attempt(() => window.dialcatz.saveItems(workspace.value!.id, [next]));
  if (w) setWorkspace(w);
}
const pick = (id: string | null) => (collection.value ? pickForCollection(id) : pickDefault(id));
</script>

<template>
  <div v-if="workspace" class="dropdown dropdown-end">
    <button tabindex="0" class="env-pick" :class="{ 'is-on': !!activeEnvironment }" :title="collection ? `Environment for ${collection.name}` : 'Environment: the values {{variables}} take'">
      <Icon name="environments" class="size-3.5" />
      <span class="max-w-40 truncate">{{ activeEnvironment?.name ?? 'No environment' }}</span>
      <Icon name="chevronDown" class="size-3.5 opacity-60" />
    </button>
    <ul tabindex="0" class="dropdown-content menu z-40 mt-1 w-64 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl">
      <li class="menu-title truncate">{{ collection ? `For ${collection.name}` : 'Workspace default' }}</li>
      <li v-if="collection">
        <button :class="{ 'menu-active': !own }" @click="pickForCollection(undefined)">
          <span class="flex-1 truncate">Workspace default</span><span class="truncate text-xs opacity-50">{{ defaultEnvironment?.name ?? 'none' }}</span>
        </button>
      </li>
      <li><button :class="{ 'menu-active': (collection ? own : true) && !activeEnvironment }" @click="pick(null)">No environment</button></li>
      <li v-for="e in workspace.environments" :key="e.id">
        <button :class="{ 'menu-active': (collection ? own : true) && e.id === activeEnvironment?.id }" @click="pick(e.id)">{{ e.name }}</button>
      </li>
      <div class="my-1 border-t border-base-300/60" />
      <li><button @click="goSection('environments')">Edit environments…</button></li>
    </ul>
  </div>
</template>
