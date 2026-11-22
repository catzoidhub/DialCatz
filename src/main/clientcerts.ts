import { safeStorage } from 'electron';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import type { ClientCert, ClientCertInput } from '@shared/types';
import { store } from './store';
import { hostMatches, setIdentityFinder, type TlsIdentity } from './tlsidentity';

/**
 * Client certificates (#102, Settings → Client certificates): which certificate DialCatz shows which host, for APIs
 * that ask for one (mutual TLS). A PEM certificate with its key, or a PKCS#12 file (.p12 / .pfx), with a passphrase
 * when the key has one. The files stay where they are and are read when a request needs them, so a renewed
 * certificate is picked up by itself. Kept on this computer only (config.json → clientCerts): never part of a
 * workspace, a folder or the Den. The passphrase is encrypted for this user (safeStorage); where nothing can encrypt
 * it, it is held until DialCatz quits and asked again next time.
 */

const KEY = 'clientCerts';
interface Stored {
  id: string;
  host: string;
  kind: 'pem' | 'pfx';
  certFile: string;
  keyFile: string;
  pfxFile: string;
  /** enc:<base64> (safeStorage), raw:<text> (tests), '' none or held in memory. */
  passphrase: string;
}

const testStore = !!process.env.DIALCATZ_NO_KEYCHAIN;
const canEncrypt = () => !testStore && safeStorage.isEncryptionAvailable();
const held = new Map<string, string>();
const stored = (): Stored[] => (store.extra<Stored[]>(KEY) ?? []).filter((c) => c && typeof c.id === 'string');

function passphraseOf(c: Stored): string {
  if (held.has(c.id)) return held.get(c.id)!;
  if (c.passphrase.startsWith('raw:')) return c.passphrase.slice(4);
  if (!c.passphrase.startsWith('enc:')) return '';
  try {
    return safeStorage.decryptString(Buffer.from(c.passphrase.slice(4), 'base64'));
  } catch {
    return '';
  }
}

/** What OpenSSL says, in words that help. */
function explain(e: unknown): string {
  const raw = String((e as Error).message ?? e);
  // OpenSSL and BoringSSL (Electron's) word the same faults differently: "bad decrypt" / "INCORRECT_PASSWORD".
  const m = raw.replace(/_/g, ' ').toLowerCase();
  if (/bad decrypt|mac verify failure|incorrect password|bad password|wrong password|interrupted or cancelled/.test(m)) return 'The passphrase does not open it (or it has one and none was given)';
  if (/bad pkcs12|pkcs12/.test(m)) return 'That is not a PKCS#12 file this can read (or its passphrase is wrong)';
  if (/key values mismatch/.test(m)) return 'That key does not belong to that certificate';
  if (/no start line|not enough data|wrong tag|header too long|unsupported|bad base64|asn1/.test(m)) return 'That file is not a certificate or key in the chosen format';
  return raw.replace(/^error:[0-9A-F]+:/i, '').slice(0, 200);
}

/** The files as node:tls takes them; throws with the reason when they cannot be used. */
function load(c: Stored, passphrase: string): TlsIdentity {
  const read = (file: string, what: string) => {
    if (!file) throw new Error(`Choose the ${what}`);
    if (!existsSync(file)) throw new Error(`The ${what} is no longer at ${file}`);
    if (statSync(file).size > 1024 * 1024) throw new Error(`The ${what} is larger than 1 MB`);
    return readFileSync(file);
  };
  const id: TlsIdentity = c.kind === 'pfx' ? { pfx: read(c.pfxFile, 'PKCS#12 file') } : { cert: read(c.certFile, 'certificate'), key: read(c.keyFile, 'key') };
  if (passphrase) id.passphrase = passphrase;
  try {
    createSecureContext(id);
  } catch (e) {
    throw new Error(explain(e));
  }
  return id;
}

const out = (c: Stored): ClientCert => {
  let problem: string | null = null;
  try {
    load(c, passphraseOf(c));
  } catch (e) {
    problem = (e as Error).message;
  }
  return { id: c.id, host: c.host, kind: c.kind, certFile: c.certFile, keyFile: c.keyFile, pfxFile: c.pfxFile, hasPassphrase: !!passphraseOf(c), problem };
};

export const list = (): ClientCert[] => stored().map(out);

export function save(input: ClientCertInput): ClientCert[] {
  const all = stored();
  const before = input.id ? all.find((c) => c.id === input.id) : undefined;
  const host = String(input.host ?? '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (!/^(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) throw new Error('The host is a name like api.example.com, *.example.com for its subdomains, or with a port: api.example.com:8443');
  if (all.some((c) => c.host === host && c.id !== before?.id)) throw new Error(`${host} already has a certificate`);
  const kind = input.kind === 'pfx' ? 'pfx' : 'pem';
  const c: Stored = { id: before?.id ?? `cc_${randomBytes(6).toString('hex')}`, host, kind, certFile: kind === 'pem' ? String(input.certFile ?? '') : '', keyFile: kind === 'pem' ? String(input.keyFile ?? '') : '', pfxFile: kind === 'pfx' ? String(input.pfxFile ?? '') : '', passphrase: before?.passphrase ?? '' };
  // undefined: the passphrase stays; '' removes it.
  const passphrase = input.passphrase === undefined ? (before ? passphraseOf(before) : '') : String(input.passphrase);
  load(c, passphrase); // refuses a pair that cannot be used, with the reason
  held.delete(c.id);
  if (!passphrase) c.passphrase = '';
  else if (testStore) c.passphrase = `raw:${passphrase}`;
  else if (canEncrypt()) c.passphrase = `enc:${safeStorage.encryptString(passphrase).toString('base64')}`;
  else (c.passphrase = ''), held.set(c.id, passphrase);
  store.setExtra(KEY, before ? all.map((x) => (x.id === c.id ? c : x)) : [...all, c]);
  return list();
}

export function remove(id: string): ClientCert[] {
  held.delete(id);
  store.setExtra(KEY, stored().filter((c) => c.id !== id));
  return list();
}

/** Hosts that have one, for clients and reports: never a path or a passphrase. */
export const hosts = (): string[] => stored().map((c) => c.host);

// The exact name before a wildcard; a certificate that cannot be read is left out (the server then says so).
setIdentityFinder((host, port) => {
  const match = stored()
    .filter((c) => hostMatches(c.host, host, port))
    .sort((a, b) => Number(a.host.startsWith('*.')) - Number(b.host.startsWith('*.')) || b.host.length - a.host.length)[0];
  if (!match) return undefined;
  try {
    return load(match, passphraseOf(match));
  } catch (e) {
    console.warn(`client certificate for ${match.host}: ${(e as Error).message}`);
    return undefined;
  }
});
