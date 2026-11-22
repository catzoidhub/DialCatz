import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { SpecResponse, TreeItem } from '@shared/types';
import { importSpec, importText } from '../src/main/importers';
import { isWorkspaceFolder, readFolder } from '../src/main/folders';
import { json, junit, paint, plainMarks, requestLines, summaryLine, totals } from './report';
import { closeAll, runCollection, type RequestResult, type RunResult } from './run';
import { read as readData } from '../src/main/datafile';
import { hostMatches, setIdentityFinder } from '../src/main/tlsidentity';
import { createSecureContext } from 'node:tls';
import { readEnvFile, specKey } from './plan';

/**
 * dialcatz — DialCatz's collections from a terminal or a CI job (#101), without the app.
 *   dialcatz run <path> [options]
 * <path>: a workspace folder (the one with dialcatz.yml, usually in your repository), a collection file exported from
 * DialCatz or Postman, or an OpenAPI / Swagger file. It exits 0 when everything passed, 1 when a request or a test
 * failed, 2 when it could not start.
 */

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

const HELP = `DialCatz CLI ${VERSION}: run a collection's requests and tests without the app.

Usage
  dialcatz run <path> [options]

  <path>   a workspace folder (the one with dialcatz.yml), a collection exported from DialCatz or
           Postman, or an OpenAPI / Swagger file

Options
  -c, --collection <name>   only this collection (a workspace folder may hold several)
  -f, --folder <name>       only the requests under this folder (or one request of this name)
  -v, --var <name=value>    a variable's value; repeat for more
      --env-file <file>     variables from a file of NAME=value lines (a .env file)
  -d, --data <file>         run once per row of a CSV (with a header row) or a JSON array of objects;
                            a row's values win over the other variables
      --file <field=path>   the file for a multipart field (or body=<path> for a binary body); repeat
      --spec <file>         check every response against this OpenAPI file (status, type, body)
      --proto <file>        .proto files for gRPC requests whose server has no reflection; repeat
      --ws-wait <seconds>   how long a WebSocket request listens after connecting (default 2)
      --cert <file>         a client certificate (PEM) with --key <file>, or --pfx <file> (PKCS#12);
      --key <file>          the passphrase comes from --passphrase or DIALCATZ_CERT_PASSPHRASE;
      --pfx <file>          --cert-host <name> limits it to that host (api.example.com, *.example.com)
      --bail                stop at the first failure
      --insecure            skip TLS certificate checks
      --timeout <seconds>   per request (default 30)
  -r, --reporter <kind>     cli (default), json or junit; repeat for more than one
  -o, --output <file>       where json / junit is written (default: the terminal)
      --verbose             passed tests and script logs too
      --no-color            plain text
  -h, --help                this page
      --version

Variables
  A {{name}} takes its value from --var, then --env-file, then an environment variable of the
  same name, then what the file itself defines (an OpenAPI server as baseUrl, a Postman
  collection's variables). Workspace folders never hold values, so pass them in.

Kinds of request
  HTTP in all its bodies, Server-Sent Events (the first seconds), GraphQL, JSON-RPC and gRPC are
  sent and tested. WebSocket, Socket.IO and Pusher requests connect, send the first message kept
  with the request, listen for --ws-wait and give what arrived to the tests as dc.messages.
  OAuth 2.0: client credentials and password get their token by themselves; a device code sign-in
  is asked for when a person is at the terminal.

Examples
  dialcatz run ./api-workspace --var baseUrl=https://staging.example.com --env-file .env.ci
  dialcatz run shop.postman_collection.json -r cli -r junit -o results.xml
  dialcatz run openapi.yaml --spec openapi.yaml --var baseUrl=http://localhost:3000
  dialcatz run ./api-workspace -c Orders --data orders.csv --file avatar=./fixtures/cat.png
`;

class Usage extends Error {}

function parse(argv: string[]) {
  const o = { command: '', path: '', collection: '', folder: '', vars: [] as string[], envFile: '', spec: '', data: '', files: [] as string[], protos: [] as string[], wsWait: 2, cert: '', key: '', pfx: '', passphrase: '', certHost: '', bail: false, insecure: false, timeout: 30, reporters: [] as string[], output: '', verbose: false, color: true, help: false, version: false };
  const short: Record<string, string> = { '-c': '--collection', '-f': '--folder', '-d': '--data', '-v': '--var', '-r': '--reporter', '-o': '--output', '-h': '--help' };
  const rest = [...argv];
  const positional: string[] = [];
  while (rest.length) {
    let a = rest.shift()!;
    let inline: string | undefined;
    if (a.startsWith('--') && a.includes('=')) [a, inline] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)];
    a = short[a] ?? a;
    const value = () => {
      const v = inline ?? rest.shift();
      if (v === undefined) throw new Usage(`${a} needs a value`);
      return v;
    };
    if (a === '--collection') o.collection = value();
    else if (a === '--folder') o.folder = value();
    else if (a === '--var') o.vars.push(value());
    else if (a === '--env-file') o.envFile = value();
    else if (a === '--spec') o.spec = value();
    else if (a === '--data') o.data = value();
    else if (a === '--file') o.files.push(value());
    else if (a === '--proto') o.protos.push(value());
    else if (a === '--cert') o.cert = value();
    else if (a === '--key') o.key = value();
    else if (a === '--pfx') o.pfx = value();
    else if (a === '--passphrase') o.passphrase = value();
    else if (a === '--cert-host') o.certHost = value();
    else if (a === '--ws-wait') {
      o.wsWait = Number(value());
      if (!(o.wsWait >= 0)) throw new Usage('--ws-wait takes seconds');
    }
    else if (a === '--timeout') {
      o.timeout = Number(value());
      if (!(o.timeout > 0)) throw new Usage('--timeout takes seconds, more than 0');
    } else if (a === '--reporter') o.reporters.push(value());
    else if (a === '--output') o.output = value();
    else if (a === '--bail') o.bail = true;
    else if (a === '--insecure') o.insecure = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--help') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a.startsWith('-')) throw new Usage(`Unknown option ${a}`);
    else positional.push(a);
  }
  [o.command = '', o.path = ''] = positional;
  if (positional.length > 2) throw new Usage(`One path at a time: ${positional.slice(1).join(', ')}`);
  for (const r of o.reporters) if (!['cli', 'json', 'junit'].includes(r)) throw new Usage(`Unknown reporter ${r}: cli, json or junit`);
  if (!o.reporters.length) o.reporters.push('cli');
  return o;
}

interface Loaded {
  /** Where relative file paths start. */
  dir: string;
  name: string;
  items: TreeItem[];
  collections: TreeItem[];
  /** Values the file itself brings (an OpenAPI server, a Postman collection's variables). */
  defaults: [string, string][];
}

function load(path: string): Loaded {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Usage(`${path} does not exist`);
  if (statSync(abs).isDirectory()) {
    if (!isWorkspaceFolder(abs)) throw new Usage(`${path} is not a DialCatz workspace folder (no dialcatz.yml). In the app: workspace menu → Keep in a folder.`);
    const d = readFolder(abs);
    if (d.errors.length) throw new Usage(`Some files could not be read:\n  ${d.errors.join('\n  ')}`);
    return { dir: abs, name: d.name || basename(abs), items: d.items, collections: d.items.filter((i) => i.kind === 'collection'), defaults: [] };
  }
  let r: ReturnType<typeof importText>;
  try {
    r = importText(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Usage(`${path}: ${(e as Error).message}`);
  }
  const defaults: [string, string][] = [...(r.variables ?? []).filter((v) => v.enabled !== false && v.key).map((v) => [v.key, v.value] as [string, string]), ...(r.baseUrl ? [['baseUrl', r.baseUrl] as [string, string]] : [])];
  return { dir: dirname(abs), name: r.root.name, items: [r.root, ...r.items], collections: [r.root], defaults };
}

function loadSpec(path: string): Map<string, SpecResponse[]> {
  if (!existsSync(path)) throw new Usage(`--spec: ${path} does not exist`);
  let r: ReturnType<typeof importSpec>;
  try {
    r = importSpec(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Usage(`--spec ${path}: ${(e as Error).message}`);
  }
  const out = new Map<string, SpecResponse[]>();
  for (const i of r.items) if (i.kind === 'request' && i.request) out.set(specKey(i.request.method, i.request.url), i.specResponses ?? []);
  if (!out.size) throw new Usage(`--spec ${path}: no operations found in it`);
  return out;
}

async function main(argv: string[]): Promise<number> {
  const o = parse(argv);
  if (o.version) return console.log(VERSION), 0;
  if (o.help || !o.command) return console.log(HELP), o.help ? 0 : 2;
  if (o.command !== 'run') throw new Usage(`Unknown command ${o.command}: the CLI has one, run`);
  if (!o.path) throw new Usage('Which collection? dialcatz run <path>');

  const loaded = load(o.path);
  let collections = loaded.collections;
  if (o.collection) {
    collections = collections.filter((c) => c.name.toLowerCase() === o.collection.toLowerCase());
    if (!collections.length) throw new Usage(`No collection called ${o.collection} in ${o.path}. It has: ${loaded.collections.map((c) => c.name).join(', ') || 'none'}`);
  }
  if (!collections.length) throw new Usage(`${o.path} has no collections`);

  // Lowest first: the file's own values, environment variables of a name the collection uses, --env-file, --var.
  const vars = new Map<string, string>(loaded.defaults);
  const used = new Set([...JSON.stringify(loaded.items).matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)].map((m) => m[1]));
  for (const name of used) if (process.env[name] !== undefined) vars.set(name, process.env[name]!);
  if (o.envFile) {
    if (!existsSync(o.envFile)) throw new Usage(`--env-file: ${o.envFile} does not exist`);
    for (const [k, v] of readEnvFile(readFileSync(o.envFile, 'utf8'))) vars.set(k, v);
  }
  for (const pair of o.vars) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Usage(`--var takes name=value, not ${pair}`);
    vars.set(pair.slice(0, i), pair.slice(i + 1));
  }

  const spec = o.spec ? loadSpec(o.spec) : null;

  // --data: one run per row.
  let rows: Record<string, string>[] | null = null;
  if (o.data) {
    if (!existsSync(o.data)) throw new Usage(`--data: ${o.data} does not exist`);
    try {
      rows = readData(o.data).rows;
    } catch (e) {
      throw new Usage(`--data ${o.data}: ${(e as Error).message}`);
    }
  }
  const files = new Map<string, string>();
  for (const pair of o.files) {
    const i = pair.indexOf('=');
    if (i < 1) throw new Usage(`--file takes field=path (or body=path), not ${pair}`);
    if (!existsSync(pair.slice(i + 1))) throw new Usage(`--file: ${pair.slice(i + 1)} does not exist`);
    files.set(pair.slice(0, i), pair.slice(i + 1));
  }
  for (const f of o.protos) if (!existsSync(f)) throw new Usage(`--proto: ${f} does not exist`);

  // A client certificate (mutual TLS) for every host, or only --cert-host.
  if (o.cert || o.key || o.pfx) {
    if (o.pfx ? o.cert || o.key : !o.cert || !o.key) throw new Usage('A client certificate is --cert with --key (PEM), or --pfx alone (PKCS#12)');
    for (const f of [o.cert, o.key, o.pfx]) if (f && !existsSync(f)) throw new Usage(`${f} does not exist`);
    const passphrase = o.passphrase || process.env.DIALCATZ_CERT_PASSPHRASE || '';
    const id = { ...(o.pfx ? { pfx: readFileSync(o.pfx) } : { cert: readFileSync(o.cert), key: readFileSync(o.key) }), ...(passphrase ? { passphrase } : {}) };
    try {
      createSecureContext(id);
    } catch (e) {
      throw new Usage(`The client certificate cannot be used: ${(e as Error).message}`);
    }
    setIdentityFinder((host, port) => (!o.certHost || hostMatches(o.certHost, host, port) ? id : undefined));
  } else if (o.certHost || o.passphrase) throw new Usage('--cert-host and --passphrase go with --cert / --key or --pfx');
  const toTerminal = o.reporters.includes('cli');
  // json / junit on the terminal: the progress lines go to stderr so the output stays clean.
  const machineOnStdout = !o.output && o.reporters.some((r) => r !== 'cli');
  const say = (s: string) => (machineOnStdout ? process.stderr : process.stdout).write(`${s}\n`);
  const tty = (machineOnStdout ? process.stderr.isTTY : process.stdout.isTTY) === true;
  const p = paint(o.color && !process.env.NO_COLOR && tty, plainMarks(process.env, process.platform, tty));

  const runs: RunResult[] = [];
  const options = { version: VERSION, vars, insecure: o.insecure, timeoutMs: o.timeout * 1000, bail: o.bail, spec, folder: o.folder || null, files, baseDir: loaded.dir, protoFiles: o.protos.map((f) => resolve(f)), wsWaitMs: o.wsWait * 1000, interactive: process.stdin.isTTY === true && process.stderr.isTTY === true && !process.env.CI, say: (text: string) => void process.stderr.write(`${text}\n`), onResult: (r: RequestResult) => void (toTerminal && requestLines(r, p, o.verbose).forEach(say)) };
  run: for (const c of collections) {
    for (const [n, row] of (rows ?? [undefined]).entries()) {
      if (toTerminal) say(`\n${p.bold(c.name)}${row ? p.dim(`  row ${n + 1} of ${rows!.length}`) : ''}`);
      const run = await runCollection(loaded.items, c, options, row, row ? n + 1 : undefined);
      if (toTerminal && !run.requests.length) say(p.dim(o.folder ? `  No requests under ${o.folder}` : '  No requests'));
      runs.push(run);
      if (o.bail && run.requests.some((r) => r.outcome === 'failed')) break run;
    }
  }
  closeAll();
  const t = totals(runs);
  if (toTerminal) say(`\n${summaryLine(t, p)}\n`);
  if (!t.requests) throw new Usage(o.folder ? `No requests under ${o.folder}` : 'No requests to run');

  const machine = o.reporters.filter((r) => r !== 'cli');
  for (const r of machine) {
    const text = r === 'junit' ? junit(runs) : json(runs, VERSION);
    // Two machine reporters and one --output: the second takes its own ending.
    const file = o.output ? (machine.length > 1 ? o.output.replace(/(\.[^./\\]+)?$/, r === 'junit' ? '.xml' : '.json') : o.output) : '';
    if (file) {
      writeFileSync(file, text);
      if (toTerminal) say(p.dim(`${r} report: ${join(file)}`));
    } else process.stdout.write(text);
  }
  return t.failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(e instanceof Usage ? `dialcatz: ${e.message}\n\nTry dialcatz --help\n` : `dialcatz: ${e.stack ?? e.message}\n`);
    process.exit(2);
  },
);
