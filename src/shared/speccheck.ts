import type { SpecResponse } from './types';

/**
 * A response checked against the responses its spec describes (#93): the status (an exact code, then "2XX", then
 * "default"), the content type, and a JSON body against the schema (OpenAPI 3.0 / 3.1 and Swagger 2 schema objects:
 * type and nullable, required, properties, additionalProperties, items, enum / const, allOf / anyOf / oneOf).
 * Formats, lengths and patterns are not checked: the shape is what drifts between a contract and a server.
 */

export interface SpecCheck {
  /** The spec's response the status matched ("200", "2XX", "default"), or null. */
  matched: string | null;
  issues: string[];
}

const MAX_ISSUES = 30;
const MAX_ITEMS = 200;

type Schema = Record<string, unknown>;

/** The spec's response for a status: exact, then its class ("2XX"), then "default". */
export function responseFor(responses: SpecResponse[], status: number): SpecResponse | null {
  const code = String(status);
  return responses.find((r) => r.status === code) ?? responses.find((r) => r.status === `${code[0]}XX`) ?? responses.find((r) => r.status === 'DEFAULT') ?? null;
}

const bare = (t: string) => t.split(';')[0].trim().toLowerCase();
function typeMatches(actual: string, listed: string): boolean {
  const [a, b] = [bare(actual), bare(listed)];
  if (b === '*/*' || a === b) return true;
  const [lt, ls] = b.split('/');
  const [at, as] = a.split('/');
  return lt === at && (ls === '*' || (ls === 'json' && /\+json$/.test(as ?? '')));
}

export function checkResponse(responses: SpecResponse[], res: { status: number; contentType: string; body: string; binary: boolean; truncated: boolean }): SpecCheck {
  const issues: string[] = [];
  const spec = responseFor(responses, res.status);
  if (!spec) {
    const listed = responses.map((r) => (r.status === 'DEFAULT' ? 'default' : r.status)).join(', ');
    return { matched: null, issues: [`Status ${res.status} is not in the spec${listed ? ` (it lists ${listed})` : ''}`] };
  }
  const hasBody = res.binary || res.body.trim() !== '';
  // No content described: many specs leave it out even when there is one, so only the status counts.
  if (!spec.types.length) return { matched: spec.status, issues };
  if (hasBody && res.contentType && !spec.types.some((t) => typeMatches(res.contentType, t))) issues.push(`Content type ${bare(res.contentType)}; the spec says ${spec.types.map(bare).join(' or ')}`);
  if (!spec.schema || !hasBody || res.binary || res.truncated) return { matched: spec.status, issues };
  if (!spec.types.some((t) => /json/i.test(t))) return { matched: spec.status, issues };
  // JSON sent with another content type (common with PHP backends) is still checked; anything else was said above.
  if (!/json/i.test(res.contentType) && !/^\s*[[{]/.test(res.body)) return { matched: spec.status, issues };
  let value: unknown;
  try {
    value = JSON.parse(res.body);
  } catch {
    issues.push('The body is not JSON, but the spec describes JSON');
    return { matched: spec.status, issues };
  }
  validate(spec.schema, value, 'body', issues, 0);
  return { matched: spec.status, issues: issues.slice(0, MAX_ISSUES) };
}

const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const fits = (type: string, v: unknown) => (type === 'number' ? typeof v === 'number' : type === 'integer' ? Number.isInteger(v) : type === 'file' ? true : kind(v) === type);
const key = (path: string, k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);
const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s && s.length > 40 ? `${s.slice(0, 37)}…` : s;
};

/** Issues of `value` against `schema`, with a JSON path each ("body.users[0].email: missing (required)"). */
export function validate(schema: unknown, value: unknown, path: string, issues: string[], depth: number): void {
  if (!schema || typeof schema !== 'object' || issues.length >= MAX_ISSUES || depth > 40) return;
  const s = schema as Schema;
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : [];
  if (value === null && (s.nullable === true || types.includes('null'))) return;
  if (Array.isArray(s.allOf)) for (const part of s.allOf) validate(part, value, path, issues, depth + 1);
  for (const k of ['anyOf', 'oneOf'] as const) {
    const options = s[k];
    if (!Array.isArray(options) || !options.length) continue;
    const fitsOne = options.some((o) => {
      const found: string[] = [];
      validate(o, value, path, found, depth + 1);
      return !found.length;
    });
    if (!fitsOne) issues.push(`${path}: matches none of the ${options.length} shapes the spec allows`);
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) issues.push(`${path}: ${show(value)}, the spec says ${show(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) issues.push(`${path}: ${show(value)} is not one of ${s.enum.slice(0, 6).map(show).join(', ')}${s.enum.length > 6 ? ', …' : ''}`);
  const want = types.filter((t) => t !== 'null');
  if (want.length && !want.some((t) => fits(t, value))) {
    issues.push(`${path}: ${value === null ? 'null' : kind(value) === 'integer' ? 'a number' : `a${/^[aeiou]/.test(kind(value)) ? 'n' : ''} ${kind(value)}`}, the spec says ${want.join(' or ')}`);
    return;
  }
  if (kind(value) === 'object' && (want.includes('object') || s.properties || s.required)) {
    const o = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, unknown>;
    for (const r of (s.required ?? []) as string[]) if (!(r in o)) issues.push(`${key(path, r)}: missing (required)`);
    for (const [k, v] of Object.entries(o)) {
      if (issues.length >= MAX_ISSUES) return;
      if (k in props) validate(props[k], v, key(path, k), issues, depth + 1);
      else if (s.additionalProperties === false) issues.push(`${key(path, k)}: not in the spec`);
      else if (s.additionalProperties && typeof s.additionalProperties === 'object') validate(s.additionalProperties, v, key(path, k), issues, depth + 1);
    }
  }
  if (Array.isArray(value) && s.items) value.slice(0, MAX_ITEMS).forEach((v, n) => validate(s.items, v, `${path}[${n}]`, issues, depth + 1));
}
