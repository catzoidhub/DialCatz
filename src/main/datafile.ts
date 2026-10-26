import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * The collection runner's data files (TODO #39): a CSV with a header row, or a JSON array of objects. Each row is one
 * iteration; its values are text, available as {{column}} and through pm.iterationData / dc.data.
 */

const MAX = 20 * 1024 * 1024;
const MAX_ROWS = 10_000;

/** RFC 4180-ish: quoted fields with "" escapes and line breaks inside quotes; , or ; or tab as the separator. */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, '');
  const first = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!head) return [];
  const keys = head.map((h) => h.trim());
  return body.slice(0, MAX_ROWS).map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ''])));
}

export function parseJson(text: string): Record<string, string>[] {
  const doc = JSON.parse(text) as unknown;
  if (!Array.isArray(doc)) throw new Error('A JSON data file is an array of objects: [{ "id": 1 }, { "id": 2 }]');
  return doc.slice(0, MAX_ROWS).map((o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : { value: o }).map(([k, v]) => [k, v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)])));
}

export function read(path: string): { name: string; rows: Record<string, string>[]; columns: string[] } {
  if (statSync(path).size > MAX) throw new Error('That data file is larger than 20 MB');
  const text = readFileSync(path, 'utf8');
  const rows = /\.json$/i.test(path) || /^\s*\[/.test(text) ? parseJson(text) : parseCsv(text);
  if (!rows.length) throw new Error('No rows in that data file (a CSV needs a header row and at least one row)');
  return { name: basename(path), rows, columns: Object.keys(rows[0]) };
}
