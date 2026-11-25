/**
 * Reads a .bru file (Bruno's own format) into its blocks: dictionaries (`key: value` lines), text (a body, a script,
 * docs) and lists. Written from the format's description; what it does not know is left in `unknown`.
 */

export interface BruPair {
  key: string;
  value: string;
  enabled: boolean;
  /** vars:post-response `@name`: for this request only. */
  local: boolean;
  description?: string;
  list?: string[];
}
export interface BruFile {
  dict: Map<string, BruPair[]>;
  text: Map<string, string>;
  list: Map<string, { name: string; enabled: boolean }[]>;
  unknown: string[];
}

const TEXT = /^(body|body:(json|text|xml|sparql|graphql|graphql:vars)|script:.+|tests|docs|example)$/;
const HEAD = /^([A-Za-z][\w:-]*)[ \t]*([{[])[ \t]*$/;

const outdent = (lines: string[]): string => {
  const body = lines.map((l) => (l.startsWith('  ') ? l.slice(2) : l.trim() ? l : ''));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join('\n');
};

/** Text between ''' with the indent its lines share taken off. */
function dedent(text: string): string {
  const lines = text.split('\n');
  const pad = Math.min(...lines.filter((l, n) => n > 0 && l.trim()).map((l) => l.length - l.trimStart().length));
  return lines
    .map((l, n) => (n === 0 ? l : l.slice(Number.isFinite(pad) ? pad : 0)))
    .join('\n')
    .replace(/^\n|\n\s*$/g, '');
}

function annotation(text: string): { name: string; arg: string } | null {
  const m = /^@([^\s(:]+)(?:\(([\s\S]*)\))?$/.exec(text.trim());
  if (!m) return null;
  let arg = (m[2] ?? '').trim();
  if (/^'''[\s\S]*'''$/.test(arg)) arg = dedent(arg.slice(3, -3));
  else if (/^".*"$/s.test(arg)) arg = arg.slice(1, -1).replace(/\\(["\\])/g, '$1');
  else if (/^'.*'$/s.test(arg)) arg = arg.slice(1, -1);
  return { name: m[1], arg };
}

function pairs(lines: string[], assertions: boolean): BruPair[] {
  const out: BruPair[] = [];
  let description: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith('@') && !/^@[\w.-]+\s*:/.test(line)) {
      // @description('…'), over several lines with '''.
      if (/\('''/.test(line) && !/'''\)\s*$/.test(line.replace(/\('''/, ''))) while (i + 1 < lines.length && !/'''\)\s*$/.test(lines[i])) line += `\n${lines[++i]}`;
      const a = annotation(line);
      if (a?.name === 'description') description = a.arg;
      continue;
    }
    let key: string;
    let rest: string;
    const quoted = /^(~?@?)"((?:\\"|[^"])*)"\s*:\s?(.*)$/s.exec(line);
    if (quoted) {
      key = quoted[1] + quoted[2].replace(/\\"/g, '"');
      rest = quoted[3];
    } else {
      // An assertion's left side is an expression: it may hold spaces, and a colon only inside quotes or brackets.
      let at = -1;
      if (assertions) {
        let depth = 0;
        let q = '';
        for (let c = 0; c < line.length && at < 0; c++) {
          const ch = line[c];
          if (q) q = ch === q && line[c - 1] !== '\\' ? '' : q;
          else if (ch === '"' || ch === "'" || ch === '`') q = ch;
          else if ('([{'.includes(ch)) depth++;
          else if (')]}'.includes(ch)) depth--;
          else if (ch === ':' && depth <= 0) at = c;
        }
      }
      if (at < 0) at = line.indexOf(':');
      if (at < 0) continue;
      key = line.slice(0, at).trim();
      rest = line.slice(at + 1).trim();
    }
    const p: BruPair = { key, value: rest.trim(), enabled: true, local: false, ...(description ? { description } : {}) };
    description = undefined;
    if (p.key.startsWith('~')) ((p.enabled = false), (p.key = p.key.slice(1)));
    if (p.key.startsWith('@')) ((p.local = true), (p.key = p.key.slice(1)));
    if (p.value.startsWith("'''")) {
      const got = [p.value.slice(3)];
      while (!/'''(\s*@contentType\([^)]*\))?\s*$/.test(got[got.length - 1]) && i + 1 < lines.length) got.push(lines[++i]);
      const whole = got.join('\n');
      const end = whole.lastIndexOf("'''");
      p.value = dedent(whole.slice(0, end < 0 ? undefined : end));
      if (end >= 0) p.value += whole.slice(end + 3);
    } else if (p.value === '[') {
      p.list = [];
      while (i + 1 < lines.length && lines[++i].trim() !== ']') if (lines[i].trim()) p.list.push(lines[i].trim());
      p.value = '';
    }
    out.push(p);
  }
  return out;
}

export function parseBru(source: string): BruFile {
  const out: BruFile = { dict: new Map(), text: new Map(), list: new Map(), unknown: [] };
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD.exec(lines[i]);
    if (!m) {
      if (lines[i].trim() && !/^extends\s*:/.test(lines[i])) out.unknown.push(lines[i].trim().slice(0, 80));
      const ext = /^extends\s*:\s*(.+)$/.exec(lines[i]);
      if (ext) out.text.set('extends', ext[1].trim());
      continue;
    }
    const [, name, open] = m;
    const close = open === '{' ? '}' : ']';
    const body: string[] = [];
    let quoted = false;
    // A block ends at its closing bracket at the start of a line (inside ''' it is text).
    while (++i < lines.length) {
      if (!TEXT.test(name) && open === '{' && (lines[i].match(/'''/g)?.length ?? 0) % 2) quoted = !quoted;
      if (!quoted && lines[i].trimEnd() === close && lines[i][0] === close) break;
      body.push(lines[i]);
    }
    if (open === '[') out.list.set(name, body.map((l) => l.trim().replace(/,$/, '')).filter((l) => l && !l.startsWith('@')).map((l) => (l.startsWith('~') ? { name: l.slice(1), enabled: false } : { name: l, enabled: true })));
    else if (TEXT.test(name)) {
      if (name !== 'example') out.text.set(name, outdent(body));
    } else out.dict.set(name, [...(out.dict.get(name) ?? []), ...pairs(body, name === 'assert')]);
  }
  return out;
}
