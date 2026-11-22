import type { RequestResult, RunResult } from './run';

/** What a run looked like: for a person at a terminal, for a CI's test report (JUnit XML), or as JSON. */

export interface Totals {
  requests: number;
  failed: number;
  skipped: number;
  tests: number;
  testsFailed: number;
  ms: number;
}
export function totals(runs: RunResult[]): Totals {
  const all = runs.flatMap((r) => r.requests);
  return {
    requests: all.length,
    failed: all.filter((r) => r.outcome === 'failed').length,
    skipped: all.filter((r) => r.outcome === 'skipped').length,
    tests: all.reduce((n, r) => n + r.tests.length, 0),
    testsFailed: all.reduce((n, r) => n + r.tests.filter((t) => !t.pass).length, 0),
    ms: runs.reduce((n, r) => n + r.ms, 0),
  };
}

export interface Paint {
  /** The marks: ✓ ✗ ›, or √ × > on a Windows console whose font has no ✓ (the classic console host). */
  ok: string;
  bad: string;
  log: string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}
/** A terminal on Windows that is not Windows Terminal, VS Code or a Unix-like shell: Consolas / raster fonts, no ✓. */
export const plainMarks = (env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, tty = process.stdout.isTTY === true): boolean =>
  platform === 'win32' && tty && !env.WT_SESSION && !env.TERM_PROGRAM && !env.TERM && !env.CI;
export function paint(on: boolean, plain = false): Paint {
  const c = (code: number) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { ok: plain ? '√' : '✓', bad: plain ? '×' : '✗', log: plain ? '>' : '›', green: c(32), red: c(31), yellow: c(33), dim: c(2), bold: c(1) };
}

const span = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);

/** One request, as it finishes. */
export function requestLines(r: RequestResult, p: Paint, verbose: boolean): string[] {
  const mark = r.outcome === 'passed' ? p.green(p.ok) : r.outcome === 'skipped' ? p.yellow('-') : p.red(p.bad);
  const where = r.place.length > 1 ? p.dim(`${r.place.slice(1).join(' / ')} / `) : '';
  const status = r.status === null ? '' : `  ${r.status >= 400 ? p.yellow(String(r.status)) : r.status}`;
  const time = r.timeMs === null ? '' : p.dim(`  ${span(r.timeMs)}`);
  const out = [`  ${mark} ${r.method.padEnd(6)} ${where}${r.name}${status}${time}`];
  if (r.outcome === 'skipped') out.push(p.dim(`      ${r.error}`));
  else if (r.error) out.push(`      ${p.red(r.error)}`);
  for (const t of r.tests) {
    if (t.pass && !verbose) continue;
    out.push(`      ${t.pass ? p.green(p.ok) : p.red(p.bad)} ${t.name}${t.error ? p.dim(`: ${t.error}`) : ''}`);
  }
  if (verbose) for (const l of r.logs) out.push(p.dim(`      ${p.log} ${l}`));
  return out;
}

export function summaryLine(t: Totals, p: Paint): string {
  const parts = [
    `${t.requests} request${t.requests === 1 ? '' : 's'}`,
    t.failed ? p.red(`${t.failed} failed`) : p.green('all passed'),
    ...(t.skipped ? [p.yellow(`${t.skipped} skipped`)] : []),
    `${t.tests} test${t.tests === 1 ? '' : 's'}${t.testsFailed ? `, ${p.red(`${t.testsFailed} failed`)}` : ''}`,
    span(t.ms),
  ];
  return parts.join(p.dim(' · '));
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** JUnit XML: a suite per collection, a case per request; a failed test or a request without an answer fails its case. */
export function junit(runs: RunResult[]): string {
  const t = totals(runs);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="DialCatz" tests="${t.requests}" failures="${t.failed}" skipped="${t.skipped}" time="${(t.ms / 1000).toFixed(3)}">`];
  for (const run of runs) {
    const failed = run.requests.filter((r) => r.outcome === 'failed').length;
    const skipped = run.requests.filter((r) => r.outcome === 'skipped').length;
    out.push(`  <testsuite name="${xml(run.collection + (run.iteration ? ` (row ${run.iteration})` : ''))}" tests="${run.requests.length}" failures="${failed}" skipped="${skipped}" time="${(run.ms / 1000).toFixed(3)}">`);
    for (const r of run.requests) {
      const head = `    <testcase classname="${xml(r.place.join(' / '))}" name="${xml(`${r.method} ${r.name}`)}" time="${((r.timeMs ?? 0) / 1000).toFixed(3)}"`;
      const logs = r.logs.length ? `      <system-out>${xml(r.logs.join('\n'))}</system-out>` : '';
      if (r.outcome === 'skipped') out.push(`${head}>`, `      <skipped message="${xml(r.error ?? '')}"/>`, '    </testcase>');
      else if (r.outcome === 'failed') {
        const why = [...(r.error ? [r.error] : []), ...r.tests.filter((x) => !x.pass).map((x) => `${x.name}${x.error ? `: ${x.error}` : ''}`)];
        out.push(`${head}>`, `      <failure message="${xml(why[0] ?? 'Failed')}">${xml([`${r.method} ${r.url}`, r.status === null ? 'No response' : `Status ${r.status}`, ...why].join('\n'))}</failure>`, ...(logs ? [logs] : []), '    </testcase>');
      } else if (logs) out.push(`${head}>`, logs, '    </testcase>');
      else out.push(`${head}/>`);
    }
    out.push('  </testsuite>');
  }
  out.push('</testsuites>', '');
  return out.join('\n');
}

export const json = (runs: RunResult[], version: string): string => `${JSON.stringify({ dialcatz: version, ...totals(runs), passed: totals(runs).failed === 0, collections: runs }, null, 2)}\n`;
