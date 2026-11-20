<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { SpecChange, SpecReview, Workspace } from '@shared/types';
import CatMood from './CatMood.vue';

/**
 * A collection that follows its spec (#92): what the spec added, changed and dropped since the collection last took it
 * in. Nothing changes until Update: new routes and changes are ticked, requests whose route is gone are not (left
 * alone they stay as the user's own). An update keeps every part the user edited.
 */
const props = defineProps<{ review: SpecReview; name: string; workspaceId: string }>();
const emit = defineEmits<{ close: []; done: [w: Workspace, summary: string] }>();
const api = window.dialcatz;

const of = (kind: SpecChange['kind']) => props.review.changes.filter((c) => c.kind === kind);
const added = computed(() => of('added'));
const changed = computed(() => of('changed'));
const removed = computed(() => of('removed'));
const picked = reactive(new Set(props.review.changes.filter((c) => c.kind === 'added' || (c.kind === 'changed' && !c.noBase)).map((c) => `${c.kind}:${c.key}`)));
const toggle = (c: SpecChange) => (picked.has(`${c.kind}:${c.key}`) ? picked.delete(`${c.kind}:${c.key}`) : picked.add(`${c.kind}:${c.key}`));
const all = (list: SpecChange[], on: boolean) => list.forEach((c) => (on ? picked.add(`${c.kind}:${c.key}`) : picked.delete(`${c.kind}:${c.key}`)));
const allOn = (list: SpecChange[]) => list.every((c) => picked.has(`${c.kind}:${c.key}`));

/** `{{baseUrl}}/users/:id?x=1` → `/users/:id`. */
const path = (url: string) => url.replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '').split('?')[0] || '/';
const PART: Record<string, string> = { name: 'name', method: 'method', url: 'path', params: 'query', headers: 'headers', body: 'body', description: 'description' };
const words = (list: string[]) => list.map((p) => PART[p] ?? p).join(', ');

const busy = ref(false);
const error = ref('');
const nothing = computed(() => !props.review.changes.length);
async function update() {
  busy.value = true;
  error.value = '';
  try {
    const keys = (kind: SpecChange['kind']) => props.review.changes.filter((c) => c.kind === kind && picked.has(`${c.kind}:${c.key}`)).map((c) => c.key);
    const r = await api.specApply(props.workspaceId, props.review.collectionId, { add: keys('added'), update: keys('changed'), remove: keys('removed') });
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} deleted`].filter(Boolean);
    emit('done', r.workspace, parts.length ? `“${props.name}”: ${parts.join(', ')}` : `“${props.name}” is up to date with its spec`);
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box flex max-h-[85vh] w-[40rem] max-w-[95vw] flex-col gap-3">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood :mood="nothing ? 'success' : 'question'" class="size-8" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">Update “{{ name }}” from its spec</h3>
          <p class="truncate text-sm opacity-70" :title="review.source">From {{ review.source }}<template v-if="review.unchanged"> · {{ review.unchanged }} {{ review.unchanged === 1 ? 'request matches' : 'requests match' }} it already</template></p>
        </div>
      </div>

      <p v-if="nothing" class="text-sm">Nothing to update: the collection has everything the spec has.</p>

      <div v-else class="min-h-0 space-y-4 overflow-y-auto pr-1">
        <section v-if="added.length" class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="label-caps">New in the spec · {{ added.length }}</span>
            <button type="button" class="link link-hover text-xs" @click="all(added, !allOn(added))">{{ allOn(added) ? 'None' : 'All' }}</button>
          </div>
          <label v-for="c in added" :key="c.key" class="spec-row">
            <input type="checkbox" class="checkbox checkbox-xs checkbox-primary" :checked="picked.has(`added:${c.key}`)" @change="toggle(c)" />
            <span class="tree-method font-mono" :class="`m-${c.method.toLowerCase()}`">{{ c.method }}</span>
            <span class="truncate font-mono text-xs">{{ path(c.url) }}</span>
            <span class="truncate text-xs opacity-60">{{ c.name }}</span>
          </label>
        </section>

        <section v-if="changed.length" class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="label-caps">Changed in the spec · {{ changed.length }}</span>
            <button type="button" class="link link-hover text-xs" @click="all(changed, !allOn(changed))">{{ allOn(changed) ? 'None' : 'All' }}</button>
          </div>
          <label v-for="c in changed" :key="c.key" class="spec-row items-start">
            <input type="checkbox" class="checkbox checkbox-xs checkbox-primary mt-0.5" :checked="picked.has(`changed:${c.key}`)" @change="toggle(c)" />
            <span class="tree-method font-mono" :class="`m-${c.method.toLowerCase()}`">{{ c.method }}</span>
            <span class="min-w-0 flex-1">
              <span class="flex gap-2"><span class="truncate font-mono text-xs">{{ path(c.url) }}</span><span class="truncate text-xs opacity-60">{{ c.name }}</span></span>
              <span class="block text-xs opacity-60">
                <template v-if="c.noBase">Differs in {{ words(c.parts ?? []) }}. Imported before DialCatz kept what the spec made, so ticking takes the spec's version; your values for the same query and header names stay.</template>
                <template v-else>The spec changed its {{ words(c.parts ?? []) }}.<template v-if="c.kept?.length"> You edited the {{ words(c.kept) }}: yours stays.</template></template>
              </span>
            </span>
          </label>
        </section>

        <section v-if="removed.length" class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="label-caps">Gone from the spec · {{ removed.length }}</span>
            <button type="button" class="link link-hover text-xs" @click="all(removed, !allOn(removed))">{{ allOn(removed) ? 'None' : 'All' }}</button>
          </div>
          <p class="text-xs opacity-60">Ticked ones are deleted. The others stay as your own requests.</p>
          <label v-for="c in removed" :key="c.key" class="spec-row">
            <input type="checkbox" class="checkbox checkbox-xs checkbox-error" :checked="picked.has(`removed:${c.key}`)" @change="toggle(c)" />
            <span class="tree-method font-mono" :class="`m-${c.method.toLowerCase()}`">{{ c.method }}</span>
            <span class="truncate font-mono text-xs">{{ path(c.url) }}</span>
            <span class="truncate text-xs opacity-60">{{ c.name }}</span>
          </label>
        </section>

        <p class="text-xs opacity-50">Updates keep your auth, scripts, folders and every part you edited. What you leave unticked is not offered again until the spec changes it.</p>
      </div>

      <p v-if="error" class="text-sm text-error">{{ error }}</p>
      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy" @click="update"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ nothing ? 'Done' : 'Update collection' }}</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>

<style scoped>
.spec-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.375rem;
  border-radius: 0.5rem;
  cursor: pointer;
}
.spec-row:hover {
  background: oklch(from var(--color-base-content) l c h / 0.05);
}
</style>
