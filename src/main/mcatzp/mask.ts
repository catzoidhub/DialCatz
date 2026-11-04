import type { EnvVariable, TreeItem, Workspace } from '@shared/types';

/**
 * What keeps secrets out of what a client reads. By name alone is not enough: a response can echo a token under any
 * name (httpbin's headers), a body may hold `{ "name": "password", "value": "x" }`, a history URL holds the value a
 * variable filled in. So there are two nets: the values DialCatz itself knows are secret are taken out wherever they
 * appear (as they are, URL-encoded, in base64), and what looks like a secret by its name or shape goes too.
 */
export const MASK = '•••';
export const SECRET_NAME = /passw(or)?d|passphrase|\bpwd\b|secret|token|api[-_ ]?key|apikey|access[-_ ]?key|private[-_ ]?key|credential|authori[sz]ation|\bauth\b|cookie|session|\bjwt\b|\bsalt\b|\botp\b|\bcsrf\b|\bxsrf\b|\bdsn\b/i;

const encodings = (v: string): string[] => [v, encodeURIComponent(v), Buffer.from(v).toString('base64'), Buffer.from(v).toString('base64url')];

/** Too short to be told from ordinary text ("1", "yes"): it goes out by name only. */
const MIN_SECRET = 4;

function add(out: Set<string>, value: string | undefined): void {
  if (!value || value.length < MIN_SECRET) return;
  for (const e of encodings(value)) out.add(e);
}

const variableIsSecret = (v: EnvVariable) => v.secret || SECRET_NAME.test(v.key);

/** Every value a workspace holds as a secret: secret variables, shared values of those, and the credentials in its items. */
export function secretValues(workspaces: Workspace[]): string[] {
  const out = new Set<string>();
  const auth = (a: TreeItem['auth']) => {
    if (!a) return;
    add(out, a.token);
    add(out, a.password);
    add(out, a.value);
    if (a.username && a.password) add(out, `${a.username}:${a.password}`);
  };
  for (const w of workspaces) {
    for (const v of w.globals ?? []) if (variableIsSecret(v)) add(out, v.value);
    for (const e of w.environments ?? []) {
      for (const v of e.variables) {
        if (!variableIsSecret(v)) continue;
        add(out, v.value);
        add(out, e.shared?.values?.[v.key]);
      }
    }
    for (const i of w.items ?? []) {
      auth(i.auth);
      auth(i.request?.auth);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const PATTERNS: [RegExp, (...g: string[]) => string][] = [
  // First: the name=value rule below would take only the word "Bearer" as the value and leave the token.
  // After "bearer" anything is a credential; after the others, ordinary words ("basic information") are not.
  [/\b(bearer|basic|token|digest)\s+([A-Za-z0-9._~+/=-]{8,})/gi, (word, value) => (/^bearer$/i.test(word) || /[\d._~+/=-]|[a-z].*[A-Z]|[A-Z].*[a-z]/.test(value) ? `${word} ${MASK}` : `${word} ${value}`)],
  // name=value, "name": "value", name: value — a secret-looking name in any text, a form body or a query string.
  [/((?:[\w.-]*(?:passw(?:or)?d|passphrase|pwd|secret|token|(?<![A-Za-z])key|apikey|credential|authorization|cookie|session|jwt|otp|csrf|xsrf|dsn)[\w.-]*))(["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,&;)}\]]+)/gi, (name, sep) => `${name}${sep}${MASK}`],
  // <password>value</password>
  [/<((?:[\w.-]*(?:passw(?:or)?d|secret|token|api[-_]?key|credential)[\w.-]*))>[^<]*<\/\1>/gi, (tag) => `<${tag}>${MASK}</${tag}>`],
  [/(\w+:\/\/[^:/\s@]+:)[^@\s/]+@/g, (start) => `${start}${MASK}@`],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g, () => MASK],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => MASK],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|glpat|xox[abprs]|dct|AKIA|ASIA)[-_A-Za-z0-9]{10,}/g, () => MASK],
];

/** Plain text: the known values, then what looks like a secret. A variable like {{token}} stays: it holds no value. */
export function maskText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(MASK);
  for (const [re, to] of PATTERNS) out = out.replace(re, (m: string, ...g: string[]) => (m.includes('{{') ? m : to(...g)));
  return out;
}

const NAME_FIELDS = ['name', 'key', 'field', 'header', 'id', 'label'];
const VALUE_FIELDS = ['value', 'val', 'content', 'data'];

/** JSON of any shape: by the key it is under, a `{ name, value }` pair, a `[name, value]` pair, else the text itself. */
export function maskJson(v: unknown, secrets: string[]): unknown {
  if (typeof v === 'string') return maskText(v, secrets);
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === 'string' && SECRET_NAME.test(v[0]) && v[1] !== null && typeof v[1] !== 'object') return [v[0], MASK];
    return v.map((x) => maskJson(x, secrets));
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const named = NAME_FIELDS.some((f) => typeof o[f] === 'string' && SECRET_NAME.test(o[f] as string));
    return Object.fromEntries(
      Object.entries(o).map(([k, x]) => {
        if (x === null || x === undefined || typeof x === 'boolean') return [k, x];
        if (SECRET_NAME.test(k) || (named && VALUE_FIELDS.includes(k))) return [k, MASK];
        return [k, maskJson(x, secrets)];
      }),
    );
  }
  return v;
}

/** A body: JSON stays JSON (and goes through by its keys), anything else as text. */
export function maskBody(body: string, secrets: string[]): string {
  const t = body.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(maskJson(JSON.parse(t), secrets), null, 2);
    } catch {
      /* not JSON after all */
    }
  }
  return maskText(body, secrets);
}

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

/** Headers and other name / value rows. The variable a value uses ({{token}}) stays readable: it holds no value. */
export function maskValue(name: string, value: string, secrets: string[]): string {
  if ((SECRET_HEADER.test(name) || SECRET_NAME.test(name)) && !/^(\s*(bearer|basic|token)?\s*\{\{[^}]+\}\}\s*)$/i.test(value)) return value ? MASK : '';
  return maskText(value, secrets);
}
export const maskHeaders = (h: [string, string][], secrets: string[]): [string, string][] => h.map(([k, v]) => [k, maskValue(k, v, secrets)]);

/** A URL: the query values under secret-looking names, then the text. */
export function maskUrl(url: string, secrets: string[]): string {
  return maskText(url, secrets).replace(/([?&])([^=&#]+)=([^&#]*)/g, (m, sep: string, k: string, v: string) => (SECRET_NAME.test(decodeSafe(k)) && !/^\{\{[^}]*\}\}$/.test(v) ? `${sep}${k}=${MASK}` : m));
}
function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
