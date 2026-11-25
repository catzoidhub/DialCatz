/**
 * Reports leave the machine (a CI artifact, a pull request's page, an e-mail): secrets do not go into them. What
 * counts as one: the value of a variable whose name says so, a value that looks generated, what OAuth handed out, and
 * — by their own name — headers, query parameters and JSON fields that carry credentials.
 */

const NAME = /(token|secret|passw|passphrase|pwd|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?key|^key$|_key$|Key$|auth|bearer|jwt|cookie|session|credential|signature|csrf|xsrf)/i;
const HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|x-xsrf-token)$/i;
export const HIDDEN = '•••';

export const secretName = (name: string): boolean => NAME.test(name);

/** Long, without spaces, letters and digits mixed: a token someone named "x". Not an address. */
const generated = (v: string) => v.length >= 24 && !/\s/.test(v) && !/^[a-z][\w+.-]*:\/\//i.test(v) && !/^[./~]/.test(v) && /[a-z]/i.test(v) && /\d/.test(v);

/** The values to hide, longest first (one may hold another). */
export function secretValues(vars: Iterable<[string, string]>, more: Iterable<string> = []): string[] {
  const out = new Set<string>();
  for (const [k, v] of vars) if (v && v.length >= 4 && !/^(true|false|null|none)$/i.test(v) && (secretName(k) || generated(v))) out.add(v);
  for (const v of more) if (v && v.length >= 4) out.add(v);
  for (const v of [...out]) for (const form of [encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString('base64')]) out.add(form);
  return [...out].sort((a, b) => b.length - a.length);
}

export type Redact = (text: string) => string;
export function redactor(values: string[]): Redact {
  return (text) => {
    let s = text;
    for (const v of values) if (s.includes(v)) s = s.split(v).join(HIDDEN);
    // user:password@ in an address, and query parameters named like a credential.
    s = s.replace(/([a-z][\w+.-]*:\/\/)[^\s/@?#"'<>]+@/gi, `$1${HIDDEN}@`);
    return s.replace(/([?&])([\w.%[\]-]+)=([^&#\s"'<>]+)/g, (all, sep: string, name: string) => (secretName(name) ? `${sep}${name}=${HIDDEN}` : all));
  };
}

export const redactHeaders = (h: [string, string][], redact: Redact): [string, string][] => h.map(([k, v]) => [k, HEADER.test(k) || secretName(k) ? HIDDEN : redact(v)]);

/** A body: JSON fields and form fields named like a credential are hidden, then the known values. */
export function redactBody(text: string, redact: Redact): string {
  const walk = (x: unknown, key = ''): unknown => {
    if (Array.isArray(x)) return x.map((y) => walk(y, key));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v, k)]));
    return key && secretName(key) && (typeof x === 'string' || typeof x === 'number') ? HIDDEN : x;
  };
  const t = text.trim();
  if (/^[[{]/.test(t)) {
    try {
      return redact(JSON.stringify(walk(JSON.parse(t)), null, 2));
    } catch {
      /* not JSON (or cut short): as text */
    }
  }
  return redact(text)
    .replace(/(^|&)([\w.%[\]-]+)=([^&\s]+)/g, (all, sep: string, name: string) => (secretName(name) ? `${sep}${name}=${HIDDEN}` : all))
    .replace(/("([^"\\]+)"\s*:\s*)"(?:[^"\\]|\\.)*"?/g, (all, head: string, name: string) => (secretName(name) ? `${head}"${HIDDEN}"` : all));
}

/** The values of a JSON answer's fields named like a credential. */
export function secretFields(text: string): string[] {
  if (!/^\s*[[{]/.test(text) || text.length > 2_000_000) return [];
  const out: string[] = [];
  const walk = (x: unknown, key = ''): void => {
    if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) walk(v, Array.isArray(x) ? key : k);
    else if (typeof x === 'string' && x.length >= 8 && !/\s/.test(x) && secretName(key)) out.push(x);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    /* not JSON */
  }
  return out;
}
