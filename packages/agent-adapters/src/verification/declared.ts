import type { RuntimeKind } from '@remyral/protocol';
import { ADAPTER_CAPABILITIES, type AdapterCapability, type CapabilityEntry } from '../capabilities.js';
import {
  CLAUDE_CODE_ADAPTER_REVISION,
  CLAUDE_CODE_DECLARED_CAPABILITIES,
} from '../runtimes/claude-code/capabilities.js';
import { CODEX_ADAPTER_REVISION, CODEX_DECLARED_CAPABILITIES } from '../runtimes/codex/capabilities.js';
import {
  OPENCODE_ADAPTER_REVISION,
  OPENCODE_TESTED_CAPABILITIES,
} from '../runtimes/opencode/capabilities.js';
import { PI_ADAPTER_REVISION, PI_TESTED_CAPABILITIES } from '../runtimes/pi/capabilities.js';

/**
 * p17-runtime-verify: per runtime, the adapter's declared capability table — the status each capability has once its
 * verification scenario passed on an exact (version, OS, arch). Pi and OpenCode: the table the scripted-provider
 * contract kit established on darwin-arm64 (`*_TESTED_CAPABILITIES`); Claude Code and Codex: what their live run would
 * establish (`*_DECLARED_CAPABILITIES`). Master-side evidence lifts `unverified` at most to this, never above
 * (`overlayCapabilityStatus` in the protocol).
 */
const DECLARED: Readonly<Record<RuntimeKind, Readonly<Record<AdapterCapability, CapabilityEntry>>>> = {
  'claude-code': CLAUDE_CODE_DECLARED_CAPABILITIES,
  codex: CODEX_DECLARED_CAPABILITIES,
  pi: PI_TESTED_CAPABILITIES,
  opencode: OPENCODE_TESTED_CAPABILITIES,
};

const REVISIONS: Readonly<Record<RuntimeKind, string>> = {
  'claude-code': CLAUDE_CODE_ADAPTER_REVISION,
  codex: CODEX_ADAPTER_REVISION,
  pi: PI_ADAPTER_REVISION,
  opencode: OPENCODE_ADAPTER_REVISION,
};

export function declaredCapabilities(
  runtime: RuntimeKind,
): Readonly<Record<AdapterCapability, CapabilityEntry>> {
  return DECLARED[runtime];
}

/** Status only (CAPABILITIES `verification.declared`, evidence `declared`). */
export function declaredStatuses(runtime: RuntimeKind): Record<AdapterCapability, CapabilityEntry['status']> {
  const out = {} as Record<AdapterCapability, CapabilityEntry['status']>;
  for (const cap of ADAPTER_CAPABILITIES) out[cap] = DECLARED[runtime][cap].status;
  return out;
}

/** The adapter revision evidence is bound to (a new revision expires older evidence). */
export function adapterRevision(runtime: RuntimeKind): string {
  return REVISIONS[runtime];
}
