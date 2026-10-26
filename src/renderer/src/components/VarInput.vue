<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { esc, markVars } from '../highlight';
import { knownVar, openVariable, setVarValue, varSource, vars } from '../state';

/**
 * A one-line input that shows {{variables}} in colour (known teal, unknown red) — a transparent input over a mirror
 * — with the resolved value as a tooltip. Typing "{{" offers the variable names; clicking inside a {{variable}}
 * opens a popover with its value, where it comes from, a quick edit and "Open environment".
 */
const props = withDefaults(defineProps<{ modelValue: string; placeholder?: string; readonly?: boolean; mono?: boolean }>(), { placeholder: '', readonly: false, mono: true });
const emit = defineEmits<{ 'update:modelValue': [v: string]; enter: [] }>();

const input = ref<HTMLInputElement | null>(null);
const mirror = ref<HTMLDivElement | null>(null);
const html = computed(() => markVars(esc(props.modelValue), knownVar) || '');
const hasVars = computed(() => props.modelValue.includes('{{'));
const title = computed(() => {
  const names = [...props.modelValue.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)].map((m) => m[1]);
  if (!names.length) return undefined;
  return names.map((n) => `${n} = ${vars.value.has(n) ? vars.value.get(n) || '(empty)' : n.startsWith('$') ? '(generated when sent)' : '(not set in this environment)'}`).join('\n');
});

const open = ref(false);
const query = ref('');
const pick = ref(0);
const choices = computed(() => [...vars.value.keys()].filter((k) => k.toLowerCase().includes(query.value.toLowerCase())).slice(0, 8));

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  emit('update:modelValue', el.value);
  const before = el.value.slice(0, el.selectionStart ?? el.value.length);
  const m = before.match(/\{\{\s*([\w.$-]*)$/);
  open.value = !!m && vars.value.size > 0;
  query.value = m?.[1] ?? '';
  pick.value = 0;
  syncScroll();
}
function choose(name: string) {
  const el = input.value!;
  const pos = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, pos).replace(/\{\{\s*([\w.$-]*)$/, `{{${name}}}`);
  const after = el.value.slice(pos).replace(/^\s*\}\}/, '');
  emit('update:modelValue', before + after);
  open.value = false;
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(before.length, before.length);
  });
}
function onKey(e: KeyboardEvent) {
  if (open.value && choices.value.length) {
    if (e.key === 'ArrowDown') return (e.preventDefault(), (pick.value = (pick.value + 1) % choices.value.length));
    if (e.key === 'ArrowUp') return (e.preventDefault(), (pick.value = (pick.value - 1 + choices.value.length) % choices.value.length));
    if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), choose(choices.value[pick.value]));
    if (e.key === 'Escape') return (open.value = false);
  }
  if (e.key === 'Enter') emit('enter');
}
// ---------------------------------------------------------------- clicked variable

const pop = ref<{ name: string; value: string; masked: boolean } | null>(null);
const src = computed(() => (pop.value ? varSource(pop.value.name) : null));
function onClick() {
  const el = input.value;
  if (!el || props.readonly) return;
  const at = el.selectionStart ?? 0;
  for (const m of props.modelValue.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)) {
    if (at > m.index! && at < m.index! + m[0].length) {
      if (m[1].startsWith('$')) return;
      const s = varSource(m[1]);
      pop.value = { name: m[1], value: s.variable?.value ?? '', masked: !!s.variable?.secret };
      return;
    }
  }
  pop.value = null;
}
async function saveVar() {
  if (pop.value && (await setVarValue(pop.value.name, pop.value.value))) pop.value = null;
}
// A click anywhere outside the input and its popover closes it.
const root = ref<HTMLElement | null>(null);
const outside = (e: MouseEvent) => {
  if (root.value && !root.value.contains(e.target as Node)) pop.value = null;
};
watch(pop, (p, was) => {
  if (p && !was) window.addEventListener('mousedown', outside);
  if (!p) window.removeEventListener('mousedown', outside);
});
onBeforeUnmount(() => window.removeEventListener('mousedown', outside));

function syncScroll() {
  requestAnimationFrame(() => {
    if (mirror.value && input.value) mirror.value.scrollLeft = input.value.scrollLeft;
  });
}
defineExpose({ focus: () => input.value?.focus(), select: () => input.value?.select() });
</script>

<template>
  <div ref="root" class="var-input" :class="{ 'font-mono': mono, 'has-vars': hasVars }" :title="pop ? undefined : title">
    <div v-if="hasVars" ref="mirror" class="var-mirror" aria-hidden="true" v-html="html" />
    <input ref="input" :value="modelValue" :placeholder="placeholder" :readonly="readonly" spellcheck="false" autocomplete="off" @input="onInput" @keydown="onKey" @scroll="syncScroll" @keyup="syncScroll" @blur="open = false" @click="onClick" />
    <div v-if="pop" class="var-pop" @keydown.esc="pop = null">
      <div class="flex items-center gap-2">
        <span class="hl-var font-mono text-sm" :class="{ 'is-unknown': !src?.variable }">{{ '\{\{' + pop.name + '\}\}' }}</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs btn-square" title="Close" @click="pop = null">×</button>
      </div>
      <p class="mt-1 text-xs opacity-60">{{ src?.variable ? `From ${src.where === 'globals' ? 'Globals' : `environment “${src.label}”`}` : `Not set — saving adds it to ${src?.where === null && src.envId ? `“${src.label}”` : 'Globals'}` }}</p>
      <input v-model="pop.value" :type="pop.masked ? 'password' : 'text'" class="input input-sm mt-2 w-full font-mono" placeholder="value" @keydown.enter="saveVar" />
      <div class="mt-2 flex items-center gap-2">
        <button class="btn btn-ghost btn-xs" @click="(openVariable(pop.name), (pop = null))">Open environment</button>
        <span class="flex-1" />
        <button class="btn btn-primary btn-xs" @click="saveVar">Save</button>
      </div>
    </div>
    <ul v-if="open && choices.length" class="var-suggest" @mousedown.prevent>
      <li v-for="(c, i) in choices" :key="c" :class="{ 'is-active': i === pick }" @mouseenter="pick = i" @click="choose(c)">
        <span class="font-mono">{{ c }}</span><span class="truncate opacity-50">{{ vars.get(c) }}</span>
      </li>
    </ul>
  </div>
</template>
