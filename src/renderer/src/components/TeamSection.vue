<script setup lang="ts">
import { ref } from 'vue';
import type { ServerConnection } from '@shared/types';
import { attempt, loadWorkspaces, notify, servers } from '../state';
import AddServerDialog from './AddServerDialog.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import CatMood from './CatMood.vue';
import Icon from './Icon.vue';

/**
 * Team: the list of DialCatz Den servers this app is connected to (one card each: who you are there, which of its
 * workspaces show in DialCatz). "Add server" opens the connect dialog. No sign-in — the admin of a server creates
 * you as a member and sends an invite link; who you are comes from the server.
 */
const api = window.dialcatz;
const adding = ref(false);
const removing = ref<ServerConnection | null>(null);
const refreshing = ref<string | null>(null);
async function copyRun() {
  await api.copyText('docker run -d -p 8080:8080 -v dialcatz:/data ghcr.io/catzoidhub/dialcatz-den');
  notify('success', 'Command copied');
}

async function refresh(s: ServerConnection) {
  refreshing.value = s.id;
  await attempt(() => api.refreshServer(s.id));
  await loadWorkspaces();
  refreshing.value = null;
}
async function subscribe(s: ServerConnection, wsId: string, on: boolean) {
  await attempt(() => api.subscribeWorkspace(s.id, wsId, on));
  await loadWorkspaces();
}
async function disconnect() {
  const s = removing.value!;
  removing.value = null;
  await attempt(() => api.disconnectServer(s.id), 'Disconnected');
  await loadWorkspaces();
}
const host = (u: string) => u.replace(/^https?:\/\//, '');
const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <header class="drag flex items-center gap-3 border-b border-base-300/60 px-6 pt-11 pb-4">
      <span class="grid size-9 shrink-0 place-items-center rounded-xl" style="color: var(--c-team); background: color-mix(in oklch, var(--c-team) 16%, transparent)"><Icon name="team" class="size-5" /></span>
      <div class="min-w-0 flex-1">
        <h1 class="text-lg font-semibold tracking-tight">Team</h1>
        <p class="text-xs opacity-60">Servers you share collections through. No accounts: each server’s admin invites you.</p>
      </div>
      <button class="btn btn-primary btn-sm gap-1.5" @click="adding = true"><Icon name="plus" class="size-4" />Add server</button>
    </header>

    <div class="site-tab">
      <div class="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <!-- No server yet -->
        <div v-if="!servers.length" class="card">
          <div class="card-body items-center py-12 text-center">
            <CatMood mood="info" class="size-14" />
            <h2>No team server yet</h2>
            <p class="max-w-md text-sm opacity-70">Ask your team’s admin for an invite link and open it, or add the server here.</p>
            <button class="btn btn-primary btn-sm mt-2 gap-1.5" @click="adding = true"><Icon name="plus" class="size-4" />Add server</button>
          </div>
        </div>

        <div v-for="s in servers" :key="s.id" class="card">
          <div class="card-body">
            <div class="flex items-start gap-3">
              <img v-if="s.avatar" :src="s.avatar" alt="" class="avatar-circle object-cover" />
              <span v-else class="avatar-circle">{{ initials(s.identity?.member.name ?? '?') }}</span>
              <div class="min-w-0 flex-1">
                <h2 class="truncate">{{ s.identity?.member.name ?? 'Unknown member' }} <span class="font-normal opacity-50">· {{ s.identity?.member.email }}</span></h2>
                <p class="text-xs opacity-60"><Icon name="server" class="inline size-3.5" /> {{ host(s.url) }} · Device: {{ s.identity?.device }}</p>
              </div>
              <button class="btn btn-ghost btn-sm btn-square" title="Refresh" @click="refresh(s)"><Icon name="refresh" class="size-4" :class="{ 'animate-spin': refreshing === s.id }" /></button>
              <button class="btn btn-ghost btn-sm text-error" @click="removing = s">Disconnect</button>
            </div>
            <div v-if="s.lastError" class="alert alert-warning alert-soft text-sm">
              <CatMood mood="warning" class="size-7 shrink-0 -my-0.5" /><span>{{ s.lastError }}</span>
            </div>
            <div>
              <h3 class="label-caps mb-2">Workspaces you can use</h3>
              <p v-if="!s.identity?.workspaces.length" class="text-sm opacity-60">None yet — ask the admin to add you to a workspace.</p>
              <div v-for="w in s.identity?.workspaces ?? []" :key="w.id" class="opt-row">
                <span class="flex min-w-0 flex-1 items-center gap-2">
                  <span class="truncate text-sm font-medium">{{ w.name }}</span>
                  <span class="badge badge-ghost badge-sm">{{ w.role }}</span>
                </span>
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.workspaceIds.includes(w.id)" title="Show in DialCatz" @change="subscribe(s, w.id, ($event.target as HTMLInputElement).checked)" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- How to run a Den: always there, under the list. -->
    <footer class="den-footer">
      <Icon name="server" class="size-4 shrink-0 opacity-60" />
      <span class="shrink-0 text-sm font-medium">Run your own DialCatz Den</span>
      <code class="selectable min-w-0 flex-1 truncate font-mono text-xs" title="One Docker container, SQLite inside (or PostgreSQL). The first visit creates the admin.">docker run -d -p 8080:8080 -v dialcatz:/data ghcr.io/catzoidhub/dialcatz-den</code>
      <button class="btn btn-ghost btn-xs gap-1" @click="copyRun"><Icon name="copy" class="size-3.5" />Copy</button>
      <button class="btn btn-ghost btn-xs" @click="api.openUrl('https://github.com/catzoidhub/DialCatz-Den#readme')">Guide</button>
    </footer>

    <AddServerDialog v-if="adding" @close="adding = false" />
    <ConfirmDialog
      v-if="removing"
      :title="`Disconnect from ${host(removing.url)}?`"
      text="Its workspaces leave this computer (changes not synced yet are lost) and the token is removed. The admin can send a new invite later."
      confirm="Disconnect"
      tone="warning"
      @ok="disconnect"
      @cancel="removing = null"
    />
  </div>
</template>
