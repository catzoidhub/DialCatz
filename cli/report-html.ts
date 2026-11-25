import type { RunResult, RequestResult } from './run';
import { span, totals } from './report';

/** The run as one HTML file: opens anywhere, loads nothing, runs no script. */

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#1d2129;--soft:#667085;--line:#e3e6eb;--ok:#15803d;--bad:#b91c1c;--skip:#a16207;--code:#f1f3f6;--teal:#0f766e}
@media(prefers-color-scheme:dark){:root{--bg:#16171c;--card:#1e2027;--ink:#e6e8ec;--soft:#98a1af;--line:#2d3039;--ok:#4ade80;--bad:#f87171;--skip:#fbbf24;--code:#15161b;--teal:#5fd4c0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:60rem;margin:0 auto;padding:2rem 1rem 4rem}h1{font-size:1.5rem;margin:0}h2{font-size:1.05rem;margin:2rem 0 .5rem}
.sub{color:var(--soft);margin:.25rem 0 1.25rem}.stats{display:flex;flex-wrap:wrap;gap:.75rem}.stat{background:var(--card);border:1px solid var(--line);border-radius:.75rem;padding:.6rem 1rem;min-width:7rem}
.stat b{display:block;font-size:1.3rem}.stat span{color:var(--soft);font-size:.8rem}.ok{color:var(--ok)}.bad{color:var(--bad)}.skip{color:var(--skip)}
details{background:var(--card);border:1px solid var(--line);border-radius:.6rem;margin:.4rem 0}summary{display:flex;gap:.6rem;align-items:baseline;padding:.55rem .8rem;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
summary .m{font:600 .75rem ui-monospace,Menlo,Consolas,monospace;color:var(--teal);min-width:3.4rem}summary .n{flex:1;overflow-wrap:anywhere}summary .t{color:var(--soft);font-size:.8rem;white-space:nowrap}
.in{padding:0 .8rem .8rem;border-top:1px solid var(--line)}.in ul{margin:.6rem 0;padding-left:0;list-style:none}.url{font:.8rem ui-monospace,Menlo,Consolas,monospace;color:var(--soft);overflow-wrap:anywhere;margin:.6rem 0 0}
h3{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--soft);margin:.9rem 0 .3rem}pre{background:var(--code);border-radius:.4rem;padding:.6rem;margin:0;overflow:auto;max-height:24rem;font:.8rem/1.45 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
footer{color:var(--soft);font-size:.8rem;margin-top:2.5rem}`;

const block = (title: string, text: string) => (text ? `<h3>${title}</h3><pre>${esc(text)}</pre>` : '');
const heads = (h: [string, string][]) => h.map(([k, v]) => `${k}: ${v}`).join('\n');

function row(r: RequestResult): string {
  const tone = r.outcome === 'passed' ? 'ok' : r.outcome === 'skipped' ? 'skip' : 'bad';
  const place = r.place.slice(1).join(' / ');
  const d = r.detail;
  return `<details${r.outcome === 'failed' ? ' open' : ''}><summary><span class="${tone}">${r.outcome === 'passed' ? '✓' : r.outcome === 'skipped' ? '–' : '✗'}</span><span class="m">${esc(r.method)}</span><span class="n">${place ? `<span class="t">${esc(place)} / </span>` : ''}${esc(r.name)}</span><span class="t">${r.attempts && r.attempts > 1 ? `${r.attempts} tries · ` : ''}${r.status ?? ''}${r.timeMs === null ? '' : ` · ${span(r.timeMs)}`}</span></summary><div class="in"><p class="url">${esc(r.url)}</p>${
    r.error ? `<p class="${tone}">${esc(r.error)}</p>` : ''
  }${r.tests.length ? `<ul>${r.tests.map((t) => `<li><span class="${t.pass ? 'ok' : 'bad'}">${t.pass ? '✓' : '✗'}</span> ${esc(t.name)}${t.error ? ` <span class="bad">${esc(t.error)}</span>` : ''}</li>`).join('')}</ul>` : ''}${block('Script log', r.logs.join('\n'))}${
    d ? `${block('Request headers', heads(d.requestHeaders))}${block('Request body', d.requestBody)}${block('Response headers', heads(d.responseHeaders))}${block('Response body', d.responseBody)}` : ''
  }</div></details>`;
}

export function html(runs: RunResult[], version: string, when = new Date()): string {
  const t = totals(runs);
  const names = [...new Set(runs.map((r) => r.collection))];
  const title = names.length === 1 ? names[0] : `${names.length} collections`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(title)}: API test report</title><style>${CSS}</style></head><body><main>
<h1><span class="${t.failed ? 'bad' : 'ok'}">${t.failed ? '✗' : '✓'}</span> ${esc(title)}</h1>
<p class="sub">${esc(when.toISOString().replace('T', ' ').slice(0, 16))} UTC</p>
<div class="stats"><div class="stat"><b>${t.requests}</b><span>requests</span></div><div class="stat"><b class="${t.failed ? 'bad' : 'ok'}">${t.failed}</b><span>failed</span></div>${t.skipped ? `<div class="stat"><b class="skip">${t.skipped}</b><span>skipped</span></div>` : ''}<div class="stat"><b>${t.tests - t.testsFailed} / ${t.tests}</b><span>tests passed</span></div><div class="stat"><b>${span(t.ms)}</b><span>total</span></div></div>
${runs.map((run) => `<h2>${esc(run.collection)}${run.iteration ? ` · row ${run.iteration}` : ''}</h2>${run.requests.map(row).join('\n')}`).join('\n')}
<footer>DialCatz CLI ${esc(version)}. Values of secret variables and credential headers are hidden.</footer>
</main></body></html>
`;
}
