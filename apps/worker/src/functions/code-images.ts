import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CodeImagesReport,
  type CodeLanguage,
  FUNCTION_CODE_BASE_IMAGES,
  type OpsUpdatePayload,
} from '@remyral/protocol';
import { ENGINE_CLIENT_ENV, type EngineExec } from '../sandbox/container/engine.js';

/**
 * p14-code-images (docs/design/p14-followups.md §2): the worker builds its own code node images (remote op
 * `code.images.prepare`) instead of an operator running `node infra/worker/images/build.mjs --only code-js,code-python`
 * on every host.
 *
 * Steps, per language (js, python), all through the configured engine CLI (docker / podman) with the client env
 * allowlist only:
 *  1. `pull <name:tag@sha256:…>` — the base pinned in FUNCTION_CODE_BASE_IMAGES (by digest; a registry cannot swap it);
 *  2. a private temp build context with exactly the Dockerfile + runner embedded in this release
 *     (code-images.generated.ts, generated from infra/worker/images/code-* and checked by `pnpm security:pins`);
 *     the embedded hashes are re-checked before the build and the Dockerfile's single FROM must equal the pin;
 *  3. `build --tag remyral/code-<lang>:<ver> --label …` of that context (no build args, no network during RUN beyond
 *     what the engine does by default; the Dockerfiles install nothing);
 *  4. `image inspect` → the local image id.
 * Nothing about the op is a parameter: images, digests and contexts are fixed by the release.
 */

export interface CodeImageContext {
  readonly base: string;
  readonly dockerfile: string;
  readonly dockerfileSha256: string;
  readonly runnerName: string;
  readonly runner: string;
  readonly runnerSha256: string;
}

export type CodeImageContexts = Readonly<Record<CodeLanguage, CodeImageContext>>;

export type CodeImagesOutcome =
  | { readonly state: 'succeeded'; readonly report: CodeImagesReport; readonly detail: string }
  | { readonly state: 'refused' | 'failed' | 'cancelled'; readonly reason: string; readonly detail: string };

export interface CodeImagesPort {
  prepare(opts: {
    readonly signal: AbortSignal;
    readonly progress: (step: string, done?: number, total?: number) => void;
  }): Promise<CodeImagesOutcome>;
}

export interface CodeImagesOptions {
  readonly engine: string;
  readonly exec: EngineExec;
  readonly contexts: CodeImageContexts;
  readonly images: Readonly<Record<CodeLanguage, string>>;
  /** Called after a successful build (the executor drops its cached readiness; the daemon re-sends CAPABILITIES). */
  readonly ready: () => Promise<boolean>;
  readonly sourceEnv?: NodeJS.ProcessEnv;
  readonly tmpRoot?: string;
  readonly pullTimeoutMs?: number;
  readonly buildTimeoutMs?: number;
}

const LANGS: readonly CodeLanguage[] = ['js', 'python'];
const RUNNER_NAME = /^run\.(mjs|py)$/;
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const tail = (s: string): string => {
  const t = s.trim().split('\n').slice(-3).join(' ').trim();
  return t.length > 240 ? `…${t.slice(-240)}` : t;
};

/** Pure check of one embedded context against the release pins (exported for the unit tests). */
export function checkContext(lang: CodeLanguage, c: CodeImageContext): string | null {
  if (c.base !== FUNCTION_CODE_BASE_IMAGES[lang]) return `the ${lang} base differs from the pinned digest`;
  if (sha256(c.dockerfile) !== c.dockerfileSha256) return `the ${lang} Dockerfile does not match its hash`;
  if (sha256(c.runner) !== c.runnerSha256) return `the ${lang} runner does not match its hash`;
  if (!RUNNER_NAME.test(c.runnerName)) return `the ${lang} runner name is not allowed`;
  const froms = c.dockerfile.split('\n').filter((l) => /^\s*FROM\s/i.test(l));
  if (froms.length !== 1 || froms[0]?.trim().split(/\s+/)[1] !== c.base)
    return `the ${lang} Dockerfile must have one FROM of the pinned digest`;
  return null;
}

export function createCodeImages(opts: CodeImagesOptions): CodeImagesPort {
  const source = opts.sourceEnv ?? process.env;
  const env: Record<string, string> = {};
  for (const name of ENGINE_CLIENT_ENV) {
    const v = source[name];
    if (v !== undefined) env[name] = v;
  }
  const run = (args: readonly string[], timeoutMs: number) =>
    opts.exec(opts.engine, args, { timeoutMs, env: { ...env } });
  let busy = false;

  async function prepare(p: {
    readonly signal: AbortSignal;
    readonly progress: (step: string, done?: number, total?: number) => void;
  }): Promise<CodeImagesOutcome> {
    if (busy)
      return { state: 'refused', reason: 'in_progress', detail: 'code images are being prepared already' };
    for (const lang of LANGS) {
      const problem = checkContext(lang, opts.contexts[lang]);
      if (problem !== null) return { state: 'refused', reason: 'context_invalid', detail: problem };
    }
    busy = true;
    // A function, not the property: the signal may abort during any awaited engine call.
    const aborted = (): boolean => p.signal.aborted;
    try {
      const v = await run(['version', '--format', '{{.Server.Version}}'], 15_000);
      if (v.code !== 0) {
        return {
          state: 'refused',
          reason: 'engine_unavailable',
          detail: `the container engine (${opts.engine}) is not reachable: ${tail(v.stderr) || `exit ${String(v.code)}`}`,
        };
      }
      const built: CodeImagesReport['images'][number][] = [];
      const total = LANGS.length * 2;
      let done = 0;
      for (const lang of LANGS) {
        const c = opts.contexts[lang];
        if (aborted()) return { state: 'cancelled', reason: 'cancelled', detail: 'cancelled' };
        p.progress('pull', done, total);
        const pulled = await run(['pull', c.base], opts.pullTimeoutMs ?? 15 * 60_000);
        if (pulled.code !== 0) {
          return {
            state: 'failed',
            reason: 'pull_failed',
            detail: `pulling ${c.base} failed: ${tail(pulled.stderr) || `exit ${String(pulled.code)}`}`,
          };
        }
        done += 1;
        if (aborted()) return { state: 'cancelled', reason: 'cancelled', detail: 'cancelled' };
        p.progress('build', done, total);
        const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), 'remyral-code-img-'));
        try {
          await writeFile(join(dir, 'Dockerfile'), c.dockerfile, { mode: 0o644 });
          await writeFile(join(dir, c.runnerName), c.runner, { mode: 0o644 });
          const tag = opts.images[lang];
          const b = await run(
            [
              'build',
              '--tag',
              tag,
              '--label',
              `org.remyral.code-base=${c.base}`,
              '--label',
              `org.remyral.code-context=${c.dockerfileSha256.slice(0, 16)}-${c.runnerSha256.slice(0, 16)}`,
              '--file',
              join(dir, 'Dockerfile'),
              dir,
            ],
            opts.buildTimeoutMs ?? 15 * 60_000,
          );
          if (b.code !== 0) {
            return {
              state: 'failed',
              reason: 'build_failed',
              detail: `building ${tag} failed: ${tail(b.stderr) || `exit ${String(b.code)}`}`,
            };
          }
          const inspect = await run(['image', 'inspect', '--format', '{{.Id}}', tag], 15_000);
          const id = inspect.stdout.trim();
          if (inspect.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
            return {
              state: 'failed',
              reason: 'build_failed',
              detail: `${tag} was not found after the build`,
            };
          }
          built.push({ language: lang, tag, base: c.base, id });
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
        done += 1;
      }
      p.progress('verify', done, total);
      const ready = await opts.ready().catch(() => false);
      return {
        state: 'succeeded',
        report: { images: built, ready },
        detail: ready
          ? 'code node images built; the machine now runs code nodes'
          : 'code node images built, but the code executor is not ready (see the container engine)',
      };
    } finally {
      busy = false;
    }
  }

  return { prepare };
}

/** The OPS_UPDATE fields of an outcome (exported for the agent). */
export function codeImagesUpdate(
  out: CodeImagesOutcome,
): Pick<OpsUpdatePayload, 'state' | 'reason' | 'detail' | 'codeImages'> {
  return out.state === 'succeeded'
    ? { state: 'succeeded', detail: out.detail.slice(0, 300), codeImages: out.report }
    : { state: out.state, reason: out.reason, detail: out.detail.slice(0, 300) };
}
