<script setup lang="ts">
import CodeEditor from './CodeEditor.vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { emptyLayout, uid, type ExportFormat, type RequestAuth, type SidebarLayout, type TreeItem } from '@shared/types';
import { attempt, closeTab, defaultEnvironment, freshRequest, importRequest, newTab, notify, openItem, plain, presenceByItem, readOnly, section, syncTabsWithWorkspace, tabs, workspace } from '../state';
import TreeNode, { type DropTarget } from './TreeNode.vue';
import PromptDialog from './PromptDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import AuthEditor from './AuthEditor.vue';
import ImportDialog from './ImportDialog.vue';
import RunnerDialog from './RunnerDialog.vue';
import CopyCollectionDialog from './CopyCollectionDialog.vue';
import Icon from './Icon.vue';
import { store } from '../store';

/**
 * The Requests sidebar: collections → folders → requests, with a filter, sort, favourites, collection groups, a
 * context menu, and drag and drop to move and reorder. Groups, favourites and the sort choice are this computer's
 * own (workspace.layout); the order itself (`sort`) is part of the items and syncs with the team.
 */
const api = window.dialcatz;
const filter = ref('');
const open = reactive(new Set<string>(store.get<string[]>('open', [])));
const remember = () => store.set('open', [...open]);

const layout = computed<SidebarLayout>(() => workspace.value?.layout ?? emptyLayout());
const sortBy = computed(() => layout.value.sortBy);
const byOrder = (a: TreeItem, b: TreeItem) => a.sort - b.sort || a.name.localeCompare(b.name);
const byName = (a: TreeItem, b: TreeItem) => a.name.localeCompare(b.name, undefined, { numeric: true });
const roots = computed(() => (workspace.value?.items ?? []).filter((i) => i.kind === 'collection').sort(sortBy.value === 'name' ? byName : byOrder));
const groupIds = computed(() => new Set(layout.value.groups.map((g) => g.id)));
const inGroup = (groupId: string) => roots.value.filter((c) => layout.value.groupOf[c.id] === groupId);
const ungrouped = computed(() => roots.value.filter((c) => !groupIds.value.has(layout.value.groupOf[c.id] ?? '')));
const favorites = computed(() => layout.value.favorites.map((id) => workspace.value?.items.find((i) => i.id === id)).filter((i): i is TreeItem => !!i));

/** Layout changes are personal: even viewers of a team workspace may arrange their sidebar. */
async function setLayout(patch: Partial<SidebarLayout>) {
  if (!workspace.value) return;
  await apply(() => api.saveLayout(workspace.value!.id, plain({ ...layout.value, ...patch })));
}
const toggleFavorite = (item: TreeItem) => setLayout({ favorites: layout.value.favorites.includes(item.id) ? layout.value.favorites.filter((f) => f !== item.id) : [...layout.value.favorites, item.id] });
const groupCollapsed = (id: string) => layout.value.collapsed.includes(id);
const toggleGroup = (id: string) => setLayout({ collapsed: groupCollapsed(id) ? layout.value.collapsed.filter((c) => c !== id) : [...layout.value.collapsed, id] });

async function newGroup(forCollection?: TreeItem) {
  const name = await ask('New group', 'Group', 'Create');
  if (!name) return;
  const id = uid('g_');
  await setLayout({ groups: [...layout.value.groups, { id, name }], groupOf: forCollection ? { ...layout.value.groupOf, [forCollection.id]: id } : layout.value.groupOf });
}
const moveToGroup = (c: TreeItem, groupId: string | null) => {
  const groupOf = { ...layout.value.groupOf };
  if (groupId) groupOf[c.id] = groupId;
  else delete groupOf[c.id];
  return setLayout({ groupOf });
};
async function renameGroup(g: { id: string; name: string }) {
  const name = await ask('Rename group', g.name, 'Rename');
  if (name) await setLayout({ groups: layout.value.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) });
}
const deleteGroup = (g: { id: string }) =>
  setLayout({ groups: layout.value.groups.filter((x) => x.id !== g.id), groupOf: Object.fromEntries(Object.entries(layout.value.groupOf).filter(([, v]) => v !== g.id)) });

function toggle(id: string) {
  if (open.has(id)) open.delete(id);
  else open.add(id);
  remember();
}

async function apply(fn: () => Promise<import('@shared/types').Workspace>, ok?: string) {
  const w = await attempt(fn, ok);
  if (w) {
    workspace.value = w;
    syncTabsWithWorkspace(w);
  }
  return w;
}

// ---------------------------------------------------------------- dialogs

const prompt = ref<{ title: string; value: string; confirm: string; done: (v: string) => void } | null>(null);
const confirm = ref<{ title: string; text: string; done: () => void; typeName?: string; list?: string[] } | null>(null);
// Deleting a collection or folder asks for its name typed out (a copy button saves typing it).
const typed = ref('');
watch(confirm, () => (typed.value = ''));
const confirmBlocked = computed(() => !!confirm.value?.typeName && typed.value.trim() !== confirm.value.typeName.trim());
function confirmOk() {
  if (!confirm.value || confirmBlocked.value) return;
  const c = confirm.value;
  confirm.value = null;
  c.done();
}
async function copyName() {
  await window.dialcatz.copyText(confirm.value?.typeName ?? '');
  notify('success', confirm.value?.list ? 'Text copied' : 'Name copied');
}

// ---------------------------------------------------------------- selecting several collections (bulk actions)

const selecting = ref<Set<string> | null>(null);
const selected = computed(() => roots.value.filter((c) => selecting.value?.has(c.id)));
function startSelect(first?: TreeItem) {
  selecting.value = new Set(first?.kind === 'collection' ? [first.id] : []);
}
function toggleSelect(item: TreeItem) {
  const s = new Set(selecting.value);
  if (s.has(item.id)) s.delete(item.id);
  else s.add(item.id);
  selecting.value = s;
}
const allSelected = computed(() => roots.value.length > 0 && selected.value.length === roots.value.length);
const selectAll = (on: boolean) => (selecting.value = new Set(on ? roots.value.map((c) => c.id) : []));
async function groupSelected(groupId: string | null) {
  const groupOf = { ...layout.value.groupOf };
  for (const c of selected.value) {
    if (groupId) groupOf[c.id] = groupId;
    else delete groupOf[c.id];
  }
  await setLayout({ groupOf });
}
/** Deleting several collections asks for "delete N collections" typed out, like one collection asks for its name. */
function removeSelected() {
  const list = selected.value;
  if (!list.length) return;
  if (list.length === 1) return remove(list[0]);
  const ids = list.map((c) => c.id);
  confirm.value = {
    title: `Delete ${list.length} collections?`,
    typeName: `delete ${list.length} collections`,
    list: list.map((c) => c.name),
    text: `These collections and everything in them are removed.${workspace.value?.serverId ? ' Your team sees them go at the next sync.' : ''}`,
    done: async () => {
      const w = await apply(() => api.deleteItems(workspace.value!.id, ids), `Deleted ${ids.length} collections`);
      if (!w) return;
      for (const t of [...tabs.value]) if (t.workspaceId === w.id && t.itemId && !w.items.some((i) => i.id === t.itemId) && !t.dirty) closeTab(t.id);
      selecting.value = null;
    },
  };
}
watch(
  () => workspace.value?.id,
  () => (selecting.value = null),
);
const authFor = ref<{ item: TreeItem; auth: RequestAuth; description: string; insecure: boolean; env: string; preRequest: string; tests: string } | null>(null);
// The collection's environment in the Settings dialog: '' the workspace default, '-' none, else an environment id.
const ENV_HINT = 'The values its {{variables}} take';
const PRE_HINT = "dc.env.set('requestId', crypto.randomUUID())";
const TESTS_HINT = "dc.test('answers in time', () => dc.expect(dc.response.time).toBeLessThan(2000))";
const envChoice = (i: TreeItem) => (i.environmentId === undefined ? '' : i.environmentId === null ? '-' : i.environmentId);
const importing = ref(false);
const importTab = ref<{ tab: 'choose' | 'file' | 'postman' | 'devcatz'; siteId?: string }>({ tab: 'choose' });
watch(importRequest, (r) => {
  if (!r) return;
  importRequest.value = null;
  section.value = 'requests';
  importTab.value = r;
  importing.value = true;
});
const running = ref<TreeItem | null>(null);
const copying = ref<TreeItem | null>(null);

function ask(title: string, value: string, confirmLabel: string): Promise<string | null> {
  return new Promise((resolve) => {
    prompt.value = { title, value, confirm: confirmLabel, done: (v) => resolve(v) };
  });
}

export interface Exposed {
  newCollection: () => Promise<void>;
  newRequestIn: (parentId?: string) => Promise<void>;
  importNow: () => void;
}

async function newCollection() {
  if (!workspace.value || readOnly.value) return;
  const name = await ask('New collection', 'My API', 'Create');
  if (!name) return;
  const id = uid('c_');
  const w = await apply(() => api.saveItems(workspace.value!.id, [{ id, kind: 'collection', parentId: null, name, sort: roots.value.length, auth: { mode: 'none' } }]));
  if (w) open.add(id), remember();
}

async function newFolder(parent: TreeItem) {
  const name = await ask('New folder', 'Folder', 'Create');
  if (!name) return;
  const sort = workspace.value!.items.filter((i) => i.parentId === parent.id).length;
  await apply(() => api.saveItems(workspace.value!.id, [{ id: uid('f_'), kind: 'folder', parentId: parent.id, name, sort, auth: { mode: 'inherit' } }]));
  open.add(parent.id);
  remember();
}

/** A new saved request in a collection / folder (the first collection, made if needed). */
async function newRequestIn(parentId?: string) {
  if (!workspace.value) return;
  if (readOnly.value) {
    newTab();
    return;
  }
  let pid = parentId ?? roots.value[0]?.id;
  if (!pid) {
    pid = uid('c_');
    const w = await apply(() => api.saveItems(workspace.value!.id, [{ id: pid!, kind: 'collection', parentId: null, name: 'My API', sort: 0, auth: { mode: 'none' } }]));
    if (!w) return;
  }
  const item: TreeItem = { id: uid('r_'), kind: 'request', parentId: pid, name: 'New request', sort: workspace.value.items.filter((i) => i.parentId === pid).length, request: freshRequest() };
  const w = await apply(() => api.saveItems(workspace.value!.id, [item]));
  if (!w) return;
  open.add(pid);
  remember();
  openItem(w.items.find((i) => i.id === item.id)!);
}

async function rename(item: TreeItem) {
  const name = await ask(`Rename ${item.kind}`, item.name, 'Rename');
  if (!name || name === item.name) return;
  await apply(() => api.saveItems(workspace.value!.id, [plain({ ...item, name })]));
}

async function duplicate(item: TreeItem) {
  const w = workspace.value!;
  const map = new Map<string, string>();
  const copies: TreeItem[] = [];
  const copy = (i: TreeItem, parentId: string | null, rename: boolean) => {
    const id = uid(i.kind === 'collection' ? 'c_' : i.kind === 'folder' ? 'f_' : 'r_');
    map.set(i.id, id);
    const { rev: _r, dirty: _d, ...rest } = i;
    copies.push(plain({ ...rest, id, parentId, name: rename ? `${i.name} copy` : i.name, sort: rename ? i.sort + 0.5 : i.sort }));
    for (const c of w.items.filter((x) => x.parentId === i.id)) copy(c, id, false);
  };
  copy(item, item.parentId, true);
  await apply(() => api.saveItems(w.id, copies));
}

function remove(item: TreeItem) {
  const under = workspace.value!.items.filter((i) => i.parentId === item.id).length;
  confirm.value = {
    title: `Delete “${item.name}”?`,
    typeName: item.kind === 'request' ? undefined : item.name,
    text: item.kind === 'request' ? 'The request is removed from the collection.' : `The ${item.kind} and everything in it${under ? ` (${under} item${under === 1 ? '' : 's'} directly inside)` : ''} is removed.${workspace.value?.serverId ? ' Your team sees it go at the next sync.' : ''}`,
    done: async () => {
      const w = await apply(() => api.deleteItems(workspace.value!.id, [item.id]));
      if (w) for (const t of [...tabs.value]) if (t.workspaceId === w.id && t.itemId && !w.items.some((i) => i.id === t.itemId) && !t.dirty) closeTab(t.id);
    },
  };
}

// Export: DialCatz's own file, or a Postman v2.1 collection for people who open it in Postman.
const exporting = ref<{ item: TreeItem; format: ExportFormat } | null>(null);
function exportIt(item: TreeItem) {
  exporting.value = { item, format: 'dialcatz' };
}
async function doExport() {
  const x = exporting.value!;
  exporting.value = null;
  if (await attempt(() => api.exportCollection(workspace.value!.id, x.item.id, x.format))) notify('success', `“${x.item.name}” exported`);
}

function editAuth(item: TreeItem) {
  authFor.value = { item, auth: plain(item.auth ?? { mode: item.kind === 'collection' ? 'none' : 'inherit' }), description: item.description ?? '', insecure: item.insecure === true, env: envChoice(item), preRequest: item.preRequest ?? '', tests: item.tests ?? '' };
}
async function saveAuth() {
  const a = authFor.value!;
  authFor.value = null;
  const next = plain({ ...a.item, auth: a.auth, description: a.description, insecure: a.item.kind === 'collection' && a.insecure ? true : undefined, environmentId: a.env === '' ? undefined : a.env === '-' ? null : a.env, preRequest: a.preRequest.trim() ? a.preRequest : undefined, tests: a.tests.trim() ? a.tests : undefined });
  if (a.item.kind !== 'collection' || a.env === '') delete next.environmentId;
  await apply(() => api.saveItems(workspace.value!.id, [next]), 'Saved');
}

// ---------------------------------------------------------------- context menu

const menu = ref<{ item: TreeItem; x: number; y: number } | null>(null);
const groupMenu = ref<{ group: { id: string; name: string }; x: number; y: number } | null>(null);
function showMenu(item: TreeItem, e: MouseEvent) {
  groupMenu.value = null;
  menu.value = { item, x: Math.min(e.clientX, window.innerWidth - 240), y: Math.min(e.clientY, window.innerHeight - 420) };
}
function showGroupMenu(group: { id: string; name: string }, e: MouseEvent) {
  menu.value = null;
  groupMenu.value = { group, x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 120) };
}
const closeMenu = () => ((menu.value = null), (groupMenu.value = null));
onMounted(() => window.addEventListener('click', closeMenu));
onBeforeUnmount(() => window.removeEventListener('click', closeMenu));
function run(fn: (i: TreeItem) => unknown) {
  const i = menu.value!.item;
  menu.value = null;
  void fn(i);
}

// ---------------------------------------------------------------- drag to move and reorder

const dragging = ref<TreeItem | null>(null);
const dropTarget = ref<DropTarget | null>(null);
/** A group header (or '' for "no group") a collection is dragged over. */
const dropGroup = ref<string | null>(null);
function endDrag() {
  dragging.value = null;
  dropTarget.value = null;
  dropGroup.value = null;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && dragging.value) endDrag();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function overGroup(groupId: string) {
  if (dragging.value?.kind === 'collection') dropGroup.value = groupId;
}
async function dropOnGroup(groupId: string) {
  const c = dragging.value;
  endDrag();
  if (c?.kind === 'collection') await moveToGroup(c, groupId || null);
}

/** Children of a parent in the user's own order. */
const ordered = (parentId: string | null) => (workspace.value?.items ?? []).filter((i) => i.parentId === parentId && (parentId !== null || i.kind === 'collection')).sort(byOrder);

async function drop() {
  const item = dragging.value;
  const target = dropTarget.value;
  endDrag();
  const w = workspace.value;
  if (!item || !target || !w || readOnly.value) return;
  const t = w.items.find((i) => i.id === target.id);
  if (!t || t.id === item.id) return;
  const parentId = target.pos === 'into' ? t.id : t.parentId;
  // Collections stay at the top level; everything else lives inside a collection.
  if ((item.kind === 'collection') !== (parentId === null)) return;
  // Not into itself or below itself.
  for (let p: string | null = parentId; p; p = w.items.find((i) => i.id === p)?.parentId ?? null) if (p === item.id) return;

  const siblings = ordered(parentId).filter((i) => i.id !== item.id);
  // By name the order is not the user's: a drop only moves the row into the folder (at the end).
  const index = target.pos === 'into' || sortBy.value === 'name' ? siblings.length : siblings.indexOf(t) + (target.pos === 'after' ? 1 : 0);
  siblings.splice(index, 0, item);
  const changed = siblings
    .map((s, i) => (s.id === item.id ? { ...s, parentId, sort: i } : s.sort !== i ? { ...s, sort: i } : null))
    .filter((s): s is TreeItem => !!s);
  if (!changed.length) return;
  await apply(() => api.saveItems(w.id, plain(changed)));
  if (parentId) open.add(parentId), remember();
  // A collection dropped next to one in a group joins that group.
  if (item.kind === 'collection' && target.pos !== 'into') {
    const g = layout.value.groupOf[t.id] ?? null;
    if ((layout.value.groupOf[item.id] ?? null) !== g) await moveToGroup(item, g);
  }
}

function imported(collectionId: string | null) {
  importing.value = false;
  importTab.value = { tab: 'choose' };
  if (collectionId) open.add(collectionId), remember();
}

defineExpose<Exposed>({ newCollection, newRequestIn, importNow: () => (importing.value = true) });
const SORTS: { id: SidebarLayout['sortBy']; label: string }[] = [
  { id: 'default', label: 'Default (your order)' },
  { id: 'name', label: 'Name' },
];
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div v-if="selecting" class="select-bar mx-2 mb-2" @keydown.esc="selecting = null">
      <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="allSelected" :indeterminate="selected.length > 0 && !allSelected" title="All collections" aria-label="Select all collections" @change="selectAll(($event.target as HTMLInputElement).checked)" />
      <span class="flex-1 truncate text-sm"><b>{{ selected.length }}</b> of {{ roots.length }} selected</span>
      <div v-if="layout.groups.length" class="dropdown dropdown-end">
        <button tabindex="0" class="btn btn-ghost btn-xs btn-square" title="Move to group" :disabled="!selected.length"><Icon name="group" class="size-4" /></button>
        <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-52 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-lg">
          <li class="menu-title">Move to group</li>
          <li v-for="g in layout.groups" :key="g.id"><button @click="(groupSelected(g.id), ($event.currentTarget as HTMLElement).blur())">{{ g.name }}</button></li>
          <li><button @click="(groupSelected(null), ($event.currentTarget as HTMLElement).blur())">No group</button></li>
        </ul>
      </div>
      <button class="btn btn-ghost btn-xs btn-square text-error" title="Delete the selected collections…" aria-label="Delete the selected collections" :disabled="!selected.length || readOnly" @click="removeSelected"><Icon name="trash" class="size-4" /></button>
      <button class="btn btn-ghost btn-xs" @click="selecting = null">Done</button>
    </div>
    <div v-else class="flex items-center gap-1 px-4 pt-1 pb-2">
      <span class="label-caps flex-1">Collections</span>
      <div class="dropdown dropdown-end">
        <button tabindex="0" class="btn btn-ghost btn-xs btn-square" :class="{ 'text-primary': sortBy !== 'default' }" :title="`Sort by: ${SORTS.find((x) => x.id === sortBy)?.label}`" aria-label="Sort collections" :disabled="!workspace"><Icon name="sort" class="size-4" /></button>
        <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-56 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-lg">
          <li class="menu-title">Sort by</li>
          <li v-for="o in SORTS" :key="o.id"><button :class="{ 'menu-active': sortBy === o.id }" @click="(setLayout({ sortBy: o.id }), ($event.currentTarget as HTMLElement).blur())">{{ o.label }}</button></li>
        </ul>
      </div>
      <button class="btn btn-ghost btn-xs btn-square" title="Select collections (delete or group several at once)" aria-label="Select collections" :disabled="!workspace || !roots.length" @click="startSelect()"><Icon name="check" class="size-4" /></button>
      <div class="dropdown dropdown-end">
        <button tabindex="0" class="btn btn-ghost btn-xs btn-square" title="New" aria-label="New" :disabled="!workspace"><Icon name="plus" class="size-4" /></button>
        <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-52 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-lg">
          <li><button @click="newRequestIn()">New request</button></li>
          <li><button :disabled="readOnly" @click="newCollection">New collection</button></li>
          <li><button :disabled="readOnly" @click="importing = true">Import…</button></li>
          <li><button @click="newGroup()">New group</button></li>
        </ul>
      </div>
    </div>
    <div class="px-3 pb-2">
      <label class="search-box">
        <Icon name="search" class="size-3.5 opacity-50" />
        <input v-model="filter" placeholder="Filter requests" spellcheck="false" />
      </label>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4" @dragend="endDrag">
      <!-- Favourites (this computer only) -->
      <template v-if="favorites.length && !filter">
        <div class="tree-section"><Icon name="star" class="tree-star size-3" />Favourites</div>
        <TreeNode
          v-for="c in favorites"
          :key="`fav-${c.id}`"
          :item="c"
        :items="workspace?.items ?? []"
          :depth="0"
          :open="open"
          :filter="filter"
          :drop="dropTarget"
          :sort-by="sortBy"
          :favorites="layout.favorites"
          :presence="presenceByItem"
          :selecting="selecting"
          @star="toggleFavorite"
        @toggle="toggle"
          @pick="openItem"
          @menu="showMenu"
          @drag="(i) => (dragging = i)"
          @drop="drop"
          @over="(t) => (dropTarget = t)"
          @select="toggleSelect"
        />
        <div class="tree-section">Collections</div>
      </template>

      <!-- Groups of collections -->
      <template v-for="g in layout.groups" :key="g.id">
        <div
          class="tree-section is-group"
          :class="{ 'is-drop-into': dropGroup === g.id }"
          @click="toggleGroup(g.id)"
          @contextmenu.prevent="showGroupMenu(g, $event)"
          @dragover.prevent="overGroup(g.id)"
          @dragleave="dropGroup = null"
          @drop.prevent="dropOnGroup(g.id)"
        >
          <Icon name="chevron" class="tree-chev size-3.5" :class="{ 'is-open': !groupCollapsed(g.id) || !!filter }" />
          <Icon name="group" class="size-4 opacity-60" />
          <span class="flex-1 truncate">{{ g.name }}</span>
          <span class="text-[11px] opacity-50">{{ inGroup(g.id).length }}</span>
          <button class="tree-more" title="More" @click.stop="showGroupMenu(g, $event)"><Icon name="dots" class="size-4" /></button>
        </div>
        <template v-if="!groupCollapsed(g.id) || filter">
          <TreeNode
            v-for="c in inGroup(g.id)"
            :key="c.id"
            :item="c"
        :items="workspace?.items ?? []"
            :depth="1"
            :open="open"
            :filter="filter"
            :drop="dropTarget"
            :sort-by="sortBy"
            :favorites="layout.favorites"
            :presence="presenceByItem"
            :selecting="selecting"
            @star="toggleFavorite"
        @toggle="toggle"
            @pick="openItem"
            @menu="showMenu"
            @drag="(i) => (dragging = i)"
            @drop="drop"
            @over="(t) => (dropTarget = t)"
            @select="toggleSelect"
          />
        </template>
      </template>
      <div
        v-if="layout.groups.length"
        class="tree-section"
        :class="{ 'is-drop-into': dropGroup === '' }"
        @dragover.prevent="overGroup('')"
        @dragleave="dropGroup = null"
        @drop.prevent="dropOnGroup('')"
      >
        No group
      </div>
      <TreeNode
        v-for="c in ungrouped"
        :key="c.id"
        :item="c"
        :items="workspace?.items ?? []"
        :depth="0"
        :open="open"
        :filter="filter"
        :drop="dropTarget"
        :sort-by="sortBy"
        :favorites="layout.favorites"
        :presence="presenceByItem"
        :selecting="selecting"
        @star="toggleFavorite"
        @toggle="toggle"
        @pick="openItem"
        @menu="showMenu"
        @drag="(i) => (dragging = i)"
        @drop="drop"
        @over="(t) => (dropTarget = t)"
        @select="toggleSelect"
      />
      <div v-if="workspace && !roots.length" class="space-y-3 px-3 py-8 text-center">
        <p class="text-sm opacity-60">No collections yet.</p>
        <div class="flex flex-col items-center gap-2">
          <button class="btn btn-primary btn-sm" :disabled="readOnly" @click="newCollection">New collection</button>
          <button class="btn btn-ghost btn-sm" :disabled="readOnly" @click="importing = true">Import Postman / OpenAPI</button>
        </div>
      </div>
    </div>

    <!-- Context menu -->
    <ul v-if="menu" class="menu fixed z-50 w-52 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
      <template v-if="menu.item.kind !== 'request'">
        <li><button :disabled="readOnly" @click="run((i) => newRequestIn(i.id))">New request</button></li>
        <li><button :disabled="readOnly" @click="run(newFolder)">New folder</button></li>
        <li><button :disabled="readOnly" @click="run(editAuth)">Settings…</button></li>
        <li><button @click="run((i) => (running = i))">Run…</button></li>
      </template>
      <li v-else><button @click="run(openItem)">Open</button></li>
      <li><button :disabled="readOnly" @click="run(rename)">Rename…</button></li>
      <li><button :disabled="readOnly" @click="run(duplicate)">Duplicate</button></li>
      <li><button @click="run(toggleFavorite)">{{ layout.favorites.includes(menu.item.id) ? 'Remove from favourites' : 'Add to favourites' }}</button></li>
      <template v-if="menu.item.kind === 'collection'">
        <li>
          <details>
            <summary>Move to group</summary>
            <ul>
              <li v-for="g in layout.groups" :key="g.id"><button :class="{ 'menu-active': layout.groupOf[menu.item.id] === g.id }" @click="run((i) => moveToGroup(i, g.id))">{{ g.name }}</button></li>
              <li v-if="layout.groupOf[menu.item.id]"><button @click="run((i) => moveToGroup(i, null))">No group</button></li>
              <li><button @click="run((i) => newGroup(i))">New group…</button></li>
            </ul>
          </details>
        </li>
        <li><button @click="run((i) => (copying = i))">Copy to workspace…</button></li>
        <li><button @click="run(exportIt)">Export…</button></li>
      </template>
      <li v-if="menu.item.kind === 'collection'"><button @click="run(startSelect)">Select…</button></li>
      <li><button class="text-error" :disabled="readOnly" @click="run(remove)">Delete…</button></li>
    </ul>

    <ul v-if="groupMenu" class="menu fixed z-50 w-52 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl" :style="{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }" @click.stop>
      <li><button @click="(renameGroup(groupMenu.group), (groupMenu = null))">Rename group…</button></li>
      <li><button @click="(newGroup(), (groupMenu = null))">New group…</button></li>
      <li><button class="text-error" @click="(deleteGroup(groupMenu.group), (groupMenu = null))">Delete group</button></li>
    </ul>

    <PromptDialog v-if="prompt" :title="prompt.title" :value="prompt.value" :confirm="prompt.confirm" @ok="(v) => (prompt!.done(v), (prompt = null))" @cancel="(prompt!.done(''), (prompt = null))" />
    <ConfirmDialog v-if="confirm" :title="confirm.title" :text="confirm.text" confirm="Delete" tone="error" :blocked="confirmBlocked" @ok="confirmOk" @cancel="confirm = null">
      <ul v-if="confirm.list" class="max-h-40 space-y-0.5 overflow-auto rounded-lg border border-base-300/70 p-2 text-sm">
        <li v-for="n in confirm.list" :key="n" class="flex items-center gap-2"><Icon name="collection" class="size-3.5 shrink-0 opacity-60" /><span class="truncate">{{ n }}</span></li>
      </ul>
      <div v-if="confirm.typeName" class="space-y-1.5">
        <p class="flex flex-wrap items-center gap-1 text-sm">Type <b class="font-mono">{{ confirm.typeName }}</b><button class="btn btn-ghost btn-xs btn-square" :title="confirm.list ? 'Copy the text' : 'Copy the name'" :aria-label="confirm.list ? 'Copy the text' : 'Copy the name'" @click="copyName"><Icon name="copy" class="size-3.5" /></button>to confirm:</p>
        <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="confirm.typeName" spellcheck="false" autocomplete="off" @keydown.enter="confirmOk" />
      </div>
    </ConfirmDialog>

    <dialog v-if="authFor" open class="modal modal-open" @keydown.esc="authFor = null">
      <div class="modal-box w-[40rem] max-w-[95vw] space-y-4">
        <h3 class="text-lg font-semibold tracking-tight">{{ authFor.item.name }}</h3>
        <p class="text-sm opacity-60">Requests inside that are set to “Inherit” use this auth.</p>
        <AuthEditor v-model="authFor.auth" :allow-inherit="authFor.item.kind !== 'collection'" inherited-label="Uses the auth of the folder or collection above." />
        <div v-if="authFor.item.kind === 'collection'" class="opt-row">
          <span class="flex flex-col"><span class="label-caps">Environment</span><span class="text-xs opacity-50">{{ ENV_HINT }}</span></span>
          <select v-model="authFor.env" class="select select-sm w-60">
            <option value="">Workspace default ({{ defaultEnvironment?.name ?? 'none' }})</option>
            <option value="-">No environment</option>
            <option v-for="e in workspace?.environments ?? []" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </div>
        <div v-if="authFor.item.kind === 'collection'" class="opt-row">
          <span class="flex flex-col"><span class="label-caps">Skip certificate checks</span><span class="text-xs opacity-50">For a local dev server with its own certificate. DevCatz sites are trusted already.</span></span>
          <input v-model="authFor.insecure" type="checkbox" class="toggle toggle-sm toggle-warning" />
        </div>
        <details class="space-y-2" :open="!!(authFor.preRequest.trim() || authFor.tests.trim())">
          <summary class="label-caps cursor-pointer select-none">Scripts<span class="ml-2 font-normal normal-case tracking-normal opacity-60">Run for every request inside: {{ authFor.item.kind === 'collection' ? 'this collection' : 'this folder' }} first, then folders below it, then the request's own</span></summary>
          <p class="text-xs opacity-60">Pre-request</p>
          <CodeEditor v-model="authFor.preRequest" class="h-28 rounded-lg border border-base-300/70" :placeholder="PRE_HINT" />
          <p class="text-xs opacity-60">Tests</p>
          <CodeEditor v-model="authFor.tests" class="h-28 rounded-lg border border-base-300/70" :placeholder="TESTS_HINT" />
        </details>
        <div class="opt-row items-start">
          <span class="label-caps pt-2">Notes</span>
          <textarea v-model="authFor.description" class="textarea textarea-sm min-h-20 flex-1" placeholder="What this is for, links to docs…" />
        </div>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="authFor = null">Cancel</button>
          <button class="btn btn-primary btn-sm" @click="saveAuth">Save</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="authFor = null" />
    </dialog>

    <dialog v-if="exporting" open class="modal modal-open" @keydown.esc="exporting = null">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <h3 class="text-lg font-semibold tracking-tight">Export “{{ exporting.item.name }}”</h3>
        <div class="seg seg-choice w-full" role="radiogroup" aria-label="Format">
          <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': exporting.format === 'dialcatz' }" :aria-checked="exporting.format === 'dialcatz'" @click="exporting.format = 'dialcatz'">DialCatz format</button>
          <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': exporting.format === 'postman' }" :aria-checked="exporting.format === 'postman'" @click="exporting.format = 'postman'">Postman format</button>
        </div>
        <p v-if="exporting.format === 'dialcatz'" class="text-sm opacity-70"><span class="font-mono text-xs">{{ exporting.item.name }}.dialcatz_collection.json</span> — everything DialCatz keeps (settings, scripts, descriptions), for DialCatz's Import.</p>
        <p v-else class="text-sm opacity-70"><span class="font-mono text-xs">{{ exporting.item.name }}.postman_collection.json</span> — a Postman Collection v2.1 with folders, requests, bodies, auth, scripts and descriptions. Postman and DialCatz both import it.</p>
        <p class="text-xs opacity-50">Auth values in the collection go into the file as they are. Files picked for multipart or binary bodies stay out.</p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="exporting = null">Cancel</button>
          <button class="btn btn-primary btn-sm gap-1.5" @click="doExport"><Icon name="upload" class="size-4" />Export…</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="exporting = null" />
    </dialog>
    <CopyCollectionDialog v-if="copying" :collection="copying" @close="copying = null" />
    <RunnerDialog v-if="running" :root="running" @close="running = null" />
    <ImportDialog v-if="importing" :tab="importTab.tab" :site-id="importTab.siteId" @done="imported" @cancel="((importing = false), (importTab = { tab: 'choose' }))" />
  </div>
</template>
