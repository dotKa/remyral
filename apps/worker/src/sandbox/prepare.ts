import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '@remyral/observability';
import type {
  OpsCommandPayload,
  OpsUpdatePayload,
  PrepareStep,
  PrepareStepId,
  SandboxStatusReport,
} from '@remyral/protocol';
import type { SandboxRunners } from './factory.js';
import {
  PrepareResult,
  type PrepareRequest,
  prepareRequestPath,
  prepareResultPath,
} from './prepare-shared.js';

/**
 * Worker side of `sandbox.prepare` (p5-sandbox-ops, ADR-0019): fixes what the worker can fix itself, hands the
 * signed command to the privileged helper when asked to, relays the helper's per-step results and reports the
 * resulting sandbox status. Every step is reported (pending → running → done / skipped / failed / needs_owner);
 * `needs_owner` steps say what only the machine owner can do and why.
 *
 * Unprivileged steps (no root, no admin): verify the dedicated user (configured or inferred), write + self-test
 * the Windows job runner, Seatbelt (macOS) / bubblewrap (Linux) checks, container engine and images checks,
 * disk space. Privileged steps run only in the root/SYSTEM helper (update/helper/prepare.ts).
 */

type Emit = (u: Omit<OpsUpdatePayload, 'commandId' | 'seq' | 'kind'>) => void;

export interface SandboxPrepareDeps {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly installDir: string | undefined;
  readonly runners: () => SandboxRunners | null;
  /** The current sandbox status (status.ts). */
  readonly status: () => Promise<SandboxStatusReport>;
  /** CAPABILITIES should be re-sent (readiness may have changed). */
  readonly changed: () => void;
  /**
   * The local config changed (privileged step): restart under the service manager after reporting. Not called
   * when the helper restarts the whole service itself (`serviceRestart`, Windows: new privileges need a new
   * service logon, which a restart of the worker process under the same service process does not give).
   */
  readonly restart: () => void;
  readonly logger: Logger;
  /** How long to wait for the helper (Windows polls once a minute; apt can take minutes). */
  readonly helperTimeoutMs?: number;
  readonly pollMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function unprivilegedSteps(platform: NodeJS.Platform): readonly PrepareStepId[] {
  switch (platform) {
    case 'win32':
      return ['worker_user', 'job_runner', 'disk_space'];
    case 'darwin':
      return ['worker_user', 'seatbelt', 'disk_space'];
    case 'linux':
      return ['worker_user', 'bubblewrap', 'container_engine', 'container_images', 'disk_space'];
    default:
      return ['worker_user', 'disk_space'];
  }
}

export class SandboxPreparer {
  readonly #d: SandboxPrepareDeps;
  #busy = false;

  constructor(d: SandboxPrepareDeps) {
    this.#d = d;
  }

  async run(workerId: string, cmd: OpsCommandPayload, emit: Emit): Promise<void> {
    if (cmd.op.kind !== 'sandbox.prepare') return;
    if (this.#busy) {
      emit({ state: 'refused', reason: 'prepare_in_progress' });
      return;
    }
    this.#busy = true;
    try {
      await this.#run(workerId, cmd, cmd.op.privileged, emit);
    } finally {
      this.#busy = false;
    }
  }

  async #run(workerId: string, cmd: OpsCommandPayload, privileged: boolean, emit: Emit): Promise<void> {
    const runners = this.#d.runners();
    const ids = unprivilegedSteps(this.#d.platform);
    const steps: PrepareStep[] = [
      ...ids.map((id) => ({ id, state: 'pending' as const, privileged: false })),
      ...(privileged ? [{ id: 'helper_request' as const, state: 'pending' as const, privileged: true }] : []),
      // p9-windows-host-isolation: after the helper (which creates / rotates the accounts).
      ...(this.#d.platform === 'win32' && runners?.windowsSlots !== undefined
        ? [{ id: 'job_slots' as const, state: 'pending' as const, privileged: false }]
        : []),
      // p19-linux-host-isolation: after the helper (which may install bubblewrap).
      ...(this.#d.platform === 'linux' && runners?.linuxIsolation !== undefined
        ? [{ id: 'host_isolation' as const, state: 'pending' as const, privileged: false }]
        : []),
      { id: 'recheck', state: 'pending', privileged: false },
    ];
    const set = (id: PrepareStepId, s: Omit<PrepareStep, 'id' | 'privileged'>, priv = false): void => {
      const i = steps.findIndex((x) => x.id === id);
      const step: PrepareStep = {
        id,
        privileged: priv,
        state: s.state,
        ...(s.code === undefined ? {} : { code: s.code }),
        ...(s.detail === undefined ? {} : { detail: s.detail.slice(0, 300) }),
      };
      if (i < 0) steps.splice(Math.max(0, steps.length - 1), 0, step);
      else steps[i] = step;
      emit({ state: 'running', progress: { step: id }, prepare: { steps: [...steps] } });
    };
    emit({ state: 'accepted', prepare: { steps: [...steps] } });
    if (runners === null) {
      emit({
        state: 'failed',
        reason: 'runners_unavailable',
        detail: 'the sandbox runners could not be created (see diagnostics)',
        prepare: { steps, status: await this.#d.status() },
      });
      return;
    }

    for (const id of ids) {
      set(id, { state: 'running' });
      try {
        set(id, await this.#step(id, runners));
      } catch (err) {
        set(id, {
          state: 'failed',
          code: 'step_error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let restartRequired = false;
    let serviceRestart = false;
    if (privileged) {
      set('helper_request', { state: 'running' }, true);
      const r = await this.#privileged(workerId, cmd, (helperSteps) => {
        for (const s of helperSteps) set(s.id, s, true);
      });
      restartRequired = r.restartRequired;
      serviceRestart = r.serviceRestart;
      set('helper_request', r.step, true);
    }

    if (this.#d.platform === 'win32') await runners.refreshJobRunner().catch(() => undefined);
    const slots = runners.windowsSlots;
    if (this.#d.platform === 'win32' && slots !== undefined) {
      set('job_slots', { state: 'running' });
      set('job_slots', await this.#slotStep(slots, restartRequired, serviceRestart));
    }
    const isolation = runners.linuxIsolation;
    if (this.#d.platform === 'linux' && isolation !== undefined) {
      set('host_isolation', { state: 'running' });
      set('host_isolation', await isolationStep(isolation));
    }
    set('recheck', { state: 'running' });
    this.#d.changed();
    const status = await this.#d.status();
    set('recheck', {
      state: 'done',
      detail: `ready: ${
        status.profiles
          .filter((p) => p.ready)
          .map((p) => p.profile)
          .join(', ') || 'none'
      }`,
    });
    const failed = steps.filter((s) => s.state === 'failed');
    const owner = steps.filter((s) => s.state === 'needs_owner');
    emit({
      state: failed.length > 0 ? 'failed' : 'succeeded',
      ...(failed.length > 0 ? { reason: 'prepare_step_failed' } : {}),
      detail: [
        failed.length > 0 ? `${String(failed.length)} step(s) failed` : 'prepared',
        owner.length > 0 ? `${String(owner.length)} step(s) need the machine owner` : '',
        serviceRestart
          ? 'the privileged helper restarts the RemyralWorker service (new privileges need a new service logon)'
          : restartRequired
            ? 'the worker restarts to apply the new local settings'
            : '',
      ]
        .filter(Boolean)
        .join('; ')
        .slice(0, 300),
      prepare: { steps, status },
    });
    if (serviceRestart) {
      this.#d.logger.warn('the privileged helper restarts the worker service (new privileges)', {
        commandId: cmd.commandId,
      });
    } else if (restartRequired) {
      this.#d.restart();
    }
  }

  async #step(id: PrepareStepId, r: SandboxRunners): Promise<Omit<PrepareStep, 'id' | 'privileged'>> {
    switch (id) {
      case 'worker_user': {
        const i = r.identity;
        if (!i.verified) {
          return {
            state: 'needs_owner',
            code: i.code ?? 'worker_identity_unsafe',
            detail: `${i.problems.join('; ')} — the service must run as the dedicated account the installer creates (re-run the installer kit)`,
          };
        }
        return {
          state: 'done',
          detail: `${i.expectedUser ?? i.username}${
            i.expectedUserSource === 'config'
              ? ' (configured)'
              : i.expectedUserSource === 'inferred'
                ? ' (inferred from the installer account)'
                : ''
          }`,
        };
      }
      case 'job_runner': {
        const jr = await r.refreshJobRunner();
        if (jr?.verified === true) return { state: 'done', detail: jr.detail ?? 'verified' };
        return {
          state: 'failed',
          code: jr?.code ?? 'job_runner_missing',
          detail:
            jr?.code === 'job_runner_selftest_failed'
              ? `self-test failed (${jr.detail ?? ''}); PowerShell Add-Type may be blocked by policy (Constrained Language Mode / AppLocker) — the owner must allow it`
              : (jr?.detail ?? 'no job runner'),
        };
      }
      case 'seatbelt':
        return r.seatbeltAvailable
          ? { state: 'done', detail: '/usr/bin/sandbox-exec works' }
          : {
              state: 'needs_owner',
              code: 'seatbelt_unavailable',
              detail:
                'sandbox-exec does not work on this macOS; host profiles cannot run here (Apple tooling, not fixable remotely)',
            };
      case 'bubblewrap': {
        const ns = r.namespaces;
        if (ns?.usable === true) return { state: 'done', detail: ns.detail };
        return {
          state: 'needs_owner',
          code: ns?.usable === false ? 'namespaces_refused' : 'bubblewrap_missing',
          detail: `${ns?.detail ?? 'bubblewrap not found'} — only runtime-sandbox needs it; enabling user namespaces is a kernel/OS setting`,
        };
      }
      case 'container_engine': {
        const c = await r.container.check();
        if (c.ready || c.reasonCode === 'image_unavailable')
          return { state: 'done', detail: 'engine reachable and rootless' };
        return {
          state: 'needs_owner',
          code: c.reasonCode ?? 'engine_unavailable',
          detail: `${c.reason ?? 'no engine'}; Prepare with the privileged helper installs Podman on Debian/Ubuntu/Fedora`,
        };
      }
      case 'container_images': {
        const c = await r.container.check();
        if (c.ready) return { state: 'done', detail: 'pinned images present' };
        if (c.reasonCode !== 'image_unavailable') return { state: 'skipped', detail: 'no usable engine yet' };
        return {
          state: 'needs_owner',
          code: 'image_unavailable',
          detail:
            'the release does not ship image build contexts; build them as the worker user: node infra/worker/images/build.mjs --engine podman (docs/ops/worker-sandbox.md)',
        };
      }
      case 'disk_space': {
        const st = await this.#d.status();
        const d = st.checks.find((x) => x.id === 'disk_space');
        return d?.status === 'ok'
          ? { state: 'done', ...(d.detail === undefined ? {} : { detail: d.detail }) }
          : {
              state: 'needs_owner',
              code: d?.code ?? 'disk_unknown',
              ...(d?.detail === undefined ? {} : { detail: d.detail }),
            };
      }
      default:
        return { state: 'skipped' };
    }
  }

  /** Cross-access self-test of the per-job accounts (p9-windows-host-isolation); always re-run by Prepare. */
  async #slotStep(
    slots: NonNullable<SandboxRunners['windowsSlots']>,
    restartRequired: boolean,
    serviceRestart: boolean,
  ): Promise<Omit<PrepareStep, 'id' | 'privileged'>> {
    if (restartRequired || serviceRestart) {
      return {
        state: 'skipped',
        code: 'job_slots_after_restart',
        detail: serviceRestart
          ? 'the privileged helper restarts the RemyralWorker service first (new privileges); the worker runs the self-test right after'
          : 'the worker restarts first (new privileges or settings); it runs the self-test right after',
      };
    }
    const record = await slots.verify(true).catch(() => null);
    const st = slots.status();
    if (st.active) return { state: 'done', detail: st.detail };
    if (record === null) {
      return {
        state:
          st.code === 'job_slots_unprovisioned' || st.code === 'job_slots_service_restart'
            ? 'needs_owner'
            : 'failed',
        code: st.code ?? 'job_slots_unverified',
        detail:
          st.code === 'job_slots_unprovisioned'
            ? 'no per-job accounts yet: run Prepare with the privileged helper (it needs the updated helper of this release - re-run the installer kit once)'
            : st.detail,
      };
    }
    return { state: 'failed', code: st.code ?? 'job_slots_selftest_failed', detail: st.detail };
  }

  async #privileged(
    workerId: string,
    cmd: OpsCommandPayload,
    onSteps: (steps: readonly PrepareStep[]) => void,
  ): Promise<{
    step: Omit<PrepareStep, 'id' | 'privileged'>;
    restartRequired: boolean;
    serviceRestart: boolean;
  }> {
    const installDir = this.#d.installDir;
    const helper = (await this.#d.status()).privilegedPrepare;
    if (installDir === undefined || !helper.available) {
      return {
        step: {
          state: 'needs_owner',
          code: 'helper_unavailable',
          detail: helper.detail ?? 'no privileged helper on this machine',
        },
        restartRequired: false,
        serviceRestart: false,
      };
    }
    const reqPath = prepareRequestPath(this.#d.platform, this.#d.dataDir);
    const resPath = prepareResultPath(this.#d.platform, installDir);
    const request: PrepareRequest = { v: 1, workerId, command: cmd };
    await mkdir(dirname(reqPath), { recursive: true, mode: 0o700 });
    const tmp = `${reqPath}.${String(process.pid)}.tmp`;
    await writeFile(tmp, JSON.stringify(request), { mode: 0o600 });
    await rename(tmp, reqPath);
    this.#d.logger.info('privileged prepare requested', { commandId: cmd.commandId });
    const sleep = this.#d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (this.#d.helperTimeoutMs ?? 20 * 60_000);
    let lastSeen = '';
    while (Date.now() < deadline) {
      await sleep(this.#d.pollMs ?? 2000);
      let res: PrepareResult | null;
      try {
        const parsed = PrepareResult.safeParse(JSON.parse(await readFile(resPath, 'utf8')));
        res = parsed.success ? parsed.data : null;
      } catch {
        res = null;
      }
      if (res?.commandId !== cmd.commandId) continue;
      if (res.updatedAt !== lastSeen) {
        lastSeen = res.updatedAt;
        onSteps(res.steps);
      }
      if (res.state === 'refused') {
        return {
          step: {
            state: 'failed',
            code: res.reason ?? 'helper_refused',
            detail: `the privileged helper refused the request: ${res.detail ?? res.reason ?? ''}`,
          },
          restartRequired: false,
          serviceRestart: false,
        };
      }
      if (res.state === 'done') {
        return {
          step: { state: 'done', detail: 'privileged steps finished' },
          restartRequired: res.restartRequired,
          serviceRestart: res.serviceRestart === true,
        };
      }
    }
    return {
      step: {
        state: 'failed',
        code: 'helper_timeout',
        detail:
          this.#d.platform === 'win32'
            ? 'the RemyralWorkerUpdater scheduled task did not answer (it runs once a minute as SYSTEM)'
            : 'the privileged helper did not answer (Linux: remyral-worker-prepare.path; macOS: com.remyral.worker.updater)',
      },
      restartRequired: false,
      serviceRestart: false,
    };
  }
}

/** p19-linux-host-isolation: the cross-attempt self-check of the per-attempt bubblewrap views, run again by Prepare. */
export async function isolationStep(
  isolation: NonNullable<SandboxRunners['linuxIsolation']>,
): Promise<Omit<PrepareStep, 'id' | 'privileged'>> {
  const st = await isolation.verify();
  if (st.active) return { state: 'done', detail: st.detail };
  return {
    state: st.code === 'host_isolation_selftest_failed' ? 'failed' : 'needs_owner',
    code: st.code ?? 'host_isolation_unverified',
    detail: st.detail,
  };
}
