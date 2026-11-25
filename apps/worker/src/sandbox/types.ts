import type { OwnedProcess, ProcessConfiner, SecretEnv } from '@remyral/agent-adapters';
import type { RuntimeKind, SandboxProfile } from '@remyral/protocol';
import type { AttemptGitView } from './attempt-git.js';

export type { SandboxProfile };

/** `host:port` the job may reach through the egress proxy (HTTP CONNECT only). */
export interface EgressTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Network policy of one job (ADR-0007, ADR-0010 rule 3, T-SBX-2, T-INJ-1).
 *  - `none`: no network at all.
 *  - `allowlist`: only HTTPS tunnels to the listed hosts, through the worker's
 *    egress proxy. Never IP literals, never private/link-local/metadata addresses.
 *  - `web` (p5-research-workspace): the listed hosts plus any public host name on port 443, through the same
 *    proxy and the same address checks (workspace jobs with egress `web`).
 *
 * `refusalHint` (p14-repo-egress): what the proxy's 403 body says about the policy and where to change it.
 */
export type NetworkPolicy =
  | { readonly mode: 'none' }
  | { readonly mode: 'allowlist'; readonly targets: readonly EgressTarget[]; readonly refusalHint?: string }
  | { readonly mode: 'web'; readonly targets: readonly EgressTarget[]; readonly refusalHint?: string };

/** Per-job resource limits (T-SBX-5). Every field is enforced where the profile can; see `p3-sandbox.md`. */
export interface ResourceLimits {
  /** Hard memory limit (container: cgroup; Windows: Job Object; macOS/Pi host: not enforceable, see docs). */
  readonly memoryBytes: number;
  /** CPU share in cores (container: `--cpus`; Windows: Job Object CPU rate). */
  readonly cpus: number;
  /** Max processes/threads (container: `--pids-limit`; POSIX host: RLIMIT_NPROC per user; Windows: active processes). */
  readonly pids: number;
  /** Max size of a single written file (RLIMIT_FSIZE / container ulimit). */
  readonly fileSizeBytes: number;
  /** Max open files (RLIMIT_NOFILE). */
  readonly openFiles: number;
  /** Size of the job's private /tmp (container tmpfs). */
  readonly tmpBytes: number;
}

export const DEFAULT_LIMITS: ResourceLimits = Object.freeze({
  memoryBytes: 4 * 1024 ** 3,
  cpus: 2,
  pids: 512,
  fileSizeBytes: 2 * 1024 ** 3,
  openFiles: 4096,
  tmpBytes: 1024 ** 3,
});

/** Everything a profile needs to confine one runtime process of one attempt. */
export interface SandboxContext {
  readonly jobId: string;
  readonly attemptId: string;
  readonly runtime?: RuntimeKind;
  /**
   * How the runtime authenticates in this attempt (the job's env plan). `local-login` (a subscription login in the
   * worker account's own login store) never runs as a Windows per-job account: processes sharing one subscription
   * login race on its OAuth refresh (p9-windows-slots-local-login). Absent: not local-login.
   */
  readonly authMode?: 'secret-ref' | 'local-login' | 'none';
  /**
   * p13-runtime-accounts (ADR-0049): `local-login` with an added runtime account — the account's own folder
   * (`<dataDir>/runtime-accounts/<runtime>/<id>`, holding its config dir and refresh locks). Windows per-job accounts:
   * the attempt runs on a slot that gets Modify on this one folder for the attempt only (revoked and owned back after
   * its last process); Seatbelt: the folder is writable for the attempt. Absent: the worker's own login (as before).
   */
  readonly loginFolder?: string;
  /** Real absolute host path of the attempt worktree — the only writable project path. */
  readonly workspacePath: string;
  /**
   * Per-attempt git view (attempt-git.ts). When present, the runtime gets its own
   * git dir instead of the shared mirror's worktree metadata (T-SBX-4).
   */
  readonly git?: AttemptGitView;
  /**
   * p5-research-workspace: the attempt's sandbox dir (`<root>/sandboxes/<job>/<attempt>`) created by the job
   * runner when there is no git view (scratch jobs). Runtime state below it may be mounted writable; the runner
   * owns and removes it. Ignored when `git` is set.
   */
  readonly sandboxDir?: string;
  readonly network: NetworkPolicy;
  readonly limits: ResourceLimits;
  /**
   * Container profile only (job runner, p3-e2e wiring): host paths the runtime's own command line refers
   * to, bind-mounted at the **same** path so those arguments stay valid inside the container — the
   * adapter's per-attempt state dir (rw) and operator-supplied extension files (ro). Never the workspace
   * root, the mirrors or the worker data dir (the runner refuses paths outside `<root>/sandboxes/<job>/
   * <attempt>` for rw mounts). Host profiles ignore it (those paths are already reachable).
   */
  readonly runtimeMounts?: readonly { readonly path: string; readonly readOnly: boolean }[];
  /**
   * p14-mcp-stdio, container profile only: install dirs of the job's local MCP servers, bind-mounted **read-only** at
   * the same path (the launcher spec file names them). The runner refuses a dir that is not a directory inside `root`
   * (`<dataDir>/mcp`). Host profiles ignore it (the MCP root is readable to them, never writable).
   */
  readonly mcpMounts?: { readonly root: string; readonly dirs: readonly string[] };
  /**
   * Container profile only: the runtime executable inside the image (e.g. `pi`), replacing the host path
   * the adapter resolved. Host profiles ignore it.
   */
  readonly containerCommand?: string;
  /**
   * p6-warm-caches (ADR-0029), host profiles only: the project's shared package cache — the one directory outside the
   * attempt the runtime may read and write (Seatbelt allows exactly it; the Linux/Windows host baseline has no
   * per-attempt filesystem confinement) and the package-manager variables pointing at it. The container runner
   * refuses a context that carries it.
   */
  readonly packageCaches?: {
    readonly dirs: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  /**
   * p15-services: the process serves a port (a service's dev server / backend). Seatbelt then allows listening
   * sockets (it cannot limit them to loopback — p3-sandbox decision 5; the same allowance the OpenCode server gets);
   * other host profiles do not restrict listening.
   */
  readonly listen?: boolean;
  /**
   * p15-services: `false` runs a host-restricted process as the worker account on Windows, never on a per-job account
   * of the pool (a long-running service must not hold one of the accounts job attempts are counted against). Its
   * directories still get the protected DACL.
   */
  readonly jobAccount?: boolean;
  /**
   * p19-ide W2b: loopback ports the process may connect to besides its egress proxy (the IDE's bridge). Seatbelt
   * allows exactly these; other host profiles do not confine loopback.
   */
  readonly loopbackPorts?: readonly number[];
  /**
   * p19-ide W2b: directories (inside the sandbox dir) where the process may bind / connect Unix-domain sockets — VS
   * Code's internal IPC. Seatbelt denies every socket otherwise; other host profiles do not confine them.
   */
  readonly unixSocketDirs?: readonly string[];
  /**
   * p19-ide W2b: further read-only directories under the workspace root (the IDE's repository mirror, for its own git):
   * a carve-out of Seatbelt's workspace-root read deny, a read-only bind in the Linux view, a read + execute grant for
   * the attempt's Windows per-job account (revoked after its last process). Never writable.
   */
  readonly readOnlyDirs?: readonly string[];
  /**
   * p22-worker-limits: every decision of this launch's own egress proxy (host profiles; the container sidecar's
   * decisions are not reported here). A service uses it to tell a policy refusal (403) from an ordinary failure.
   */
  readonly onEgressDecision?: (d: {
    readonly target: string;
    readonly allowed: boolean;
    readonly reason: string;
  }) => void;
  /**
   * p22-worker-limits: the attempt must stay on the host network even in a Linux view with a private network namespace
   * — e.g. a job that may open preview links (the worker reaches its dev server on the host's loopback).
   */
  readonly hostNetwork?: boolean;
}

export interface SandboxLaunchRequest extends SandboxContext {
  readonly command: string;
  readonly args: readonly string[];
  /** Non-secret environment (e.g. `ResolvedJobEnv.publicEnv`). Nothing of the daemon env is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Secrets (e.g. `ResolvedJobEnv.secretEnv`), forwarded through the environment only. */
  readonly secretEnv?: SecretEnv;
  readonly stdin?: 'pipe' | 'ignore';
  readonly maxBufferBytes?: number;
}

/**
 * Starts runtime processes confined according to one ADR-0007 profile. The
 * returned `OwnedProcess` owns the whole confined tree; `dispose()` removes
 * everything the confinement created (container, network, proxy, profile files).
 */
export interface SandboxRunner {
  readonly profile: SandboxProfile;
  /** Implementation label, e.g. `container:docker`, `host-restricted:seatbelt`. */
  readonly kind: string;
  /**
   * A confiner for adapters that call `spawnOwnedProcess` themselves (each
   * `confine()` creates one confined process with its own resources).
   */
  confiner(ctx: SandboxContext): ProcessConfiner;
  /** `spawnOwnedProcess` + `confiner(req)`. */
  launch(req: SandboxLaunchRequest): Promise<OwnedProcess>;
}
