import { readFile, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  RuntimeKind,
  SandboxCheck,
  SandboxFix,
  SandboxProfileStatus,
  SandboxStatusReport,
} from '@remyral/protocol';
import { helperName } from '../update/layout.js';
import type { SandboxRunners } from './factory.js';
import type { ProfileCapability } from './policy.js';
import { hostFallback } from './host/fallback.js';
import { PREPARE_HELPER_MARKER } from './prepare-shared.js';

/**
 * The Sandbox card's data (p5-sandbox-ops): per profile ready / not ready with a machine-readable code, a reason,
 * a remedy and who can fix it, plus the host checks behind it. Built from the runners' own self-checks (the same
 * ones job placement and `selectProfile` use), never from tool presence alone.
 */

export interface SandboxStatusInputs {
  readonly runners: SandboxRunners | null;
  readonly runnersError: string | null;
  readonly enabledRuntimes: readonly RuntimeKind[];
  /** Effective `unconfined` state (managed config). */
  readonly unconfined: 'allowed' | 'not_enabled' | 'forbidden_locally';
  /**
   * p19-unconfined-parallel: attempts without filesystem confinement run in parallel up to this many
   * (maxParallelJobs; absent: the setting is off and they run alone).
   */
  readonly unconfinedParallel?: number | undefined;
  readonly workspaceRoot: string;
  /** Privileged prepare helper present (see `privilegedHelperAvailable`). */
  readonly privilegedHelper: { available: boolean; detail?: string };
  readonly platform?: NodeJS.Platform;
  readonly now?: Date;
  /** Tests: free bytes of the workspace root. */
  readonly freeBytes?: number | null;
}

const MIN_FREE = 2 * 1024 ** 3;

/** p19-unconfined-parallel: the concurrency note of a profile without isolation when the machine setting is on. */
const PARALLEL_NOTE =
  "no isolation between attempts; they run in parallel (machine setting: Sandbox'sız işler paralel çalışabilir)";

function platformOf(p: NodeJS.Platform): SandboxStatusReport['platform'] {
  return p === 'linux' || p === 'darwin' || p === 'win32' ? p : 'other';
}

async function freeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

/**
 * Whether the installed privileged helper implements `sandbox.prepare` (the updater bundle in the install dir
 * carries the marker). Cached per file size + mtime.
 */
let helperCache: { key: string; ok: boolean } | null = null;
export async function privilegedHelperAvailable(
  installDir: string | undefined,
): Promise<{ available: boolean; detail?: string }> {
  if (installDir === undefined) return { available: false, detail: 'install dir unknown' };
  const file = join(installDir, helperName());
  try {
    const st = await stat(file);
    const key = `${file}:${String(st.size)}:${String(st.mtimeMs)}`;
    if (helperCache?.key !== key) {
      helperCache = { key, ok: (await readFile(file, 'utf8')).includes(PREPARE_HELPER_MARKER) };
    }
    return helperCache.ok
      ? { available: true }
      : {
          available: false,
          detail:
            'the installed updater predates privileged prepare; re-run the installer kit once (as admin/root)',
        };
  } catch {
    return {
      available: false,
      detail: 'no privileged updater installed (re-run the installer kit with its updater)',
    };
  }
}

function check(
  id: SandboxCheck['id'],
  status: SandboxCheck['status'],
  extra: { code?: string; detail?: string; fix?: SandboxFix } = {},
): SandboxCheck {
  return {
    id,
    status,
    ...(extra.code === undefined ? {} : { code: extra.code }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail.slice(0, 300) }),
    ...(extra.fix === undefined ? {} : { fix: extra.fix }),
  };
}

function notReady(
  profile: SandboxProfileStatus['profile'],
  cap: ProfileCapability,
  checks: SandboxProfileStatus['checks'],
  fix: SandboxFix,
  code?: string,
): SandboxProfileStatus {
  return {
    profile,
    ready: false,
    code: code ?? cap.reasonCode ?? 'not_ready',
    ...(cap.reason === undefined ? {} : { reason: cap.reason.slice(0, 300) }),
    ...(cap.remedy === undefined ? {} : { remedy: cap.remedy.slice(0, 300) }),
    fix,
    checks,
  };
}

export async function buildSandboxStatus(i: SandboxStatusInputs): Promise<SandboxStatusReport> {
  const platform = i.platform ?? i.runners?.platform ?? process.platform;
  const checks: SandboxCheck[] = [];
  const profiles: SandboxProfileStatus[] = [];
  const r = i.runners;
  const helper = i.privilegedHelper;

  if (r === null) {
    const reason = `sandbox runners unavailable: ${i.runnersError ?? 'not created'}`.slice(0, 300);
    for (const profile of ['container', 'runtime-sandbox', 'host-restricted', 'unconfined'] as const) {
      profiles.push({ profile, ready: false, code: 'runners_unavailable', reason, fix: 'owner', checks: [] });
    }
    return {
      checkedAt: (i.now ?? new Date()).toISOString(),
      platform: platformOf(platform),
      workerUser: { running: 'unknown', source: 'none' },
      privilegedPrepare: helper,
      profiles,
      checks,
    };
  }

  // --- host checks ---------------------------------------------------------------------------------
  const id = r.identity;
  const identityOk = id.verified;
  const identityFix: SandboxFix = 'owner';
  checks.push(
    identityOk
      ? check('worker_identity', 'ok', { detail: `runs as ${id.username}` })
      : check('worker_identity', 'failed', {
          code: id.code ?? 'worker_identity_unsafe',
          detail: id.problems.join('; '),
          fix: identityFix,
        }),
  );
  checks.push(
    id.expectedUserSource === 'none' || id.expectedUserSource === undefined
      ? check('worker_user', 'failed', {
          code: 'worker_user_unset',
          detail: 'sandbox.workerUser is not set and the worker does not run as the installer account',
          fix: 'owner',
        })
      : check('worker_user', 'ok', {
          detail: `${id.expectedUser ?? ''} (${id.expectedUserSource === 'config' ? 'configured' : 'inferred from the installer account'})`,
        }),
  );
  const jr = r.jobRunner();
  if (platform === 'win32') {
    checks.push(
      jr?.verified === true
        ? check('job_runner', 'ok', { detail: jr.detail ?? jr.source ?? 'verified' })
        : check('job_runner', 'failed', {
            code: jr?.code ?? 'job_runner_missing',
            ...(jr?.detail === undefined ? {} : { detail: jr.detail }),
            fix: 'prepare',
          }),
    );
  } else {
    checks.push(check('job_runner', 'not_applicable'));
  }
  if (platform === 'darwin') {
    checks.push(
      r.seatbeltAvailable
        ? check('seatbelt', 'ok', { detail: '/usr/bin/sandbox-exec works' })
        : check('seatbelt', 'failed', {
            code: 'seatbelt_unavailable',
            detail: 'sandbox-exec is not usable on this macOS',
            fix: 'owner',
          }),
    );
  } else {
    checks.push(check('seatbelt', 'not_applicable'));
  }
  if (platform === 'linux') {
    const ns = r.namespaces;
    checks.push(
      ns?.usable === true
        ? check('bubblewrap', 'ok', { detail: ns.detail })
        : check('bubblewrap', 'warning', {
            code: ns?.usable === false ? 'namespaces_refused' : 'bubblewrap_missing',
            detail: ns?.detail ?? 'bubblewrap not checked',
            fix: 'owner',
          }),
    );
  } else {
    checks.push(check('bubblewrap', 'not_applicable'));
  }
  // Container engine / images (Linux only by ADR-0007).
  const engine = await r.container.check();
  if (platform !== 'linux') {
    checks.push(check('container_engine', 'not_applicable'));
    checks.push(check('container_rootless', 'not_applicable'));
    checks.push(check('container_images', 'not_applicable'));
  } else if (!engine.ready && engine.reasonCode === 'engine_unavailable') {
    const rootless = /rootless/.test(engine.reason ?? '');
    checks.push(
      rootless
        ? check('container_engine', 'ok')
        : check('container_engine', 'failed', {
            code: 'engine_unavailable',
            ...(engine.reason === undefined ? {} : { detail: engine.reason }),
            fix: 'prepare_privileged',
          }),
    );
    checks.push(
      rootless
        ? check('container_rootless', 'failed', {
            code: 'engine_not_rootless',
            ...(engine.reason === undefined ? {} : { detail: engine.reason }),
            fix: 'owner',
          })
        : check('container_rootless', 'not_applicable'),
    );
    checks.push(check('container_images', 'not_applicable'));
  } else {
    checks.push(check('container_engine', 'ok'));
    checks.push(check('container_rootless', 'ok'));
    const missing: string[] = [];
    for (const rt of i.enabledRuntimes) {
      const c = await r.container.check(rt);
      if (!c.ready && c.reasonCode === 'image_unavailable') missing.push(rt);
    }
    checks.push(
      missing.length === 0 && engine.ready
        ? check('container_images', 'ok')
        : check('container_images', 'failed', {
            code: 'image_unavailable',
            detail: `no pinned image present for ${missing.join(', ') || 'the default runtime'}`,
            fix: 'owner',
          }),
    );
  }
  const free = i.freeBytes !== undefined ? i.freeBytes : await freeBytes(i.workspaceRoot);
  checks.push(
    free === null
      ? check('disk_space', 'warning', {
          code: 'disk_unknown',
          detail: 'free space of the workspace root unknown',
        })
      : free < MIN_FREE
        ? check('disk_space', 'warning', {
            code: 'disk_low',
            detail: `${String(Math.round(free / 1024 ** 2))} MiB free under the workspace root`,
            fix: 'owner',
          })
        : check('disk_space', 'ok', { detail: `${String(Math.round(free / 1024 ** 3))} GiB free` }),
  );
  checks.push(
    helper.available
      ? check('privileged_helper', 'ok')
      : check('privileged_helper', 'warning', {
          code: 'helper_unavailable',
          ...(helper.detail === undefined ? {} : { detail: helper.detail }),
          fix: 'owner',
        }),
  );
  checks.push(
    i.unconfined === 'allowed'
      ? check('unconfined_policy', 'warning', {
          code: 'unconfined_enabled',
          detail: 'the unconfined profile is ON for this worker (no filesystem or egress confinement)',
          fix: 'panel',
        })
      : i.unconfined === 'forbidden_locally'
        ? check('unconfined_policy', 'failed', {
            code: 'unconfined_forbidden_locally',
            detail: 'the panel allows unconfined but the local config forbids it',
            fix: 'owner',
          })
        : check('unconfined_policy', 'not_applicable', { code: 'unconfined_not_enabled', fix: 'panel' }),
  );

  // p9-windows-host-isolation: per-job accounts (parallel host attempts on Windows).
  const slots = platform === 'win32' ? r.windowsSlots : undefined;
  const slotStatus = slots?.status();
  if (platform !== 'win32') {
    checks.push(check('job_slots', 'not_applicable'));
  } else if (slotStatus === undefined) {
    checks.push(
      check('job_slots', 'warning', {
        code: 'job_slots_disabled',
        detail:
          'per-job accounts are off on this machine (sandbox.windowsJobSlots: 0); host jobs run one at a time',
        fix: 'owner',
      }),
    );
  } else if (slotStatus.active) {
    checks.push(check('job_slots', 'ok', { detail: slotStatus.detail }));
  } else {
    checks.push(
      check(
        'job_slots',
        slotStatus.code === 'job_slots_selftest_failed' || slotStatus.code === 'job_slots_login_shared'
          ? 'failed'
          : 'warning',
        {
          ...(slotStatus.code === undefined ? {} : { code: slotStatus.code }),
          detail: slotStatus.detail,
          fix: slotFix(slotStatus.code),
        },
      ),
    );
  }

  // p19-linux-host-isolation (ADR-0066): per-attempt bubblewrap views (parallel host attempts on Linux).
  const isolation = platform === 'linux' ? r.linuxIsolation?.status() : undefined;
  if (platform !== 'linux' || isolation === undefined) {
    checks.push(check('host_isolation', 'not_applicable'));
  } else if (isolation.active) {
    checks.push(check('host_isolation', 'ok', { detail: isolation.detail }));
  } else {
    checks.push(
      check('host_isolation', isolation.code === 'host_isolation_selftest_failed' ? 'failed' : 'warning', {
        ...(isolation.code === undefined ? {} : { code: isolation.code }),
        detail: isolation.detail,
        fix: isolationFix(isolation.code),
      }),
    );
  }

  // --- profiles ------------------------------------------------------------------------------------
  const identityFirst = (cap: ProfileCapability): SandboxFix =>
    cap.reasonCode === 'worker_identity_unsafe'
      ? 'owner'
      : platform === 'win32' && jr?.verified !== true
        ? 'prepare'
        : 'owner';
  const hostCode = (cap: ProfileCapability): string | undefined =>
    platform === 'win32' && cap.reasonCode === 'limits_unsupported'
      ? (jr?.code ?? 'job_runner_missing')
      : undefined;

  // container
  if (platform !== 'linux') {
    profiles.push({
      profile: 'container',
      ready: false,
      code: 'profile_unsupported_on_os',
      reason: `ADR-0007 defines the container profile for Linux workers (this is ${platform})`,
      fix: 'none',
      checks: ['container_engine', 'container_rootless', 'container_images'],
    });
  } else {
    const ready: RuntimeKind[] = [];
    let first: ProfileCapability | undefined;
    for (const rt of i.enabledRuntimes) {
      const c = await r.container.check(rt);
      if (c.ready) ready.push(rt);
      else first ??= c;
    }
    const cap = ready.length > 0 ? { ready: true } : (first ?? engine);
    profiles.push(
      ready.length > 0 || (cap.ready && i.enabledRuntimes.length === 0)
        ? {
            profile: 'container',
            ready: true,
            runtimes: ready,
            checks: ['container_engine', 'container_rootless', 'container_images'],
            confinement: { filesystem: 'container', egress: 'enforced', limits: 'cgroup' },
          }
        : notReady(
            'container',
            cap,
            ['container_engine', 'container_rootless', 'container_images'],
            cap.reasonCode === 'engine_unavailable' && !/rootless/.test(cap.reason ?? '')
              ? 'prepare_privileged'
              : 'owner',
          ),
    );
  }
  // runtime-sandbox
  {
    const ready: RuntimeKind[] = [];
    let first: ProfileCapability | undefined;
    for (const rt of i.enabledRuntimes) {
      const c = r.runtimeSandbox.check(rt);
      if (c.ready) ready.push(rt);
      else first ??= c;
    }
    const deps: SandboxProfileStatus['checks'] =
      platform === 'linux'
        ? ['worker_identity', 'bubblewrap']
        : platform === 'darwin'
          ? ['worker_identity', 'seatbelt']
          : ['worker_identity', 'job_runner'];
    // p19-linux-host-isolation: the runtime's own bubblewrap cannot nest in a per-attempt view — one at a time.
    const rsNote =
      platform === 'linux' && i.unconfinedParallel !== undefined
        ? PARALLEL_NOTE
        : platform === 'linux'
          ? isolation?.active === true
            ? 'one attempt at a time: the runtime’s own bubblewrap sandbox cannot run inside a per-attempt view; host-restricted runs in parallel'
            : 'one attempt at a time: host attempts share the worker account here (T-SBX-4)'
          : undefined;
    profiles.push(
      ready.length > 0
        ? {
            profile: 'runtime-sandbox',
            ready: true,
            runtimes: ready,
            checks: deps,
            ...(rsNote === undefined
              ? {}
              : {
                  concurrency: rsNote === PARALLEL_NOTE ? (i.unconfinedParallel ?? 1) : 1,
                  concurrencyNote: rsNote.slice(0, 300),
                }),
          }
        : notReady(
            'runtime-sandbox',
            first ?? {
              ready: false,
              reasonCode: 'runtime_has_no_sandbox',
              reason: 'no enabled runtime has a native sandbox here',
            },
            deps,
            first === undefined ? 'none' : identityFirst(first),
          ),
    );
  }
  // host-restricted
  {
    const cap = r.host.check();
    const deps: SandboxProfileStatus['checks'] =
      platform === 'win32'
        ? ['worker_identity', 'worker_user', 'job_runner', 'job_slots']
        : platform === 'darwin'
          ? ['worker_identity', 'worker_user', 'seatbelt']
          : platform === 'linux'
            ? ['worker_identity', 'worker_user', 'host_isolation']
            : ['worker_identity', 'worker_user'];
    // p19-unconfined-parallel: without isolation the machine setting lets host attempts run beside each other.
    const parallelHost = cap.filesystemConfinement === 'none' && i.unconfinedParallel !== undefined;
    const concurrency = parallelHost ? (i.unconfinedParallel ?? 1) : r.hostRestrictedConcurrency();
    const note = parallelHost
      ? PARALLEL_NOTE
      : cap.filesystemConfinement === 'job_user'
        ? // p9-windows-slots-local-login: subscription logins never run on a per-job account.
          'for API-key runtimes; subscription logins run one at a time (each API-key attempt runs as its own Windows account)'
        : cap.filesystemConfinement === 'seatbelt'
          ? undefined
          : cap.filesystemConfinement === 'bwrap'
            ? // p19-linux-host-isolation: subscription logins keep the worker home (one job family at a time);
              // p22-worker-limits: with sandbox.linuxLoginStoreView they get a private home and run in parallel.
              cap.loginStoreView
              ? 'each attempt in its own bubblewrap view; subscription-login (local-login) jobs get a private home with only the login stores writable and run in parallel'
              : 'each attempt in its own bubblewrap view; subscription-login (local-login) jobs run one job family at a time (they share the worker home)'
            : platform === 'win32'
              ? `one attempt at a time: ${slotStatus?.detail ?? 'per-job accounts are off'}`
              : platform === 'linux' && isolation !== undefined
                ? `one attempt at a time: ${isolation.detail}`
                : 'one attempt at a time: host attempts share the worker account here (T-SBX-4); use the container profile for parallel jobs';
    // Security fix: no confinement at all (not even a per-job account) is said so — filesystem `none`, with why and
    // what gives real confinement — instead of the old `os_user` (that is the per-job account case on Windows).
    const fallback = hostFallback(r);
    profiles.push(
      cap.ready
        ? {
            profile: 'host-restricted',
            ready: true,
            checks: deps,
            ...(fallback === null
              ? {}
              : {
                  code: fallback.code,
                  reason: `${fallback.reason} (${fallback.cause})`.slice(0, 300),
                  remedy: fallback.remedy.slice(0, 300),
                  fix: fallback.fix,
                }),
            confinement: {
              filesystem:
                cap.filesystemConfinement === 'seatbelt' || cap.filesystemConfinement === 'bwrap'
                  ? cap.filesystemConfinement
                  : cap.filesystemConfinement === 'none'
                    ? 'none'
                    : 'os_user',
              egress: cap.egressEnforced ? 'enforced' : 'proxy_env_only',
              limits: platform === 'win32' ? 'job_object' : 'rlimits',
            },
            concurrency,
            ...(note === undefined ? {} : { concurrencyNote: note.slice(0, 300) }),
          }
        : notReady('host-restricted', cap, deps, identityFirst(cap), hostCode(cap)),
    );
  }
  // unconfined
  {
    const cap = r.unconfined.check();
    const deps: SandboxProfileStatus['checks'] =
      platform === 'win32'
        ? ['unconfined_policy', 'worker_identity', 'job_runner']
        : ['unconfined_policy', 'worker_identity'];
    profiles.push(
      cap.ready
        ? {
            profile: 'unconfined',
            ready: true,
            checks: deps,
            confinement: {
              filesystem: 'none',
              egress: 'none',
              limits: platform === 'win32' ? 'job_object' : 'rlimits',
            },
            // p19-unconfined-parallel: reported only with the setting on (otherwise: alone, as before).
            ...(i.unconfinedParallel === undefined
              ? {}
              : { concurrency: i.unconfinedParallel, concurrencyNote: PARALLEL_NOTE }),
          }
        : notReady(
            'unconfined',
            cap,
            deps,
            i.unconfined === 'allowed'
              ? identityFirst(cap)
              : i.unconfined === 'forbidden_locally'
                ? 'owner'
                : 'panel',
            i.unconfined === 'allowed'
              ? (hostCode(cap) ?? cap.reasonCode)
              : i.unconfined === 'forbidden_locally'
                ? 'unconfined_forbidden_locally'
                : 'unconfined_not_enabled',
          ),
    );
  }

  return {
    checkedAt: (i.now ?? new Date()).toISOString(),
    platform: platformOf(platform),
    workerUser: {
      running: id.username.slice(0, 128),
      ...(id.expectedUser === undefined ? {} : { expected: id.expectedUser.slice(0, 128) }),
      source: id.expectedUserSource ?? 'none',
    },
    privilegedPrepare: helper,
    profiles,
    checks,
  };
}

/** Who fixes a Linux isolation problem (p19-linux-host-isolation). */
function isolationFix(code: string | undefined): SandboxFix {
  switch (code) {
    case 'host_isolation_bwrap_missing':
      // The privileged helper installs the distribution's bubblewrap; without one the owner does (the detail says how).
      return 'prepare_privileged';
    case 'host_isolation_unverified':
      return 'prepare';
    default:
      return 'owner';
  }
}

/** Who fixes a per-job account problem (p9-windows-host-isolation). */
function slotFix(code: string | undefined): SandboxFix {
  switch (code) {
    case 'worker_identity_unsafe':
    case 'job_slots_service_restart':
      return 'owner';
    case 'job_runner_missing':
    case 'job_slots_unverified':
    case 'job_slots_quarantined':
    case 'job_slots_unchecked':
    case 'job_slots_login_shared':
      return 'prepare';
    default:
      return 'prepare_privileged';
  }
}
