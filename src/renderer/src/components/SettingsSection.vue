<script setup lang="ts">
import AboutCard from './AboutCard.vue';
import AiModelPicker from './AiModelPicker.vue';
import { computed, onMounted, ref } from 'vue';
import { AI_FEATURES, AI_PROVIDERS, aiProvider, type AiFeature, type AiProvider, type DialCatzSettingsPatch, type Theme } from '@shared/types';
import { AUTO_HEADERS } from '@shared/request';
import { attempt, notify, settings, settingsTab, updateOpen, updateState } from '../state';
import type { ReportPrefs, UpdatePrefs } from '@shared/types';
import { words } from '../platform';
import PageHeader from './PageHeader.vue';

/** Settings: appearance and the AI connection (both shared with all Catzoid apps), request defaults, about. */
const api = window.dialcatz;

async function patch(p: DialCatzSettingsPatch) {
  const s = await attempt(() => api.setSettings(p));
  if (s) settings.value = s;
}
const ai = computed(() => settings.value!.ai);
const provider = computed(() => aiProvider(ai.value.provider));
const model = computed(() => ai.value.models[ai.value.provider] ?? provider.value.models[0] ?? '');
const baseUrl = computed(() => ai.value.baseUrls[ai.value.provider] ?? '');
const hasKey = computed(() => ai.value.keys.includes(ai.value.provider));
const keyDraft = ref('');
async function saveKey(remove = false) {
  const s = await attempt(() => api.setAiKey(ai.value.provider, remove ? '' : keyDraft.value), remove ? 'Key removed' : 'Key saved');
  if (s) {
    settings.value = s;
    keyDraft.value = '';
  }
}
function setFeature(f: AiFeature, on: boolean) {
  const off = new Set(ai.value.off);
  if (on) off.delete(f);
  else off.add(f);
  void patch({ ai: { off: [...off] } });
}
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);
async function testAi() {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = { ok: true, text: `Answered: ${await api.aiTest()}` };
  } catch (e) {
    testResult.value = { ok: false, text: String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  } finally {
    testing.value = false;
  }
}
const loadedModels = ref<Partial<Record<AiProvider, string[]>>>({});
const loadingModels = ref(false);
async function loadModels() {
  loadingModels.value = true;
  const list = await attempt(() => api.aiModels(ai.value.provider));
  loadingModels.value = false;
  if (list) {
    loadedModels.value = { ...loadedModels.value, [ai.value.provider]: list };
    notify('success', `${list.length} model(s) available`);
  }
}
const modelChoices = computed(() => [...new Set([...(loadedModels.value[ai.value.provider] ?? []), ...provider.value.models])]);

// Updates (Catzoid #54) and crash reports (#65).
const updatePrefs = ref<UpdatePrefs | null>(null);
const reportPrefs = ref<ReportPrefs | null>(null);
const version = ref('');
const site = ref('https://catzoid.com');
onMounted(async () => {
  updatePrefs.value = await api.updatePrefs();
  reportPrefs.value = await api.reportPrefs();
  const i = await api.appInfo();
  version.value = i.version;
  site.value = i.site;
});
async function setUpdate(patch: Partial<Pick<UpdatePrefs, 'auto' | 'channel' | 'notify'>>) {
  updatePrefs.value = await api.setUpdatePrefs(patch);
}
async function setCrash(on: boolean) {
  reportPrefs.value = await api.setReportPrefs({ crashReports: on });
}
async function checkNow() {
  updateOpen.value = true;
  await api.updateCheck();
  updatePrefs.value = await api.updatePrefs();
}
const lastChecked = computed(() => (updatePrefs.value?.lastChecked ? new Date(updatePrefs.value.lastChecked).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never'));
const CHANNELS = [
  { id: 'stable', label: 'Stable' },
  { id: 'beta', label: 'Beta' },
] as const;
const TABS = [
  { id: 'general', label: 'General' },
  { id: 'ai', label: 'AI' },
  { id: 'updates', label: 'Updates' },
  { id: 'about', label: 'About' },
] as const;
const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'Auto' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];
</script>

<template>
  <div v-if="settings" class="flex min-h-0 min-w-0 flex-1 flex-col">
    <PageHeader title="Settings" icon="" :closable="false" tint="settings">
      <template #beside>
        <div role="tablist" class="seg no-drag ml-3">
          <button v-for="t in TABS" :key="t.id" role="tab" class="seg-item normal-case" :class="{ 'is-active': settingsTab === t.id }" :aria-selected="settingsTab === t.id" @click="settingsTab = t.id">{{ t.label }}</button>
        </div>
      </template>
    </PageHeader>
    <!-- The page scrolls edge to edge (scrollbar at the window's right edge); the cards keep a readable width. -->
    <div class="site-tab">
      <div class="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <template v-if="settingsTab === 'general'">
      <div class="card">
        <div class="card-body">
          <div class="flex items-center gap-2"><h2 class="flex-1">Appearance</h2><span class="badge badge-soft badge-primary badge-sm" title="Change it here and every Catzoid app follows">Shared with Catzoid apps</span></div>
          <p class="text-sm opacity-60">All Catzoid apps use the same theme.</p>
          <div class="opt-row">
            <span class="label-caps">Theme</span>
            <div class="seg seg-choice">
              <button v-for="t in THEMES" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': settings.theme === t.id }" @click="patch({ theme: t.id })">{{ t.label }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <h2>Requests</h2>
          <div class="opt-row">
            <span class="label-caps">Timeout</span>
            <span class="flex items-center gap-2">
              <input type="number" min="1" max="600" class="input input-sm w-24 font-mono" :value="Math.round(settings.requests.timeoutMs / 1000)" @change="patch({ requests: { timeoutMs: Number(($event.target as HTMLInputElement).value) * 1000 } })" />
              <span class="text-sm opacity-60">seconds</span>
            </span>
          </div>
          <div class="opt-row">
            <span class="label-caps">Follow redirects</span>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="settings.requests.followRedirects" @change="patch({ requests: { followRedirects: ($event.target as HTMLInputElement).checked } })" />
          </div>
          <div class="opt-row">
            <span class="flex flex-col gap-0.5">
              <span class="label-caps">Skip certificate checks</span>
              <span class="text-xs opacity-50">For local dev servers with self-signed certificates. Leave off for anything else.</span>
            </span>
            <input type="checkbox" class="toggle toggle-sm toggle-warning" :checked="settings.requests.insecure" @change="patch({ requests: { insecure: ($event.target as HTMLInputElement).checked } })" />
          </div>
          <div class="opt-row items-start">
            <span class="flex flex-col gap-0.5">
              <span class="label-caps">Auto headers</span>
              <span class="text-xs opacity-50">What new requests send by default. Each request can still switch them on or off in its Headers tab.</span>
            </span>
            <div class="flex flex-col gap-1.5">
              <label v-for="a in AUTO_HEADERS" :key="a.key" class="flex items-center justify-end gap-2 font-mono text-xs">
                {{ a.key }}
                <input type="checkbox" class="toggle toggle-xs toggle-primary" :checked="settings.requests.autoHeaders[a.key] !== false" @change="patch({ requests: { autoHeaders: { ...settings.requests.autoHeaders, [a.key]: ($event.target as HTMLInputElement).checked } } })" />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div v-if="reportPrefs" class="card">
        <div class="card-body">
          <h2>Privacy</h2>
          <div class="opt-row">
            <span class="flex flex-col">
              <span class="label-caps">Send crash reports</span>
              <span class="text-xs opacity-50">When DialCatz crashes or hits an error, send the error to Catzoid so it gets fixed. Never your requests, responses, variables, tokens or hosts. <a class="link" @click="api.openUrl(`${site}/docs/privacy-and-data`)">What is sent</a></span>
            </span>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="reportPrefs.crashReports" @change="setCrash(($event.target as HTMLInputElement).checked)" />
          </div>
        </div>
      </div>

      </template>

      <template v-if="settingsTab === 'updates'">
      <div v-if="updatePrefs" class="card">
        <div class="card-body">
          <h2>Updates</h2>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">DialCatz {{ version }}</span><span class="text-xs opacity-50">Last checked: {{ lastChecked }}</span></span>
            <button class="btn btn-sm" :disabled="updateState.kind === 'checking'" @click="checkNow"><span v-if="updateState.kind === 'checking'" class="loading loading-spinner loading-xs" />{{ ['available', 'downloaded'].includes(updateState.kind) ? 'Show the update' : 'Check now' }}</button>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Check automatically</span><span class="text-xs opacity-50">30 seconds after DialCatz opens, then every 6 hours. Nothing downloads without you.</span></span>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="updatePrefs.auto" @change="setUpdate({ auto: ($event.target as HTMLInputElement).checked })" />
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Channel</span><span class="text-xs opacity-50">Beta gets new versions earlier, before they are fully tested.</span></span>
            <div class="seg seg-choice">
              <button v-for="c in CHANNELS" :key="c.id" class="seg-item" :class="{ 'is-active': updatePrefs.channel === c.id }" @click="setUpdate({ channel: c.id })">{{ c.label }}</button>
            </div>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Notify me</span><span class="text-xs opacity-50">A notification once when a new version is out.</span></span>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="updatePrefs.notify" @change="setUpdate({ notify: ($event.target as HTMLInputElement).checked })" />
          </div>
        </div>
      </div>
      </template>

      <template v-if="settingsTab === 'ai'">
      <div class="card">
        <div class="card-body">
          <div class="flex items-center gap-2">
            <img src="../assets/logos/ask-catzoid.svg" alt="" class="size-6" />
            <h2 class="flex-1">AI</h2>
            <span class="badge badge-soft badge-primary badge-sm" title="Change the provider, model or key in any Catzoid app and the others follow">Shared with Catzoid apps</span>
          </div>
          <p class="text-sm opacity-60">This switch and the features below are for DialCatz only; the provider, model and key are shared with all Catzoid apps.</p>
          <div class="opt-row">
            <span class="label-caps">Use AI in DialCatz</span>
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="ai.enabled" @change="patch({ ai: { enabled: ($event.target as HTMLInputElement).checked } })" />
          </div>
          <div class="opt-row">
            <span class="label-caps">Provider</span>
            <select class="select select-sm w-72" :value="ai.provider" @change="patch({ ai: { provider: ($event.target as HTMLSelectElement).value as AiProvider } })">
              <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
          </div>
          <div class="opt-row">
            <span class="label-caps">Model</span>
            <span class="flex w-[26rem] max-w-full items-center gap-2">
              <AiModelPicker :model-value="model" :models="modelChoices" :placeholder="provider.models[0] ?? 'model id'" @update:model-value="(m) => patch({ ai: { models: { [ai.provider]: m } } })" />
              <button class="btn btn-ghost btn-sm" :disabled="loadingModels" title="Ask the provider which models this key can use" @click="loadModels"><span v-if="loadingModels" class="loading loading-spinner loading-xs" />Load models</button>
            </span>
          </div>
          <div v-if="['ollama', 'openai-compatible'].includes(ai.provider)" class="opt-row">
            <span class="label-caps">Address</span>
            <input class="input input-sm w-72 font-mono" :value="baseUrl" :placeholder="provider.baseUrl" @change="patch({ ai: { baseUrls: { [ai.provider]: ($event.target as HTMLInputElement).value } } })" />
          </div>
          <div v-if="provider.keyUrl || ai.provider === 'openai-compatible'" class="opt-row">
            <span class="flex flex-col gap-0.5">
              <span class="label-caps">API key</span>
              <span class="text-xs opacity-50">{{ hasKey ? `Kept only on this computer in ${words.secretStore}, shared with Catzoid apps` : 'Not set' }}<template v-if="provider.keyUrl"> · <a class="link" @click="api.openUrl(provider.keyUrl)">get one</a></template></span>
            </span>
            <span class="flex items-center gap-2">
              <input v-model="keyDraft" type="password" class="input input-sm w-56 font-mono" :placeholder="hasKey ? '•••••••• (replace)' : 'Paste the key'" />
              <button class="btn btn-sm" :disabled="!keyDraft.trim()" @click="saveKey()">Save</button>
              <button v-if="hasKey" class="btn btn-ghost btn-sm text-error" @click="saveKey(true)">Remove</button>
            </span>
          </div>
          <div class="opt-row">
            <span class="flex flex-col"><span class="label-caps">Connection</span><span v-if="testResult" class="text-xs" :class="testResult.ok ? 'text-success' : 'text-error'">{{ testResult.text }}</span></span>
            <button class="btn btn-sm" :disabled="testing || !ai.enabled" :title="ai.enabled ? 'One tiny request to the chosen model' : 'Turn AI on first'" @click="testAi"><span v-if="testing" class="loading loading-spinner loading-xs" />Test connection</button>
          </div>
          <div class="divider my-0" />
          <h3 class="label-caps">Features</h3>
          <div v-for="f in AI_FEATURES" :key="f.id" class="opt-row items-start">
            <span class="flex flex-col gap-0.5">
              <span class="text-sm font-medium">{{ f.label }}</span>
              <span class="text-xs opacity-60">{{ f.hint }}</span>
              <span class="text-xs opacity-45">Sends: {{ f.sends }}.</span>
            </span>
            <input type="checkbox" class="toggle toggle-sm toggle-primary mt-1" :checked="!ai.off.includes(f.id)" :disabled="!ai.enabled" @change="setFeature(f.id, ($event.target as HTMLInputElement).checked)" />
          </div>
        </div>
      </div>

      </template>

      <AboutCard v-if="settingsTab === 'about'" />
      </div>
    </div>
  </div>
</template>
