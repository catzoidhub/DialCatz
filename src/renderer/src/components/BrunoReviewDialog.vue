<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { BrunoChange, BrunoReview, Workspace } from '@shared/types';
import CatMood from './CatMood.vue';

/**
 * A collection imported from Bruno (#104): what its Bruno folder added, changed and dropped since. Nothing changes
 * until Update, what the user edited here stays, and Bruno's own files are never written.
 */
const props = defineProps<{ review: BrunoReview; name: string; workspaceId: string }>();
const emit = defineEmits<{ close: []; done: [w: Workspace, summary: string] }>();
const api = window.dialcatz;

type Kind = BrunoChange['kind'];
const id = (c: BrunoChange) => `${c.kind}:${c.key}`;
const picked = reactive(new Set(props.review.changes.filter((c) => c.kind !== 'removed').map(id)));
const toggle = (c: BrunoChange) => (picked.has(id(c)) ? picked.delete(id(c)) : picked.add(id(c)));
const environments = ref(props.review.environments.length > 0);

const GROUPS: { kind: Kind; title: string; help: string; tone: string }[] = [
  { kind: 'added', title: 'New in Bruno', help: 'Ticked items are added to the collection.', tone: 'is-new' },
  { kind: 'changed', title: 'Changed in Bruno', help: "Ticked items take Bruno's version. Anything you edited here stays yours.", tone: 'is-changed' },
  { kind: 'removed', title: 'Removed from Bruno', help: 'Ticked items are deleted. Unticked ones stay as your own.', tone: 'is-removed' },
];
const groups = computed(() => GROUPS.map((g) => ({ ...g, list: props.review.changes.filter((c) => c.kind === g.kind) })).filter((g) => g.list.length));
const allOn = (list: BrunoChange[]) => list.every((c) => picked.has(id(c)));
const setAll = (list: BrunoChange[], on: boolean) => list.forEach((c) => (on ? picked.add(id(c)) : picked.delete(id(c))));
const PART: Record<string, string> = { name: 'Name', method: 'Method', url: 'URL', headers: 'Headers', body: 'Body', auth: 'Auth', preRequest: 'Pre-request script', tests: 'Tests', description: 'Notes', other: 'Message / method' };
const KIND: Record<string, string> = { collection: 'Collection', folder: 'Folder' };
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const where = (c: BrunoChange) => c.key.slice(c.key.indexOf(':') + 1);

const willDo = computed(() => {
  const n = (k: Kind) => props.review.changes.filter((c) => c.kind === k && picked.has(id(c))).length;
  const parts = [n('added') && `add ${n('added')}`, n('changed') && `update ${n('changed')}`, n('removed') && `delete ${n('removed')}`, environments.value && 'add variables'].filter(Boolean);
  return parts.length ? `Will ${parts.join(', ')}` : 'Nothing ticked: the changes are only marked as seen';
});
const nothing = computed(() => !props.review.changes.length && !props.review.environments.length);
const busy = ref(false);
const error = ref('');
async function update() {
  if (nothing.value) return emit('close');
  busy.value = true;
  error.value = '';
  try {
    const keys = (kind: Kind) => props.review.changes.filter((c) => c.kind === kind && picked.has(id(c))).map((c) => c.key);
    const r = await api.brunoApply(props.workspaceId, props.review.collectionId, { add: keys('added'), update: keys('changed'), remove: keys('removed'), environments: environments.value });
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} deleted`].filter(Boolean);
    emit('done', r.workspace, parts.length ? `“${props.name}”: ${parts.join(', ')}` : `“${props.name}” is up to date with Bruno`);
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <div class="modal-box flex max-h-[85vh] w-[42rem] max-w-[95vw] flex-col gap-4 p-0">
      <div class="flex items-start gap-3 px-6 pt-6">
        <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood :mood="nothing ? 'success' : 'question'" class="size-8" /></span>
        <div class="min-w-0 flex-1 space-y-1">
          <h3 class="text-lg font-semibold tracking-tight">Update “{{ name }}” from Bruno</h3>
          <p class="text-sm opacity-70">{{ nothing ? 'Everything in the Bruno folder is in the collection already.' : 'Pick what to bring in. Bruno\'s own files are only read.' }}</p>
          <p class="spec-source" :title="review.folder"><span class="opacity-60">Folder</span><span class="truncate font-mono">{{ review.folder }}</span><template v-if="review.unchanged"><span class="opacity-40">·</span><span class="shrink-0 opacity-60">{{ plural(review.unchanged, 'request') }} up to date</span></template></p>
        </div>
      </div>

      <div v-if="!nothing" class="min-h-0 space-y-3 overflow-y-auto px-6">
        <section v-for="g in groups" :key="g.kind" class="spec-group" :class="g.tone">
          <header class="spec-group-head">
            <span class="spec-dot" />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold">{{ g.title }} <span class="font-normal opacity-50">{{ g.list.length }}</span></span>
              <span class="block text-xs opacity-60">{{ g.help }}</span>
            </span>
            <label v-if="g.list.length > 1" class="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs opacity-70">
              <input type="checkbox" class="checkbox checkbox-xs" :class="g.kind === 'removed' ? 'checkbox-error' : 'checkbox-primary'" :checked="allOn(g.list)" @change="setAll(g.list, !allOn(g.list))" />
              All
            </label>
          </header>
          <label v-for="c in g.list" :key="c.key" class="spec-row" :class="{ 'is-off': !picked.has(id(c)) }">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :class="g.kind === 'removed' ? 'checkbox-error' : 'checkbox-primary'" :checked="picked.has(id(c))" @change="toggle(c)" />
            <span class="spec-method font-mono" :class="c.method ? `m-${c.method.toLowerCase()}` : ''">{{ c.method || KIND[c.item] }}</span>
            <span class="min-w-0 flex-1 space-y-0.5">
              <span class="block truncate text-sm leading-5">{{ c.name }}</span>
              <span class="block truncate font-mono text-xs opacity-60">{{ where(c) }}</span>
              <span v-if="c.kind === 'changed'" class="flex flex-wrap items-center gap-1 pt-1">
                <span class="mr-0.5 text-xs opacity-50">Changed:</span>
                <span v-for="p in c.parts" :key="p" class="spec-chip" :class="{ 'is-kept': c.kept?.includes(p) }">{{ PART[p] ?? p }}<template v-if="c.kept?.includes(p)"> · yours stays</template></span>
              </span>
            </span>
          </label>
        </section>
        <label v-if="review.environments.length" class="spec-group flex cursor-pointer items-start gap-3 px-3.5 py-2.5">
          <input v-model="environments" type="checkbox" class="checkbox checkbox-sm checkbox-primary mt-0.5" />
          <span class="min-w-0"><span class="block text-sm font-semibold">New variables</span><span v-for="e in review.environments" :key="e" class="block text-xs opacity-60">{{ e }}</span></span>
        </label>
        <details v-if="review.notes.length" class="text-sm"><summary class="cursor-pointer opacity-70">{{ plural(review.notes.length, 'note') }} about the Bruno folder</summary><ul class="mt-1 list-disc space-y-0.5 pl-5 text-xs opacity-70"><li v-for="n in review.notes" :key="n">{{ n }}</li></ul></details>
      </div>

      <div class="spec-foot">
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
        <div class="flex items-center gap-3">
          <p class="min-w-0 flex-1 text-xs opacity-60">{{ nothing ? 'Nothing to update.' : `${willDo}. Values of your variables are never touched.` }}</p>
          <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy" @click="update"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ nothing ? 'Done' : 'Update collection' }}</button>
        </div>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>

<style scoped>
.spec-source {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  max-width: 100%;
  width: fit-content;
  margin-top: 0.375rem;
  padding: 0.125rem 0.625rem;
  border-radius: 999px;
  font-size: 11.5px;
  background: oklch(from var(--color-base-content) l c h / 0.06);
}
.spec-group {
  --tone: var(--color-primary);
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
  border-radius: 0.875rem;
  overflow: hidden;
}
.spec-group.is-changed {
  --tone: var(--color-warning);
}
.spec-group.is-removed {
  --tone: var(--color-error);
}
.spec-group-head {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 0.875rem;
  background: oklch(from var(--tone) l c h / 0.07);
}
.spec-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 999px;
  background: var(--tone);
}
.spec-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.5rem 0.875rem;
  border-top: 1px solid oklch(from var(--color-base-content) l c h / 0.06);
  cursor: pointer;
  transition: background 0.12s, opacity 0.12s;
}
.spec-row:hover {
  background: oklch(from var(--color-base-content) l c h / 0.04);
}
.spec-row.is-off > :not(input) {
  opacity: 0.55;
}
.spec-method {
  flex-shrink: 0;
  width: 3rem;
  margin-top: 0.1875rem;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--m, currentColor);
}
.spec-chip {
  padding: 0 0.5rem;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.25rem;
  background: oklch(from var(--color-warning) l c h / 0.14);
}
.spec-chip.is-kept {
  background: oklch(from var(--color-primary) l c h / 0.14);
  color: var(--primary-ink, var(--color-primary));
}
.spec-foot {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.875rem 1.5rem 1.25rem;
  border-top: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
}
</style>
