<script setup lang="ts">
import { ref } from 'vue';
import type { AuthMode, RequestAuth } from '@shared/types';
import VarInput from './VarInput.vue';
import Icon from './Icon.vue';

/** Auth of a request, folder or collection. `inherit` is offered unless this is a collection (the top). */
const props = withDefaults(defineProps<{ modelValue: RequestAuth; allowInherit?: boolean; inheritedLabel?: string; readonly?: boolean }>(), { allowInherit: true, inheritedLabel: '', readonly: false });
const emit = defineEmits<{ 'update:modelValue': [a: RequestAuth] }>();

const MODES: { id: AuthMode; label: string }[] = [
  { id: 'inherit', label: 'Inherit' },
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic' },
  { id: 'apikey', label: 'API key' },
];
const show = ref(false);
const set = (patch: Partial<RequestAuth>) => emit('update:modelValue', { ...props.modelValue, ...patch });
</script>

<template>
  <div class="space-y-4">
    <div class="opt-row">
      <span class="label-caps">Type</span>
      <div class="seg seg-choice">
        <button v-for="m in MODES.filter((x) => allowInherit || x.id !== 'inherit')" :key="m.id" role="tab" class="seg-item" :class="{ 'is-active': modelValue.mode === m.id }" :disabled="readonly" @click="set({ mode: m.id })">{{ m.label }}</button>
      </div>
    </div>

    <p v-if="modelValue.mode === 'inherit'" class="text-sm opacity-60">{{ inheritedLabel || 'Uses the auth of the folder or collection above.' }}</p>
    <p v-else-if="modelValue.mode === 'none'" class="text-sm opacity-60">No Authorization header is added.</p>

    <template v-else-if="modelValue.mode === 'bearer'">
      <div class="opt-row">
        <span class="label-caps">Token</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="modelValue.token ?? ''" placeholder="{{token}}" :readonly="readonly" @update:model-value="(v) => set({ token: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
      <p class="text-xs opacity-50">Sent as <code>Authorization: Bearer …</code>. Put real tokens in an environment variable marked secret.</p>
    </template>

    <template v-else-if="modelValue.mode === 'basic'">
      <div class="opt-row">
        <span class="label-caps">Username</span>
        <VarInput class="field-box flex-1" :model-value="modelValue.username ?? ''" :readonly="readonly" @update:model-value="(v) => set({ username: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Password</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="modelValue.password ?? ''" :readonly="readonly" @update:model-value="(v) => set({ password: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
    </template>

    <template v-else-if="modelValue.mode === 'apikey'">
      <div class="opt-row">
        <span class="label-caps">Name</span>
        <VarInput class="field-box flex-1" :model-value="modelValue.key ?? ''" placeholder="X-API-Key" :readonly="readonly" @update:model-value="(v) => set({ key: v })" />
      </div>
      <div class="opt-row">
        <span class="label-caps">Value</span>
        <div class="flex flex-1 items-center gap-2">
          <VarInput class="field-box flex-1" :class="{ 'is-masked': !show }" :model-value="modelValue.value ?? ''" :readonly="readonly" @update:model-value="(v) => set({ value: v })" />
          <button class="btn btn-ghost btn-sm btn-square" :title="show ? 'Hide' : 'Show'" @click="show = !show"><Icon :name="show ? 'eyeOff' : 'eye'" class="size-4" /></button>
        </div>
      </div>
      <div class="opt-row">
        <span class="label-caps">Add to</span>
        <div class="seg seg-choice">
          <button role="tab" class="seg-item" :class="{ 'is-active': modelValue.in !== 'query' }" :disabled="readonly" @click="set({ in: 'header' })">Header</button>
          <button role="tab" class="seg-item" :class="{ 'is-active': modelValue.in === 'query' }" :disabled="readonly" @click="set({ in: 'query' })">Query params</button>
        </div>
      </div>
    </template>
  </div>
</template>
