import { execFile } from 'node:child_process';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  adapterRevision,
  declaredStatuses,
  runCapabilityVerification,
  type SpawnContext,
  type VerificationSession,
} from '@remyral/agent-adapters';
import type { Logger } from '@remyral/observability';
import {
  AttemptId,
  CapabilityEvidence,
  capabilityEvidenceStatement,
  type CapabilityCheckResult,
  JobId,
  type OpsOperation,
  type RuntimeKind,
  type SandboxProfile,
  type SignedCapabilityEvidence,
} from '@remyral/protocol';
import type { SandboxPort } from '../jobs/runner.js';
import { networkPolicy } from '../jobs/workspace-job.js';
import type { SandboxReadiness } from '../probe/capabilities.js';
import type { RuntimeRegistry } from '../runtimes/registry.js';
import type { RuntimeAuthMap } from '../secrets/auth.js';
import { planJobEnv, resolveJobEnv, type ResolvedJobEnv } from '../secrets/env.js';
import { JobEnvError, SecretError } from '../secrets/errors.js';
import type { JobSecretLease } from '../secrets/registry.js';
import type { SecretStore } from '../secrets/store.js';
import { ensureDirInside } from '../workspace/paths.js';

/**
 * p17-runtime-verify (docs/design/p17-runtime-verify.md §3): the worker side of "Doğrula". Runs the capability
 * scenario set of `@remyral/agent-adapters` through the **real** adapter of the active runtime version:
 *
 *  - auth: the machine's configured `runtimeAuth` for the runtime — its subscription login (`local-login`) or the
 *    bound secret reference (`secret-ref`, resolved from this worker's store and registered for redaction like a job's);
 *    no other secret path exists;
 *  - workspace: a throw-away git repository under `<workspaceRoot>/sandboxes/verify-<op>/attempt-1/repo`, removed
 *    afterwards;
 *  - confinement: the job sandbox runner of the first ready host profile (`host-restricted`, else `runtime-sandbox`),
 *    model egress only (the job egress allowlist), the job resource limits;
 *  - bounds: the op's time and token budget; one verification at a time on this worker;
 *  - evidence: per capability passed / failed / skipped with a reason (redacted), the tuple (runtime version, adapter
 *    revision, OS / arch), worker version, auth mode, profile, time, tokens — signed by the device key, bound to the
 *    worker id and the master's operation id.
 */

/** Refused before anything ran (OPS_UPDATE `refused` with the reason). */
export class CapabilityVerifyRefusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityVerifyRefusal';
  }
}

export interface CapabilityVerifierDeps {
  readonly registry: Pick<RuntimeRegistry, 'refresh' | 'createForAttempt' | 'fake'>;
  readonly sandbox: SandboxPort | null;
  /** Sandbox readiness of this machine for `runtime` (CAPABILITIES sandboxReadiness). */
  readonly readiness: (runtime: RuntimeKind) => Promise<readonly SandboxReadiness[]>;
  readonly auth: () => RuntimeAuthMap;
  readonly secretStore: SecretStore;
  readonly secretRegistry: { lease(): JobSecretLease };
  readonly workspaceRoot: string;
  readonly workerId: () => string | null;
  readonly workerVersion: string;
  /** The device key's signature (base64url) over `data`. */
  readonly sign: (data: Uint8Array) => string;
  readonly redact: (text: string) => string;
  readonly logger: Logger;
  /** `git init` + one file (tests replace it). */
  readonly initRepo?: (dir: string) => Promise<void>;
  /** Process command lines (safe_cancel); default: the scenario module's ps / CIM listing. */
  readonly processes?: () => Promise<readonly string[] | null>;
  /** Tests: the scenario runner and its options. */
  readonly run?: typeof runCapabilityVerification;
  readonly scenario?: Partial<Parameters<typeof runCapabilityVerification>[0]>;
}

/** Host profiles a verification may run in, in order of preference (containers need image wiring jobs have). */
const PROFILES: readonly SandboxProfile[] = ['host-restricted', 'runtime-sandbox'];

const TIMEOUTS = { startupMs: 120_000, cancelGraceMs: 5_000, cancelMs: 20_000, approvalMs: 60_000 };

async function gitInit(dir: string): Promise<void> {
  await writeFile(join(dir, 'README.md'), '# Remyral runtime verification\n', { mode: 0o600 });
  await new Promise<void>((resolve, reject) => {
    execFile('git', ['init', '-q'], { cwd: dir, timeout: 30_000, windowsHide: true }, (err) => {
      if (err === null) resolve();
      else reject(new Error(`git init failed: ${err.message}`));
    });
  });
}

export class CapabilityVerifier {
  readonly #d: CapabilityVerifierDeps;
  #running = false;

  constructor(deps: CapabilityVerifierDeps) {
    this.#d = deps;
  }

  get running(): boolean {
    return this.#running;
  }

  async run(
    commandId: string,
    op: Extract<OpsOperation, { kind: 'runtime.capabilities.verify' }>,
    opts: {
      readonly signal: AbortSignal;
      readonly progress: (step: string, results: readonly CapabilityCheckResult[]) => void;
    },
  ): Promise<SignedCapabilityEvidence> {
    const d = this.#d;
    const workerId = d.workerId();
    if (workerId === null) throw new CapabilityVerifyRefusal('not_enrolled', 'the worker is not enrolled');
    if (this.#running) {
      throw new CapabilityVerifyRefusal(
        'verification_running',
        'a capability verification is already running on this machine',
      );
    }
    this.#running = true;
    try {
      return await this.#run(commandId, op, opts, workerId);
    } finally {
      this.#running = false;
    }
  }

  async #run(
    commandId: string,
    op: Extract<OpsOperation, { kind: 'runtime.capabilities.verify' }>,
    opts: {
      readonly signal: AbortSignal;
      readonly progress: (step: string, results: readonly CapabilityCheckResult[]) => void;
    },
    workerId: string,
  ): Promise<SignedCapabilityEvidence> {
    const d = this.#d;
    if (d.registry.fake) {
      throw new CapabilityVerifyRefusal(
        'fake_runtime',
        'jobs on this worker run on the development fake adapter; nothing real to verify',
      );
    }
    const runtime = op.runtime;
    const status = await d.registry.refresh(runtime, true);
    if (status.unavailable !== null) {
      throw new CapabilityVerifyRefusal(
        'runtime_unavailable',
        `${status.unavailable.code}: ${status.unavailable.message}`,
      );
    }
    const probe = status.probe;
    if (probe === null || !probe.installed || probe.version === undefined) {
      throw new CapabilityVerifyRefusal(
        'runtime_not_installed',
        `${runtime} is not installed on this machine`,
      );
    }
    if (probe.version !== op.version) {
      throw new CapabilityVerifyRefusal(
        'version_changed',
        `${runtime} ${probe.version} is active here, not ${op.version}; reload the page and verify again`,
      );
    }
    const sandbox = d.sandbox;
    if (sandbox === null) {
      throw new CapabilityVerifyRefusal(
        'sandbox_unavailable',
        'the sandbox runners of this machine are unavailable',
      );
    }
    const ready = await d.readiness(runtime);
    const profile = PROFILES.find((p) =>
      ready.some(
        (r) => r.profile === p && r.ready && (r.runtimes === undefined || r.runtimes.includes(runtime)),
      ),
    );
    if (profile === undefined) {
      throw new CapabilityVerifyRefusal(
        'sandbox_not_ready',
        'no host sandbox profile is ready here (Makine → Sandbox); a verification runs confined like a job',
      );
    }
    let plan: ReturnType<typeof planJobEnv>;
    try {
      plan = planJobEnv({ runtime, auth: d.auth()[runtime] }, workerId);
    } catch (err) {
      if (err instanceof JobEnvError || err instanceof SecretError)
        throw new CapabilityVerifyRefusal('auth_invalid', err.message);
      throw err;
    }

    const lease = d.secretRegistry.lease();
    const jobId = `verify-${commandId.slice(0, 8)}`;
    const attemptId = 'attempt-1';
    let root: string | null = null;
    try {
      let env: ResolvedJobEnv;
      try {
        env = await resolveJobEnv(plan, { store: d.secretStore, lease });
      } catch (err) {
        if (err instanceof SecretError)
          throw new CapabilityVerifyRefusal('credential_missing', d.redact(err.message));
        throw err;
      }
      root = await realpath(d.workspaceRoot);
      const sandboxDir = await ensureDirInside(root, ['sandboxes', jobId, attemptId]);
      const repo = await ensureDirInside(root, ['sandboxes', jobId, attemptId, 'repo']);
      await (d.initRepo ?? gitInit)(repo);
      const confiner = sandbox.runners.runner(profile).confiner({
        jobId,
        attemptId,
        runtime,
        authMode: plan.authMode,
        workspacePath: repo,
        sandboxDir,
        // Model egress only: the verification needs nothing else.
        network: networkPolicy({ egress: 'none', allowHosts: [] }, sandbox.egressAllow),
        limits: sandbox.limits,
      });
      const stateDirs = new Map<VerificationSession, string>();
      const stateDir = async (session: VerificationSession): Promise<string> => {
        const known = stateDirs.get(session);
        if (known !== undefined) return known;
        const dir = await ensureDirInside(root ?? '', ['sandboxes', jobId, attemptId, `runtime-${session}`]);
        stateDirs.set(session, dir);
        return dir;
      };
      const budget = op.budget;
      const context = (
        _session: VerificationSession,
        input: { readonly signal: AbortSignal; readonly approvalPolicy: SpawnContext['approvalPolicy'] },
      ): SpawnContext => ({
        jobId: JobId.parse(jobId),
        attemptId: AttemptId.parse(attemptId),
        workspaceRoot: repo,
        job: {
          runtime,
          prompt: 'runtime capability verification',
          limits: { maxDurationSec: budget.maxDurationSec },
        },
        sandboxProfile: profile,
        approvalPolicy: input.approvalPolicy,
        repositoryTrust: 'untrusted',
        repoConfig: 'ignore-repository-config',
        secretEnv: env.secretEnv,
        timeouts: { ...TIMEOUTS, maxDurationMs: budget.maxDurationSec * 1000 },
        // Verifying unverified capabilities is the point; the scenarios themselves decide pass / fail.
        allowUnverified: true,
        signal: input.signal,
        confiner,
      });
      d.logger.info('capability verification started', { commandId, runtime, version: op.version, profile });
      const run = await (d.run ?? runCapabilityVerification)({
        runtime,
        adapter: async (session) =>
          d.registry.createForAttempt(runtime, await stateDir(session), env.publicEnv),
        context,
        workspace: repo,
        budget,
        signal: opts.signal,
        onProgress: (step, results) => {
          opts.progress(
            step,
            results.map((r) => ({ ...r, reason: d.redact(r.reason).slice(0, 300) })),
          );
        },
        ...(d.processes === undefined ? {} : { processes: d.processes }),
        ...d.scenario,
      });
      const evidence = CapabilityEvidence.parse({
        runtime,
        runtimeVersion: probe.version,
        adapterVersion: adapterRevision(runtime),
        os: probe.os,
        arch: probe.arch,
        workerId,
        workerVersion: d.workerVersion.slice(0, 64),
        opId: commandId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        authMode: plan.authMode,
        sandboxProfile: profile,
        budget,
        ...(run.stoppedBy === undefined ? {} : { stoppedBy: run.stoppedBy }),
        usage: run.usage,
        declared: declaredStatuses(runtime),
        results: run.results.map((r) => ({ ...r, reason: d.redact(r.reason).slice(0, 300) })),
      });
      const signature = d.sign(capabilityEvidenceStatement({ workerId, opId: commandId, evidence }));
      d.logger.info('capability verification finished', {
        commandId,
        runtime,
        passed: evidence.results.filter((r) => r.status === 'passed').map((r) => r.capability),
        failed: evidence.results.filter((r) => r.status === 'failed').map((r) => r.capability),
        stoppedBy: evidence.stoppedBy,
      });
      return { evidence, signature };
    } finally {
      lease.release();
      if (root !== null) {
        await rm(join(root, 'sandboxes', jobId), { recursive: true, force: true }).catch((err: unknown) => {
          d.logger.warn('verification scratch not removed', { commandId, err });
        });
      }
    }
  }
}
