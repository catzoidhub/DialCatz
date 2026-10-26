<script setup lang="ts">
import { computed } from 'vue';
import { updateState } from '../state';
import { esc } from '../highlight';
import CatMood from './CatMood.vue';

/**
 * Updates (Catzoid family #54) in one dialog that follows the check: checking → up to date / What's New (the notes of
 * every version between the installed one and the new one, size; Update now / Later / Skip this version) → progress
 * (percent, MB, speed, time left, Cancel) → Verifying… → Ready (Restart now / Install when I quit) — or an error in
 * plain words with Retry and "Download from the site".
 */
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;
const st = computed(() => updateState.value);

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} MB`;
const left = computed(() => {
  const s = st.value;
  if (s.kind !== 'downloading' || !s.bytesPerSecond) return '';
  const sec = Math.max(1, Math.round((s.total - s.transferred) / s.bytesPerSecond));
  return sec < 60 ? `${sec} s left` : `${Math.ceil(sec / 60)} min left`;
});
const when = (d: string) => (d ? new Date(d).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }) : '');

/** Release notes are Markdown: headings, lists, bold, code and links, drawn as safe HTML. */
function md(src: string): string {
  const inline = (t: string) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1');
  const out: string[] = [];
  let list = false;
  for (const line of src.replace(/\r/g, '').split('\n')) {
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (!list) (out.push('<ul>'), (list = true));
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    if (list) (out.push('</ul>'), (list = false));
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) out.push(`<p class="font-semibold mt-2">${inline(h[1])}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

const close = () => emit('close');
async function skip() {
  if (st.value.kind === 'available') await api.updateSkip(st.value.version);
  close();
}
async function installOnQuit() {
  await api.updateInstall('quit');
  close();
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="close">
    <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
      <!-- Checking -->
      <template v-if="st.kind === 'checking' || st.kind === 'idle'">
        <div class="flex items-center gap-3 py-2">
          <span class="loading loading-spinner loading-md text-primary" />
          <span class="text-sm">Checking for updates…</span>
        </div>
        <div class="modal-action mt-0"><button class="btn btn-ghost btn-sm" @click="close">Close</button></div>
      </template>

      <!-- Up to date -->
      <template v-else-if="st.kind === 'none'">
        <div class="flex items-center gap-3">
          <CatMood mood="success" class="size-10 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">You’re up to date</h3>
            <p class="text-sm opacity-70">DialCatz {{ st.version }} is the newest version.</p>
          </div>
        </div>
        <div class="modal-action mt-0"><button class="btn btn-primary btn-sm" @click="close">OK</button></div>
      </template>

      <!-- What's New -->
      <template v-else-if="st.kind === 'available'">
        <div class="flex items-center gap-3">
          <CatMood mood="info" class="size-10 shrink-0" />
          <div class="min-w-0">
            <h3 class="text-lg font-semibold tracking-tight">DialCatz {{ st.version }} is available</h3>
            <p class="text-sm opacity-70">You have {{ st.current }}.<template v-if="st.size"> The download is {{ mb(st.size) }}.</template></p>
          </div>
        </div>
        <div class="max-h-72 space-y-3 overflow-y-auto rounded-xl border border-base-300/70 bg-base-200/40 p-3">
          <div v-for="n in st.notes" :key="n.version" class="update-notes text-sm">
            <p class="mb-1 font-semibold">{{ n.version }} <span class="font-normal opacity-50">{{ when(n.date) }}</span></p>
            <div v-if="n.notes.trim()" v-html="md(n.notes)" />
            <p v-else class="opacity-50">No notes for this version.</p>
          </div>
        </div>
        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm mr-auto" @click="skip">Skip this version</button>
          <button class="btn btn-ghost btn-sm" @click="close">Later</button>
          <button class="btn btn-primary btn-sm" @click="api.updateDownload()">Update now</button>
        </div>
      </template>

      <!-- Downloading -->
      <template v-else-if="st.kind === 'downloading' || st.kind === 'verifying'">
        <h3 class="text-lg font-semibold tracking-tight">Downloading DialCatz {{ st.version }}</h3>
        <progress class="progress progress-primary w-full" :value="st.kind === 'downloading' ? st.percent : undefined" max="100" />
        <p class="text-sm opacity-70">
          <template v-if="st.kind === 'verifying'">Verifying…</template>
          <template v-else>{{ Math.floor(st.percent) }}% · {{ mb(st.transferred) }} of {{ mb(st.total) }}<template v-if="st.bytesPerSecond"> · {{ mb(st.bytesPerSecond) }}/s · {{ left }}</template></template>
        </p>
        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" @click="close">Hide</button>
          <button v-if="st.kind === 'downloading'" class="btn btn-sm" @click="api.updateCancel()">Cancel</button>
        </div>
      </template>

      <!-- Ready -->
      <template v-else-if="st.kind === 'downloaded'">
        <div class="flex items-center gap-3">
          <CatMood mood="success" class="size-10 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Ready to install — restart DialCatz</h3>
            <p class="text-sm opacity-70">DialCatz {{ st.version }} is downloaded and checked.</p>
          </div>
        </div>
        <p class="text-sm opacity-70">Open tabs and unsaved edits come back after the restart. Requests still running and WebSocket connections stop.</p>
        <p v-if="st.onQuit" class="text-sm text-primary">It installs when you quit DialCatz.</p>
        <div class="modal-action mt-0">
          <button v-if="!st.onQuit" class="btn btn-ghost btn-sm" @click="installOnQuit">Install when I quit</button>
          <button v-else class="btn btn-ghost btn-sm" @click="close">OK</button>
          <button class="btn btn-primary btn-sm" @click="api.updateInstall('now')">Restart now</button>
        </div>
      </template>

      <!-- Error -->
      <template v-else-if="st.kind === 'error'">
        <div class="flex items-start gap-3">
          <CatMood mood="error" class="size-10 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">The update did not work</h3>
            <p class="selectable text-sm opacity-80">{{ st.message }}</p>
          </div>
        </div>
        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm mr-auto" @click="api.openUrl(st.download)">Download from the site</button>
          <button class="btn btn-ghost btn-sm" @click="close">Close</button>
          <button class="btn btn-primary btn-sm" @click="api.updateCheck()">Retry</button>
        </div>
      </template>
    </div>
    <div class="modal-backdrop" @click="close" />
  </dialog>
</template>

<style scoped>
.update-notes :deep(ul) {
  list-style: disc;
  padding-left: 1.2rem;
}
.update-notes :deep(code) {
  font-family: var(--font-mono, ui-monospace);
  font-size: 0.85em;
}
</style>
