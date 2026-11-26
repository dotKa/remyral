import type { RuntimeKind } from './common.js';

/**
 * Runtime version pins — the single source in code (p5-runtime-policy-ui: moved here from
 * apps/worker/src/runtimes/pins.ts so the master's policy template uses exactly the worker's pins).
 *
 * Source of truth: docs/adr/0012-runtime-integration-surfaces.md (Decision table) and
 * docs/compat/README.md §1. Change a pin only together with an ADR-0012 update and a
 * re-run of the compat checklist; a reported version that differs from the pin makes
 * every capability `unverified` (ADR-0008, ADR-0012 rule 1).
 */
export interface RuntimePin {
  /** Version the runtime itself reports (what the probe compares). */
  version: string;
  /** What gets installed for this pin. */
  install: string;
  /** Executable the probe looks for. */
  binary: string;
  /** Exact command whose output carries the version (from docs/compat/<runtime>.md). */
  versionCommand: string;
  /**
   * p16-runtime-updates: the npm package the worker installs for this runtime (the install set's root) and its pinned
   * version. Claude Code installs the agent SDK, whose own version line differs from the CLI's (`0.3.296` bundles CLI
   * `2.1.296`); for the other runtimes both are the runtime's version.
   */
  package: string;
  packageVersion: string;
}

export const RUNTIME_PINS: Readonly<Record<RuntimeKind, RuntimePin>> = {
  'claude-code': {
    // The adapter uses @anthropic-ai/claude-agent-sdk@0.3.310, which bundles CLI 2.1.310.
    // A standalone `claude` on PATH is compared against that bundled CLI version.
    version: '2.1.310',
    install: 'npm: @anthropic-ai/claude-agent-sdk@0.3.310 (bundles Claude Code CLI 2.1.310)',
    binary: 'claude',
    versionCommand: 'claude --version',
    package: '@anthropic-ai/claude-agent-sdk',
    packageVersion: '0.3.310',
  },
  codex: {
    version: '0.164.0',
    install: 'npm: @openai/codex@0.164.0',
    binary: 'codex',
    versionCommand: 'codex --version',
    package: '@openai/codex',
    packageVersion: '0.164.0',
  },
  pi: {
    version: '1.6.0',
    install: 'npm: @earendil-works/pi-coding-agent@1.6.0',
    binary: 'pi',
    versionCommand: 'pi --version',
    package: '@earendil-works/pi-coding-agent',
    packageVersion: '1.6.0',
  },
  opencode: {
    version: '1.19.4',
    install: 'npm: opencode-ai@1.19.4',
    binary: 'opencode',
    versionCommand: 'opencode --version',
    package: 'opencode-ai',
    packageVersion: '1.19.4',
  },
};

/**
 * p17-update-channel (ADR-0065 §8): every runtime version that was a worker release pin (packages/protocol history),
 * newest last. A stored policy rule whose version is one of these (or a catalog version) followed the pin when it was
 * saved and becomes `follow`; any other version was a deliberate choice and becomes `hold`.
 */
export const RELEASE_PIN_HISTORY: Readonly<Record<RuntimeKind, readonly string[]>> = {
  'claude-code': ['2.1.296', '2.1.310'],
  codex: ['0.162.1', '0.164.0'],
  pi: ['1.1.0', '1.4.0', '1.6.0'],
  opencode: ['1.19.0', '1.19.4'],
};

/**
 * p16-runtime-updates: the package version that brings runtime `version` (what the runtime itself reports). Claude Code:
 * the agent SDK of the pinned SDK line whose patch is the CLI's patch (`2.1.309` → `0.3.309`; the master confirms it with
 * the SDK's `claudeCodeVersion` before anything is installed); the others: the version itself. Null when the version is
 * not on the pinned line (another major / minor of the Claude Code CLI).
 */
export function runtimePackageVersion(runtime: RuntimeKind, version: string): string | null {
  const pin = RUNTIME_PINS[runtime];
  if (runtime !== 'claude-code') return version;
  const cli = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const pinned = /^(\d+)\.(\d+)\.(\d+)$/.exec(pin.version);
  const sdk = /^(\d+)\.(\d+)\.\d+$/.exec(pin.packageVersion);
  if (cli === null || pinned === null || sdk === null) return null;
  if (cli[1] !== pinned[1] || cli[2] !== pinned[2]) return null;
  return `${sdk[1] ?? '0'}.${sdk[2] ?? '0'}.${cli[3] ?? '0'}`;
}
