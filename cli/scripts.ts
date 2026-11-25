import { readPatch, textRecord, type RequestPatch } from '@shared/scriptpatch';
import { Worker } from 'node:worker_threads';
import sandbox from '../src/renderer/public/sandbox.html?raw';

/**
 * Request scripts (pre-request, tests) in the CLI: the very code the app runs them with (the worker inside
 * renderer/public/sandbox.html: dc.*, pm.*, expect), started in a worker thread, inside a context of its own, and
 * stopped after 10 s. Scripts get the request / response and variables as plain data and hand back test results,
 * variable changes and log lines, as in the app. They are code from your own repository: treat them like any test.
 */

export interface ScriptResult {
  tests: { name: string; pass: boolean; error?: string }[];
  logs: string[];
  changes: Record<string, string | null>;
  error: string | null;
  locals?: Record<string, string>;
  patch?: RequestPatch;
}
export interface ScriptContext {
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  requestName?: string;
  collectionName?: string;
  envName?: string;
  response?: { status: number; statusText: string; headers: Record<string, string>; body: string; time: number; size: number };
  vars: Record<string, string>;
  data?: Record<string, string>;
  /** A WebSocket request: what arrived while it listened. */
  messages?: { data: string; event?: string; channel?: string }[];
}

const CODE = /<script id="worker"[^>]*>([\s\S]*?)<\/script>/.exec(sandbox)?.[1] ?? '';
const TIMEOUT = 10_000;
const BOOT = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const self = { onmessage: null, postMessage: (m) => parentPort.postMessage(m) };
const context = vm.createContext({ self, setTimeout, clearTimeout, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa });
vm.runInContext(workerData.code, context, { filename: 'dialcatz-script.js' });
parentPort.on('message', (data) => self.onmessage({ data }));
`;
const none = (error: string): ScriptResult => ({ tests: [], logs: [], changes: {}, error });

export function runScript(code: string, ctx: ScriptContext): Promise<ScriptResult> {
  if (!CODE) return Promise.resolve(none('The script runtime is missing from this build'));
  return new Promise((resolve) => {
    const w = new Worker(BOOT, { eval: true, workerData: { code: CODE }, resourceLimits: { maxOldGenerationSizeMb: 256 }, stdout: true, stderr: true });
    let done = false;
    const finish = (r: ScriptResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish(none(`The script ran longer than ${TIMEOUT / 1000} s and was stopped`)), TIMEOUT);
    w.on('message', (d: Partial<ScriptResult>) => finish({ tests: Array.isArray(d.tests) ? d.tests : [], logs: Array.isArray(d.logs) ? d.logs.map(String) : [], changes: d.changes && typeof d.changes === 'object' ? d.changes : {}, error: d.error ? String(d.error) : null, locals: textRecord(d.locals), patch: readPatch(d.patch) }));
    w.on('error', (e) => finish(none(e.message || 'The script failed')));
    w.on('exit', () => finish(none('The script stopped without an answer')));
    w.postMessage({ id: '1', code, ctx });
  });
}
