/** What an import says about requests it could not bring over whole: shared by Postman, Hoppscotch and Bruno. */

/** The values DialCatz makes by itself ({{$guid}} …). */
export const DYNAMIC = new Set(['$timestamp', '$isoTimestamp', '$randomUUID', '$guid', '$randomInt']);

export class Notes {
  private list = new Set<string>();
  add(where: string, what: string): void {
    this.list.add(`${where}: ${what}`);
  }
  plain(what: string): void {
    this.list.add(what);
  }
  /** Values the text asks for that DialCatz does not make. */
  dynamic(where: string, value: unknown): void {
    const names = new Set([...JSON.stringify(value ?? '').matchAll(/\{\{\s*(\$[\w.]+)\s*\}\}/g)].map((m) => m[1]));
    for (const n of names) if (!DYNAMIC.has(n)) this.add(where, `{{${n}}} is not a value DialCatz makes`);
  }
  all(): string[] {
    return [...this.list];
  }
}

const MODULES = new Set(['chai', 'uuid', 'nanoid', 'atob', 'btoa']);
/** What a script written for another app uses that DialCatz's sandbox does not have. */
export function scriptGaps(code: string): string[] {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:pm\.|insomnia\.)?require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) if (!MODULES.has(m[1])) out.add(`require('${m[1]}')`);
  for (const m of text.matchAll(/\bpm\.(sendRequest|cookies|execution|vault|visualizer|message|mock|datasets)\b/g)) out.add(`pm.${m[1]}`);
  for (const m of text.matchAll(/\binsomnia\.(sendRequest|cookies|execution|vault|parentFolders|clientCertificates)\b/g)) out.add(`insomnia.${m[1]}`);
  for (const m of text.matchAll(/\bpostman\.(\w+)/g)) out.add(`postman.${m[1]}`);
  for (const m of text.matchAll(/\bhopp\.(fetch|cookies)\b/g)) out.add(`hopp.${m[1]}`);
  for (const m of text.matchAll(/\bhopp\.request\.setAuth\b/g)) out.add(m[0]);
  if (/\btv4\.|\bcheerio\.|\bxml2Json\s*\(|\bCryptoJS\.|\bmoment\s*\(|\b_\.\w+\(/.test(text)) for (const [n, re] of [['tv4', /\btv4\./], ['cheerio', /\bcheerio\./], ['xml2Json', /\bxml2Json\s*\(/], ['CryptoJS', /\bCryptoJS\./], ['moment', /\bmoment\s*\(/], ['lodash (_)', /(^|[^\w$.])_\.\w+\(/]] as const) if (re.test(text)) out.add(n);
  if (/^\s*import\s/m.test(text) || /\bimport\s*\(/.test(text)) out.add('import');
  if (/(^|[^.\w$])(fetch|axios)\s*[.(]/.test(text)) out.add('network requests');
  return [...out];
}
export const gapsNote = (gaps: string[]) => `its scripts use ${gaps.join(', ')}, which DialCatz scripts do not have`;
