import type { Capability, CapabilityStatus, RuntimeKind } from '@remyral/protocol';

/**
 * Capability evidence from docs/compat/README.md §2 (pinned versions, chosen surface).
 * Levels: VL verified locally (macOS arm64) · VD verified from docs/source · U unverified ·
 * W provided by our worker · X known absent.
 *
 * None of this is a contract test on *this* worker, so per ADR-0008 the probe maps every
 * level except X to `unverified`; only p3 contract tests may ever produce `supported`.
 */
export type EvidenceLevel = 'VL' | 'VD' | 'U' | 'W' | 'X';

export interface MatrixCell {
  level: EvidenceLevel;
  note: string;
}

export const CAPABILITY_MATRIX: Readonly<Record<RuntimeKind, Readonly<Record<Capability, MatrixCell>>>> = {
  'claude-code': {
    streaming: { level: 'VL', note: 'Agent SDK query()' },
    interactive_prompt: { level: 'VL', note: 'streaming input' },
    approval: { level: 'VL', note: 'canUseTool' },
    cancel: { level: 'VL', note: 'interrupt(); safe cancel (tree reaped) U' },
    safe_cancel: {
      level: 'U',
      note: 'process-tree reaping untested; worker must own the tree (ADR-0012 rule 4)',
    },
    resume: { level: 'VL', note: 'same worker; other worker U' },
    cost_reporting: { level: 'VL', note: 'total_cost_usd (runtime estimate)' },
    artifacts: { level: 'W', note: 'worker collects git diff in the worktree' },
  },
  codex: {
    streaming: { level: 'VD', note: 'app-server notifications' },
    interactive_prompt: { level: 'VD', note: 'turn/start on a live thread' },
    approval: { level: 'VD', note: 'server requests' },
    cancel: { level: 'VD', note: 'turn/interrupt; safe cancel (tree reaped) U' },
    safe_cancel: {
      level: 'U',
      note: 'process-tree reaping untested; worker must own the tree (ADR-0012 rule 4)',
    },
    resume: { level: 'VD', note: 'thread/resume same worker; other worker U' },
    cost_reporting: { level: 'W', note: 'tokens only, no USD; worker estimates from tokens' },
    artifacts: { level: 'VD', note: 'turn/diff/updated' },
  },
  pi: {
    streaming: { level: 'VD', note: 'RPC message_update' },
    interactive_prompt: { level: 'VD', note: 'steer/follow_up' },
    approval: { level: 'W', note: 'native approval absent; worker permission-gate extension' },
    cancel: { level: 'VD', note: 'abort (VL idle only); safe cancel (tree reaped) U' },
    safe_cancel: {
      level: 'U',
      note: 'process-tree reaping untested; worker must own the tree (ADR-0012 rule 4)',
    },
    resume: { level: 'VD', note: 'session id; partly VL' },
    cost_reporting: { level: 'VD', note: 'Pi-computed estimate' },
    artifacts: { level: 'W', note: 'no artifact API; worker collects git diff' },
  },
  opencode: {
    streaming: { level: 'VL', note: 'SSE connect VL; run payloads U' },
    interactive_prompt: { level: 'VD', note: 'session prompt routes' },
    approval: { level: 'VD', note: '/permission' },
    cancel: { level: 'VL', note: 'idle VL, mid-run U; safe cancel (tree reaped) U' },
    safe_cancel: {
      level: 'U',
      note: 'process-tree reaping untested; worker must own the tree (ADR-0012 rule 4)',
    },
    resume: { level: 'VD', note: 'session routes' },
    cost_reporting: { level: 'VL', note: 'fields VL; accuracy U' },
    artifacts: { level: 'VL', note: 'diff endpoint VL; content U' },
  },
};

export interface NativeSandboxFact {
  available: boolean;
  note: string;
}

/**
 * Native OS sandbox per runtime and OS (docs/compat/README.md §2 "Native OS sandbox",
 * §4.6, ADR-0007). Feeds the `runtime-sandbox` profile. All of it is unverified on the
 * target nodes until p0-compat-handson / p7-sandbox-escape.
 */
export function nativeSandbox(runtime: RuntimeKind, platform: string): NativeSandboxFact {
  switch (runtime) {
    case 'codex':
      if (platform === 'darwin')
        return { available: true, note: 'Seatbelt (VL on macOS arm64); reads of ~/.ssh still allowed' };
      if (platform === 'linux')
        return {
          available: true,
          note: 'bubblewrap (VD); needs unprivileged user namespaces; WSL1 unsupported',
        };
      if (platform === 'win32')
        return {
          available: true,
          note: 'Windows sandbox backends (VD, untested); elevated setup is an admin action',
        };
      return { available: false, note: 'no sandbox on this OS' };
    case 'claude-code':
      if (platform === 'win32') return { available: false, note: 'no native sandbox on native Windows (VD)' };
      return { available: true, note: 'sandboxes Bash tool only (VD)' };
    case 'pi':
      return { available: false, note: 'no native sandbox (VD)' };
    case 'opencode':
      return { available: false, note: 'no native sandbox (VD)' };
  }
}

/** Platform caveats from docs/compat/README.md §3 that the operator should see. */
export function platformNotes(runtime: RuntimeKind, platform: string, arch: string): string[] {
  const notes: string[] = [];
  if (runtime === 'claude-code' && platform === 'win32')
    notes.push('no sandbox on native Windows: needs WSL2/container/host-restricted policy');
  if (runtime === 'codex' && platform === 'linux')
    notes.push('sandbox needs bwrap and unprivileged user namespaces');
  if (runtime === 'pi' && platform === 'win32')
    notes.push('native Windows needs Git Bash (Git for Windows) for the bash tool');
  if (runtime === 'opencode' && platform === 'win32')
    notes.push('upstream recommends WSL; native Windows UNVERIFIED');
  if (platform === 'linux' && arch === 'arm64' && (runtime === 'pi' || runtime === 'opencode'))
    notes.push('Linux arm64 (Raspberry Pi) UNVERIFIED for this runtime');
  return notes;
}

export function statusFor(level: EvidenceLevel): CapabilityStatus {
  return level === 'X' ? 'unsupported' : 'unverified';
}
