<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { mcatzpInstalling, uninstallOpen, updateOpen, updateOpenAuto, updateState } from '../state';

/**
 * DialCatz's own update opens What's New by itself (Catzoid #97, as DevCatz's UpdatePrompt). Once per version and
 * launch, at a calm moment: the window in front, no other dialog open, nothing installing. Later = again on the next
 * launch, or 24 h after it last opened in a long session; Skip this version = never for that version; "Don't open this
 * on its own" (in the dialog, and Settings → Updates) leaves only the dot, Settings and the notification. A finished
 * download opens it once more for Restart now.
 */
const DAY = 86_400_000;
const api = window.dialcatz;
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 30_000);
const wake = () => (now.value = Date.now());
window.addEventListener('focus', wake);
document.addEventListener('visibilitychange', wake);
onBeforeUnmount(() => {
  clearInterval(tick);
  window.removeEventListener('focus', wake);
  document.removeEventListener('visibilitychange', wake);
});

/** What was opened in this launch: `<version>:available` / `<version>:downloaded`. */
const shown = new Set<string>();

/** What would open now (null = nothing to ask). */
const want = computed(() => {
  const x = updateState.value;
  if (x.kind === 'downloaded') return x.onQuit && shown.has(`${x.version}:downloaded`) ? null : `${x.version}:downloaded`;
  if (x.kind === 'available') return `${x.version}:available`;
  return null;
});
/** Something is running that a dialog on top would interrupt. */
const busy = computed(() => !!mcatzpInstalling.value || uninstallOpen.value);
let asking = false;

watch(
  [want, busy, now],
  async () => {
    const key = want.value;
    if (!key || asking || updateOpen.value || busy.value) return;
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (document.querySelector('dialog[open], .modal-open')) return;
    asking = true;
    try {
      const p = await api.updatePrefs();
      const version = key.split(':')[0];
      if (!p.dialog || p.skipped === version) return;
      if (shown.has(key) && (p.promptAt ?? 0) + DAY > now.value) return;
      if (want.value !== key || updateOpen.value || document.querySelector('dialog[open], .modal-open')) return;
      shown.add(key);
      updateOpenAuto.value = true;
      updateOpen.value = true;
      await api.setUpdatePrefs({ promptAt: Date.now() });
    } catch {
      /* asked again on the next tick */
    } finally {
      asking = false;
    }
  },
  { immediate: true },
);
watch(updateOpen, (open) => {
  if (!open) updateOpenAuto.value = false;
});
</script>

<template>
  <span hidden />
</template>
