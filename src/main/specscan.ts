import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * OpenAPI / Swagger documents in a project folder (Import → OpenAPI in a project), for people without DevCatz: every
 * JSON or YAML file whose start says `openapi: 3…` or `swagger: "2…"`, outside dependency and build folders. Only the
 * first 4 KB of a file is read to decide; the ones found are read whole for their title and size.
 */

const SKIP = new Set(['node_modules', 'vendor', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt', '.output', '.svelte-kit', 'target', 'coverage', '.venv', 'venv', '__pycache__', '.idea', '.vscode', 'Pods', 'DerivedData', '.gradle', 'bower_components', '.cache', '.turbo', 'tmp', 'logs']);
const MAX_DEPTH = 7;
const MAX_ENTRIES = 40_000;
const MAX_SIZE = 20 * 1024 * 1024;

export interface FoundSpec {
  file: string;
  /** Path in the folder, forward slashes. */
  rel: string;
  title: string;
  version: string;
  /** "OpenAPI 3.1" / "Swagger 2.0". */
  format: string;
  /** How many operations (requests) it describes. */
  operations: number;
}

function head(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const LOOKS = /(^|[\s{,])["']?(openapi|swagger)["']?\s*:\s*["']?(\d+(\.\d+)*)/m;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function scanFolder(root: string): FoundSpec[] {
  const out: FoundSpec[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith('.')) walk(p, depth + 1);
        continue;
      }
      if (!e.isFile() || !/\.(json|ya?ml)$/i.test(e.name) || /(^|\.)(package|composer|tsconfig|jsconfig)(-lock)?\.json$|lock\.(json|ya?ml)$/i.test(e.name)) continue;
      try {
        const size = statSync(p).size;
        if (size > MAX_SIZE || size < 20) continue;
        const m = head(p).match(LOOKS);
        if (!m) continue;
        const doc = parseDoc(p);
        if (!doc || (typeof doc.openapi !== 'string' && typeof doc.swagger !== 'string')) continue;
        const info = (doc.info ?? {}) as { title?: unknown; version?: unknown };
        const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
        const operations = Object.values(paths).reduce((n, o) => n + Object.keys(o ?? {}).filter((k) => METHODS.includes(k.toLowerCase())).length, 0);
        out.push({
          file: p,
          rel: relative(root, p).split(sep).join('/'),
          title: typeof info.title === 'string' && info.title.trim() ? info.title.trim().slice(0, 200) : e.name,
          version: typeof info.version === 'string' || typeof info.version === 'number' ? String(info.version).slice(0, 40) : '',
          format: typeof doc.openapi === 'string' ? `OpenAPI ${doc.openapi}` : `Swagger ${String(doc.swagger)}`,
          operations,
        });
      } catch {
        /* unreadable or not a document: skipped */
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel));
}

function parseDoc(file: string): Record<string, unknown> | null {
  const text = readFileSync(file, 'utf8');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const d = parseYaml(text, { maxAliasCount: 200 }) as unknown;
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : null;
  }
}
