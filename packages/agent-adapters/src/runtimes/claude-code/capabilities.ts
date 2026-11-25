import {
  applyVersionGate,
  defineCapabilitySet,
  type AdapterCapability,
  type CapabilityEntry,
  type CapabilityKey,
  type CapabilitySet,
} from '../../capabilities.js';
import { resumeCapability } from '../../resume-verification.js';
import { CLAUDE_AGENT_SDK_PIN, CLAUDE_CODE_CLI_PIN } from './pins.js';

const LIVE_PENDING =
  'adapter mapping contract-tested against fakes built from the pinned SDK 0.3.310 typings (2026-10-26); ' +
  'live run against a model pending (REMYRAL_LIVE_RUNTIMES=1)';

/**
 * Truthful Claude Code capability set (ADR-0008). Nothing is `supported`
 * until the live contract run passes on the exact tuple; credential-free
 * evidence (real-binary smoke tests) can only lift `cancel` to `degraded`.
 */
const BASE: Partial<Record<AdapterCapability, CapabilityEntry>> = {
  streaming: { status: 'unverified', reason: LIVE_PENDING },
  interactive_prompt: { status: 'unverified', reason: LIVE_PENDING },
  approval: { status: 'unverified', reason: `canUseTool bridge: ${LIVE_PENDING}` },
  cancel: { status: 'unverified', reason: LIVE_PENDING },
  resume: { status: 'unverified', reason: `same worker only (options.resume); ${LIVE_PENDING}` },
  cost_reporting: { status: 'unverified', reason: `total_cost_usd/modelUsage mapping: ${LIVE_PENDING}` },
  artifacts: {
    status: 'unsupported',
    reason: 'no artifact API in the SDK; the worker collects the git diff of the worktree (compat §5)',
  },
  safe_cancel: {
    status: 'unverified',
    reason:
      'the CLI process group is reaped by the worker; tool subprocesses that leave the group are contained only by p3-sandbox; live tool run pending',
  },
};

/** Tuples on which the credential-free smoke suite ran (test/runtimes/claude-code/smoke.test.ts). */
const SMOKE_VERIFIED: Readonly<Record<string, Partial<Record<AdapterCapability, CapabilityEntry>>>> = {
  'darwin-arm64': {
    cancel: {
      status: 'degraded',
      reason:
        'verified 2026-10-13 on darwin arm64: cancel ends the session and kills the CLI process tree; graceful interrupt() of a running turn not yet verified live',
    },
  },
};

/**
 * p17-runtime-verify (ADR-0012 amendment 2026-10-27): what this adapter declares once a capability passed its live
 * verification scenario on an exact (version, OS, arch) — the ceiling a passed check can lift `unverified` to. Never
 * consulted without master-side evidence; `unsupported` stays unsupported.
 */
export const CLAUDE_CODE_DECLARED_CAPABILITIES: Readonly<Record<AdapterCapability, CapabilityEntry>> = {
  streaming: { status: 'supported', reason: 'SDK message stream mapped to sequenced events' },
  interactive_prompt: {
    status: 'supported',
    reason: 'follow-ups queued into the running query (streaming input)',
  },
  approval: {
    status: 'supported',
    reason: 'canUseTool bridge: every sensitive tool call waits for a decision',
  },
  cancel: {
    status: 'supported',
    reason: 'interrupt(), then the CLI process tree is killed after the grace period',
  },
  resume: { status: 'degraded', reason: 'same worker only (options.resume on the kept session)' },
  cost_reporting: {
    status: 'degraded',
    reason: "total_cost_usd is the CLI's own estimate (secret-ref); tokens only under local-login",
  },
  artifacts: BASE.artifacts ?? { status: 'unsupported', reason: 'no artifact API in the SDK' },
  safe_cancel: {
    status: 'degraded',
    reason:
      'the CLI process group is reaped by the worker; tool subprocesses that leave the group are contained only by the sandbox',
  },
};

/** p17-runtime-verify: bump when the adapter's mapping changes — evidence of an older revision then expires. */
export const CLAUDE_CODE_ADAPTER_REVISION = `claude-code-adapter/1+sdk${CLAUDE_AGENT_SDK_PIN}`;

export function claudeCodeCapabilities(key: CapabilityKey): CapabilitySet {
  const tuple = `${key.os}-${key.arch}`;
  // p11-session-continuity: `resume` is supported only for a version whose native resume was verified live.
  const resume = resumeCapability(
    'claude-code',
    key.version,
    BASE.resume ?? { status: 'unverified', reason: LIVE_PENDING },
  );
  const set = defineCapabilitySet(key, { ...BASE, ...SMOKE_VERIFIED[tuple], resume });
  return applyVersionGate(set, CLAUDE_CODE_CLI_PIN);
}
