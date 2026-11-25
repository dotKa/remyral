import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { FUNCTION_LIMITS, type FunctionCodeResult, type FunctionCodeSpec } from '@remyral/protocol';
import { buildRunArgs } from '../sandbox/container/args.js';
import { ENGINE_CLIENT_ENV, type EngineExec, type EngineResult } from '../sandbox/container/engine.js';
import { type CodeExecutor, type FunctionContext, FunctionError } from './types.js';

/**
 * p14-workflow-engine 14.3, K3 (ADR-0055 §3.6): the code node — JavaScript / Python in a network-less container.
 *
 * Each run is one `docker run --rm` of the locally built `remyral/code-js` / `remyral/code-python` image (FROM the digests
 * of FUNCTION_CODE_BASE_IMAGES, `--pull never`): `--network none`, read-only root, all capabilities dropped,
 * no-new-privileges, non-root 10001, 64 pids, the node's memory (no swap), 0.5 CPU, tmpfs /tmp 16 MiB, no mounts, no
 * environment, no secrets. The spec's `{source, input}` goes in as one JSON document on stdin; the image's runner
 * writes exactly one JSON line `{"ok":…}` to stdout (user output goes to stderr). The wall clock (`timeoutSec` plus a
 * fixed container start allowance) and an abort kill the container by name.
 */

export const DEFAULT_CODE_IMAGES = {
  js: 'remyral/code-js:0.1.0',
  python: 'remyral/code-python:0.1.0',
} as const;

/** Container start allowance on top of the node's own `timeoutSec` (cold `docker run`). */
export const CODE_START_ALLOWANCE_MS = 3_000;
const READY_TTL_MS = 60_000;
const CPUS = 0.5;
const PIDS = 64;
const TMP_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL = 4096;
const MESSAGE_MAX = 1024;

export interface CodeSpawnResult {
  /** Exit code (null: killed by a signal). */
  readonly code: number | null;
  readonly stdout: string;
  /** stdout went past `maxStdout` (the rest was discarded). */
  readonly stdoutTooLarge: boolean;
  /** The last ≤ 4 KiB of stderr. */
  readonly stderrTail: string;
}

/** Runs the engine CLI with `stdin` piped in and bounded output capture. */
export type CodeSpawn = (
  binary: string,
  args: readonly string[],
  opts: {
    readonly env: Record<string, string>;
    readonly stdin: Buffer;
    readonly maxStdout: number;
    readonly signal: AbortSignal;
  },
) => Promise<CodeSpawnResult>;

export interface CodeExecutorOptions {
  /** Engine CLI binary (`docker` or `podman`, or a path). */
  readonly engine: string;
  /** For `image inspect`, `version`, `rm --force` (default: execFile with the client env allowlist). */
  readonly exec?: EngineExec;
  /** For the `run` itself (default: spawn with stdin). */
  readonly spawn?: CodeSpawn;
  readonly images?: { readonly js: string; readonly python: string };
  readonly clock?: () => number;
  /** Source of the engine client environment (default process.env; filtered through ENGINE_CLIENT_ENV). */
  readonly sourceEnv?: NodeJS.ProcessEnv;
}

export const defaultExec: EngineExec = (binary, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      env: opts.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 1_000_000) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 100_000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

export const defaultCodeSpawn: CodeSpawn = (binary, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(binary, [...args], {
      env: opts.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let outBytes = 0;
    let tooLarge = false;
    let errTail = Buffer.alloc(0);
    const onAbort = (): void => {
      child.kill('SIGKILL');
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (tooLarge) return;
      if (outBytes + d.length > opts.maxStdout) {
        tooLarge = true;
        return;
      }
      out.push(d);
      outBytes += d.length;
    });
    child.stderr.on('data', (d: Buffer) => {
      errTail = Buffer.concat([errTail, d]);
      if (errTail.length > STDERR_TAIL) errTail = errTail.subarray(errTail.length - STDERR_TAIL);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (err) => {
      opts.signal.removeEventListener('abort', onAbort);
      resolve({ code: 127, stdout: '', stdoutTooLarge: false, stderrTail: err.message });
    });
    child.on('close', (code) => {
      opts.signal.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stdoutTooLarge: tooLarge,
        stderrTail: errTail.toString('utf8'),
      });
    });
    child.stdin.end(opts.stdin);
  });

/** The hardened `docker run` argv of one code run (pure; asserted by the unit tests). */
export function codeRunArgs(input: {
  readonly name: string;
  readonly image: string;
  readonly language: 'js' | 'python';
  readonly memoryMb: number;
}): string[] {
  const args = buildRunArgs({
    name: input.name,
    image: input.image,
    labels: { 'remyral.kind': 'function-code', 'remyral.language': input.language },
    network: 'none',
    user: '10001:10001',
    limits: {
      memoryBytes: input.memoryMb * 1024 * 1024,
      cpus: CPUS,
      pids: PIDS,
      fileSizeBytes: TMP_BYTES,
      openFiles: 256,
      tmpBytes: TMP_BYTES,
    },
    mounts: [],
    workdir: '/tmp',
    envNames: [],
    stdin: true,
    command: input.language === 'js' ? 'node' : 'python3',
    args: input.language === 'js' ? ['/opt/remyral/run.mjs'] : ['-I', '/opt/remyral/run.py'],
  });
  // A code run leaves nothing behind (buildRunArgs' attempts are removed by the runner; here the engine does it).
  args.splice(1, 0, '--rm');
  return args;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

export function createCodeExecutor(opts: CodeExecutorOptions): CodeExecutor {
  const exec = opts.exec ?? defaultExec;
  const spawnRun = opts.spawn ?? defaultCodeSpawn;
  const images = opts.images ?? DEFAULT_CODE_IMAGES;
  const clock = opts.clock ?? Date.now;
  const source = opts.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of ENGINE_CLIENT_ENV) {
    const v = source[name];
    if (v !== undefined) env[name] = v;
  }
  const run = (args: readonly string[], timeoutMs: number): Promise<EngineResult> =>
    exec(opts.engine, args, { timeoutMs, env: { ...env } });
  let cached: { at: number; ready: boolean } | null = null;

  async function ready(): Promise<boolean> {
    const now = clock();
    if (cached !== null && now - cached.at < READY_TTL_MS) return cached.ready;
    let ok = false;
    try {
      const v = await run(['version', '--format', '{{.Server.Version}}'], 15_000);
      if (v.code === 0) {
        const [a, b] = await Promise.all(
          [images.js, images.python].map((ref) =>
            run(['image', 'inspect', '--format', '{{.Id}}', ref], 15_000),
          ),
        );
        ok = a?.code === 0 && b?.code === 0;
      }
    } catch {
      ok = false;
    }
    cached = { at: clock(), ready: ok };
    return ok;
  }

  async function execute(spec: FunctionCodeSpec, ctx: FunctionContext): Promise<FunctionCodeResult> {
    if (ctx.signal.aborted) throw new FunctionError('code_failed', 'the run was cancelled before it started');
    if (spec.source.length > FUNCTION_LIMITS.maxSourceBytes)
      throw new FunctionError('function_refused', 'the code is larger than the limit');
    let payload: Buffer;
    try {
      payload = Buffer.from(JSON.stringify({ source: spec.source, input: spec.input ?? null }), 'utf8');
    } catch {
      throw new FunctionError('function_refused', 'the input is not JSON-serialisable');
    }
    if (payload.length > FUNCTION_LIMITS.maxCodeInputBytes + FUNCTION_LIMITS.maxSourceBytes + 64)
      throw new FunctionError('function_refused', 'the input is larger than the limit');
    if (!(await ready()))
      throw new FunctionError(
        'code_unavailable',
        'no ready container engine or code image on this worker (prepare them on the machine page: Tools → Code node images)',
      );
    const image = spec.language === 'js' ? images.js : images.python;
    const name = `remyral-code-${randomBytes(8).toString('hex')}`;
    const args = codeRunArgs({ name, image, language: spec.language, memoryMb: spec.memoryMb });
    const local = new AbortController();
    const stop = { timedOut: false, cancelled: false };
    const kill = (): void => {
      // The CLI process is killed by `local`; the container itself is removed by name (it may outlive its client).
      local.abort();
      void run(['rm', '--force', name], 30_000).catch(() => undefined);
    };
    const timer = setTimeout(
      () => {
        stop.timedOut = true;
        kill();
      },
      spec.timeoutSec * 1000 + CODE_START_ALLOWANCE_MS,
    );
    const onAbort = (): void => {
      stop.cancelled = true;
      kill();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const started = clock();
    let res: CodeSpawnResult;
    try {
      res = await spawnRun(opts.engine, args, {
        env: { ...env },
        stdin: payload,
        maxStdout: FUNCTION_LIMITS.maxCodeOutputBytes + 64,
        signal: local.signal,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
    const durationMs = Math.max(0, Math.round(clock() - started));
    const stderr = res.stderrTail.slice(-STDERR_TAIL);
    if (stop.cancelled) throw new FunctionError('code_failed', 'the run was cancelled');
    if (stop.timedOut)
      throw new FunctionError('code_timeout', `the code did not finish within ${String(spec.timeoutSec)} s`);
    if (res.stdoutTooLarge)
      throw new FunctionError(
        'code_output_invalid',
        `the output is larger than ${String(FUNCTION_LIMITS.maxCodeOutputBytes)} bytes`,
      );
    if (
      res.code !== 0 &&
      /No such image|Unable to find image|image not known|pull access denied/i.test(res.stderrTail)
    ) {
      cached = null;
      throw new FunctionError('code_unavailable', `the code image ${image} is not on this worker`);
    }
    const doc = parseOne(res.stdout);
    if (doc !== null && doc.ok === false) {
      throw new FunctionError(
        'code_failed',
        clip(typeof doc.error === 'string' ? doc.error : 'the code failed', MESSAGE_MAX),
      );
    }
    if (res.code !== 0) {
      throw new FunctionError(
        'code_failed',
        res.code === 137 || res.code === null
          ? 'the code was killed (memory limit or signal)'
          : clip(`the code exited with ${String(res.code)}: ${stderr.trim()}`, MESSAGE_MAX),
      );
    }
    if (doc === null || doc.ok !== true || !('output' in doc))
      throw new FunctionError('code_output_invalid', 'the code runner did not return one JSON result');
    const json = JSON.stringify(doc.output);
    if (Buffer.byteLength(json, 'utf8') > FUNCTION_LIMITS.maxCodeOutputBytes)
      throw new FunctionError(
        'code_output_invalid',
        `the output is larger than ${String(FUNCTION_LIMITS.maxCodeOutputBytes)} bytes`,
      );
    return {
      type: 'code',
      output: doc.output ?? null,
      ...(stderr === '' ? {} : { stderr }),
      durationMs,
    };
  }

  return {
    ready,
    invalidate: () => {
      cached = null;
    },
    run: execute,
  };
}

/** Exactly one JSON object on stdout (trailing newline allowed), else null. */
function parseOne(stdout: string): { ok?: unknown; output?: unknown; error?: unknown } | null {
  const text = stdout.trim();
  if (text === '' || text.includes('\n')) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is { ok?: unknown; output?: unknown; error?: unknown } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
