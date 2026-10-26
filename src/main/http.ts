import http from 'node:http';
import https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { rootCertificates } from 'node:tls';
import type { HttpResponse, SendOptions, SendResult, WireRequest } from '@shared/types';
import { store } from './store';

/**
 * Sends requests from the main process with node:http(s): no browser CORS rules, a real Host / Cookie header,
 * self-signed certificates on request, redirects followed by hand (each hop counted), the time to the first byte,
 * and bodies cut at MAX_BODY so a huge download cannot flood the window. One AbortController per send token.
 */

const MAX_BODY = 25 * 1024 * 1024;
const MAX_UPLOAD = 200 * 1024 * 1024;
const MAX_REDIRECTS = 10;

// ------------------------------------------------------------------ DevCatz's local CA

// DevCatz signs its sites' certificates with its own CA. Trust that CA (its public certificate only) for the hosts
// DevCatz serves — the site and app domains in its bridge.json, whatever their ending — and .localhost, so DevCatz
// sites work without turning certificate checks off. The CA can sign any name, so it is never trusted elsewhere.
const DEVCATZ = join(process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')), 'DevCatz');
let caCache: { mtime: number; ca: string[] } | null = null;
let hostCache: { mtime: number; hosts: Set<string> } | null = null;

/** The hosts DevCatz serves (bridge.json, re-read when it changes). */
function devcatzHosts(): Set<string> {
  const file = join(DEVCATZ, 'bridge.json');
  try {
    const mtime = statSync(file).mtimeMs;
    if (hostCache?.mtime !== mtime) {
      const hosts = new Set<string>();
      const add = (v: unknown) => {
        if (typeof v !== 'string' || !v) return;
        try {
          hosts.add((v.includes('://') ? new URL(v).hostname : v).toLowerCase());
        } catch {
          /* not an address */
        }
      };
      const b = JSON.parse(readFileSync(file, 'utf8')) as { sites?: { domain?: string; url?: string; apps?: { domain?: string; url?: string | null }[] }[] };
      for (const site of b.sites ?? []) {
        add(site.domain);
        add(site.url);
        for (const a of site.apps ?? []) (add(a.domain), add(a.url));
      }
      hostCache = { mtime, hosts };
    }
    return hostCache.hosts;
  } catch {
    return new Set();
  }
}

function localCa(host: string): string[] | undefined {
  const h = host.toLowerCase();
  if (h !== 'localhost' && !h.endsWith('.localhost') && !devcatzHosts().has(h)) return undefined;
  const file = join(DEVCATZ, 'certs', 'ca.crt');
  try {
    const mtime = statSync(file).mtimeMs;
    if (caCache?.mtime !== mtime) caCache = { mtime, ca: [...rootCertificates, readFileSync(file, 'utf8')] };
    return caCache.ca;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ files to send

/**
 * Only files the user picked in a file dialog can be sent: a request's file path could come from an imported
 * collection or a teammate (those are stripped too), and must never let a request read e.g. ~/.ssh/id_rsa.
 */
const PICKED = 'pickedFiles';
export function allowFile(path: string): void {
  const list = (store.extra<string[]>(PICKED) ?? []).filter((p) => p !== path);
  store.setExtra(PICKED, [path, ...list].slice(0, 500));
}
async function readPicked(path: string): Promise<Buffer> {
  if (!path) throw new Error('Choose a file for this request first');
  if (!(store.extra<string[]>(PICKED) ?? []).includes(path)) throw new Error(`Choose ${basename(path)} again with the file picker: DialCatz only sends files you picked on this computer`);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw new Error(`${basename(path)} is not there any more`);
  if (st.size > MAX_UPLOAD) throw new Error(`${basename(path)} is larger than ${MAX_UPLOAD / 1024 / 1024} MB`);
  return readFile(path);
}
const MIME: Record<string, string> = { '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };
const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

/** The request body as bytes: text, a multipart form (its own boundary) or a picked file. */
async function encodeBody(w: WireRequest): Promise<{ body?: Buffer; contentType?: string }> {
  if (w.multipart) {
    const boundary = `----DialCatz${Math.random().toString(36).slice(2, 14)}`;
    const chunks: Buffer[] = [];
    const q = (s: string) => s.replace(/["\r\n]/g, (c) => encodeURIComponent(c));
    for (const p of w.multipart) {
      if (p.file !== undefined) {
        const data = await readPicked(p.file);
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(p.name)}"; filename="${q(basename(p.file))}"\r\nContent-Type: ${mimeOf(p.file)}\r\n\r\n`), data, Buffer.from('\r\n'));
      } else chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(p.name)}"\r\n\r\n${p.value ?? ''}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  if (w.bodyFile !== undefined) return { body: await readPicked(w.bodyFile) };
  return { body: w.body !== undefined ? Buffer.from(w.body, 'utf8') : undefined };
}

const running = new Map<string, AbortController>();
/** The raw bytes of the last response per token, for "Save response". */
const lastBodies = new Map<string, Buffer>();

export function cancel(token: string): void {
  running.get(token)?.abort();
}

export const lastBody = (token: string) => lastBodies.get(token);

const TEXTISH = /^(text\/|application\/(json|.*\+json|xml|.*\+xml|javascript|x-www-form-urlencoded|graphql|yaml|x-yaml|problem\+json|ld\+json|x-ndjson))/i;

function looksText(buf: Buffer, contentType: string): boolean {
  if (TEXTISH.test(contentType)) return true;
  if (contentType && !/octet-stream/i.test(contentType)) return false;
  const n = Math.min(buf.length, 1024);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

function decode(res: http.IncomingMessage): Readable {
  switch ((res.headers['content-encoding'] ?? '').toString().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

interface Hop {
  status: number;
  statusText: string;
  headers: [string, string][];
  location?: string;
  buf: Buffer;
  truncated: boolean;
  ttfb: number;
}

function once(w: WireRequest, body: Buffer | undefined, signal: AbortSignal, opts: Required<SendOptions>, started: number): Promise<Hop> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(w.url);
    } catch {
      return reject(new Error(`Not a valid URL: ${w.url}`));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error(`Only http:// and https:// URLs can be sent (got ${u.protocol})`));
    const lib = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string | string[]> = {};
    const lower = new Set<string>();
    for (const [k, v] of w.headers) {
      const key = k.toLowerCase();
      lower.add(key);
      // Repeated headers stay repeated (Cookie joins with "; " as browsers do).
      if (headers[k] !== undefined) headers[k] = key === 'cookie' ? `${headers[k]}; ${v}` : ([] as string[]).concat(headers[k] as string, v);
      else headers[k] = v;
    }
    // Exactly the headers of the request (its auto headers included, see shared/request.ts); Host and
    // Content-Length are worked out here.
    if (body && !lower.has('content-length')) headers['Content-Length'] = String(body.length);

    const ca = u.protocol === 'https:' && !opts.insecure ? localCa(u.hostname) : undefined;
    const req = lib.request(u, { method: w.method, headers, signal, rejectUnauthorized: !opts.insecure, timeout: opts.timeoutMs, ...(ca ? { ca } : {}) }, (res) => {
      const ttfb = performance.now() - started;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const stream = decode(res);
      stream.on('data', (c: Buffer) => {
        if (truncated) return;
        size += c.length;
        if (size > MAX_BODY) {
          truncated = true;
          chunks.push(c.subarray(0, c.length - (size - MAX_BODY)));
          res.destroy();
          finish();
        } else chunks.push(c);
      });
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const hdrs: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) hdrs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? '', headers: hdrs, location: res.headers.location, buf: Buffer.concat(chunks), truncated, ttfb });
      };
      stream.on('end', finish);
      stream.on('error', (e) => (truncated ? finish() : reject(e)));
    });
    req.on('timeout', () => req.destroy(new Error(`No answer within ${Math.round(opts.timeoutMs / 1000)} s (timeout)`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function friendly(e: Error & { code?: string }, url: string): string {
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return 'Cancelled';
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep the text */
  }
  switch (e.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Could not find the server ${host} (DNS lookup failed)`;
    case 'ECONNREFUSED':
      return `${host} refused the connection: nothing is listening there`;
    case 'ECONNRESET':
      return `${host} closed the connection`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host} cannot be reached from this network`;
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The TLS certificate of ${host} is not trusted (${e.code}). For a local dev server, turn on "Skip certificate checks" in the collection's settings (or in Settings).`;
    default:
      return e.message || String(e);
  }
}

export async function send(w: WireRequest, token: string, options: SendOptions = {}): Promise<SendResult> {
  const opts: Required<SendOptions> = { timeoutMs: options.timeoutMs ?? 30_000, followRedirects: options.followRedirects ?? true, insecure: options.insecure ?? false };
  running.get(token)?.abort();
  const ctl = new AbortController();
  running.set(token, ctl);
  const started = performance.now();
  let cur = { ...w };
  let sent = { method: w.method, url: w.url, headers: w.headers, body: w.body };
  try {
    const enc = await encodeBody(w);
    if (enc.contentType) cur.headers = [...w.headers.filter(([k]) => k.toLowerCase() !== 'content-type'), ['Content-Type', enc.contentType]];
    let body = enc.body;
    const described = w.multipart ? w.multipart.map((p) => (p.file !== undefined ? `${p.name}=@${basename(p.file)}` : `${p.name}=${p.value ?? ''}`)).join('\n') : w.bodyFile !== undefined ? `<file ${basename(w.bodyFile)}, ${body?.length ?? 0} bytes>` : w.body;
    sent = { method: w.method, url: w.url, headers: cur.headers, body: described };
    let hop = await once(cur, body, ctl.signal, opts, started);
    let redirects = 0;
    while (opts.followRedirects && hop.location && [301, 302, 303, 307, 308].includes(hop.status)) {
      if (++redirects > MAX_REDIRECTS) throw new Error(`More than ${MAX_REDIRECTS} redirects`);
      const next = new URL(hop.location, cur.url).toString();
      const keepBody = hop.status === 307 || hop.status === 308;
      const crossOrigin = new URL(next).origin !== new URL(cur.url).origin;
      cur = {
        method: keepBody ? cur.method : cur.method === 'HEAD' ? 'HEAD' : 'GET',
        url: next,
        // Credentials do not follow to another origin.
        headers: cur.headers.filter(([k]) => (keepBody || !/^content-(type|length)$/i.test(k)) && !(crossOrigin && /^(authorization|cookie)$/i.test(k))),
      };
      if (!keepBody) body = undefined;
      hop = await once(cur, body, ctl.signal, opts, started);
    }
    const total = performance.now() - started;
    const contentType = (hop.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '').split(';')[0].trim().toLowerCase();
    const text = looksText(hop.buf, contentType);
    lastBodies.set(token, hop.buf);
    const response: HttpResponse = {
      ok: hop.status >= 200 && hop.status < 300,
      status: hop.status,
      statusText: hop.statusText || http.STATUS_CODES[hop.status] || '',
      headers: hop.headers,
      body: text ? hop.buf.toString('utf8') : '',
      binary: !text,
      bodyBase64: !text && hop.buf.length <= 10 * 1024 * 1024 ? hop.buf.toString('base64') : undefined,
      contentType,
      size: hop.buf.length,
      timings: { total: Math.round(total), ttfb: Math.round(hop.ttfb) },
      url: cur.url,
      redirected: redirects > 0,
      truncated: hop.truncated,
    };
    return { response, sent };
  } catch (e) {
    return { error: friendly(e as Error & { code?: string }, cur.url), sent };
  } finally {
    if (running.get(token) === ctl) running.delete(token);
  }
}
