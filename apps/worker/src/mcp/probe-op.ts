import {
  mcpReferencedSlots,
  mcpSecretEnvName,
  mcpSecretValueProblem,
  type McpProbeReport,
  type McpSpec,
  mcpSpecEgressHosts,
  type OpsOperation,
  verifyMcpSpec,
} from '@remyral/protocol';
import { localSecretName, parseSecretRef, SecretString } from '../secrets/ref.js';
import type { SecretStore } from '../secrets/store.js';
import type { McpInstaller, McpServerExec } from './install.js';
import { mcpServerEnv } from './launcher.js';
import {
  McpProbeError,
  type McpProbeDeps,
  probeMcpServer,
  probeStdioServer,
  type StdioProbeProcess,
} from './probe.js';

/**
 * p14-mcp-core: the worker side of the `mcp.probe` remote op. The spec is verified with this worker's own skills keys
 * (signature context `remana-mcp/v1`), the secret slots are read from this worker's store (vault credentials), and
 * only then the server's URL is contacted. Values are never reported or logged.
 *
 * p14-mcp-stdio: a stdio server is probed only from its intact install of exactly this spec (never downloaded for
 * the probe), started through the job launcher inside the worker's host sandbox with only its declared hosts.
 */

export type McpProbeOutcome =
  | { readonly state: 'succeeded'; readonly report: McpProbeReport }
  | { readonly state: 'refused' | 'failed'; readonly reason: string; readonly detail: string };

/** Starts one installed stdio server for a probe (sandboxed; stop() removes everything it created). */
export type StdioProbeStarter = (input: {
  readonly spec: McpSpec;
  readonly exec: McpServerExec;
  readonly env: Readonly<Record<string, string>>;
  readonly egressHosts: readonly string[];
}) => Promise<StdioProbeProcess>;

export interface McpProbeOpDeps extends McpProbeDeps {
  /** The skills keys the spec must verify with (local offline keys + panel keys unless vetoed). */
  readonly keys: () => readonly string[] | null;
  readonly store: Pick<SecretStore, 'get'>;
  readonly workerId: string | null;
  /** `localCeiling.allowMcp` (false: refused). */
  readonly allowMcp: boolean;
  /** p14-mcp-stdio (absent: stdio servers are refused `mcp_stdio_unsupported`). */
  readonly stdio?: {
    readonly installer: Pick<McpInstaller, 'ready'>;
    readonly start: StdioProbeStarter;
  };
}

export async function runMcpProbe(
  op: Extract<OpsOperation, { kind: 'mcp.probe' }>,
  deps: McpProbeOpDeps,
): Promise<McpProbeOutcome> {
  const refuse = (reason: string, detail: string): McpProbeOutcome => ({ state: 'refused', reason, detail });
  if (!deps.allowMcp)
    return refuse('mcp_vetoed', 'this machine refuses external MCP servers (localCeiling.allowMcp: false)');
  const keys = deps.keys() ?? [];
  const v = verifyMcpSpec(op.server, keys);
  if (!v.ok)
    return refuse(
      'mcp_verification_failed',
      `${v.reason}${v.detail === undefined ? '' : ` (${v.detail.slice(0, 200)})`}`,
    );
  if (v.spec.transport === 'stdio' && deps.stdio === undefined)
    return refuse('mcp_stdio_unsupported', 'this worker runs no local (stdio) MCP servers');
  const secrets: Record<string, string> = {};
  for (const slot of mcpReferencedSlots(v.spec)) {
    const ref = op.secrets.find((s) => s.slot === slot)?.ref;
    if (ref === undefined) return refuse('mcp_secret_missing', `secret slot ${slot} is not bound`);
    let value;
    try {
      value = await deps.store.get(localSecretName(parseSecretRef(ref), deps.workerId, ref));
    } catch {
      value = null;
    }
    if (value === null)
      return refuse('mcp_secret_missing', `the secret for slot ${slot} is not on this machine`);
    const problem = mcpSecretValueProblem(value.reveal());
    if (problem !== null) return refuse('mcp_secret_invalid', `slot ${slot}: ${problem}`);
    secrets[slot] = value.reveal();
  }
  const redact = (text: string): string => {
    let detail = text;
    for (const value of Object.values(secrets)) detail = detail.split(value).join('[REDACTED]');
    return detail.slice(0, 300);
  };
  try {
    if (v.spec.transport === 'stdio') {
      const stdio = deps.stdio;
      if (stdio === undefined) return refuse('mcp_stdio_unsupported', 'no stdio support');
      const ready = await stdio.installer.ready(v.spec, v.specSha256);
      if (!ready.ok) return refuse(`mcp_${ready.code}`, ready.message);
      const secretEnv: Record<string, SecretString> = {};
      for (const [slot, value] of Object.entries(secrets)) {
        secretEnv[mcpSecretEnvName(v.spec.id, slot)] = new SecretString(value);
      }
      const env = mcpServerEnv(v.spec, secretEnv);
      const spec = v.spec;
      const report = await probeStdioServer(
        () => stdio.start({ spec, exec: ready.exec, env, egressHosts: mcpSpecEgressHosts(spec) }),
        deps,
      );
      return { state: 'succeeded', report };
    }
    return { state: 'succeeded', report: await probeMcpServer(v.spec, secrets, deps) };
  } catch (err) {
    if (err instanceof McpProbeError) {
      // A server may echo a header or env value back in its error text: never report a secret value.
      return { state: 'failed', reason: err.reason, detail: redact(err.message) };
    }
    return { state: 'failed', reason: 'internal', detail: 'unexpected error on the worker (see its log)' };
  }
}
