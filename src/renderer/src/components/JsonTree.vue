<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * One node of the JSON tree (recursive). Objects and arrays fold open / closed; leaves show their value in the
 * hl-* colours. `open` holds the paths that are unfolded; `hits` the paths whose key or value matches the search
 * (their branches are shown open by the parent); `active` is the current match.
 */
const props = defineProps<{ value: unknown; name: string | number | null; path: string; depth: number; open: Set<string>; hits: Set<string>; active: string | null; last: boolean }>();
const emit = defineEmits<{ toggle: [path: string]; copy: [path: string, value: unknown, what: 'value' | 'path'] }>();

const isObj = computed(() => props.value !== null && typeof props.value === 'object');
const isArr = computed(() => Array.isArray(props.value));
const entries = computed<[string | number, unknown][]>(() => (isArr.value ? (props.value as unknown[]).map((v, i) => [i, v]) : isObj.value ? Object.entries(props.value as object) : []));
const isOpen = computed(() => props.open.has(props.path));
const childPath = (k: string | number) => (typeof k === 'number' ? `${props.path}[${k}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? `${props.path}.${k}` : `${props.path}[${JSON.stringify(k)}]`);
const leafClass = computed(() => (typeof props.value === 'string' ? 'hl-str' : typeof props.value === 'number' ? 'hl-num' : 'hl-const'));
const leafText = computed(() => (typeof props.value === 'string' ? JSON.stringify(props.value) : String(props.value)));
const summary = computed(() => (isArr.value ? `${entries.value.length} item${entries.value.length === 1 ? '' : 's'}` : `${entries.value.length} key${entries.value.length === 1 ? '' : 's'}`));
const hit = computed(() => props.hits.has(props.path));
// Big arrays / objects show 500 children at a time.
const limit = ref(500);
const shown = computed(() => entries.value.slice(0, limit.value));
</script>

<template>
  <div class="jt-node" :data-path="path">
    <div class="jt-row" :class="{ 'is-hit': hit, 'is-active': active === path }" :style="{ paddingLeft: `${depth * 16 + 4}px` }" @click="isObj && emit('toggle', path)">
      <span class="jt-twisty">{{ isObj ? (isOpen ? '▾' : '▸') : '' }}</span>
      <template v-if="name !== null">
        <span :class="typeof name === 'number' ? 'jt-index' : 'hl-key'">{{ typeof name === 'number' ? name : JSON.stringify(name) }}</span><span class="hl-punct">:&nbsp;</span>
      </template>
      <template v-if="isObj">
        <span class="hl-br hl-br-0">{{ isArr ? '[' : '{' }}</span>
        <template v-if="!isOpen"><span class="jt-summary">{{ summary }}</span><span class="hl-br hl-br-0">{{ isArr ? ']' : '}' }}</span><span v-if="!last" class="hl-punct">,</span></template>
      </template>
      <template v-else><span :class="leafClass" class="jt-leaf">{{ leafText }}</span><span v-if="!last" class="hl-punct">,</span></template>
      <span class="jt-actions" @click.stop>
        <button title="Copy value" @click="emit('copy', path, value, 'value')">copy</button>
        <button title="Copy path" @click="emit('copy', path, value, 'path')">path</button>
      </span>
    </div>
    <template v-if="isObj && isOpen">
      <JsonTree
        v-for="([k, v], i) in shown"
        :key="String(k)"
        :value="v"
        :name="k"
        :path="childPath(k)"
        :depth="depth + 1"
        :open="open"
        :hits="hits"
        :active="active"
        :last="i === entries.length - 1"
        @toggle="(p) => emit('toggle', p)"
        @copy="(p, val, w) => emit('copy', p, val, w)"
      />
      <div v-if="entries.length > limit" class="jt-row" :style="{ paddingLeft: `${(depth + 1) * 16 + 4}px` }">
        <button class="btn btn-ghost btn-xs" @click.stop="limit += 500">Show {{ Math.min(500, entries.length - limit) }} more of {{ entries.length - limit }}</button>
      </div>
      <div class="jt-row" :style="{ paddingLeft: `${depth * 16 + 4}px` }"><span class="jt-twisty" /><span class="hl-br hl-br-0">{{ isArr ? ']' : '}' }}</span><span v-if="!last" class="hl-punct">,</span></div>
    </template>
  </div>
</template>
