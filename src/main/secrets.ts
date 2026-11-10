import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { linuxSecret, setLinuxSecret } from './shared';
import { store } from './store';

/**
 * DialCatz Den tokens in the system's own credential store, one item per connection (account = the connection id):
 * - macOS: a Keychain generic password, service "DialCatz Den", through `/usr/bin/security` with the token on stdin.
 * - Windows (#3, 2026-11-10): Credential Manager, a generic credential with target "DialCatz Den:<id>" and user name
 *   <id> (Windows Credentials in Control Panel), written and read through advapi32 CredWrite / CredRead from
 *   PowerShell with the token on stdin.
 * - Linux (#87): the desktop's keyring through the Secret Service (secret-tool), attributes service "DialCatz Den" +
 *   account <id>, as the shared AI keys; secret-tool is installed with one password prompt when missing.
 * Tokens saved before in config.json (Electron safeStorage, Windows and Linux) move to the store the first time they are
 * read, and leave config.json. DIALCATZ_NO_KEYCHAIN=1 keeps them in config.json on every OS (tests).
 */

const SERVICE = 'DialCatz Den';
const KEYCHAIN = process.env.CATZOID_KEYCHAIN ? [process.env.CATZOID_KEYCHAIN] : [];
const FALLBACK = 'serverTokens';
const own = !process.env.DIALCATZ_NO_KEYCHAIN;
const mac = process.platform === 'darwin' && own;
const win = process.platform === 'win32' && own;
const linux = process.platform === 'linux' && own;

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => execFile('/usr/bin/security', args, { timeout: 15_000 }, (err, stdout) => resolve({ code: err ? 1 : 0, stdout: String(stdout ?? '') })));
}

// ---------------------------------------------------------------- Windows Credential Manager

const winTarget = (account: string) => `${SERVICE}:${account}`;
/** advapi32's credential functions for PowerShell: CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE, the token as UTF-16. */
const CRED_CS = `
using System; using System.Runtime.InteropServices; using System.Text;
public static class DcCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL c, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, int type, int flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, string user, string secret) {
    byte[] b = Encoding.Unicode.GetBytes(secret);
    CREDENTIAL c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.UserName = user; c.Persist = 2;
    c.CredentialBlobSize = b.Length; c.CredentialBlob = Marshal.AllocHGlobal(b.Length);
    try { Marshal.Copy(b, 0, c.CredentialBlob, b.Length); if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(); }
    finally { Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static string Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) return "";
    try { CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); return Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2); }
    finally { CredFree(p); }
  }
  public static void Delete(string target) { CredDeleteW(target, 1, 0); }
}`;
/**
 * One PowerShell run of a small script file (the C# above and the action; no secret in it): the target comes as an
 * argument, the token on stdin — never on a command line or in a file.
 */
let scriptFile: string | null = null;
function credScript(): string {
  if (scriptFile && existsSync(scriptFile)) return scriptFile;
  const dir = mkdtempSync(join(tmpdir(), 'dialcatz-cred-'));
  scriptFile = join(dir, 'cred.ps1');
  writeFileSync(
    scriptFile,
    `param([string]$Action, [string]$Target, [string]$User)\n$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @"\n${CRED_CS}\n"@\n` +
      `if ($Action -eq 'read') { [Console]::Out.Write([DcCred]::Read($Target)) }\n` +
      `elseif ($Action -eq 'write') { $t = [Console]::In.ReadToEnd().Trim(); [DcCred]::Write($Target, $User, $t) }\n` +
      `elseif ($Action -eq 'delete') { [DcCred]::Delete($Target) }\n`,
    { mode: 0o600 },
  );
  return scriptFile;
}
function credPs(action: 'read' | 'write' | 'delete', account: string, input = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', credScript(), action, winTarget(account), account], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.stdin.on('error', () => undefined);
    p.on('error', (e) => resolve({ code: 1, out: '', err: e.message }));
    p.on('close', (c) => resolve({ code: c ?? 1, out, err }));
    p.stdin.end(input);
  });
}
async function winRead(account: string): Promise<string> {
  const r = await credPs('read', account);
  return r.code === 0 ? r.out.replace(/\r?\n$/, '') : '';
}
async function winWrite(account: string, token: string): Promise<void> {
  const r = await credPs('write', account, token);
  if (r.code !== 0) throw new Error(`Windows Credential Manager: ${r.err.trim().split('\n')[0] || `exit ${r.code}`}`);
}
async function winDelete(account: string): Promise<void> {
  await credPs('delete', account);
}

// ---------------------------------------------------------------- the store, whichever it is

const cache = new Map<string, string>();

/** A token kept in config.json by an older DialCatz (safeStorage), or there now with DIALCATZ_NO_KEYCHAIN. */
function fromConfig(account: string): string {
  const v = store.extra<Record<string, string>>(FALLBACK)?.[account];
  try {
    return v && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : '';
  } catch {
    return '';
  }
}
function dropFromConfig(account: string): void {
  const all = { ...(store.extra<Record<string, string>>(FALLBACK) ?? {}) };
  if (!(account in all)) return;
  delete all[account];
  store.setExtra(FALLBACK, all);
}

async function readStore(account: string): Promise<string> {
  if (mac) {
    const r = await security(['find-generic-password', '-s', SERVICE, '-a', account, '-w', ...KEYCHAIN]);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  }
  if (win) return winRead(account);
  if (linux) return linuxSecret(SERVICE, account);
  return fromConfig(account);
}

async function writeStore(account: string, token: string): Promise<void> {
  if (mac) {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('error', reject);
      p.on('close', (c) => (c === 0 && !err.trim() ? resolve() : reject(new Error(`Secret store: ${err.trim() || `exit ${c}`}`))));
      p.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${account}" -l "${SERVICE} (${account})" -w "${token}"${KEYCHAIN.length ? ` "${KEYCHAIN[0]}"` : ''}\n`);
    });
  } else if (win) await winWrite(account, token);
  else if (linux) await setLinuxSecret(SERVICE, account, token);
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('No secret store available on this system');
    const all = { ...(store.extra<Record<string, string>>(FALLBACK) ?? {}) };
    all[account] = safeStorage.encryptString(token).toString('base64');
    store.setExtra(FALLBACK, all);
  }
}

export async function getToken(account: string): Promise<string> {
  if (cache.has(account)) return cache.get(account)!;
  let token = await readStore(account);
  // An older DialCatz kept it in config.json: it moves to the credential store now (kept there if the move fails).
  if (!token && (win || linux)) {
    const old = fromConfig(account);
    if (old) {
      token = old;
      try {
        await writeStore(account, old);
        dropFromConfig(account);
      } catch {
        /* the store is not available: the token keeps working from config.json */
      }
    }
  }
  if (token) cache.set(account, token);
  return token;
}

export async function setToken(account: string, token: string): Promise<void> {
  if (!/^[\w.-]+$/.test(account)) throw new Error('Bad secret account name');
  if (/["\\\n\r\s]/.test(token)) throw new Error('That token has characters a DialCatz token does not have');
  await writeStore(account, token);
  if (win || linux) dropFromConfig(account);
  cache.set(account, token);
}

export async function deleteToken(account: string): Promise<void> {
  cache.delete(account);
  if (mac) await security(['delete-generic-password', '-s', SERVICE, '-a', account, ...KEYCHAIN]);
  else if (win) await winDelete(account);
  else if (linux) await setLinuxSecret(SERVICE, account, '');
  dropFromConfig(account);
}

/** Where the tokens are kept, in words for the window (Uninstall's list). */
export const tokenStore = (): string =>
  mac ? 'Keychain items “DialCatz Den”' : win ? 'Windows Credential Manager, “DialCatz Den:…”' : linux ? 'the keyring, “DialCatz Den”' : 'the data folder';
