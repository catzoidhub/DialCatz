<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { activeTab, activeTabId, aiOn, askOpen, connectRequest as connect, goSection, importRequest, loadHistory, onWsEvent, presence, loadSettings, loadWorkspaces, reloadWorkspace, restoreTabs, section, sendTab, settings, settingsTab, syncTabsWithWorkspace, updateState, updateOpen, reportOpen, uninstallOpen, tabs, toast, workspace, type Section } from './state';
import { backIndex, backList, canBack, canForward, forwardList, goBack, goForward, goTo, navApply, navPrune, navVisit, type NavEntry } from './nav';
import PopMenu from './components/PopMenu.vue';
import UpdateDialog from './components/UpdateDialog.vue';
import ReportDialog from './components/ReportDialog.vue';
import WelcomeDialog from './components/WelcomeDialog.vue';
import UninstallDialog from './components/UninstallDialog.vue';
import RequestsSection from './components/RequestsSection.vue';
import EnvironmentsSection from './components/EnvironmentsSection.vue';
import HistorySection from './components/HistorySection.vue';
import TeamSection from './components/TeamSection.vue';
import SettingsSection from './components/SettingsSection.vue';
import ConnectDialog from './components/ConnectDialog.vue';
import AskDialCatz from './components/AskDialCatz.vue';
import askMark from './assets/logos/ask-catzoid.svg';
import { isMac, keyLabel, modKey } from './platform';
import EnvPicker from './components/EnvPicker.vue';
import CatMood from './components/CatMood.vue';
import Icon, { type IconName } from './components/Icon.vue';

/** The shell: section rail → section. Menu commands and dialcatz://connect links arrive here. */
const api = window.dialcatz;
const requests = ref<InstanceType<typeof RequestsSection> | null>(null);
const environments = ref<InstanceType<typeof EnvironmentsSection> | null>(null);
const ready = ref(false);

const RAIL: { id: Section; label: string; icon: IconName }[] = [
  { id: 'requests', label: 'Requests', icon: 'requests' },
  { id: 'environments', label: 'Variables', icon: 'environments' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'team', label: 'Team', icon: 'team' },
];

// The window follows the theme (shared with the other Catzoid apps).
watch(
  () => settings.value?.theme,
  (t) => {
    if (!t || t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  },
);
watch(workspace, (w) => w && syncTabsWithWorkspace(w));

const offs: (() => void)[] = [];
function onCommand(cmd: string) {
  const goReq = () => goSection('requests');
  switch (cmd) {
    case 'about':
      settingsTab.value = 'about';
      goSection('settings');
      break;
    case 'checkUpdates':
      updateOpen.value = true;
      if (!['available', 'downloading', 'verifying', 'downloaded'].includes(updateState.value.kind)) void api.updateCheck();
      break;
    case 'whatsNew':
      updateOpen.value = true;
      break;
    case 'reportBug':
      reportOpen.value = 'bug';
      break;
    case 'sendFeedback':
      reportOpen.value = 'idea';
      break;
    case 'newRequest':
      goReq();
      void requests.value?.newRequest();
      break;
    case 'newCollection':
      goReq();
      void requests.value?.newCollection();
      break;
    case 'import':
      goReq();
      requests.value?.importNow();
      break;
    case 'save':
      if (section.value === 'requests') void requests.value?.save();
      else if (section.value === 'environments') void environments.value?.save();
      break;
    case 'closeTab':
      if (section.value === 'requests') requests.value?.closeTab();
      break;
    case 'send':
      if (activeTab.value) void sendTab(activeTab.value);
      break;
    case 'focusUrl':
      goReq();
      requests.value?.focusUrl();
      break;
  }
}

// ---- Back / forward (nav.ts, as in DevCatz): record where the window is, and go back there.
const navNow = (): NavEntry => ({ section: section.value, item: section.value === 'requests' ? activeTabId.value : null, tab: section.value === 'settings' ? settingsTab.value : null });
watch([section, activeTabId, settingsTab], () => navVisit(navNow()), { immediate: true });
watch(navApply, (r) => {
  if (!r) return;
  const { section: sec, item, tab } = r.entry;
  goSection(sec as Section);
  if (sec === 'requests' && item && tabs.value.some((t) => t.id === item)) activeTabId.value = item;
  if (sec === 'settings' && tab) settingsTab.value = tab as typeof settingsTab.value;
});
// Closed request tabs drop out of the history.
watch(
  () => tabs.value.length,
  () => navPrune((e) => e.section !== 'requests' || !e.item || tabs.value.some((t) => t.id === e.item)),
);
/** "Requests · Get users", "Variables", "Settings · AI" for the history menus. */
function navLabel(e: NavEntry): string {
  const rail = e.section === 'settings' ? 'Settings' : (RAIL.find((r) => r.id === e.section)?.label ?? e.section);
  const name = e.section === 'requests' ? tabs.value.find((t) => t.id === e.item)?.name : null;
  const item = name && name.length > 40 ? `${name.slice(0, 39)}…` : name;
  const tab = e.tab ? e.tab.charAt(0).toUpperCase() + e.tab.slice(1) : null;
  return [rail, item, tab === 'Ai' ? 'AI' : tab].filter(Boolean).join(' · ');
}
const backItems = computed(() => backList.value.map((e, i) => ({ label: navLabel(e), action: () => goTo('back', backIndex(i)) })));
const forwardItems = computed(() => forwardList.value.map((e, i) => ({ label: navLabel(e), action: () => goTo('forward', i) })));
const backMenu = ref<{ toggle: () => void } | null>(null);
/** After an error while crash reports were off: ask once whether to send them from now on. */
const askCrash = ref(false);
async function answerCrash(yes: boolean) {
  askCrash.value = false;
  await api.setReportPrefs(yes ? { crashReports: true } : { askCrash: false });
}
/** A dot on the Settings gear while an update waits. */
const updateDot = computed(() => ['available', 'downloaded'].includes(updateState.value.kind));
const forwardMenu = ref<{ toggle: () => void } | null>(null);

// ⌘K / Ctrl+K: Ask DialCatz. ⌘[ / ⌘] (Ctrl on Windows) and the mouse's back / forward buttons: history.
function onKey(e: KeyboardEvent) {
  if (!modKey(e) || e.altKey || e.shiftKey) return;
  if (e.key.toLowerCase() === 'k' && aiOn('ask')) {
    e.preventDefault();
    askOpen.value = !askOpen.value;
  } else if (e.key === '[') {
    e.preventDefault();
    goBack();
  } else if (e.key === ']') {
    e.preventDefault();
    goForward();
  }
}
function onMouse(e: MouseEvent) {
  if (e.button === 3) goBack();
  else if (e.button === 4) goForward();
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  window.addEventListener('mouseup', onMouse);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('mouseup', onMouse);
});

onMounted(async () => {
  await Promise.all([loadSettings(), loadWorkspaces(), loadHistory()]);
  restoreTabs();
  ready.value = true;
  offs.push(api.onCommand(onCommand));
  offs.push(api.onSettings((s) => (settings.value = s)));
  offs.push(api.onWorkspaces(() => void loadWorkspaces()));
  offs.push(api.onSynced(() => void reloadWorkspace()));
  offs.push(api.onConnect((r) => (connect.value = r)));
  offs.push(api.onWs(onWsEvent));
  offs.push(api.onDevCatz((siteId) => (importRequest.value = { tab: 'devcatz', siteId })));
  offs.push(api.onPresence((p) => (presence.value = { ...presence.value, [p.workspaceId]: p.presence })));
  offs.push(api.onUpdate((st) => (updateState.value = st)));
  updateState.value = await api.updateState();
  // Uncaught errors in the window go to the crash reports when the user turned them on (Catzoid #65).
  const report = (message: string, stack: string) => void api.reportError(message, stack).catch(() => {});
  window.addEventListener('error', (e) => report(e.message, e.error?.stack ?? ''));
  window.addEventListener('unhandledrejection', (e) => report(String(e.reason?.message ?? e.reason), e.reason?.stack ?? ''));
  const rp = await api.reportPrefs();
  askCrash.value = rp.askCrash && !rp.crashReports;
  connect.value = await api.pendingConnect();
});
onBeforeUnmount(() => offs.forEach((f) => f()));
</script>

<template>
  <div class="flex h-full" :class="{ 'is-mac': isMac }">
    <!-- Section rail -->
    <nav class="rail drag flex w-24 shrink-0 flex-col items-center pt-12 pb-3">
      <div class="rail-scroll flex flex-1 flex-col items-center gap-1 overflow-y-auto">
        <button v-for="r in RAIL" :key="r.id" class="rail-item no-drag" :class="{ 'is-active': section === r.id }" :style="{ '--rail-c': `var(--c-${r.id})` }" @click="goSection(r.id)">
          <span class="rail-icon"><Icon :name="r.icon" class="size-[18px]" /></span>{{ r.label }}
        </button>
      </div>
      <div class="my-2 w-12 border-t border-base-content/10" />
      <button class="rail-item no-drag" :class="{ 'is-active': section === 'settings' }" style="--rail-c: var(--c-settings)" @click="goSection('settings')">
        <span class="rail-icon relative"><Icon name="settings" class="size-[18px]" /><span v-if="updateDot" class="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary ring-2 ring-base-200" title="An update is available" /></span>Settings
      </button>
    </nav>

    <main v-if="ready" class="main-surface flex min-w-0 flex-1">
      <RequestsSection v-show="section === 'requests'" ref="requests">
        <template #env><EnvPicker /></template>
      </RequestsSection>
      <EnvironmentsSection v-if="section === 'environments'" ref="environments" />
      <HistorySection v-else-if="section === 'history'" />
      <TeamSection v-else-if="section === 'team'" />
      <SettingsSection v-else-if="section === 'settings'" />
    </main>

    <button v-if="ready && aiOn('ask') && !askOpen && workspace" class="ask-fab no-drag" :title="`Ask DialCatz (${keyLabel('mod+K')}): say what you need in plain words`" aria-label="Ask DialCatz" @click="askOpen = true"><span><img :src="askMark" alt="" /></span></button>
    <AskDialCatz v-if="askOpen" @close="askOpen = false" />

    <div v-if="toast.text" class="toast toast-end toast-bottom z-50" :class="{ 'is-beside-fab': aiOn('ask') }">
      <div class="alert" :class="`alert-${toast.kind}`">
        <CatMood :mood="toast.kind" class="size-8 shrink-0 -my-1" />
        <span class="max-w-md text-sm">{{ toast.text }}</span>
      </div>
    </div>

    <ConnectDialog v-if="connect" :request="connect" @close="connect = null" />
    <UpdateDialog v-if="updateOpen" @close="updateOpen = false" />
    <ReportDialog v-if="reportOpen" :kind="reportOpen" @close="reportOpen = null" />
    <WelcomeDialog v-if="ready" />
    <UninstallDialog v-if="uninstallOpen" @close="uninstallOpen = false" />
    <div v-if="askCrash" class="toast toast-start toast-bottom z-50">
      <div class="alert max-w-md items-start gap-2.5 text-sm shadow-lg">
        <CatMood mood="warning" class="-my-1 size-8 shrink-0" />
        <span class="min-w-0 flex-1">DialCatz ran into an error. Send crash and error reports to Catzoid from now on? They never carry tokens, request or response bodies, variable values or hosts.</span>
        <span class="flex shrink-0 flex-col gap-1">
          <button class="btn btn-primary btn-xs" @click="answerCrash(true)">Send reports</button>
          <button class="btn btn-ghost btn-xs" @click="answerCrash(false)">Not now</button>
        </span>
      </div>
    </div>
    <!-- Back / forward right of the rail, level with the traffic lights (as in DevCatz); right-click lists the recent
       screens. Every sidebar / page header leaves this strip free. Last in the document on purpose: Electron builds
       the drag area in document order, so a no-drag hole made before the drag strips would be filled again. -->
    <div class="no-drag fixed top-2.5 left-[6.75rem] z-30 flex items-center gap-0.5">
      <PopMenu ref="backMenu" :items="backItems" :width="240">
        <button class="btn btn-ghost btn-xs btn-square" :disabled="!canBack" :title="`Back (${keyLabel('mod+[')}) · right-click for recent screens`" aria-label="Back" @click.stop="goBack" @contextmenu.prevent.stop="canBack && backMenu?.toggle()">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.8 4.2a.75.75 0 0 1 0 1.06L8.06 10l4.74 4.74a.75.75 0 1 1-1.06 1.06l-5.27-5.27a.75.75 0 0 1 0-1.06l5.27-5.27a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
        </button>
      </PopMenu>
      <PopMenu ref="forwardMenu" :items="forwardItems" :width="240">
        <button class="btn btn-ghost btn-xs btn-square" :disabled="!canForward" :title="`Forward (${keyLabel('mod+]')}) · right-click for recent screens`" aria-label="Forward" @click.stop="goForward" @contextmenu.prevent.stop="canForward && forwardMenu?.toggle()">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.2 4.2a.75.75 0 0 1 1.06 0l5.27 5.27a.75.75 0 0 1 0 1.06L8.26 15.8a.75.75 0 1 1-1.06-1.06L11.94 10 7.2 5.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
        </button>
      </PopMenu>
    </div>
  </div>
</template>
