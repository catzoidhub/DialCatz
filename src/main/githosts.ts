import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitAccount, GitHostKind, GitPull, GitRepo, GitSshKey } from '@shared/types';
import type { GitCreds } from './gitcore';
import { setSharedGitAccounts, setSharedGitToken, sharedGitAccounts, sharedGitToken } from './shared';
import { store } from './store';

/**
 * Hosting accounts (GitHub, GitLab, Gitea / Forgejo, Bitbucket) through their REST APIs with a personal access
 * token — ported from DevCatz. The accounts are shared with the Catzoid apps: connected once in DevCatz or here,
 * they are in both (shared.json "git.accounts", tokens in the Keychain item "Catzoid Git"; see shared.ts). Tokens
 * never leave the main process. Avatars are kept here as small data: URLs (the window only loads its own images).
 */

type StoredAccount = GitAccount;

const accountsOf = (): StoredAccount[] => sharedGitAccounts();
async function decrypt(a: StoredAccount): Promise<string> {
  const t = await sharedGitToken(a.id);
  if (!t) throw new Error(`The token of ${a.username} is not in the Keychain: remove the account and connect it again`);
  return t;
}

function run(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) =>
    execFile(cmd, args, { timeout: opts.timeout ?? 60_000 }, (e, stdout, stderr) =>
      done({ code: e ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (e?.message ?? '')) }),
    ),
  );
}

/** Local avatar copies, by account id: { url (the remote one it came from), data }. */
const avatars = (): Record<string, { url: string; data: string | null }> => store.extra('gitAvatars') ?? {};

export function listAccounts(): GitAccount[] {
  void fillAvatars();
  const local = avatars();
  return accountsOf().map((a) => ({ ...a, avatarUrl: a.avatarUrl && local[a.id]?.url === a.avatarUrl ? local[a.id].data : null }));
}

async function avatarData(url: string | null, a?: StoredAccount): Promise<string | null> {
  if (!url || url.startsWith('data:')) return url;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('githubusercontent.com') || u.hostname.endsWith('gravatar.com')) u.searchParams.set('s', '96');
    // Self-hosted GitLab / Gitea avatars may need the token.
    const sameHost = a && hostOf(a.baseUrl) === u.hostname;
    const res = await fetch(u, { headers: sameHost ? headers(a.kind, a.baseUrl, await decrypt(a), a.username) : {}, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type')?.split(';')[0] ?? 'image/png';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 300_000 ? null : `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

let filling = false;
/** Fetches the avatars not copied yet (once per remote URL; a failed one stays empty). */
async function fillAvatars(): Promise<void> {
  if (filling) return;
  const local = avatars();
  const todo = accountsOf().filter((a) => a.avatarUrl && local[a.id]?.url !== a.avatarUrl);
  if (!todo.length) return;
  filling = true;
  try {
    const next = { ...local };
    for (const a of todo) next[a.id] = { url: a.avatarUrl!, data: await avatarData(a.avatarUrl, a) };
    // Forget the avatars of removed accounts.
    const ids = new Set(accountsOf().map((a) => a.id));
    store.setExtra('gitAvatars', Object.fromEntries(Object.entries(next).filter(([id]) => ids.has(id))));
    onAccountsChange();
  } finally {
    filling = false;
  }
}

/** Set by index.ts: refreshes the window after avatars arrive. */
let onAccountsChange: () => void = () => undefined;
export const setAccountsListener = (fn: () => void) => (onAccountsChange = fn);

const trimUrl = (u: string) => u.trim().replace(/\/+$/, '');
const DEFAULT_URL: Record<GitHostKind, string> = { github: 'https://github.com', gitlab: 'https://gitlab.com', gitea: 'https://codeberg.org', bitbucket: 'https://bitbucket.org' };
const hostOf = (u: string) => new URL(u).hostname.toLowerCase();
const isBitbucketCloud = (base: string) => hostOf(base) === 'bitbucket.org';

function apiBase(kind: GitHostKind, base: string): string {
  if (kind === 'github') return hostOf(base) === 'github.com' ? 'https://api.github.com' : `${base}/api/v3`;
  if (kind === 'gitlab') return `${base}/api/v4`;
  if (kind === 'gitea') return `${base}/api/v1`;
  return isBitbucketCloud(base) ? 'https://api.bitbucket.org/2.0' : `${base}/rest/api/1.0`;
}

function headers(kind: GitHostKind, base: string, token: string, username: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'DialCatz' };
  if (kind === 'github') Object.assign(h, { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
  else if (kind === 'gitlab') h['PRIVATE-TOKEN'] = token;
  else if (kind === 'gitea') h.Authorization = `token ${token}`;
  // Bitbucket Cloud: username + app password / API token (basic); Server / Data Center: HTTP access token.
  else h.Authorization = isBitbucketCloud(base) ? `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` : `Bearer ${token}`;
  return h;
}

async function call<T>(kind: GitHostKind, base: string, token: string, username: string, method: string, path: string, body?: unknown): Promise<T> {
  const url = path.startsWith('http') ? path : `${apiBase(kind, base)}${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...headers(kind, base, token, username), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* text */
  }
  if (!res.ok) {
    const d = data as { message?: string; error?: string | { message?: string }; errors?: { message?: string }[] | Record<string, string[]> };
    const detail =
      d?.message ??
      (typeof d?.error === 'string' ? d.error : d?.error?.message) ??
      (Array.isArray(d?.errors) ? d.errors.map((e) => e.message).join('; ') : d?.errors ? JSON.stringify(d.errors) : '') ??
      '';
    const hint = res.status === 401 ? ' (token wrong or expired)' : res.status === 403 ? ' (the token lacks a scope, or rate limit)' : res.status === 404 ? ' (not found, or the token cannot see it)' : '';
    throw new Error(`${NAME[kind]}: HTTP ${res.status}${hint}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
  }
  return data as T;
}

export const NAME: Record<GitHostKind, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket' };

function account(id: string): StoredAccount {
  const a = accountsOf().find((x) => x.id === id);
  if (!a) throw new Error('Account not found');
  return a;
}
const callAs = async <T>(a: StoredAccount, method: string, path: string, body?: unknown) => call<T>(a.kind, a.baseUrl, await decrypt(a), a.username, method, path, body);

/** Checks the token against the host, then keeps the account. */
export async function addAccount(kind: GitHostKind, baseUrlIn: string, token: string, usernameIn: string): Promise<GitAccount> {
  const baseUrl = trimUrl(baseUrlIn || DEFAULT_URL[kind]);
  if (!/^https?:\/\/[^/]+/.test(baseUrl)) throw new Error('URL: https://host');
  const t = token.trim();
  if (!t) throw new Error('Enter a token');
  let username = usernameIn.trim();
  let name: string | null = null;
  let avatarUrl: string | null = null;
  if (kind === 'github') {
    const u = await call<{ login: string; name: string | null; avatar_url: string }>(kind, baseUrl, t, username, 'GET', '/user');
    [username, name, avatarUrl] = [u.login, u.name, u.avatar_url];
  } else if (kind === 'gitlab') {
    const u = await call<{ username: string; name: string; avatar_url: string | null }>(kind, baseUrl, t, username, 'GET', '/user');
    [username, name, avatarUrl] = [u.username, u.name, u.avatar_url];
  } else if (kind === 'gitea') {
    const u = await call<{ login: string; full_name: string; avatar_url: string }>(kind, baseUrl, t, username, 'GET', '/user');
    [username, name, avatarUrl] = [u.login, u.full_name || null, u.avatar_url];
  } else if (isBitbucketCloud(baseUrl)) {
    if (!username) throw new Error('Bitbucket Cloud: enter your username (or Atlassian email for API tokens)');
    const u = await call<{ username?: string; display_name: string; links?: { avatar?: { href: string } } }>(kind, baseUrl, t, username, 'GET', '/user');
    [name, avatarUrl] = [u.display_name, u.links?.avatar?.href ?? null];
  } else {
    if (!username) throw new Error('Bitbucket Server: enter your username');
    await call(kind, baseUrl, t, username, 'GET', `/users/${encodeURIComponent(username)}`);
  }
  const list = accountsOf().filter((a) => !(a.kind === kind && a.baseUrl === baseUrl && a.username === username));
  // The same account connected again keeps its id (the other apps know it by that).
  const same = accountsOf().find((a) => a.kind === kind && a.baseUrl === baseUrl && a.username === username);
  const acc: StoredAccount = { id: same?.id ?? `${kind}-${Date.now().toString(36)}`, kind, baseUrl, username, name, avatarUrl, addedAt: same?.addedAt ?? new Date().toISOString() };
  await setSharedGitToken(acc.id, t);
  setSharedGitAccounts([...list, acc]);
  const data = await avatarData(avatarUrl);
  if (avatarUrl) store.setExtra('gitAvatars', { ...avatars(), [acc.id]: { url: avatarUrl, data } });
  return listAccounts().find((a) => a.id === acc.id)!;
}

/** Removes the account from every Catzoid app (and its token from the Keychain). */
export async function removeAccount(id: string): Promise<void> {
  setSharedGitAccounts(accountsOf().filter((a) => a.id !== id));
  await setSharedGitToken(id, '').catch(() => undefined);
}

/** The account for a remote's host (first match), and HTTPS credentials for it. */
export function accountFor(host: string | null): GitAccount | null {
  if (!host) return null;
  const h = host.toLowerCase();
  const a = accountsOf().find((x) => {
    const own = hostOf(x.baseUrl);
    return own === h || (x.kind === 'github' && own === 'github.com' && h === 'ssh.github.com') || (x.kind === 'bitbucket' && own === 'bitbucket.org' && h === 'altssh.bitbucket.org');
  });
  return a ?? null;
}

export async function credsFor(host: string | null): Promise<GitCreds | null> {
  const pub = accountFor(host);
  if (!pub) return null;
  const a = account(pub.id);
  const user = a.kind === 'github' ? 'x-access-token' : a.kind === 'gitlab' ? 'oauth2' : a.username;
  const token = await sharedGitToken(a.id);
  return token ? { username: user, token } : null;
}

// ------------------------------------------------------------ repositories

export async function repos(accountId: string, search: string): Promise<GitRepo[]> {
  const a = account(accountId);
  const q = search.trim().toLowerCase();
  const match = (r: GitRepo) => !q || r.fullName.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q);
  if (a.kind === 'github') {
    type R = { full_name: string; name: string; description: string | null; private: boolean; fork: boolean; default_branch: string; clone_url: string; ssh_url: string; html_url: string; pushed_at: string | null };
    const out: GitRepo[] = [];
    for (let page = 1; page <= 3; page++) {
      const list = await callAs<R[]>(a, 'GET', `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      out.push(...list.map((r) => ({ fullName: r.full_name, name: r.name, description: r.description, private: r.private, fork: r.fork, defaultBranch: r.default_branch, cloneHttps: r.clone_url, cloneSsh: r.ssh_url, webUrl: r.html_url, updatedAt: r.pushed_at })));
      if (list.length < 100) break;
    }
    return out.filter(match);
  }
  if (a.kind === 'gitlab') {
    type R = { path_with_namespace: string; name: string; description: string | null; visibility: string; forked_from_project?: unknown; default_branch: string | null; http_url_to_repo: string; ssh_url_to_repo: string; web_url: string; last_activity_at: string };
    const list = await callAs<R[]>(a, 'GET', `/projects?membership=true&per_page=100&order_by=last_activity_at${q ? `&search=${encodeURIComponent(q)}` : ''}`);
    return list.map((r) => ({ fullName: r.path_with_namespace, name: r.name, description: r.description, private: r.visibility !== 'public', fork: Boolean(r.forked_from_project), defaultBranch: r.default_branch, cloneHttps: r.http_url_to_repo, cloneSsh: r.ssh_url_to_repo, webUrl: r.web_url, updatedAt: r.last_activity_at }));
  }
  if (a.kind === 'gitea') {
    type R = { full_name: string; name: string; description: string; private: boolean; fork: boolean; default_branch: string; clone_url: string; ssh_url: string; html_url: string; updated_at: string };
    const r = await callAs<{ data: R[] }>(a, 'GET', `/repos/search?limit=50&sort=updated&order=desc${q ? `&q=${encodeURIComponent(q)}` : ''}&uid=0&private=true`).catch(() => null);
    const list = r?.data ?? (await callAs<R[]>(a, 'GET', '/user/repos?limit=50'));
    return list.map((x) => ({ fullName: x.full_name, name: x.name, description: x.description || null, private: x.private, fork: x.fork, defaultBranch: x.default_branch, cloneHttps: x.clone_url, cloneSsh: x.ssh_url, webUrl: x.html_url, updatedAt: x.updated_at })).filter(match);
  }
  if (isBitbucketCloud(a.baseUrl)) {
    type R = { full_name: string; name: string; description: string; is_private: boolean; parent?: unknown; mainbranch?: { name: string }; links: { clone: { name: string; href: string }[]; html: { href: string } }; updated_on: string };
    const r = await callAs<{ values: R[] }>(a, 'GET', `/repositories?role=member&pagelen=100&sort=-updated_on${q ? `&q=${encodeURIComponent(`name ~ "${q.replace(/"/g, '')}"`)}` : ''}`);
    return r.values.map((x) => ({
      fullName: x.full_name,
      name: x.name,
      description: x.description || null,
      private: x.is_private,
      fork: Boolean(x.parent),
      defaultBranch: x.mainbranch?.name ?? null,
      cloneHttps: (x.links.clone.find((c) => c.name === 'https')?.href ?? '').replace(/^https:\/\/[^@]+@/, 'https://'),
      cloneSsh: x.links.clone.find((c) => c.name === 'ssh')?.href ?? null,
      webUrl: x.links.html.href,
      updatedAt: x.updated_on,
    }));
  }
  type R = { slug: string; name: string; description?: string; public: boolean; project: { key: string }; links: { clone: { name: string; href: string }[]; self: { href: string }[] } };
  const r = await callAs<{ values: R[] }>(a, 'GET', `/repos?limit=100${q ? `&name=${encodeURIComponent(q)}` : ''}`);
  return r.values.map((x) => ({
    fullName: `${x.project.key}/${x.slug}`,
    name: x.name,
    description: x.description ?? null,
    private: !x.public,
    fork: false,
    defaultBranch: null,
    cloneHttps: x.links.clone.find((c) => c.name === 'http')?.href ?? '',
    cloneSsh: x.links.clone.find((c) => c.name === 'ssh')?.href ?? null,
    webUrl: x.links.self[0]?.href ?? '',
    updatedAt: null,
  }));
}

/** A new, empty repository on the account (for a workspace to push to). */
export async function createRepo(accountId: string, nameIn: string, priv: boolean, description: string): Promise<GitRepo> {
  const a = account(accountId);
  const name = nameIn.trim();
  if (!/^[\w.-]+$/.test(name)) throw new Error('Repository name: letters, digits, . _ -');
  const desc = description.trim();
  if (a.kind === 'github' || a.kind === 'gitea') {
    type R = { full_name: string; name: string; description: string | null; private: boolean; default_branch: string | null; clone_url: string; ssh_url: string; html_url: string };
    const r = await callAs<R>(a, 'POST', '/user/repos', { name, private: priv, description: desc, auto_init: false });
    return { fullName: r.full_name, name: r.name, description: r.description || null, private: r.private, fork: false, defaultBranch: null, cloneHttps: r.clone_url, cloneSsh: r.ssh_url, webUrl: r.html_url, updatedAt: new Date().toISOString() };
  }
  if (a.kind === 'gitlab') {
    type R = { path_with_namespace: string; name: string; description: string | null; visibility: string; http_url_to_repo: string; ssh_url_to_repo: string; web_url: string };
    const r = await callAs<R>(a, 'POST', '/projects', { name, path: name, visibility: priv ? 'private' : 'public', description: desc, initialize_with_readme: false });
    return { fullName: r.path_with_namespace, name: r.name, description: r.description, private: r.visibility !== 'public', fork: false, defaultBranch: null, cloneHttps: r.http_url_to_repo, cloneSsh: r.ssh_url_to_repo, webUrl: r.web_url, updatedAt: new Date().toISOString() };
  }
  if (isBitbucketCloud(a.baseUrl)) {
    type R = { full_name: string; name: string; description: string; is_private: boolean; links: { clone: { name: string; href: string }[]; html: { href: string } } };
    const slug = name.toLowerCase();
    const r = await callAs<R>(a, 'POST', `/repositories/${enc(a.username)}/${enc(slug)}`, { scm: 'git', is_private: priv, description: desc });
    return {
      fullName: r.full_name,
      name: r.name,
      description: r.description || null,
      private: r.is_private,
      fork: false,
      defaultBranch: null,
      cloneHttps: (r.links.clone.find((c) => c.name === 'https')?.href ?? '').replace(/^https:\/\/[^@]+@/, 'https://'),
      cloneSsh: r.links.clone.find((c) => c.name === 'ssh')?.href ?? null,
      webUrl: r.links.html.href,
      updatedAt: new Date().toISOString(),
    };
  }
  throw new Error('Create the repository on your Bitbucket Server, then pick it from the list');
}

// ------------------------------------------------------------ accounts connected in DevCatz before the shared ones

/**
 * DevCatz kept its accounts in its own settings until it moves them to the shared store (its token encrypted with
 * Electron's safeStorage key, the Keychain item "DevCatz Safe Storage"). Bringing one over decrypts the token with
 * that key — macOS asks the user to allow DialCatz to read it — and keeps the account's id, so DevCatz's own move
 * later finds it already there.
 */
const devcatzConfig = () =>
  join(process.env.DIALCATZ_DEVCATZ_DIR || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'DevCatz') : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DevCatz')), 'config.json');

type DevCatzAccount = GitAccount & { token: string };
function devcatzStored(): DevCatzAccount[] {
  try {
    const d = JSON.parse(readFileSync(devcatzConfig(), 'utf8')) as { extra?: { gitAccounts?: DevCatzAccount[] } };
    return (d.extra?.gitAccounts ?? []).filter((a) => a?.id && a.kind && a.baseUrl && typeof a.token === 'string');
  } catch {
    return [];
  }
}

/** DevCatz's accounts that are not shared yet (no tokens). */
export function devcatzAccounts(): GitAccount[] {
  const have = new Set(accountsOf().map((a) => `${a.kind} ${a.baseUrl} ${a.username}`));
  return devcatzStored()
    .filter((a) => !have.has(`${a.kind} ${a.baseUrl} ${a.username}`))
    .map(({ token: _t, ...a }) => ({ ...a, avatarUrl: a.avatarUrl && !a.avatarUrl.startsWith('data:') ? a.avatarUrl : null }));
}

/** Chromium's safeStorage on macOS: "v10" + AES-128-CBC, key = PBKDF2-SHA1(Keychain password, "saltysalt", 1003), IV = 16 spaces. */
export function safeStorageDecrypt(blob: Buffer, password: string): string {
  if (blob.subarray(0, 3).toString() !== 'v10') throw new Error('Not a safeStorage value');
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  return Buffer.concat([d.update(blob.subarray(3)), d.final()]).toString('utf8');
}

/** Brings DevCatz's accounts over (tokens checked against the host first); returns how many came. */
export async function importDevCatz(): Promise<number> {
  if (process.platform !== 'darwin') throw new Error('Connect the accounts again here (bringing them over works on macOS)');
  const todo = devcatzStored().filter((a) => devcatzAccounts().some((x) => x.id === a.id));
  if (!todo.length) return 0;
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', 'DevCatz Safe Storage', '-w'], { timeout: 120_000 });
  const password = r.stdout.replace(/\n$/, '');
  if (r.code !== 0 || !password) throw new Error('DialCatz was not allowed to read DevCatz’s key: connect the accounts here with a token instead');
  let n = 0;
  for (const a of todo) {
    const token = safeStorageDecrypt(Buffer.from(a.token, 'base64'), password).trim();
    if (!token) continue;
    const { token: _t, ...pub } = a;
    // Still valid? (A revoked token is left behind.)
    await call(pub.kind, pub.baseUrl, token, pub.username, 'GET', pub.kind === 'bitbucket' && !isBitbucketCloud(pub.baseUrl) ? `/users/${encodeURIComponent(pub.username)}` : '/user').catch(() => {
      throw new Error(`The token of ${pub.username} (${NAME[pub.kind]}) no longer works: connect it again here`);
    });
    await setSharedGitToken(pub.id, token);
    setSharedGitAccounts([...accountsOf().filter((x) => x.id !== pub.id), { ...pub, avatarUrl: pub.avatarUrl?.startsWith('data:') ? null : pub.avatarUrl }]);
    n++;
  }
  return n;
}

// ------------------------------------------------------------ pull / merge requests

const enc = encodeURIComponent;

export async function pulls(accountId: string, owner: string, repo: string): Promise<GitPull[]> {
  const a = account(accountId);
  if (a.kind === 'github') {
    type P = { number: number; title: string; user: { login: string }; draft: boolean; head: { ref: string; sha: string }; base: { ref: string }; html_url: string; updated_at: string };
    const list = await callAs<P[]>(a, 'GET', `/repos/${owner}/${repo}/pulls?state=open&per_page=50`);
    return Promise.all(
      list.map(async (p, i) => {
        let checks: GitPull['checks'] = null;
        let review: string | null = null;
        // Checks and reviews of the first 15 (two calls each).
        if (i < 15) {
          const runs = await callAs<{ check_runs: { status: string; conclusion: string | null }[] }>(a, 'GET', `/repos/${owner}/${repo}/commits/${p.head.sha}/check-runs?per_page=100`).catch(() => null);
          if (runs?.check_runs.length) {
            checks = runs.check_runs.some((r) => r.status !== 'completed') ? 'pending' : runs.check_runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion ?? '')) ? 'failure' : 'success';
          }
          const reviews = await callAs<{ state: string; user: { login: string } }[]>(a, 'GET', `/repos/${owner}/${repo}/pulls/${p.number}/reviews?per_page=100`).catch(() => []);
          const latest = new Map<string, string>();
          for (const r of reviews) if (r.state !== 'COMMENTED') latest.set(r.user.login, r.state);
          const states = [...latest.values()];
          review = states.includes('CHANGES_REQUESTED') ? 'changes requested' : states.includes('APPROVED') ? `approved (${states.filter((s) => s === 'APPROVED').length})` : 'review required';
        }
        return { number: p.number, title: p.title, author: p.user.login, draft: p.draft, head: p.head.ref, base: p.base.ref, url: p.html_url, updatedAt: p.updated_at, checks, review };
      }),
    );
  }
  if (a.kind === 'gitlab') {
    type M = { iid: number; title: string; author: { username: string }; draft?: boolean; work_in_progress?: boolean; source_branch: string; target_branch: string; web_url: string; updated_at: string; detailed_merge_status?: string; head_pipeline?: { status: string } | null };
    const list = await callAs<M[]>(a, 'GET', `/projects/${enc(`${owner}/${repo}`)}/merge_requests?state=opened&per_page=50`);
    const pipe = (s?: string): GitPull['checks'] => (!s ? null : s === 'success' ? 'success' : ['failed', 'canceled'].includes(s) ? 'failure' : 'pending');
    return list.map((m) => ({
      number: m.iid,
      title: m.title,
      author: m.author.username,
      draft: Boolean(m.draft ?? m.work_in_progress),
      head: m.source_branch,
      base: m.target_branch,
      url: m.web_url,
      updatedAt: m.updated_at,
      checks: pipe(m.head_pipeline?.status),
      review: m.detailed_merge_status?.replace(/_/g, ' ') ?? null,
    }));
  }
  if (a.kind === 'gitea') {
    type P = { number: number; title: string; user: { login: string }; draft?: boolean; head: { ref: string }; base: { ref: string }; html_url: string; updated_at: string; mergeable: boolean };
    const list = await callAs<P[]>(a, 'GET', `/repos/${owner}/${repo}/pulls?state=open&limit=50`);
    return list.map((p) => ({ number: p.number, title: p.title, author: p.user.login, draft: Boolean(p.draft) || /^(WIP|Draft):/i.test(p.title), head: p.head.ref, base: p.base.ref, url: p.html_url, updatedAt: p.updated_at, checks: null, review: p.mergeable ? 'mergeable' : 'conflicts' }));
  }
  if (isBitbucketCloud(a.baseUrl)) {
    type P = { id: number; title: string; author: { display_name: string }; draft?: boolean; source: { branch: { name: string } }; destination: { branch: { name: string } }; links: { html: { href: string } }; updated_on: string; participants?: { approved: boolean }[] };
    const r = await callAs<{ values: P[] }>(a, 'GET', `/repositories/${owner}/${repo}/pullrequests?state=OPEN&pagelen=50`);
    return r.values.map((p) => ({
      number: p.id,
      title: p.title,
      author: p.author.display_name,
      draft: Boolean(p.draft),
      head: p.source.branch.name,
      base: p.destination.branch.name,
      url: p.links.html.href,
      updatedAt: p.updated_on,
      checks: null,
      review: p.participants?.some((x) => x.approved) ? 'approved' : null,
    }));
  }
  type P = { id: number; title: string; author: { user: { name: string } }; draft?: boolean; fromRef: { displayId: string }; toRef: { displayId: string }; links: { self: { href: string }[] }; updatedDate: number };
  const r = await callAs<{ values: P[] }>(a, 'GET', `/projects/${owner}/repos/${repo}/pull-requests?state=OPEN&limit=50`);
  return r.values.map((p) => ({ number: p.id, title: p.title, author: p.author.user.name, draft: Boolean(p.draft), head: p.fromRef.displayId, base: p.toRef.displayId, url: p.links.self[0]?.href ?? '', updatedAt: new Date(p.updatedDate).toISOString(), checks: null, review: null }));
}

export async function createPull(accountId: string, owner: string, repo: string, o: { title: string; body: string; head: string; base: string; draft: boolean }): Promise<GitPull> {
  const a = account(accountId);
  const now = new Date().toISOString();
  if (a.kind === 'github') {
    const p = await callAs<{ number: number; html_url: string; draft: boolean }>(a, 'POST', `/repos/${owner}/${repo}/pulls`, { title: o.title, body: o.body, head: o.head, base: o.base, draft: o.draft });
    return { number: p.number, title: o.title, author: a.username, draft: p.draft, head: o.head, base: o.base, url: p.html_url, updatedAt: now, checks: null, review: null };
  }
  if (a.kind === 'gitlab') {
    const m = await callAs<{ iid: number; web_url: string }>(a, 'POST', `/projects/${enc(`${owner}/${repo}`)}/merge_requests`, {
      source_branch: o.head,
      target_branch: o.base,
      title: o.draft ? `Draft: ${o.title}` : o.title,
      description: o.body,
      remove_source_branch: false,
    });
    return { number: m.iid, title: o.title, author: a.username, draft: o.draft, head: o.head, base: o.base, url: m.web_url, updatedAt: now, checks: null, review: null };
  }
  if (a.kind === 'gitea') {
    const p = await callAs<{ number: number; html_url: string }>(a, 'POST', `/repos/${owner}/${repo}/pulls`, { title: o.draft ? `WIP: ${o.title}` : o.title, body: o.body, head: o.head, base: o.base });
    return { number: p.number, title: o.title, author: a.username, draft: o.draft, head: o.head, base: o.base, url: p.html_url, updatedAt: now, checks: null, review: null };
  }
  if (isBitbucketCloud(a.baseUrl)) {
    const p = await callAs<{ id: number; links: { html: { href: string } } }>(a, 'POST', `/repositories/${owner}/${repo}/pullrequests`, {
      title: o.title,
      description: o.body,
      draft: o.draft,
      source: { branch: { name: o.head } },
      destination: { branch: { name: o.base } },
    });
    return { number: p.id, title: o.title, author: a.username, draft: o.draft, head: o.head, base: o.base, url: p.links.html.href, updatedAt: now, checks: null, review: null };
  }
  const p = await callAs<{ id: number; links: { self: { href: string }[] } }>(a, 'POST', `/projects/${owner}/repos/${repo}/pull-requests`, {
    title: o.title,
    description: o.body,
    draft: o.draft,
    fromRef: { id: `refs/heads/${o.head}` },
    toRef: { id: `refs/heads/${o.base}` },
  });
  return { number: p.id, title: o.title, author: a.username, draft: o.draft, head: o.head, base: o.base, url: p.links.self[0]?.href ?? '', updatedAt: now, checks: null, review: null };
}

/** The ref a PR's head can be fetched from (null = fetch its branch by name). */
export function pullRef(kind: GitHostKind, n: number): string | null {
  if (kind === 'github' || kind === 'gitea') return `pull/${n}/head`;
  if (kind === 'gitlab') return `merge-requests/${n}/head`;
  return null;
}

// ------------------------------------------------------------ SSH keys

const sshDir = () => join(homedir(), '.ssh');

export async function sshKeys(): Promise<GitSshKey[]> {
  const dir = sshDir();
  if (!existsSync(dir)) return [];
  const out: GitSshKey[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.pub'))) {
    const path = join(dir, f);
    const text = readFileSync(path, 'utf8').trim();
    const [type, , ...comment] = text.split(/\s+/);
    if (!/^(ssh-|ecdsa-|sk-)/.test(type ?? '')) continue;
    const fp = await run('ssh-keygen', ['-lf', path], { timeout: 10_000 });
    out.push({ path, type, comment: comment.join(' '), fingerprint: fp.stdout.split(/\s+/)[1] ?? '', publicKey: text });
  }
  return out;
}

/** A new ed25519 key: ~/.ssh/id_ed25519 when free (ssh uses it by default), else id_ed25519_dialcatz. No passphrase. */
export async function sshGenerate(email: string): Promise<GitSshKey> {
  const dir = sshDir();
  const base = existsSync(join(dir, 'id_ed25519')) ? 'id_ed25519_dialcatz' : 'id_ed25519';
  const path = join(dir, base);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Windows: the OpenSSH client that ships with Windows 10/11 (System32\\OpenSSH, on the Path).
  const r = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', email.trim() || 'dialcatz', '-f', path]);
  if (r.code !== 0) throw new Error(`ssh-keygen: ${r.stderr.trim()}`);
  const key = (await sshKeys()).find((k) => k.path === `${path}.pub`);
  if (!key) throw new Error('Key not found after ssh-keygen');
  return key;
}

export async function sshAddToAccount(accountId: string, keyPath: string, title: string): Promise<void> {
  const a = account(accountId);
  const key = (await sshKeys()).find((k) => k.path === keyPath);
  if (!key) throw new Error('Not a public key in ~/.ssh');
  const label = title.trim() || `DialCatz ${new Date().toISOString().slice(0, 10)}`;
  // Comment-free key body (some hosts reject a trailing comment).
  const body = key.publicKey.split(/\s+/).slice(0, 2).join(' ');
  if (a.kind === 'github' || a.kind === 'gitlab' || a.kind === 'gitea') {
    await callAs(a, 'POST', '/user/keys', { title: label, key: body });
  } else if (isBitbucketCloud(a.baseUrl)) {
    const u = await callAs<{ uuid: string }>(a, 'GET', '/user');
    await callAs(a, 'POST', `/users/${enc(u.uuid)}/ssh-keys`, { key: body, label });
  } else {
    await call(a.kind, a.baseUrl, await decrypt(a), a.username, 'POST', `${a.baseUrl}/rest/ssh/1.0/keys`, { text: body, label });
  }
}
