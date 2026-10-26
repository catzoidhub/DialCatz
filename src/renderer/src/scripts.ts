import type { HttpResponse, WireRequest } from '@shared/types';

/**
 * Request scripts (pre-request and tests) run in public/sandbox.html inside an <iframe sandbox="allow-scripts">:
 * an opaque origin without the app's APIs, storage or network. A script gets plain data in, gives test results,
 * variable changes and log lines back. Each script runs in a Worker the sandbox terminates after 10 s; scripts may
 * await, and async tests are awaited.
 */

export interface ScriptTest {
  name: string;
  pass: boolean;
  error?: string;
}
export interface ScriptResult {
  tests: ScriptTest[];
  logs: string[];
  /** Variable name → new value (null: removed). */
  changes: Record<string, string | null>;
  error: string | null;
}
export interface ScriptContext {
  request: { method: string; url: string; headers: Record<string, string> };
  response?: { status: number; statusText: string; headers: Record<string, string>; body: string; time: number; size: number };
  vars: Record<string, string>;
  /** The runner's data row for this iteration (CSV / JSON data file). */
  data?: Record<string, string>;
}

/** The sandbox stops a script after 10 s itself; this is the backstop if the frame stops answering. */
const TIMEOUT = 12_000;
let frame: HTMLIFrameElement | null = null;
let ready: Promise<void> | null = null;
const waiting = new Map<string, (r: ScriptResult) => void>();

function boot(): Promise<void> {
  if (ready && frame?.isConnected) return ready;
  frame?.remove();
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.style.display = 'none';
  f.src = 'sandbox.html';
  frame = f;
  ready = new Promise((resolve) => {
    const onReady = (e: MessageEvent) => {
      if (e.source === f.contentWindow && e.data?.ready) {
        window.removeEventListener('message', onReady);
        resolve();
      }
    };
    window.addEventListener('message', onReady);
  });
  document.body.appendChild(f);
  return ready;
}

window.addEventListener('message', (e) => {
  if (!frame || e.source !== frame.contentWindow || !e.data?.id) return;
  const done = waiting.get(e.data.id);
  if (!done) return;
  waiting.delete(e.data.id);
  const d = e.data as ScriptResult & { id: string };
  done({ tests: Array.isArray(d.tests) ? d.tests : [], logs: Array.isArray(d.logs) ? d.logs.map(String) : [], changes: d.changes && typeof d.changes === 'object' ? d.changes : {}, error: d.error ? String(d.error) : null });
});

export async function runScript(code: string, ctx: ScriptContext): Promise<ScriptResult> {
  await boot();
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      // A loop that never ends: drop the frame, a new one is made next time.
      frame?.remove();
      frame = null;
      ready = null;
      resolve({ tests: [], logs: [], changes: {}, error: 'The script sandbox did not answer' });
    }, TIMEOUT);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    frame!.contentWindow!.postMessage({ id, code, ctx: JSON.parse(JSON.stringify(ctx)) }, '*');
  });
}

export const headerObject = (headers: [string, string][]) => Object.fromEntries(headers.map(([k, v]) => [k.toLowerCase(), v]));

export function requestContext(w: WireRequest) {
  return { method: w.method, url: w.url, headers: headerObject(w.headers) };
}
export function responseContext(r: HttpResponse) {
  return { status: r.status, statusText: r.statusText, headers: headerObject(r.headers), body: r.body, time: r.timings.total, size: r.size };
}
