<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { CiPlan, CiSaved, TreeItem } from '@shared/types';
import { ciFile, ciProblem, ciSecretName, ciText, type CiProvider, type CiSetup } from '@shared/ci';
import { attempt, goSection, notify, plain, workspace } from '../state';
import { store } from '../store';
import CatMood from './CatMood.vue';
import CodeEditor from './CodeEditor.vue';
import Icon from './Icon.vue';

/**
 * Run in CI (#103): a GitHub Actions workflow or GitLab CI job that runs the collection with the DialCatz CLI when the
 * code changes. Everything that will be written is in the preview before it is saved.
 */
const props = defineProps<{ collection: TreeItem }>();
const emit = defineEmits<{ close: [] }>();
const api = window.dialcatz;

const ws = workspace.value!.id;
const plan = ref<CiPlan | null>(null);
const setup = reactive<CiSetup>({ provider: store.get<CiProvider>('ciProvider', 'github'), push: true, pull: true, schedule: '', branch: 'main', variables: [], retries: 0, report: true, action: false, prepare: '' });
const scheduled = ref(false);
const tab = ref<'setup' | 'preview'>('setup');
const literals = ref(false);
const busy = ref(false);
const saved = ref<CiSaved | null>(null);
const replace = ref<string[] | null>(null);

onMounted(async () => {
  plan.value = (await attempt(() => api.ciPlan(ws, props.collection.id))) ?? null;
  if (!plan.value) return emit('close');
  setup.variables = plan.value.variables.map((v) => ({ ...v }));
});
watch(() => setup.provider, (p) => store.set('ciProvider', p));
watch(scheduled, (on) => (setup.schedule = on ? setup.schedule || '0 3 * * 1-5' : ''));

const problem = computed(() => ciProblem(setup));
const text = computed(() => (plan.value && !problem.value ? ciText(plan.value.target, setup) : ''));
const file = computed(() => (plan.value ? ciFile(setup.provider, plan.value.target.slug) : ''));
const secrets = computed(() => setup.variables.filter((v) => v.kind === 'secret').map((v) => ciSecretName(v.name)));
const empty = computed(() => setup.variables.filter((v) => v.kind === 'plain' && !v.value.trim()).map((v) => v.name));
const noRepo = computed(() => !!plan.value?.inRepo && !plan.value.root);
const held = computed(() => !!plan.value && !plan.value.inRepo && plan.value.literals.length > 0 && !literals.value);
const list = (names: string[]) => `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;

async function save(overwrite = false) {
  busy.value = true;
  const r = await attempt(() => api.ciSave(ws, props.collection.id, plain(setup), { overwrite, literals: literals.value }));
  busy.value = false;
  replace.value = null;
  if (!r) return;
  if (r.exists.length) replace.value = r.exists;
  else saved.value = r;
}
async function copy(t: string, what: string) {
  await navigator.clipboard.writeText(t);
  notify('success', `${what} copied`);
}
function toGit() {
  emit('close');
  goSection('git');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('close')">
    <div class="modal-box flex max-h-[88vh] w-[42rem] max-w-[95vw] flex-col gap-4">
      <div class="flex items-start gap-3">
        <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-primary/10"><CatMood :mood="saved ? 'success' : 'info'" class="size-8" /></span>
        <div class="min-w-0 flex-1">
          <h3 class="text-lg font-semibold tracking-tight">Run “{{ collection.name }}” in CI</h3>
          <p class="text-sm opacity-70">Every change to your code runs these requests and their tests on GitHub or GitLab, so a broken API shows before it is merged.</p>
        </div>
      </div>

      <div v-if="!plan" class="grid place-items-center py-10"><span class="loading loading-spinner" /></div>

      <!-- Saved: what is left to do -->
      <div v-else-if="saved" class="min-h-0 space-y-3 overflow-y-auto">
        <div class="ci-card space-y-1">
          <p class="text-sm font-medium">Saved in <span class="font-mono text-xs break-all">{{ saved.root }}</span></p>
          <p v-for="f in saved.files" :key="f" class="font-mono text-xs break-all opacity-70">{{ f }}</p>
        </div>
        <div v-for="n in saved.notes" :key="n" class="ci-card space-y-2">
          <p class="text-sm font-medium">One more thing</p>
          <pre class="selectable overflow-x-auto text-xs">{{ n }}</pre>
        </div>
        <div v-if="secrets.length" class="ci-card space-y-2">
          <p class="text-sm">Add these secrets on {{ setup.provider === 'github' ? 'GitHub: Settings → Secrets and variables → Actions' : 'GitLab: Settings → CI/CD → Variables, as masked' }}.</p>
          <div v-for="s in secrets" :key="s" class="flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate text-xs">{{ s }}</code>
            <button class="btn btn-ghost btn-xs" :title="`Copy ${s}`" @click="copy(s, 'Name')"><Icon name="copy" class="size-3.5" /></button>
          </div>
        </div>
        <p class="text-sm opacity-70">Commit and push the files to start it.</p>
      </div>

      <template v-else>
        <div class="flex flex-wrap items-center gap-3">
          <div class="seg seg-choice flex-1" role="radiogroup" aria-label="CI service">
            <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': setup.provider === 'github' }" :aria-checked="setup.provider === 'github'" @click="setup.provider = 'github'">GitHub Actions</button>
            <button type="button" role="radio" class="seg-item flex-1 normal-case" :class="{ 'is-active': setup.provider === 'gitlab' }" :aria-checked="setup.provider === 'gitlab'" @click="setup.provider = 'gitlab'">GitLab CI</button>
          </div>
          <div class="seg flex-1" role="tablist">
            <button type="button" role="tab" class="seg-item flex-1 normal-case" :class="{ 'is-active': tab === 'setup' }" @click="tab = 'setup'">Setup</button>
            <button type="button" role="tab" class="seg-item flex-1 normal-case" :class="{ 'is-active': tab === 'preview' }" @click="tab = 'preview'">Preview</button>
          </div>
        </div>

        <div v-if="tab === 'setup'" class="min-h-0 space-y-3 overflow-y-auto">
          <p v-if="plan.tested < plan.requests" class="ci-card text-sm">
            <b>{{ plan.requests - plan.tested }}</b> of {{ plan.requests }} requests {{ plan.requests - plan.tested === 1 ? 'has' : 'have' }} no tests. Without one, any answer passes, even an error 500. Add tests to a request, or once for all in the collection's Settings.
          </p>

          <div class="ci-card space-y-2.5">
            <p class="label-caps">When</p>
            <div class="flex items-center gap-3">
              <label class="flex flex-1 items-center gap-2 text-sm"><input v-model="setup.push" type="checkbox" class="checkbox checkbox-sm" />On pushes to</label>
              <input v-model="setup.branch" class="input input-sm w-52 font-mono" :disabled="!setup.push" aria-label="Branch" placeholder="main" spellcheck="false" />
            </div>
            <label class="flex items-center gap-2 text-sm"><input v-model="setup.pull" type="checkbox" class="checkbox checkbox-sm" />On {{ setup.provider === 'github' ? 'pull' : 'merge' }} requests</label>
            <div class="flex items-center gap-3">
              <label class="flex flex-1 items-center gap-2 text-sm"><input v-model="scheduled" type="checkbox" class="checkbox checkbox-sm" />On a schedule <span class="text-xs opacity-50">cron, UTC</span></label>
              <input v-model="setup.schedule" class="input input-sm w-52 font-mono" :disabled="!scheduled" aria-label="Schedule" placeholder="0 3 * * 1-5" spellcheck="false" />
            </div>
          </div>

          <div v-if="setup.variables.length" class="ci-card space-y-2">
            <p class="label-caps">Variables</p>
            <p class="text-xs opacity-60">A secret is read from {{ setup.provider === 'github' ? 'GitHub' : 'GitLab' }} and never written down. A plain value goes into the file, for everyone who sees the repository.</p>
            <div v-for="v in setup.variables" :key="v.name" class="flex items-center gap-2">
              <code class="w-40 shrink-0 truncate text-xs" :title="v.name">{{ v.name }}</code>
              <select v-model="v.kind" class="select select-sm w-28 shrink-0" :aria-label="`Where ${v.name} comes from`"><option value="secret">Secret</option><option value="plain">Plain</option></select>
              <code v-if="v.kind === 'secret'" class="min-w-0 flex-1 truncate text-xs opacity-60">{{ ciSecretName(v.name) }}</code>
              <input v-else v-model="v.value" class="input input-sm min-w-0 flex-1 font-mono" :aria-label="`Value of ${v.name}`" placeholder="Its value in CI" spellcheck="false" />
            </div>
          </div>

          <div class="ci-card space-y-2">
            <p class="label-caps">Before the tests</p>
            <CodeEditor v-model="setup.prepare" language="shell" class="h-20 rounded-lg border border-base-300/70" placeholder="docker compose up -d --wait" />
            <p class="text-xs opacity-60">Commands that start your API. Leave it empty when it already runs somewhere CI can reach.</p>
          </div>

          <div class="ci-card space-y-2.5">
            <label class="flex items-center gap-3 text-sm"><span class="flex-1">Try a failed request again</span><input v-model.number="setup.retries" type="number" min="0" max="10" class="input input-sm w-20" /><span class="w-10 text-xs opacity-60">times</span></label>
            <label class="flex items-center gap-3 text-sm"><span class="flex-1">Keep an HTML report with each run</span><input v-model="setup.report" type="checkbox" class="toggle toggle-sm" /></label>
            <label v-if="setup.provider === 'github'" class="flex items-center gap-3 text-sm"><span class="flex flex-1 flex-col"><span>Use the DialCatz action</span><span class="text-xs opacity-50">A shorter workflow, with catzoidhub/DialCatz-Action. Off: npx, with nothing between.</span></span><input v-model="setup.action" type="checkbox" class="toggle toggle-sm" /></label>
          </div>

          <div v-if="noRepo" class="ci-card flex items-center gap-3 text-sm">
            <span class="flex-1">This workspace's folder is not in a Git repository yet.</span>
            <button class="btn btn-sm" @click="toGit">Open Git</button>
          </div>
          <div v-else-if="!plan.inRepo" class="ci-card space-y-2 text-sm">
            <p>This workspace is only on this computer. Saving asks for your project and writes the collection there too, as <code class="text-xs break-all">{{ plan.target.path }}</code>. Save again after you change it.</p>
            <label v-if="plan.literals.length" class="flex items-start gap-2 text-warning-content"><input v-model="literals" type="checkbox" class="checkbox checkbox-sm checkbox-warning mt-0.5" /><span class="text-base-content">Credentials are written out in {{ list(plan.literals) }} and would go into the repository. Put them in <code v-pre>{{variables}}</code> instead, or tick to save anyway.</span></label>
          </div>
          <p v-if="problem" class="text-sm text-error">{{ problem }}</p>
          <p v-else-if="empty.length" class="text-sm opacity-70">No value yet: {{ list(empty) }}. Those requests would fail.</p>
        </div>

        <template v-else>
          <p v-if="problem" class="text-sm text-error">{{ problem }}</p>
          <template v-else>
            <div class="flex items-center gap-2"><code class="min-w-0 flex-1 truncate text-xs opacity-70">{{ file }}</code><button class="btn btn-ghost btn-xs gap-1" @click="copy(text, 'Workflow')"><Icon name="copy" class="size-3.5" />Copy</button></div>
            <CodeEditor :model-value="text" language="yaml" readonly class="h-96 min-h-0 rounded-lg border border-base-300/70" />
          </template>
        </template>

        <div v-if="replace" class="ci-card flex items-center gap-3">
          <span class="min-w-0 flex-1 text-sm">Already there with other text: <span class="font-mono text-xs break-all">{{ replace.join(', ') }}</span></span>
          <button class="btn btn-ghost btn-sm" @click="replace = null">Keep</button>
          <button class="btn btn-warning btn-sm" :disabled="busy" @click="save(true)">Replace</button>
        </div>
      </template>

      <div class="modal-action mt-0">
        <button class="btn btn-ghost btn-sm" @click="emit('close')">{{ saved ? 'Close' : 'Cancel' }}</button>
        <button v-if="saved && plan?.inRepo" class="btn btn-sm" @click="toGit">Open Git</button>
        <button v-if="plan && !saved" class="btn btn-primary btn-sm gap-1.5" :disabled="busy || !!problem || noRepo || held || !!replace" @click="save()"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ plan.inRepo ? 'Save' : 'Save to a project…' }}</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>

<style scoped>
.ci-card {
  padding: 0.75rem 1rem;
  border-radius: 0.875rem;
  border: 1px solid oklch(from var(--color-base-content) l c h / 0.08);
  background: oklch(from var(--color-base-content) l c h / 0.025);
}
</style>
