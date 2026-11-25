import type { ProbeResult } from '@remyral/agent-adapters';
import type {
  OpsOperation,
  RuntimeKind,
  RuntimeVerifyCheck,
  RuntimeVerifyCheckId,
  RuntimeVerifyReport,
} from '@remyral/protocol';
import { InstallError } from './fetch.js';
import type { Launch, Progress } from './installers.js';
import { InstallRefusal, type RuntimeInstaller } from './installer.js';
import { lockSha256, packLockfile } from '../mcp/lockfile.js';

/**
 * p16-runtime-updates §3 (docs/design/p16-runtime-updates.md): the automatable part of the compat checklist for a
 * runtime version that is not the release pin, run on a canary machine by `runtime.verify`. The candidate is installed
 * into a scratch dir (never activated, never visible to jobs) with every check of an unverified install, then:
 *
 *  - `integrity`     the lock's root is the registry integrity the master signed; every tarball matched its sha512
 *  - `version`       the runtime's own `--version` prints the version
 *  - `bundled_version` Claude Code: the agent SDK's `claudeCodeVersion` is the CLI version
 *  - `help`          `--help` exits 0 with output (Claude Code, Codex, Pi)
 *  - `server_auth`   OpenCode: loopback server with a random password — 401 without, 200 with it, version from health
 *  - `adapter_probe` the adapter's own `probe()` on the scratch executable (no session, no model request)
 *
 * and reports honestly what it cannot do here: `headless_prompt` (needs a model credential and spends tokens) and
 * `contract_suite` (the scripted-provider contract kit runs in the repository's test suites) are `skipped`. A passing
 * report means "the automatable checks passed on this machine", never "supported" (ADR-0008).
 */

export interface RuntimeVerifierDeps {
  readonly installer: Pick<RuntimeInstaller, 'stageCandidate'>;
  /** `--help` / the OpenCode loopback auth self-test on an executable (runtimes/selftest.ts). */
  readonly selfTest: (
    runtime: RuntimeKind,
    launch: Launch,
    /** The candidate's version (the OpenCode server reports it, not the pin). */
    expectedVersion: string,
  ) => Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** The adapter's `probe()` on an executable that is not the active one (RuntimeRegistry.probeExecutable). */
  readonly probe: (runtime: RuntimeKind, launch: Launch) => Promise<ProbeResult | null>;
}

type VerifyOp = Extract<OpsOperation, { kind: 'runtime.verify' }>;

function check(
  id: RuntimeVerifyCheckId,
  status: RuntimeVerifyCheck['status'],
  required: boolean,
  detail?: string,
): RuntimeVerifyCheck {
  return { id, status, required, ...(detail === undefined ? {} : { detail: detail.slice(0, 300) }) };
}

const NOT_AUTOMATED: readonly RuntimeVerifyCheck[] = [
  check(
    'headless_prompt',
    'skipped',
    false,
    'not automated: a prompt needs a model credential and spends tokens (live suites stay manual, docs/compat)',
  ),
  check(
    'contract_suite',
    'skipped',
    false,
    'not run on a worker: the adapter contract kit with scripted providers runs in the repository test suites',
  ),
];

export class RuntimeVerifyRefusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeVerifyRefusal';
  }
}

/** Runs the checks; a refusal before anything was installed throws {@link RuntimeVerifyRefusal}. */
export async function verifyRuntime(
  d: RuntimeVerifierDeps,
  op: VerifyOp,
  opts: { readonly signal?: AbortSignal; readonly progress: Progress },
): Promise<RuntimeVerifyReport> {
  const checks: RuntimeVerifyCheck[] = [];
  const done = (lock?: Buffer, produced = false): RuntimeVerifyReport => {
    const all = [...checks, ...NOT_AUTOMATED];
    return {
      runtime: op.runtime,
      version: op.version,
      passed: all.every((c) => !c.required || c.status === 'passed'),
      checks: all,
      ...(lock === undefined ? {} : { lockSha256: lockSha256(lock) }),
      ...(lock !== undefined && produced ? { lock: packLockfile('npm', lock) } : {}),
    };
  };
  let staged: Awaited<ReturnType<RuntimeInstaller['stageCandidate']>>;
  try {
    staged = await d.installer.stageCandidate(op.runtime, op.version, op.source, {
      progress: opts.progress,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof InstallRefusal) throw new RuntimeVerifyRefusal(err.reason, err.message);
    if (err instanceof InstallError) {
      if (err.reason === 'cancelled') throw err;
      // The install itself is the first check: integrity / lock problems and the version check fail it.
      const versionCheck = err.reason === 'version_mismatch';
      checks.push(
        check(
          'integrity',
          versionCheck ? 'passed' : 'failed',
          true,
          versionCheck ? 'every package matched its sha512' : `${err.reason}: ${err.message}`,
        ),
      );
      if (versionCheck) checks.push(check('version', 'failed', true, err.message));
      return done();
    }
    throw err;
  }
  try {
    checks.push(
      check(
        'integrity',
        'passed',
        true,
        `lock root ${op.source.package}@${op.source.packageVersion} matches the registry integrity; every package matched its sha512`,
      ),
    );
    checks.push(check('version', 'passed', true, `--version printed ${staged.reportedVersion ?? '?'}`));
    if (op.runtime === 'claude-code') {
      checks.push(
        check('bundled_version', 'passed', true, `claudeCodeVersion ${staged.bundledVersion ?? '?'}`),
      );
    }
    opts.progress('selftest');
    const self = await d.selfTest(op.runtime, staged.launch, op.version).catch((err: unknown) => ({
      ok: false,
      detail: err instanceof Error ? err.message : 'self-test failed',
    }));
    checks.push(
      check(
        op.runtime === 'opencode' ? 'server_auth' : 'help',
        self.ok ? 'passed' : 'failed',
        true,
        self.detail,
      ),
    );
    opts.progress('probe');
    const probe = await d.probe(op.runtime, staged.launch).catch((err: unknown) => {
      checks.push(
        check('adapter_probe', 'failed', true, err instanceof Error ? err.message : 'probe failed'),
      );
      return undefined;
    });
    if (probe === null) {
      checks.push(
        check('adapter_probe', 'skipped', false, 'no adapter for this runtime in this worker build'),
      );
    } else if (probe !== undefined) {
      const offered = Object.entries(probe.capabilities.capabilities)
        .filter(([, e]) => e.status !== 'unsupported')
        .map(([k]) => k);
      // Claude Code's probe reads `<cli>+sdk.<sdk>` (the SDK that bundles it): compare the CLI part.
      const read = probe.version?.split('+')[0] ?? null;
      const ok = probe.installed && read === op.version;
      checks.push(
        check(
          'adapter_probe',
          ok ? 'passed' : 'failed',
          true,
          ok
            ? `probe read ${op.version}; not unsupported: ${offered.join(', ') || 'none'} (all unverified until it is the pin)`
            : `probe read ${probe.installed ? (probe.version ?? 'no version') : 'not installed'}, expected ${op.version}`,
        ),
      );
    }
    return done(staged.lock, staged.produced);
  } finally {
    await staged.cleanup();
  }
}
