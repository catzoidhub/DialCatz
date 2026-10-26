<script setup lang="ts">
import { computed } from 'vue';
import type { TreeItem } from '@shared/types';
import { activeTab, readOnly } from '../state';
import Icon from './Icon.vue';

/** Where a dragged row would land relative to this one. */
export type DropPos = 'before' | 'after' | 'into';
export interface DropTarget {
  id: string;
  pos: DropPos;
}

/** One row of the collection tree, and its children when open. Actions go up to CollectionTree. */
/** `selecting`: the collections ticked while selecting several (bulk actions), null otherwise. */
const props = defineProps<{ item: TreeItem; items: TreeItem[]; depth: number; open: Set<string>; filter: string; drop: DropTarget | null; sortBy: 'default' | 'name'; favorites: string[]; presence?: Record<string, string[]>; selecting?: Set<string> | null }>();
const emit = defineEmits<{ star: [item: TreeItem]; toggle: [id: string]; pick: [item: TreeItem]; menu: [item: TreeItem, e: MouseEvent]; drag: [item: TreeItem]; drop: []; over: [target: DropTarget | null]; select: [item: TreeItem] }>();

/** Default: the order the user set (drag and drop). Name: folders first, then A–Z. */
const children = computed(() => {
  const list = props.items.filter((i) => i.parentId === props.item.id);
  if (props.sortBy === 'name') return list.sort((a, b) => Number(a.kind === 'request') - Number(b.kind === 'request') || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
});
const isOpen = computed(() => props.open.has(props.item.id) || !!props.filter);
const active = computed(() => activeTab.value?.itemId === props.item.id);
const starred = computed(() => props.favorites.includes(props.item.id));

/** With a filter: a branch shows when anything below it matches. */
function matches(i: TreeItem): boolean {
  if (!props.filter) return true;
  const f = props.filter.toLowerCase();
  if (i.name.toLowerCase().includes(f) || i.request?.url.toLowerCase().includes(f)) return true;
  return props.items.some((c) => c.parentId === i.id && matches(c));
}
const visible = computed(() => matches(props.item));
const method = computed(() => props.item.request?.method ?? 'GET');
const short: Record<string, string> = { DELETE: 'DEL', OPTIONS: 'OPT', PATCH: 'PATCH' };

// Reordering works in the user's own order only; by name the rows can still be dropped into a folder.
const canDrag = computed(() => !readOnly.value && !props.selecting);
/** While selecting, a collection's row ticks it instead of opening. */
const ticks = computed(() => !!props.selecting && props.item.kind === 'collection');
const ticked = computed(() => !!props.selecting?.has(props.item.id));
function onOver(e: DragEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (e.clientY - box.top) / box.height;
  let pos: DropPos;
  if (props.item.kind === 'request') pos = y < 0.5 ? 'before' : 'after';
  else pos = y < 0.25 ? 'before' : y > 0.75 && !isOpen.value ? 'after' : 'into';
  if (props.sortBy === 'name' && pos !== 'into') pos = props.item.kind === 'request' ? 'before' : 'into';
  if (props.drop?.id !== props.item.id || props.drop.pos !== pos) emit('over', { id: props.item.id, pos });
}
const dropClass = computed(() => (props.drop?.id === props.item.id ? `is-drop-${props.drop.pos}` : ''));
</script>

<template>
  <template v-if="visible">
    <div
      class="tree-row"
      :class="[{ 'is-active': active && !ticks, 'is-ticked': ticked }, dropClass]"
      :style="{ paddingLeft: `${8 + depth * 14}px` }"
      :draggable="canDrag"
      @click="ticks ? emit('select', item) : item.kind === 'request' ? emit('pick', item) : emit('toggle', item.id)"
      @contextmenu.prevent="emit('menu', item, $event)"
      @dragstart.stop="emit('drag', item)"
      @dragover.prevent.stop="onOver"
      @drop.prevent.stop="emit('drop')"
    >
      <template v-if="item.kind === 'request'">
        <span class="tree-method font-mono" :class="`m-${method.toLowerCase()}`">{{ short[method] ?? method }}</span>
      </template>
      <template v-else>
        <input v-if="ticks" type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="ticked" :aria-label="`Select ${item.name}`" @click.stop="emit('select', item)" />
        <Icon v-else name="chevron" class="tree-chev size-3.5" :class="{ 'is-open': isOpen }" />
        <Icon :name="item.kind === 'collection' ? 'collection' : 'folder'" class="size-4 shrink-0 opacity-70" />
      </template>
      <span class="truncate">{{ item.name }}</span>
      <button class="tree-star-btn" :class="{ 'is-on': starred }" :title="starred ? 'Remove from favourites' : 'Add to favourites'" @click.stop="emit('star', item)"><Icon name="star" class="size-3.5" /></button>
      <span v-if="item.dirty" class="tree-dirty" title="Changed here, not synced yet" />
      <span v-if="presence?.[item.id]?.length" class="tree-presence" :title="`${presence[item.id].join(', ')} ${presence[item.id].length === 1 ? 'has' : 'have'} this open`">{{ presence[item.id].map((n) => n[0]).join('') }}</span>
      <button class="tree-more" title="More" @click.stop="emit('menu', item, $event)"><Icon name="dots" class="size-4" /></button>
    </div>
    <template v-if="item.kind !== 'request' && isOpen && !ticks">
      <TreeNode
        v-for="c in children"
        :key="c.id"
        :item="c"
        :items="items"
        :depth="depth + 1"
        :open="open"
        :filter="filter"
        :drop="drop"
        :sort-by="sortBy"
        :favorites="favorites"
        :presence="presence"
        :selecting="selecting"
        @star="(i) => emit('star', i)"
        @toggle="(id) => emit('toggle', id)"
        @pick="(i) => emit('pick', i)"
        @menu="(i, e) => emit('menu', i, e)"
        @drag="(i) => emit('drag', i)"
        @drop="emit('drop')"
        @over="(t) => emit('over', t)"
        @select="(i) => emit('select', i)"
      />
      <div v-if="!children.length && !filter" class="tree-empty" :style="{ paddingLeft: `${30 + depth * 14}px` }">Empty</div>
    </template>
  </template>
</template>
