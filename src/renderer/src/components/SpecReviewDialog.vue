<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { SpecChange, SpecReview, Workspace } from '@shared/types';
import CatMood from './CatMood.vue';

/**
 * A collection that follows its spec (#92): what the spec added, changed and dropped since the collection last took it
 * in. Nothing changes until Update: new routes and changes are ticked, requests whose route is gone are not (left
 * alone they stay as the user's own). An update keeps every part the user edited. Each group says in plain words
 * what ticking does; the footer says what Update will do.
 */
const props = defineProps<{ review: SpecReview; name: string; workspaceId: string }>();
const emit = defineEmits<{ close: []; done: [w: Workspace, summary: string] }>();
const api = window.dialcatz;

type Kind = SpecChange['kind'];
const id = (c: SpecChange) => `${c.kind}:${c.key}`;
const picked = reactive(new Set(props.review.changes.filter((c) => c.kind === 'added' || (c.kind === 'changed' && !c.noBase)).map(id)));
const toggle = (c: SpecChange) => (picked.has(id(c)) ? picked.delete(id(c)) : picked.add(id(c)));

const GROUPS: { kind: Kind; title: string; help: string; tone: string }[] = [
  { kind: 'added', title: 'New in the spec', help: 'Ticked requests are added to the collection.', tone: 'is-new' },
  { kind: 'changed', title: 'Changed in the spec', help: "Ticked requests take the spec's new version. Anything you edited yourself stays yours.", tone: 'is-changed' },
  { kind: 'removed', title: 'Removed from the spec', help: 'Ticked requests are deleted. Unticked ones stay as your own requests.', tone: 'is-removed' },
];
const groups = computed(() => GROUPS.map((g) => ({ ...g, list: props.review.changes.filter((c) => c.kind === g.kind) })).filter((g) => g.list.length));
const allOn = (list: SpecChange[]) => list.every((c) => picked.has(id(c)));
const setAll = (list: SpecChange[], on: boolean) => list.forEach((c) => (on ? picked.add(id(c)) : picked.delete(id(c))));

/** `{{baseUrl}}/users/:id?x=1` → `/users/:id`. */
const path = (url: string) => url.replace(/^\{\{[^}]+\}\}/, '').replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, '').split('?')[0] || '/';
const PART: Record<string, string> = { name: 'Name', method: 'Method', url: 'Path', params: 'Query', headers: 'Headers', body: 'Body', description: 'Description' };
const part = (p: string) => PART[p] ?? p;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const counts = computed(() => {
  const n = (k: Kind) => props.review.changes.filter((c) => c.kind === k && picked.has(id(c))).length;
  return { add: n('added'), update: n('changed'), remove: n('removed') };
});
const summary = computed(() => {
  const c = props.review.changes;
  const n = (k: Kind) => c.filter((x) => x.kind === k).length;
  return [n('added') && plural(n('added'), 'new request'), n('changed') && plural(n('changed'), 'changed request'), n('removed') && plural(n('removed'), 'removed request')].filter(Boolean).join(', ');
});
const willDo = computed(() => {
  const c = counts.value;
  const parts = [c.add && `add ${c.add}`, c.update && `update ${c.update}`, c.remove && `delete ${c.remove}`].filter(Boolean);
  return parts.length ? `Will ${parts.join(', ')}` : 'Nothing ticked: the changes are only marked as seen';
});

const busy = ref(false);
const error = ref('');
const nothing = computed(() => !props.review.changes.length);
async function update() {
  busy.value = true;
  error.value = '';
  try {
    const keys = (kind: Kind) => props.review.changes.filter((c) => c.kind === kind && picked.has(id(c))).map((c) => c.key);
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
    <div class="modal-box flex max-h-[85vh] w-[42rem] max-w-[95vw] flex-col gap-4 p-0">
      <!-- Header -->
      <div class="flex items-start gap-3 px-6 pt-6">
        <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood :mood="nothing ? 'success' : 'question'" class="size-8" /></span>
        <div class="min-w-0 flex-1 space-y-1">
          <h3 class="text-lg font-semibold tracking-tight">Update “{{ name }}” from its spec</h3>
          <p class="text-sm opacity-70">
            <template v-if="nothing">Everything in the spec is in the collection already.</template>
            <template v-else>The spec has {{ summary }}. Pick what to bring into the collection.</template>
          </p>
          <p class="spec-source" :title="review.source">
            <span class="opacity-60">Spec</span><span class="truncate font-mono">{{ review.source }}</span><template v-if="review.unchanged"><span class="opacity-40">·</span><span class="shrink-0 opacity-60">{{ plural(review.unchanged, 'request') }} up to date</span></template>
          </p>
        </div>
      </div>

      <!-- Groups -->
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
            <span class="spec-method font-mono" :class="`m-${c.method.toLowerCase()}`">{{ c.method }}</span>
            <span class="min-w-0 flex-1 space-y-0.5">
              <span class="block truncate text-sm leading-5">{{ c.name }}</span>
              <span class="block truncate font-mono text-xs opacity-60">{{ path(c.url) }}</span>
              <span v-if="c.kind === 'changed'" class="flex flex-wrap items-center gap-1 pt-1">
                <span class="mr-0.5 text-xs opacity-50">Changed:</span>
                <span v-for="p in c.parts" :key="p" class="spec-chip" :class="{ 'is-kept': c.kept?.includes(p) }" :title="c.kept?.includes(p) ? 'You edited this: yours stays' : 'Takes the spec’s version'">{{ part(p) }}<template v-if="c.kept?.includes(p)"> · yours stays</template></span>
              </span>
              <span v-if="c.noBase" class="block text-xs opacity-60">Imported before DialCatz kept track of the spec, so ticking takes the spec's version. Your values for the same query and header names stay.</span>
            </span>
          </label>
        </section>
      </div>

      <!-- Footer -->
      <div class="spec-foot">
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
        <div class="flex items-center gap-3">
          <p class="min-w-0 flex-1 text-xs opacity-60">
            <template v-if="nothing">Nothing to update.</template>
            <template v-else>{{ willDo }}. Auth, scripts and folders are never touched.</template>
          </p>
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
