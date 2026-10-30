import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import type { FolderGitChange, FolderGitStatus } from '@shared/types';
import { gitEnv, parseRemote } from './gitcore';
import { credsFor } from './githosts';

/**
 * Git for folder workspaces (git sharing, phase 2): status, diff, commit, pull and push of the workspace's folder
 * with the system's git and the user's own credentials (SSH agent, credential helper) — DialCatz keeps no Git
 * password or token. Only the workspace folder is staged and committed (`-- <folder>`), never the rest of the
 * repository. git never waits for a prompt: it fails with a message instead (GIT_TERMINAL_PROMPT=0, ssh BatchMode).
 */

const TIMEOUT = 90_000;

class GitError extends Error {}

function git(cwd: string, args: string[], allowFail = false, extra: Record<string, string> = {}): Promise<{ out: string; err: string; code: number }> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }), ...extra };
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, env, timeout: TIMEOUT, maxBuffer: 32 * 1024 * 1024 }, (e, stdout, stderr) => {
      const code = e ? (typeof (e as { code?: unknown }).code === 'number' ? ((e as { code: number }).code) : -1) : 0;
      if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('Git is not installed on this computer. Install Git (on a Mac: xcode-select --install), then try again.'));
      if (e && !allowFail) return reject(new GitError(friendly(String(stderr || e.message))));
      resolve({ out: String(stdout), err: String(stderr), code });
    }),
  );
}

/**
 * Credentials for origin when it is an HTTPS remote on a connected Git account (Git → Accounts, shared with the
 * Catzoid apps); otherwise git uses the user's own helper / SSH key.
 */
async function remoteEnv(folder: string): Promise<Record<string, string>> {
  const url = (await git(folder, ['remote', 'get-url', 'origin'], true)).out.trim();
  const r = url ? parseRemote(url) : null;
  const creds = r?.https ? await credsFor(r.host).catch(() => null) : null;
  return creds ? gitEnv(creds) : {};
}

/** git's message, said plainly where it is a common one. */
function friendly(msg: string): string {
  const m = msg.trim();
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(m)) return 'Git could not sign in to the remote. Sign in once with Git in a terminal (or set up an SSH key), then try again.';
  if (/Permission denied \(publickey\)|Host key verification failed/i.test(m)) return 'The remote refused the SSH key. Check that your SSH key is added to the Git host (and to the SSH agent).';
  if (/Could not resolve host|unable to access/i.test(m)) return 'The remote could not be reached. Check the internet connection.';
  if (/non-fast-forward|fetch first|rejected/i.test(m)) return 'The remote has commits you do not have yet: Pull first, then Push.';
  if (/no upstream|has no upstream/i.test(m)) return 'This branch has no remote branch yet.';
  if (/would be overwritten by merge|commit your changes or stash/i.test(m)) return 'You have changes that are not committed yet: Commit them first, then Pull.';
  if (/No configured push destination|does not appear to be a git repository|'origin'/i.test(m)) return 'This repository has no remote (origin) to push to. Add one with Git (git remote add origin …), then try again.';
  if (/Please tell me who you are|user\.email/i.test(m)) return 'Git does not know your name and email yet. Set them once with git config --global user.name and user.email.';
  return m.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 400) || 'Git failed';
}

/** A path in the workspace folder as the item it is (its name from the file when it is still there). */
function label(folder: string, rel: string): string {
  const abs = join(folder, rel);
  let name = '';
  try {
    if (existsSync(abs)) name = String((parse(readFileSync(abs, 'utf8')) as { name?: unknown })?.name ?? '');
  } catch {
    /* a file with a mistake: its path says enough */
  }
  const base = rel.split('/').pop() ?? rel;
  const kind = base.endsWith('.request.yml') ? 'Request' : base === 'collection.yml' ? 'Collection' : base === 'folder.yml' ? 'Folder' : base.endsWith('.env.yml') ? 'Environment' : base === 'dialcatz.yml' ? 'Workspace' : 'File';
  return `${kind}: ${name || base.replace(/\.(request|env)?\.?yml$/, '')}`;
}

export async function status(folder: string, fetch = false): Promise<FolderGitStatus> {
  let top: string;
  try {
    const r = await git(folder, ['rev-parse', '--show-toplevel'], true);
    if (r.code !== 0) return { repo: false, changes: [], ahead: 0, behind: 0, conflicts: [], merging: false };
    top = r.out.trim();
  } catch (e) {
    return { repo: false, gitMissing: true, error: (e as Error).message, changes: [], ahead: 0, behind: 0, conflicts: [], merging: false };
  }
  let error: string | undefined;
  if (fetch) {
    const f = await git(folder, ['fetch', '--quiet'], true, await remoteEnv(folder));
    if (f.code !== 0 && /remote|fatal/i.test(f.err)) error = friendly(f.err);
  }
  // symbolic-ref names the branch even before its first commit; a detached HEAD has none.
  const branch = (await git(folder, ['symbolic-ref', '--short', '-q', 'HEAD'], true)).out.trim() || (await git(folder, ['rev-parse', '--short', 'HEAD'], true)).out.trim() || 'HEAD';
  const up = await git(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true);
  const upstream = up.code === 0 ? up.out.trim() : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const c = await git(folder, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], true);
    const [b, a] = c.out.trim().split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  }
  const remotes = (await git(folder, ['remote'], true)).out.trim().split('\n').filter(Boolean);
  // Changes inside the workspace folder only, paths relative to it.
  const st = await git(folder, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], true);
  const prefix = relative(top, folder).replace(/\\/g, '/');
  const changes: FolderGitChange[] = [];
  const conflicts: string[] = [];
  const parts = st.out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const xy = e.slice(0, 2);
    let path = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the old name follows
    if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
    const kind: FolderGitChange['kind'] = /U|AA|DD/.test(xy) ? 'conflict' : xy === '??' || xy.includes('A') ? 'added' : xy.includes('D') ? 'deleted' : xy.includes('R') ? 'renamed' : 'modified';
    if (kind === 'conflict') conflicts.push(path);
    changes.push({ path, kind, label: label(folder, path) });
  }
  const merging = existsSync(join(top, '.git', 'MERGE_HEAD'));
  const remoteUrl = remotes.includes('origin') ? (await git(folder, ['remote', 'get-url', 'origin'], true)).out.trim() : '';
  return { repo: true, root: top, branch, upstream, hasRemote: remotes.length > 0, remoteUrl, ahead, behind, changes: changes.sort((a, b) => a.path.localeCompare(b.path)), conflicts, merging, error };
}

export async function diff(folder: string, path: string): Promise<string> {
  if (path.includes('..')) throw new GitError('Bad path');
  const tracked = (await git(folder, ['ls-files', '--error-unmatch', '--', path], true)).code === 0;
  if (!tracked) {
    // A new file: all of it is the change.
    return existsSync(join(folder, path)) ? readFileSync(join(folder, path), 'utf8').split('\n').map((l) => `+${l}`).join('\n') : '';
  }
  return (await git(folder, ['diff', 'HEAD', '--no-color', '--', path], true)).out;
}

/** Commits the workspace folder's changes only (the rest of the repository is left as it is). */
export async function commit(folder: string, message: string): Promise<void> {
  const msg = message.trim();
  if (!msg) throw new GitError('Write what changed (the commit message)');
  await git(folder, ['add', '-A', '--', '.']);
  const staged = await git(folder, ['diff', '--cached', '--quiet', '--', '.'], true);
  if (staged.code === 0) throw new GitError('Nothing to commit in this workspace');
  // During a merge git takes no paths: the merge commit is the whole of it.
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).out.trim();
  if (existsSync(join(top, '.git', 'MERGE_HEAD'))) await git(folder, ['commit', '-m', msg.slice(0, 5000)]);
  else await git(folder, ['commit', '-m', msg.slice(0, 5000), '--', '.']);
}

/** Pull: fast-forward when it can; otherwise merge (conflicts are left for the user, with Abort merge). */
export async function pull(folder: string): Promise<{ merged: boolean; conflicts: boolean }> {
  const env = await remoteEnv(folder);
  const ff = await git(folder, ['pull', '--ff-only', '--no-edit'], true, env);
  if (ff.code === 0) return { merged: false, conflicts: false };
  if (!/Not possible to fast-forward|diverg/i.test(ff.err)) throw new GitError(friendly(ff.err));
  const m = await git(folder, ['pull', '--no-rebase', '--no-edit'], true, env);
  if (m.code === 0) return { merged: true, conflicts: false };
  if (/CONFLICT|conflict/i.test(m.out + m.err)) return { merged: true, conflicts: true };
  throw new GitError(friendly(m.err));
}

export async function push(folder: string): Promise<void> {
  const up = await git(folder, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true);
  const env = await remoteEnv(folder);
  if (up.code === 0) await git(folder, ['push'], false, env);
  else await git(folder, ['push', '-u', 'origin', 'HEAD'], false, env);
}

/**
 * Connects the workspace's repository to a remote (origin): starts Git in the folder when it has none, adds or
 * changes origin, and fetches it. An empty remote just waits for the first Push. One with commits becomes the
 * branch's upstream: before the first local commit the workspace sits on top of it (its files show as changes to
 * commit); with local commits it is merged in (unrelated histories allowed; conflicts are left for the user).
 */
export async function connect(folder: string, url: string): Promise<{ merged: boolean; conflicts: boolean }> {
  const u = url.trim();
  if (!u || u.startsWith('-') || (!parseRemote(u) && !u.startsWith('/'))) throw new GitError('Not a Git URL (https://…, git@host:owner/repo.git)');
  if ((await git(folder, ['rev-parse', '--show-toplevel'], true)).code !== 0) await git(folder, ['init', '-b', 'main']);
  const has = (await git(folder, ['remote'], true)).out.split('\n').includes('origin');
  await git(folder, ['remote', has ? 'set-url' : 'add', 'origin', u]);
  const env = await remoteEnv(folder);
  await git(folder, ['fetch', 'origin'], false, env);
  const heads = (await git(folder, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], true)).out.split('\n').filter((b) => b && b !== 'origin/HEAD' && b !== 'origin');
  if (!heads.length) return { merged: false, conflicts: false };
  // The remote's default branch (origin/HEAD), else main / master, else its first branch.
  await git(folder, ['remote', 'set-head', 'origin', '--auto'], true, env);
  const head = (await git(folder, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], true)).out.trim();
  const remote = head || ['origin/main', 'origin/master'].find((b) => heads.includes(b)) || heads[0];
  const branch = remote.replace(/^origin\//, '');
  const hasCommits = (await git(folder, ['rev-parse', '--verify', '-q', 'HEAD'], true)).code === 0;
  if (!hasCommits) {
    // Nothing committed here yet: take the remote's history; the files on disk stay as they are.
    await git(folder, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    await git(folder, ['reset', '-q', remote]);
    await git(folder, ['branch', '--set-upstream-to', remote]);
    return { merged: false, conflicts: false };
  }
  const current = (await git(folder, ['symbolic-ref', '--short', '-q', 'HEAD'], true)).out.trim();
  if (current && current !== branch && (await git(folder, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], true)).code !== 0) await git(folder, ['branch', '-m', branch]);
  const m = await git(folder, ['merge', '--no-edit', '--allow-unrelated-histories', remote], true);
  await git(folder, ['branch', '--set-upstream-to', remote], true);
  if (m.code === 0) return { merged: true, conflicts: false };
  if (/CONFLICT|conflict/i.test(m.out + m.err)) return { merged: true, conflicts: true };
  throw new GitError(friendly(m.err));
}

export async function init(folder: string): Promise<void> {
  await git(folder, ['init']);
}

export async function abortMerge(folder: string): Promise<void> {
  await git(folder, ['merge', '--abort']);
}
