<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { HistoryEntry } from '@shared/types';
import { history, newTab, plain, selectWorkspace, workspace, workspaces } from '../state';
import ConfirmDialog from './ConfirmDialog.vue';
import Icon from './Icon.vue';

/**
 * Every request sent from this computer (the last 300), newest first, grouped by day, 50 to a page. Click one to
 * send it again.
 */
const PAGE = 50;
const filter = ref('');
const clearing = ref(false);
const page = ref(0);

const matching = computed(() => {
  const f = filter.value.toLowerCase();
  return f ? history.value.filter((h) => `${h.request.method} ${h.request.url} ${h.name} ${h.status ?? ''}`.toLowerCase().includes(f)) : history.value;
});
const pages = computed(() => Math.max(1, Math.ceil(matching.value.length / PAGE)));
watch(filter, () => (page.value = 0));
watch(pages, (n) => page.value >= n && (page.value = n - 1));
/** Page numbers to show: the first, the last, and two around the current one; null is a gap. */
const pageList = computed(() => {
  const n = pages.value;
  const keep = [...new Set([0, n - 1, page.value - 1, page.value, page.value + 1])].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  keep.forEach((i, k) => {
    if (k && i - keep[k - 1] > 1) out.push(null);
    out.push(i);
  });
  return out;
});
function go(i: number) {
  page.value = i;
  scroller.value?.scrollTo({ top: 0 });
}
const scroller = ref<HTMLElement | null>(null);

const groups = computed(() => {
  const out: { day: string; items: HistoryEntry[] }[] = [];
  for (const h of matching.value.slice(page.value * PAGE, (page.value + 1) * PAGE)) {
    const day = new Date(h.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    const g = out[out.length - 1];
    if (g?.day === day) g.items.push(h);
    else out.push({ day, items: [h] });
  }
  return out;
});

async function reopen(h: HistoryEntry) {
  if (workspaces.value.some((w) => w.id === h.workspaceId) && h.workspaceId !== workspace.value?.id) await selectWorkspace(h.workspaceId);
  newTab(plain(h.request), h.name);
}
async function clear() {
  clearing.value = false;
  await window.dialcatz.clearHistory();
  history.value = [];
}
const tone = (s: number | null) => (s === null ? 'is-bad' : s < 300 ? 'is-ok' : s < 400 ? 'is-info' : s < 500 ? 'is-warn' : 'is-bad');
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <header class="drag flex items-center gap-3 border-b border-base-300/60 px-6 pt-11 pb-4">
      <span class="grid size-9 shrink-0 place-items-center rounded-xl" style="color: var(--c-history); background: color-mix(in oklch, var(--c-history) 16%, transparent)"><Icon name="history" class="size-5" /></span>
      <h1 class="flex-1 text-lg font-semibold tracking-tight">History</h1>
      <label class="search-box no-drag w-72">
        <Icon name="search" class="size-3.5 opacity-50" />
        <input v-model="filter" placeholder="Filter by URL, method or status" />
      </label>
      <button class="btn btn-ghost btn-sm" :disabled="!history.length" @click="clearing = true">Clear</button>
    </header>
    <div ref="scroller" class="min-h-0 flex-1 overflow-auto px-6 py-4">
      <p v-if="!history.length" class="py-16 text-center text-sm opacity-50">Nothing sent yet. Every request you send shows up here.</p>
      <p v-else-if="!matching.length" class="py-16 text-center text-sm opacity-50">Nothing matches “{{ filter }}”.</p>
      <div v-for="g in groups" :key="g.day" class="mb-5">
        <h2 class="label-caps mb-2">{{ g.day }}</h2>
        <div class="card"><div class="card-body card-table">
          <button v-for="h in g.items" :key="h.id" class="hist-row" @click="reopen(h)">
            <span class="w-16 shrink-0 font-mono text-xs opacity-50">{{ time(h.at) }}</span>
            <span class="tree-method w-14 shrink-0 font-mono" :class="`m-${h.request.method.toLowerCase()}`">{{ h.request.method }}</span>
            <span class="min-w-0 flex-1 truncate text-left font-mono text-xs">{{ h.request.url }}</span>
            <span class="status-mini font-mono" :class="tone(h.status)" :title="h.error">{{ h.status ?? 'failed' }}</span>
            <span class="w-16 shrink-0 text-right font-mono text-xs opacity-50">{{ h.timeMs }} ms</span>
          </button>
        </div></div>
      </div>
      <nav v-if="pages > 1" class="flex flex-wrap items-center justify-between gap-3 pb-2" aria-label="Pages">
        <span class="text-xs opacity-60">{{ page * PAGE + 1 }}–{{ Math.min((page + 1) * PAGE, matching.length) }} of {{ matching.length }}</span>
        <div class="join">
          <button class="btn btn-sm join-item" :disabled="page === 0" aria-label="Previous page" @click="go(page - 1)">‹</button>
          <template v-for="(i, k) in pageList" :key="k">
            <button v-if="i === null" class="btn btn-sm join-item btn-disabled" tabindex="-1">…</button>
            <button v-else class="btn btn-sm join-item tabular-nums" :class="{ 'btn-active btn-primary': i === page }" :aria-current="i === page ? 'page' : undefined" @click="go(i)">{{ i + 1 }}</button>
          </template>
          <button class="btn btn-sm join-item" :disabled="page >= pages - 1" aria-label="Next page" @click="go(page + 1)">›</button>
        </div>
      </nav>
    </div>
    <ConfirmDialog v-if="clearing" title="Clear the history?" text="All sent requests are forgotten. Saved requests are not touched." confirm="Clear history" tone="warning" @ok="clear" @cancel="clearing = false" />
  </div>
</template>
