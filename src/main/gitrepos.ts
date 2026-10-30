import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { GitCloneTask, GitPull, GitRemote, GitRepoEntry, GitState, GitStatus, GitSummary, GitSyncAction } from '@shared/types';
import * as g from './gitcore';
import * as hosts from './githosts';
import { store } from './store';

/**
 * The Git section's repositories (ported from DevCatz's per-site Git): the repositories of folder workspaces, the
 * ones the user added and the ones cloned here, each with a summary (refreshed every 20 s while the Git section is
 * open, and after each operation), the operations behind the repository view, pull requests through the connected
 * accounts, and Clone. Long operations (fetch, pull, push, clone) stream into the repository's output log and can be
 * cancelled.
 */
export interface GitRepoHooks {
  /** Folders of the folder workspaces (by workspace id). */
  workspaceFolders(): { id: string; name: string; folder: string }[];
  changed(): void;
  openFile(path: string): Promise<void>;
}

interface Added {
  path: string;
  addedAt: string;
}

const SHA = /^[0-9a-f]{4,40}$/i;
const idOf = (root: string) => `r${createHash('sha1').update(resolve(root)).digest('hex').slice(0, 12)}`;
const LOG_LINES = 400;

/** A DialCatz workspace in the repository: its root, or its dialcatz/ folder (where DevCatz sites keep it). */
export function workspaceIn(root: string): string | null {
  for (const dir of [root, join(root, 'dialcatz')]) if (existsSync(join(dir, 'dialcatz.yml'))) return dir;
  return null;
}

export class GitRepos {
  version: string | null = null;
  private roots = new Map<string, { root: string; added: boolean; workspaces: string[] }>();
  private summaries = new Map<string, GitSummary | null>();
  private busy = new Map<string, string>();
  private logs = new Map<string, string[]>();
  private aborts = new Map<string, AbortController>();
  private clone: GitCloneTask | null = null;
  private cloneAbort: AbortController | null = null;
  private polling: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private h: GitRepoHooks) {
    void g.gitVersion().then((v) => {
      this.version = v;
      this.h.changed();
    });
  }

  private added = (): Added[] => (store.extra<Added[]>('gitRepos') ?? []).filter((a) => a?.path);

  /** Re-reads which repositories there are (folder workspaces may have moved); keeps the summaries. */
  private async rescan(): Promise<void> {
    const next = new Map<string, { root: string; added: boolean; workspaces: string[] }>();
    for (const a of this.added()) {
      if (!existsSync(a.path)) continue;
      const root = (await g.repoRoot(a.path)) ?? a.path;
      next.set(idOf(root), { root, added: true, workspaces: [] });
    }
    for (const w of this.h.workspaceFolders()) {
      const root = existsSync(w.folder) ? await g.repoRoot(w.folder) : null;
      if (!root) continue;
      const id = idOf(root);
      const cur = next.get(id) ?? { root, added: false, workspaces: [] };
      cur.workspaces.push(w.id);
      next.set(id, cur);
    }
    this.roots = next;
  }

  state(): GitState {
    const names = new Map(this.h.workspaceFolders().map((w) => [w.id, w.name]));
    const repos: GitRepoEntry[] = [...this.roots.entries()]
      .map(([id, r]) => ({
        id,
        name: basename(r.root),
        path: r.root,
        added: r.added,
        workspaces: r.workspaces.map((w) => ({ id: w, name: names.get(w) ?? w })),
        workspaceFolder: workspaceIn(r.root),
        summary: this.summaries.get(id) ?? null,
        busy: this.busy.get(id) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { version: this.version, accounts: hosts.listAccounts(), clone: this.clone, cloneDir: this.cloneDir(), repos };
  }

  /** The folder most repositories live in (new clones go next to them), else ~/Projects (or ~/ when that is not there). */
  cloneDir(): string {
    const count = new Map<string, number>();
    for (const r of this.roots.values()) count.set(dirname(r.root), (count.get(dirname(r.root)) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top) return top;
    const projects = join(homedir(), 'Projects');
    return existsSync(projects) ? projects : homedir();
  }

  /** Summaries every 20 s, only while the Git section is on screen. */
  watch(on: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!on) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), 20_000);
  }

  /** One round of summaries; a call during one waits for it, then runs another (the list may have changed since). */
  pollAll(): Promise<void> {
    const next = this.polling.then(() => this.poll());
    this.polling = next.catch(() => undefined);
    return next;
  }

  private async poll(): Promise<void> {
    await this.rescan();
    for (const [id, r] of this.roots) this.summaries.set(id, existsSync(r.root) ? await g.summary(r.root).catch(() => null) : null);
    for (const id of [...this.summaries.keys()]) if (!this.roots.has(id)) this.summaries.delete(id);
    this.h.changed();
  }

  /** Re-reads one repository's summary (after an operation). */
  async refresh(id: string): Promise<void> {
    const r = this.roots.get(id);
    if (!r) return;
    this.summaries.set(id, await g.summary(r.root).catch(() => null));
    this.h.changed();
  }

  /** Adds a folder (a repository, or one to start Git in); returns its id. */
  async add(path: string): Promise<string> {
    const dir = resolve(path);
    if (!existsSync(dir)) throw new Error(`${dir} does not exist`);
    const root = (await g.repoRoot(dir)) ?? dir;
    if (!this.added().some((a) => resolve(a.path) === root)) store.setExtra('gitRepos', [...this.added(), { path: root, addedAt: new Date().toISOString() }]);
    await this.pollAll();
    return idOf(root);
  }

  /** Takes a repository off the list (its files stay; a folder workspace's repository stays listed). */
  async remove(id: string): Promise<void> {
    const r = this.roots.get(id);
    if (!r) return;
    store.setExtra('gitRepos', this.added().filter((a) => idOf(a.path) !== id && resolve(a.path) !== r.root));
    this.logs.delete(id);
    await this.pollAll();
  }

  pathOf(id: string): string {
    const r = this.roots.get(id);
    if (!r) throw new Error('That repository is not on the list any more');
    return r.root;
  }

  log(id: string): string[] {
    return this.logs.get(id) ?? [];
  }

  private line(id: string, text: string): void {
    const list = this.logs.get(id) ?? [];
    list.push(text);
    if (list.length > LOG_LINES) list.splice(0, list.length - LOG_LINES);
    this.logs.set(id, list);
  }

  private async root(id: string): Promise<string> {
    const root = await g.repoRoot(this.pathOf(id));
    if (!root) throw new Error('Not a Git repository');
    return root;
  }

  /** Runs a short git command in the repository, then refreshes its summary. */
  private async op(id: string, args: string[], opts: Parameters<typeof g.git>[2] = {}): Promise<string> {
    if (this.busy.has(id)) throw new Error(`Busy: ${this.busy.get(id)}`);
    const root = await this.root(id);
    try {
      return await g.gitOk(root, args, { ...opts, env: { GIT_EDITOR: 'true', ...opts.env } });
    } finally {
      void this.refresh(id);
    }
  }

  private remoteInfo(name: string, url: string): GitRemote {
    const r = g.parseRemote(url);
    const acc = hosts.accountFor(r?.host ?? null);
    const kind = acc?.kind ?? (r?.host === 'github.com' ? 'github' : r?.host === 'gitlab.com' ? 'gitlab' : r?.host === 'bitbucket.org' ? 'bitbucket' : r?.host === 'codeberg.org' ? 'gitea' : null);
    const web = r ? `https://${r.host === 'ssh.github.com' ? 'github.com' : r.host}/${r.owner}/${r.repo}` : null;
    return { name, url, host: r?.host ?? null, owner: r?.owner ?? null, repo: r?.repo ?? null, webUrl: web, accountId: acc?.id ?? null, kind };
  }

  async status(id: string): Promise<GitStatus | null> {
    const path = this.pathOf(id);
    if (!(await g.repoRoot(path))) return null;
    const s = await g.status(path);
    const { remoteUrls, ...rest } = s;
    this.summaries.set(id, { branch: s.branch, detached: s.detached, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changed: s.changed, conflicts: s.conflicts, operation: s.operation });
    return { ...rest, remotes: remoteUrls.map((r) => this.remoteInfo(r.name, r.url)) };
  }

  async init(id: string): Promise<void> {
    const path = this.pathOf(id);
    if (await g.repoRoot(path)) throw new Error('Already a Git repository');
    await g.gitOk(path, ['init', '-b', 'main']);
    await this.refresh(id);
  }

  async diff(id: string, file: string, staged: boolean): Promise<string> {
    return g.diff(await this.root(id), file, staged);
  }

  private async files(id: string, files: string[]): Promise<{ root: string; list: string[] }> {
    const root = await this.root(id);
    const list = files.map((f) => g.inside(root, f));
    if (!list.length) throw new Error('No files');
    return { root, list };
  }

  async stage(id: string, files: string[]): Promise<void> {
    const { list } = await this.files(id, files);
    await this.op(id, ['add', '-A', '--', ...list]);
  }

  async unstage(id: string, files: string[]): Promise<void> {
    const { root, list } = await this.files(id, files);
    const hasHead = (await g.git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    await this.op(id, hasHead ? ['restore', '--staged', '--', ...list] : ['rm', '--cached', '-r', '-q', '--', ...list]);
  }

  async discard(id: string, files: string[]): Promise<void> {
    const { root, list } = await this.files(id, files);
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const f of list) ((await g.git(root, ['ls-files', '--error-unmatch', '--', f])).code === 0 ? tracked : untracked).push(f);
    if (tracked.length) await this.op(id, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
    if (untracked.length) await this.op(id, ['clean', '-f', '-q', '--', ...untracked]);
  }

  async commit(id: string, message: string, amend: boolean): Promise<void> {
    const root = await this.root(id);
    if (!message.trim() && !amend) throw new Error('Write a commit message');
    const staged = (await g.git(root, ['diff', '--cached', '--quiet'])).code === 1;
    if (!staged && !amend) throw new Error('Nothing staged: stage files first');
    const who = await g.git(root, ['config', 'user.email']);
    if (!who.stdout.trim()) throw new Error('Set your name and email first (identity, above)');
    await this.op(id, ['commit', ...(amend ? ['--amend'] : []), ...(message.trim() ? ['-F', '-'] : ['--no-edit'])], { input: message.trim() ? `${message.trim()}\n` : undefined });
    this.line(id, `git commit${amend ? ' --amend' : ''}: ${message.trim().split('\n')[0] ?? ''}`);
  }

  /** Credentials for the remote a command talks to (HTTPS + a connected account). */
  private async credsFor(root: string, remote: string): Promise<g.GitCreds | null> {
    const url = (await g.git(root, ['remote', 'get-url', remote])).stdout.trim();
    const r = g.parseRemote(url);
    return r?.https ? hosts.credsFor(r.host) : null;
  }

  /** The remote of the current branch's upstream, else origin, else the first one. */
  private async remoteOf(root: string): Promise<string> {
    const up = (await g.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
    const remotes = (await g.git(root, ['remote'])).stdout.split('\n').filter(Boolean);
    if (!remotes.length) throw new Error('No remote: add one first (e.g. origin)');
    const fromUp = up && remotes.find((r) => up.startsWith(`${r}/`));
    return fromUp || (remotes.includes('origin') ? 'origin' : remotes[0]);
  }

  /** A long git command: output in the repository's log, busy label, cancellable. */
  private async task(id: string, label: string, root: string, args: string[], creds: g.GitCreds | null): Promise<void> {
    if (this.busy.has(id)) throw new Error(`Busy: ${this.busy.get(id)}`);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    this.busy.set(id, label);
    this.h.changed();
    this.line(id, `$ git ${args.join(' ')}`);
    let pending = '';
    try {
      const code = await g.gitStream(
        root,
        args,
        (line, progress) => {
          if (progress) pending = line;
          else {
            if (pending) this.line(id, pending);
            pending = '';
            this.line(id, line);
          }
        },
        { env: { ...g.gitEnv(creds), GIT_EDITOR: 'true' }, signal: abort.signal },
      );
      if (pending) this.line(id, pending);
      this.line(id, `→ exit ${code}`);
      if (abort.signal.aborted) throw new Error(`${label} cancelled`);
      if (code !== 0) throw new Error(`${label} failed (exit ${code}); see the output`);
    } finally {
      this.aborts.delete(id);
      this.busy.delete(id);
      void this.refresh(id);
    }
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort();
  }

  async sync(id: string, action: GitSyncAction): Promise<void> {
    // Anything else must not fall through to a push.
    if (!['fetch', 'pull', 'pull-rebase', 'push', 'push-force'].includes(action)) throw new Error(`Unknown Git action: ${String(action)}`);
    const root = await this.root(id);
    if (action === 'fetch') {
      const remotes = (await g.git(root, ['remote'])).stdout.split('\n').filter(Boolean);
      if (!remotes.length) throw new Error('No remote: add one first (e.g. origin)');
      for (const r of remotes) await this.task(id, `git fetch ${r}`, root, ['fetch', '--prune', '--progress', r], await this.credsFor(root, r));
      return;
    }
    const remote = await this.remoteOf(root);
    const creds = await this.credsFor(root, remote);
    const branch = (await g.git(root, ['branch', '--show-current'])).stdout.trim();
    if (!branch) throw new Error('Not on a branch (detached HEAD): switch to a branch first');
    const hasUp = (await g.git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).code === 0;
    if (action === 'pull' || action === 'pull-rebase') {
      if (!hasUp) throw new Error(`${branch} has no upstream yet: push it first`);
      await this.task(id, action === 'pull' ? 'git pull' : 'git pull --rebase', root, ['pull', '--progress', ...(action === 'pull' ? ['--no-rebase'] : ['--rebase', '--autostash'])], creds);
    } else {
      const args = ['push', '--progress', ...(action === 'push-force' ? ['--force-with-lease'] : []), ...(hasUp ? [] : ['-u', remote, `HEAD:refs/heads/${branch}`])];
      await this.task(id, action === 'push-force' ? 'git push --force-with-lease' : 'git push', root, args, creds);
    }
  }

  async history(id: string, search: string, skip: number, ref?: string) {
    const root = await this.root(id);
    if (ref && !(await g.branches(root)).some((b) => b.name === ref)) throw new Error(`Unknown branch ${ref}`);
    return g.log(root, search, skip, 100, ref);
  }

  show(id: string, sha: string) {
    return this.root(id).then((r) => g.show(r, sha));
  }

  branches(id: string) {
    return this.root(id).then((r) => g.branches(r));
  }

  async branch(id: string, action: 'create' | 'switch' | 'delete' | 'force-delete' | 'merge', name: string, from?: string): Promise<void> {
    const root = await this.root(id);
    const all = await g.branches(root);
    const known = all.find((b) => b.name === name);
    if (action === 'create') {
      const n = await g.checkRefName(root, name);
      if (from && !all.some((b) => b.name === from) && !SHA.test(from)) throw new Error(`Unknown start point ${from}`);
      await this.op(id, ['switch', '-c', n, ...(from ? [from] : [])]);
      return;
    }
    if (!known) throw new Error(`Unknown branch ${name}`);
    if (action === 'switch') {
      if (known.remote) {
        const local = name.split('/').slice(1).join('/');
        await this.op(id, all.some((b) => !b.remote && b.name === local) ? ['switch', local] : ['switch', '--track', name]);
      } else await this.op(id, ['switch', name]);
    } else if (action === 'merge') await this.op(id, ['merge', '--no-edit', name]);
    else {
      if (known.remote) throw new Error('Delete remote branches on the host');
      if (known.current) throw new Error('Switch to another branch first');
      await this.op(id, ['branch', action === 'force-delete' ? '-D' : '-d', name]);
    }
  }

  stashes(id: string) {
    return this.root(id).then((r) => g.stashes(r));
  }

  async stash(id: string, action: 'save' | 'apply' | 'pop' | 'drop', arg: string): Promise<void> {
    if (action === 'save') {
      await this.op(id, ['stash', 'push', '--include-untracked', ...(arg.trim() ? ['-m', arg.trim()] : [])]);
      return;
    }
    if (!/^stash@\{\d+\}$/.test(arg)) throw new Error('Not a stash');
    await this.op(id, ['stash', action, arg]);
  }

  tags(id: string) {
    return this.root(id).then((r) => g.tags(r));
  }

  async tag(id: string, action: 'create' | 'delete' | 'push', name: string, message?: string): Promise<void> {
    const root = await this.root(id);
    const n = await g.checkRefName(root, name, 'tag');
    if (action === 'create') await this.op(id, ['tag', ...(message?.trim() ? ['-a', n, '-m', message.trim()] : [n])]);
    else if (action === 'delete') await this.op(id, ['tag', '-d', n]);
    else {
      const remote = await this.remoteOf(root);
      await this.task(id, `git push tag ${n}`, root, ['push', '--progress', remote, `refs/tags/${n}`], await this.credsFor(root, remote));
    }
  }

  async operation(id: string, action: 'rebase' | 'continue' | 'skip' | 'abort', onto?: string): Promise<void> {
    const root = await this.root(id);
    if (action === 'rebase') {
      if (!onto || !(await g.branches(root)).some((b) => b.name === onto)) throw new Error('Choose the branch to rebase onto');
      await this.op(id, ['rebase', '--autostash', onto]).catch((e) => {
        throw new Error(`${(e as Error).message} — resolve the conflicts, stage them and Continue, or Abort`);
      });
      return;
    }
    const st = await g.summary(root);
    const kind = st?.operation;
    if (!kind) throw new Error('No merge, rebase or cherry-pick in progress');
    if (action === 'continue' && st.conflicts) throw new Error(`${st.conflicts} file(s) still have conflicts: fix and stage them first`);
    if (kind === 'merge') {
      if (action === 'skip') throw new Error('A merge cannot skip');
      await this.op(id, action === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit']);
    } else await this.op(id, [kind, `--${action}`]);
  }

  async squash(id: string, onto: string, message: string): Promise<void> {
    const root = await this.root(id);
    if (!message.trim()) throw new Error('Write the message of the squashed commit');
    const st = await g.summary(root);
    if (st?.changed) throw new Error('Commit or stash your changes first');
    const base = (await g.gitOk(root, ['merge-base', 'HEAD', onto])).trim();
    const count = Number((await g.gitOk(root, ['rev-list', '--count', `${base}..HEAD`])).trim());
    if (count < 2) throw new Error(`Only ${count} commit(s) since ${onto}: nothing to squash`);
    await this.op(id, ['reset', '--soft', base]);
    await this.op(id, ['commit', '-F', '-'], { input: `${message.trim()}\n` });
    this.line(id, `Squashed ${count} commits into one (was based on ${base.slice(0, 7)})`);
  }

  async cherryPick(id: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    await this.op(id, ['cherry-pick', sha]);
  }

  async revert(id: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    await this.op(id, ['revert', '--no-edit', sha]);
  }

  async reset(id: string, mode: 'soft' | 'mixed' | 'hard', sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error('Unknown reset mode');
    await this.op(id, ['reset', `--${mode}`, sha]);
    this.line(id, `git reset --${mode} ${sha.slice(0, 7)}`);
  }

  async restoreFile(id: string, file: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    const { list } = await this.files(id, [file]);
    await this.op(id, ['restore', `--source=${sha}`, '--staged', '--worktree', '--', ...list]);
  }

  async openFile(id: string, file: string): Promise<void> {
    const root = await this.root(id);
    await this.h.openFile(join(root, g.inside(root, file)));
  }

  async ignoreSuggestions(id: string): Promise<string[]> {
    return g.ignoreSuggestions(await this.root(id));
  }

  async ignoreAdd(id: string, lines: string[]): Promise<void> {
    g.addIgnore(await this.root(id), lines);
    await this.refresh(id);
  }

  async gitignoreRead(id: string): Promise<{ exists: boolean; content: string; suggested: string }> {
    const file = join((await g.repoRoot(this.pathOf(id))) ?? this.pathOf(id), '.gitignore');
    const exists = existsSync(file);
    return { exists, content: exists ? readFileSync(file, 'utf8') : '', suggested: SUGGESTED };
  }

  async gitignoreSave(id: string, content: string): Promise<void> {
    writeFileSync(join((await g.repoRoot(this.pathOf(id))) ?? this.pathOf(id), '.gitignore'), content.endsWith('\n') || !content ? content : `${content}\n`);
    this.line(id, '.gitignore saved');
    void this.refresh(id);
  }

  async setIdentity(id: string, name: string, email: string, global: boolean): Promise<void> {
    const root = await this.root(id);
    if (!name.trim() || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new Error('Enter a name and an email address');
    await g.gitOk(root, ['config', ...(global ? ['--global'] : []), 'user.name', name.trim()]);
    await g.gitOk(root, ['config', ...(global ? ['--global'] : []), 'user.email', email.trim()]);
  }

  async addRemote(id: string, name: string, url: string): Promise<void> {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Remote name: letters, digits, . _ -');
    if (!g.parseRemote(url) && !url.startsWith('/')) throw new Error('Not a Git URL');
    await this.op(id, ['remote', 'add', name, url.trim()]);
  }

  // ---- worktrees (a plain list: add, remove, prune)

  async worktrees(id: string) {
    const root = await this.root(id);
    const list = await g.worktrees(root);
    return Promise.all(list.map(async (w) => ({ ...w, unpushed: w.main || !existsSync(w.path) ? 0 : await g.unpushed(w.path).catch(() => 0) })));
  }

  async worktreeAdd(id: string, path: string, branch: string, create: boolean, from?: string): Promise<string> {
    const root = await this.root(id);
    const b = create ? await g.checkRefName(root, branch) : branch.trim();
    if (!b || b.startsWith('-')) throw new Error('Choose a branch');
    if (!path.trim()) throw new Error('Choose a folder');
    if (from && (from.startsWith('-') || !(await g.branches(root)).some((x) => x.name === from))) throw new Error(`Unknown start point ${from}`);
    const dest = resolve(path.trim());
    await g.worktreeAdd(root, dest, b, create, from || undefined);
    this.line(id, `git worktree add ${dest} (${b})`);
    void this.refresh(id);
    return dest;
  }

  async worktreeRemove(id: string, path: string, force: boolean): Promise<void> {
    const root = await this.root(id);
    const w = (await g.worktrees(root)).find((x) => resolve(x.path) === resolve(path));
    if (!w) throw new Error('Not a worktree of this repository');
    if (w.main) throw new Error('The main working tree cannot be removed');
    await g.worktreeRemove(root, w.path, force);
    this.line(id, `git worktree remove ${w.path}`);
  }

  async worktreePrune(id: string): Promise<void> {
    await g.worktreePrune(await this.root(id));
  }

  // ---- pull requests

  private async hosted(id: string): Promise<{ root: string; remote: GitRemote; accountId: string }> {
    const root = await this.root(id);
    const name = await this.remoteOf(root);
    const url = (await g.git(root, ['remote', 'get-url', name])).stdout.trim();
    const remote = this.remoteInfo(name, url);
    if (!remote.owner || !remote.repo) throw new Error(`Cannot read the repository from ${url}`);
    if (!remote.accountId) throw new Error(`Connect a ${remote.host ?? 'Git host'} account in Git → Accounts to see pull requests`);
    return { root, remote, accountId: remote.accountId };
  }

  async pulls(id: string): Promise<GitPull[]> {
    const { remote, accountId } = await this.hosted(id);
    return hosts.pulls(accountId, remote.owner!, remote.repo!);
  }

  async createPull(id: string, title: string, body: string, base: string, draft: boolean): Promise<GitPull> {
    const { root, remote, accountId } = await this.hosted(id);
    if (!title.trim()) throw new Error('Write a title');
    const head = (await g.git(root, ['branch', '--show-current'])).stdout.trim();
    if (!head) throw new Error('Not on a branch');
    if (head === base) throw new Error(`Pick a base other than ${head}`);
    const up = await g.git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    if (up.code !== 0) throw new Error(`Push ${head} first (it has no upstream on ${remote.name})`);
    const s = await g.summary(root);
    if (s?.ahead) throw new Error(`${s.ahead} commit(s) not pushed yet: push first`);
    return hosts.createPull(accountId, remote.owner!, remote.repo!, { title: title.trim(), body, head, base, draft });
  }

  async checkoutPull(id: string, pull: GitPull): Promise<void> {
    const { root, remote, accountId } = await this.hosted(id);
    const kind = hosts.listAccounts().find((a) => a.id === accountId)!.kind;
    const n = Number(pull.number);
    if (!Number.isInteger(n) || n < 1) throw new Error('Not a pull request');
    const ref = hosts.pullRef(kind, n);
    if (!ref && (!pull.head || pull.head.startsWith('-') || /\s/.test(pull.head))) throw new Error('Not a branch name');
    const creds = await this.credsFor(root, remote.name);
    const local = ref ? `pr/${n}` : pull.head;
    await this.task(id, `fetch pull #${n}`, root, ['fetch', '--progress', remote.name, `+${ref ?? `refs/heads/${pull.head}`}:refs/heads/${local}`], creds);
    await this.op(id, ['switch', local]);
  }

  // ---- clone

  async cloneRepo(url: string, parent: string, name: string, branch: string, shallow: boolean): Promise<string> {
    if (this.cloneAbort) throw new Error('A clone is already running');
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error('Folder name: letters, digits, . _ -');
    if (!existsSync(parent)) throw new Error(`${parent} does not exist`);
    const src = url.trim();
    const remote = g.parseRemote(src);
    if (!remote && !src.startsWith('/')) throw new Error('Not a Git URL (https://…, git@host:owner/repo.git)');
    if (branch && (branch.startsWith('-') || /\s/.test(branch))) throw new Error('Not a branch or tag name');
    const dest = join(parent, name);
    const abort = new AbortController();
    this.cloneAbort = abort;
    this.clone = { url: src, dest, lines: [], done: false, error: null };
    this.h.changed();
    let lastProgress = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = (line: string, progress: boolean) => {
      const c = this.clone!;
      if (lastProgress && c.lines.length) c.lines[c.lines.length - 1] = line;
      else c.lines.push(line);
      lastProgress = progress;
      if (c.lines.length > 200) c.lines.splice(0, c.lines.length - 200);
      // Progress updates are frequent: send state at most every 250 ms.
      timer ??= setTimeout(() => {
        timer = null;
        this.h.changed();
      }, 250);
    };
    try {
      await g.clone({ url: src, dest, branch, shallow, creds: remote?.https ? await hosts.credsFor(remote.host) : null, log: push, signal: abort.signal });
      this.clone = { ...this.clone!, done: true };
      await this.add(dest);
      return dest;
    } catch (err) {
      this.clone = { ...this.clone!, done: true, error: (err as Error).message };
      if (abort.signal.aborted) rmSync(dest, { recursive: true, force: true });
      throw err;
    } finally {
      this.cloneAbort = null;
      if (timer) clearTimeout(timer);
      this.h.changed();
    }
  }

  cancelClone(): void {
    this.cloneAbort?.abort();
  }

  dismissClone(): void {
    if (this.clone?.done) this.clone = null;
    this.h.changed();
  }

  /** Sends the state again (accounts changed). */
  changed(): void {
    this.h.changed();
  }
}

/** A starting .gitignore for a repository with API work in it. */
const SUGGESTED = `# Secrets
.env
.env.*
!.env.example

# Dependencies and build output
node_modules/
dist/
build/
.venv/
__pycache__/
vendor/

# Logs and editors
*.log
.DS_Store
.idea/
.vscode/*
!.vscode/extensions.json
`;
