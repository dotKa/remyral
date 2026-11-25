import {
  approvalScript,
  basicScript,
  FakeRuntimeAdapter,
  longRunningScript,
  type FakeAdapterOptions,
  type FakeScript,
} from '../src/index.js';
import { defineAdapterContractSuite, type ContractScenario } from '../src/testing/index.js';

const scripts: Record<ContractScenario, FakeScript> = {
  basic: basicScript,
  'long-running': longRunningScript,
  approval: approvalScript,
};

const fake = (opts: FakeAdapterOptions) => (scenario: ContractScenario) =>
  new FakeRuntimeAdapter({ ...opts, script: scripts[scenario] });

// Full-featured runtime (Claude Code / Codex app-server shape).
defineAdapterContractSuite('fake (all capabilities)', fake({}));

// Pi-like: no native approvals, cost is an estimate, cancel only via kill after grace.
defineAdapterContractSuite(
  'fake (no approval, slow forced cancel, estimated cost)',
  fake({
    runtime: 'pi',
    capabilities: {
      approval: { status: 'unsupported', reason: 'no native approvals; worker extension not loaded' },
      cancel: { status: 'degraded', reason: 'cancel = process tree kill after grace' },
    },
    cancel: { gracefulDelayMs: 5_000 },
    costProvenance: 'estimated-from-tokens',
  }),
);

// exec-style fallback: single-shot, no follow-ups, no resume, no cost.
defineAdapterContractSuite(
  'fake (minimal: no interactive prompt, resume or cost)',
  fake({
    runtime: 'codex',
    capabilities: {
      interactive_prompt: { status: 'unsupported', reason: 'exec mode is one prompt per process' },
      approval: { status: 'unsupported', reason: 'exec rejects approval requests' },
      resume: { status: 'unsupported', reason: 'resume not wired in exec mode' },
      cost_reporting: { status: 'unsupported', reason: 'no usage events in this mode' },
    },
  }),
);

// Version drift: everything unverified, but policy allows unverified (ADR-0012 rule 1).
defineAdapterContractSuite(
  'fake (version differs from pin, policy allows unverified)',
  fake({ runtime: 'opencode', version: '1.20.0', pinnedVersion: '1.19.0' }),
  { makeContext: (base) => ({ ...base, allowUnverified: true }) },
);
