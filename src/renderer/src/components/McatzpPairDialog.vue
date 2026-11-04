<script setup lang="ts">
import dialcatzLogo from '../assets/logos/dialcatz.png';
import mcatzpLogo from '../assets/logos/mcatzp.svg';
import { attempt, mcatzpAsk } from '../state';

/** MCatzP asks here: may this MCP client connect (the first time). DevCatz's dialog is the model. */
const api = window.dialcatz;
const ask = mcatzpAsk;
const CAN = ['The workspaces you share: collections, requests and environments', 'Variable values, history and responses when you share them, with secrets masked'];
const answer = (a: 'deny' | 'once') => {
  const id = ask.value?.id;
  if (id) void attempt(() => api.mcatzpAnswer(id, a).then(() => true));
};
</script>

<template>
  <!-- At the end of <body>, above everything: it can come up on any page, over another dialog. -->
  <Teleport to="body">
    <dialog v-if="ask" open class="modal modal-open z-[1000]" @keydown.esc.prevent="answer('deny')">
      <div class="modal-box flex w-[27rem] max-w-[95vw] flex-col items-center gap-4 text-center">
        <!-- The way the request travels: MCatzP → this app. -->
        <div class="flex items-center gap-3" role="img" aria-label="MCatzP to DialCatz">
          <img :src="mcatzpLogo" alt="" class="size-14 rounded-2xl shadow-sm" draggable="false" />
          <!-- Still on purpose: nothing here moves, a waiting dialog must not cost CPU. -->
          <svg viewBox="0 0 64 24" class="h-6 w-16 shrink-0" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <defs>
              <linearGradient id="mcatzp-to-app" gradientUnits="userSpaceOnUse" x1="4" y1="12" x2="60" y2="12">
                <stop offset="0" stop-color="#FF8DBE" />
                <stop offset="1" stop-color="#4ECBB4" />
              </linearGradient>
            </defs>
            <circle cx="5" cy="12" r="2.5" fill="url(#mcatzp-to-app)" />
            <path d="M12 12h46M50 5l8 7-8 7" stroke="url(#mcatzp-to-app)" stroke-width="2.5" />
          </svg>
          <img :src="dialcatzLogo" alt="" class="size-14 rounded-2xl shadow-sm" draggable="false" />
        </div>
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Let <span class="client selectable">{{ ask.client }}</span> use DialCatz?</h3>
          <p class="mt-0.5 text-xs opacity-60">{{ ask.version ? `Version ${ask.version}, connecting` : 'Connecting' }} through MCatzP</p>
        </div>
        <div class="w-full rounded-box border border-base-300/70 bg-base-200/40 p-3 text-left">
          <span class="label-caps mb-1.5 block">It can read</span>
          <ul class="space-y-1 text-sm">
            <li v-for="c in CAN" :key="c" class="flex items-center gap-2"><span class="status status-success status-xs shrink-0" />{{ c }}</li>
          </ul>
          <p class="mt-2 border-t border-base-300/60 pt-2 text-xs opacity-70">It cannot send requests or change anything. What it reads goes to that assistant's model provider.</p>
        </div>
        <p class="text-xs opacity-60">You can revoke this in Settings → MCatzP. The name is what the client says about itself: if you did not just start it, choose Don't Allow.</p>
        <div class="flex w-full gap-2">
          <button class="btn btn-sm flex-1" autofocus @click="answer('deny')">Don't Allow</button>
          <button class="btn btn-primary btn-sm flex-1" @click="answer('once')">Allow</button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
/* Who is asking is what the user checks first. */
.client {
  border-radius: 0.375rem;
  background: color-mix(in oklab, var(--color-primary) 18%, transparent);
  color: var(--primary-ink, var(--color-primary));
  font-weight: 600;
  padding: 0.05em 0.4em;
}
</style>
