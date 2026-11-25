import {
  ASSISTANT_CAPACITY_FEATURE,
  HOST_ISOLATION_LINUX_FEATURE,
  LocalLoginSlots,
  SandboxStatusReport,
} from '@remyral/protocol';
import { profileFacts } from '../queue/facts.js';

/**
 * p19-linux-host-isolation Part 2 (docs/design/p19-linux-host-isolation.md §6): the REAL per-profile concurrency of a
 * machine and why, for the assistant (describe_worker `capacity`). The owner was told to raise a "host-restricted
 * slot count" that does not exist: per-profile concurrency is derived on the worker (profile-slots.ts) from how it
 * separates attempts — Seatbelt (macOS), per-job accounts (Windows), per-attempt bubblewrap views (Linux) or nothing
 * (one at a time) — and capped by the one setting that exists, "En çok paralel iş" (maxParallelJobs). This module
 * turns the worker's own reports (CAPABILITIES.profileConcurrency / exclusiveProfiles / localLogin, sandboxStatus) into
 * that explanation and into advice that names only real settings and screens. Pure; tested in capacity.test.ts.
 */

const PROFILE_LABEL: Readonly<Record<string, string>> = {
  container: 'Konteyner / Container',
  'runtime-sandbox': 'Runtime sandbox’ı / Runtime’s sandbox',
  'host-restricted': 'Makinede (kısıtlı) / On the machine (restricted)',
  unconfined: 'Sınırsız (tüm makine) / Unconfined (full machine)',
};

/** Where the one real concurrency setting lives (console and tool). */
export const MAX_PARALLEL_SETTING = {
  name: 'En çok paralel iş / Max parallel jobs',
  where: 'Makineler → <machine> → Yapılandırma → Genel / Machines → <machine> → Configuration → General',
  tool: 'draft_worker_config_change (maxParallelJobs)',
} as const;

/**
 * p19-unconfined-parallel: the machine setting that lets attempts without sandbox (unconfined, host profiles without
 * per-attempt isolation) run in parallel.
 */
export const UNCONFINED_PARALLEL_SETTING = {
  name: 'Sandbox’sız işler paralel çalışabilir / Jobs without sandbox may run in parallel',
  where:
    'Makineler → <machine> → Sandbox ve politika → Kısıtsız profil / Machines → <machine> → Sandbox & policy → Unconfined profile',
} as const;

/** The rule text for assistants that predate the capacity prompt rule (`assistant-capacity-v1`). */
export const CAPACITY_RULE_NOTE =
  'Capacity advice must come only from this capacity block: name only the settings, screens and commands it lists. There is no per-profile slot setting (no "host-restricted slot count"); per-profile limits follow from how the machine isolates attempts (limitedBy / why).';

export type LimitedBy =
  | 'max_parallel_jobs'
  | 'no_isolation'
  | 'per_job_accounts'
  | 'runtime_sandbox_nesting'
  | 'unconfined_profile'
  | 'unknown';

export interface CapacityProfile {
  readonly profile: string;
  readonly label: string;
  /** Attempts of it at once (null: the worker does not report it). */
  readonly parallel: number | null;
  /** Its attempt runs only on an otherwise idle machine. */
  readonly runsAlone: boolean;
  readonly limitedBy: LimitedBy;
  readonly why: string;
  /** The worker's own note on its concurrency (e.g. subscription logins). */
  readonly note?: string;
}

export interface CapacityView {
  readonly maxParallelJobs: number | null;
  readonly setting: typeof MAX_PARALLEL_SETTING;
  /** The machine owner's local ceiling (`localCeiling.maxParallelJobs`), when the worker reports one. */
  readonly localCeiling?: number;
  /** How this machine separates concurrent host attempts. */
  readonly hostIsolation: {
    readonly os: string;
    readonly confinement: 'seatbelt' | 'job_user' | 'bwrap' | 'none' | 'unknown';
    readonly state?: string;
    readonly detail?: string;
  };
  readonly profiles: readonly CapacityProfile[];
  readonly subscriptionLogins?: string;
  /** What raises parallelism here — real settings, screens and commands only. */
  readonly advice: readonly string[];
  readonly noOtherSetting: string;
  /** Only for assistants without the capacity prompt rule. */
  readonly rule?: string;
}

export interface CapacityInput {
  readonly name: string;
  readonly os: string | null;
  readonly features: unknown;
  readonly maxParallelJobs: number | null;
  /** `config_report.ceiling.maxParallelJobs` (the local ceiling), if any. */
  readonly localCeiling?: number | null;
  readonly profileConcurrency: unknown;
  readonly exclusiveProfiles: unknown;
  readonly localLogin: unknown;
  readonly sandboxStatus: unknown;
  /** The answering assistant has the capacity prompt rule (`assistant-capacity-v1`). */
  readonly ruleAware?: boolean;
}

function featureList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export function capacityOf(i: CapacityInput): CapacityView {
  const features = featureList(i.features);
  const status = SandboxStatusReport.safeParse(i.sandboxStatus);
  const st = status.success ? status.data : null;
  const os =
    st?.platform ?? (i.os === 'linux' || i.os === 'darwin' || i.os === 'win32' ? i.os : (i.os ?? 'other'));
  const slots = profileFacts(i.features, i.profileConcurrency, i.exclusiveProfiles, null);
  const max = i.maxParallelJobs;
  const check = (id: string) => st?.checks.find((c) => c.id === id);
  const iso = check('host_isolation');
  const jobSlots = check('job_slots');
  const host = st?.profiles.find((p) => p.profile === 'host-restricted');
  const hostFs = host?.confinement?.filesystem;
  const confinement: CapacityView['hostIsolation']['confinement'] =
    hostFs === 'seatbelt' || hostFs === 'bwrap'
      ? hostFs
      : os === 'win32' && jobSlots?.status === 'ok'
        ? 'job_user'
        : host?.ready === true
          ? 'none'
          : 'unknown';
  const isoState = os === 'linux' ? iso : os === 'win32' ? jobSlots : undefined;
  const linuxRelease = features.includes(HOST_ISOLATION_LINUX_FEATURE);

  const ready =
    st === null
      ? Object.keys(slots.profileConcurrency ?? {})
      : st.profiles.filter((p) => p.ready).map((p) => p.profile);
  const profiles: CapacityProfile[] = [];
  const advice: string[] = [];
  const add = (s: string): void => {
    if (!advice.includes(s)) advice.push(s);
  };
  const machine = i.name;
  const screen = (tab: string): string => `Makineler → ${machine} → ${tab}`;

  for (const p of ready) {
    const reported = slots.profileConcurrency?.[p];
    const sp = st?.profiles.find((x) => x.profile === p);
    const parallel = reported ?? sp?.concurrency ?? null;
    const runsAlone = slots.exclusiveProfiles?.includes(p) === true;
    const note = sp?.concurrencyNote;
    let limitedBy: LimitedBy = 'unknown';
    let why = 'the machine does not report its per-profile concurrency (an older worker release)';
    if (p === 'unconfined' && (runsAlone || parallel === null)) {
      limitedBy = 'unconfined_profile';
      why = `runs as the worker account itself: one at a time and alone (ADR-0019), unless an admin turns on “${UNCONFINED_PARALLEL_SETTING.name}” (${UNCONFINED_PARALLEL_SETTING.where})`;
    } else if (p === 'unconfined') {
      // p19-unconfined-parallel: the machine setting is on.
      limitedBy = 'max_parallel_jobs';
      why = `“${UNCONFINED_PARALLEL_SETTING.name}” is on: runs beside other jobs, bounded by “${MAX_PARALLEL_SETTING.name}” (${String(max ?? parallel)})`;
    } else if (parallel !== null && max !== null && parallel >= max) {
      limitedBy = 'max_parallel_jobs';
      why = `bounded only by “${MAX_PARALLEL_SETTING.name}” (${String(max)})`;
    } else if (p === 'runtime-sandbox' && os === 'linux' && confinement === 'bwrap') {
      limitedBy = 'runtime_sandbox_nesting';
      why =
        'the runtime’s own bubblewrap sandbox cannot run inside a per-attempt view: one at a time; host-restricted runs in parallel';
    } else if (p === 'host-restricted' || p === 'runtime-sandbox') {
      if (os === 'win32') {
        limitedBy = 'per_job_accounts';
        why =
          jobSlots?.status === 'ok'
            ? `per-job Windows accounts: ${jobSlots.detail ?? 'active'}`
            : `no per-job Windows accounts (${jobSlots?.code ?? 'not set up'}): host attempts share the worker account, one at a time`;
      } else if (os === 'linux') {
        limitedBy = 'no_isolation';
        why = !linuxRelease
          ? 'this worker release cannot isolate host attempts on Linux: they share the worker account, one at a time'
          : `no per-attempt isolation yet (${iso?.code ?? 'unknown'}): ${iso?.detail ?? 'host attempts share the worker account, one at a time'}`;
      } else {
        limitedBy = 'no_isolation';
        why = 'host attempts cannot be isolated from each other here: one at a time (T-SBX-4)';
      }
    } else if (parallel !== null) {
      limitedBy = 'max_parallel_jobs';
      why = `bounded by “${MAX_PARALLEL_SETTING.name}” (${String(max ?? parallel)})`;
    }
    profiles.push({
      profile: p,
      label: PROFILE_LABEL[p] ?? p,
      parallel,
      runsAlone,
      limitedBy,
      why,
      ...(note === undefined ? {} : { note }),
    });
  }

  // --- advice, real settings only -------------------------------------------------------------------------
  const hostProfile = profiles.find((p) => p.profile === 'host-restricted');
  const containerReady = profiles.some((p) => p.profile === 'container');
  if (hostProfile?.limitedBy === 'no_isolation' && os === 'linux') {
    if (!linuxRelease) {
      add(
        `Update ${machine} to a worker release with Linux per-attempt isolation (Ayarlar → Makine sürümleri / Settings → Worker releases); until then host-restricted jobs run one at a time and raising “${MAX_PARALLEL_SETTING.name}” does not change that.`,
      );
    } else {
      switch (iso?.code) {
        case 'host_isolation_bwrap_missing':
          add(
            `Install bubblewrap on ${machine}: ${screen('Sandbox ve politika')} → Hazırla with “Yetkili yardımcıyı da çalıştır” ticked (installs the distribution package), or on the machine: sudo apt install bubblewrap (Fedora: sudo dnf install bubblewrap), then Hazırla again. After the self-check passes, host-restricted jobs run in parallel up to “${MAX_PARALLEL_SETTING.name}”.`,
          );
          break;
        case 'host_isolation_userns_refused':
          add(
            `${machine} refuses unprivileged user namespaces, which the per-attempt isolation needs: the machine owner allows them (Ubuntu 24.04: the AppArmor bwrap-userns-restrict profile shipped with the apparmor package, or sysctl kernel.apparmor_restrict_unprivileged_userns=0), then ${screen('Sandbox ve politika')} → Hazırla.`,
          );
          break;
        case 'host_isolation_disabled':
          add(
            `The machine owner turned per-attempt isolation off in ${machine}'s local config (sandbox.linuxHostIsolation: "off"); removing that key and restarting the worker enables it.`,
          );
          break;
        case 'host_isolation_selftest_failed':
          add(
            `The cross-attempt self-check failed on ${machine} (${iso.detail ?? 'see the Sandbox card'}): host jobs stay one at a time — show the owner ${screen('Sandbox ve politika')}; Hazırla runs the check again.`,
          );
          break;
        default:
          add(
            `Run ${screen('Sandbox ve politika')} → Hazırla: it runs the per-attempt isolation self-check; once it passes, host-restricted jobs run in parallel.`,
          );
      }
    }
    if (containerReady) {
      add(
        `Jobs in the Konteyner / Container profile already run in parallel on ${machine} (up to “${MAX_PARALLEL_SETTING.name}”).`,
      );
    }
  }
  if (hostProfile?.limitedBy === 'per_job_accounts') {
    add(
      jobSlots?.status === 'ok'
        ? `More parallel host jobs on ${machine} need more per-job Windows accounts: the owner sets sandbox.windowsJobSlots in the machine's local config, then ${screen('Sandbox ve politika')} → Hazırla with the privileged helper.`
        : `Set up per-job Windows accounts: ${screen('Sandbox ve politika')} → Hazırla with “Yetkili yardımcıyı da çalıştır” ticked (${jobSlots?.code ?? 'job_slots'}); then host jobs run in parallel.`,
    );
  }
  if (profiles.some((p) => p.profile === 'runtime-sandbox' && p.limitedBy === 'runtime_sandbox_nesting')) {
    add(
      `Runtime sandbox’ı jobs run one at a time on ${machine}; Makinede (kısıtlı) / host-restricted jobs run in parallel there.`,
    );
  }
  const atMax = profiles.filter((p) => p.limitedBy === 'max_parallel_jobs');
  if (atMax.length > 0 && max !== null) {
    const ceiling = i.localCeiling ?? null;
    add(
      `Raise “${MAX_PARALLEL_SETTING.name}” (now ${String(max)}) in ${screen('Yapılandırma → Genel')} or with ${MAX_PARALLEL_SETTING.tool}: it is the limit for ${atMax.map((p) => p.label).join(', ')}.${
        ceiling !== null
          ? ` The machine's local ceiling (localCeiling.maxParallelJobs = ${String(ceiling)}) caps it; only the machine owner changes that in the local config.`
          : ''
      }`,
    );
  }
  // p19-unconfined-parallel: the one setting that lifts "alone" (an explicit trade-off, never the first advice).
  if (profiles.some((p) => p.runsAlone)) {
    add(
      `Jobs that run alone here (no isolation between attempts) may run in parallel when an admin turns on “${UNCONFINED_PARALLEL_SETTING.name}” in ${screen('Sandbox ve politika')} (needs the unconfined profile allowed; they then share the worker account and its files).`,
    );
  }
  const ll = LocalLoginSlots.safeParse(i.localLogin);
  const subscriptionLogins =
    ll.success && ll.data.runtimes.length > 0 && ll.data.exclusiveProfiles.length > 0
      ? `Subscription-login (local-login) jobs of ${ll.data.runtimes.join(', ')} run one at a time per login in ${ll.data.exclusiveProfiles.join(', ')} (processes sharing one subscription login race on its refresh); API-key runtimes run in parallel there.`
      : confinement === 'bwrap' && (host?.concurrencyNote ?? '').includes('private home')
        ? 'Subscription-login (local-login) jobs get a private home with only the login stores writable and run in parallel here (sandbox.linuxLoginStoreView is on).'
        : confinement === 'bwrap'
          ? 'Subscription-login (local-login) jobs share the worker home on Linux: one job family at a time; API-key runtimes run in parallel. An admin can let them run in parallel with “Abonelik işleri paralel (ayrı ev dizini)” (Makineler → <machine> → Yapılandırma → Yerel ayarlar → Linux sandbox ayarları, or draft_worker_config_change sandbox.linuxLoginStoreView: true; needs the worker release with worker-sandbox-settings-v1 and a worker restart).'
          : undefined;

  return {
    maxParallelJobs: max,
    setting: MAX_PARALLEL_SETTING,
    ...(i.localCeiling === null || i.localCeiling === undefined ? {} : { localCeiling: i.localCeiling }),
    hostIsolation: {
      os,
      confinement,
      ...(isoState?.code === undefined
        ? isoState?.status === 'ok'
          ? { state: 'ok' }
          : {}
        : { state: isoState.code }),
      ...(isoState?.detail === undefined ? {} : { detail: isoState.detail }),
    },
    profiles,
    ...(subscriptionLogins === undefined ? {} : { subscriptionLogins }),
    advice,
    noOtherSetting:
      'There is no other concurrency setting: no per-profile or "host-restricted slot" setting exists. Per-profile limits follow from the isolation above; only “En çok paralel iş” and the steps in advice change them.',
    ...(i.ruleAware === true ? {} : { rule: CAPACITY_RULE_NOTE }),
  };
}

/** Whether the answering worker has the capacity prompt rule. */
export function capacityRuleAware(features: unknown): boolean {
  return featureList(features).includes(ASSISTANT_CAPACITY_FEATURE);
}
