import { type OpsOperation, verifyMcpSpec } from '@remyral/protocol';
import type { McpInstallOutcome } from '../remote-ops/agent.js';
import { McpInstallError, type McpInstaller } from './install.js';

/**
 * p14-mcp-stdio: the worker side of `mcp.install` / `mcp.remove`. The spec is verified with this worker's own skills
 * keys (signature context `remana-mcp/v1`) before anything is fetched; local vetoes (`localCeiling.allowMcp`,
 * `allowMcpStdio`) refuse; the installer enforces the rest (no install scripts unless approved exactly, hashes before
 * unpacking, the spec's name / version / integrity, size, read-only tree).
 */

export interface McpInstallOpDeps {
  readonly installer: Pick<McpInstaller, 'install' | 'remove'>;
  readonly keys: () => readonly string[] | null;
  /** Why installs are refused here now (null: allowed) — the local vetoes. */
  readonly refusal: () => string | null;
}

/** Install errors that are a refusal (the worker did not try / the input is wrong), not a failure. */
const REFUSALS = new Set([
  'busy',
  'invalid_spec',
  'npm_unavailable',
  'uv_unavailable',
  'insufficient_space',
  'lock_invalid',
  'lock_mismatch',
  'lock_too_large',
  'integrity_mismatch',
  'install_scripts_required',
  'platform_unsupported',
]);

export function mcpInstallPort(d: McpInstallOpDeps) {
  return {
    async install(
      op: Extract<OpsOperation, { kind: 'mcp.install' }>,
      opts: { readonly signal: AbortSignal; readonly progress: (step: string) => void },
    ): Promise<McpInstallOutcome> {
      const vetoed = d.refusal();
      if (vetoed !== null) return { state: 'refused', reason: 'mcp_vetoed', detail: vetoed };
      const v = verifyMcpSpec(op.server, d.keys() ?? []);
      if (!v.ok) {
        return {
          state: 'refused',
          reason: 'mcp_verification_failed',
          detail: `${v.reason}${v.detail === undefined ? '' : ` (${v.detail.slice(0, 200)})`}`,
        };
      }
      if (v.spec.transport !== 'stdio') {
        return { state: 'refused', reason: 'invalid_spec', detail: 'only stdio servers are installed' };
      }
      try {
        const report = await d.installer.install(v.spec, v.specSha256, op.lock, {
          ...opts,
          // p19-install-scripts: the approvals the master sent (absent from an older master: scripts are refused).
          ...(op.installScripts === undefined ? {} : { installScripts: op.installScripts }),
        });
        return {
          state: 'succeeded',
          report,
          detail: `installed ${v.spec.id}@${v.spec.version} (${report.digest.slice(0, 19)}…)`,
        };
      } catch (err) {
        if (err instanceof McpInstallError) {
          if (err.reason === 'cancelled')
            return { state: 'cancelled', reason: 'cancelled', detail: 'cancelled' };
          return {
            state: REFUSALS.has(err.reason) ? 'refused' : 'failed',
            reason: err.reason,
            detail: err.message,
          };
        }
        return {
          state: 'failed',
          reason: 'internal',
          detail: 'unexpected error on the worker (see its log)',
        };
      }
    },
    async remove(op: Extract<OpsOperation, { kind: 'mcp.remove' }>): Promise<McpInstallOutcome> {
      try {
        const had = await d.installer.remove(op.id, op.version);
        return {
          state: 'succeeded',
          detail: had ? `removed ${op.id}@${op.version}` : `${op.id}@${op.version} was not installed`,
        };
      } catch (err) {
        if (err instanceof McpInstallError)
          return { state: 'refused', reason: err.reason, detail: err.message };
        return {
          state: 'failed',
          reason: 'internal',
          detail: 'unexpected error on the worker (see its log)',
        };
      }
    },
  };
}
