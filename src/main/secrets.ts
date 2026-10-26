import { execFile, spawn } from 'node:child_process';
import { safeStorage } from 'electron';
import { store } from './store';

/**
 * Server tokens in the system's secret store. macOS: a Keychain generic password (service "DialCatz Den",
 * account = the connection id), through `/usr/bin/security` with the secret on stdin, never in argv — the same
 * way shared.ts keeps the AI keys. Elsewhere (Windows / Linux, until the Credential Manager is wired): encrypted with
 * Electron's safeStorage in config.json.
 */

const SERVICE = 'DialCatz Den';
const KEYCHAIN = process.env.CATZOID_KEYCHAIN ? [process.env.CATZOID_KEYCHAIN] : [];
const FALLBACK = 'serverTokens';
const mac = process.platform === 'darwin' && !process.env.DIALCATZ_NO_KEYCHAIN;

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => execFile('/usr/bin/security', args, { timeout: 15_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') })));
}

const cache = new Map<string, string>();

export async function getToken(account: string): Promise<string> {
  if (cache.has(account)) return cache.get(account)!;
  let token = '';
  if (mac) {
    const r = await security(['find-generic-password', '-s', SERVICE, '-a', account, '-w', ...KEYCHAIN]);
    token = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  } else {
    const v = store.extra<Record<string, string>>(FALLBACK)?.[account];
    token = v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
  }
  if (token) cache.set(account, token);
  return token;
}

export async function setToken(account: string, token: string): Promise<void> {
  if (!/^[\w.-]+$/.test(account)) throw new Error('Bad secret account name');
  if (/["\\\n\r\s]/.test(token)) throw new Error('That token has characters a DialCatz token does not have');
  if (mac) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 && !err.trim() ? resolve() : reject(new Error(`Secret store: ${err.trim() || `exit ${c}`}`))));
      p.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${account}" -l "${SERVICE} (${account})" -w "${token}"${KEYCHAIN.length ? ` "${KEYCHAIN[0]}"` : ''}\n`);
    });
  } else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('No secret store available on this system');
    const all = { ...(store.extra<Record<string, string>>(FALLBACK) ?? {}) };
    all[account] = safeStorage.encryptString(token).toString('base64');
    store.setExtra(FALLBACK, all);
  }
  cache.set(account, token);
}

export async function deleteToken(account: string): Promise<void> {
  cache.delete(account);
  if (mac) await security(['delete-generic-password', '-s', SERVICE, '-a', account, ...KEYCHAIN]);
  else {
    const all = { ...(store.extra<Record<string, string>>(FALLBACK) ?? {}) };
    delete all[account];
    store.setExtra(FALLBACK, all);
  }
}
