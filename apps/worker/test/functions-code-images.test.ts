import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FUNCTION_CODE_BASE_IMAGES, OpsUpdatePayload } from '@remyral/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createCodeExecutor, DEFAULT_CODE_IMAGES, defaultExec } from '../src/functions/code.js';
import { CODE_IMAGE_CONTEXTS } from '../src/functions/code-images.generated.js';
import {
  checkContext,
  type CodeImageContexts,
  codeImagesUpdate,
  createCodeImages,
} from '../src/functions/code-images.js';
import type { EngineExec } from '../src/sandbox/container/engine.js';
import { tempDir } from './helpers.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const ID = (c: string) => `sha256:${c.repeat(64)}`;

interface Call {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly files?: Record<string, string>;
}

/** A fake engine CLI: records every call (and the build context's files at build time). */
function fakeEngine(over: Partial<Record<'version' | 'pull' | 'build' | 'inspect', number>> = {}) {
  const calls: Call[] = [];
  const exec: EngineExec = async (_binary, args, opts) => {
    const a = [...args];
    let files: Record<string, string> | undefined;
    if (a[0] === 'build') {
      const dir = a.at(-1) ?? '';
      files = {};
      for (const f of await readdir(dir)) files[f] = await readFile(join(dir, f), 'utf8');
    }
    calls.push({ args: a, env: opts.env, ...(files === undefined ? {} : { files }) });
    const kind = a[0] === 'image' ? 'inspect' : (a[0] as 'version' | 'pull' | 'build');
    const code = over[kind] ?? 0;
    const stdout = kind === 'inspect' ? (a.at(-1)?.includes('python') ? ID('b') : ID('a')) : '24.0.0';
    return { code, stdout: code === 0 ? stdout : '', stderr: code === 0 ? '' : `${kind} went wrong\n` };
  };
  return { exec, calls };
}

describe('code node images (p14-code-images)', () => {
  it('the embedded contexts are the reviewed infra files, FROM the pinned digests', async () => {
    for (const [lang, dir, runner] of [
      ['js', 'code-js', 'run.mjs'],
      ['python', 'code-python', 'run.py'],
    ] as const) {
      const c = CODE_IMAGE_CONTEXTS[lang];
      expect(c.base).toBe(FUNCTION_CODE_BASE_IMAGES[lang]);
      expect(c.dockerfile).toBe(await readFile(join(repo, 'infra/worker/images', dir, 'Dockerfile'), 'utf8'));
      expect(c.runnerName).toBe(runner);
      expect(c.runner).toBe(await readFile(join(repo, 'infra/worker/images', dir, runner), 'utf8'));
      expect(checkContext(lang, c)).toBeNull();
    }
  });

  it('pulls each base by digest, builds the tagged image from exactly the embedded context, then re-checks readiness', async () => {
    const { exec, calls } = fakeEngine();
    const ready = vi.fn(() => Promise.resolve(true));
    const steps: string[] = [];
    const port = createCodeImages({
      engine: 'docker',
      exec,
      contexts: CODE_IMAGE_CONTEXTS,
      images: DEFAULT_CODE_IMAGES,
      ready,
      sourceEnv: { PATH: '/usr/bin', SECRET_TOKEN: 'x', DOCKER_HOST: 'unix:///run/docker.sock' },
      tmpRoot: await tempDir('code-img-'),
    });
    const out = await port.prepare({ signal: new AbortController().signal, progress: (s) => steps.push(s) });
    expect(out.state).toBe('succeeded');
    expect(calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'version --format',
      `pull ${FUNCTION_CODE_BASE_IMAGES.js}`,
      `build --tag`,
      'image inspect',
      `pull ${FUNCTION_CODE_BASE_IMAGES.python}`,
      `build --tag`,
      'image inspect',
    ]);
    const builds = calls.filter((c) => c.args[0] === 'build');
    expect(builds[0]?.args[2]).toBe('remyral/code-js:0.1.0');
    expect(builds[1]?.args[2]).toBe('remyral/code-python:0.1.0');
    expect(builds[0]?.args).toContain(`org.remyral.code-base=${FUNCTION_CODE_BASE_IMAGES.js}`);
    // No build args, no network flag games: exactly the embedded Dockerfile and runner in a private context.
    expect(builds.every((b) => !b.args.includes('--build-arg'))).toBe(true);
    expect(builds[0]?.files).toEqual({
      Dockerfile: CODE_IMAGE_CONTEXTS.js.dockerfile,
      'run.mjs': CODE_IMAGE_CONTEXTS.js.runner,
    });
    expect(builds[1]?.files).toEqual({
      Dockerfile: CODE_IMAGE_CONTEXTS.python.dockerfile,
      'run.py': CODE_IMAGE_CONTEXTS.python.runner,
    });
    // Only the engine client env allowlist reaches the CLI.
    expect(calls.every((c) => c.env.SECRET_TOKEN === undefined && c.env.PATH === '/usr/bin')).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(steps).toEqual(['pull', 'build', 'pull', 'build', 'verify']);
    if (out.state !== 'succeeded') throw new Error('unreachable');
    expect(out.report).toEqual({
      ready: true,
      images: [
        { language: 'js', tag: 'remyral/code-js:0.1.0', base: FUNCTION_CODE_BASE_IMAGES.js, id: ID('a') },
        {
          language: 'python',
          tag: 'remyral/code-python:0.1.0',
          base: FUNCTION_CODE_BASE_IMAGES.python,
          id: ID('b'),
        },
      ],
    });
    // The update is valid on the wire.
    OpsUpdatePayload.parse({
      commandId: crypto.randomUUID(),
      seq: 1,
      kind: 'code.images.prepare',
      ...codeImagesUpdate(out),
    });
  });

  it('no engine → refused; a failed pull or build → failed with the engine’s last line; nothing is ready-checked', async () => {
    for (const [over, state, reason] of [
      [{ version: 1 }, 'refused', 'engine_unavailable'],
      [{ pull: 1 }, 'failed', 'pull_failed'],
      [{ build: 1 }, 'failed', 'build_failed'],
      [{ inspect: 1 }, 'failed', 'build_failed'],
    ] as const) {
      const { exec } = fakeEngine(over);
      const ready = vi.fn(() => Promise.resolve(true));
      const port = createCodeImages({
        engine: 'podman',
        exec,
        contexts: CODE_IMAGE_CONTEXTS,
        images: DEFAULT_CODE_IMAGES,
        ready,
      });
      const out = await port.prepare({ signal: new AbortController().signal, progress: () => undefined });
      expect(out).toMatchObject({ state, reason });
      expect(ready).not.toHaveBeenCalled();
    }
  });

  it('a tampered or re-pinned context is refused before the engine is touched', async () => {
    const bad: CodeImageContexts[] = [
      { ...CODE_IMAGE_CONTEXTS, js: { ...CODE_IMAGE_CONTEXTS.js, runner: 'process.exit(0)' } },
      {
        ...CODE_IMAGE_CONTEXTS,
        python: { ...CODE_IMAGE_CONTEXTS.python, base: 'python:3.13-slim-bookworm' },
      },
      {
        ...CODE_IMAGE_CONTEXTS,
        js: { ...CODE_IMAGE_CONTEXTS.js, runnerName: '../escape.mjs' },
      },
    ];
    for (const contexts of bad) {
      const { exec, calls } = fakeEngine();
      const port = createCodeImages({
        engine: 'docker',
        exec,
        contexts,
        images: DEFAULT_CODE_IMAGES,
        ready: () => Promise.resolve(true),
      });
      const out = await port.prepare({ signal: new AbortController().signal, progress: () => undefined });
      expect(out).toMatchObject({ state: 'refused', reason: 'context_invalid' });
      expect(calls).toHaveLength(0);
    }
  });

  it('one preparation at a time; an abort between steps cancels', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { exec: inner } = fakeEngine();
    const exec: EngineExec = async (b, a, o) => {
      if (a[0] === 'pull') await gate;
      return inner(b, a, o);
    };
    const port = createCodeImages({
      engine: 'docker',
      exec,
      contexts: CODE_IMAGE_CONTEXTS,
      images: DEFAULT_CODE_IMAGES,
      ready: () => Promise.resolve(true),
    });
    const abort = new AbortController();
    const first = port.prepare({ signal: abort.signal, progress: () => undefined });
    await new Promise((r) => setTimeout(r, 0));
    expect(
      await port.prepare({ signal: new AbortController().signal, progress: () => undefined }),
    ).toMatchObject({
      state: 'refused',
      reason: 'in_progress',
    });
    abort.abort();
    release();
    expect(await first).toMatchObject({ state: 'cancelled' });
  });
});

/** Real engine (REMYRAL_TEST_DOCKER=1): pulls the pinned bases and builds the images, then a code run works. */
describe.skipIf(process.env.REMYRAL_TEST_DOCKER !== '1')('code node images (real docker)', () => {
  it('prepare builds both images from the embedded contexts; the executor is ready and runs code', async () => {
    const ex = createCodeExecutor({ engine: 'docker' });
    const port = createCodeImages({
      engine: 'docker',
      exec: defaultExec,
      contexts: CODE_IMAGE_CONTEXTS,
      images: DEFAULT_CODE_IMAGES,
      ready: () => {
        ex.invalidate?.();
        return ex.ready();
      },
    });
    const out = await port.prepare({ signal: new AbortController().signal, progress: () => undefined });
    expect(out).toMatchObject({ state: 'succeeded', report: { ready: true } });
    const r = await ex.run(
      {
        type: 'code',
        language: 'python',
        source: 'return input * 2',
        input: 21,
        timeoutSec: 10,
        memoryMb: 128,
      },
      {
        signal: new AbortController().signal,
        credential: () => Promise.resolve(null),
        addSecret: () => undefined,
        log: { info: () => undefined, warn: () => undefined },
      },
    );
    expect(r.output).toBe(42);
  }, 600_000);
});
