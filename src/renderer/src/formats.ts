/** Response formats beyond JSON: tables from CSV / NDJSON / arrays, hex dumps, base64, readable HTML. */

export interface Table {
  columns: string[];
  rows: string[][];
}

/** RFC 4180-ish CSV (quotes, doubled quotes, CRLF); the first row is the header. Also tab-separated. */
export function parseCsv(text: string, max = 2000): Table | null {
  const sep = text.split('\n', 1)[0].includes('\t') && !text.split('\n', 1)[0].includes(',') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length <= max; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += c;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  const clean = rows.filter((r) => r.some((c) => c !== ''));
  if (clean.length < 2 || clean[0].length < 2) return null;
  return { columns: clean[0], rows: clean.slice(1) };
}

const cellText = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** An array of objects (JSON, or NDJSON lines) as a table; null when it does not look like one. */
export function objectsTable(list: unknown[], max = 2000): Table | null {
  const objs = list.filter((o) => o && typeof o === 'object' && !Array.isArray(o)) as Record<string, unknown>[];
  if (objs.length < 1 || objs.length < list.length * 0.8) return null;
  const columns = [...new Set(objs.slice(0, 200).flatMap((o) => Object.keys(o)))].slice(0, 50);
  return { columns, rows: objs.slice(0, max).map((o) => columns.map((c) => cellText(o[c]))) };
}

export function parseNdjson(text: string): unknown[] | null {
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  try {
    return lines.slice(0, 5000).map((l) => JSON.parse(l));
  } catch {
    return null;
  }
}

/** A table for the body if it has one (CSV, NDJSON, a JSON array of objects, or an object holding one). */
export function tableOf(body: string, contentType: string, json: unknown): Table | null {
  if (json !== undefined) {
    if (Array.isArray(json)) return objectsTable(json);
    if (json && typeof json === 'object') {
      const arr = Object.values(json as object).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
      return arr ? objectsTable(arr as unknown[]) : null;
    }
    return null;
  }
  if (/ndjson|jsonl|json-seq/.test(contentType)) {
    const list = parseNdjson(body);
    return list ? objectsTable(list) : null;
  }
  if (/csv|tab-separated/.test(contentType) || /^[^\n,]+(,[^\n,]*)+\r?\n/.test(body.slice(0, 2000))) return parseCsv(body);
  return null;
}

/** Bytes as a hex dump: offset, 16 bytes in hex, the printable characters. */
export function hexDump(bytes: Uint8Array, max = 64 * 1024): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const chunk = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(chunk, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes (save the response to see all)`);
  return lines.join('\n');
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Decodes base64 / base64url text (a whole body, or a data: URL); null when it is not base64. */
export function decodeBase64(text: string): { bytes: Uint8Array; mime: string | null } | null {
  let s = text.trim();
  let mime: string | null = null;
  const data = s.match(/^data:([^;,]+)?(;[^,]*)?,(.*)$/s);
  if (data) {
    mime = data[1] ?? null;
    s = data[3];
  }
  s = s.replace(/^"|"$/g, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!s || s.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    return { bytes: base64ToBytes(s.padEnd(Math.ceil(s.length / 4) * 4, '=')), mime };
  } catch {
    return null;
  }
}

/** The likely type of some bytes, from their magic numbers. */
export function sniff(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return null;
}

/** Text when the bytes are valid UTF-8 without control characters, else null. */
export function bytesAsText(bytes: Uint8Array): string | null {
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return /[\u0000-\u0008\u000e-\u001f]/.test(t.slice(0, 2000)) ? null : t;
  } catch {
    return null;
  }
}

/** HTML indented one element per line (good enough to read a page or a fragment). */
export function prettyHtml(html: string): string {
  if (html.split('\n').length > 5) return html;
  const VOID = /^<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr|!doctype)\b/i;
  let depth = 0;
  return html
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + l;
      if (/^<[a-z][^>]*>$/i.test(l) && !VOID.test(l) && !/\/>$/.test(l) && !/^<[^>]+>.*<\/[^>]+>$/.test(l)) depth++;
      return out;
    })
    .join('\n');
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
}

/** The Set-Cookie headers of a response, read. */
export function parseSetCookies(headers: [string, string][]): Cookie[] {
  return headers
    .filter(([k]) => k.toLowerCase() === 'set-cookie')
    .map(([, v]) => {
      const [pair, ...attrs] = v.split(';');
      const eq = pair.indexOf('=');
      const c: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), httpOnly: false, secure: false };
      for (const a of attrs) {
        const [k, ...rest] = a.split('=');
        const key = k.trim().toLowerCase();
        const val = rest.join('=').trim();
        if (key === 'domain') c.domain = val;
        else if (key === 'path') c.path = val;
        else if (key === 'expires') c.expires = val;
        else if (key === 'max-age') c.maxAge = val;
        else if (key === 'httponly') c.httpOnly = true;
        else if (key === 'secure') c.secure = true;
        else if (key === 'samesite') c.sameSite = val;
      }
      return c;
    });
}
