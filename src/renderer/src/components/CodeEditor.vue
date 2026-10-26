<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { esc, highlight, markVars, type Language } from '../highlight';
import { modKey } from '../platform';

/**
 * A code editor without a dependency (the DBCatz one, trimmed): a transparent textarea over a highlighted <pre>
 * that scrolls with it, line numbers in a gutter. Tab inserts two spaces; mod+Enter emits `run`. {{variables}}
 * are marked (unknown ones red) when `known` is given. Read-only mode is for response bodies.
 */
const props = withDefaults(defineProps<{ modelValue: string; language?: Language; readonly?: boolean; placeholder?: string; known?: (name: string) => boolean; wrap?: boolean; search?: string; activeIndex?: number }>(), {
  language: 'text',
  readonly: false,
  placeholder: '',
  wrap: false,
  search: '',
  activeIndex: 0,
});
const emit = defineEmits<{ 'update:modelValue': [value: string]; run: []; matches: [count: number] }>();

const pre = ref<HTMLPreElement | null>(null);
const gutter = ref<HTMLDivElement | null>(null);
// Highlighting is drawn for the first LIMIT characters (more for read-only views such as a response); past that the
// text shows uncoloured, so a huge body stays usable. It used to drop the colours for the whole text once over it.
const LIMIT = 400_000;
const limit = computed(() => (props.readonly ? 2_000_000 : LIMIT));
const html = computed(() => {
  const src = props.modelValue;
  const cut = Math.min(src.length, limit.value);
  const h = highlight(props.language, src.slice(0, cut)) + esc(src.slice(cut));
  return `${props.known ? markVars(h, props.known) : h}\n`;
});
const lines = computed(() => {
  const n = props.modelValue.split('\n').length;
  return Array.from({ length: Math.min(n, 50_000) }, (_, i) => i + 1).join('\n');
});

// Search: a layer under the text with a <mark> per match (case-insensitive), the active one in another colour.
const marksEl = ref<HTMLPreElement | null>(null);
const area = ref<HTMLTextAreaElement | null>(null);
const matches = computed(() => {
  const q = props.search.toLowerCase();
  const out: number[] = [];
  if (!q) return out;
  const text = props.modelValue.toLowerCase();
  for (let i = text.indexOf(q); i >= 0 && out.length < 10_000; i = text.indexOf(q, i + q.length)) out.push(i);
  return out;
});
const activeAt = computed(() => (matches.value.length ? ((props.activeIndex % matches.value.length) + matches.value.length) % matches.value.length : -1));
const marks = computed(() => {
  if (!matches.value.length) return '';
  const src = props.modelValue;
  const n = props.search.length;
  let out = '';
  let last = 0;
  matches.value.forEach((at, i) => {
    out += esc(src.slice(last, at)) + `<mark class="${i === activeAt.value ? 'is-active' : ''}">${esc(src.slice(at, at + n))}</mark>`;
    last = at + n;
  });
  return `${out + esc(src.slice(last))}\n`;
});
watch(() => matches.value.length, (n) => emit('matches', n), { immediate: true });
watch([activeAt, () => props.search], async () => {
  await nextTick();
  const a = area.value;
  if (!a || activeAt.value < 0) return;
  const line = props.modelValue.slice(0, matches.value[activeAt.value]).split('\n').length - 1;
  const lh = parseFloat(getComputedStyle(a).lineHeight) || 19;
  a.scrollTop = Math.max(0, line * lh - a.clientHeight / 2);
  onScroll({ target: a } as unknown as Event);
});

function onScroll(e: Event) {
  const a = e.target as HTMLTextAreaElement;
  for (const el of [pre.value, marksEl.value]) {
    if (!el) continue;
    el.scrollTop = a.scrollTop;
    el.scrollLeft = a.scrollLeft;
  }
  if (gutter.value) gutter.value.scrollTop = a.scrollTop;
}

function onKey(ev: KeyboardEvent) {
  const a = ev.target as HTMLTextAreaElement;
  if (ev.key === 'Enter' && modKey(ev)) {
    ev.preventDefault();
    emit('run');
  } else if (ev.key === 'Tab' && !props.readonly && !ev.shiftKey) {
    ev.preventDefault();
    const s = a.selectionStart;
    const v = `${a.value.slice(0, s)}  ${a.value.slice(a.selectionEnd)}`;
    emit('update:modelValue', v);
    requestAnimationFrame(() => a.setSelectionRange(s + 2, s + 2));
  }
}
</script>

<template>
  <div class="code-box" :class="{ 'is-wrap': wrap }">
    <div ref="gutter" class="code-gutter" aria-hidden="true">{{ lines }}</div>
    <div class="code-area">
      <pre v-if="marks" ref="marksEl" class="code-hl code-marks" aria-hidden="true" v-html="marks" />
      <pre ref="pre" class="code-hl" aria-hidden="true" v-html="html" />
      <textarea
        ref="area"
        class="code-input selectable"
        :value="modelValue"
        :readonly="readonly"
        :placeholder="placeholder"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
        @scroll="onScroll"
        @keydown="onKey"
      />
    </div>
  </div>
</template>
