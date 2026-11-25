import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  canonicalPolicyJson,
  MAX_MCP_PROBE_TOOLS,
  MAX_MCP_TOOL_DESCRIPTION_BYTES,
  mcpFormatValue,
  mcpRemoteOf,
  type McpProbeReport,
  type McpProbeTool,
  type McpSpec,
  McpToolName,
} from '@remyral/protocol';
import { isForbiddenAddress } from '../sandbox/network.js';
import { pinnedFetch } from './pinned-fetch.js';
import { WORKER_VERSION } from '../version.js';

/**
 * p14-mcp-core (design §2.8): tool discovery for one remote MCP server, run by the worker (the master never connects
 * to an MCP server and never holds its token). A deliberately small client of its own — no dependency:
 *
 * - **streamable HTTP** (`http`): POST `initialize` → POST `notifications/initialized` → POST `tools/list` (cursor
 *   pages) → DELETE the session. Answers may be `application/json` or a `text/event-stream`; `Mcp-Session-Id` and
 *   `MCP-Protocol-Version` are sent back as the specification asks.
 * - **legacy SSE** (`sse`): GET opens the stream, its `endpoint` event names the POST URL (same origin only), answers
 *   arrive as `message` events.
 *
 * Bounds: https only (the spec URL, already validated), `redirect: 'error'`, the host must not resolve to a private /
 * loopback / metadata address, 60 s wall time, ≤ 4 MiB per answer, ≤ 20 pages, ≤ 256 tools reported (the rest
 * counted), descriptions cut to 1 KiB, control characters dropped. Server text is untrusted data.
 */

export const MCP_PROBE_TIMEOUT_MS = 60_000;
export const MAX_MCP_PROBE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 20;
/** The protocol revision the client asks for (the server answers with the one it speaks). */
export const MCP_CLIENT_PROTOCOL_VERSION = '2025-06-18';

export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface McpProbeDeps {
  /** Tests: the HTTP client (default: {@link pinnedFetch} to the address the SSRF check approved). */
  readonly fetch?: McpFetch;
  /** Tests: builds the default client for the checked host and address. */
  readonly pinnedFetch?: (host: string, address: string) => McpFetch;
  /** Address lookup for the SSRF check (default: DNS, all addresses). */
  readonly lookup?: (host: string) => Promise<readonly string[]>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: () => number;
}

export class McpProbeError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpProbeError';
  }
}

interface RpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

async function defaultLookup(host: string): Promise<readonly string[]> {
  const all = await dnsLookup(host, { all: true, verbatim: true });
  return all.map((a) => a.address);
}

/** Header values of the spec with the secret slots filled in (values only in memory, never logged). */
export function probeHeaders(
  spec: McpSpec,
  secrets: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(mcpRemoteOf(spec)?.headers ?? {})) {
    if (typeof value === 'string') out[name] = value;
    else {
      const v = secrets[value.secret];
      if (v === undefined)
        throw new McpProbeError('mcp_secret_missing', `secret slot ${value.secret} is unbound`);
      out[name] = mcpFormatValue(value.format, v);
    }
  }
  return out;
}

/** Bounded body reader (bytes). */
async function readBounded(res: Response, signal: AbortSignal): Promise<string> {
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    if (signal.aborted) throw new McpProbeError('timeout', 'the MCP server did not answer in time');
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_MCP_PROBE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpProbeError('response_too_large', 'the MCP server sent more than 4 MiB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/** Incremental `text/event-stream` parser over a response body (bounded in total bytes). */
async function* sseEvents(res: Response, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return;
  const decoder = new TextDecoder();
  let buf = '';
  let total = 0;
  let event = 'message';
  let data: string[] = [];
  try {
    for (;;) {
      if (signal.aborted) throw new McpProbeError('timeout', 'the MCP server did not answer in time');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MCP_PROBE_RESPONSE_BYTES) {
        throw new McpProbeError('response_too_large', 'the MCP server sent more than 4 MiB');
      }
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length > 0) yield { event, data: data.join('\n') };
          event = 'message';
          data = [];
        } else if (line.startsWith(':')) {
          // comment / keep-alive
        } else {
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'event') event = v;
          else if (field === 'data') data.push(v);
        }
      }
    }
    if (data.length > 0) yield { event, data: data.join('\n') };
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseRpc(text: string): RpcMessage[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new McpProbeError('protocol_error', 'the MCP server sent invalid JSON');
  }
  const list = Array.isArray(json) ? json : [json];
  return list.filter((m): m is RpcMessage => typeof m === 'object' && m !== null);
}

function rpcResult(msg: RpcMessage, method: string): Record<string, unknown> {
  if (msg.error !== undefined) {
    const e = msg.error as { code?: unknown; message?: unknown };
    const text = typeof e.message === 'string' ? e.message.slice(0, 200) : 'error';
    throw new McpProbeError('server_error', `${method}: ${text}`);
  }
  if (typeof msg.result !== 'object' || msg.result === null) {
    throw new McpProbeError('protocol_error', `${method}: no result`);
  }
  return msg.result as Record<string, unknown>;
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** Cuts untrusted text to `max` UTF-8 bytes (never in the middle of a character), control characters dropped. */
export function cutUtf8(text: string, max: number): string {
  const clean = text.replace(CONTROL, ' ');
  if (Buffer.byteLength(clean, 'utf8') <= max) return clean;
  let out = '';
  let n = 0;
  for (const ch of clean) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function schemaSha256(schema: unknown): string {
  let text: string;
  try {
    text = canonicalPolicyJson((schema ?? null) as Json);
  } catch {
    text = 'null';
  }
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toTool(raw: unknown): McpProbeTool | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
  const name = McpToolName.safeParse(t.name);
  if (!name.success) return null;
  const ann =
    typeof t.annotations === 'object' && t.annotations !== null
      ? (t.annotations as { readOnlyHint?: unknown })
      : {};
  return {
    name: name.data,
    description: cutUtf8(
      typeof t.description === 'string' ? t.description : '',
      MAX_MCP_TOOL_DESCRIPTION_BYTES,
    ),
    schemaSha256: schemaSha256(t.inputSchema),
    ...(typeof ann.readOnlyHint === 'boolean' ? { readOnlyHint: ann.readOnlyHint } : {}),
  };
}

/** A transport: one request → its answer (matched by id); notifications → no answer. */
interface Session {
  request(id: number, method: string, params: Record<string, unknown>): Promise<RpcMessage>;
  notify(method: string): Promise<void>;
  protocolVersion(v: string): void;
  close(): Promise<void>;
}

function streamable(
  url: string,
  headers: Record<string, string>,
  fetch: McpFetch,
  signal: AbortSignal,
): Session {
  let session: string | null = null;
  let version: string | null = null;
  const base = (): Record<string, string> => ({
    ...headers,
    ...(session === null ? {} : { 'Mcp-Session-Id': session }),
    ...(version === null ? {} : { 'MCP-Protocol-Version': version }),
  });
  const post = async (body: unknown): Promise<Response> => {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        ...base(),
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid !== null && /^[\x21-\x7e]{1,256}$/.test(sid)) session = sid;
    return res;
  };
  return {
    async request(id, method, params) {
      const res = await post({ jsonrpc: '2.0', id, method, params });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new McpProbeError(
          res.status === 401 || res.status === 403 ? 'unauthorized' : 'http_error',
          `${method}: HTTP ${String(res.status)}`,
        );
      }
      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      if (type.startsWith('text/event-stream')) {
        for await (const ev of sseEvents(res, signal)) {
          if (ev.event !== 'message') continue;
          for (const m of parseRpc(ev.data)) if (m.id === id) return m;
        }
        throw new McpProbeError('protocol_error', `${method}: the stream ended without an answer`);
      }
      const found = parseRpc(await readBounded(res, signal)).find((m) => m.id === id);
      if (found === undefined) throw new McpProbeError('protocol_error', `${method}: no answer`);
      return found;
    },
    async notify(method) {
      const res = await post({ jsonrpc: '2.0', method });
      await res.body?.cancel().catch(() => undefined);
      if (!res.ok) throw new McpProbeError('http_error', `${method}: HTTP ${String(res.status)}`);
    },
    protocolVersion(v) {
      version = v;
    },
    async close() {
      if (session === null) return;
      const res = await fetch(url, { method: 'DELETE', redirect: 'error', signal, headers: base() }).catch(
        () => null,
      );
      await res?.body?.cancel().catch(() => undefined);
    },
  };
}

async function legacySse(
  url: string,
  headers: Record<string, string>,
  fetch: McpFetch,
  signal: AbortSignal,
): Promise<Session> {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal,
    headers: { ...headers, Accept: 'text/event-stream' },
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new McpProbeError(
      res.status === 401 || res.status === 403 ? 'unauthorized' : 'http_error',
      `SSE stream: HTTP ${String(res.status)}`,
    );
  }
  const events = sseEvents(res, signal);
  const next = async (): Promise<SseEvent> => {
    const r = await events.next();
    if (r.done === true) throw new McpProbeError('protocol_error', 'the SSE stream ended');
    return r.value;
  };
  let endpoint: string | null = null;
  while (endpoint === null) {
    const ev = await next();
    if (ev.event !== 'endpoint') continue;
    let target: URL;
    try {
      target = new URL(ev.data.trim(), url);
    } catch {
      throw new McpProbeError('protocol_error', 'invalid endpoint event');
    }
    if (target.origin !== new URL(url).origin) {
      throw new McpProbeError('protocol_error', 'the endpoint event names another origin; refused');
    }
    endpoint = target.toString();
  }
  const post = endpoint;
  const waiting = new Map<number, RpcMessage>();
  return {
    async request(id, method, params) {
      const r = await fetch(post, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      await r.body?.cancel().catch(() => undefined);
      if (!r.ok) throw new McpProbeError('http_error', `${method}: HTTP ${String(r.status)}`);
      for (;;) {
        const got = waiting.get(id);
        if (got !== undefined) return got;
        const ev = await next();
        if (ev.event !== 'message') continue;
        for (const m of parseRpc(ev.data)) if (typeof m.id === 'number') waiting.set(m.id, m);
      }
    },
    async notify(method) {
      const r = await fetch(post, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method }),
      });
      await r.body?.cancel().catch(() => undefined);
    },
    protocolVersion() {
      // the legacy transport carries no version header
    },
    async close() {
      await events.return(undefined).catch(() => undefined);
    },
  };
}

/**
 * Refuses a host resolving to a private / loopback / link-local (metadata) address; returns the first checked address
 * (every request of the probe connects to it — no second resolution).
 */
async function assertPublicHost(
  url: string,
  lookup: (host: string) => Promise<readonly string[]>,
): Promise<string> {
  const host = new URL(url).hostname;
  let addresses: readonly string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new McpProbeError('dns_failed', `cannot resolve ${host}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isForbiddenAddress(a))) {
    throw new McpProbeError('forbidden_address', `${host} resolves to a private or local address; refused`);
  }
  return addresses[0] as string;
}

/** initialize → initialized → tools/list (cursor pages) over an open session: the report (untrusted text, bounded). */
async function discover(
  session: Session,
  transport: McpProbeReport['transport'],
  now: () => number,
  started: number,
): Promise<McpProbeReport> {
  const init = rpcResult(
    await session.request(1, 'initialize', {
      protocolVersion: MCP_CLIENT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'remyral-worker', version: WORKER_VERSION },
    }),
    'initialize',
  );
  const protocolVersion =
    typeof init.protocolVersion === 'string' ? init.protocolVersion.slice(0, 32) : undefined;
  if (protocolVersion !== undefined) session.protocolVersion(protocolVersion);
  const info = init.serverInfo as { name?: unknown; version?: unknown } | undefined;
  await session.notify('notifications/initialized');
  const tools: McpProbeTool[] = [];
  const seen = new Set<string>();
  let more = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const r = rpcResult(
      await session.request(2 + page, 'tools/list', cursor === undefined ? {} : { cursor }),
      'tools/list',
    );
    const list = Array.isArray(r.tools) ? (r.tools as unknown[]) : [];
    for (const raw of list) {
      const t = toTool(raw);
      if (t === null || seen.has(t.name)) continue;
      seen.add(t.name);
      if (tools.length < MAX_MCP_PROBE_TOOLS) tools.push(t);
      else more += 1;
    }
    cursor = typeof r.nextCursor === 'string' && r.nextCursor !== '' ? r.nextCursor : undefined;
    if (cursor === undefined) break;
  }
  return {
    tools,
    ...(more > 0 ? { moreTools: more } : {}),
    ...(info !== undefined && typeof info.name === 'string'
      ? {
          serverInfo: {
            name: cutUtf8(info.name, 128).slice(0, 128),
            ...(typeof info.version === 'string' ? { version: cutUtf8(info.version, 64).slice(0, 64) } : {}),
          },
        }
      : {}),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    transport,
    durationMs: Math.max(0, Math.round(now() - started)),
  };
}

/**
 * Runs initialize + tools/list against the spec's URL. `secrets` = slot → value (from this worker's vault). Throws
 * {@link McpProbeError} with a stable `reason`.
 */
export async function probeMcpServer(
  spec: McpSpec,
  secrets: Readonly<Record<string, string>>,
  deps: McpProbeDeps = {},
): Promise<McpProbeReport> {
  const remote = mcpRemoteOf(spec);
  if (remote === undefined || spec.transport === 'stdio') {
    throw new McpProbeError('mcp_stdio_unsupported', 'stdio servers are probed after install (P4)');
  }
  const url = remote.url;
  if (!url.startsWith('https://')) throw new McpProbeError('invalid_url', 'only https');
  const now = deps.clock ?? Date.now;
  const started = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    ctl.abort();
  }, deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS);
  const onAbort = () => {
    ctl.abort();
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  const headers = probeHeaders(spec, secrets);
  let session: Session | null = null;
  try {
    const address = await assertPublicHost(url, deps.lookup ?? defaultLookup);
    // DNS rebinding: the checked address, not a fresh resolution per request.
    const host = new URL(url).hostname;
    const fetch: McpFetch = deps.fetch ?? (deps.pinnedFetch ?? pinnedFetch)(host, address);
    session =
      spec.transport === 'sse'
        ? await legacySse(url, headers, fetch, ctl.signal)
        : streamable(url, headers, fetch, ctl.signal);
    return await discover(session, spec.transport === 'sse' ? 'sse' : 'streamable-http', now, started);
  } catch (err) {
    if (err instanceof McpProbeError) throw err;
    if (ctl.signal.aborted) throw new McpProbeError('timeout', 'the MCP server did not answer in time');
    const msg = err instanceof Error ? err.message : 'error';
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
    // fetch with redirect:'error' rejects with a TypeError ("unexpected redirect") on a 3xx.
    if (/redirect/i.test(`${msg} ${cause}`)) {
      throw new McpProbeError('redirect_refused', 'the MCP server answered with a redirect; refused');
    }
    throw new McpProbeError('connect_failed', `${msg} ${cause}`.trim().slice(0, 200));
  } finally {
    await session?.close().catch(() => undefined);
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

// ------------------------------------------------------------------------------------------- p14-mcp-stdio

/** The started server of a stdio probe: its pipes and how to stop it (the whole confined tree). */
export interface StdioProbeProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  /** Resolves when the process exited (or immediately when it never started). */
  readonly exited: Promise<unknown>;
  stop(): Promise<void>;
}

/** Longest line (one JSON-RPC message) a stdio server may send. */
const MAX_STDIO_LINE_BYTES = 1024 * 1024;

/**
 * MCP over stdio (newline-delimited JSON-RPC, MCP specification "stdio" transport): requests are written one per line,
 * answers matched by id; requests *from* the server (roots/list, sampling, …) are answered `-32601`, notifications and
 * non-JSON lines (logging on stdout) ignored. ≤ 4 MiB read in total, ≤ 1 MiB per line.
 */
function stdioSession(proc: StdioProbeProcess, signal: AbortSignal): Session {
  const waiting = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  let buf = '';
  let total = 0;
  let failed: Error | null = null;
  const failAll = (e: Error) => {
    if (failed !== null) return;
    failed = e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  const write = (msg: Record<string, unknown>) =>
    new Promise<void>((resolve, reject) => {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`, (err) => {
        if (err === null || err === undefined) resolve();
        else reject(new McpProbeError('connect_failed', 'the MCP server closed its input'));
      });
    });
  const onLine = (line: string) => {
    const text = line.trim();
    if (text === '') return;
    let msg: RpcMessage;
    try {
      const json: unknown = JSON.parse(text);
      if (typeof json !== 'object' || json === null || Array.isArray(json)) return;
      msg = json;
    } catch {
      return; // a server writing logs to stdout: not a message
    }
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) {
        void write({ id: msg.id, error: { code: -32601, message: 'not supported by the probe' } }).catch(
          () => undefined,
        );
      }
      return;
    }
    if (typeof msg.id === 'number') {
      const w = waiting.get(msg.id);
      if (w !== undefined) {
        waiting.delete(msg.id);
        w.resolve(msg);
      }
    }
  };
  proc.stdout.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    total += Buffer.byteLength(text);
    if (total > MAX_MCP_PROBE_RESPONSE_BYTES) {
      failAll(new McpProbeError('response_too_large', 'the MCP server sent more than 4 MiB'));
      return;
    }
    buf += text;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
    if (Buffer.byteLength(buf) > MAX_STDIO_LINE_BYTES) {
      failAll(new McpProbeError('response_too_large', 'the MCP server sent a line above 1 MiB'));
    }
  });
  void proc.exited.then(() => {
    failAll(new McpProbeError('server_exited', 'the MCP server exited before it answered'));
  });
  signal.addEventListener(
    'abort',
    () => {
      failAll(new McpProbeError('timeout', 'the MCP server did not answer in time'));
    },
    { once: true },
  );
  return {
    async request(id, method, params) {
      if (failed !== null) throw failed;
      const answer = new Promise<RpcMessage>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
      });
      await write({ id, method, params });
      return answer;
    },
    async notify(method) {
      if (failed !== null) throw failed;
      await write({ method });
    },
    protocolVersion() {
      // stdio carries no protocol header.
    },
    async close() {
      await proc.stop();
    },
  };
}

/**
 * p14-mcp-stdio: tool discovery of an installed stdio server, on this worker (the master never starts a server).
 * `start` launches it (through the job launcher, inside the worker's host sandbox, with the server's env and only its
 * declared hosts); the session is closed — the confined tree stopped — whatever happens. Throws {@link McpProbeError}.
 */
export async function probeStdioServer(
  start: () => Promise<StdioProbeProcess>,
  deps: Pick<McpProbeDeps, 'timeoutMs' | 'signal' | 'clock'> = {},
): Promise<McpProbeReport> {
  const now = deps.clock ?? Date.now;
  const started = now();
  const ctl = new AbortController();
  const timer = setTimeout(() => {
    ctl.abort();
  }, deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS);
  const onAbort = () => {
    ctl.abort();
  };
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  let session: Session | null = null;
  try {
    let proc: StdioProbeProcess;
    try {
      proc = await start();
    } catch (err) {
      if (err instanceof McpProbeError) throw err;
      throw new McpProbeError(
        'start_failed',
        `the MCP server could not be started: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
      );
    }
    session = stdioSession(proc, ctl.signal);
    return await discover(session, 'stdio', now, started);
  } catch (err) {
    if (err instanceof McpProbeError) throw err;
    if (ctl.signal.aborted) throw new McpProbeError('timeout', 'the MCP server did not answer in time');
    throw new McpProbeError('protocol_error', err instanceof Error ? err.message.slice(0, 200) : 'error');
  } finally {
    await session?.close().catch(() => undefined);
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}
