import type { TreeItem } from './types';

/**
 * "Run in CI" (#103): the GitHub Actions workflow or GitLab CI job that runs a collection with the CLI (#101) when the
 * code changes. Only text is made here. A secret is written as a reference to the CI's own store, never its value.
 */

export type CiProvider = 'github' | 'gitlab';
export interface CiVariable {
  name: string;
  /** secret: the CI's secret store. plain: the value stands in the workflow file. */
  kind: 'secret' | 'plain';
  value: string;
}
export interface CiSetup {
  provider: CiProvider;
  push: boolean;
  pull: boolean;
  /** Cron (UTC), '' for none. */
  schedule: string;
  branch: string;
  variables: CiVariable[];
  retries: number;
  /** Keep the HTML report with the run. */
  report: boolean;
  /** GitHub: the catzoidhub/DialCatz-Action step instead of npx. */
  action: boolean;
  /** Shell lines that start the API before the tests. */
  prepare: string;
}
/** What the workflow runs, from the repository's root. */
export interface CiTarget {
  path: string;
  /** Names the workflow's file, job and report: each collection has its own. */
  slug: string;
  title: string;
  collection: string;
  /** The OpenAPI file the responses are checked against, '' for none. */
  spec: string;
}

export const CI_MARK = '# Made by DialCatz (Run in CI).';
/** The CLI's major version: fixes come by themselves, a breaking change does not. */
const CLI = 'dialcatz@1';
export const ciFile = (provider: CiProvider, slug: string): string => (provider === 'github' ? `.github/workflows/dialcatz-${slug}.yml` : `.gitlab/dialcatz-${slug}.gitlab-ci.yml`);
/** A name as a file name; one without Latin letters or digits takes the collection's id. */
export const ciSlug = (name: string, id: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'collection';

export const SECRET_LIKE = /(token|secret|passw|passphrase|pwd|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?key|^key$|_key$|Key$|auth|bearer|jwt|cookie|session|credential|signature)/i;

const under = (items: TreeItem[], collectionId: string): TreeItem[] => {
  const ids = new Set([collectionId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const i of items) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) (ids.add(i.id), (grew = true));
  }
  return items.filter((i) => ids.has(i.id));
};

/** The {{variables}} the collection needs a value for: not {{$dynamic}} ones, not ones its scripts set. */
export function ciVariables(items: TreeItem[], collectionId: string): string[] {
  const all = under(items, collectionId);
  const used = new Set<string>();
  for (const i of all) for (const m of JSON.stringify([i.auth, i.request]).matchAll(/\{\{\s*([^{}\s$][^{}\s]*)\s*\}\}/g)) used.add(m[1]);
  const set = new Set<string>();
  for (const i of all) for (const code of [i.preRequest, i.tests, i.request?.preRequest, i.request?.tests]) for (const m of (code ?? '').matchAll(/\.set\(\s*['"`]([^'"`]+)['"`]/g)) set.add(m[1]);
  return [...used].filter((n) => !set.has(n)).sort((a, b) => a.localeCompare(b));
}

/** Requests whose credentials are written out instead of in a {{variable}}: they would go into the repository. */
export function ciLiterals(items: TreeItem[], collectionId: string): string[] {
  const plain = (v: string | undefined) => !!v?.trim() && !v.includes('{{');
  const out: string[] = [];
  for (const i of under(items, collectionId)) {
    const auths = [i.auth, i.request?.auth];
    if (auths.some((a) => a && (plain(a.token) || plain(a.password) || plain(a.value) || plain(a.oauth2?.clientSecret) || plain(a.oauth2?.password)))) out.push(i.name);
    else if ([...(i.request?.headers ?? []), ...(i.request?.params ?? []), ...(i.request?.body?.fields ?? [])].some((h) => h.enabled && SECRET_LIKE.test(h.key) && plain(h.value))) out.push(i.name);
  }
  return out;
}

/** How many of its requests have a test of their own or from above. Without tests a 500 passes: it is an answer. */
export function ciTested(items: TreeItem[], collectionId: string): { requests: number; tested: number } {
  const all = under(items, collectionId);
  const byId = new Map(all.map((i) => [i.id, i]));
  const reqs = all.filter((i) => i.kind === 'request' && i.request);
  const above = (i: TreeItem) => {
    for (let c = i.parentId ? byId.get(i.parentId) : undefined; c; c = c.parentId ? byId.get(c.parentId) : undefined) if (c.tests?.trim()) return true;
    return false;
  };
  return { requests: reqs.length, tested: reqs.filter((i) => i.request!.tests?.trim() || above(i)).length };
}

/** A variable's name in the CI's store: clientSecret → CLIENT_SECRET. */
export const ciSecretName = (name: string): string => {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'VALUE';
  return /^(\d|GITHUB_|CI_|GITLAB_)/.test(s) ? `API_${s}` : s;
};

const sh = (s: string) => (/^[\w./@:=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** A YAML string that says exactly this. */
const q = (s: string) => [...JSON.stringify(s)].map((c) => ((c.codePointAt(0)! >= 0x7f && c.codePointAt(0)! <= 0x9f) || [0x2028, 0x2029, 0xfeff].includes(c.codePointAt(0)!) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c)).join('');
/** GitHub fills in ${{ … }} before anything else reads the text: a name that holds one stays a name. */
const lit = (s: string) => s.replace(/\$\{\{/g, "${{ '${{' }}");
const block = (text: string, indent: string) => text.replace(/\r/g, '').split('\n').map((l) => (l.trim() ? indent + l : '')).join('\n').replace(/\n+$/, '');

/** An environment variable the CLI reads by itself; another name (a-b, PATH) goes in with --var. */
const direct = (name: string) => /^[A-Za-z_]\w*$/.test(name) && !/^(PATH|HOME|SHELL|USER|PWD|TMPDIR|LANG|IFS|ENV|BASH_ENV|CI|DEBUG)$|^(NODE_|NPM_|npm_|GITHUB_|RUNNER_|ACTIONS_|CI_|GITLAB_|LD_|DYLD_|BASH_|DIALCATZ_)/.test(name);

function unique(vars: CiVariable[]): { v: CiVariable; store: string; env: string }[] {
  const taken = new Set<string>();
  return vars.map((v) => {
    let store = ciSecretName(v.name);
    for (let n = 2; taken.has(store); n++) store = `${ciSecretName(v.name)}_${n}`;
    taken.add(store);
    return { v, store, env: direct(v.name) ? v.name : `DC_${store}` };
  });
}

const command = (t: CiTarget, s: CiSetup, vars: ReturnType<typeof unique>, reporters: string[]) =>
  [
    `npx --yes ${CLI} run ${sh(t.path)}`,
    ...(t.collection ? [`--collection ${sh(t.collection)}`] : []),
    ...(t.spec ? [`--spec ${sh(t.spec)}`] : []),
    ...vars.filter((x) => x.env !== x.v.name).map((x) => `--var ${sh(x.v.name)}="$${x.env}"`),
    ...(s.retries ? [`--retries ${s.retries}`] : []),
    ...reporters.map((r) => `--reporter ${r}`),
  ].join(' \\\n  ');

function github(t: CiTarget, s: CiSetup): string {
  const vars = unique(s.variables);
  const on = [
    ...(s.push ? ['  push:', `    branches: [${q(s.branch || 'main')}]`] : []),
    ...(s.pull ? ['  pull_request:'] : []),
    ...(s.schedule ? ['  schedule:', `    - cron: ${q(s.schedule)}`] : []),
    '  workflow_dispatch:',
  ];
  const env = vars.map((x) => `          ${x.env}: ${x.v.kind === 'secret' ? `\${{ secrets.${x.store} }}` : q(lit(x.v.value))}`);
  const run = s.action
    ? [
        '      - uses: catzoidhub/DialCatz-Action@v1',
        '        with:',
        `          path: ${q(lit(t.path))}`,
        ...(t.collection ? [`          collection: ${q(lit(t.collection))}`] : []),
        ...(t.spec ? [`          spec: ${q(lit(t.spec))}`] : []),
        ...(s.retries ? [`          retries: ${s.retries}`] : []),
        ...(vars.some((x) => x.env !== x.v.name) ? ['          vars: |', ...vars.filter((x) => x.env !== x.v.name).map((x) => `            ${lit(x.v.name)}=${x.v.kind === 'secret' ? `\${{ secrets.${x.store} }}` : lit(x.v.value.replace(/[\r\n]+/g, ' '))}`)] : []),
        ...(s.report ? ['          report: dialcatz-report.html'] : []),
        ...(vars.some((x) => x.env === x.v.name) ? ['        env:', ...env.filter((_, i) => vars[i].env === vars[i].v.name)] : []),
      ]
    : [
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 22',
        '      - name: Run the API tests',
        '        run: |',
        block(lit(command(t, s, vars, ['cli', 'github', ...(s.report ? ['html=dialcatz-report.html'] : [])])), '          '),
        ...(env.length ? ['        env:', ...env] : []),
      ];
  return [
    CI_MARK,
    ...secretNotes(vars, 'the repository on GitHub: Settings → Secrets and variables → Actions'),
    `name: ${q(lit(`API tests: ${t.title}`))}`,
    'on:',
    ...on,
    'permissions:',
    '  contents: read',
    'jobs:',
    '  api:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 20',
    '    steps:',
    '      - uses: actions/checkout@v4',
    ...(s.prepare.trim() ? ['      - name: Start the API', '        run: |', block(s.prepare.trim(), '          ')] : []),
    ...run,
    ...(s.report ? ['      - uses: actions/upload-artifact@v4', '        if: always()', '        with:', `          name: dialcatz-${t.slug}-report`, '          path: dialcatz-report.html', '          if-no-files-found: ignore'] : []),
    '',
  ].join('\n');
}

const secretNotes = (vars: ReturnType<typeof unique>, where: string) => {
  const s = vars.filter((x) => x.v.kind === 'secret');
  return s.length ? [`# Add these in ${where}`, `#   ${s.map((x) => x.store).join(', ')}`] : [];
};

function gitlab(t: CiTarget, s: CiSetup): string {
  const vars = unique(s.variables);
  const rules = [...(s.pull ? ['    - if: $CI_PIPELINE_SOURCE == "merge_request_event"'] : []), ...(s.push ? [`    - if: $CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == ${q(s.branch || 'main')}`] : []), ...(s.schedule ? ['    - if: $CI_PIPELINE_SOURCE == "schedule"'] : []), '    - if: $CI_PIPELINE_SOURCE == "web"'];
  // A variable of the same name is already in the job; another name is read from the store's.
  const env = vars.filter((x) => x.v.kind === 'plain').map((x) => `    ${x.env}: ${q(x.v.value.replace(/\$/g, '$$$$'))}`);
  const copies = vars.filter((x) => x.v.kind === 'secret' && x.env !== x.store).map((x) => `export ${x.env}="$${x.store}"`);
  return [
    CI_MARK,
    ...secretNotes(vars, 'the project on GitLab: Settings → CI/CD → Variables (masked)'),
    ...(s.schedule ? [`# Scheduled runs are set on GitLab: Build → Pipeline schedules, cron ${s.schedule.replace(/[\r\n]/g, ' ')}`] : []),
    `dialcatz-${t.slug}:`,
    '  stage: test',
    '  image: node:22',
    '  timeout: 20 minutes',
    '  rules:',
    ...rules,
    ...(env.length ? ['  variables:', ...env] : []),
    '  script:',
    '    - |',
    block([...(s.prepare.trim() ? [s.prepare.trim()] : []), ...copies, command(t, s, vars, ['cli', 'junit=dialcatz-results.xml', ...(s.report ? ['html=dialcatz-report.html'] : [])])].join('\n'), '      '),
    '  artifacts:',
    '    when: always',
    '    expire_in: 2 weeks',
    '    reports:',
    '      junit: dialcatz-results.xml',
    ...(s.report ? ['    paths:', '      - dialcatz-report.html'] : []),
    '',
  ].join('\n');
}

const CRON = /^[\d*/,A-Za-z-]+( [\d*/,A-Za-z-]+){4}$/;
/** What is wrong with a setup, or null. */
export function ciProblem(s: CiSetup): string | null {
  if (s.schedule && !CRON.test(s.schedule)) return 'The schedule is five cron fields, for example 0 3 * * 1-5';
  if (s.push && !/^[^\s~^:?[\\\u0000-\u001f]+$/.test(s.branch || 'main')) return 'That is not a branch name';
  if (!Number.isInteger(s.retries) || s.retries < 0 || s.retries > 10) return 'Retries: a number from 0 to 10';
  if (s.variables.some((v) => v.kind === 'plain' && /[\r\n]/.test(v.value))) return 'A value must be on one line; keep longer ones as a secret';
  return null;
}

export const ciText = (t: CiTarget, s: CiSetup): string => (s.provider === 'github' ? github(t, s) : gitlab(t, s));
