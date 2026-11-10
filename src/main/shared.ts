import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { AiProvider, GitAccount, Theme } from '@shared/types';
import { runAsRootLinux } from './linuxadmin';
import { appDataDir, isLinux, isWin } from './platform';

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
 *   Windows: %APPDATA%\Catzoid\shared.json; the AI keys DPAPI-encrypted for the user in Catzoid\keys\<provider>.dpapi
 *   (PowerShell's ConvertFrom-SecureString, as DevCatz and DBCatz), Git tokens in Catzoid\git\<account id>.dpapi
 *   (characters outside [\w.-] in the id become "_"), as DevCatz 1.0.2 for Windows writes them.
 *   Linux: ~/.config/Catzoid/shared.json ($XDG_CONFIG_HOME); the AI keys and Git tokens in the desktop's keyring
 *   through the Secret Service (secret-tool), attributes service + account as above — the same items as DevCatz and DoCatz.
 *
 * CATZOID_SHARED_DIR and CATZOID_KEYCHAIN (a keychain file) point both elsewhere, for tests.
 */

export const SHARED_DIR =
  process.env.CATZOID_SHARED_DIR || appDataDir('Catzoid');
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
    const v = JSON.parse(readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '')) as Shared;
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

/**
 * Windows: a secret encrypted with DPAPI for the current user in Catzoid\keys\<name>.dpapi, so every Catzoid app of the
 * same user reads it, as the Keychain item on macOS (the same files as DevCatz and DBCatz). The secret goes in through
 * stdin, never the command line.
 */
const keyFile = (name: string) => join(SHARED_DIR, 'keys', `${name}.dpapi`);
/** A Git account's token file, as DevCatz names it: Catzoid\git\<id>.dpapi. */
const gitTokenFile = (id: string) => join(SHARED_DIR, 'git', `${id.replace(/[^\w.-]/g, '_')}.dpapi`);
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
function powershell(script: string, input = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ code: 1, out: '' }));
    p.on('close', (c) => resolve({ code: c ?? 1, out }));
    p.stdin.end(input);
  });
}
async function winSecret(file: string): Promise<string> {
  if (!existsSync(file)) return '';
  const r = await powershell(
    `$s = ConvertTo-SecureString (Get-Content -Raw -Path ${psQuote(file)}).Trim(); ` +
      '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
  );
  return r.code === 0 ? r.out.trim() : '';
}
async function setWinSecret(file: string, value: string): Promise<void> {
  if (!value) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  const r = await powershell(
    `$k = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $k -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline -Path ${psQuote(file)}`,
    value,
  );
  if (r.code !== 0) throw new Error('Windows could not store the secret');
}

/**
 * Linux: the desktop's keyring through the Secret Service (secret-tool), attributes service + account — the same
 * items DevCatz and DoCatz read and write. secret-tool is not on a fresh Ubuntu: saving installs it (libsecret-tools)
 * through one password prompt; reading without it finds nothing. The secret goes in on stdin, never in a process list.
 */
function tool(args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    // stdin only when there is something to write: a program that exits without reading it (sh, secret-tool lookup)
    // would make the write fail with EPIPE, an uncaught error (found on Ubuntu, #87).
    const p = spawn(args[0], args.slice(1), { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    p.stdin?.on('error', () => undefined);
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill(), 60_000);
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', () => (clearTimeout(t), resolve({ code: 127, out: '', err: '' })));
    p.on('close', (c) => (clearTimeout(t), resolve({ code: c ?? 1, out, err })));
    if (input !== undefined) p.stdin?.end(input);
  });
}
const hasSecretTool = async () => (await tool(['/bin/sh', '-c', 'command -v secret-tool'])).code === 0;
export async function linuxSecret(service: string, account: string): Promise<string> {
  if (!account || !(await hasSecretTool())) return '';
  const r = await tool(['secret-tool', 'lookup', 'service', service, 'account', account]);
  return r.code === 0 ? r.out.replace(/\n$/, '') : '';
}
export async function setLinuxSecret(service: string, account: string, value: string): Promise<void> {
  if (!value) {
    if (await hasSecretTool()) await tool(['secret-tool', 'clear', 'service', service, 'account', account]);
    return;
  }
  if (!(await hasSecretTool())) {
    const r = await runAsRootLinux(
      'if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libsecret-tools >/dev/null; elif command -v dnf >/dev/null 2>&1; then dnf install -y -q libsecret >/dev/null; elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed libsecret >/dev/null; fi',
    );
    if (r.cancelled) throw new Error('Cancelled: saving needs secret-tool, installed with your password');
    if (!(await hasSecretTool())) throw new Error('Saving needs secret-tool from your package manager (sudo apt install libsecret-tools)');
  }
  const r = await tool(['secret-tool', 'store', `--label=${service} (${account})`, 'service', service, 'account', account], value);
  if (r.code !== 0) throw new Error(`Keyring: ${r.err.trim() || `exit ${r.code}`} (is a keyring such as GNOME Keyring running and unlocked?)`);
}

/** The provider's API key from the shared Keychain item ('' when there is none). Cached for a minute. */
export async function sharedKey(provider: AiProvider): Promise<string> {
  const hit = keyCache.get(provider);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  let key: string;
  if (isWin) key = await winSecret(keyFile(provider));
  else if (isLinux) key = await linuxSecret(SERVICE, provider);
  else {
    const r = await security(['find-generic-password', '-s', SERVICE, '-a', provider, '-w', ...KEYCHAIN]);
    key = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  }
  keyCache.set(provider, { at: Date.now(), key });
  return key;
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item and lists it in shared.json. */
export async function setSharedKey(provider: AiProvider, key: string): Promise<void> {
  const k = key.trim();
  if (isWin) {
    if (/["\\\n\r]/.test(k)) throw new Error('That key has characters an API key does not have');
    await setWinSecret(keyFile(provider), k);
  } else if (isLinux) {
    await setLinuxSecret(SERVICE, provider, k);
  } else if (!k) {
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
  let token: string;
  if (isWin) token = id ? await winSecret(gitTokenFile(id)) : '';
  else if (isLinux) token = await linuxSecret(GIT_SERVICE, id);
  else {
    const r = await security(['find-generic-password', '-s', GIT_SERVICE, '-a', id, '-w', ...KEYCHAIN]);
    token = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  }
  gitTokens.set(id, { at: Date.now(), token });
  return token;
}

/** Saves (or with '' removes) an account's token in the shared Keychain item, through `security -i` (never in a process list). */
export async function setSharedGitToken(id: string, token: string): Promise<void> {
  const t = token.trim();
  if (isWin) {
    if (!id) throw new Error('Bad account id');
    if (/["\\\n\r]/.test(t)) throw new Error('That token has characters a token does not have');
    await setWinSecret(gitTokenFile(id), t);
  } else if (!/^[\w.-]+$/.test(id)) throw new Error('Bad account id');
  else if (isLinux) await setLinuxSecret(GIT_SERVICE, id, t);
  else if (!t) await security(['delete-generic-password', '-s', GIT_SERVICE, '-a', id, ...KEYCHAIN]);
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
