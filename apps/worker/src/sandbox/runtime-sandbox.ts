import type { OwnedProcess, ProcessConfiner } from '@remyral/agent-adapters';
import type { RuntimeKind } from '@remyral/protocol';
import type { NamespaceCheck } from '../probe/bwrap.js';
import { SandboxRequestError, SandboxUnavailableError } from './errors.js';
import type { HostRestrictedRunner } from './host/runner.js';
import type { ProfileCapability } from './policy.js';
import type { SandboxContext, SandboxLaunchRequest, SandboxRunner } from './types.js';

/**
 * ADR-0007 `runtime-sandbox`: the runtime's own sandbox, configured by us, layered
 * on the host-restricted baseline — never instead of it, never weaker than it.
 *
 * Config surfaces (verified against the pinned releases):
 *  - Codex 0.162.1 app-server: `thread/start.sandbox` ∈ {read-only, workspace-write,
 *    danger-full-access}; per turn `sandboxPolicy` = `{type:"workspaceWrite",
 *    writableRoots, networkAccess:boolean, excludeSlashTmp, excludeTmpdirEnvVar}` or
 *    `{type:"externalSandbox", networkAccess:"restricted"|"enabled"}` (schema
 *    generated from the pinned binary, 2026-10-13). `codex exec`: `--sandbox` and
 *    `-c sandbox_workspace_write.*` keys (docs/compat/codex.md §2–3).
 *  - Claude Agent SDK 0.3.296 `options.sandbox` (`SandboxSettings` in sdk.d.ts):
 *    enabled, failIfUnavailable, autoAllowBashIfSandboxed, allowUnsandboxedCommands,
 *    excludedCommands, network{allowedDomains, allowLocalBinding, allowUnixSockets,
 *    allowAllUnixSockets, httpProxyPort}, filesystem{allowWrite, denyWrite, denyRead},
 *    enableWeakerNestedSandbox. It sandboxes the Bash tool only; Read/Edit are
 *    gated by our `canUseTool` policy (p3-adapter-claude).
 *
 * Platform facts:
 *  - macOS: Seatbelt cannot nest (`sandbox_apply: Operation not permitted`,
 *    verified). Our host Seatbelt confines the *whole* runtime tree and the
 *    runtime's Seatbelt would fail inside it, so `runtime-sandbox` is not offered
 *    on macOS — `host-restricted` is strictly stronger there.
 *  - Linux/Pi host and Windows: the host baseline has no per-attempt filesystem
 *    confinement, so the runtime sandbox (bwrap / Windows sandbox) adds to it.
 *  - Pi, OpenCode: no native sandbox (compat §4.6) — refused.
 */

export interface CodexSandboxConfig {
  /** `thread/start` → `sandbox`. */
  readonly threadSandbox: 'workspace-write';
  /** `turn/start` → `sandboxPolicy`. */
  readonly turnSandboxPolicy:
    | {
        readonly type: 'workspaceWrite';
        readonly writableRoots: readonly string[];
        readonly networkAccess: false;
        readonly excludeSlashTmp: true;
        readonly excludeTmpdirEnvVar: boolean;
      }
    | { readonly type: 'externalSandbox'; readonly networkAccess: 'restricted' };
  /** Equivalent `codex exec` flags. */
  readonly execArgs: readonly string[];
}

/**
 * Codex sandbox for a job. Tool commands never get network (`networkAccess:false`;
 * the model API is called by Codex itself, outside the tool sandbox). `/tmp` is
 * excluded; `$TMPDIR` is the attempt's private tmp under the sandbox dir and stays
 * writable. Inside our container the container is the boundary: `externalSandbox`.
 */
export function codexSandboxConfig(opts: {
  inContainer: boolean;
  extraWritableRoots?: readonly string[];
}): CodexSandboxConfig {
  if (opts.inContainer) {
    return {
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
      execArgs: ['--sandbox', 'workspace-write'],
    };
  }
  const roots = [...(opts.extraWritableRoots ?? [])];
  return {
    threadSandbox: 'workspace-write',
    turnSandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: roots,
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    },
    execArgs: [
      '--sandbox',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=false',
      '-c',
      'sandbox_workspace_write.exclude_slash_tmp=true',
    ],
  };
}

/** Subset of the Claude Agent SDK `SandboxSettings` we set (shape of sdk.d.ts 0.3.296). */
export interface ClaudeSandboxSettings {
  readonly enabled: true;
  readonly failIfUnavailable: true;
  readonly autoAllowBashIfSandboxed: false;
  readonly allowUnsandboxedCommands: false;
  readonly excludedCommands: readonly string[];
  readonly enableWeakerNestedSandbox: false;
  readonly network: {
    readonly allowedDomains: readonly string[];
    readonly allowLocalBinding: boolean;
    readonly allowUnixSockets: readonly string[];
    readonly allowAllUnixSockets: false;
    readonly httpProxyPort?: number;
  };
  readonly filesystem: {
    readonly allowWrite: readonly string[];
    readonly denyWrite: readonly string[];
    readonly denyRead: readonly string[];
  };
}

/**
 * Claude Code sandbox settings for a job: always on, fail if unavailable, no
 * unsandboxed escape hatch, Bash commands still go through our approval policy
 * (`autoAllowBashIfSandboxed: false`), no tool network (`allowedDomains: []`),
 * writes only to the attempt worktree + its tmp, reads of protected paths denied.
 */
export function claudeSandboxSettings(opts: {
  workspace: string;
  tmpDir: string;
  denyRead: readonly string[];
  denyWrite?: readonly string[];
  allowLocalBinding?: boolean;
  /** p6-warm-caches (ADR-0029): the project's shared package cache dir(s). */
  extraWrite?: readonly string[];
}): ClaudeSandboxSettings {
  return {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    enableWeakerNestedSandbox: false,
    network: {
      allowedDomains: [],
      allowLocalBinding: opts.allowLocalBinding ?? false,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
    },
    filesystem: {
      allowWrite: [opts.workspace, opts.tmpDir, ...(opts.extraWrite ?? [])],
      denyWrite: [`${opts.workspace}/.git`, ...(opts.denyWrite ?? [])],
      denyRead: [...opts.denyRead],
    },
  };
}

/** Refuses any runtime sandbox config weaker than our minimum (tests + adapter wiring). */
export function assertRuntimeSandboxNotWeaker(runtime: RuntimeKind, cfg: unknown): void {
  const fail = (why: string): never => {
    throw new SandboxRequestError(`${runtime}.sandbox`, `weaker than the host-restricted minimum: ${why}`);
  };
  if (typeof cfg !== 'object' || cfg === null) fail('missing');
  const c = cfg as Record<string, unknown>;
  if (runtime === 'claude-code') {
    if (c.enabled !== true) fail('enabled must be true');
    if (c.failIfUnavailable !== true) fail('failIfUnavailable must be true');
    if (c.allowUnsandboxedCommands !== false) fail('allowUnsandboxedCommands must be false');
    if (c.autoAllowBashIfSandboxed !== false) fail('autoAllowBashIfSandboxed must be false');
    if (c.enableWeakerNestedSandbox === true) fail('enableWeakerNestedSandbox');
    if (!Array.isArray(c.excludedCommands) || c.excludedCommands.length > 0)
      fail('excludedCommands must be empty');
    const net = c.network as Record<string, unknown> | undefined;
    if (!Array.isArray(net?.allowedDomains) || net.allowedDomains.length > 0)
      fail('tool network must be off');
    if (net?.allowAllUnixSockets === true) fail('allowAllUnixSockets');
    const fs = c.filesystem as Record<string, unknown> | undefined;
    if (!Array.isArray(fs?.denyRead) || fs.denyRead.length === 0)
      fail('denyRead must list the protected paths');
    return;
  }
  if (runtime === 'codex') {
    const p = c.turnSandboxPolicy as Record<string, unknown> | undefined;
    if (c.threadSandbox !== 'workspace-write') fail('thread sandbox must be workspace-write');
    if (p?.type === 'workspaceWrite') {
      if (p.networkAccess !== false) fail('networkAccess must be false');
      if (p.excludeSlashTmp !== true) fail('/tmp must be excluded');
      return;
    }
    if (p?.type === 'externalSandbox') {
      if (p.networkAccess !== 'restricted') fail('networkAccess must be restricted');
      return;
    }
    fail(`policy type ${String(p?.type)}`);
  }
  fail('runtime has no native sandbox');
}

/** Whether `runtime` has a native sandbox we can layer on this platform's host baseline. */
export function runtimeSandboxSupport(
  runtime: RuntimeKind,
  platform: NodeJS.Platform,
  /** Linux: result of the real bwrap namespace check (probe/bwrap.ts); absent = not checked (tests). */
  namespaces?: NamespaceCheck,
): ProfileCapability {
  if (platform === 'darwin') {
    return {
      ready: false,
      reasonCode: 'runtime_has_no_sandbox',
      reason:
        'on macOS the runtime Seatbelt cannot nest inside the host-restricted Seatbelt (sandbox_apply EPERM); host-restricted is strictly stronger',
      remedy: 'use the host-restricted profile on macOS',
    };
  }
  const bubblewrapRuntime = runtime === 'codex' || (runtime === 'claude-code' && platform === 'linux');
  if (bubblewrapRuntime && platform === 'linux' && namespaces !== undefined && namespaces.usable !== true) {
    // handson 2026-10-13 finding 2: bwrap present but unable to create namespaces must not be offered.
    return {
      ready: false,
      reasonCode: 'runtime_has_no_sandbox',
      reason: `${runtime} sandbox (bubblewrap) unusable: ${namespaces.detail}`,
      remedy:
        'run the worker on the host OS (not in a container), allow unprivileged user namespaces, or use the container profile',
    };
  }
  if (runtime === 'codex') return { ready: true };
  if (runtime === 'claude-code' && platform === 'linux') return { ready: true };
  return {
    ready: false,
    reasonCode: 'runtime_has_no_sandbox',
    reason: `${runtime} has no native sandbox on ${platform} (docs/compat/README.md §4.6)`,
    remedy: 'use host-restricted or container',
  };
}

/**
 * `runtime-sandbox` runner: exactly the host-restricted confinement (same OS user,
 * env, limits, egress handling); the adapter additionally passes the runtime
 * config from `codexSandboxConfig` / `claudeSandboxSettings`. On Linux it never runs inside the per-attempt
 * bubblewrap view of p19-linux-host-isolation (bubblewrap does not nest): its attempts keep running one at a time.
 */
export class RuntimeSandboxRunner implements SandboxRunner {
  readonly profile = 'runtime-sandbox' as const;
  readonly kind: string;

  constructor(
    private readonly host: HostRestrictedRunner,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly namespaces?: NamespaceCheck,
  ) {
    this.kind = `runtime-sandbox+${host.kind}`;
  }

  check(runtime: RuntimeKind): ProfileCapability {
    const base = this.host.check();
    if (!base.ready) return base;
    return runtimeSandboxSupport(runtime, this.platform, this.namespaces);
  }

  #require(ctx: SandboxContext): void {
    const runtime = ctx.runtime;
    const c = runtime === undefined ? { ready: false, reason: 'no runtime given' } : this.check(runtime);
    if (!c.ready) {
      throw new SandboxUnavailableError(
        'runtime-sandbox',
        c.reasonCode ?? 'runtime_has_no_sandbox',
        c.reason ?? 'unavailable',
        c.remedy ?? 'use host-restricted or container',
      );
    }
  }

  confiner(ctx: SandboxContext): ProcessConfiner {
    // p19-linux-host-isolation: the runtime's own bubblewrap cannot nest in the per-attempt view — no view here.
    const inner = this.host.confiner(ctx, { runtimeSandbox: true });
    return {
      kind: this.kind,
      confine: async (plan) => {
        this.#require(ctx);
        return inner.confine(plan);
      },
    };
  }

  async launch(req: SandboxLaunchRequest): Promise<OwnedProcess> {
    this.#require(req);
    return this.host.launch(req, { runtimeSandbox: true });
  }
}
