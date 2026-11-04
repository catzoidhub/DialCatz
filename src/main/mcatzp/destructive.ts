import type { CallResult } from '@catzoid/mcatzp-host';
import type { DialCatzApi, GitRepoEntry, Workspace, WorkspaceSummary } from '@shared/types';
import { isSecretVar, pick, placeOf, reply, type Scopes, underCollection } from './actions';
import type { ChangeAction, McatzpPage } from './changes';
import { SECRET_NAME } from './mask';

/**
 * What is really gone or rewrites history (TODO #80): the user types a name, every time, checked again in the main
 * process, and "allow for this session" is never offered. What can be had back is a change with one dialog (removing a
 * group or a repository from the list). After Allow the app never opens what is being removed.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const S = (description: string, maxLength = 512) => ({ type: 'string', minLength: 1, maxLength, description });
const WORKSPACE = S("The workspace's id or name (see list_workspaces).");
const REPO = S("The repository's id or name (see list_git_repos).");
type Fact = { label: string; value: string };
type Q = { title: string; facts: Fact[]; page: McatzpPage | null; typeName?: string };
const short = (t: string, m = 500) => (t.length > m ? `${t.slice(0, m)}…` : t);
const done = (data: unknown): CallResult => reply(data);
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);

/** Things `api` does with a native dialog of its own: here the question has been asked already. */
export interface DirectGit {
  gitDiscard(id: string, files: string[]): Promise<void>;
}

export function destructiveActions(api: DialCatzApi, scopes: Scopes, direct: DirectGit): ChangeAction[] {
  if (!scopes.changes) return [];
  const shared = async (): Promise<WorkspaceSummary[]> => (await api.workspaces()).filter((w) => scopes.workspace(w.id));
  const workspaceOf = async (ref: unknown): Promise<Workspace> => {
    const w = await api.workspace(pick(await shared(), String(ref), 'shared workspace', 'list_workspaces').id);
    if (w.serverId && w.role === 'viewer') throw new Error(`${w.name} is read-only for you: your role is Viewer`);
    return w;
  };
  const repoOf = async (ref: unknown): Promise<GitRepoEntry> => pick((await api.gitState()).repos, String(ref), 'repository', 'list_git_repos');
  const branchOf = async (r: GitRepoEntry) => {
    const b = (await api.gitStatus(r.id))?.branch;
    if (!b) throw new Error(`${r.name} has no current branch: check it out first`);
    return b;
  };

  /** The real thing is gone: the user types a name, every time. */
  const typed = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], preview: (a: Record<string, unknown>) => Promise<Q & { typeName: string }>, run: ChangeAction['run']): ChangeAction => ({ name, title, description: `${description} The user types a name in DialCatz to allow it, every time.`, tier: 'destructive', input: OBJECT(props, required), preview, run });
  const asked = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], preview: (a: Record<string, unknown>) => Promise<Q>, run: ChangeAction['run']): ChangeAction => ({ name, title, description: `${description} DialCatz asks the user first.`, tier: 'change', input: OBJECT(props, required), preview, run });
  const git = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], ask: (r: GitRepoEntry, a: Record<string, unknown>) => Promise<{ title: string; facts: Fact[]; typeName: string }>, run: (r: GitRepoEntry, a: Record<string, unknown>) => Promise<unknown>): ChangeAction =>
    typed(name, title, description, { repo: REPO, ...props }, ['repo', ...required], async (a) => {
      const r = await repoOf(a.repo);
      const q = await ask(r, a);
      return { ...q, facts: [{ label: 'Repo', value: r.name }, ...q.facts], page: { section: 'git' } };
    }, async (a) => done((await run(await repoOf(a.repo), a)) ?? { done: true }));

  const items = (w: Workspace, kind: 'collection' | 'folder' | 'request', ref: unknown) => pick(w.items.filter((i) => i.kind === kind), String(ref), kind, kind === 'request' ? 'list_requests' : 'list_collections');
  const deleteItem = (kind: 'collection' | 'folder' | 'request') =>
    typed(`delete_${kind}`, `Delete a ${kind}`, kind === 'request' ? 'Deletes a saved request.' : `Deletes a ${kind} and everything in it.`, { workspace: WORKSPACE, [kind]: S(`The ${kind}'s id, or its name when only one has it.`) }, ['workspace', kind], async (a) => {
      const w = await workspaceOf(a.workspace);
      const i = items(w, kind, a[kind]);
      const inside = underCollection(w.items, i.id);
      return { title: `Delete ${kind} ${i.name}?`, facts: [{ label: 'In', value: [w.name, ...placeOf(w.items, i)].join(' / ') }, ...(kind === 'request' ? [] : [{ label: 'Goes', value: `${inside.filter((x) => x.kind === 'request').length} requests, ${inside.filter((x) => x.kind === 'folder').length} folders` }]), ...fact('Team', w.serverId ? 'It goes for your whole team' : w.folder ? 'Its files go from the folder' : null)], page: { workspaceId: w.id, section: 'requests' }, typeName: i.name };
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      await api.deleteItems(w.id, [items(w, kind, a[kind]).id]);
      return done({ deleted: true });
    });

  const list: ChangeAction[] = [
    deleteItem('request'),
    deleteItem('folder'),
    deleteItem('collection'),
    typed('delete_environment', 'Delete an environment', 'Deletes an environment and its values, which cannot be read back.', { workspace: WORKSPACE, environment: S("The environment's id or name (see list_environments).") }, ['workspace', 'environment'], async (a) => {
      const w = await workspaceOf(a.workspace);
      const e = pick(w.environments, String(a.environment), 'environment', 'list_environments');
      const users = w.items.filter((i) => i.kind === 'collection' && i.environmentId === e.id);
      return { title: `Delete environment ${e.name}?`, facts: [{ label: 'Goes', value: `${e.variables.length} variable(s), ${e.variables.filter(isSecretVar).length} secret` }, ...fact('Used by', users.map((c) => c.name).join(', ') || null), ...fact('Team', w.serverId ? 'It goes for your whole team' : null)], page: { workspaceId: w.id, section: 'environments' }, typeName: e.name };
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      await api.deleteEnvironment(w.id, pick(w.environments, String(a.environment), 'environment', 'list_environments').id);
      return done({ deleted: true });
    }),
    typed('delete_workspace', 'Delete a workspace', "Deletes a personal workspace from this computer: collections, environments and values. A folder workspace's files stay in the folder. A team workspace is hidden from the Team page or deleted in its Den instead.", { workspace: WORKSPACE }, ['workspace'], async (a) => {
      const w = await workspaceOf(a.workspace);
      if (w.serverId) throw new Error(`${w.name} is a team workspace: it is hidden with show_team_workspace, and deleted in its DialCatz Den`);
      return { title: `Delete workspace ${w.name}?`, facts: [{ label: 'Goes', value: `${w.items.filter((i) => i.kind === 'collection').length} collections, ${w.items.filter((i) => i.kind === 'request').length} requests, ${w.environments.length} environments` }, ...fact('Stays', w.folder ? 'The files in its folder' : null)], page: null, typeName: w.name };
    }, async (a) => {
      await api.deleteWorkspace((await workspaceOf(a.workspace)).id);
      return done({ deleted: true });
    }),
    typed('disconnect_team_server', 'Leave a team server', "Disconnects from a DialCatz Den: its workspaces leave this computer, unsent changes with them. The Den and your team's copies stay.", { server: S('The id from list_team_servers.') }, ['server'], async (a) => {
      const s = (await api.servers()).find((x) => x.id === a.server);
      if (!s) throw new Error(`No server ${String(a.server)} (list_team_servers shows them)`);
      const host = new URL(s.url).host;
      return { title: `Leave ${host}?`, facts: [{ label: 'Goes', value: `${s.workspaceIds.length} team workspaces from this computer` }, { label: 'Stays', value: 'The Den and your team’s copies' }], page: { section: 'team' }, typeName: host };
    }, async (a) => {
      await api.disconnectServer(String(a.server));
      return done({ disconnected: true });
    }),
    {
      ...asked('remove_variables', 'Remove variables', 'Removes variables from an environment, or the globals when none is named. A secret one asks for its name to be typed: its value cannot be read back.', { workspace: WORKSPACE, environment: S("The environment's id or name; left out: the globals."), names: { type: 'array', minItems: 1, maxItems: 200, items: S('A variable.', 200) } }, ['workspace', 'names'], async (a) => {
        const w = await workspaceOf(a.workspace);
        const e = a.environment ? pick(w.environments, String(a.environment), 'environment', 'list_environments') : null;
        const names = a.names as string[];
        const all = e?.variables ?? w.globals;
        const missing = names.filter((n) => !all.some((v) => v.key.trim() === n));
        if (missing.length) throw new Error(`No variable ${missing.join(', ')} in ${e?.name ?? 'the globals'}`);
        const secret = all.filter((v) => names.includes(v.key.trim()) && (isSecretVar(v) || SECRET_NAME.test(v.key)));
        return { title: `Remove ${names.length === 1 ? names[0] : `${names.length} variables`} from ${e?.name ?? 'the globals'}?`, facts: [{ label: 'Goes', value: short(names.join(', ')) }, ...fact('Secret', secret.length ? `${secret.map((v) => v.key).join(', ')}: the value cannot be read back` : null)], page: { workspaceId: w.id, section: 'environments' }, ...(secret.length ? { typeName: secret[0].key.trim() } : {}) };
      }, async (a) => {
        const w = await workspaceOf(a.workspace);
        const names = new Set(a.names as string[]);
        if (a.environment) {
          const e = pick(w.environments, String(a.environment), 'environment', 'list_environments');
          await api.saveEnvironment(w.id, { ...e, variables: e.variables.filter((v) => !names.has(v.key.trim())) });
        } else await api.saveGlobals(w.id, w.globals.filter((v) => !names.has(v.key.trim())));
        return done({ removed: [...names] });
      }),
    },
    asked('rename_group', 'Rename a sidebar group', 'Gives a group of collections a new name.', { workspace: WORKSPACE, group: S('The group’s name.', 200), name: S('The new name.', 200) }, ['workspace', 'group', 'name'], async (a) => {
      const w = await workspaceOf(a.workspace);
      return { title: `Rename group ${String(a.group)} to ${String(a.name)}?`, facts: [], page: { workspaceId: w.id, section: 'requests' } };
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const g = w.layout.groups.find((x) => x.name === a.group);
      if (!g) throw new Error(`No group ${String(a.group)} (list_collections shows them)`);
      await api.saveLayout(w.id, { ...w.layout, groups: w.layout.groups.map((x) => (x.id === g.id ? { ...x, name: String(a.name) } : x)) });
      return done({ renamed: true });
    }),
    asked('delete_group', 'Delete a sidebar group', 'Removes a group; its collections stay, ungrouped.', { workspace: WORKSPACE, group: S('The group’s name.', 200) }, ['workspace', 'group'], async (a) => {
      const w = await workspaceOf(a.workspace);
      if (!w.layout.groups.some((x) => x.name === a.group)) throw new Error(`No group ${String(a.group)} (list_collections shows them)`);
      return { title: `Delete group ${String(a.group)}?`, facts: [{ label: 'Stays', value: 'Its collections, ungrouped' }], page: { workspaceId: w.id, section: 'requests' } };
    }, async (a) => {
      const w = await workspaceOf(a.workspace);
      const g = w.layout.groups.find((x) => x.name === a.group);
      if (!g) throw new Error(`No group ${String(a.group)} (list_collections shows them)`);
      await api.saveLayout(w.id, { ...w.layout, groups: w.layout.groups.filter((x) => x.id !== g.id), groupOf: Object.fromEntries(Object.entries(w.layout.groupOf).filter(([, v]) => v !== g.id)) });
      return done({ deleted: true });
    }),
    ...(scopes.responses
      ? [
          typed('clear_history', 'Clear the history', 'Deletes the whole History list, of every workspace.', {}, [], async () => {
            const n = (await api.history()).length;
            return { title: 'Clear the history?', facts: [{ label: 'Goes', value: `${n} entries, of every workspace` }], page: null, typeName: 'history' };
          }, async () => {
            await api.clearHistory();
            return done({ cleared: true });
          }),
        ]
      : []),
  ];

  const gitTools: ChangeAction[] = [
    asked('git_repo_remove', 'Take a repository off the list', 'Takes it out of the Git section; its files stay.', { repo: REPO }, ['repo'], async (a) => {
      const r = await repoOf(a.repo);
      return { title: `Take ${r.name} off the list?`, facts: [{ label: 'Stays', value: 'Its files' }], page: { section: 'git' } };
    }, async (a) => {
      await api.gitRepoRemove((await repoOf(a.repo)).id);
      return done({ removed: true });
    }),
    git('git_discard', 'Discard changes', 'Throws away the changes in these files; untracked ones are deleted. They cannot be had back.', { files: { type: 'array', minItems: 1, maxItems: 200, items: S('A path from git_status.', 1000) } }, ['files'], async (r, a) => {
      const f = a.files as string[];
      return { title: `Throw away the changes in ${f.length === 1 ? f[0] : `${f.length} files`}?`, facts: [{ label: 'Goes', value: short(f.join(', ')) }], typeName: r.name };
    }, (r, a) => direct.gitDiscard(r.id, a.files as string[])),
    git('git_reset', 'Reset a branch', 'Moves the current branch to a commit. Hard also throws away uncommitted changes.', { mode: { type: 'string', enum: ['soft', 'mixed', 'hard'] }, sha: S('The commit (git_log).', 100) }, ['mode', 'sha'], async (r, a) => {
      const b = await branchOf(r);
      return { title: `Reset ${b} to ${String(a.sha).slice(0, 10)}?`, facts: [{ label: 'Mode', value: String(a.mode) }, ...fact('Goes', a.mode === 'hard' ? 'Uncommitted changes, and the commits after it' : 'The commits after it, from this branch')], typeName: b };
    }, (r, a) => api.gitReset(r.id, a.mode as 'soft' | 'mixed' | 'hard', String(a.sha))),
    git('git_squash', 'Squash commits', "Squashes the branch's commits since it left another branch into one. This rewrites history.", { onto: S('The branch.', 300), message: S('The commit message.', 5000) }, ['onto', 'message'], async (r, a) => {
      const b = await branchOf(r);
      return { title: `Squash ${b}?`, facts: [{ label: 'Since', value: String(a.onto) }, { label: 'Message', value: short(String(a.message), 300) }], typeName: b };
    }, (r, a) => api.gitSquash(r.id, String(a.onto), String(a.message))),
    git('git_amend', 'Amend the last commit', 'Replaces the last commit with what is staged and this message. This rewrites history.', { message: S('The commit message.', 5000) }, ['message'], async (r, a) => {
      const b = await branchOf(r);
      return { title: `Replace the last commit on ${b}?`, facts: [{ label: 'Message', value: short(String(a.message), 300) }], typeName: b };
    }, (r, a) => api.gitCommit(r.id, String(a.message), true)),
    git('git_force_push', 'Force push', "Overwrites the remote branch with this one (with lease). Others' commits there can be lost.", {}, [], async (r) => {
      const b = await branchOf(r);
      return { title: `Force push ${b}?`, facts: [{ label: 'Goes', value: 'Commits on the remote that are not here' }], typeName: b };
    }, (r) => api.gitSync(r.id, 'push-force')),
    git('git_branch_delete', 'Delete a branch', 'Deletes a local branch. `force` also deletes one not merged yet, whose commits can be lost.', { name: S('The branch.', 300), force: { type: 'boolean' } }, ['name'], async (_r, a) => ({ title: `Delete the branch ${String(a.name)}?`, facts: fact('Force', a.force ? 'Even when not merged: its commits can be lost' : null), typeName: String(a.name) }), (r, a) => api.gitBranch(r.id, a.force ? 'force-delete' : 'delete', String(a.name))),
    git('git_tag_delete', 'Delete a tag', 'Deletes a local tag.', { name: S('The tag.', 300) }, ['name'], async (_r, a) => ({ title: `Delete the tag ${String(a.name)}?`, facts: [], typeName: String(a.name) }), (r, a) => api.gitTag(r.id, 'delete', String(a.name))),
    git('git_stash_drop', 'Drop a stash', 'Deletes a stash from git_stashes.', { stash: { type: 'string', pattern: '^stash@\\{\\d+\\}$', description: 'Its ref, like stash@{0}.' } }, ['stash'], async (_r, a) => ({ title: `Drop ${String(a.stash)}?`, facts: [], typeName: String(a.stash) }), (r, a) => api.gitStash(r.id, 'drop', String(a.stash))),
    git('git_restore_file', 'Restore a file from a commit', "Replaces a file with its version in a commit; its current content goes.", { file: S('The path.', 1000), sha: S('The commit.', 100) }, ['file', 'sha'], async (_r, a) => ({ title: `Replace ${String(a.file)} with its version in ${String(a.sha).slice(0, 10)}?`, facts: [{ label: 'Goes', value: 'Its current content' }], typeName: String(a.file).split(/[\\/]/).pop()! }), (r, a) => api.gitRestoreFile(r.id, String(a.file), String(a.sha))),
    git('git_worktree_remove', 'Remove a worktree', 'Removes a worktree and its folder. `force` also throws away its uncommitted changes.', { branch: S('Its branch (git_worktrees).', 300), force: { type: 'boolean' } }, ['branch'], async (r, a) => {
      const w = (await api.gitWorktrees(r.id)).find((x) => x.branch === a.branch);
      if (!w) throw new Error(`No worktree on ${String(a.branch)} (git_worktrees shows them)`);
      if (w.main) throw new Error('That is the main worktree: it cannot be removed');
      return { title: `Remove the worktree of ${String(a.branch)}?`, facts: [{ label: 'Goes', value: 'Its folder' }, ...fact('Lost', w.unpushed ? `${w.unpushed} commits not pushed` : null), ...fact('Force', a.force ? 'Its uncommitted changes go too' : null)], typeName: String(a.branch) };
    }, async (r, a) => {
      const w = (await api.gitWorktrees(r.id)).find((x) => x.branch === a.branch);
      if (!w) throw new Error(`No worktree on ${String(a.branch)} (git_worktrees shows them)`);
      await api.gitWorktreeRemove(r.id, w.path, a.force === true);
    }),
  ];

  return [...list, ...(scopes.git ? gitTools : [])];
}
