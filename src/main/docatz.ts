import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { uid, type DoCatzProject, type DoCatzService, type EnvVariable, type TreeItem } from '@shared/types';
import { envFileVariables, MAX_SPEC, OPENAPI_PATHS, parseSpec, servedOpenApi } from './devcatz';
import { goravelCommand, laravelTree, parseGoravelRoutes, routesTree } from './routetree';

/**
 * DoCatz → DialCatz (#79). DoCatz runs the user's compose projects on https://<service>.<project>.docatz.<tld> and
 * writes what it runs to bridge.json (schema 1, read-only for us): each container's project, service, state, URL,
 * compose folder and the framework it is built from. A project becomes an environment "DoCatz · <project>" (baseUrl
 * = its API service, <service>Url for each API service) and its routes a collection: Laravel and Goravel through
 * `artisan route:list` inside the container (their tools are there, not on the computer), else an OpenAPI document — a
 * file in the compose folder, then one a service serves. Only API services are listed (built from a framework, or
 * with an OpenAPI file in their own folder): databases, caches, front ends, plain images and background workers are
 * left out, and a project with none is not listed.
 * The project's .env values stay on this computer (environment values never sync).
 */

// DIALCATZ_DOCATZ_DIR points at another DoCatz data folder for tests.
const DATA = process.env.DIALCATZ_DOCATZ_DIR || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'DoCatz') : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DoCatz'));
/** DoCatz's own docker CLI and its context (the engine DoCatz runs, never another Docker on the computer). */
const DOCKER = join(homedir(), '.docatz', 'bin', process.platform === 'win32' ? 'docker.exe' : 'docker');

/** Compose project names, as DoCatz and `docker compose` allow them. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

interface Bridge {
  schema: number;
  engine?: 'running' | 'stopped';
  containers?: { name: string; project: string | null; service: string | null; state: string; url: string | null; inner?: string | null; dir?: string | null; framework?: string | null; library?: string | null }[];
}

function bridge(): Bridge | null {
  try {
    const b = JSON.parse(readFileSync(join(DATA, 'bridge.json'), 'utf8')) as Bridge;
    return b.schema === 1 ? b : null;
  } catch {
    return null;
  }
}

/** Front ends: a service built from one of these is a web page, not the API requests go to. */
const WEB = new Set(['nuxt', 'next', 'astro', 'vite', 'vite-vue', 'vite-react', 'vite-svelte', 'vue', 'react', 'svelte', 'sveltekit', 'remix', 'angular', 'gatsby', 'solid', 'qwik', 'static', 'wordpress', 'drupal', 'joomla', 'electron', 'leptos', 'yew', 'dioxus', 'sycamore', 'perseus']);
const isApi = (framework: string | null, library: string | null) => !!framework && !WEB.has(framework) && !(library && WEB.has(library)) && !(framework === 'node' && !library);

/** The compose file in the folder: the plain names first, then any compose*.yml / docker-compose*.yml (prod, dev …). */
function composeFile(dir: string | null): string | null {
  if (!dir) return null;
  const plain = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((f) => /^(docker-)?compose[\w.-]*\.ya?ml$/i.test(f));
  } catch {
    return null;
  }
  const f = plain.find((n) => names.includes(n)) ?? names.sort()[0];
  return f ? join(dir, f) : null;
}
/** Background workers built from the app's code (scheduler, queue …): never the service requests go to. */
const WORKER = /schedul|queue|worker|cron|horizon|reverb|supervisor/i;
const doCatzEnv = (project: string) => join(DATA, 'env', `${project}.env`);

export function installed(): boolean {
  return existsSync(join(DATA, 'bridge.json'));
}

export function engineRunning(): boolean {
  return bridge()?.engine === 'running';
}

export function projects(): DoCatzProject[] {
  const byName = new Map<string, DoCatzProject>();
  for (const c of bridge()?.containers ?? []) {
    if (!c.project || !PROJECT_NAME.test(c.project) || !c.service || c.inner) continue;
    // Only what has routes to import: an API built from a framework (Laravel, NestJS, Go …), or any service with an
    // OpenAPI file in its own folder (openapi.yaml, swagger.json …). Front ends, plain images (mail, storage, admin
    // tools) and background workers stay in DoCatz.
    if (WORKER.test(c.service) || !(isApi(c.framework ?? null, c.library ?? null) || hasOwnSpec(c.dir ?? null, c.service))) continue;
    let p = byName.get(c.project);
    if (!p) byName.set(c.project, (p = { name: c.project, dir: null, composeFile: null, running: false, hasEnv: false, services: [] }));
    p.dir ??= c.dir ?? null;
    const running = c.state === 'running';
    p.running ||= running;
    const s: DoCatzService = { service: c.service, container: c.name, running, url: c.url ? c.url.replace(/\/+$/, '') : null, framework: c.framework ?? null, library: c.library ?? null, api: true };
    // One container per service (a scaled service lists more): the running one wins.
    const i = p.services.findIndex((x) => x.service === s.service);
    if (i < 0) p.services.push(s);
    else if (!p.services[i].running && running) p.services[i] = s;
  }
  return [...byName.values()]
    .map((p) => ({ ...p, composeFile: composeFile(p.dir), hasEnv: existsSync(doCatzEnv(p.name)) || (!!p.dir && existsSync(join(p.dir, '.env'))), services: p.services.sort((a, b) => a.service.localeCompare(b.service)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function project(name: string): DoCatzProject {
  const p = PROJECT_NAME.test(name) ? projects().find((x) => x.name === name) : undefined;
  if (!p) throw new Error(`DoCatz does not have a project called ${name} any more`);
  return p;
}

/** The service requests go to: the one asked for, else an API service with an address, else the first with one. */
export function pickService(p: DoCatzProject, name?: string): DoCatzService | null {
  return (name ? p.services.find((s) => s.service === name) : undefined) ?? p.services.find((s) => s.api && s.url) ?? p.services.find((s) => s.url) ?? p.services.find((s) => s.api) ?? p.services[0] ?? null;
}

/** `my-api` → myApiUrl. */
export const serviceVar = (service: string) => `${service.replace(/[^A-Za-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))}Url`;

/** baseUrl and <service>Url for every service with an address. */
export function urlVariables(p: DoCatzProject, service?: string): EnvVariable[] {
  const base = pickService(p, service)?.url;
  const out: EnvVariable[] = base ? [{ key: 'baseUrl', value: base, enabled: true, secret: false }] : [];
  for (const s of p.services) if (s.url && !out.some((v) => v.key === serviceVar(s.service))) out.push({ key: serviceVar(s.service), value: s.url, enabled: true, secret: false });
  return out;
}

/** The project's .env: DoCatz's own copy for it, else the compose folder's. */
export function envVariables(p: DoCatzProject): EnvVariable[] {
  const own = doCatzEnv(p.name);
  return existsSync(own) ? envFileVariables(own) : p.dir ? envFileVariables(join(p.dir, '.env')) : [];
}

function docker(args: string[], timeout = 90_000): Promise<string> {
  if (!existsSync(DOCKER)) return Promise.reject(new Error(`DoCatz's docker is not at ${DOCKER} — open DoCatz once so it sets itself up`));
  return new Promise((resolve, reject) =>
    execFile(DOCKER, ['--context', 'docatz', ...args], { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).toString().trim().split('\n').slice(-3).join(' '))) : resolve(stdout),
    ),
  );
}

const SPEC_FILES = ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml', 'swagger.yml'];
/** A service's own folders in the compose folder (<service>, apps/<service>, services/<service>) and their docs/. */
const ownFolders = (service: string) => [service, join('apps', service), join('services', service)].flatMap((f) => [f, join(f, 'docs')]);
/** An OpenAPI file in one of the service's own folders (an image DoCatz cannot name, but with routes to import). */
const hasOwnSpec = (dir: string | null, service: string) => !!dir && ownFolders(service).some((f) => SPEC_FILES.some((n) => existsSync(join(dir, f, n))));

/** OpenAPI files lying in the compose folder: the service's own folders first, then the top level and the usual docs
 * folders, then each app of a monorepo (apps/*). */
function fileSpec(dir: string | null, service?: string): { api: NonNullable<ReturnType<typeof parseSpec>>; from: string } | null {
  if (!dir) return null;
  let apps: string[] = [];
  try {
    apps = readdirSync(join(dir, 'apps'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    /* not a monorepo */
  }
  const subs = [...(service ? ownFolders(service) : []), '', 'docs', 'api', 'openapi', 'swagger', ...apps.flatMap((a) => [join('apps', a), join('apps', a, 'docs')])];
  for (const sub of [...new Set(subs)])
    for (const f of SPEC_FILES) {
      const file = join(dir, sub, f);
      try {
        if (!existsSync(file) || statSync(file).size > MAX_SPEC) continue;
        const api = parseSpec(readFileSync(file, 'utf8'));
        if (api) return { api, from: join(sub, f) || basename(file) };
      } catch {
        /* unreadable: try the next one */
      }
    }
  return null;
}

/**
 * Swagger UI behind Basic auth (NestJS often guards /api/docs and its -json): the user and password the project's own
 * .env sets for it (SWAGGER_USER / SWAGGER_PASSWORD, DOCS_…), only sent after the service answers 401.
 */
function docsLogin(p: DoCatzProject): string | undefined {
  const env = new Map(envVariables(p).map((v) => [v.key.toUpperCase(), v.value]));
  for (const pre of ['SWAGGER', 'DOCS', 'API_DOCS', 'OPENAPI']) {
    const user = env.get(`${pre}_USER`) ?? env.get(`${pre}_USERNAME`);
    const pass = env.get(`${pre}_PASSWORD`) ?? env.get(`${pre}_PASS`);
    if (user && pass) return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return undefined;
}

/** A collection of the project's routes: Laravel's route list from inside its container, else an OpenAPI document. */
export async function routes(p: DoCatzProject, service?: string): Promise<{ root: TreeItem; items: TreeItem[]; source: string }> {
  const s = pickService(p, service);
  const name = s && p.services.length > 1 ? `${p.name} · ${s.service}` : p.name;
  const note = `Imported from DoCatz (${s?.url ?? p.name}).`;
  if (s?.framework === 'laravel') {
    if (!s.running) throw new Error(`${s.service} is not running, and its routes are listed inside its container. Start ${p.name} in DoCatz, then import again.`);
    const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name, sort: 0, auth: { mode: 'none' }, description: note };
    const out = await docker(['exec', s.container, 'php', 'artisan', 'route:list', '--json']);
    return { root, items: laravelTree(out, root.id), source: 'artisan route:list' };
  }
  if (s?.library === 'goravel') {
    if (!s.running) throw new Error(`${s.service} is not running, and its routes are listed inside its container. Start ${p.name} in DoCatz, then import again.`);
    // The built program differs per image; one running from source compiles first, which takes a while.
    const [entrypoint, cmd] = (await docker(['inspect', '-f', '{{json .Config.Entrypoint}} {{json .Config.Cmd}}', s.container])).trim().split(' ').map((x) => JSON.parse(x) as string[] | null);
    const command = goravelCommand(entrypoint, cmd);
    const out = await docker(['exec', s.container, ...command], command[0] === 'go' ? 300_000 : 90_000);
    const listed = parseGoravelRoutes(out);
    if (!listed.length) throw new Error(`${s.service} listed no routes through ${command.slice(0, 2).join(' ')} … artisan route:list.`);
    const root: TreeItem = { id: uid('c_'), kind: 'collection', parentId: null, name, sort: 0, auth: { mode: 'none' }, description: note };
    return { root, items: routesTree(listed, root.id), source: 'artisan route:list' };
  }
  const found = fileSpec(p.dir, s?.service) ?? (await servedOpenApi([s?.url, ...p.services.filter((x) => x.api).map((x) => x.url)], `docatz-${p.name}`, docsLogin(p)));
  if (found) return { root: { ...found.api.root, name, description: `${found.api.root.description ?? ''}\n\n${note}`.trim() }, items: found.api.items, source: `OpenAPI (${found.from})` };
  throw new Error(
    p.running
      ? `${p.name} has no OpenAPI document DialCatz could find (none in its compose folder, and ${s?.url ?? 'its services'} serve none at ${OPENAPI_PATHS.slice(0, 3).join(', ')} …).`
      : `${p.name} is not running, and its compose folder has no OpenAPI file. Start it in DoCatz, then import again.`,
  );
}

/**
 * Every API service's routes, one collection each (the "All services" choice). Each collection's requests go to its own
 * service — {{baseUrl}} becomes {{<service>Url}} — so they share the project's one environment. A service whose routes
 * cannot be read (stopped, no OpenAPI document) is left out and named in `skipped`; none at all is an error.
 */
export async function routesAll(p: DoCatzProject): Promise<{ collections: { root: TreeItem; items: TreeItem[]; source: string; service: string }[]; skipped: string[] }> {
  const collections: { root: TreeItem; items: TreeItem[]; source: string; service: string }[] = [];
  const skipped: string[] = [];
  for (const s of p.services) {
    try {
      const r = await routes(p, s.service);
      const to = `{{${serviceVar(s.service)}}}`;
      for (const i of r.items) if (i.request) i.request = { ...i.request, url: i.request.url.split('{{baseUrl}}').join(to) };
      collections.push({ ...r, service: s.service });
    } catch (e) {
      skipped.push(`${s.service}: ${(e as Error).message}`);
    }
  }
  if (!collections.length) throw new Error(skipped.join(' — '));
  return { collections, skipped };
}

/** The DoCatz link that shows the project: its compose file (ready to Up, nothing runs), else DoCatz's window. */
export function link(p: DoCatzProject): string {
  return p.composeFile ? `docatz://compose?path=${encodeURIComponent(p.composeFile)}` : 'docatz://open';
}
