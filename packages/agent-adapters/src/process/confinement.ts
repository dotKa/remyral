import type { ProcessTreeKiller } from './tree-killer.js';

/**
 * Spawner hook for execution sandboxes (ADR-0007, p3-sandbox).
 *
 * `spawnOwnedProcess` builds the runtime's command line and environment exactly
 * as without a sandbox; a `ProcessConfiner` then rewrites that plan into the
 * command that actually starts it confined (e.g. `docker run … <image> <cmd>`,
 * `sandbox-exec -f … <cmd>`, a Windows Job Object helper). The confiner may
 * supply its own tree killer (a container must be killed through the engine,
 * not by signalling the local client) and a `dispose` that removes everything
 * it created (container, network, proxy, temp files). Ownership semantics stay
 * those of `OwnedProcess`.
 *
 * Secrets: `plan.env` contains the revealed secret values (they must reach the
 * runtime). A confiner must forward them through the environment only — the
 * rewritten argv is checked again for secret values before spawning.
 */
export interface SpawnPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete child environment, secrets included. */
  readonly env: Readonly<Record<string, string>>;
  /** Names in `env` that carry secrets (so a confiner can forward them by name). */
  readonly secretNames: readonly string[];
}

export interface ConfinedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Replaces the default tree killer when the confinement needs its own (containers, Job Objects). */
  readonly treeKiller?: ProcessTreeKiller;
  /**
   * Removes what the confinement created. Called by `OwnedProcess.dispose()`;
   * must be idempotent and must not throw when there is nothing left to remove.
   */
  readonly dispose?: () => Promise<void>;
}

export interface ProcessConfiner {
  /** Short label for logs/audit, e.g. `container:docker`, `host-restricted:seatbelt`. */
  readonly kind: string;
  confine(plan: SpawnPlan): Promise<ConfinedSpawn>;
}
