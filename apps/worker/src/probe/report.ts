import { HostFacts, RuntimeCapabilities, RuntimeKind, SandboxProfile } from '@remyral/protocol';
import { z } from 'zod';

/**
 * Output contract of `remyral-worker probe --json`. Bump `PROBE_SCHEMA_VERSION` on any
 * breaking change; saved probe reports are validated against it.
 * Reuses the protocol's HostFacts / RuntimeCapabilities so a probe result can be
 * turned into HELLO/CAPABILITIES payloads later without translation.
 */
export const PROBE_SCHEMA_VERSION = 1;

const ShortText = z.string().max(512);
const Path = z.string().max(1024);

export const ProblemSeverity = z.enum(['error', 'warning', 'info']);
export type ProblemSeverity = z.infer<typeof ProblemSeverity>;

export const Problem = z.object({
  code: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'dotted lower_snake code, e.g. host.node_too_old'),
  severity: ProblemSeverity,
  message: ShortText,
});
export type Problem = z.infer<typeof Problem>;

export const HostSection = z.object({
  /** `null` when the platform cannot be expressed as protocol HostFacts (unsupported OS/arch). */
  facts: HostFacts.nullable(),
  raw: z.object({
    platform: z.string().max(32),
    arch: z.string().max(32),
    machine: z.string().max(64),
    release: z.string().max(128),
    nodeVersion: z.string().max(32),
    /** e.g. "Raspberry Pi 5 Model B Rev 1.0" from /proc/device-tree/model (Linux only). */
    hardwareModel: z.string().max(128).optional(),
    /** Directory whose filesystem `diskFreeBytes` describes. */
    diskPath: Path,
  }),
});
export type HostSection = z.infer<typeof HostSection>;

export const ToolName = z.enum(['git', 'docker', 'podman', 'python', 'node', 'bubblewrap', 'wsl', 'uv']);
export type ToolName = z.infer<typeof ToolName>;

export const ToolReport = z.object({
  name: ToolName,
  found: z.boolean(),
  path: Path.optional(),
  version: z.string().max(64).optional(),
  /** Small, non-secret facts: e.g. daemonReachable, rootless, command. */
  details: z.record(z.string().max(64), z.union([z.string().max(256), z.boolean(), z.null()])).optional(),
});
export type ToolReport = z.infer<typeof ToolReport>;

export const PinStatus = z.enum(['match', 'mismatch', 'unknown', 'not-installed']);
export type PinStatus = z.infer<typeof PinStatus>;

export const SelfTestCheck = z.object({
  name: z.string().max(128),
  ok: z.boolean(),
  detail: ShortText.optional(),
});

export const SelfTestResult = z.object({
  kind: z.enum(['server-auth', 'cli-help']),
  status: z.enum(['passed', 'failed', 'skipped']),
  durationMs: z.number().int().min(0),
  checks: z.array(SelfTestCheck).max(32),
});
export type SelfTestResult = z.infer<typeof SelfTestResult>;

export const RuntimeReport = z.object({
  runtime: RuntimeKind,
  /** Protocol-shaped record (ADR-0008); what CAPABILITIES will carry later. */
  capabilities: RuntimeCapabilities,
  binaryPath: Path.nullable(),
  pin: z.string().max(64),
  pinStatus: PinStatus,
  notes: z.array(ShortText).max(32),
  selfTest: SelfTestResult.optional(),
});
export type RuntimeReport = z.infer<typeof RuntimeReport>;

export const SandboxProfileReport = z.object({
  profile: SandboxProfile,
  /** The host has what the profile needs. */
  available: z.boolean(),
  /** Available *and* fully configured (e.g. dedicated OS user exists). */
  ready: z.boolean(),
  runtimes: z.array(RuntimeKind).max(8).optional(),
  notes: z.array(ShortText).max(16),
});
export type SandboxProfileReport = z.infer<typeof SandboxProfileReport>;

export const ProbeReport = z.object({
  schemaVersion: z.literal(PROBE_SCHEMA_VERSION),
  probedAt: z.iso.datetime({ precision: 3 }),
  probe: z.object({
    workerVersion: z.string().max(64),
    durationMs: z.number().int().min(0),
    selfTest: z.boolean(),
    runtimeFilter: RuntimeKind.nullable(),
  }),
  host: HostSection,
  tools: z.array(ToolReport).max(32),
  runtimes: z.array(RuntimeReport).max(8),
  sandboxProfiles: z.array(SandboxProfileReport).max(8),
  problems: z.array(Problem).max(256),
});
export type ProbeReport = z.infer<typeof ProbeReport>;
