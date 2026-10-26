<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { emptyEnvLayout, uid, type EnvLayout, type Environment } from '@shared/types';
import { attempt, plain, readOnly, setWorkspace, workspace } from '../state';
import PromptDialog from './PromptDialog.vue';
import Icon from './Icon.vue';

/**
 * The environment list of the Variables sidebar, arranged like the collection tree: a filter, favourites, groups
 * (fold, rename, delete), drag to reorder or into a group, and a context menu. The arrangement is this computer's
 * own (workspace.layout.env); the environments themselves are not changed by it. While selecting several (bulk
 * delete) rows tick instead of opening.
 */
const props = defineProps<{ selected: string; picking: Set<string> | null }>();
const emit = defineEmits<{ pick: [id: string]; tick: [id: string]; remove: [env: Environment] }>();
const api = window.dialcatz;

const filter = ref('');
const lay = computed<EnvLayout>(() => workspace.value?.layout.env ?? emptyEnvLayout());
async function setLay(patch: Partial<EnvLayout>) {
  const w = workspace.value;
  if (!w) return;
  const next = await attempt(() => api.saveLayout(w.id, plain({ ...w.layout, env: { ...lay.value, ...patch } })));
  if (next) setWorkspace(next);
}

/** Default: the dragged order (environments never dragged keep their own order after those). Name: A–Z. */
const ordered = computed(() => {
  const list = workspace.value?.environments ?? [];
  if (lay.value.sortBy === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const at = new Map(lay.value.order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => (at.get(a.id) ?? 1e6 + list.indexOf(a)) - (at.get(b.id) ?? 1e6 + list.indexOf(b)));
});
const matches = (e: Environment) => !filter.value.trim() || e.name.toLowerCase().includes(filter.value.trim().toLowerCase());
const groupIds = computed(() => new Set(lay.value.groups.map((g) => g.id)));
const inGroup = (id: string) => ordered.value.filter((e) => lay.value.groupOf[e.id] === id && matches(e));
const ungrouped = computed(() => ordered.value.filter((e) => !groupIds.value.has(lay.value.groupOf[e.id] ?? '') && matches(e)));
const favorites = computed(() => lay.value.favorites.map((id) => ordered.value.find((e) => e.id === id)).filter((e): e is Environment => !!e));
const collapsed = (id: string) => lay.value.collapsed.includes(id) && !filter.value.trim();
const nothing = computed(() => !!filter.value.trim() && !ordered.value.some(matches));

const toggleFav = (e: Environment) => setLay({ favorites: lay.value.favorites.includes(e.id) ? lay.value.favorites.filter((f) => f !== e.id) : [...lay.value.favorites, e.id] });
const toggleGroup = (id: string) => setLay({ collapsed: lay.value.collapsed.includes(id) ? lay.value.collapsed.filter((c) => c !== id) : [...lay.value.collapsed, id] });
function moveTo(e: Environment, groupId: string | null) {
  const groupOf = { ...lay.value.groupOf };
  if (groupId) groupOf[e.id] = groupId;
  else delete groupOf[e.id];
  return setLay({ groupOf });
}

// ---------------------------------------------------------------- groups (named in a small prompt)

const prompt = ref<{ title: string; value: string; confirm: string; done: (v: string) => void } | null>(null);
const ask = (title: string, value: string, confirm: string) => new Promise<string>((done) => (prompt.value = { title, value, confirm, done }));
async function newGroup(forEnv?: Environment) {
  const name = (await ask('New group', 'Group', 'Create')).trim();
  if (!name) return;
  const id = uid('g_');
  await setLay({ groups: [...lay.value.groups, { id, name }], groupOf: forEnv ? { ...lay.value.groupOf, [forEnv.id]: id } : lay.value.groupOf });
}
async function renameGroup(g: { id: string; name: string }) {
  const name = (await ask('Rename group', g.name, 'Rename')).trim();
  if (name) await setLay({ groups: lay.value.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) });
}
const deleteGroup = (g: { id: string }) => setLay({ groups: lay.value.groups.filter((x) => x.id !== g.id), groupOf: Object.fromEntries(Object.entries(lay.value.groupOf).filter(([, v]) => v !== g.id)) });
defineExpose({ newGroup: () => newGroup(), setSort: (sortBy: EnvLayout['sortBy']) => setLay({ sortBy }) });

// ---------------------------------------------------------------- context menus

const menu = ref<{ env: Environment; x: number; y: number } | null>(null);
const groupMenu = ref<{ group: { id: string; name: string }; x: number; y: number } | null>(null);
function showMenu(env: Environment, e: MouseEvent) {
  groupMenu.value = null;
  menu.value = { env, x: Math.min(e.clientX, window.innerWidth - 230), y: Math.min(e.clientY, window.innerHeight - 300) };
}
function showGroupMenu(group: { id: string; name: string }, e: MouseEvent) {
  menu.value = null;
  groupMenu.value = { group, x: Math.min(e.clientX, window.innerWidth - 220), y: Math.min(e.clientY, window.innerHeight - 120) };
}
const close = () => ((menu.value = null), (groupMenu.value = null));
onMounted(() => window.addEventListener('click', close));
onBeforeUnmount(() => window.removeEventListener('click', close));
function run(fn: (e: Environment) => unknown) {
  const e = menu.value!.env;
  menu.value = null;
  void fn(e);
}
async function makeDefault(e: Environment) {
  const w = await attempt(() => api.setActiveEnvironment(workspace.value!.id, e.id));
  if (w) setWorkspace(w);
}

// ---------------------------------------------------------------- drag to reorder, or into a group

const dragging = ref<string | null>(null);
const over = ref<{ id: string; pos: 'before' | 'after' } | null>(null);
const overGroup = ref<string | null>(null);
const canDrag = computed(() => !props.picking);
function dragOver(e: Environment, ev: DragEvent) {
  if (!dragging.value || dragging.value === e.id) return;
  const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  over.value = { id: e.id, pos: ev.clientY - box.top < box.height / 2 ? 'before' : 'after' };
}
function endDrag() {
  dragging.value = null;
  over.value = null;
  overGroup.value = null;
}
/** Dropped on a row: placed before / after it, and into its group. */
async function dropOn(target: Environment) {
  const id = dragging.value;
  const pos = over.value?.pos ?? 'before';
  endDrag();
  if (!id || id === target.id) return;
  // Sorted by name the order is not the user's: a drop only moves into the target's group.
  const order = lay.value.sortBy === 'name' ? lay.value.order : ordered.value.map((e) => e.id).filter((x) => x !== id);
  if (lay.value.sortBy !== 'name') order.splice(order.indexOf(target.id) + (pos === 'after' ? 1 : 0), 0, id);
  const groupOf = { ...lay.value.groupOf };
  const g = lay.value.groupOf[target.id];
  if (g) groupOf[id] = g;
  else delete groupOf[id];
  await setLay({ order, groupOf });
}
/** Dropped on a group's header ('' = no group). */
async function dropOnGroup(groupId: string) {
  const id = dragging.value;
  endDrag();
  const e = ordered.value.find((x) => x.id === id);
  if (e) await moveTo(e, groupId || null);
}

const active = (e: Environment) => e.id === workspace.value?.activeEnvironmentId;
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="px-3 pb-2">
      <label class="search-box">
        <Icon name="search" class="size-3.5 opacity-50" />
        <input v-model="filter" placeholder="Filter environments" spellcheck="false" />
      </label>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4" @dragend="endDrag">
      <button class="env-row" :class="{ 'is-active': selected === '__globals' && !picking }" @click="emit('pick', '__globals')">
        <Icon name="environments" class="size-4 shrink-0 opacity-60" /><span class="flex-1 truncate text-left">Globals</span><span class="badge badge-ghost badge-xs">local</span>
      </button>

      <template v-if="favorites.length && !filter.trim()">
        <div class="tree-section"><Icon name="star" class="tree-star size-3" />Favourites</div>
        <template v-for="e in favorites" :key="`fav-${e.id}`">
          <button class="env-row" :class="{ 'is-active': selected === e.id && !picking, 'is-ticked': picking?.has(e.id) }" @click="picking ? emit('tick', e.id) : emit('pick', e.id)" @contextmenu.prevent="showMenu(e, $event)">
            <input v-if="picking" type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="picking.has(e.id)" tabindex="-1" :aria-label="`Select ${e.name}`" @click.stop="emit('tick', e.id)" />
            <span v-else class="status status-xs" :class="active(e) ? 'status-success' : 'opacity-30'" :title="active(e) ? 'Default' : undefined" />
            <span class="flex-1 truncate text-left">{{ e.name }}</span>
            <span class="tree-star-btn is-on" title="Remove from favourites" @click.stop="toggleFav(e)"><Icon name="star" class="size-3.5" /></span>
          </button>
        </template>
        <div class="tree-section">Environments</div>
      </template>

      <template v-for="g in lay.groups" :key="g.id">
        <template v-if="!filter.trim() || inGroup(g.id).length">
          <div
            class="tree-section is-group"
            :class="{ 'is-drop-into': overGroup === g.id }"
            @click="toggleGroup(g.id)"
            @contextmenu.prevent="showGroupMenu(g, $event)"
            @dragover.prevent="dragging && (overGroup = g.id)"
            @dragleave="overGroup = null"
            @drop.prevent="dropOnGroup(g.id)"
          >
            <Icon name="chevron" class="tree-chev size-3.5" :class="{ 'is-open': !collapsed(g.id) }" />
            <Icon name="group" class="size-4 opacity-60" />
            <span class="flex-1 truncate">{{ g.name }}</span>
            <span class="text-[11px] opacity-50">{{ inGroup(g.id).length }}</span>
            <button class="tree-more" title="More" @click.stop="showGroupMenu(g, $event)"><Icon name="dots" class="size-4" /></button>
          </div>
          <template v-if="!collapsed(g.id)">
            <template v-for="e in inGroup(g.id)" :key="e.id">
              <button
                class="env-row"
                style="padding-left: 30px"
                :class="{ 'is-active': selected === e.id && !picking, 'is-ticked': picking?.has(e.id), [`is-drop-${over?.pos}`]: over?.id === e.id }"
                :draggable="canDrag"
                @click="picking ? emit('tick', e.id) : emit('pick', e.id)"
                @contextmenu.prevent="showMenu(e, $event)"
                @dragstart="dragging = e.id"
                @dragover.prevent="dragOver(e, $event)"
                @drop.prevent.stop="dropOn(e)"
              >
                <input v-if="picking" type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="picking.has(e.id)" tabindex="-1" :aria-label="`Select ${e.name}`" @click.stop="emit('tick', e.id)" />
                <span v-else class="status status-xs" :class="active(e) ? 'status-success' : 'opacity-30'" :title="active(e) ? 'Default' : undefined" />
                <span class="flex-1 truncate text-left">{{ e.name }}</span>
                <span class="tree-star-btn" :class="{ 'is-on': lay.favorites.includes(e.id) }" :title="lay.favorites.includes(e.id) ? 'Remove from favourites' : 'Add to favourites'" @click.stop="toggleFav(e)"><Icon name="star" class="size-3.5" /></span>
                <span v-if="e.dirty" class="tree-dirty" title="Not synced yet" />
              </button>
            </template>
          </template>
        </template>
      </template>
      <div
        v-if="lay.groups.length && (!filter.trim() || ungrouped.length)"
        class="tree-section"
        :class="{ 'is-drop-into': overGroup === '' }"
        @dragover.prevent="dragging && (overGroup = '')"
        @dragleave="overGroup = null"
        @drop.prevent="dropOnGroup('')"
      >
        No group
      </div>
      <template v-for="e in ungrouped" :key="e.id">
        <button
          class="env-row"
          :class="{ 'is-active': selected === e.id && !picking, 'is-ticked': picking?.has(e.id), [`is-drop-${over?.pos}`]: over?.id === e.id }"
          :draggable="canDrag"
          @click="picking ? emit('tick', e.id) : emit('pick', e.id)"
          @contextmenu.prevent="showMenu(e, $event)"
          @dragstart="dragging = e.id"
          @dragover.prevent="dragOver(e, $event)"
          @drop.prevent.stop="dropOn(e)"
        >
          <input v-if="picking" type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="picking.has(e.id)" tabindex="-1" :aria-label="`Select ${e.name}`" @click.stop="emit('tick', e.id)" />
          <span v-else class="status status-xs" :class="active(e) ? 'status-success' : 'opacity-30'" :title="active(e) ? 'Default' : undefined" />
          <span class="flex-1 truncate text-left">{{ e.name }}</span>
          <span class="tree-star-btn" :class="{ 'is-on': lay.favorites.includes(e.id) }" :title="lay.favorites.includes(e.id) ? 'Remove from favourites' : 'Add to favourites'" @click.stop="toggleFav(e)"><Icon name="star" class="size-3.5" /></span>
          <span v-if="e.dirty" class="tree-dirty" title="Not synced yet" />
        </button>
      </template>
      <p v-if="nothing" class="px-3 py-4 text-sm opacity-60">Nothing matches “{{ filter.trim() }}”.</p>
    </div>

    <ul v-if="menu" class="menu fixed z-50 w-56 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }" @click.stop>
      <li><button @click="run((e) => emit('pick', e.id))">Open</button></li>
      <li><button :disabled="active(menu.env)" @click="run(makeDefault)">Make default</button></li>
      <li><button @click="run(toggleFav)">{{ lay.favorites.includes(menu.env.id) ? 'Remove from favourites' : 'Add to favourites' }}</button></li>
      <li>
        <details>
          <summary>Move to group</summary>
          <ul>
            <li v-for="g in lay.groups" :key="g.id"><button :class="{ 'menu-active': lay.groupOf[menu.env.id] === g.id }" @click="run((e) => moveTo(e, g.id))">{{ g.name }}</button></li>
            <li v-if="lay.groupOf[menu.env.id]"><button @click="run((e) => moveTo(e, null))">No group</button></li>
            <li><button @click="run((e) => newGroup(e))">New group…</button></li>
          </ul>
        </details>
      </li>
      <li><button class="text-error" :disabled="readOnly" @click="run((e) => emit('remove', e))">Delete…</button></li>
    </ul>
    <ul v-if="groupMenu" class="menu fixed z-50 w-52 rounded-box border border-base-300/60 bg-base-100 p-1 shadow-xl" :style="{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }" @click.stop>
      <li><button @click="(renameGroup(groupMenu.group), (groupMenu = null))">Rename group…</button></li>
      <li><button @click="(newGroup(), (groupMenu = null))">New group…</button></li>
      <li><button class="text-error" @click="(deleteGroup(groupMenu.group), (groupMenu = null))">Delete group</button></li>
    </ul>
    <PromptDialog v-if="prompt" :title="prompt.title" :value="prompt.value" :confirm="prompt.confirm" @ok="(v) => (prompt!.done(v), (prompt = null))" @cancel="(prompt!.done(''), (prompt = null))" />
  </div>
</template>
