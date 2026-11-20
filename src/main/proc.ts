import { spawn, type ChildProcess } from 'node:child_process';

/** One command's result. Never throws for a non-zero exit: `code` says it. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeout?: number;
  input?: string;
  signal?: AbortSignal;
  /** Each output line as it comes (stdout and stderr). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** The child, once it runs (to keep or kill it). */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * Runs a program by its full path with arguments (no shell, so nothing in an argument is interpreted). Output is
 * kept up to 4 MB per stream.
 */
export function run(cmd: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { env: o.env ?? process.env, cwd: o.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ code: 127, stdout: '', stderr: (e as Error).message });
    }
    o.onSpawn?.(child);
    const timer = o.timeout ? setTimeout(() => child.kill(), o.timeout) : undefined;
    o.signal?.addEventListener('abort', () => child.kill(), { once: true });
    const lines = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      return (d: Buffer) => {
        const s = d.toString();
        if (stream === 'stdout') stdout = (stdout + s).slice(-4_000_000);
        else stderr = (stderr + s).slice(-4_000_000);
        if (!o.onLine) return;
        buf += s;
        let nl: number;
        while ((nl = buf.search(/\r?\n|\r/)) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
          if (line.trim()) o.onLine(line, stream);
        }
      };
    };
    child.stdout?.on('data', lines('stdout'));
    child.stderr?.on('data', lines('stderr'));
    child.on('error', (e) => finish({ code: 127, stdout, stderr: stderr || e.message }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
    if (o.input !== undefined) child.stdin?.end(o.input);
    else child.stdin?.end();
  });
}

/** The last meaningful line of an error output, for a plain-words message. */
export function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^time="[^"]*"\s+level=\w+\s+msg=/, '').replace(/^"|"$/g, '').trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
