<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { notify } from '../state';
import JsonTree from './JsonTree.vue';

/**
 * The JSON response as a tree: fold objects and arrays (two levels open at first), expand / collapse all, search
 * keys and values (matches highlighted, their branches opened, next / previous), copy a value or its path ($.a[0].b).
 */
const props = defineProps<{ value: unknown; search: string; activeIndex: number }>();
const emit = defineEmits<{ matches: [count: number] }>();

const ROOT = '$';
const open = ref(new Set<string>());

function childPath(path: string, k: string | number) {
  return typeof k === 'number' ? `${path}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`;
}
/** Every branch path, with its depth (for "expand all" and the first view). */
function walk(v: unknown, path: string, depth: number, visit: (path: string, depth: number, key: string | number | null, value: unknown, parents: string[]) => void, key: string | number | null = null, parents: string[] = []) {
  visit(path, depth, key, v, parents);
  if (v !== null && typeof v === 'object') {
    const kids = Array.isArray(v) ? v.map((x, i) => [i, x] as const) : Object.entries(v as object);
    for (const [k, x] of kids) walk(x, childPath(path, k), depth + 1, visit, k, [...parents, path]);
  }
}
function expandTo(level: number) {
  const s = new Set<string>();
  let n = 0;
  walk(props.value, ROOT, 0, (p, d, _k, v) => {
    if (v !== null && typeof v === 'object' && d < level && n++ < 5000) s.add(p);
  });
  open.value = s;
}
watch(() => props.value, () => expandTo(2), { immediate: true });

// Search: paths whose key or leaf value contains the text; their parents are shown open.
const found = computed(() => {
  const q = props.search.trim().toLowerCase();
  const hits: string[] = [];
  const parents = new Set<string>();
  if (!q) return { hits, parents };
  walk(props.value, ROOT, 0, (p, _d, k, v, ps) => {
    const keyHit = k !== null && String(k).toLowerCase().includes(q);
    const valHit = (v === null || typeof v !== 'object') && String(v).toLowerCase().includes(q);
    if ((keyHit || valHit) && hits.length < 5000) {
      hits.push(p);
      for (const x of ps) parents.add(x);
    }
  });
  return { hits, parents };
});
const hitSet = computed(() => new Set(found.value.hits));
const shownOpen = computed(() => (found.value.parents.size ? new Set([...open.value, ...found.value.parents]) : open.value));
const active = computed(() => (found.value.hits.length ? found.value.hits[((props.activeIndex % found.value.hits.length) + found.value.hits.length) % found.value.hits.length] : null));
watch(() => found.value.hits.length, (n) => emit('matches', n), { immediate: true });

const box = ref<HTMLElement | null>(null);
watch(active, async (p) => {
  if (!p) return;
  await nextTick();
  box.value?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"] > .jt-row`)?.scrollIntoView({ block: 'center' });
});

function toggle(path: string) {
  const s = new Set(open.value);
  if (s.has(path)) s.delete(path);
  else s.add(path);
  open.value = s;
}
async function copy(path: string, value: unknown, what: 'value' | 'path') {
  await window.dialcatz.copyText(what === 'path' ? path : typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  notify('success', what === 'path' ? `Copied ${path}` : 'Value copied');
}
defineExpose({ expandAll: () => expandTo(64), collapseAll: () => (open.value = new Set([ROOT])) });
</script>

<template>
  <div ref="box" class="json-tree selectable">
    <JsonTree :value="value" :name="null" :path="ROOT" :depth="0" :open="shownOpen" :hits="hitSet" :active="active" :last="true" @toggle="toggle" @copy="copy" />
  </div>
</template>
