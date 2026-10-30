/**
 * DialCatz — types shared by the main process, the preload bridge and the window.
 *
 * A workspace holds collections (trees of folders and requests) and environments. Personal workspaces live only on
 * this computer; team workspaces come from a DialCatz Den and sync through it (revision numbers, see sync.ts).
 */

import { keyLabel } from './platform';

export type Theme = 'system' | 'light' | 'dark';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** One row of a key / value table (query params, headers, form fields, variables). */
export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
  /** Multipart fields: a file instead of text. */
  type?: 'text' | 'file';
  /** The picked file's path (this computer only: never exported or synced). */
  src?: string;
}

export type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'form' | 'multipart' | 'graphql' | 'binary';
export interface RequestBody {
  mode: BodyMode;
  /** json / text / xml, and the GraphQL query. */
  raw: string;
  /** form (x-www-form-urlencoded) and multipart (text and file fields). */
  fields: KeyValue[];
  /** GraphQL variables (JSON text). */
  variables?: string;
  /** binary: the picked file's path (this computer only). */
  file?: string;
}

export type AuthMode = 'none' | 'inherit' | 'bearer' | 'basic' | 'apikey';
export interface RequestAuth {
  mode: AuthMode;
  token?: string;
  username?: string;
  password?: string;
  /** API key: header or query parameter name, value and where it goes. */
  key?: string;
  value?: string;
  in?: 'header' | 'query';
}

export interface RequestSpec {
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: RequestAuth;
  /** Auto headers switched off for this request (names, see AUTO_HEADERS). */
  autoOff?: string[];
  /** Scripts (JavaScript, run in a sandbox): before the request is built, and after the response (tests). */
  preRequest?: string;
  tests?: string;
}

/** A request as it goes on the wire: variables filled, auth applied, body encoded (shared/request.ts toWire). */
export interface WireRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
  /** multipart/form-data parts; the main process builds the body (and the boundary) and reads the files. */
  multipart?: { name: string; value?: string; file?: string }[];
  /** binary body: a file the main process reads. */
  bodyFile?: string;
}

export type ItemKind = 'collection' | 'folder' | 'request';

/** A node of a collection tree. Collections are the roots (parentId null). */
export interface TreeItem {
  id: string;
  kind: ItemKind;
  parentId: string | null;
  name: string;
  sort: number;
  /** Requests only. */
  request?: RequestSpec;
  /** Collections and folders: auth their requests inherit, and a description. */
  auth?: RequestAuth;
  description?: string;
  /** Collections and folders: scripts run for every request inside, collection first, then folders, then the request's own. */
  preRequest?: string;
  tests?: string;
  /** Collections: skip TLS certificate checks for their requests (a local dev server's own certificate). */
  insecure?: boolean;
  /** Collections: the environment their requests use (null: none); not set: the workspace's default environment. */
  environmentId?: string | null;
  /** Collections: where "Check in DBCatz" looks. This computer only (connections differ per computer): never synced. */
  database?: { conn: string; db: string };
  /** Requests: the table "Check in DBCatz" opens when the guess from the URL is wrong. This computer only. */
  dbTable?: string;
  /** Sync bookkeeping (team workspaces): the server revision this copy is based on, and unsent local changes. */
  rev?: number;
  dirty?: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export interface EnvVariable {
  key: string;
  /** Local value. In team workspaces only names are shared; values stay on this computer. */
  value: string;
  enabled: boolean;
  secret: boolean;
}

/** Values a team member chose to share (team workspaces): stored on the Den, loaded by others on request. */
export interface SharedValues {
  by: string;
  byId: string;
  at: string;
  values: Record<string, string>;
}

export interface Environment {
  id: string;
  name: string;
  variables: EnvVariable[];
  /** Team workspaces only, opt-in: a snapshot of values someone shared. Variable values are otherwise local. */
  shared?: SharedValues;
  rev?: number;
  dirty?: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  /** null = personal (this computer only); else the server connection it syncs with. */
  serverId: string | null;
  /** Team workspaces: the workspace's id on the server. */
  remoteId?: string;
  /** The member's role on a team workspace. */
  role?: Role;
  /** Folder workspaces (git sharing): the folder its collections and environment names live in, as files. */
  folder?: string;
}

/** How this computer shows a workspace's sidebar: personal, never synced to a Den. */
export interface SidebarLayout {
  groups: { id: string; name: string }[];
  /** Collection id → group id. */
  groupOf: Record<string, string>;
  /** Starred collections and requests, in the order starred. */
  favorites: string[];
  collapsed: string[];
  sortBy: 'default' | 'name';
  /** The environment list's own groups, favourites and order (Variables sidebar). */
  env?: EnvLayout;
}
/** How this computer arranges the environment list: groups, favourites, collapsed groups and the dragged order. */
export interface EnvLayout {
  groups: { id: string; name: string }[];
  /** Environment id → group id. */
  groupOf: Record<string, string>;
  favorites: string[];
  collapsed: string[];
  /** Environment ids in the order the user dragged them (others follow in their own order). */
  order: string[];
  sortBy: 'default' | 'name';
}
export const emptyEnvLayout = (): EnvLayout => ({ groups: [], groupOf: {}, favorites: [], collapsed: [], order: [], sortBy: 'default' });
export const emptyLayout = (): SidebarLayout => ({ groups: [], groupOf: {}, favorites: [], collapsed: [], sortBy: 'default', env: emptyEnvLayout() });

export interface Workspace extends WorkspaceSummary {
  items: TreeItem[];
  layout: SidebarLayout;
  environments: Environment[];
  activeEnvironmentId: string | null;
  /** Workspace-wide variables (globals), local only. */
  globals: EnvVariable[];
  /** Team workspaces: the last server revision pulled, ids deleted locally and not yet pushed, last sync result. */
  revision?: number;
  deleted?: string[];
  syncedAt?: string;
  syncError?: string;
  /** Team workspaces: my changes to a folder, collection or environment that a teammate's change won over (TODO #41). */
  conflicts?: SyncConflict[];
  /** Folder workspaces: why the folder could not be read or written (it moved, a file has a mistake …). */
  folderError?: string;
}

/**
 * A change of mine the server turned down because a teammate changed the same folder, collection or environment
 * first (or deleted it). Their version is in the workspace; mine waits here until I keep theirs or use mine.
 */
export interface SyncConflict {
  id: string;
  kind: 'collection' | 'folder' | 'environment';
  name: string;
  /** The teammate and when (from the server's copy). */
  by: string | null;
  at: string | null;
  /** What differs: name, place, auth, notes, settings, variables … ('deleted': they deleted it). */
  fields: string[];
  mine: TreeItem | Environment;
  /** The server's revision of it when the conflict happened (a "use mine" builds on it, also after a delete). */
  rev?: number;
}

export interface ResponseCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: [string, string][];
  /** Body as text (UTF-8) when it looks like text, else '' and `binary` true. */
  body: string;
  binary: boolean;
  /** Binary bodies up to 10 MB, base64 (image / PDF preview, hex view). */
  bodyBase64?: string;
  /** Content type without parameters (e.g. application/json). */
  contentType: string;
  size: number;
  /** Times in ms. */
  timings: { total: number; ttfb: number };
  /** The final URL after redirects. */
  url: string;
  redirected: boolean;
  /** Was the body cut at the size limit. */
  truncated: boolean;
}

export interface SendResult {
  response?: HttpResponse;
  /** A network-level failure (DNS, refused, TLS, timeout, cancelled). */
  error?: string;
  /** The request as actually sent (variables filled in). */
  sent: { method: string; url: string; headers: [string, string][]; body?: string };
}

export interface SendOptions {
  timeoutMs?: number;
  followRedirects?: boolean;
  /** Skip TLS certificate checks (self-signed dev servers). */
  insecure?: boolean;
}

/** Something that happened on a WebSocket tab. `in` / `out` are messages; binary ones as base64 (first 4 KB). */
export interface WsEvent {
  token: string;
  type: 'connecting' | 'open' | 'in' | 'out' | 'error' | 'close';
  at: number;
  data: string;
  binary?: boolean;
  size?: number;
}

export interface HistoryEntry {
  id: string;
  at: string;
  workspaceId: string;
  /** The saved request it came from, if any. */
  itemId: string | null;
  name: string;
  request: RequestSpec;
  status: number | null;
  error?: string;
  timeMs: number;
  size: number;
}

// ------------------------------------------------------------------ team servers

export type Role = 'owner' | 'editor' | 'viewer';

export interface ServerIdentity {
  member: { id: string; name: string; email: string; avatarUrl?: string };
  device: string;
  workspaces: { id: string; name: string; role: Role }[];
}

/** Who has which request open in a team workspace (from the Den's live events). */
export interface PresenceEntry {
  memberId: string;
  name: string;
  device: string;
  itemId: string | null;
  at: number;
}

/** A DialCatz Den this app is connected to. The token is in the system's secret store, never here. */
export interface ServerConnection {
  id: string;
  url: string;
  identity: ServerIdentity | null;
  /** Workspaces of this server shown in the app (subscribed). */
  workspaceIds: string[];
  connectedAt: string;
  lastError?: string;
  /** The member's photo, fetched by the main process and kept as a small data: URL (no remote images in the window). */
  avatar?: string;
}

/** What `dialcatz://connect?server=…&code=…` asks for; shown to the user before anything is sent. */
export interface ConnectRequest {
  server: string;
  code: string;
}

// ------------------------------------------------------------------ settings + AI (shared with all Catzoid apps)

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'deepseek' | 'mistral' | 'xai' | 'groq' | 'openrouter' | 'ollama' | 'openai-compatible';
export interface AiProviderInfo {
  id: AiProvider;
  name: string;
  /** Where its API key is made (empty: no key needed). */
  keyUrl: string;
  baseUrl: string;
  models: string[];
}
/** Kept the same as the other Catzoid apps' list. */
export const AI_PROVIDERS: AiProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { id: 'openai', name: 'OpenAI (GPT)', keyUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'] },
  { id: 'gemini', name: 'Google (Gemini)', keyUrl: 'https://aistudio.google.com/apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'zai', name: 'Z.ai (GLM)', keyUrl: 'https://z.ai/manage-apikey/apikey-list', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-5.3', 'glm-5.2'] },
  { id: 'deepseek', name: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'mistral', name: 'Mistral', keyUrl: 'https://console.mistral.ai/api-keys', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'codestral-latest'] },
  { id: 'xai', name: 'xAI (Grok)', keyUrl: 'https://console.x.ai', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3-mini'] },
  { id: 'groq', name: 'Groq', keyUrl: 'https://console.groq.com/keys', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  { id: 'openrouter', name: 'OpenRouter (many models)', keyUrl: 'https://openrouter.ai/keys', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'] },
  { id: 'ollama', name: 'Ollama (local, offline)', keyUrl: '', baseUrl: 'http://localhost:11434', models: ['qwen2.5-coder', 'llama3.1'] },
  { id: 'openai-compatible', name: 'OpenAI-compatible server', keyUrl: '', baseUrl: 'http://localhost:1234/v1', models: [] },
];
export const aiProvider = (id: AiProvider) => AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];

export type AiFeature = 'ask' | 'explain' | 'tests' | 'body';
/** DialCatz's AI features: each can be switched off in Settings → AI; `sends` says what leaves the computer. */
export const AI_FEATURES: { id: AiFeature; label: string; hint: string; sends: string }[] = [
  { id: 'ask', label: `Ask DialCatz (${keyLabel('mod+K')})`, hint: 'The ✦ button: say what you need in plain words; DialCatz proposes requests and variables you add with a click.', sends: 'collection, folder and request names, methods and URLs, variable names (never their values), the open request without its secrets' },
  { id: 'explain', label: 'Explain a response', hint: 'Why a request failed or what a response means, with what to try next.', sends: 'the request (method, URL, header names; auth and cookies masked) and the response status, headers and the first 12 KB of the body' },
  { id: 'tests', label: 'Write tests', hint: 'A tests script for the request, from its last response.', sends: 'the request and the shape of its last response (first 12 KB)' },
  { id: 'body', label: 'Generate a body', hint: 'A request body (JSON, form fields) from a sentence, e.g. “a new user with an address”.', sends: 'the request (method, URL, current body) and what you asked for' },
];

/** One turn of an AI conversation. */
export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Ask DialCatz: what the model may propose (each step is applied only when the user clicks it). */
export type AskAction =
  /** collectionId: an existing collection's id; collectionName: a collection created in the same answer (by name). */
  | { type: 'createRequest'; name: string; method: HttpMethod; url: string; headers: { key: string; value: string }[]; bodyMode: 'none' | 'json' | 'text' | 'form'; body: string; collectionId: string | null; collectionName?: string }
  | { type: 'openRequest'; itemId: string; name: string }
  | { type: 'setVariable'; key: string; value: string; secret: boolean }
  /** A table in DBCatz (conn "" when DBCatz is not installed: the button offers it). */
  | { type: 'openInDbcatz'; conn: string; connName: string; db: string; table: string; col: string; val: string }
  /** New containers: a collection, a folder in one, an environment with variable names (values only when given). */
  | { type: 'createCollection'; name: string; description: string }
  | { type: 'createFolder'; name: string; collectionId: string | null; collectionName: string }
  | { type: 'createEnvironment'; name: string; variables: { key: string; value: string; secret: boolean }[] }
  /** Collections or environments into a sidebar group (made when missing): existing ids, or names created in this answer. */
  | { type: 'groupItems'; target: 'collections' | 'environments'; group: string; ids: string[]; names: string[] };
export interface AskAnswer {
  reply: string;
  actions: AskAction[];
}
export interface AskContext {
  workspace: string;
  environment: string | null;
  variables: string[];
  collections: { id: string; name: string; requests: { id: string; name: string; method: string; url: string; folder: string }[] }[];
  environments: { id: string; name: string }[];
  /** The sidebar groups of this computer, by name, with what is in them. */
  groups: { collections: { name: string; items: string[] }[]; environments: { name: string; items: string[] }[] };
  open: {
    name: string;
    method: string;
    url: string;
    headers: string[];
    body: string;
    /** "Check in DBCatz": its collection's DBCatz connection and database, and the table its last call touched. */
    database?: { conn: string; db: string } | null;
    table?: { name: string; col?: string; val?: string } | null;
    status?: number | null;
  } | null;
}
export interface ExplainAnswer {
  summary: string;
  cause: string;
  fixes: string[];
}

export interface AiSettings {
  /** DialCatz's own switch (not shared). */
  enabled: boolean;
  /** Features switched off (DialCatz's own; each is on while AI is on). */
  off: AiFeature[];
  provider: AiProvider;
  models: Partial<Record<AiProvider, string>>;
  baseUrls: Partial<Record<AiProvider, string>>;
  /** Providers with a key in the shared secret store (names only; keys never reach the window). */
  keys: AiProvider[];
}

export interface RequestDefaults {
  timeoutMs: number;
  followRedirects: boolean;
  insecure: boolean;
  /** Which auto headers new requests start with (name → on). */
  autoHeaders: Record<string, boolean>;
}

export interface DialCatzSettings {
  theme: Theme;
  ai: AiSettings;
  requests: RequestDefaults;
}
export type DialCatzSettingsPatch = { theme?: Theme; ai?: Partial<Omit<AiSettings, 'keys'>>; requests?: Partial<RequestDefaults> };

/** A local site DevCatz runs (read from DevCatz). */
/** One app of a DevCatz site (a monorepo has several: web, api …), from DevCatz's bridge.json. */
export interface DevCatzApp {
  dir: string;
  name: string;
  framework: string;
  kind: 'web' | 'api' | 'assets';
  url: string | null;
}
/** An OpenAPI document DevCatz found for a site: a file in the project, or a URL a running app serves. */
export interface DevCatzOpenApi {
  app: string;
  file?: string;
  url?: string;
}
export interface DevCatzSite {
  id: string;
  name: string;
  domain: string;
  path: string;
  /** The site's repository already holds a DialCatz workspace (`<path>/dialcatz/dialcatz.yml`, git sharing). */
  workspace?: boolean;
  url: string;
  framework: 'laravel' | 'nestjs' | 'node' | 'web' | 'go' | 'python' | 'other';
  hasEnv: boolean;
  running: boolean;
  /** From bridge.json (empty with an older DevCatz). */
  apps: DevCatzApp[];
  openapi: DevCatzOpenApi[];
}

/**
 * What Postman has, to pick from before moving: one group per Postman workspace (an export is one group). Ids are
 * Postman's uids with an API key, positions in the export otherwise. `token` names the export read in the main process.
 */
export interface PostmanChoice {
  token: string;
  groups: { name: string; collections: { id: string; name: string; requests?: number }[]; environments: { id: string; name: string }[] }[];
  /** Whether there are globals to bring (with an API key: unknown until read, so true). */
  globals: boolean;
  skipped: string[];
}
/** What to bring over from a PostmanChoice. */
export interface PostmanPick {
  collections: string[];
  environments: string[];
  globals: boolean;
}

// ------------------------------------------------------------------ Git section (ported from DevCatz)

export type GitHostKind = 'github' | 'gitlab' | 'gitea' | 'bitbucket';

/** A connected hosting account, shared with the Catzoid apps (its token is in the Keychain item "Catzoid Git"). */
export interface GitAccount {
  id: string;
  kind: GitHostKind;
  /** Web URL: https://github.com, https://gitlab.example.com … */
  baseUrl: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  addedAt: string;
}

export interface GitRepo {
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  defaultBranch: string | null;
  cloneHttps: string;
  cloneSsh: string | null;
  webUrl: string;
  updatedAt: string | null;
}

export interface GitSummary {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed, added, deleted and untracked files. */
  changed: number;
  conflicts: number;
  /** A merge / rebase / cherry-pick / revert waiting to be finished. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
}

export interface GitFile {
  path: string;
  /** Renamed / copied from. */
  from: string | null;
  /** Porcelain codes: index (staged) and worktree letters (M A D R C U ? .). */
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
}

export interface GitRemote {
  name: string;
  url: string;
  /** Parsed host / owner / repo and the matching connected account, if any. */
  host: string | null;
  owner: string | null;
  repo: string | null;
  webUrl: string | null;
  accountId: string | null;
  kind: GitHostKind | null;
}

export interface GitStatus extends GitSummary {
  root: string;
  head: string | null;
  files: GitFile[];
  remotes: GitRemote[];
  stashes: number;
  /** Commit author identity (git config user.name / user.email). */
  identity: { name: string | null; email: string | null };
  last: GitCommit | null;
}

export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string[];
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  sha: string;
  subject: string;
  date: string;
}

export interface GitStash {
  ref: string;
  message: string;
  date: string;
}

export interface GitTag {
  name: string;
  sha: string;
  date: string;
  subject: string;
}

/** An open pull / merge request of the site's repository. */
export interface GitPull {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  head: string;
  base: string;
  url: string;
  updatedAt: string;
  /** CI result of the head commit (GitHub check runs, GitLab pipeline …), null = none / unknown. */
  checks: 'success' | 'failure' | 'pending' | null;
  /** Review / merge state as the host words it (approved, changes requested, mergeable …). */
  review: string | null;
}

export interface GitSshKey {
  path: string;
  type: string;
  comment: string;
  fingerprint: string;
  publicKey: string;
}

/** A clone in progress (Git → Clone). */
export interface GitCloneTask {
  url: string;
  dest: string;
  /** Last output lines (progress lines replace each other). */
  lines: string[];
  done: boolean;
  error: string | null;
}

/** A repository in the Git section: a folder workspace's, one the user added, or one cloned here. */
export interface GitRepoEntry {
  id: string;
  name: string;
  path: string;
  /** Added by the user (or cloned here); a folder workspace's repository is listed without that. */
  added: boolean;
  /** Folder workspaces inside it. */
  workspaces: { id: string; name: string }[];
  /** A DialCatz workspace folder in it (its root, or dialcatz/), opened or not. */
  workspaceFolder: string | null;
  /** null: not a Git repository (yet). */
  summary: GitSummary | null;
  /** A long operation running (fetch, pull, push …). */
  busy: string | null;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  locked: boolean;
  prunable: boolean;
  /** Commits that would be lost with it. */
  unpushed: number;
}

export interface GitState {
  /** `git --version`, null when git is missing (Xcode Command Line Tools not installed). */
  version: string | null;
  accounts: GitAccount[];
  clone: GitCloneTask | null;
  /** Default folder new clones go into (the folder most repositories live in). */
  cloneDir: string;
  repos: GitRepoEntry[];
}

export type GitSyncAction = 'fetch' | 'pull' | 'pull-rebase' | 'push' | 'push-force';


/** A changed file in a folder workspace (its path inside the folder, and the item it is). */
export interface FolderGitChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict';
  label: string;
}
/** Git state of a folder workspace's folder. */
export interface FolderGitStatus {
  repo: boolean;
  gitMissing?: boolean;
  root?: string;
  branch?: string;
  upstream?: string | null;
  hasRemote?: boolean;
  /** origin's URL. */
  remoteUrl?: string;
  ahead: number;
  behind: number;
  changes: FolderGitChange[];
  conflicts: string[];
  merging: boolean;
  /** The last fetch's trouble, said plainly. */
  error?: string;
}

/** Export files: DialCatz's own format, or Postman's (for people who open them in Postman). */
export type ExportFormat = 'dialcatz' | 'postman';

/** A connection DBCatz shares in its bridge.json (no passwords): a saved one, or a DevCatz service (svc:<id>). */
export interface DbCatzConnection {
  id: string;
  name: string;
  engine: 'mysql' | 'mariadb' | 'postgres' | 'sqlite' | 'redis' | 'valkey' | 'mongodb' | 'elasticsearch';
  host: string | null;
  port: number | null;
  database: string | null;
  source: 'saved' | 'devcatz';
}
/** What "Check in DBCatz" opens: a connection's database and table, optionally one row (col = val). */
export interface DbCatzTarget {
  conn: string;
  db: string;
  table?: string;
  col?: string;
  val?: string;
}

/** What a Postman migration found (and imported). */
export interface PostmanSummary {
  collections: { name: string; requests: number }[];
  environments: string[];
  globals: number;
  skipped: string[];
}

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  dataDir: string;
  /** The Catzoid site address shared by the Catzoid apps (links in Settings → About). */
  site: string;
  /** Settings → About's details. */
  arch: string;
  os: string;
  electron: string;
  chrome: string;
  node: string;
}

// ------------------------------------------------------------------ updates, uninstall, reports (Catzoid #54 / #55 / #65)

export type UpdateChannel = 'stable' | 'beta';
export interface UpdatePrefs {
  /** Check 30 s after launch and every 6 hours. */
  auto: boolean;
  channel: UpdateChannel;
  /** A notification once per new version. */
  notify: boolean;
  /** "Skip this version". */
  skipped: string | null;
  lastChecked: number | null;
}
/** One version's notes from the Catzoid site (`/api/dialcatz/releases`). */
export interface ReleaseNote {
  version: string;
  date: string;
  notes: string;
}
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking'; manual: boolean }
  | { kind: 'none'; version: string; manual: boolean }
  | { kind: 'available'; version: string; current: string; size: number | null; notes: ReleaseNote[] }
  | { kind: 'downloading'; version: string; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: 'verifying'; version: string }
  | { kind: 'downloaded'; version: string; onQuit: boolean }
  /** download: the site's page for this computer's build; none when there is no build for it. */
  | { kind: 'error'; message: string; manual: boolean; download?: string };

/** What Uninstall DialCatz removes (shown before anything goes). */
export interface UninstallPlan {
  items: { label: string; detail: string }[];
  /** Other Catzoid apps on this Mac (then the shared settings and AI key stay unless the user says otherwise). */
  otherApps: string[];
  /** Installed with Homebrew: the cask command to run too. */
  brew: string | null;
  /** Running from a build folder (not an installed app): nothing is moved to the Trash. */
  dev: boolean;
}

export type ReportKind = 'bug' | 'idea' | 'question';
export interface ReportDraft {
  kind: ReportKind;
  message: string;
  email?: string;
  /** Screenshots on a bug report (Catzoid #67), sent as multipart `image` parts next to the JSON. */
  shots?: ReportShot[];
  /** For Preview what is sent: how many screenshots would go (their bytes are not needed for that). */
  shotCount?: number;
}
/** A screenshot attached to a bug report (Catzoid #67): PNG or JPEG, base64, already re-encoded in the window. */
export interface ReportShot {
  type: 'image/png' | 'image/jpeg';
  data: string;
}
export interface ReportPrefs {
  /** Send crash and error reports (off until the user turns it on). */
  crashReports: boolean;
  /** Asked once after the first error while crash reports were off. */
  askCrash: boolean;
}

// ------------------------------------------------------------------ IPC surface

export interface DialCatzApi {
  appInfo(): Promise<AppInfo>;
  settings(): Promise<DialCatzSettings>;
  setSettings(patch: DialCatzSettingsPatch): Promise<DialCatzSettings>;
  /** Stores (or with '' removes) a provider's API key in the shared secret store. */
  setAiKey(provider: AiProvider, key: string): Promise<DialCatzSettings>;

  workspaces(): Promise<WorkspaceSummary[]>;
  workspace(id: string): Promise<Workspace>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: string, name: string): Promise<Workspace>;
  deleteWorkspace(id: string): Promise<void>;
  /** Folder workspaces (git sharing): picks a folder and opens it as a workspace (a new one when it is empty). Null: cancelled. */
  openFolderWorkspace(): Promise<Workspace | null>;
  /** Moves a personal workspace into a folder the user picks: its collections and environment names are written there. */
  useFolder(workspaceId: string): Promise<Workspace | null>;
  /** Stops writing to the folder; its files stay. */
  stopUsingFolder(workspaceId: string): Promise<Workspace>;
  /** Shows the workspace's folder in Finder / Explorer. */
  revealFolder(workspaceId: string): Promise<void>;
  /** Git for a folder workspace (phase 2): its folder's status (fetch: ask the remote first). */
  folderGitStatus(workspaceId: string, fetch?: boolean): Promise<FolderGitStatus>;
  folderGitDiff(workspaceId: string, path: string): Promise<string>;
  /** Commits this workspace's files only (never the rest of the repository). */
  folderGitCommit(workspaceId: string, message: string): Promise<FolderGitStatus>;
  folderGitPull(workspaceId: string): Promise<{ status: FolderGitStatus; merged: boolean; conflicts: boolean }>;
  folderGitPush(workspaceId: string): Promise<FolderGitStatus>;
  folderGitInit(workspaceId: string): Promise<FolderGitStatus>;
  folderGitAbortMerge(workspaceId: string): Promise<FolderGitStatus>;
  // ---- Git section (ported from DevCatz; accounts shared with the Catzoid apps). `id` is a repository's id (GitRepoEntry).
  gitState(): Promise<GitState>;
  /** The Git section is on screen (summaries every 20 s) or not. */
  gitWatch(on: boolean): Promise<GitState>;
  /** Adds a folder the user picks (a repository, or one to start Git in); its id, or null when cancelled. */
  gitRepoAdd(): Promise<string | null>;
  /** Takes a repository off the list (its files stay). */
  gitRepoRemove(id: string): Promise<void>;
  /** Output of the repository's fetch / pull / push (newest last). */
  gitRepoLog(id: string): Promise<string[]>;
  gitRevealRepo(id: string): Promise<void>;
  /** Opens (or starts) the DialCatz workspace in the repository: its root or dialcatz/ folder. Returns the workspace id. */
  gitOpenWorkspace(id: string): Promise<string>;
  /** A folder picker for clones (null = cancelled). */
  gitPickFolder(start: string): Promise<string | null>;
  gitStatus(id: string): Promise<GitStatus | null>;
  gitInit(id: string): Promise<void>;
  gitDiff(id: string, file: string, staged: boolean): Promise<string>;
  gitStage(id: string, files: string[]): Promise<void>;
  gitUnstage(id: string, files: string[]): Promise<void>;
  /** Throws away worktree changes of these files after asking (untracked files are deleted). */
  gitDiscard(id: string, files: string[]): Promise<void>;
  gitCommit(id: string, message: string, amend: boolean): Promise<void>;
  /** fetch / pull / push (output in the repository's log, cancellable). */
  gitSync(id: string, action: GitSyncAction): Promise<void>;
  gitCancel(id: string): Promise<void>;
  /** History of the current branch, or of `ref` (another branch, for cherry-picking). */
  gitLog(id: string, search: string, skip: number, ref?: string): Promise<GitCommit[]>;
  gitShow(id: string, sha: string): Promise<string>;
  gitBranches(id: string): Promise<GitBranch[]>;
  gitBranch(id: string, action: 'create' | 'switch' | 'delete' | 'force-delete' | 'merge', name: string, from?: string): Promise<void>;
  gitStashes(id: string): Promise<GitStash[]>;
  gitStash(id: string, action: 'save' | 'apply' | 'pop' | 'drop', arg: string): Promise<void>;
  gitTags(id: string): Promise<GitTag[]>;
  gitTag(id: string, action: 'create' | 'delete' | 'push', name: string, message?: string): Promise<void>;
  /** Rebase onto a branch, or continue / skip / abort the merge, rebase or cherry-pick in progress. */
  gitOperation(id: string, action: 'rebase' | 'continue' | 'skip' | 'abort', onto?: string): Promise<void>;
  /** Squashes the branch's commits since it left `onto` into one. */
  gitSquash(id: string, onto: string, message: string): Promise<void>;
  gitCherryPick(id: string, sha: string): Promise<void>;
  gitRevert(id: string, sha: string): Promise<void>;
  gitReset(id: string, mode: 'soft' | 'mixed' | 'hard', sha: string): Promise<void>;
  /** Puts one file back to how it was in a commit (staged). */
  gitRestoreFile(id: string, file: string, sha: string): Promise<void>;
  gitOpenFile(id: string, file: string): Promise<void>;
  gitIgnoreSuggestions(id: string): Promise<string[]>;
  gitIgnoreAdd(id: string, lines: string[]): Promise<void>;
  gitignoreRead(id: string): Promise<{ exists: boolean; content: string; suggested: string }>;
  gitignoreSave(id: string, content: string): Promise<void>;
  gitSetIdentity(id: string, name: string, email: string, global: boolean): Promise<void>;
  gitAddRemote(id: string, name: string, url: string): Promise<void>;
  gitWorktrees(id: string): Promise<GitWorktree[]>;
  /** Adds a worktree in a folder the user picks: a new branch (from `from`) or an existing one. Returns its folder, or null when cancelled. */
  gitWorktreeAdd(id: string, branch: string, create: boolean, from?: string): Promise<string | null>;
  gitWorktreeRemove(id: string, path: string, force: boolean): Promise<void>;
  gitWorktreePrune(id: string): Promise<void>;
  gitPulls(id: string): Promise<GitPull[]>;
  gitCreatePull(id: string, title: string, body: string, base: string, draft: boolean): Promise<GitPull>;
  gitCheckoutPull(id: string, pull: GitPull): Promise<void>;
  gitAddAccount(kind: GitHostKind, baseUrl: string, token: string, username: string): Promise<GitAccount>;
  gitRemoveAccount(accountId: string): Promise<void>;
  gitRepos(accountId: string, search: string): Promise<GitRepo[]>;
  gitSshKeys(): Promise<GitSshKey[]>;
  gitSshGenerate(email: string): Promise<GitSshKey>;
  gitSshAddToAccount(accountId: string, keyPath: string, title: string): Promise<void>;
  /** Clones into `parent/name` and adds it to the list; resolves with the folder. */
  gitClone(url: string, parent: string, name: string, branch: string, shallow: boolean): Promise<string>;
  gitCancelClone(): Promise<void>;
  gitDismissClone(): Promise<void>;
  /** The connected (shared) accounts, without polling repositories. */
  gitAccounts(): Promise<GitAccount[]>;
  /** A new empty repository on the account. */
  gitCreateRemoteRepo(accountId: string, name: string, priv: boolean, description: string): Promise<GitRepo>;
  /** Accounts connected in DevCatz that are not shared yet (no tokens). */
  gitDevCatzAccounts(): Promise<GitAccount[]>;
  /** Brings them over (macOS asks to let DialCatz read DevCatz's key); how many came. */
  gitImportDevCatz(): Promise<number>;
  /** Connects a folder workspace's repository to a remote (origin) and fetches it. */
  folderGitConnect(workspaceId: string, url: string): Promise<{ status: FolderGitStatus; merged: boolean; conflicts: boolean }>;
  /** A new workspace kept in a folder (`parent/folderName`); the folder is made when missing. */
  createFolderWorkspace(name: string, parent: string, folderName: string): Promise<Workspace>;
  /** A team workspace's DialCatz Den admin panel (Workspaces page): deleting one happens there. */
  teamAdminUrl(workspaceId: string): Promise<string>;
  /** A folder picker (null = cancelled). */
  pickFolder(title: string, start: string): Promise<string | null>;
  /** Adds or replaces items (by id). */
  saveItems(workspaceId: string, items: TreeItem[]): Promise<Workspace>;
  /** Removes items and everything under them. */
  deleteItems(workspaceId: string, ids: string[]): Promise<Workspace>;
  saveEnvironment(workspaceId: string, env: Environment): Promise<Workspace>;
  deleteEnvironment(workspaceId: string, envId: string): Promise<Workspace>;
  setActiveEnvironment(workspaceId: string, envId: string | null): Promise<Workspace>;
  saveGlobals(workspaceId: string, globals: EnvVariable[]): Promise<Workspace>;
  /** Groups, favourites and sort order of the sidebar (this computer only). */
  saveLayout(workspaceId: string, layout: SidebarLayout): Promise<Workspace>;
  /** Imports a Postman v2 collection, an OpenAPI 3 document or a DialCatz export (JSON / YAML text) as a collection. */
  importText(workspaceId: string, text: string): Promise<{ workspace: Workspace; collectionId: string; count: number }>;
  /** Picks a file and imports it like importText (null: cancelled). */
  /**
   * Picks files: one collection file goes straight in (`collection`); an export zip, several files or an environment
   * file come back as a list to pick from (`choice`, then migratePostman with its token). Null when cancelled.
   */
  importFile(workspaceId: string): Promise<{ kind: 'collection'; workspace: Workspace; collectionId: string; count: number } | { kind: 'choice'; choice: PostmanChoice } | null>;
  /** Copies a collection into another workspace: a new copy (named), or replacing / merging into one of the same name. */
  copyCollection(fromWorkspaceId: string, collectionId: string, toWorkspaceId: string, mode: 'new' | 'replace' | 'merge', name: string): Promise<{ workspace: Workspace; collectionId: string }>;
  /** DevCatz: its local sites; an environment and / or a collection of routes for one of them. */
  devcatzSites(): Promise<{ installed: boolean; sites: DevCatzSite[] }>;
  /**
   * The DialCatz workspace kept in a DevCatz site's repository (`<site folder>/dialcatz`, a folder workspace for Git):
   * opened, or made when `create` (named after the site). Null when there is none and `create` is false.
   */
  devcatzWorkspace(siteId: string, create: boolean): Promise<Workspace | null>;
  devcatzImport(workspaceId: string, siteId: string, what: { environment: boolean; envVars: boolean; routes: boolean; app?: string }): Promise<{ workspace: Workspace; collectionId: string | null; requests: number; source: string | null }>;
  /** Postman: pick its data export (zip), a folder or JSON files and read what is in it (null when cancelled). */
  postmanReadExport(how: 'files' | 'folder'): Promise<PostmanChoice | null>;
  /** Brings the picked collections, environments and globals of the export read last into the workspace. */
  migratePostman(workspaceId: string, token: string, pick: PostmanPick): Promise<{ workspace: Workspace; summary: PostmanSummary }>;
  /** Postman with an API key (no export): whose key it is and the workspaces it sees. The key is not stored. */
  postmanWorkspaces(key: string): Promise<{ user: string; workspaces: { id: string; name: string; type: string }[] }>;
  /** The collections and environments in the chosen Postman workspaces (names only), to pick from. */
  postmanContents(key: string, postmanWorkspaceIds: string[]): Promise<PostmanChoice>;
  /** Moves the picked collections, environments (and globals) of those workspaces here (progress on onPostmanProgress). */
  migratePostmanApi(workspaceId: string, key: string, postmanWorkspaceIds: string[], pick: PostmanPick): Promise<{ workspace: Workspace; summary: PostmanSummary }>;
  /** Saves a collection as a DialCatz file (`.dialcatz_collection.json`) or a Postman v2.1 collection (false: cancelled). */
  exportCollection(workspaceId: string, collectionId: string, format?: ExportFormat): Promise<boolean>;

  /** Sends a request in its wire form (variables, auth and body already resolved by the window: shared/request.ts). */
  send(wire: WireRequest, token: string, options?: SendOptions): Promise<SendResult>;
  /** AI (Settings → AI): models of a provider, a test call, and DialCatz's features. A token lets a request be stopped. */
  aiModels(provider: AiProvider): Promise<string[]>;
  aiTest(): Promise<string>;
  aiAsk(prompt: string, history: AiTurn[], context: AskContext, token: string): Promise<AskAnswer>;
  aiExplain(wire: { method: string; url: string; headers: [string, string][] }, response: { status: number; statusText: string; headers: [string, string][]; body: string; time: number }, token: string): Promise<ExplainAnswer>;
  aiTests(wire: { method: string; url: string }, response: { status: number; headers: [string, string][]; body: string; time: number }, current: string, token: string): Promise<string>;
  aiBody(request: { method: string; url: string; bodyMode: string; body: string }, instruction: string, token: string): Promise<{ mode: 'json' | 'text' | 'xml' | 'form'; body: string; fields: { key: string; value: string }[] }>;
  aiCancel(token: string): Promise<void>;
  /** Picks a file to send (multipart field or binary body); only picked files can be sent. */
  pickFile(title: string): Promise<string | null>;
  /** The runner's data file (CSV with a header row, or a JSON array): one row per iteration. null: cancelled. */
  pickDataFile(): Promise<{ name: string; rows: Record<string, string>[]; columns: string[] } | null>;
  /** Saves text through a save dialog (runner results). false: cancelled. */
  saveText(suggestedName: string, text: string): Promise<boolean>;
  cancel(token: string): Promise<void>;
  /** WebSocket tabs: connect (handshake headers + subprotocols), send a text message, close. Events: onWs. */
  wsConnect(token: string, url: string, headers: [string, string][], protocols: string[]): Promise<void>;
  wsSend(token: string, data: string): Promise<void>;
  wsClose(token: string): Promise<void>;
  /** Saves the last response body to a file. */
  saveResponse(token: string, suggestedName: string): Promise<boolean>;

  history(): Promise<HistoryEntry[]>;
  addHistory(entry: HistoryEntry): Promise<void>;
  clearHistory(): Promise<void>;

  servers(): Promise<ServerConnection[]>;
  /** Checks a server's health before connecting (address shown to the user first). */
  probeServer(url: string): Promise<{ ok: boolean; name?: string; version?: string; error?: string }>;
  /** Connects with a pasted token (fallback). */
  connectWithToken(url: string, token: string): Promise<ServerConnection>;
  /** Connects with a one-time invite code (from a dialcatz://connect link). */
  connectWithCode(url: string, code: string, device: string): Promise<ServerConnection>;
  refreshServer(id: string): Promise<ServerConnection>;
  disconnectServer(id: string): Promise<void>;
  /** Shows or hides one of a server's workspaces in the app. */
  subscribeWorkspace(serverId: string, workspaceId: string, on: boolean): Promise<ServerConnection>;
  /** Tells the team which request this app has open (team workspaces; null: none). */
  setPresence(workspaceId: string, itemId: string | null): Promise<void>;
  presence(workspaceId: string): Promise<PresenceEntry[]>;
  /** Pull, then push the workspace's local changes. */
  syncWorkspace(workspaceId: string): Promise<Workspace>;
  /** A sync conflict: 'mine' sends my version over theirs, 'theirs' drops the note. */
  resolveConflict(workspaceId: string, itemId: string, keep: 'mine' | 'theirs'): Promise<Workspace>;

  openUrl(url: string): Promise<void>;
  /** Saves an environment as a DialCatz (or Postman) environment file; false when cancelled. */
  exportEnvironment(workspaceId: string, envId: string, options: { values: boolean; secrets: boolean; format: ExportFormat }): Promise<boolean>;
  /**
   * Export all: every collection, environment and the globals of a workspace in one zip, in DialCatz's or Postman's
   * format (Postman's data-export layout). Variable values optional, secret values only when asked; false: cancelled.
   */
  exportWorkspace(workspaceId: string, options: { values: boolean; secrets: boolean; format: ExportFormat }): Promise<{ collections: number; environments: number } | false>;
  /** Picks Postman / DialCatz environment files (or a Postman export zip) and adds their environments; null when cancelled. */
  importEnvironments(workspaceId: string): Promise<{ workspace: Workspace; names: string[]; skipped: string[] } | null>;
  /** DBCatz on this computer, and the connections it shares (with a DBCatz that writes bridge.json). */
  dbcatzInfo(): Promise<{ installed: boolean; bridge: boolean; connections: DbCatzConnection[] }>;
  /** Opens a table in DBCatz (dbcatz://open…). */
  dbcatzOpen(target: DbCatzTarget): Promise<void>;
  /** Remembers where "Check in DBCatz" looks: the collection's database and the request's table (this computer only). */
  saveDbTarget(workspaceId: string, collectionId: string, database: { conn: string; db: string }, requestId: string | null, table: string | null): Promise<Workspace>;
  copyText(text: string): Promise<void>;
  hostName(): Promise<string>;

  updateState(): Promise<UpdateState>;
  updateCheck(): Promise<UpdateState>;
  updateDownload(): Promise<void>;
  updateCancel(): Promise<void>;
  updateInstall(when: 'now' | 'quit'): Promise<void>;
  updateSkip(version: string): Promise<void>;
  updatePrefs(): Promise<UpdatePrefs>;
  setUpdatePrefs(patch: Partial<Pick<UpdatePrefs, 'auto' | 'channel' | 'notify'>>): Promise<UpdatePrefs>;
  uninstallPlan(): Promise<UninstallPlan>;
  uninstall(removeShared: boolean): Promise<void>;
  reportPreview(draft: ReportDraft): Promise<string>;
  reportSend(draft: ReportDraft): Promise<{ queued: boolean }>;
  /** The window as a PNG (base64), for "Capture this window" in Report a Bug (the dialog hides itself first). */
  captureWindow(): Promise<string>;
  reportError(message: string, stack: string): Promise<void>;
  reportPrefs(): Promise<ReportPrefs>;
  setReportPrefs(patch: Partial<ReportPrefs>): Promise<ReportPrefs>;
}

export const API_METHODS = [
  'appInfo', 'settings', 'setSettings', 'setAiKey',
  'workspaces', 'workspace', 'createWorkspace', 'renameWorkspace', 'deleteWorkspace', 'openFolderWorkspace', 'useFolder', 'stopUsingFolder', 'revealFolder', 'folderGitStatus', 'folderGitDiff', 'folderGitCommit', 'folderGitPull', 'folderGitPush', 'folderGitInit', 'folderGitAbortMerge',
  'gitState', 'gitWatch', 'gitRepoAdd', 'gitRepoRemove', 'gitRepoLog', 'gitRevealRepo', 'gitOpenWorkspace', 'gitPickFolder', 'gitStatus', 'gitInit', 'gitDiff', 'gitStage', 'gitUnstage', 'gitDiscard', 'gitCommit', 'gitSync', 'gitCancel', 'gitLog', 'gitShow', 'gitBranches', 'gitBranch', 'gitStashes', 'gitStash', 'gitTags', 'gitTag', 'gitOperation', 'gitSquash', 'gitCherryPick', 'gitRevert', 'gitReset', 'gitRestoreFile', 'gitOpenFile', 'gitIgnoreSuggestions', 'gitIgnoreAdd', 'gitignoreRead', 'gitignoreSave', 'gitSetIdentity', 'gitAddRemote', 'gitWorktrees', 'gitWorktreeAdd', 'gitWorktreeRemove', 'gitWorktreePrune', 'gitPulls', 'gitCreatePull', 'gitCheckoutPull', 'gitAddAccount', 'gitRemoveAccount', 'gitRepos', 'gitSshKeys', 'gitSshGenerate', 'gitSshAddToAccount', 'gitClone', 'gitCancelClone', 'gitDismissClone', 'gitAccounts', 'gitCreateRemoteRepo', 'gitDevCatzAccounts', 'gitImportDevCatz', 'folderGitConnect', 'createFolderWorkspace', 'pickFolder', 'teamAdminUrl',
  'saveItems', 'deleteItems',
  'saveEnvironment', 'deleteEnvironment', 'setActiveEnvironment', 'saveGlobals', 'saveLayout', 'importText', 'importFile', 'copyCollection', 'devcatzSites', 'devcatzWorkspace', 'devcatzImport', 'postmanReadExport', 'migratePostman', 'postmanWorkspaces', 'postmanContents', 'migratePostmanApi', 'exportCollection',
  'aiModels', 'aiTest', 'aiAsk', 'aiExplain', 'aiTests', 'aiBody', 'aiCancel',
  'send', 'pickFile', 'pickDataFile', 'saveText', 'cancel', 'wsConnect', 'wsSend', 'wsClose', 'saveResponse', 'history', 'addHistory', 'clearHistory',
  'servers', 'probeServer', 'connectWithToken', 'connectWithCode', 'refreshServer', 'disconnectServer', 'subscribeWorkspace', 'setPresence', 'presence', 'syncWorkspace', 'resolveConflict',
  'openUrl', 'exportWorkspace', 'exportEnvironment', 'importEnvironments', 'dbcatzInfo', 'dbcatzOpen', 'saveDbTarget', 'copyText', 'hostName',
  'updateState', 'updateCheck', 'updateDownload', 'updateCancel', 'updateInstall', 'updateSkip', 'updatePrefs', 'setUpdatePrefs',
  'uninstallPlan', 'uninstall', 'reportPreview', 'reportSend', 'captureWindow', 'reportError', 'reportPrefs', 'setReportPrefs',
] as const satisfies readonly (keyof DialCatzApi)[];

// ------------------------------------------------------------------ helpers used on both sides

export const emptyBody = (): RequestBody => ({ mode: 'none', raw: '', fields: [] });
export const newRequest = (): RequestSpec => ({ method: 'GET', url: '', params: [], headers: [], body: emptyBody(), auth: { mode: 'inherit' } });

export function uid(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}
