<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { activeTab, activeTabId, attempt, closeTab, newTab, plain, presenceByItem, saveTab, workspace, workspaceTabs, type Tab } from '../state';
import { store } from '../store';
import CollectionTree from './CollectionTree.vue';
import RequestEditor from './RequestEditor.vue';
import ResponseView from './ResponseView.vue';
import WorkspaceBar from './WorkspaceBar.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import Icon from './Icon.vue';

/** Requests: the collection tree on the left; open requests as tabs, each with its editor above its response. */
const tree = ref<InstanceType<typeof CollectionTree> | null>(null);
const editor = ref<InstanceType<typeof RequestEditor> | null>(null);

// Editor / response split, dragged by the bar between them (a fraction of the height).
const split = ref(store.get('split', 0.46));
const main = ref<HTMLElement | null>(null);
function startDrag(e: MouseEvent) {
  const box = main.value!.getBoundingClientRect();
  const move = (ev: MouseEvent) => (split.value = Math.min(0.8, Math.max(0.18, (ev.clientY - box.top) / box.height)));
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('is-resizing');
    store.set('split', split.value);
  };
  document.body.classList.add('is-resizing');
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  e.preventDefault();
}

// Saving a scratch tab asks where it goes.
const saveAs = ref<{ tab: Tab; parentId: string; name: string } | null>(null);
const containers = computed(() => {
  const items = workspace.value?.items ?? [];
  const out: { id: string; label: string }[] = [];
  const walk = (parentId: string | null, prefix: string) => {
    for (const i of items.filter((x) => x.parentId === parentId && x.kind !== 'request').sort((a, b) => a.sort - b.sort)) {
      out.push({ id: i.id, label: prefix + i.name });
      walk(i.id, `${prefix}${i.name} / `);
    }
  };
  walk(null, '');
  return out;
});
async function save(tab: Tab | null = activeTab.value) {
  if (!tab) return;
  if (tab.itemId) return void (await saveTab(tab));
  if (!containers.value.length) {
    await tree.value?.newRequestIn();
    return;
  }
  saveAs.value = { tab, parentId: containers.value[0].id, name: tab.name === 'Untitled request' ? '' : tab.name };
}
async function confirmSaveAs() {
  const s = saveAs.value!;
  saveAs.value = null;
  await attempt(() => saveTab(s.tab, s.parentId, s.name || 'New request'));
}

// Closing: tabs with unsaved changes to a saved request ask first, unless closed "without saving".
const closing = ref<Tab[] | null>(null);
const unsaved = (t: Tab) => t.dirty && !!t.itemId;
function askCloseMany(list: Tab[]) {
  const dirty = list.filter(unsaved);
  for (const t of list.filter((x) => !unsaved(x))) closeTab(t.id);
  if (dirty.length) closing.value = dirty;
}
const askClose = (tab: Tab) => askCloseMany([tab]);
function closeNow(list: Tab[]) {
  for (const t of list) closeTab(t.id);
}
/** Saves each tab into its request, then closes the ones that saved. */
async function saveAndClose(list: Tab[]) {
  closing.value = null;
  for (const t of list) if (await saveTab(t)) closeTab(t.id);
}

// The tab strip scrolls on its own: wheel scrolls it sideways, the active tab is kept in view.
const strip = ref<HTMLElement | null>(null);
function onWheel(e: WheelEvent) {
  if (!strip.value || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  strip.value.scrollLeft += e.deltaY;
}
watch(activeTabId, async (id) => {
  await nextTick();
  strip.value?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

// Right-click menu of a tab.
const menu = ref<{ tab: Tab; x: number; y: number } | null>(null);
function showMenu(tab: Tab, e: MouseEvent) {
  menu.value = { tab, x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 300) };
}
const closeMenu = () => (menu.value = null);
onMounted(() => window.addEventListener('click', closeMenu));
onBeforeUnmount(() => window.removeEventListener('click', closeMenu));
function duplicate(tab: Tab) {
  const copy = newTab(plain(tab.spec), `${tab.name} copy`);
  if (copy) copy.dirty = false;
}
const others = (tab: Tab) => workspaceTabs.value.filter((t) => t.id !== tab.id);
function run(fn: (t: Tab) => void) {
  const t = menu.value!.tab;
  menu.value = null;
  fn(t);
}

const methodClass = (t: Tab) => `m-${t.spec.method.toLowerCase()}`;

defineExpose({
  newRequest: () => tree.value?.newRequestIn(),
  newCollection: () => tree.value?.newCollection(),
  importNow: () => tree.value?.importNow(),
  save: () => save(),
  closeTab: () => activeTab.value && askClose(activeTab.value),
  focusUrl: () => editor.value?.focusUrl(),
});
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="sidebar flex w-72 shrink-0 flex-col">
      <WorkspaceBar />
      <CollectionTree ref="tree" />
    </aside>

    <section ref="main" class="flex min-w-0 flex-1 flex-col">
      <!-- Tabs -->
      <div class="drag req-tabs">
        <div ref="strip" class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto no-scrollbar" @wheel.passive="onWheel">
          <button
            v-for="t in workspaceTabs"
            :key="t.id"
            :data-tab="t.id"
            class="req-tab no-drag"
            :class="{ 'is-active': t.id === activeTabId }"
            :title="t.spec.url || t.name"
            @click="activeTabId = t.id"
            @auxclick.middle="askClose(t)"
            @contextmenu.prevent="showMenu(t, $event)"
          >
            <span class="tree-method font-mono" :class="methodClass(t)">{{ t.spec.method }}</span>
            <span class="truncate" :class="{ italic: !t.itemId }">{{ t.name }}</span>
            <span v-if="t.itemId && presenceByItem[t.itemId]" class="tree-presence" :title="`${presenceByItem[t.itemId].join(', ')} also ${presenceByItem[t.itemId].length === 1 ? 'has' : 'have'} this open`">{{ presenceByItem[t.itemId].map((n) => n[0]).join('') }}</span>
            <span v-if="t.sending" class="loading loading-spinner loading-xs" />
            <span class="req-tab-x" :class="{ 'is-dirty': t.dirty }" title="Close" @click.stop="askClose(t)"><Icon name="x" class="size-3" /></span>
          </button>
        </div>
        <div class="no-drag flex items-center gap-1 pr-3">
          <button class="req-tab-add mb-1" title="New tab (scratch request)" @click="newTab()"><Icon name="plus" class="size-4" /></button>
          <!-- Every open tab, for when the strip is too narrow to show them all. -->
          <div v-if="workspaceTabs.length > 1" class="dropdown dropdown-end">
            <button tabindex="0" class="req-tab-add mb-1" :title="`All open tabs (${workspaceTabs.length})`"><Icon name="chevronDown" class="size-4" /></button>
            <ul tabindex="0" class="dropdown-content menu z-40 mt-1 max-h-96 w-72 flex-nowrap overflow-y-auto rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl">
              <li v-for="t in workspaceTabs" :key="t.id">
                <button :class="{ 'menu-active': t.id === activeTabId }" @click="((activeTabId = t.id), ($event.currentTarget as HTMLElement).blur())">
                  <span class="tree-method font-mono" :class="methodClass(t)">{{ t.spec.method }}</span>
                  <span class="flex-1 truncate">{{ t.name }}</span>
                  <span v-if="t.dirty" class="tree-dirty" />
                </button>
              </li>
            </ul>
          </div>
          <slot name="env" />
        </div>
      </div>

      <template v-if="activeTab && activeTab.workspaceId === workspace?.id">
        <div class="flex min-h-0 flex-col" :style="{ height: `${split * 100}%` }">
          <RequestEditor :key="activeTab.id" ref="editor" :tab="activeTab" @save="save()" />
        </div>
        <div class="split-bar" @mousedown="startDrag" />
        <div class="flex min-h-0 flex-1 flex-col">
          <ResponseView :key="activeTab.id" :tab="activeTab" />
        </div>
      </template>
      <div v-else class="grid flex-1 place-items-center p-8 text-center">
        <div class="max-w-sm space-y-3">
          <img src="../assets/icon.png" alt="" class="mx-auto size-20" />
          <h2 class="text-lg font-semibold">Make the call.</h2>
          <p class="text-sm opacity-60">Pick a request on the left, or start a new one.</p>
          <div class="flex justify-center gap-2">
            <button class="btn btn-primary btn-sm" @click="tree?.newRequestIn()">New request</button>
            <button class="btn btn-ghost btn-sm" @click="newTab()">Scratch tab</button>
          </div>
        </div>
      </div>
    </section>

    <dialog v-if="saveAs" open class="modal modal-open" @keydown.esc="saveAs = null">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <h3 class="text-lg font-semibold tracking-tight">Save request</h3>
        <div class="opt-row">
          <span class="label-caps">Name</span>
          <input v-model="saveAs.name" class="input input-sm flex-1" placeholder="New request" @keydown.enter="confirmSaveAs" />
        </div>
        <div class="opt-row">
          <span class="label-caps">In</span>
          <select v-model="saveAs.parentId" class="select select-sm flex-1">
            <option v-for="c in containers" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="saveAs = null">Cancel</button>
          <button class="btn btn-primary btn-sm" @click="confirmSaveAs">Save</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="saveAs = null" />
    </dialog>

    <!-- Tab menu -->
    <ul v-if="menu" class="menu fixed z-50 w-60 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
      <li><button @click="run(() => newTab())">New request tab</button></li>
      <li><button @click="run(duplicate)">Duplicate tab</button></li>
      <div class="my-1 border-t border-base-300/60" />
      <li><button @click="run(askClose)">Close tab</button></li>
      <li><button :disabled="!menu.tab.dirty" @click="run((t) => closeNow([t]))">Close without saving</button></li>
      <li><button :disabled="!others(menu.tab).length" @click="run((t) => askCloseMany(others(t)))">Close other tabs</button></li>
      <div class="my-1 border-t border-base-300/60" />
      <li><button @click="run(() => askCloseMany([...workspaceTabs]))">Close all tabs</button></li>
      <li><button class="text-error" @click="run(() => closeNow([...workspaceTabs]))">Close all without saving</button></li>
    </ul>

    <ConfirmDialog
      v-if="closing"
      :title="closing.length === 1 ? `Save the changes to “${closing[0].name}”?` : `Save the changes to ${closing.length} requests?`"
      :text="closing.length === 1 ? 'This tab has changes that are not saved yet.' : `${closing.map((t) => t.name).join(', ')} have changes that are not saved yet.`"
      :confirm="closing.length === 1 ? 'Save & close' : 'Save all & close'"
      tone="primary"
      @ok="saveAndClose(closing)"
      @cancel="closing = null"
    >
      <div class="flex justify-end"><button class="btn btn-ghost btn-sm text-error" @click="(closeNow(closing), (closing = null))">Close without saving</button></div>
    </ConfirmDialog>
  </div>
</template>
