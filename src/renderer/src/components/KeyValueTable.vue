<script setup lang="ts">
import { computed } from 'vue';
import type { KeyValue } from '@shared/types';
import VarInput from './VarInput.vue';
import Icon from './Icon.vue';

/**
 * An editable key / value table (params, headers, form fields). There is always one empty row at the end: typing
 * into it adds a row. Each row has a switch, a key, a value with {{variable}} marks, a quieter description (notes
 * for people, never sent; Postman's come along on import), and a remove button. With
 * `allowFiles` (multipart) a row can hold a file instead of text: picked with the system dialog, sent as a file part.
 */
const props = withDefaults(defineProps<{ modelValue: KeyValue[]; keyPlaceholder?: string; valuePlaceholder?: string; readonly?: boolean; suggestions?: string[]; allowFiles?: boolean }>(), {
  keyPlaceholder: 'Key',
  valuePlaceholder: 'Value',
  readonly: false,
  suggestions: () => [],
  allowFiles: false,
});
const emit = defineEmits<{ 'update:modelValue': [rows: KeyValue[]] }>();

const rows = computed(() => (props.readonly ? props.modelValue : [...props.modelValue, { key: '', value: '', enabled: true }]));
const listId = `kv-${Math.random().toString(36).slice(2, 8)}`;

function set(i: number, patch: Partial<KeyValue>) {
  const next = props.modelValue.map((r) => ({ ...r }));
  if (i >= next.length) next.push({ key: '', value: '', enabled: true, ...patch });
  else next[i] = { ...next[i], ...patch };
  emit('update:modelValue', next);
}
function remove(i: number) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, n) => n !== i),
  );
}
async function pick(i: number) {
  const path = await window.dialcatz.pickFile('Choose the file to send');
  if (path) set(i, { type: 'file', src: path, value: '' });
}
const fileName = (p?: string) => (p ? p.split(/[\\/]/).pop() : '');
</script>

<template>
  <div class="kv-table" :class="{ 'has-type': allowFiles }">
    <datalist v-if="suggestions.length" :id="listId">
      <option v-for="s in suggestions" :key="s" :value="s" />
    </datalist>
    <div v-for="(r, i) in rows" :key="i" class="kv-row" :class="{ 'is-off': !r.enabled, 'is-new': i === modelValue.length }">
      <input v-if="i < modelValue.length" type="checkbox" class="toggle toggle-xs toggle-primary" :checked="r.enabled" :disabled="readonly" title="Send this row" @change="set(i, { enabled: ($event.target as HTMLInputElement).checked })" />
      <span v-else class="w-6" />
      <input class="kv-cell font-mono" :value="r.key" :placeholder="keyPlaceholder" :readonly="readonly" :list="suggestions.length ? listId : undefined" spellcheck="false" @input="set(i, { key: ($event.target as HTMLInputElement).value })" />
      <select v-if="allowFiles" class="kv-type" :value="r.type ?? 'text'" :disabled="readonly" title="Text or file" @change="set(i, { type: ($event.target as HTMLSelectElement).value as 'text' | 'file', src: undefined })">
        <option value="text">Text</option>
        <option value="file">File</option>
      </select>
      <div v-if="allowFiles && r.type === 'file'" class="kv-cell flex items-center gap-2">
        <button class="btn btn-ghost btn-xs gap-1" :disabled="readonly" @click="pick(i)"><Icon name="file" class="size-3.5" />{{ r.src ? 'Change…' : 'Choose file…' }}</button>
        <span class="truncate font-mono text-xs" :class="r.src ? '' : 'opacity-50'" :title="r.src">{{ r.src ? fileName(r.src) : 'no file picked on this computer' }}</span>
      </div>
      <VarInput v-else class="kv-cell" :model-value="r.value" :placeholder="valuePlaceholder" :readonly="readonly" @update:model-value="(v) => set(i, { value: v })" />
      <input class="kv-cell kv-desc" :value="r.description ?? ''" placeholder="Description" :readonly="readonly" :title="r.description || 'A note for people: not sent'" @input="set(i, { description: ($event.target as HTMLInputElement).value || undefined })" />
      <button v-if="i < modelValue.length && !readonly" class="kv-del" title="Remove" @click="remove(i)"><Icon name="x" class="size-3.5" /></button>
      <span v-else class="w-6" />
    </div>
  </div>
</template>
