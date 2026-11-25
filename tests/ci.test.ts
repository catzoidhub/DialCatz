import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ciFile, ciLiterals, ciProblem, ciSecretName, ciSlug, ciTested, ciText, ciVariables, type CiSetup, type CiTarget } from '../src/shared/ci';
import { save, plan } from '../src/main/ci';
import { newRequest, type TreeItem, type Workspace } from '../src/shared/types';
import { redactBody, redactHeaders, redactor, secretFields, secretValues } from '../cli/redact';
import { annotations, inert, summary } from '../cli/report-github';
import { html } from '../cli/report-html';

const request = (id: string, parentId: string, over: object): TreeItem => ({ id, kind: 'request', parentId, name: id, sort: 0, request: { ...newRequest(), ...over } }) as TreeItem;
const items: TreeItem[] = [
  { id: 'c', kind: 'collection', parentId: null, name: "Bob's API", sort: 0, auth: { mode: 'bearer', token: '{{clientToken}}' } },
  { id: 'f', kind: 'folder', parentId: 'c', name: 'F', sort: 0, tests: 'dc.test("x", () => {})' },
  request('in', 'f', { url: '{{baseUrl}}/a/{{id}}?x={{$guid}}' }),
  request('login', 'c', { url: '{{baseUrl}}/login', tests: 'dc.variables.set("id", 1)' }),
  request('bare', 'c', { url: '{{my-host}}/', auth: { mode: 'bearer', token: 'literal-token' } }),
];
const setup = (over: Partial<CiSetup> = {}): CiSetup => ({ provider: 'github', push: true, pull: true, schedule: '', branch: 'main', variables: [{ name: 'baseUrl', kind: 'plain', value: 'https://x.test' }, { name: 'clientToken', kind: 'secret', value: '' }, { name: 'my-host', kind: 'plain', value: 'http://h' }], retries: 2, report: true, action: false, prepare: '', ...over });
const target: CiTarget = { slug: 'bob-s-api', title: "Bob's API", path: './api', collection: "Bob's API", spec: '' };

test('what a workflow needs is read from the collection', () => {
  expect(ciVariables(items, 'c')).toEqual(['baseUrl', 'clientToken', 'my-host']);
  expect(ciLiterals(items, 'c')).toEqual(['bare']);
  expect(ciTested(items, 'c')).toEqual({ requests: 3, tested: 2 });
  expect([ciSecretName('clientSecret'), ciSecretName('my-host'), ciSecretName('1x'), ciSecretName('github_token')]).toEqual(['CLIENT_SECRET', 'MY_HOST', 'API_1X', 'API_GITHUB_TOKEN']);
});

test('GitHub: valid YAML, secrets as references, quoted command', () => {
  const y = parse(ciText(target, setup({ schedule: '0 3 * * 1', prepare: 'docker compose up -d\n\nsleep 2' })));
  expect(Object.keys(y.on)).toEqual(['push', 'pull_request', 'schedule', 'workflow_dispatch']);
  expect(y.permissions).toEqual({ contents: 'read' });
  const step = y.jobs.api.steps.find((s: { name?: string }) => s.name === 'Run the API tests');
  expect(step.env).toEqual({ baseUrl: 'https://x.test', clientToken: '${{ secrets.CLIENT_TOKEN }}', DC_MY_HOST: 'http://h' });
  expect(step.run).toContain(`--collection 'Bob'\\''s API'`);
  expect(step.run).toContain('--var my-host="$DC_MY_HOST"');
  expect(step.run).toContain('--retries 2');
  expect(y.jobs.api.steps[1].run).toBe('docker compose up -d\n\nsleep 2\n');
});

test('GitHub: the action instead of npx', () => {
  const y = parse(ciText(target, setup({ action: true })));
  const step = y.jobs.api.steps.find((s: { uses?: string }) => s.uses === 'catzoidhub/DialCatz-Action@v1');
  expect(step.with).toMatchObject({ path: './api', collection: "Bob's API", retries: 2, report: 'dialcatz-report.html', vars: 'my-host=http://h\n' });
  expect(step.env).toEqual({ baseUrl: 'https://x.test', clientToken: '${{ secrets.CLIENT_TOKEN }}' });
});

test('names from an import cannot become expressions or commands', () => {
  const evil = { slug: 'x', title: '${{ x }}', path: './api', collection: "${{ secrets.X }}'; curl evil #", spec: '' };
  const t = ciText(evil, setup({ variables: [{ name: 'v', kind: 'plain', value: '${{ github.token }}"\n' }].map((v) => ({ ...v, kind: 'plain' as const })) }));
  expect(t.replaceAll("${{ '${{' }}", '')).not.toContain('${{');
  expect(parse(t).jobs.api.steps.find((s: { name?: string }) => s.name === 'Run the API tests').run).toContain(`'\\''; curl evil #'`);
  expect(ciProblem(setup({ schedule: 'x\n  evil: 1' }))).not.toBeNull();
  expect(ciProblem(setup({ branch: 'a b' }))).not.toBeNull();
  expect(ciProblem(setup({ branch: 'release/*' }))).toBeNull();
  expect(ciProblem(setup())).toBeNull();
});

test('GitLab: valid YAML, masked variables by the store name, JUnit report', () => {
  const y = parse(ciText(target, setup({ provider: 'gitlab', variables: [...setup().variables, { name: 'cost', kind: 'plain', value: 'a$b' }] })));
  const job = y['dialcatz-bob-s-api'];
  expect(job.variables).toEqual({ baseUrl: 'https://x.test', DC_MY_HOST: 'http://h', cost: 'a$$b' });
  expect(job.script[0]).toContain('export clientToken="$CLIENT_TOKEN"');
  expect(job.artifacts.reports.junit).toBe('dialcatz-results.xml');
});

const tmp = mkdtempSync(join(tmpdir(), 'dc-ci-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const ws = { id: 'w', name: 'W', items, environments: [{ id: 'e', name: 'E', variables: [{ key: 'baseUrl', value: 'https://env.test', enabled: true, secret: false }, { key: 'clientToken', value: 'real-secret', enabled: true, secret: true }] }], activeEnvironmentId: 'e', globals: [] } as unknown as Workspace;

test('a plan never holds a secret value', () => {
  const p = plan(ws, 'c', null);
  expect(p.variables.find((v) => v.name === 'baseUrl')).toEqual({ name: 'baseUrl', kind: 'plain', value: 'https://env.test' });
  expect(JSON.stringify(p)).not.toContain('real-secret');
});

test('saving: the collection next to the workflow, replaced only after asking, other files left alone', () => {
  const root = join(tmp, 'a');
  mkdirSync(root);
  expect(save(ws, 'c', root, setup(), false).files).toEqual([ciFile('github', 'bob-s-api'), 'api-tests/bob-s-api.dialcatz_collection.json']);
  expect(save(ws, 'c', root, setup(), false).exists).toEqual([]);
  expect(save(ws, 'c', root, setup({ retries: 0 }), false).exists).toEqual([ciFile('github', 'bob-s-api')]);
  expect(save(ws, 'c', root, setup({ retries: 0 }), true).files.length).toBe(2);
  writeFileSync(join(root, ciFile('github', 'bob-s-api')), 'name: mine\n');
  expect(() => save(ws, 'c', root, setup(), true)).toThrow('not made by DialCatz');
  // GitLab: an existing .gitlab-ci.yml stays as it is.
  writeFileSync(join(root, '.gitlab-ci.yml'), 'stages: [test]\n');
  expect(save(ws, 'c', root, setup({ provider: 'gitlab' }), false).notes[0]).toContain(ciFile('gitlab', 'bob-s-api'));
  expect(readFileSync(join(root, '.gitlab-ci.yml'), 'utf8')).toBe('stages: [test]\n');
});

test('saving does not follow a link out of the repository', () => {
  if (process.platform === 'win32') return;
  const root = join(tmp, 'b');
  mkdirSync(root);
  mkdirSync(join(tmp, 'elsewhere'));
  symlinkSync(join(tmp, 'elsewhere'), join(root, '.github'));
  expect(() => save(ws, 'c', root, setup(), true)).toThrow('through a link');
});

test('reports hide secrets', () => {
  const hide = redactor(secretValues([['token', 'sup3r/secret'], ['baseUrl', 'https://staging.example.com/v1/long-path-2'], ['name', 'Catherine']]));
  expect(hide('a sup3r/secret sup3r%2Fsecret c3VwM3Ivc2VjcmV0')).toBe('a ••• ••• •••');
  expect(hide('Catherine https://staging.example.com/v1/long-path-2?api_key=1&q=2')).toBe('Catherine https://staging.example.com/v1/long-path-2?api_key=•••&q=2');
  expect(hide('https://u:p@x.test')).toBe('https://•••@x.test');
  expect(redactHeaders([['Authorization', 'Bearer q'], ['Set-Cookie', 'a=b'], ['Accept', '*/*']], hide)).toEqual([['Authorization', '•••'], ['Set-Cookie', '•••'], ['Accept', '*/*']]);
  expect(redactBody('{"password":"x","deep":[{"access_token":"y"}],"n":1}', hide)).not.toMatch(/"x"|"y"/);
  // Cut short: no longer JSON.
  expect(redactBody('{"password":"abc", "a": "1', hide)).not.toContain('abc');
  expect(redactBody('user=a&password=b', hide)).toBe('user=a&password=•••');
  expect(secretFields('{"data":{"token":"abcdefgh1"},"id":"abcdefgh2"}')).toEqual(['abcdefgh1']);
});

test('GitHub and HTML reports: text from servers stays text', () => {
  const runs = [{ collection: 'A|<b>', ms: 5, requests: [{ id: 'r', name: 'x</td>\n::error::e', place: ['A'], method: 'GET', url: 'https://x.test/<script>', status: 500, timeMs: 3, size: 1, outcome: 'failed' as const, error: null, tests: [{ name: 't', pass: false, error: 'a\n::set-env::b' }], logs: ['<img>'], attempts: 3 }] }];
  expect(summary(runs)).not.toMatch(/<b>|<\/td>|\n::/);
  expect(annotations(runs)).toEqual(['::error title=GET x</td>%0A%3A%3Aerror%3A%3Ae::Status 500%0At: a%0A::set-env::b']);
  expect(inert('ok\n::error::x')).not.toContain('\n::');
  const page = html(runs, '9');
  expect(page).not.toMatch(/<script>|<img>/);
  expect(page).toContain('3 tries');
});

test('two collections in one repository each have their own workflow', () => {
  const root = join(tmp, 'two');
  mkdirSync(root);
  const two = { ...ws, items: [...items, { id: 'c2', kind: 'collection', parentId: null, name: '支払い', sort: 1 } as TreeItem] } as Workspace;
  save(two, 'c', root, setup(), false);
  expect(save(two, 'c2', root, setup(), false)).toMatchObject({ exists: [], files: [ciFile('github', 'c2'), 'api-tests/c2.dialcatz_collection.json'] });
  expect(ciSlug('!!', '_')).toBe('collection');
});
