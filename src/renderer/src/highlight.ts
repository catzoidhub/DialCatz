/**
 * Small tokenizers for request / response bodies: JSON (from DBCatz), XML / HTML, and {{variables}} in any text.
 * Each returns HTML with one <span> per token (classes `hl-*`, colours in main.css); plain text is escaped.
 */

export type Language = 'json' | 'xml' | 'text';

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
