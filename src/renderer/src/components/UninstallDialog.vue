<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { UninstallPlan } from '@shared/types';
import { words } from '../platform';
import { notify } from '../state';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';

/**
 * Uninstall DialCatz (Catzoid family #55): what goes, the shared Catzoid settings and AI key only when the user says so
 * (ticked by default only when no other Catzoid app is installed), typed confirmation, then the app quits.
 */
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;
const NAME = 'DialCatz';

const plan = ref<UninstallPlan | null>(null);
const removeShared = ref(false);
const typed = ref('');
const busy = ref(false);
onMounted(async () => {
  plan.value = await api.uninstallPlan();
  removeShared.value = plan.value.otherApps.length === 0;
});
const blocked = computed(() => busy.value || typed.value.trim() !== NAME);

async function copyName() {
  await api.copyText(NAME);
  notify('success', 'Name copied');
}
async function go() {
  if (blocked.value) return;
  busy.value = true;
  await api.uninstall(removeShared.value);
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-3">
        <CatMood mood="warning" class="size-10 shrink-0" />
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Uninstall DialCatz?</h3>
          <p class="text-sm opacity-70">This removes DialCatz and what it keeps on this computer. It cannot be undone.</p>
        </div>
      </div>
      <template v-if="plan">
        <ul class="space-y-1.5 rounded-xl border border-base-300/70 bg-base-200/40 p-3 text-sm">
          <li v-for="i in plan.items" :key="i.label">
            <span class="font-medium">{{ i.label }}</span>
            <span class="block font-mono text-xs opacity-55">{{ i.detail }}</span>
          </li>
        </ul>
        <p class="text-xs opacity-60">Your own files stay: exported collections, saved responses and anything else you saved elsewhere. Team workspaces stay on their DialCatz Den server.</p>
        <label class="opt-row cursor-pointer">
          <span class="flex flex-col">
            <span class="label-caps">Also remove the shared Catzoid settings</span>
            <span class="text-xs opacity-50">{{ plan.otherApps.length ? `Theme, AI connection and AI key are shared with ${plan.otherApps.join(', ')}: keep them for those apps.` : `Theme, AI connection and the AI key in ${words.secretStore}. No other Catzoid app is installed.` }}</span>
          </span>
          <input v-model="removeShared" type="checkbox" class="toggle toggle-sm toggle-warning" />
        </label>
        <div v-if="plan.brew" class="alert alert-info alert-soft text-sm"><CatMood mood="info" class="size-7 shrink-0 -my-0.5" /><span>Installed with Homebrew: also run <code class="selectable font-mono">{{ plan.brew }}</code> in Terminal.</span></div>
        <p v-if="plan.dev" class="text-xs text-warning">Running from a build folder: the data is removed, no app is moved to the Trash.</p>
        <div class="space-y-1.5">
          <p class="flex flex-wrap items-center gap-1 text-sm">Type <b class="font-mono">{{ NAME }}</b><button class="btn btn-ghost btn-xs btn-square" title="Copy the name" aria-label="Copy the name" @click="copyName"><Icon name="copy" class="size-3.5" /></button>to confirm:</p>
          <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="NAME" spellcheck="false" autocomplete="off" @keydown.enter="go" />
        </div>
      </template>
      <div v-else class="py-4 text-center"><span class="loading loading-dots" /></div>
      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="blocked" @click="go"><span v-if="busy" class="loading loading-spinner loading-xs" />Uninstall DialCatz</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
