import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import 'protobufjs/ext/descriptor';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { GrpcMethodInfo, GrpcServiceInfo } from '@shared/types';

/**
 * gRPC requests (#98): grpc://host:port (plain) or grpcs://host:port (TLS). What a server offers comes from server
 * reflection (grpc.reflection.v1, else v1alpha) or from .proto files the user picked; both become one protobufjs Root,
 * kept per address + source for the session. Unary calls answer with one message; server streaming collects the
 * messages it sends (up to 200, or until the deadline). Client and bidirectional streaming are not offered.
 */

const REFLECTION = (pkg: string) => `syntax = "proto3"; package ${pkg};
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest { string host = 1; oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; ExtensionRequest file_containing_extension = 5; int32 all_extension_numbers_of_type = 6; string list_services = 7; } }
message ExtensionRequest { string containing_type = 1; int32 extension_number = 2; }
message ServerReflectionResponse { string valid_host = 1; ServerReflectionRequest original_request = 2; oneof message_response { FileDescriptorResponse file_descriptor_response = 4; ExtensionNumberResponse all_extension_numbers_response = 5; ListServiceResponse list_services_response = 6; ErrorResponse error_response = 7; } }
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ExtensionNumberResponse { string base_type_name = 1; repeated int32 extension_number = 2; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }`;

export const CODES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
/** The HTTP status closest to a gRPC code, so the response view's colours and the runner's checks read it right. */
export const HTTP_OF = [200, 499, 500, 400, 504, 404, 409, 403, 429, 400, 409, 400, 501, 500, 503, 500, 401];

export interface Target {
  address: string;
  tls: boolean;
}

export function target(url: string): Target {
  const m = url.trim().match(/^(grpcs?):\/\/([^/?#]+)/i);
  if (!m) throw new Error('A gRPC address looks like grpc://host:port (or grpcs:// for TLS)');
  const tls = m[1].toLowerCase() === 'grpcs';
  const address = /:\d+$/.test(m[2]) ? m[2] : `${m[2]}:${tls ? 443 : 80}`;
  return { address, tls };
}

function credentials(t: Target, insecure: boolean): grpc.ChannelCredentials {
  if (!t.tls) return grpc.credentials.createInsecure();
  return grpc.credentials.createSsl(null, null, null, insecure ? { checkServerIdentity: () => undefined, rejectUnauthorized: false } : undefined);
}

/** HTTP/1 headers that are not metadata (Connection and friends break the HTTP/2 connection outright). */
const NOT_METADATA = /^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade|host|te|content-type|content-length|accept|accept-encoding|cache-control|user-agent)$/i;
const metadataOf = (rows: [string, string][]) => {
  const md = new grpc.Metadata();
  for (const [k, v] of rows) if (k && /^[a-z0-9_.-]+$/i.test(k) && !NOT_METADATA.test(k) && !/^grpc-/i.test(k)) md.add(k.toLowerCase(), v);
  return md;
};

const roots = new Map<string, protobuf.Root>();
const rootKey = (t: Target, files?: string[]) => `${t.tls ? 's' : ''}${t.address}|${(files ?? []).join('|')}`;

/** What the server describes about itself (reflection), as a Root. */
async function reflect(t: Target, insecure: boolean, md: [string, string][], timeoutMs: number): Promise<protobuf.Root> {
  let lastError: Error | null = null;
  for (const pkg of ['grpc.reflection.v1', 'grpc.reflection.v1alpha']) {
    const r = protobuf.parse(REFLECTION(pkg)).root;
    const Req = r.lookupType(`${pkg}.ServerReflectionRequest`);
    const Res = r.lookupType(`${pkg}.ServerReflectionResponse`);
    const client = new grpc.Client(t.address, credentials(t, insecure));
    try {
      const files = new Map<string, Uint8Array>();
      const ask = (req: Record<string, unknown>): Promise<Record<string, unknown>> =>
        new Promise((resolveAsk, reject) => {
          const call = client.makeBidiStreamRequest(
            `/${pkg}.ServerReflection/ServerReflectionInfo`,
            (o: Record<string, unknown>) => Buffer.from(Req.encode(Req.fromObject(o)).finish()),
            (b: Buffer) => Res.toObject(Res.decode(b), { bytes: Array, defaults: false }) as Record<string, unknown>,
            metadataOf(md),
            // Each reflection version gets its own share: a server that ignores v1 must still leave time for v1alpha.
            { deadline: Date.now() + Math.min(timeoutMs, 8000) },
          );
          call.on('data', (d: Record<string, unknown>) => {
            resolveAsk(d);
            call.end();
          });
          call.on('error', reject);
          call.write(req);
        });
      const list = await ask({ listServices: '' });
      if (list.errorResponse) throw new Error(String((list.errorResponse as { errorMessage?: string }).errorMessage ?? 'reflection error'));
      const services = ((list.listServicesResponse as { service?: { name: string }[] } | undefined)?.service ?? []).map((s) => s.name).filter((n) => !n.startsWith('grpc.reflection.'));
      const take = (d: Record<string, unknown>) => {
        for (const raw of ((d.fileDescriptorResponse as { fileDescriptorProto?: number[][] } | undefined)?.fileDescriptorProto ?? [])) {
          const bytes = Uint8Array.from(raw);
          const fd = (protobuf as unknown as { descriptor: { FileDescriptorProto: protobuf.Type } }).descriptor.FileDescriptorProto.decode(bytes) as unknown as { name: string; dependency?: string[] };
          if (!files.has(fd.name)) files.set(fd.name, bytes);
        }
      };
      for (const s of services) take(await ask({ fileContainingSymbol: s }));
      // Imports the server did not send along.
      for (let grew = true; grew; ) {
        grew = false;
        const FDP = (protobuf as unknown as { descriptor: { FileDescriptorProto: protobuf.Type } }).descriptor.FileDescriptorProto;
        for (const bytes of [...files.values()]) {
          for (const dep of ((FDP.decode(bytes) as unknown as { dependency?: string[] }).dependency ?? [])) {
            if (files.has(dep) || dep.startsWith('google/protobuf/')) continue;
            take(await ask({ fileByFilename: dep }));
            grew = files.has(dep) || grew;
            if (!files.has(dep)) files.set(dep, new Uint8Array());
          }
        }
      }
      const FDS = (protobuf as unknown as { descriptor: { FileDescriptorSet: protobuf.Type } }).descriptor.FileDescriptorSet;
      const FDP = (protobuf as unknown as { descriptor: { FileDescriptorProto: protobuf.Type } }).descriptor.FileDescriptorProto;
      const set = FDS.fromObject({ file: [...files.values()].filter((b) => b.length).map((b) => FDP.toObject(FDP.decode(b))) });
      return (protobuf.Root as unknown as { fromDescriptor: (s: unknown) => protobuf.Root }).fromDescriptor(set);
    } catch (e) {
      lastError = e as Error;
      // Not served, or no answer to this version: the next one may be. Only an address that cannot be reached stops here.
      if ((e as { code?: number }).code === grpc.status.UNAVAILABLE) break;
    } finally {
      client.close();
    }
  }
  const code = (lastError as { code?: number } | null)?.code;
  const msg = lastError?.message ?? 'no answer';
  if (code === grpc.status.UNIMPLEMENTED || code === grpc.status.DEADLINE_EXCEEDED) throw new Error('The server does not offer reflection (or does not answer it). Choose its .proto files instead.');
  // A TLS address on a server without TLS (or the other way round): say which to try.
  if (/WRONG_VERSION_NUMBER|wrong version number/i.test(msg)) throw new Error(`${t.address} does not speak TLS: use grpc:// instead of grpcs://`);
  if (t.tls === false && /Protocol error|unexpected HTTP status|Received RST_STREAM/i.test(msg)) throw new Error(`Reflection failed: ${msg} (if the server uses TLS, try grpcs://)`);
  throw new Error(`Reflection failed: ${msg}`);
}

/** .proto files as a Root; imports resolve next to the importing file, then next to every picked file. */
function fromFiles(files: string[]): protobuf.Root {
  const root = new protobuf.Root();
  const dirs = [...new Set(files.map((f) => dirname(f)))];
  root.resolvePath = (origin, target2) => {
    if (isAbsolute(target2)) return target2;
    for (const d of [origin ? dirname(origin) : '', ...dirs]) {
      const p = resolve(d || '.', target2);
      if (existsSync(p)) return p;
    }
    return join(dirs[0] ?? '.', target2);
  };
  return root.loadSync(files, { keepCase: false });
}

/** An example message for a type: each field with a value of its kind (nested messages a few levels deep). */
function exampleOf(type: protobuf.Type, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of type.fieldsArray) {
    f.resolve();
    let v: unknown;
    if (f.resolvedType instanceof protobuf.Type) v = depth < 3 ? exampleOf(f.resolvedType, depth + 1) : {};
    else if (f.resolvedType instanceof protobuf.Enum) v = Object.keys(f.resolvedType.values)[0] ?? 0;
    else v = { string: '', bool: false, bytes: '' }[f.type] ?? (/int|fixed|double|float/.test(f.type) ? 0 : null);
    out[f.name] = f.repeated ? [v] : f.map ? {} : v;
  }
  return out;
}

function describeRoot(root: protobuf.Root): GrpcServiceInfo[] {
  const services: GrpcServiceInfo[] = [];
  const walk = (ns: protobuf.NamespaceBase) => {
    for (const o of ns.nestedArray) {
      if (o instanceof protobuf.Service) {
        const full = o.fullName.replace(/^\./, '');
        if (full.startsWith('grpc.reflection.')) continue;
        services.push({
          name: full,
          methods: o.methodsArray.map((m): GrpcMethodInfo => {
            m.resolve();
            return { name: m.name, requestType: m.requestType.replace(/^\./, ''), responseType: m.responseType.replace(/^\./, ''), clientStreaming: !!m.requestStream, serverStreaming: !!m.responseStream, example: JSON.stringify(exampleOf(m.resolvedRequestType!), null, 2) };
          }),
        });
      } else if (o instanceof protobuf.Namespace) walk(o);
    }
  };
  walk(root);
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

export async function describe(url: string, o: { protoFiles?: string[]; insecure?: boolean; metadata?: [string, string][]; timeoutMs?: number }): Promise<{ services: GrpcServiceInfo[]; source: 'reflection' | 'files' }> {
  const t = target(url);
  const files = o.protoFiles?.length ? o.protoFiles : undefined;
  const root = files ? fromFiles(files) : await reflect(t, !!o.insecure, o.metadata ?? [], o.timeoutMs ?? 15_000);
  roots.set(rootKey(t, files), root);
  return { services: describeRoot(root), source: files ? 'files' : 'reflection' };
}

const running = new Map<string, grpc.Client>();
export function cancel(token: string): void {
  running.get(token)?.close();
}

export interface CallResult {
  code: number;
  details: string;
  messages: unknown[];
  headers: [string, string][];
  ttfb: number;
}

/** One call: unary, or server streaming (its messages collected). */
export async function call(o: { url: string; service: string; method: string; message: string; metadata: [string, string][]; protoFiles?: string[]; insecure?: boolean; timeoutMs: number; token: string }): Promise<CallResult> {
  const t = target(o.url);
  const files = o.protoFiles?.length ? o.protoFiles : undefined;
  let root = roots.get(rootKey(t, files));
  if (!root) {
    await describe(o.url, { protoFiles: files, insecure: o.insecure, metadata: o.metadata, timeoutMs: o.timeoutMs });
    root = roots.get(rootKey(t, files))!;
  }
  if (!o.service || !o.method) throw new Error('Pick the service and method first (Message → Load from server, or .proto files…)');
  let svc: protobuf.Service;
  try {
    svc = root.lookupService(o.service);
  } catch {
    throw new Error(`The server has no service ${o.service} (load its services again)`);
  }
  const m = svc.methods[o.method];
  if (!m) throw new Error(`${o.service} has no method ${o.method}`);
  m.resolve();
  if (m.requestStream) throw new Error(`${o.method} streams from the client: only unary and server-streaming methods can be called`);
  const Req = m.resolvedRequestType!;
  const Res = m.resolvedResponseType!;
  let input: Record<string, unknown> = {};
  if (o.message.trim()) {
    try {
      input = JSON.parse(o.message);
    } catch (e) {
      throw new Error(`The message is not JSON: ${(e as Error).message}`);
    }
  }
  // Checked once converted (enum names, strings for 64-bit numbers): a field of the wrong kind is said before sending.
  let err: string | null;
  try {
    err = Req.verify(Req.fromObject(input));
  } catch (e) {
    err = (e as Error).message;
  }
  if (err) throw new Error(`The message does not fit ${Req.name}: ${err}`);
  const path = `/${o.service}/${o.method}`;
  const ser = (x: Record<string, unknown>) => Buffer.from(Req.encode(Req.fromObject(x)).finish());
  const de = (b: Buffer) => Res.toObject(Res.decode(b), { longs: String, enums: String, bytes: String, defaults: true, json: true });
  const client = new grpc.Client(t.address, credentials(t, !!o.insecure));
  running.get(o.token)?.close();
  running.set(o.token, client);
  const started = performance.now();
  let ttfb = 0;
  const headers: [string, string][] = [];
  const addMd = (md: grpc.Metadata, prefix: string) => {
    for (const [k, v] of Object.entries(md.getMap())) headers.push([`${prefix}${k}`, Buffer.isBuffer(v) ? v.toString('base64') : String(v)]);
  };
  try {
    return await new Promise<CallResult>((done) => {
      const deadline = Date.now() + o.timeoutMs;
      const finish = (status: grpc.StatusObject | null, messages: unknown[], e?: grpc.ServiceError) => {
        if (status?.metadata) addMd(status.metadata, 'trailer: ');
        done({ code: e?.code ?? status?.code ?? 0, details: e?.details ?? status?.details ?? '', messages, headers, ttfb: ttfb || performance.now() - started });
      };
      if (m.responseStream) {
        const messages: unknown[] = [];
        const s = client.makeServerStreamRequest(path, ser, de, input, metadataOf(o.metadata), { deadline });
        s.on('metadata', (md: grpc.Metadata) => ((ttfb = performance.now() - started), addMd(md, '')));
        s.on('data', (d: unknown) => {
          messages.push(d);
          if (messages.length >= 200) s.cancel();
        });
        let st: grpc.StatusObject | null = null;
        s.on('status', (x: grpc.StatusObject) => (st = x));
        s.on('error', (e: grpc.ServiceError) => finish(null, messages, e.code === grpc.status.CANCELLED && messages.length >= 200 ? undefined : e));
        s.on('end', () => finish(st, messages));
      } else {
        const c = client.makeUnaryRequest(path, ser, de, input, metadataOf(o.metadata), { deadline }, (e, res) => (e ? finish(null, [], e) : finish(st, [res])));
        let st: grpc.StatusObject | null = null;
        c.on('metadata', (md: grpc.Metadata) => ((ttfb = performance.now() - started), addMd(md, '')));
        c.on('status', (x: grpc.StatusObject) => (st = x));
      }
    });
  } finally {
    if (running.get(o.token) === client) running.delete(o.token);
    client.close();
  }
}
