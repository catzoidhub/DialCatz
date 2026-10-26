<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import CatMood from './CatMood.vue';

/** Asks for one line of text (a name). Enter confirms, Esc cancels. */
const props = withDefaults(defineProps<{ title: string; text?: string; value?: string; confirm?: string; placeholder?: string }>(), { text: '', value: '', confirm: 'Save', placeholder: '' });
const emit = defineEmits<{ ok: [value: string]; cancel: [] }>();
const v = ref(props.value);
const input = ref<HTMLInputElement | null>(null);
onMounted(() => nextTick(() => input.value?.select()));
const ok = () => v.value.trim() && emit('ok', v.value.trim());
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('cancel')">
    <div class="modal-box w-[28rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood mood="question" class="size-8" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">{{ title }}</h3>
          <p v-if="text" class="text-sm opacity-70">{{ text }}</p>
        </div>
      </div>
      <input ref="input" v-model="v" class="input input-sm w-full" :placeholder="placeholder" @keydown.enter="ok" />
      <slot />
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="!v.trim()" @click="ok">{{ confirm }}</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('cancel')" />
  </dialog>
</template>
