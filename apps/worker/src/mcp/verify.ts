import {
  type AssignedMcp,
  MAX_JOB_MCP_EGRESS_HOSTS,
  type McpPin,
  type McpSpec,
  type McpToolRule,
  mcpPolicySha256,
  mcpReferencedSlots,
  mcpSetHash,
  mcpSpecEgressHosts,
  type RuntimeKind,
  verifyMcpSpec,
} from '@remyral/protocol';
import type { McpServerExec } from './install.js';

/**
 * p14-mcp-core (ADR-0054, docs/design/p14-mcp-skills.md §2.4): the worker's own verification of the external MCP
 * servers that came with an ASSIGN_JOB — against the skills keys of **its** configuration (the `remana-mcp/v1`
 * signature context keeps a skill signature from being replayed as a spec), never against anything the master says.
 *
 * Fails closed: any bad signature, duplicate id, runtime mismatch, set-hash mismatch, missing secret reference,
 * untrusted source, stdio server without `mcp-stdio-v1` or a local veto refuses the whole job — the worker declines it before anything
 * is prepared. Every refusal message starts with a stable code (`mcp_…:`).
 */

/** One verified server of a job: the parsed spec, its tool rules and where each secret slot comes from. */
export interface VerifiedMcpServer {
  readonly spec: McpSpec;
  readonly specSha256: string;
  readonly rules: readonly McpToolRule[];
  /** slot → secret reference (`secret:vault-<id>`), one per slot the spec references. */
  readonly secrets: Readonly<Record<string, string>>;
  /** p14-mcp-stdio: the intact install of a stdio server (filled in at admission by the job runner). */
  readonly stdio?: { readonly dir: string; readonly exec: McpServerExec };
}

export interface VerifiedMcp {
  readonly servers: readonly VerifiedMcpServer[];
  readonly setHash: string;
  /** Hosts this attempt may additionally reach (URL hosts + declared hosts), sorted, ≤ 32. */
  readonly egressHosts: readonly string[];
}

export type McpCheck =
  { readonly ok: true; readonly mcp: VerifiedMcp | null } | { readonly ok: false; readonly message: string };

export interface McpVerifyOptions {
  /** `localCeiling.allowMcp` (false: every job carrying MCP is declined). */
  readonly allowMcp?: boolean;
  /** The job's `sourceTrust` (only `trusted` sources may get MCP; absent = untrusted, ADR-0010 rule 3). */
  readonly sourceTrust?: 'trusted' | 'untrusted' | undefined;
  /** The job pins a pull request head (always untrusted). */
  readonly pullRequest?: boolean;
  /** p14-mcp-stdio: this worker runs local (stdio) servers (`mcp-stdio-v1` on, an installer present). */
  readonly allowStdio?: boolean;
}

/** Stable decline codes (documented in docs/design/p14-mcp-skills.md §13). */
export const MCP_DECLINE = {
  vetoed: 'mcp_vetoed',
  untrusted: 'mcp_untrusted',
  noKeys: 'mcp_untrusted_keys',
  verification: 'mcp_verification_failed',
  stdio: 'mcp_stdio_unsupported',
  secretMissing: 'mcp_secret_missing',
  secretInvalid: 'mcp_secret_invalid',
  runtime: 'mcp_runtime_unsupported',
  notInstalled: 'mcp_not_installed',
  modified: 'mcp_install_modified',
} as const;

export function verifyAssignedMcp(
  assigned: AssignedMcp | undefined,
  runtime: RuntimeKind,
  keys: readonly string[] | null,
  opts: McpVerifyOptions = {},
): McpCheck {
  if (assigned === undefined) return { ok: true, mcp: null };
  const fail = (code: string, text: string): McpCheck => ({ ok: false, message: `${code}: ${text}` });
  if (opts.allowMcp === false) {
    return fail(
      MCP_DECLINE.vetoed,
      'this machine refuses external MCP servers (localCeiling.allowMcp: false)',
    );
  }
  if (opts.sourceTrust !== 'trusted' || opts.pullRequest === true) {
    return fail(MCP_DECLINE.untrusted, 'external MCP servers are never given to jobs on an untrusted source');
  }
  const trusted = keys ?? [];
  if (trusted.length === 0) {
    return fail(MCP_DECLINE.noKeys, 'the job carries MCP servers but this worker trusts no skills key');
  }
  const policies = new Map(assigned.policies.map((p) => [p.server, p.rules]));
  const servers: VerifiedMcpServer[] = [];
  const pins: McpPin[] = [];
  for (const signed of assigned.servers) {
    const v = verifyMcpSpec(signed, trusted);
    if (!v.ok) {
      return fail(
        MCP_DECLINE.verification,
        `${v.reason}${v.detail === undefined ? '' : ` (${v.detail.slice(0, 200)})`}`,
      );
    }
    const spec = v.spec;
    const label = `${spec.id}@${spec.version}`;
    if (servers.some((s) => s.spec.id === spec.id)) {
      return fail(MCP_DECLINE.verification, `duplicate server ${spec.id}`);
    }
    if (!spec.runtimes.includes(runtime)) {
      return fail(MCP_DECLINE.verification, `${label} is not for runtime ${runtime}`);
    }
    if (spec.transport === 'stdio' && opts.allowStdio !== true) {
      return fail(MCP_DECLINE.stdio, `${label} is a stdio server; this worker runs no local MCP servers`);
    }
    const rules = policies.get(spec.id) ?? [];
    const secrets: Record<string, string> = {};
    for (const slot of mcpReferencedSlots(spec)) {
      const refs = assigned.secrets.filter((s) => s.server === spec.id && s.slot === slot);
      if (refs.length !== 1 || refs[0] === undefined) {
        return fail(
          MCP_DECLINE.secretMissing,
          `${label} needs secret slot ${slot}, the assignment ${refs.length === 0 ? 'binds none' : 'binds it twice'}`,
        );
      }
      secrets[slot] = refs[0].ref;
    }
    servers.push({ spec, specSha256: v.specSha256, rules, secrets });
    pins.push({
      id: spec.id,
      version: spec.version,
      specSha256: v.specSha256,
      policySha256: mcpPolicySha256(rules),
    });
  }
  for (const p of assigned.policies) {
    if (!servers.some((s) => s.spec.id === p.server)) {
      return fail(
        MCP_DECLINE.verification,
        `a tool policy names ${p.server}, which is not a server of the job`,
      );
    }
  }
  for (const s of assigned.secrets) {
    if (!servers.some((v) => v.spec.id === s.server && s.slot in v.secrets)) {
      return fail(
        MCP_DECLINE.verification,
        `a secret binding names ${s.server}/${s.slot}, which no spec uses`,
      );
    }
  }
  if (mcpSetHash(pins) !== assigned.setHash) {
    return fail(MCP_DECLINE.verification, 'the MCP server set does not match its pinned hash');
  }
  const egressHosts = [...new Set(servers.flatMap((s) => mcpSpecEgressHosts(s.spec)))].sort();
  if (egressHosts.length > MAX_JOB_MCP_EGRESS_HOSTS) {
    return fail(
      MCP_DECLINE.verification,
      `the job's MCP servers need ${String(egressHosts.length)} hosts (limit ${String(MAX_JOB_MCP_EGRESS_HOSTS)})`,
    );
  }
  return { ok: true, mcp: { servers, setHash: assigned.setHash, egressHosts } };
}
