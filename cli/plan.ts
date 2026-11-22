import type { SpecResponse, TreeItem } from '@shared/types';
import { pathOf } from '../src/main/openapi-export';

/** What a run is made of, worked out before anything is sent: the order, the contract's side of a request, values from a file. */

/** The requests under a collection, in the runner's order. */
export function requestsOf(items: TreeItem[], collectionId: string): TreeItem[] {
  const out: TreeItem[] = [];
  const walk = (parentId: string) => {
    for (const i of items.filter((x) => x.parentId === parentId).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
      if (i.kind === 'request' && i.request) out.push(i);
      else if (i.kind === 'folder') walk(i.id);
    }
  };
  walk(collectionId);
  return out;
}

/** "METHOD /path/{}": how an operation is found whatever its parameters are called. */
export const specKey = (method: string, url: string) => `${method.toUpperCase()} ${pathOf(url).path.replace(/\{[^}]*\}/g, '{}')}`;

/** The contract's responses for a request: the same path, or one whose {parameters} stand for this URL's values. */
export function specFor(spec: Map<string, SpecResponse[]>, method: string, url: string): SpecResponse[] | null {
  const key = specKey(method, url);
  const exact = spec.get(key);
  if (exact) return exact;
  const [m, path] = [key.slice(0, key.indexOf(' ')), key.slice(key.indexOf(' ') + 1)];
  const segs = path.split('/');
  let best: { n: number; r: SpecResponse[] } | null = null;
  for (const [k, r] of spec) {
    if (!k.startsWith(`${m} `)) continue;
    const s = k.slice(m.length + 1).split('/');
    if (s.length !== segs.length || !s.every((x, i) => x === '{}' || x === segs[i])) continue;
    const literal = s.filter((x) => x !== '{}').length;
    if (!best || literal > best.n) best = { n: literal, r };
  }
  return best?.r ?? null;
}

/** NAME=value lines; quotes around a value are dropped, # starts a comment line. */
export function readEnvFile(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    const q = /^(["'])([\s\S]*)\1$/.exec(v);
    if (q) v = q[1] === '"' ? q[2].replace(/\\n/g, '\n').replace(/\\"/g, '"') : q[2];
    else v = v.replace(/\s+#.*$/, '');
    out.push([m[1], v]);
  }
  return out;
}

