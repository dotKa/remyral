import { type IncomingMessage, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import {
  FUNCTION_LIMITS,
  FUNCTION_RESPONSE_HEADERS,
  type FunctionProbeResult,
  type FunctionProbeSpec,
} from '@remyral/protocol';
import { portPolicy } from '../previews/ports.js';
import { type FunctionContext, FunctionError, type ProbeExecutor } from './types.js';

/**
 * p15-watches (watch-checks-v1, docs/design/p15-watches.md): a watch's check of a port on THIS machine's own loopback
 * interface — the deterministic `curl localhost:3000`. It connects to 127.0.0.1, then ::1, and nowhere else (no DNS,
 * no redirects, no proxy, no credential). The port must pass the preview port policy (1024–65535, no well-known
 * service port, none of the worker's own ports). HTTP: GET / HEAD, `accept-encoding: identity`, the body cut at
 * `maxResponseBytes`, allow-listed response headers only. An unreachable port is a result (`reachable: false`), not a
 * failure: the watch is simply not met yet.
 */

export interface ProbeExecutorOptions {
  /** Ports the worker itself (or its helpers) listens on: never probed. */
  readonly ownPorts?: () => readonly number[];
  /** Loopback addresses tried in order (tests may narrow it). */
  readonly hosts?: readonly string[];
}

const LOOPBACK: readonly string[] = ['127.0.0.1', '::1'];

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ECONNREFUSED') return 'connection_refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (code === 'ETIMEDOUT' || code === 'timeout') return 'timeout';
  if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'ENETUNREACH') return 'no_loopback';
  return 'protocol_error';
}

export class NodeProbeExecutor implements ProbeExecutor {
  constructor(private readonly opts: ProbeExecutorOptions = {}) {}

  async run(spec: FunctionProbeSpec, ctx: FunctionContext): Promise<FunctionProbeResult> {
    const port = spec.probe.port;
    const verdict = portPolicy(port, this.opts.ownPorts?.() ?? []);
    if (!verdict.ok) throw new FunctionError('function_refused', verdict.detail);
    const started = Date.now();
    const hosts = this.opts.hosts ?? LOOPBACK;
    let last = 'connection_refused';
    for (const host of hosts) {
      if (ctx.signal.aborted) throw new FunctionError('function_refused', 'the check was cancelled');
      try {
        if (spec.probe.kind === 'tcp') {
          await this.#tcp(host, port, spec.probe.timeoutSec * 1000, ctx.signal);
          return {
            type: 'probe',
            kind: 'tcp',
            reachable: true,
            bodyEncoding: 'none',
            truncated: false,
            durationMs: Date.now() - started,
          };
        }
        const r = await this.#http(host, spec.probe, ctx.signal);
        return { ...r, durationMs: Date.now() - started };
      } catch (err) {
        if (err instanceof FunctionError) throw err;
        last = errorCode(err);
        if (last !== 'connection_refused' && last !== 'no_loopback') break;
      }
    }
    ctx.log.info('watch probe: port not reachable', { port, reason: last });
    return {
      type: 'probe',
      kind: spec.probe.kind,
      reachable: false,
      bodyEncoding: 'none',
      truncated: false,
      error: last,
      durationMs: Date.now() - started,
    };
  }

  #tcp(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = connect({ host, port });
      const done = (err?: unknown): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        s.destroy();
        if (err === undefined) resolve();
        else reject(err instanceof Error ? err : new Error('connection failed'));
      };
      const onAbort = (): void => {
        done(Object.assign(new Error('aborted'), { code: 'timeout' }));
      };
      const timer = setTimeout(() => {
        done(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, timeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });
      s.once('connect', () => {
        done();
      });
      s.once('error', (err) => {
        done(err);
      });
    });
  }

  #http(
    host: string,
    probe: Extract<FunctionProbeSpec['probe'], { kind: 'http' }>,
    signal: AbortSignal,
  ): Promise<Omit<FunctionProbeResult, 'durationMs'>> {
    const max = Math.min(probe.maxResponseBytes, FUNCTION_LIMITS.maxProbeResponseBytes);
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host,
        port: probe.port,
        path: probe.path,
        method: probe.method,
        agent: false,
        headers: { 'user-agent': 'Remyral-Watch/1.0', accept: '*/*', 'accept-encoding': 'identity' },
        timeout: probe.timeoutSec * 1000,
        signal,
      });
      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, probe.timeoutSec * 1000);
      req.once('timeout', () => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' }));
      });
      req.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      req.once('response', (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (truncated) return;
          const room = max - size;
          if (c.length > room) {
            chunks.push(c.subarray(0, Math.max(0, room)));
            size = max;
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const name of FUNCTION_RESPONSE_HEADERS) {
            const v = res.headers[name];
            if (typeof v === 'string') headers[name] = v.slice(0, 4096);
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          let bodyEncoding: FunctionProbeResult['bodyEncoding'] = 'none';
          if (probe.method !== 'HEAD' && text !== '') {
            const json = /\bjson\b/i.test(res.headers['content-type'] ?? '');
            if (json && !truncated) {
              try {
                body = JSON.parse(text) as unknown;
                bodyEncoding = 'json';
              } catch {
                body = text;
                bodyEncoding = 'text';
              }
            } else {
              body = text;
              bodyEncoding = 'text';
            }
          }
          resolve({
            type: 'probe',
            kind: 'http',
            reachable: true,
            status: Math.min(Math.max(res.statusCode ?? 0, 100), 599),
            headers,
            ...(body === undefined ? {} : { body }),
            bodyEncoding,
            truncated,
          });
        };
        res.once('end', finish);
        res.once('close', finish);
        res.once('error', () => {
          finish();
        });
      });
      req.end();
    });
  }
}
