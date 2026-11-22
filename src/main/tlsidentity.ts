/**
 * Client certificates (mutual TLS, #102): the certificate DialCatz shows a server that asks who is calling. Which one
 * goes to which host is decided elsewhere (the app: Settings → Client certificates, main/clientcerts.ts; the CLI: its
 * --cert flags); requests, WebSocket connections, gRPC channels and OAuth token requests ask here.
 */

export interface TlsIdentity {
  /** PEM certificate (chain) and its key … */
  cert?: Buffer;
  key?: Buffer;
  /** … or both in one PKCS#12 file. */
  pfx?: Buffer;
  passphrase?: string;
}

let finder: (host: string, port: string) => TlsIdentity | undefined = () => undefined;
export const setIdentityFinder = (fn: (host: string, port: string) => TlsIdentity | undefined) => (finder = fn);

/** The certificate for a host, as options for node:tls / https / undici; {} when it has none. */
export function identityFor(url: URL | string): TlsIdentity {
  try {
    const u = typeof url === 'string' ? new URL(url) : url;
    if (!['https:', 'wss:', 'grpcs:'].includes(u.protocol)) return {};
    return finder(u.hostname.toLowerCase(), u.port || '443') ?? {};
  } catch {
    return {};
  }
}

/**
 * Whether a certificate set for `pattern` goes to a host: the name itself (api.example.com), a wildcard for its
 * subdomains (*.example.com, any depth), with a port when only that one is meant (api.example.com:8443).
 */
export function hostMatches(pattern: string, host: string, port: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (!p) return false;
  const m = /^(.*?)(?::(\d+))?$/.exec(p)!;
  if (m[2] && m[2] !== port) return false;
  const name = m[1];
  const h = host.toLowerCase();
  return name.startsWith('*.') ? h.endsWith(name.slice(1)) && h.length > name.length - 1 : h === name;
}
