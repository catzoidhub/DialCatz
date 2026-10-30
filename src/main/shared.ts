import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiProvider, GitAccount, Theme } from '@shared/types';

/**
 * Settings shared by the Catzoid apps (DevCatz, DBCatz, DialCatz): the theme and the AI connection
 * (provider, models, addresses). One owner-only JSON file every app reads, writes and watches, so a change in
 * one app shows up in the others; API keys sit in one Keychain item ("Catzoid AI", an account per provider)
 * read through macOS's `security` tool — the way git's and gh's credential helpers keep tokens.
 * Kept in step with DevCatz's src/main/shared.ts by hand.
 *
 * Contract (keep it the same in every app):
 *   ~/Library/Application Support/Catzoid/shared.json  (folder 0700, file 0600)
 *   { "version": 1, "theme": "system" | "light" | "dark",
 *     "ai": { "provider": "anthropic", "models": { "<provider>": "<model>" }, "baseUrls": { … }, "keys": ["<provider>", …] },
 *     "updatedBy": "devcatz" | "dbcatz" | "dialcatz", "updatedAt": "<ISO time>" }
 *   Keychain: generic password, service "Catzoid AI", account = provider id, password = the API key.
 *   On / off switches (AI enabled, features) stay in each app.
 *   Git hosting accounts (connected once, used by every Catzoid app):
 *     "git": { "accounts": [ { "id", "kind": "github"|"gitlab"|"gitea"|"bitbucket", "baseUrl", "username", "name",
 *              "avatarUrl" (the remote URL), "addedAt" } ] }
 *   Keychain: generic password, service "Catzoid Git", account = the account id, password = its token.
 *
 * CATZOID_SHARED_DIR and CATZOID_KEYCHAIN (a keychain file) point both elsewhere, for tests.
 */

export const SHARED_DIR = process.env.CATZOID_SHARED_DIR || join(homedir(), 'Library', 'Application Support', 'Catzoid');
const FILE = join(SHARED_DIR, 'shared.json');
const SERVICE = 'Catzoid AI';
const GIT_SERVICE = 'Catzoid Git';
const ME = 'dialcatz';
/** A keychain file instead of the login keychain (tests only). */
const KEYCHAIN = process.env.CATZOID_KEYCHAIN ? [process.env.CATZOID_KEYCHAIN] : [];

export interface SharedAi {
  provider?: AiProvider;
  models?: Partial<Record<AiProvider, string>>;
  baseUrls?: Partial<Record<AiProvider, string>>;
  /** Providers with a key in the Keychain (names only). */
  keys?: AiProvider[];
}
export interface Shared {
  version: 1;
  theme?: Theme;
  ai?: SharedAi;
  /** Git hosting accounts, shared by the Catzoid apps (tokens in the Keychain item "Catzoid Git"). */
  git?: { accounts?: GitAccount[] };
  /** The Catzoid site address the apps build their links from and update from (Catzoid TODO #50); catzoid.com when unset. */
  site?: string;
  updatedBy?: string;
  updatedAt?: string;
}

let cache: Shared | null = null;

export function readShared(): Shared {
  if (cache) return cache;
  try {
    const v = JSON.parse(readFileSync(FILE, 'utf8')) as Shared;
    cache = v && typeof v === 'object' ? { ...v, version: 1 } : { version: 1 };
  } catch {
    cache = { version: 1 };
  }
  return cache;
}

/** Merges `patch` (ai merged one level deep) and writes the file atomically. */
export const DEFAULT_SITE = 'https://catzoid.com';

/**
 * The shared site address (Catzoid TODO #50), without a trailing slash. Only https on catzoid.com or a
 * *.catzoid.tech host counts for now; anything else falls back to catzoid.com until Settings can ask about it.
 */
export function siteBase(): string {
  // a development build may point at a local Catzoid site (CATZOID_SITE=http://127.0.0.1:8099), as DevCatz does
  const dev = !app.isPackaged && process.env.CATZOID_SITE;
  if (dev) {
    try {
      const d = new URL(dev);
      if (/^https?:$/.test(d.protocol)) return d.origin;
    } catch {
      /* not a URL: the usual address */
    }
  }
  const raw = readShared().site;
  try {
    const u = new URL(typeof raw === 'string' ? raw : '');
    if (u.protocol === 'https:' && (u.hostname === 'catzoid.com' || u.hostname.endsWith('.catzoid.tech'))) return u.origin;
  } catch {
    /* not set or not a URL */
  }
  return DEFAULT_SITE;
}

export function writeShared(patch: Partial<Omit<Shared, 'version' | 'ai' | 'git'>> & { ai?: SharedAi; git?: Shared['git'] }): Shared {
  const cur = readShared();
  const next: Shared = { ...cur, ...patch, ai: patch.ai ? { ...(cur.ai ?? {}), ...patch.ai } : cur.ai, git: patch.git ? { ...(cur.git ?? {}), ...patch.git } : cur.git, version: 1, updatedBy: ME, updatedAt: new Date().toISOString() };
  mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SHARED_DIR, 0o700);
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, FILE);
  cache = next;
  lastOwnWrite = next.updatedAt!;
  return next;
}

let lastOwnWrite = '';
let watcher: FSWatcher | null = null;
const listeners: ((s: Shared) => void)[] = [];
/** One more listener for another app's changes (Git accounts …), next to the settings one. */
export const onSharedChange = (fn: (s: Shared) => void) => listeners.push(fn);

/** Calls `onChange` when another app changed the file (own writes are ignored). */
export function watchShared(onChange: (s: Shared) => void): void {
  watcher?.close();
  mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = watch(SHARED_DIR, (_e, name) => {
      if (name && name !== 'shared.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cache = null;
        keyCache.clear();
        gitTokens.clear();
        const s = readShared();
        if (s.updatedAt && s.updatedAt === lastOwnWrite) return;
        onChange(s);
        for (const fn of listeners) fn(s);
      }, 250);
    });
  } catch {
    /* folder vanished: no live updates, the next read still sees changes */
  }
}

export const sharedExists = () => existsSync(FILE);

// ---------------------------------------------------------------- Keychain

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) =>
    execFile('/usr/bin/security', args, { timeout: 15_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') })),
  );
}

const keyCache = new Map<AiProvider, { at: number; key: string }>();

/** The provider's API key from the shared Keychain item ('' when there is none). Cached for a minute. */
export async function sharedKey(provider: AiProvider): Promise<string> {
  const hit = keyCache.get(provider);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  const r = await security(['find-generic-password', '-s', SERVICE, '-a', provider, '-w', ...KEYCHAIN]);
  const key = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  keyCache.set(provider, { at: Date.now(), key });
  return key;
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item and lists it in shared.json. */
export async function setSharedKey(provider: AiProvider, key: string): Promise<void> {
  const k = key.trim();
  if (!k) {
    await security(['delete-generic-password', '-s', SERVICE, '-a', provider, ...KEYCHAIN]);
  } else {
    if (/["\\\n\r]/.test(k)) throw new Error('That key has characters an API key does not have');
    // Through `security -i` (commands on stdin), so the key never appears in a process list.
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain: ${err.trim() || `exit ${c}`}`))));
      p.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${provider}" -l "${SERVICE} (${provider})" -w "${k}"${KEYCHAIN.length ? ` "${KEYCHAIN[0]}"` : ''}\n`);
    });
  }
  keyCache.delete(provider);
  const keys = new Set(readShared().ai?.keys ?? []);
  if (k) keys.add(provider);
  else keys.delete(provider);
  writeShared({ ai: { keys: [...keys] } });
}

// ---------------------------------------------------------------- Git accounts (shared with the Catzoid apps)

/** Connected Git hosting accounts (no tokens). */
export const sharedGitAccounts = (): GitAccount[] => (readShared().git?.accounts ?? []).filter((a) => a && a.id && a.kind && a.baseUrl);

export function setSharedGitAccounts(accounts: GitAccount[]): void {
  writeShared({ git: { accounts } });
}

const gitTokens = new Map<string, { at: number; token: string }>();

/** An account's token from the shared Keychain item ('' when there is none). Cached for a minute. */
export async function sharedGitToken(id: string): Promise<string> {
  const hit = gitTokens.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.token;
  const r = await security(['find-generic-password', '-s', GIT_SERVICE, '-a', id, '-w', ...KEYCHAIN]);
  const token = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  gitTokens.set(id, { at: Date.now(), token });
  return token;
}

/** Saves (or with '' removes) an account's token in the shared Keychain item, through `security -i` (never in a process list). */
export async function setSharedGitToken(id: string, token: string): Promise<void> {
  const t = token.trim();
  if (!/^[\w.-]+$/.test(id)) throw new Error('Bad account id');
  if (!t) await security(['delete-generic-password', '-s', GIT_SERVICE, '-a', id, ...KEYCHAIN]);
  else {
    if (/["\\\n\r]/.test(t)) throw new Error('That token has characters a token does not have');
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain: ${err.trim() || `exit ${c}`}`))));
      p.stdin.end(`add-generic-password -U -s "${GIT_SERVICE}" -a "${id}" -l "${GIT_SERVICE} (${id})" -w "${t}"${KEYCHAIN.length ? ` "${KEYCHAIN[0]}"` : ''}\n`);
    });
  }
  gitTokens.delete(id);
}
