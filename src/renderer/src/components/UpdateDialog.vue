<script setup lang="ts">
import { currentOS } from '@shared/platform';
import type { ReleaseNote } from '@shared/types';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CatMood from './CatMood.vue';
import { appVersion, settings, tabs, updateOpenAuto, updateState } from '../state';
import { openCommunity, openDonate } from '../support';
import dialcatzLogo from '../assets/logos/dialcatz.png';

/**
 * DialCatz's update (Catzoid #54), laid out exactly like DevCatz's UpdateDialog (the four apps' update dialogs look the
 * same; user, 2026-11-18): What's New (the notes of every version since the installed one), then the download (percent,
 * MB of MB, speed, time left, Cancel), then Restart now / Install when I quit. Errors in plain words with Retry and the
 * site's download page. Before the restart it says what stops.
 */
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;
const st = computed(() => updateState.value);
const site = ref('https://catzoid.com');
onMounted(async () => (site.value = (await api.appInfo().catch(() => null))?.site ?? site.value));

/** The offer seen last (version, size, notes): the download and Ready states keep showing it, as in DevCatz. */
const offer = ref<{ version: string; size: number | null; notes: ReleaseNote[] } | null>(null);
watch(
  st,
  (s) => {
    if (s.kind === 'available') offer.value = { version: s.version, size: s.size, notes: s.notes };
  },
  { immediate: true },
);
const status = computed(() => (st.value.kind === 'idle' ? 'checking' : st.value.kind === 'verifying' ? 'downloading' : st.value.kind));
const version = computed(() => ('version' in st.value && st.value.kind !== 'none' ? st.value.version : (offer.value?.version ?? null)));
const notes = computed(() => (offer.value && offer.value.version === version.value ? offer.value.notes : []));
const size = computed(() => (offer.value && offer.value.version === version.value ? offer.value.size : null));
const progress = computed(() => (st.value.kind === 'downloading' ? st.value : st.value.kind === 'verifying' ? { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 } : null));
const verifying = computed(() => st.value.kind === 'verifying');

/** What the restart stops: requests on their way and open WebSocket connections. */
const sending = computed(() => tabs.value.filter((t) => t.sending).length);
const sockets = computed(() => tabs.value.filter((t) => t.ws?.state === 'open' || t.ws?.state === 'connecting').length);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const left = computed(() => {
  const p = progress.value;
  if (!p || !p.bytesPerSecond) return '';
  const s = Math.max(0, Math.round((p.total - p.transferred) / p.bytesPerSecond));
  return s < 60 ? `${s} s left` : `${Math.ceil(s / 60)} min left`;
});
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** A small, safe Markdown: headings, lists, bold, code, links (text only); everything else as text. */
function md(src: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (t: string) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const out: string[] = [];
  let list = false;
  for (const line of src.replace(/\r/g, '').split('\n')) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) out.push('</ul>');
    list = false;
    // "> note" (a quote in the release notes): shown as a plain paragraph, without the ">".
    const q = line.match(/^\s*>\s?(.*)$/);
    if (q) {
      if (q[1].trim()) out.push(`<p class="opacity-80">${inline(q[1])}</p>`);
      continue;
    }
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) out.push(`<h4>${inline(h[1])}</h4>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

const close = () => emit('close');
const check = () => api.updateCheck().catch(() => undefined);
const download = () => api.updateDownload().catch(() => undefined);
const restart = () => api.updateInstall('now').catch(() => undefined);
async function later() {
  await api.updateInstall('quit');
  close();
}
async function skip() {
  if (st.value.kind === 'available') await api.updateSkip(st.value.version);
  close();
}
/**
 * What's New starts at the newest version's first line. The box can be laid out late (the window was in the back when
 * the dialog opened by itself, the notes arrived after it) and Chromium then kept it scrolled to the end, so it goes
 * back to the top whenever its size changes, until the user scrolls it.
 */
/**
 * Support Catzoid at the end of What's New (Catzoid #94, as DevCatz 058fc2e): one quiet line, the same links as Settings →
 * About. Gone once the corner card is done with (joined, donated, rated or "Don't show again": support.off).
 */
const supportLine = computed(() => !settings.value?.support?.off);
const notesBox = ref<HTMLElement | null>(null);
let touched = false;
const toTop = () => !touched && notesBox.value && (notesBox.value.scrollTop = 0);
const sized = new ResizeObserver(toTop);
const mine = () => (touched = true);
watch(notesBox, (el, old) => {
  if (old) (sized.disconnect(), ['wheel', 'pointerdown', 'keydown', 'touchstart'].forEach((e) => old.removeEventListener(e, mine)));
  if (!el) return;
  touched = false;
  sized.observe(el);
  for (const c of Array.from(el.children)) sized.observe(c);
  ['wheel', 'pointerdown', 'keydown', 'touchstart'].forEach((e) => el.addEventListener(e, mine, { passive: true }));
  void nextTick(toTop);
});
watch(version, () => ((touched = false), void nextTick(toTop)));
onBeforeUnmount(() => sized.disconnect());
/** The offered version's notes did not come (a failed request, the site not caught up yet): ask again on open. */
const notesMissing = computed(() => st.value.kind === 'available' && !notes.value.find((n) => n.version === version.value)?.notes.trim());
watch(notesMissing, (missing) => missing && void api.updateNotes().catch(() => undefined), { immediate: true });
/** "Don't open this on its own" (Catzoid #97), shown when the dialog opened by itself; Settings → Updates has it too. */
const quiet = ref(false);
async function setQuiet(off: boolean) {
  quiet.value = off;
  await api.setUpdatePrefs({ dialog: !off }).catch(() => undefined);
}
const quitWord = currentOS === 'mac' ? 'quit' : 'close DialCatz';
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="close">
    <div class="modal-box w-[36rem] max-w-[95vw] space-y-4">
      <div class="flex items-start gap-4">
        <img :src="dialcatzLogo" alt="" class="size-14 shrink-0 drop-shadow-md" draggable="false" />
        <div class="min-w-0 flex-1 space-y-0.5">
          <h3 class="text-lg font-semibold tracking-tight">
            <template v-if="status === 'checking'">Looking for updates…</template>
            <template v-else-if="status === 'none'">You're up to date</template>
            <template v-else-if="status === 'downloaded'">DialCatz {{ version }} is ready to install</template>
            <template v-else-if="status === 'error'">The update did not work</template>
            <template v-else-if="version">DialCatz {{ version }} is available</template>
            <template v-else>Updates</template>
          </h3>
          <p class="text-sm opacity-60">
            You have {{ appVersion }}<template v-if="version && status !== 'none'"> · new: {{ version }}<template v-if="size"> · {{ mb(size) }}</template></template>
          </p>
        </div>
      </div>

      <!-- What's New -->
      <div v-if="notes.length && (status === 'available' || status === 'downloading' || status === 'downloaded')" ref="notesBox" class="update-notes max-h-72 space-y-4 overflow-y-auto rounded-box bg-base-200/60 px-4 py-3 text-sm">
        <section v-for="n in notes" :key="n.version">
          <div class="mb-1 flex items-baseline gap-2">
            <span class="font-semibold">{{ n.version }}</span>
            <span class="text-xs opacity-50">{{ date(n.date) }}</span>
          </div>
          <div v-if="n.notes.trim()" class="selectable" v-html="md(n.notes)" />
          <p v-else class="opacity-60">
            The notes did not load yet.
            <button type="button" class="link link-hover" @click="api.openUrl(`${site}/dialcatz/download#versions`)">Read them on the site</button>
          </p>
        </section>
        <p v-if="supportLine" class="border-t border-base-300/60 pt-3 text-xs opacity-60">
          Catzoid is free and open source.
          <button type="button" class="link" @click="openCommunity">Joining the community</button> already helps a lot — or
          <button type="button" class="link" @click="openDonate">support us</button> if you like.
        </p>
      </div>

      <!-- Download -->
      <div v-if="status === 'downloading' && progress" class="space-y-1.5">
        <progress class="progress progress-primary w-full" :value="verifying ? undefined : progress.percent" max="100" />
        <div v-if="!verifying" class="flex justify-between text-xs opacity-60">
          <span>{{ Math.floor(progress.percent) }}% · {{ mb(progress.transferred) }} of {{ mb(progress.total) }}</span>
          <span>{{ progress.bytesPerSecond ? `${mb(progress.bytesPerSecond)}/s · ${left}` : 'Starting…' }}</span>
        </div>
        <p v-if="verifying" class="text-xs opacity-60">Verifying…</p>
      </div>

      <!-- Before the restart: what stops -->
      <div v-if="status === 'downloaded'" role="alert" class="alert alert-info alert-soft text-sm">
        <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
        <span v-if="st.kind === 'downloaded' && st.onQuit">It installs when you {{ quitWord }}. Open tabs and unsaved edits come back.</span>
        <span v-else-if="sending || sockets">
          Restarting stops {{ sending ? plural(sending, 'request') + ' on its way' : '' }}{{ sending && sockets ? ' and ' : '' }}{{ sockets ? plural(sockets, 'WebSocket connection') : '' }} for a few seconds.
          Open tabs and unsaved edits come back.
        </span>
        <span v-else>Nothing is running: the restart takes a few seconds.</span>
      </div>

      <div v-if="status === 'none'" class="flex items-center gap-3 text-sm">
        <CatMood mood="success" class="size-8 shrink-0" />
        <span>DialCatz {{ appVersion }} is the newest version.</span>
      </div>
      <div v-if="st.kind === 'error'" role="alert" class="alert alert-error alert-soft text-sm">
        <CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
        <span class="selectable">{{ st.message }}</span>
      </div>

      <div class="modal-action flex-wrap items-center">
        <label v-if="updateOpenAuto && (status === 'available' || status === 'downloaded')" class="mr-auto flex cursor-pointer items-center gap-2 text-xs opacity-70">
          <input type="checkbox" class="checkbox checkbox-xs" :checked="quiet" @change="setQuiet(($event.target as HTMLInputElement).checked)" />
          Don't open this on its own
        </label>
        <template v-if="status === 'available'">
          <button type="button" class="btn btn-ghost btn-sm" @click="skip">Skip this version</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Later</button>
          <button type="button" class="btn btn-primary btn-sm" @click="download">Update now</button>
        </template>
        <template v-else-if="status === 'downloading'">
          <button v-if="!verifying" type="button" class="btn btn-ghost btn-sm" @click="api.updateCancel()">Cancel</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Hide</button>
        </template>
        <template v-else-if="status === 'downloaded'">
          <button v-if="st.kind === 'downloaded' && !st.onQuit" type="button" class="btn btn-ghost btn-sm" @click="later">Install when I {{ quitWord }}</button>
          <button v-else type="button" class="btn btn-ghost btn-sm" @click="close">OK</button>
          <button type="button" class="btn btn-primary btn-sm" @click="restart">Restart now</button>
        </template>
        <template v-else-if="st.kind === 'error'">
          <button v-if="st.download" type="button" class="btn btn-ghost btn-sm" @click="api.openUrl(st.download)">Download from the site</button>
          <button type="button" class="btn btn-ghost btn-sm" @click="close">Close</button>
          <button type="button" class="btn btn-primary btn-sm" @click="version ? download() : check()">Retry</button>
        </template>
        <template v-else>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="status === 'checking'" @click="check"><span v-if="status === 'checking'" class="loading loading-spinner loading-xs" />Check again</button>
          <button type="button" class="btn btn-primary btn-sm" @click="close">OK</button>
        </template>
      </div>
    </div>
    <div class="modal-backdrop" @click="status !== 'downloading' && close()" />
  </dialog>
</template>

<style scoped>
.update-notes :deep(h4) {
  margin: 0.5rem 0 0.25rem;
  font-weight: 600;
}
.update-notes :deep(ul) {
  list-style: disc;
  padding-left: 1.25rem;
}
.update-notes :deep(p),
.update-notes :deep(li) {
  margin: 0.15rem 0;
  line-height: 1.5;
}
.update-notes :deep(code) {
  font-size: 0.85em;
  padding: 0 0.25rem;
  border-radius: 0.25rem;
  background: oklch(from var(--color-base-content) l c h / 0.08);
}
</style>
