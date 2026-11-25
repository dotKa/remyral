import type { RuntimeKind } from '@remyral/protocol';
import { extractVersion } from '../probe/version.js';
import type { Problem, SelfTestResult } from '../probe/report.js';
import { buildChildEnv } from '../system/process.js';
import type { ServerProcess, System } from '../system/types.js';
import type { Launch } from './detect.js';
import { RUNTIME_PINS } from './pins.js';

type Check = SelfTestResult['checks'][number];

const HTTP_TIMEOUT_MS = 5_000;
const POLL_MS = 250;
const CLI_HELP_TIMEOUT_MS = 20_000;

/**
 * A loopback HTTP server self-test (ADR-0012 rule 2): start with a random per-run
 * secret on 127.0.0.1:<free port>, require 401 without credentials and 200 with them.
 * Flags and routes come from docs/compat/opencode.md §2.
 */
export interface ServerSpec {
  runtime: RuntimeKind;
  args(port: number): string[];
  /** Secret-bearing env for the child. The secret is never put in argv or the report. */
  env(secret: string): Record<string, string>;
  authHeaders(secret: string): Record<string, string>;
  /** Route that must be 401 without and 200 with credentials. */
  protectedPath: string;
  /** Route queried with credentials to read the server-reported version (JSON `version`). */
  versionPath: string;
  startTimeoutMs: number;
}

export const OPENCODE_SPEC: ServerSpec = {
  runtime: 'opencode',
  // `opencode serve --help` (1.19.0): --hostname default 127.0.0.1, --port default 0, --pure.
  args: (port) => ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--pure'],
  env: (secret) => ({
    OPENCODE_SERVER_PASSWORD: secret,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  }),
  // HTTP Basic, default username `opencode` (compat/opencode.md §2).
  authHeaders: (secret) => ({
    authorization: `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`,
  }),
  // `/global/health` is behind auth when a password is set; returns {"healthy":true,"version":…}.
  protectedPath: '/global/health',
  versionPath: '/global/health',
  startTimeoutMs: 45_000,
};

function wrongSecret(secret: string): string {
  return secret.length > 0 ? `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}` : 'x';
}

function readJsonVersion(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && 'version' in parsed && typeof parsed.version === 'string') {
      return extractVersion(parsed.version);
    }
  } catch {
    /* not JSON */
  }
  return null;
}

async function waitUntilListening(
  sys: System,
  server: ServerProcess,
  base: string,
  deadline: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  while (sys.monotonicMs() < deadline) {
    const exit = server.exitCode();
    if (exit !== undefined)
      return { ok: false, reason: `server exited before listening (exit ${String(exit)})` };
    try {
      // Any HTTP answer (even 401) means the listener is up.
      await sys.httpGetLoopback(`${base}/`, {}, 1_000);
      return { ok: true };
    } catch {
      await sys.sleep(POLL_MS);
    }
  }
  return { ok: false, reason: 'server did not start listening before the timeout' };
}

export async function serverAuthSelfTest(
  sys: System,
  spec: ServerSpec,
  launch: Launch,
  /** p16-runtime-updates: a verification candidate reports its own version, not the pin. */
  expectedVersion?: string,
): Promise<{ result: SelfTestResult; problems: Problem[] }> {
  const started = sys.monotonicMs();
  const checks: Check[] = [];
  const problems: Problem[] = [];
  let failOpen = false;
  let dir: string | null = null;
  let server: ServerProcess | null = null;
  try {
    dir = await sys.makeTempDir('remyral-probe-');
    const port = await sys.freeLoopbackPort();
    const secret = sys.randomSecret();
    const env = buildChildEnv(
      (n) => sys.getEnv(n),
      dir,
      sys.platform === 'win32' ? '\\' : '/',
      spec.env(secret),
    );
    server = sys.spawnServer(launch.file, [...launch.prefixArgs, ...spec.args(port)], { env, cwd: dir });
    const base = `http://127.0.0.1:${String(port)}`;

    const up = await waitUntilListening(sys, server, base, started + spec.startTimeoutMs);
    checks.push({ name: 'listening on 127.0.0.1', ok: up.ok, ...(up.ok ? {} : { detail: up.reason }) });
    if (up.ok) {
      const anon = await sys.httpGetLoopback(`${base}${spec.protectedPath}`, {}, HTTP_TIMEOUT_MS);
      failOpen = anon.status >= 200 && anon.status < 300;
      checks.push({
        name: `unauthenticated GET ${spec.protectedPath} is refused (401)`,
        ok: anon.status === 401,
        detail: failOpen ? `got ${String(anon.status)}: server is FAIL-OPEN` : `got ${String(anon.status)}`,
      });

      const wrong = await sys.httpGetLoopback(
        `${base}${spec.protectedPath}`,
        spec.authHeaders(wrongSecret(secret)),
        HTTP_TIMEOUT_MS,
      );
      checks.push({
        name: `wrong secret on ${spec.protectedPath} is refused (401)`,
        ok: wrong.status === 401,
        detail: `got ${String(wrong.status)}`,
      });

      const authed = await sys.httpGetLoopback(
        `${base}${spec.protectedPath}`,
        spec.authHeaders(secret),
        HTTP_TIMEOUT_MS,
      );
      checks.push({
        name: `authenticated GET ${spec.protectedPath} succeeds (200)`,
        ok: authed.status === 200,
        detail: `got ${String(authed.status)}`,
      });

      const info = await sys.httpGetLoopback(
        `${base}${spec.versionPath}`,
        spec.authHeaders(secret),
        HTTP_TIMEOUT_MS,
      );
      const reported = info.status === 200 ? readJsonVersion(info.body) : null;
      const pin = expectedVersion ?? RUNTIME_PINS[spec.runtime].version;
      checks.push({
        name:
          expectedVersion === undefined
            ? `server-reported version equals pin ${pin}`
            : `server-reported version equals ${pin}`,
        ok: reported === pin,
        detail: reported ? `server reports ${reported}` : `no version (HTTP ${String(info.status)})`,
      });
    }
  } catch (error) {
    checks.push({
      name: 'self-test ran to completion',
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
    });
  } finally {
    if (server) {
      await server.stop();
      checks.push({
        name: 'server process stopped',
        ok: server.exitCode() !== undefined,
        detail: 'process group killed (POSIX) / taskkill /T /F (Windows)',
      });
    }
    if (dir) await sys.removeDir(dir).catch(() => undefined);
  }

  const passed = checks.every((c) => c.ok);
  if (failOpen) {
    problems.push({
      code: 'selftest.fail_open',
      severity: 'error',
      message: `${spec.runtime} server answered an unauthenticated request with success although a secret was set; never use it on this node until fixed (ADR-0012 rule 2).`,
    });
  } else if (!passed) {
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    problems.push({
      code: 'selftest.failed',
      severity: 'error',
      message: `${spec.runtime} self-test failed: ${failed.join('; ')}`.slice(0, 512),
    });
  }
  return {
    result: {
      kind: 'server-auth',
      status: passed ? 'passed' : 'failed',
      durationMs: Math.max(0, Math.round(sys.monotonicMs() - started)),
      checks,
    },
    problems,
  };
}

/** Claude Code / Codex / Pi talk over stdio or in-process: only `--help` is checked. */
export async function cliHelpSelfTest(
  sys: System,
  runtime: RuntimeKind,
  launch: Launch,
): Promise<{ result: SelfTestResult; problems: Problem[] }> {
  const started = sys.monotonicMs();
  const checks: Check[] = [];
  let dir: string | null = null;
  try {
    dir = await sys.makeTempDir('remyral-probe-');
    const env = buildChildEnv((n) => sys.getEnv(n), dir, sys.platform === 'win32' ? '\\' : '/', {});
    const r = await sys.exec(launch.file, [...launch.prefixArgs, '--help'], {
      timeoutMs: CLI_HELP_TIMEOUT_MS,
      env,
      cwd: dir,
    });
    const output = `${r.stdout}${r.stderr}`.trim();
    checks.push({
      name: '`--help` exits 0 with output',
      ok: r.exitCode === 0 && output.length > 0,
      detail: r.timedOut
        ? 'timed out'
        : r.spawnError
          ? `could not start (${r.spawnError})`
          : `exit ${String(r.exitCode)}, ${String(output.length)} chars`,
    });
  } finally {
    if (dir) await sys.removeDir(dir).catch(() => undefined);
  }
  const passed = checks.every((c) => c.ok);
  return {
    result: {
      kind: 'cli-help',
      status: passed ? 'passed' : 'failed',
      durationMs: Math.max(0, Math.round(sys.monotonicMs() - started)),
      checks,
    },
    problems: passed
      ? []
      : [{ code: 'selftest.failed', severity: 'error', message: `${runtime} \`--help\` check failed.` }],
  };
}

export function runSelfTest(
  sys: System,
  runtime: RuntimeKind,
  launch: Launch,
  expectedVersion?: string,
): Promise<{ result: SelfTestResult; problems: Problem[] }> {
  if (runtime === 'opencode') return serverAuthSelfTest(sys, OPENCODE_SPEC, launch, expectedVersion);
  return cliHelpSelfTest(sys, runtime, launch);
}
