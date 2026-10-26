<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { goSection, history, importRequest, newTab, servers } from '../state';
import CatMood from './CatMood.vue';

/**
 * First-run welcome (the Catzoid family's Get started, as DevCatz's WelcomeDialog): what DialCatz does and three first
 * steps, each with why and a button. Shown once, on a true first launch — never seen, nothing sent yet and no team
 * server — so an update never shows it. DialCatz needs no account, no sign-in and no administrator password.
 */
const api = window.dialcatz;
const KEY = 'dialcatz.welcomeSeen';
const seen = ref(true);
try {
  seen.value = localStorage.getItem(KEY) === '1';
} catch {
  /* no storage: treat as seen */
}
const site = ref('');
onMounted(async () => (site.value = (await api.appInfo().catch(() => null))?.site ?? ''));
const open = computed(() => !seen.value && history.value.length === 0 && servers.value.length === 0);

function done() {
  seen.value = true;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* fine: it shows once more next time */
  }
}
function firstCall() {
  done();
  goSection('requests');
  newTab();
}
function bringCollections() {
  done();
  goSection('requests');
  importRequest.value = { tab: 'choose' };
}
function team() {
  done();
  goSection('team');
}
const privacy = () => site.value && api.openUrl(`${site.value}/docs/privacy-and-data`);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open" open class="modal modal-open" @keydown.esc="done">
      <div class="modal-box w-[38rem] max-w-[95vw] space-y-5">
        <div class="flex items-start gap-3">
          <CatMood mood="success" class="size-11 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Welcome to DialCatz</h3>
            <p class="text-sm opacity-70">
              Dial an endpoint, hear it purr: requests, collections, environments and tests on your Mac — and your team’s own server when you
              want to share them.
            </p>
          </div>
        </div>

        <div class="space-y-1">
          <p class="label-caps">Three ways to start</p>
          <p class="text-xs opacity-60">No account, no sign-in, no administrator password. Pick one now or later — nothing is set up for you.</p>
        </div>

        <div class="space-y-3">
          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">1 · Make the first call</p>
                <p class="mt-1 text-sm opacity-70">
                  The <b>Getting started</b> collection has a few requests to try, or start a fresh one. Paste a cURL command into the address bar
                  and it becomes a request.
                </p>
              </div>
              <button class="btn btn-primary btn-sm shrink-0" @click="firstCall">New request</button>
            </div>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">2 · Bring your collections</p>
                <p class="mt-1 text-sm opacity-70">
                  From Postman (a collection, a whole data export, or straight from your account with a Postman API key), OpenAPI or Swagger in JSON or YAML — or the routes of a site DevCatz runs.
                </p>
              </div>
              <button class="btn btn-outline btn-sm shrink-0" @click="bringCollections">Import…</button>
            </div>
          </div>

          <div class="rounded-xl border border-base-300/70 bg-base-200/40 p-4">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <p class="font-medium">3 · Work as a team <span class="badge badge-ghost badge-sm ml-1">optional</span></p>
                <p class="mt-1 text-sm opacity-70">
                  Your team runs its own DialCatz Den; an admin sends you an invite link. Collections sync live, environment values stay on your Mac.
                </p>
              </div>
              <button class="btn btn-outline btn-sm shrink-0" @click="team">Connect…</button>
            </div>
          </div>
        </div>

        <p class="text-xs opacity-60">
          AI is off until you turn it on in Settings → AI, and then only names and URLs go — never your variable values or auth.
          <a v-if="site" class="link" @click="privacy">What DialCatz sends</a>
        </p>

        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" @click="done">Maybe later</button>
          <button class="btn btn-primary btn-sm" @click="done">Get started</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="done" />
    </dialog>
  </Teleport>
</template>
