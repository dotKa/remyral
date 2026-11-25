import { FUNCTION_LIMITS, type FunctionCodeSpec } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  type CodeSpawn,
  type CodeSpawnResult,
  codeRunArgs,
  createCodeExecutor,
} from '../src/functions/code.js';
import { type FunctionContext, FunctionError } from '../src/functions/types.js';
import type { EngineExec } from '../src/sandbox/container/engine.js';

const ctx = (signal = new AbortController().signal): FunctionContext => ({
  signal,
  credential: () => Promise.resolve(null),
  addSecret: () => undefined,
  log: { info: () => undefined, warn: () => undefined },
});

const spec = (over: Partial<FunctionCodeSpec> = {}): FunctionCodeSpec => ({
  type: 'code',
  language: 'js',
  source: 'return input * 2',
  input: 21,
  timeoutSec: 5,
  memoryMb: 128,
  ...over,
});

function fakeEngine(opts: { images?: boolean; engine?: boolean } = {}): {
  exec: EngineExec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: EngineExec = (_bin, args) => {
    calls.push([...args]);
    if (args[0] === 'version')
      return Promise.resolve({ code: opts.engine === false ? 1 : 0, stdout: '29.6.2', stderr: '' });
    if (args[0] === 'image')
      return Promise.resolve({ code: opts.images === false ? 1 : 0, stdout: 'sha256:x', stderr: '' });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { exec, calls };
}

function fakeSpawn(result: Partial<CodeSpawnResult> | ((signal: AbortSignal) => Promise<CodeSpawnResult>)): {
  spawn: CodeSpawn;
  runs: { args: string[]; stdin: string; env: Record<string, string> }[];
} {
  const runs: { args: string[]; stdin: string; env: Record<string, string> }[] = [];
  const spawn: CodeSpawn = (_bin, args, o) => {
    runs.push({ args: [...args], stdin: o.stdin.toString('utf8'), env: o.env });
    if (typeof result === 'function') return result(o.signal);
    return Promise.resolve({ code: 0, stdout: '', stdoutTooLarge: false, stderrTail: '', ...result });
  };
  return { spawn, runs };
}

async function failure(p: Promise<unknown>): Promise<FunctionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof FunctionError) return err;
    throw err;
  }
  throw new Error('expected a FunctionError');
}

describe('code node argv (K3 hardening)', () => {
  it('runs network-less, read-only, non-root, bounded, without mounts, env or pulls', () => {
    const args = codeRunArgs({
      name: 'remyral-code-abc',
      image: 'remyral/code-js:0.1.0',
      language: 'js',
      memoryMb: 128,
    });
    const joined = args.join(' ');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(joined).toContain('--network none');
    expect(args).toContain('--read-only');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--user 10001:10001');
    expect(joined).toContain('--pids-limit 64');
    expect(joined).toContain(`--memory ${String(128 * 1024 * 1024)}b`);
    expect(joined).toContain(`--memory-swap ${String(128 * 1024 * 1024)}b`);
    expect(joined).toContain('--cpus 0.5');
    expect(joined).toContain('--pull never');
    expect(joined).toMatch(/--tmpfs \/tmp:rw,nosuid,nodev,size=16777216/);
    expect(args).toContain('--interactive');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('--privileged');
    expect(args.slice(-3)).toEqual(['remyral/code-js:0.1.0', 'node', '/opt/remyral/run.mjs']);
    const py = codeRunArgs({
      name: 'n1',
      image: 'remyral/code-python:0.1.0',
      language: 'python',
      memoryMb: 64,
    });
    expect(py.slice(-4)).toEqual(['remyral/code-python:0.1.0', 'python3', '-I', '/opt/remyral/run.py']);
  });
});

describe('code executor (fake engine)', () => {
  it('passes {source, input} on stdin with only the engine client env and returns the output', async () => {
    const { exec } = fakeEngine();
    const { spawn, runs } = fakeSpawn({ stdout: '{"ok":true,"output":42}\n', stderrTail: 'hi\n' });
    const ex = createCodeExecutor({
      engine: 'docker',
      exec,
      spawn,
      sourceEnv: { PATH: '/bin', SECRET_TOKEN: 'x', DOCKER_HOST: 'unix:///d' },
    });
    const r = await ex.run(spec(), ctx());
    expect(r).toMatchObject({ type: 'code', output: 42, stderr: 'hi\n' });
    expect(JSON.parse(runs[0]?.stdin ?? '')).toEqual({ source: 'return input * 2', input: 21 });
    expect(runs[0]?.env).toEqual({ PATH: '/bin', DOCKER_HOST: 'unix:///d' });
  });

  it('is unavailable without an engine or images', async () => {
    const ex = createCodeExecutor({
      engine: 'docker',
      exec: fakeEngine({ images: false }).exec,
      spawn: fakeSpawn({}).spawn,
    });
    expect(await ex.ready()).toBe(false);
    expect((await failure(ex.run(spec(), ctx()))).code).toBe('code_unavailable');
    const noEngine = createCodeExecutor({ engine: 'docker', exec: fakeEngine({ engine: false }).exec });
    expect(await noEngine.ready()).toBe(false);
  });

  it('caches readiness for a minute', async () => {
    let now = 0;
    const { exec, calls } = fakeEngine();
    const ex = createCodeExecutor({ engine: 'docker', exec, clock: () => now });
    await ex.ready();
    await ex.ready();
    expect(calls.filter((c) => c[0] === 'version')).toHaveLength(1);
    now = 61_000;
    await ex.ready();
    expect(calls.filter((c) => c[0] === 'version')).toHaveLength(2);
  });

  it('maps runner errors, exits and bad output', async () => {
    const run = async (r: Partial<CodeSpawnResult>): Promise<string> =>
      (
        await failure(
          createCodeExecutor({ engine: 'docker', exec: fakeEngine().exec, spawn: fakeSpawn(r).spawn }).run(
            spec(),
            ctx(),
          ),
        )
      ).code;
    expect(await run({ code: 1, stdout: '{"ok":false,"error":"TypeError: boom"}\n' })).toBe('code_failed');
    expect(await run({ code: 137, stdout: '' })).toBe('code_failed');
    expect(await run({ code: 0, stdout: 'not json' })).toBe('code_output_invalid');
    expect(await run({ code: 0, stdout: '{"ok":true,"output":1}\n{"ok":true,"output":2}\n' })).toBe(
      'code_output_invalid',
    );
    expect(await run({ code: 0, stdout: '', stdoutTooLarge: true })).toBe('code_output_invalid');
    expect(await run({ code: 125, stderrTail: 'Unable to find image remyral/code-js:0.1.0 locally' })).toBe(
      'code_unavailable',
    );
  });

  it('clips the error message to 1 KiB', async () => {
    const big = 'x'.repeat(5000);
    const err = await failure(
      createCodeExecutor({
        engine: 'docker',
        exec: fakeEngine().exec,
        spawn: fakeSpawn({ code: 1, stdout: `${JSON.stringify({ ok: false, error: big })}\n` }).spawn,
      }).run(spec(), ctx()),
    );
    expect(err.message.length).toBeLessThanOrEqual(1025);
  });

  it('refuses oversized input before starting a container', async () => {
    const { spawn, runs } = fakeSpawn({});
    const ex = createCodeExecutor({ engine: 'docker', exec: fakeEngine().exec, spawn });
    const err = await failure(
      ex.run(
        spec({
          input: 'x'.repeat(FUNCTION_LIMITS.maxCodeInputBytes + FUNCTION_LIMITS.maxSourceBytes + 1000),
        }),
        ctx(),
      ),
    );
    expect(err.code).toBe('function_refused');
    expect(runs).toHaveLength(0);
  });

  it('kills the container by name on timeout (code_timeout)', async () => {
    const { exec, calls } = fakeEngine();
    const spawn: CodeSpawn = (_b, _a, o) =>
      new Promise((resolve) => {
        o.signal.addEventListener('abort', () => {
          resolve({ code: null, stdout: '', stdoutTooLarge: false, stderrTail: '' });
        });
      });
    const ex = createCodeExecutor({ engine: 'docker', exec, spawn });
    const t0 = Date.now();
    const err = await failure(ex.run(spec({ timeoutSec: 1 }), ctx()));
    expect(err.code).toBe('code_timeout');
    expect(Date.now() - t0).toBeLessThan(6_000);
    const rm = calls.find((c) => c[0] === 'rm');
    expect(rm?.slice(0, 2)).toEqual(['rm', '--force']);
    expect(rm?.[2]).toMatch(/^remyral-code-[0-9a-f]{16}$/);
  });

  it('kills the container on abort', async () => {
    const { exec, calls } = fakeEngine();
    const ac = new AbortController();
    const spawn: CodeSpawn = (_b, _a, o) =>
      new Promise((resolve) => {
        o.signal.addEventListener('abort', () => {
          resolve({ code: null, stdout: '', stdoutTooLarge: false, stderrTail: '' });
        });
        setTimeout(() => {
          ac.abort();
        }, 20);
      });
    const err = await failure(
      createCodeExecutor({ engine: 'docker', exec, spawn }).run(spec(), ctx(ac.signal)),
    );
    expect(err.code).toBe('code_failed');
    expect(err.message).toMatch(/cancelled/);
    expect(calls.some((c) => c[0] === 'rm')).toBe(true);
  });
});

const docker = process.env.REMYRAL_TEST_DOCKER === '1';

/** Real container runs (needs Docker and `node infra/worker/images/build.mjs --only code-js,code-python`). */
describe.skipIf(!docker)('code executor (real docker, REMYRAL_TEST_DOCKER=1)', () => {
  const ex = createCodeExecutor({ engine: 'docker' });
  const js = (source: string, input: unknown = null, over: Partial<FunctionCodeSpec> = {}) =>
    ex.run(spec({ language: 'js', source, input, ...over }), ctx());
  const py = (source: string, input: unknown = null, over: Partial<FunctionCodeSpec> = {}) =>
    ex.run(spec({ language: 'python', source, input, ...over }), ctx());

  it('is ready', async () => {
    expect(await ex.ready()).toBe(true);
  });

  it('JavaScript: returns input * 2, async works, console goes to stderr', async () => {
    expect((await js('console.log("hello"); return input * 2', 21)).output).toBe(42);
    const r = await js(
      'await new Promise((r) => setTimeout(r, 50)); return { sum: input.reduce((a, b) => a + b, 0) }',
      [1, 2, 3],
    );
    expect(r.output).toEqual({ sum: 6 });
    expect((await js('console.log("to stderr"); return 1')).stderr).toContain('to stderr');
  }, 60_000);

  it('Python: returns the sum, print goes to stderr', async () => {
    const r = await py('print("hello")\nreturn sum(input)', [1, 2, 3]);
    expect(r.output).toBe(6);
    expect(r.stderr).toContain('hello');
  }, 60_000);

  it('has no network', async () => {
    const r = await js(
      'try { await fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) }); return "reached" } catch (e) { return "refused" }',
    );
    expect(r.output).toBe('refused');
    const p = await py(
      'import socket\ntry:\n    socket.create_connection(("1.1.1.1", 80), timeout=3)\n    return "reached"\nexcept OSError:\n    return "refused"',
    );
    expect(p.output).toBe('refused');
  }, 60_000);

  it('read-only root, writable /tmp', async () => {
    const r = await js(
      'const fs = await import("node:fs"); let root = "written"; try { fs.writeFileSync("/x", "1") } catch { root = "refused" } fs.writeFileSync("/tmp/x", "1"); return { root, tmp: fs.readFileSync("/tmp/x", "utf8") }',
    );
    expect(r.output).toEqual({ root: 'refused', tmp: '1' });
  }, 60_000);

  it('a thrown error is code_failed', async () => {
    const err = await failure(js('throw new Error("boom")'));
    expect(err.code).toBe('code_failed');
    expect(err.message).toContain('boom');
  }, 60_000);

  it('a memory blow-up is code_failed', async () => {
    const err = await failure(
      js('const a = []; for (;;) a.push(new Array(1e6).fill(Math.random()));', null, {
        memoryMb: 64,
        timeoutSec: 30,
      }),
    );
    expect(err.code).toBe('code_failed');
  }, 60_000);

  it('an infinite loop is code_timeout', async () => {
    const err = await failure(js('for (;;) {}', null, { timeoutSec: 2 }));
    expect(err.code).toBe('code_timeout');
  }, 60_000);

  it('a huge output is code_output_invalid', async () => {
    const err = await failure(js('return "x".repeat(1024 * 1024)'));
    expect(err.code).toBe('code_output_invalid');
  }, 60_000);
});
