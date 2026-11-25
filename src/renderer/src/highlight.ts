/**
 * Small tokenizers: JSON (from DBCatz), XML / HTML, YAML and shell (CI workflows), and {{variables}} in any text.
 * Each returns HTML with one <span> per token (classes `hl-*`, colours in main.css); plain text is escaped.
 */

export type Language = 'json' | 'xml' | 'yaml' | 'shell' | 'text';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => (cls ? `<span class="hl-${cls}">${esc(s)}</span>` : esc(s));

/** JSON (and relaxed JSON): keys, strings, numbers, constants, brackets with a depth colour. */
export function highlightJson(src: string): string {
  const re = /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\]])|([,:])|(\b[A-Za-z_$][A-Za-z0-9_$]*\b)(\s*:)/g;
  let out = '';
  let last = 0;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [tok, str, colonAfterStr, num, konst, bracket, punct, bareKey, colonAfterKey] = m;
    if (str) out += span(colonAfterStr ? 'key' : 'str', str) + (colonAfterStr ? span('punct', colonAfterStr) : '');
    else if (num) out += span('num', tok);
    else if (konst) out += span('const', tok);
    else if (bracket) {
      if (bracket === '}' || bracket === ']') depth = Math.max(0, depth - 1);
      out += `<span class="hl-br hl-br-${depth % 3}">${bracket}</span>`;
      if (bracket === '{' || bracket === '[') depth++;
    } else if (punct) out += span('punct', tok);
    else if (bareKey) out += span('key', bareKey) + span('punct', colonAfterKey);
  }
  return out + esc(src.slice(last));
}

/** XML / HTML: comments, tags, attribute names and values. */
export function highlightXml(src: string): string {
  const re = /(<!--[\s\S]*?(?:-->|$))|(<\/?[\w:.-]+)|([\w:.-]+)(=)("[^"]*"?|'[^']*'?)|(\/?>)/g;
  let out = '';
  let last = 0;
  let inTag = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [tok, cmt, open, attr, eq, val, close] = m;
    if (!inTag && (attr || close) && !open) {
      // Outside a tag "a=b" is just text.
      continue;
    }
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    if (cmt) out += span('cmt', tok);
    else if (open) {
      out += span('kw', open);
      inTag = true;
    } else if (attr) out += span('key', attr) + span('punct', eq) + span('str', val);
    else if (close) {
      out += span('kw', close);
      inTag = false;
    }
  }
  return out + esc(src.slice(last));
}

/** Shell: comments, strings, $variables, --options and the command at the start of a line. `start` false: the line goes on from the one before. */
function shellLine(src: string, start = true): string {
  const re = /(^|\s)(#.*$)|(\$\{\{.*?\}\})|('[^']*'?|"(?:[^"\\]|\\.)*"?)|(\$\{[^}]*\}?|\$\w+)|(^|\s)(--?[A-Za-z][\w-]*)|(&&|\|\||[|;<>&\\])|([^\s'"$|;&<>\\]+)/g;
  let out = '';
  let last = 0;
  let command = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [tok, s1, cmt, expr, str, v, s2, opt, op, word] = m;
    if (cmt) out += esc(s1) + span('cmt', cmt);
    else if (expr) out += span('var', expr);
    else if (str) out += span('str', str);
    else if (v) out += span('ident', v);
    else if (opt) out += esc(s2) + span('op', opt);
    else if (op) {
      out += span('punct', op);
      if (op !== '\\' && op !== '<' && op !== '>') command = true;
    } else if (command) {
      const keyword = /^(export|if|then|else|fi|for|do|done|while|in)$/.test(word);
      out += span(keyword ? 'kw' : 'fn', word);
      command = keyword && !/^(export|for|in)$/.test(word);
    } else out += /^\d+$/.test(word) ? span('num', tok) : esc(tok);
  }
  return out + esc(src.slice(last));
}
export function highlightShell(src: string): string {
  const lines = src.split('\n');
  return lines.map((l, i) => shellLine(l, i === 0 || !lines[i - 1].endsWith('\\'))).join('\n');
}

/** YAML: comments, keys, list dashes, strings, numbers, constants, ${{ expressions }}; a block under | or > as shell. */
export function highlightYaml(src: string): string {
  const value = (v: string): string => {
    const m = /^(\s*)(.*?)(\s*)$/s.exec(v)!;
    const [, a, t, b] = m;
    if (!t) return esc(v);
    // A comment after a plain value.
    const c = /^(?!["'])(.*?)(\s#.*)$/.exec(t);
    if (c) return esc(a) + value(c[1]) + span('cmt', c[2]) + esc(b);
    let h: string;
    if (/^["']/.test(t)) h = span('str', t);
    else if (/^[[{]/.test(t)) h = t.replace(/("(?:[^"\\]|\\.)*"|'[^']*')|([[\]{}])|(,)|([^[\]{},"']+)/g, (tok, str, br, comma) => (str ? span('str', tok) : br ? `<span class="hl-br hl-br-0">${tok}</span>` : comma ? span('punct', tok) : esc(tok)));
    else if (/^-?\d+(\.\d+)?$/.test(t)) h = span('num', t);
    else if (/^(true|false|null|~|yes|no|on|off)$/i.test(t)) h = span('const', t);
    else if (/^[|>][+-]?$/.test(t)) h = span('punct', t);
    else h = t.split(/(\$\{\{.*?\}\})/).map((p) => (p.startsWith('${{') ? span('var', p) : p ? span('str', p) : '')).join('');
    return esc(a) + h + esc(b);
  };
  let block = -1;
  let goesOn = false;
  return src
    .split('\n')
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      if (block >= 0) {
        if (!line.trim()) return esc(line);
        if (indent > block) {
          const h = esc(line.slice(0, indent)) + shellLine(line.slice(indent), !goesOn);
          goesOn = line.endsWith('\\');
          return h;
        }
        block = -1;
      }
      if (/^\s*#/.test(line)) return span('cmt', line);
      const m = /^(\s*)((?:- )*)(.*)$/s.exec(line)!;
      const [, sp, dash, rest] = m;
      const k = /^([\w./$-]+|"(?:[^"\\]|\\.)*")(:)(\s.*|)$/s.exec(rest);
      const v = k ? k[3] : rest;
      if (/^[|>][+-]?$/.test(v.trim())) {
        block = sp.length + (k ? dash.length : 0);
        goesOn = false;
      }
      return esc(sp) + (dash ? span('punct', dash) : '') + (k ? span('key', k[1]) + span('punct', k[2]) : '') + value(v);
    })
    .join('\n');
}

/** Marks {{variables}} inside an already-escaped HTML string: known ones teal, unknown ones red. */
export function markVars(html: string, known: (name: string) => boolean): string {
  return html.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (whole, name: string) => `<span class="hl-var ${known(name) || name.startsWith('$') ? '' : 'is-unknown'}">${whole}</span>`);
}

export function highlight(language: Language, src: string): string {
  switch (language) {
    case 'json':
      return highlightJson(src);
    case 'xml':
      return highlightXml(src);
    case 'yaml':
      return highlightYaml(src);
    case 'shell':
      return highlightShell(src);
    default:
      return esc(src);
  }
}

/** Language for a content type. */
export function languageFor(contentType: string): Language {
  if (/json/i.test(contentType)) return 'json';
  if (/xml|html/i.test(contentType)) return 'xml';
  return 'text';
}

/** Pretty JSON when the text parses, else null. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!/^[{[]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** Indents XML / HTML one tag per line (good enough for reading). */
export function prettyXml(text: string): string {
  if (text.includes('\n') && text.split('\n').length > 3) return text;
  let depth = 0;
  return text
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
      const out = `${'  '.repeat(depth)}${l}`;
      if (/^<[^!?/][^>]*[^/]>$/.test(l) && !/^<[^>]+>.*<\/[^>]+>$/.test(l) && !/^<(br|hr|img|input|meta|link)\b/i.test(l)) depth++;
      return out;
    })
    .join('\n');
}
