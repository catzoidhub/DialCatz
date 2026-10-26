<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ReportKind } from '@shared/types';
import { notify } from '../state';
import CatMood from './CatMood.vue';
import { fromFile, prepare, SHOTS_MAX, type Shot } from '../shots';

/**
 * Help → Report a Bug… / Send Feedback… (Catzoid family #65): the kind, a message, an optional email for a reply,
 * and Preview what is sent (the exact JSON: version, OS, arch, channel, a random install id — nothing else).
 * Sent to the Catzoid site; when it cannot be reached the report waits and goes later.
 */
const props = defineProps<{ kind: ReportKind }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

const KINDS: { id: ReportKind; label: string; hint: string }[] = [
  { id: 'bug', label: 'Bug', hint: 'What did you do, what happened, and what did you expect?' },
  { id: 'idea', label: 'Idea', hint: 'What would make DialCatz better for you?' },
  { id: 'question', label: 'Question', hint: 'What would you like to know? Add your email for an answer.' },
];
const kind = ref<ReportKind>(props.kind);
const message = ref('');
const email = ref('');
const busy = ref(false);
const error = ref('');
const preview = ref<string | null>(null);
const clean = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
// screenshots on a bug report (Catzoid #67): optional, cleaned in shots.ts, shown before they go
const shots = ref<Shot[]>([]);
const shotError = ref('');
const capturing = ref(false);
const picker = ref<HTMLInputElement | null>(null);
const sendShots = computed(() => (kind.value === 'bug' ? shots.value : []));
const draft = () => ({ kind: kind.value, message: message.value, email: email.value.trim() || undefined, shotCount: sendShots.value.length });

async function add(src: string) {
  shotError.value = '';
  try {
    shots.value = [...shots.value, await prepare(src)];
  } catch (e) {
    shotError.value = (e as Error).message;
  }
}
async function pick(e: Event) {
  const el = e.target as HTMLInputElement;
  for (const f of [...(el.files ?? [])].slice(0, SHOTS_MAX - shots.value.length)) {
    try {
      await add(await fromFile(f));
    } catch (err) {
      shotError.value = (err as Error).message;
    }
  }
  el.value = '';
}
/** The window without this dialog: hide it, let a frame paint, capture, show it again. */
async function capture() {
  capturing.value = true;
  await nextTick();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
  try {
    const png = await api.captureWindow();
    capturing.value = false;
    if (png) await add(`data:image/png;base64,${png}`);
  } finally {
    capturing.value = false;
  }
}
const remove = (i: number) => (shots.value = shots.value.filter((_, j) => j !== i));

async function togglePreview() {
  preview.value = preview.value === null ? await api.reportPreview(draft()) : null;
}
watch([kind, message, email, () => shots.value.length], async () => {
  if (preview.value !== null) preview.value = await api.reportPreview(draft());
});

async function send() {
  busy.value = true;
  error.value = '';
  try {
    const r = await api.reportSend({ ...draft(), shots: sendShots.value.map(({ type, data }) => ({ type, data })) });
    notify('success', r.queued ? 'Saved — it goes to Catzoid as soon as the site can be reached' : 'Thanks — sent to Catzoid');
    emit('close');
  } catch (e) {
    error.value = clean(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <dialog open class="modal modal-open" :class="{ invisible: capturing }" @keydown.esc="!busy && emit('close')">
    <div class="modal-box w-[36rem] max-w-[95vw] space-y-4">
      <div class="flex items-center gap-3">
        <h3 class="flex-1 text-lg font-semibold tracking-tight">{{ kind === 'bug' ? 'Report a bug' : 'Send feedback' }}</h3>
        <div class="seg seg-xs seg-choice">
          <button v-for="k in KINDS" :key="k.id" class="seg-item normal-case" :class="{ 'is-active': kind === k.id }" @click="kind = k.id">{{ k.label }}</button>
        </div>
      </div>
      <textarea v-model="message" class="textarea selectable h-36 w-full text-sm" :placeholder="KINDS.find((k) => k.id === kind)!.hint" maxlength="10000" />
      <div v-if="kind === 'bug'" class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="label-caps">Screenshots <span class="normal-case tracking-normal opacity-60">(optional, up to {{ SHOTS_MAX }})</span></span>
          <span class="flex-1" />
          <button type="button" class="btn btn-ghost btn-xs" :disabled="shots.length >= SHOTS_MAX || capturing" @click="capture">Capture this window</button>
          <button type="button" class="btn btn-ghost btn-xs" :disabled="shots.length >= SHOTS_MAX" @click="picker?.click()">Attach a screenshot…</button>
          <input ref="picker" type="file" accept="image/png,image/jpeg" multiple class="hidden" @change="pick" />
        </div>
        <div v-if="shots.length" class="grid grid-cols-3 gap-2">
          <figure v-for="(sh, i) in shots" :key="i + sh.data.length" class="relative overflow-hidden rounded-lg border border-base-300 bg-base-200/50">
            <img :src="sh.url" alt="Screenshot to send" class="aspect-[16/10] w-full object-cover object-top" />
            <figcaption class="flex justify-between px-1.5 py-0.5 font-mono text-[10px] opacity-60">
              <span>{{ sh.width }}×{{ sh.height }}</span><span>{{ Math.max(1, Math.round(sh.bytes / 1024)) }} KB</span>
            </figcaption>
            <button type="button" class="btn btn-circle btn-xs absolute right-1 top-1 opacity-90" title="Remove" aria-label="Remove this screenshot" @click="remove(i)">✕</button>
          </figure>
        </div>
        <p v-if="shots.length" class="text-xs text-warning">
          Look at each screenshot before you send it: no tokens, headers, request or response bodies, environment values or hosts.
          Pictures cannot be cleaned like text — what you see is what goes.
        </p>
        <p v-if="shotError" class="text-xs text-error">{{ shotError }}</p>
      </div>
      <div class="opt-row">
        <span class="flex flex-col"><span class="label-caps">Email (optional)</span><span class="text-xs opacity-50">Only to answer this report</span></span>
        <input v-model="email" type="email" class="input input-sm w-64" placeholder="you@example.com" autocomplete="email" />
      </div>
      <p class="text-xs opacity-60">
        Sent to Catzoid with the DialCatz version, OS and a random install id. Never your requests, responses, variables, tokens or hosts.
        <a class="link" @click="togglePreview">{{ preview === null ? 'Preview what is sent' : 'Hide preview' }}</a>
      </p>
      <pre v-if="preview !== null" class="selectable max-h-56 overflow-auto rounded-xl bg-base-200 p-3 font-mono text-xs">{{ preview }}</pre>
      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span>{{ error }}</span></div>
      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !message.trim()" @click="send"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ error ? 'Retry' : 'Send' }}</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
