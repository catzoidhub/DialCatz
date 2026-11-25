import type { RunResult, RequestResult } from './run';
import { span, totals } from './report';

/** GitHub Actions: a summary on the run's page, and an error on the run for each request that failed. */

const cell = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/[\\`*_{}[\]()#+!|~@:]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\s*[\r\n]+\s*/g, ' ');
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const why = (r: RequestResult): string[] => [...(r.error ? [r.error] : []), ...r.tests.filter((t) => !t.pass).map((t) => `${t.name}${t.error ? `: ${t.error}` : ''}`)];

// The job summary holds 1 MiB; past these the HTML or JUnit report has the rest.
const MAX_FAILED = 100;
const MAX_ROWS = 500;

export function summary(runs: RunResult[]): string {
  const t = totals(runs);
  const all = runs.flatMap((run) => run.requests.map((r) => ({ r, run })));
  const failed = all.filter((x) => x.r.outcome === 'failed');
  const name = (x: (typeof all)[number]) => `${cell(cut([x.run.collection, ...x.r.place.slice(1), x.r.name].join(' / '), 160))}${x.run.iteration ? ` (row ${x.run.iteration})` : ''}`;
  const out = [
    `## ${t.failed ? '❌' : '✅'} DialCatz: ${t.failed ? `${t.failed} of ${t.requests} requests failed` : `all ${t.requests} requests passed`}`,
    '',
    `${t.tests} tests, ${t.testsFailed} failed${t.skipped ? ` · ${t.skipped} requests skipped` : ''} · ${span(t.ms)}`,
    '',
  ];
  if (failed.length) {
    out.push('| Failed request | Status | Why |', '|---|---|---|');
    for (const x of failed.slice(0, MAX_FAILED)) out.push(`| ${cell(x.r.method)} ${name(x)} | ${x.r.status ?? '–'} | ${why(x.r).slice(0, 5).map((w) => cell(cut(w, 300))).join('<br>')} |`);
    if (failed.length > MAX_FAILED) out.push('', `…and ${failed.length - MAX_FAILED} more.`);
    out.push('');
  }
  out.push('<details><summary>Every request</summary>', '', '| | Request | Status | Time | Tests |', '|---|---|---|---|---|');
  for (const x of all.slice(0, MAX_ROWS)) out.push(`| ${x.r.outcome === 'passed' ? '✅' : x.r.outcome === 'skipped' ? '⏭️' : '❌'} | ${cell(x.r.method)} ${name(x)} | ${x.r.status ?? '–'} | ${x.r.timeMs === null ? '–' : span(x.r.timeMs)} | ${x.r.tests.filter((y) => y.pass).length} / ${x.r.tests.length}${x.r.attempts && x.r.attempts > 1 ? ` · ${x.r.attempts} tries` : ''} |`);
  if (all.length > MAX_ROWS) out.push('', `…and ${all.length - MAX_ROWS} more.`);
  out.push('', '</details>', '', '');
  return out.join('\n');
}

const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s: string) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
/** GitHub shows ten errors per step; the summary names the others. */
export function annotations(runs: RunResult[]): string[] {
  return runs
    .flatMap((run) => run.requests)
    .filter((r) => r.outcome === 'failed')
    .slice(0, 10)
    .map((r) => `::error title=${prop(cut(`${r.method} ${r.name}`, 120))}::${data(cut([...(r.status === null ? [] : [`Status ${r.status}`]), ...why(r)].join('\n'), 1500))}`);
}

/** What a script logged, or a server answered, must not be read as one of the runner's own commands. */
export const inert = (s: string): string => s.replace(/(^|[\r\n])(\s*)(::|##\[)/g, (_, a: string, b: string, c: string) => `${a}${b}${c[0]}\u200b${c.slice(1)}`);
