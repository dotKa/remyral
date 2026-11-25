import { RuntimeKind } from '@remyral/protocol';
import { z } from 'zod';
import { parseEgressTarget } from './network.js';
import { DEFAULT_LIMITS, type ResourceLimits } from './types.js';

const AbsPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) => !p.includes('\0') && (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)),
    'must be an absolute path',
  );

const ImageRef = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9._/:@-]*$/, 'image reference (lower-case, no spaces)');

const EgressEntry = z
  .string()
  .max(260)
  .superRefine((v, ctx) => {
    try {
      parseEgressTarget(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'invalid' });
    }
  });

export const SandboxLimitsSettings = z.strictObject({
  memoryBytes: z
    .number()
    .int()
    .min(64 * 1024 ** 2)
    .optional(),
  cpus: z.number().min(0.1).max(256).optional(),
  pids: z.number().int().min(16).max(65536).optional(),
  fileSizeBytes: z
    .number()
    .int()
    .min(1024 ** 2)
    .optional(),
  openFiles: z.number().int().min(64).max(1_048_576).optional(),
  tmpBytes: z
    .number()
    .int()
    .min(16 * 1024 ** 2)
    .optional(),
});

/** `sandbox` section of the worker config (p3-sandbox). Every key is optional. */
export const SandboxSettings = z.strictObject({
  /** The dedicated low-privilege worker OS user the service runs as (ADR-0007). Required for host profiles. */
  workerUser: z.string().min(1).max(128).optional(),
  /** macOS: Seatbelt for host profiles. `off` is only for diagnosis; it disables per-attempt confinement. */
  seatbelt: z.enum(['required', 'off']).default('required'),
  /** Further homes whose secrets are denied to host runtimes (e.g. the owner's home). */
  protectedHomes: z.array(AbsPath).max(16).default([]),
  /** local-login runtimes: keep the worker user's HOME and allow these state dirs to be written. */
  keepHome: z.boolean().default(false),
  hostExtraWritable: z.array(AbsPath).max(16).default([]),
  /** local-login on macOS: allow Keychain reads (Claude Code stores its login there). */
  allowKeychain: z.boolean().default(false),
  /** Windows: an owner-placed job runner script (`remyral-jobrun.ps1`); default: the embedded one (p5-sandbox-ops). */
  windowsJobHelper: AbsPath.optional(),
  /**
   * Windows (p9-windows-host-isolation): per-job accounts the privileged Prepare keeps (remyral-job-1..N; default
   * max(maxParallelJobs, 4)). `0` = never use per-job accounts on this machine: host jobs stay one at a time.
   */
  windowsJobSlots: z.number().int().min(0).max(16).optional(),
  /**
   * Linux (p19-linux-host-isolation, ADR-0066): run each `host-restricted` attempt in its own bubblewrap view once the
   * cross-attempt self-check passed (`auto`, default). `off` = the owner's local switch: host jobs stay one at a time.
   */
  linuxHostIsolation: z.enum(['auto', 'off']).default('auto'),
  /**
   * Linux (p22-worker-limits, backlog p19-linux-net-isolation): `auto` gives each bubblewrap view its own network
   * namespace with a relay to the attempt's egress proxy once the network self-check passed. Attempts the worker must
   * reach on loopback (services, IDE servers, OpenCode, jobs with preview links) keep the host network. Default `off`
   * (every view shares the host network, as before) until the live check in docs/design/p22-worker-limits.md §2.6
   * passed on the machine.
   */
  linuxPrivateNetwork: z.enum(['auto', 'off']).default('off'),
  /**
   * Linux (p22-worker-limits, backlog p19-linux-local-login-parallel): subscription-login (local-login) host attempts
   * get a private home with only the runtimes' login stores writable (their trusted configuration read-only), and then
   * run in parallel across job families. OFF by default until the live check in docs/design/p22-worker-limits.md
   * §3.3 passed on the machine (Claude Code's refresh lock and ~/.claude.json rewrite in such a view).
   */
  linuxLoginStoreView: z.boolean().default(false),
  /**
   * p19-unconfined-parallel: the owner's local pin of the panel setting "Sandbox'sız işler paralel çalışabilir" —
   * attempts without filesystem confinement (`unconfined`, host profiles without per-attempt isolation) run beside
   * each other and beside other attempts (up to maxParallelJobs) instead of alone. Absent: the panel decides (default
   * off); `false` keeps them alone whatever the panel says.
   */
  unconfinedParallel: z.boolean().optional(),
  /** Default egress allowlist (model APIs); jobs can only narrow it. */
  egressAllow: z.array(EgressEntry).max(64).default(['api.anthropic.com', 'api.openai.com']),
  limits: SandboxLimitsSettings.prefault({}),
  container: z
    .strictObject({
      engine: z.enum(['docker', 'podman']).default('docker'),
      /** Runtime image per runtime kind (`default` for the rest). Pin by digest in production. */
      images: z.partialRecord(z.union([RuntimeKind, z.literal('default')]), ImageRef).default({}),
      proxyImage: ImageRef.default('remyral/egress-proxy:0.1.0'),
      egressNetwork: z
        .string()
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/)
        .default('bridge'),
      user: z
        .string()
        .regex(/^[1-9]\d{0,9}(:\d{1,10})?$/, 'non-root numeric uid[:gid]')
        .default('10001:10001'),
    })
    .prefault({}),
});
export type SandboxSettings = z.infer<typeof SandboxSettings>;

export function limitsFromSettings(s: SandboxSettings['limits']): ResourceLimits {
  return {
    memoryBytes: s.memoryBytes ?? DEFAULT_LIMITS.memoryBytes,
    cpus: s.cpus ?? DEFAULT_LIMITS.cpus,
    pids: s.pids ?? DEFAULT_LIMITS.pids,
    fileSizeBytes: s.fileSizeBytes ?? DEFAULT_LIMITS.fileSizeBytes,
    openFiles: s.openFiles ?? DEFAULT_LIMITS.openFiles,
    tmpBytes: s.tmpBytes ?? DEFAULT_LIMITS.tmpBytes,
  };
}
