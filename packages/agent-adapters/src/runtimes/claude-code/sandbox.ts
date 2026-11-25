import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

/**
 * Subset of the SDK `SandboxSettings` we set for the `runtime-sandbox` profile.
 * Mirrors `claudeSandboxSettings` in apps/worker/src/sandbox/runtime-sandbox.ts
 * (p3-sandbox) — mirrored, not imported, because packages must not depend on
 * apps. A compile-time assignment keeps it a valid SDK 0.3.296 shape.
 */
// A type alias (not an interface): the SDK type is a loose object with an index signature.
export type ClaudeRuntimeSandbox = {
  readonly enabled: true;
  readonly failIfUnavailable: true;
  readonly autoAllowBashIfSandboxed: false;
  readonly allowUnsandboxedCommands: false;
  readonly excludedCommands: string[];
  readonly enableWeakerNestedSandbox: false;
  readonly network: {
    readonly allowedDomains: string[];
    readonly allowLocalBinding: boolean;
    readonly allowUnixSockets: string[];
    readonly allowAllUnixSockets: false;
  };
  readonly filesystem: {
    readonly allowWrite: string[];
    readonly denyWrite: string[];
    readonly denyRead: string[];
  };
};

// Compile-time proof that the mirror is a valid SDK 0.3.296 SandboxSettings.
export const _CLAUDE_SANDBOX_MATCHES_SDK: ClaudeRuntimeSandbox extends SandboxSettings ? true : never = true;

/** Credential locations no job may read by default (the worker can pass its own list). */
export function defaultDenyRead(home: string = homedir()): string[] {
  return ['.ssh', '.aws', '.gnupg', '.netrc', '.config/gh', '.docker/config.json', '.codex', '.claude'].map(
    (p) => join(home, p),
  );
}

/**
 * Bash sandbox for a job: always on, fail closed if unavailable, no
 * unsandboxed escape hatch, Bash still goes through our approval policy,
 * no tool network, writes only to the worktree (+ its tmp), `.git` read-only.
 */
export function claudeRuntimeSandbox(opts: {
  workspace: string;
  tmpDir?: string;
  denyRead?: readonly string[];
  /** p6-warm-caches: further writable dirs (the project's shared package cache). */
  extraWrite?: readonly string[];
  /** p8-preview-tunnels: the job's dev server may listen on localhost (only for jobs with previews). */
  allowLocalBinding?: boolean;
}): ClaudeRuntimeSandbox {
  const settings: ClaudeRuntimeSandbox = {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    excludedCommands: [],
    enableWeakerNestedSandbox: false,
    network: {
      allowedDomains: [],
      allowLocalBinding: opts.allowLocalBinding === true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
    },
    filesystem: {
      allowWrite: [
        opts.workspace,
        ...(opts.tmpDir === undefined ? [] : [opts.tmpDir]),
        ...(opts.extraWrite ?? []),
      ],
      denyWrite: [join(opts.workspace, '.git')],
      denyRead: [...(opts.denyRead ?? defaultDenyRead())],
    },
  };
  return settings;
}
