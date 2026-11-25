import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpHeaderValue, McpJobDelivery, McpServerDelivery } from '@remyral/agent-adapters';
import {
  mcpRemoteOf,
  mcpRuntimeName,
  mcpSecretEnvName,
  mcpSecretValueProblem,
  type McpValue,
} from '@remyral/protocol';
import { ResolvedJobEnv } from '../secrets/env.js';
import type { JobSecretLease } from '../secrets/registry.js';
import { localSecretName, parseSecretRef, type SecretString } from '../secrets/ref.js';
import type { SecretStore } from '../secrets/store.js';
import { MCP_FORWARD_ENV, mcpServerEnv, writeMcpLaunch } from './launcher.js';
import { MCP_DECLINE, type VerifiedMcp } from './verify.js';

/**
 * p14-mcp-core (ADR-0054 §2.4): turns the verified servers of a job into what the adapter renders — names `x-<id>`,
 * headers as literals or secret env references, tool rules, timeouts — plus the secret values from this worker's
 * store (vault credentials `secret:vault-<id>`) as env variables `REMYRAL_MCP_<ID>_<SLOT>`. Values never leave the
 * worker, never go on argv (the adapters' rule) and are registered with the job's redaction lease.
 */

/** One secret of a job's MCP servers: the env variable it is injected as and the local store name. */
interface McpSecretSlot {
  readonly env: string;
  readonly name: string;
  readonly label: string;
  /** p14-mcp-stdio: the slot of a stdio server (its value goes into the launch file, not the runtime's env). */
  readonly stdio: boolean;
}

/** Env names of the remote servers' secret slots (the only MCP secrets a runtime process gets as env). */
function remoteSecretEnvNames(mcp: VerifiedMcp): Set<string> {
  return new Set(
    mcp.servers
      .filter((s) => s.spec.transport !== 'stdio')
      .flatMap((s) => Object.keys(s.secrets).map((slot) => mcpSecretEnvName(s.spec.id, slot))),
  );
}

function slots(mcp: VerifiedMcp, workerId: string | null): McpSecretSlot[] {
  const out: McpSecretSlot[] = [];
  for (const s of mcp.servers) {
    for (const [slot, ref] of Object.entries(s.secrets)) {
      out.push({
        env: mcpSecretEnvName(s.spec.id, slot),
        name: localSecretName(parseSecretRef(ref), workerId, ref),
        label: `${s.spec.id}/${slot}`,
        stdio: s.spec.transport === 'stdio',
      });
    }
  }
  return out;
}

/**
 * Admission check (values are read, checked and dropped): every slot's secret is on this machine and fits a header
 * value ({@link mcpSecretValueProblem}). Returns the decline message, or null.
 */
export async function checkMcpSecrets(
  mcp: VerifiedMcp,
  store: Pick<SecretStore, 'get'>,
  workerId: string | null,
): Promise<string | null> {
  let list: McpSecretSlot[];
  try {
    list = slots(mcp, workerId);
  } catch (err) {
    return `${MCP_DECLINE.secretMissing}: ${err instanceof Error ? err.message.slice(0, 200) : 'invalid secret reference'}`;
  }
  for (const s of list) {
    let value: SecretString | null;
    try {
      value = await store.get(s.name);
    } catch {
      value = null;
    }
    if (value === null) {
      return `${MCP_DECLINE.secretMissing}: the secret for ${s.label} is not on this machine (vault credential ${s.name})`;
    }
    const problem = mcpSecretValueProblem(value.reveal());
    if (problem !== null) {
      return `${MCP_DECLINE.secretInvalid}: the secret for ${s.label} cannot be used as a header value (${problem})`;
    }
  }
  return null;
}

/**
 * Spawn time: reads the MCP secrets, registers each value with the job's redaction lease and returns the job env
 * extended by the remote servers' ones (`env` for the child process, `secretEnv` as opaque handles) and all MCP
 * secrets (`mcpSecretEnv`: stdio servers' values go only into their launch files).
 */
export async function withMcpSecrets(
  env: ResolvedJobEnv,
  mcp: VerifiedMcp,
  store: Pick<SecretStore, 'get'>,
  lease: Pick<JobSecretLease, 'add'>,
  workerId: string | null,
): Promise<{ readonly env: ResolvedJobEnv; readonly mcpSecretEnv: Readonly<Record<string, SecretString>> }> {
  const full: Record<string, string> = { ...env.env };
  const secretEnv: Record<string, SecretString> = { ...env.secretEnv };
  const mcpSecretEnv: Record<string, SecretString> = {};
  for (const s of slots(mcp, workerId)) {
    if (s.env in env.secretEnv || s.env in env.env) {
      throw new Error(`${MCP_DECLINE.secretInvalid}: ${s.env} is already set for this job`);
    }
    const value = await store.get(s.name);
    if (value === null)
      throw new Error(`${MCP_DECLINE.secretMissing}: the secret for ${s.label} disappeared`);
    const problem = mcpSecretValueProblem(value.reveal());
    if (problem !== null) throw new Error(`${MCP_DECLINE.secretInvalid}: ${s.label} (${problem})`);
    lease.add(value.reveal(), s.env);
    mcpSecretEnv[s.env] = value;
    // A stdio server's secret reaches only its launch file (0600), never the runtime's environment.
    if (s.stdio) continue;
    full[s.env] = value.reveal();
    secretEnv[s.env] = value;
  }
  return { env: new ResolvedJobEnv(full, secretEnv, env.authMode), mcpSecretEnv };
}

function header(serverId: string, value: McpValue): McpHeaderValue {
  if (typeof value === 'string') return { kind: 'literal', value };
  return {
    kind: 'secret',
    env: mcpSecretEnvName(serverId, value.secret),
    ...(value.format === undefined ? {} : { format: value.format }),
  };
}

/** The attempt-private config directory (`<stateDir>/mcp`, 0700; removed with the attempt's state dir). */
export async function prepareMcpConfigDir(stateDir: string): Promise<string> {
  const dir = join(stateDir, 'mcp');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  return dir;
}

/**
 * What the adapter gets as `ctx.mcp`. p14-mcp-stdio: a stdio server becomes the launcher command line (`node` running
 * `remyral-mcp-launch.mjs <x-id>.launch.json`, both written 0600 into the attempt's config dir); its env — secrets
 * included — is only in that file. `node` is the job's Node: the worker's own on the host, the image's inside a
 * container (`containerNode`).
 */
export async function buildMcpDelivery(
  mcp: VerifiedMcp,
  secretEnv: Readonly<Record<string, SecretString>>,
  configDir: string,
  opts: { readonly node: string },
): Promise<McpJobDelivery> {
  const servers: McpServerDelivery[] = [];
  for (const s of mcp.servers) {
    const base = {
      id: s.spec.id,
      name: mcpRuntimeName(s.spec.id),
      rules: s.rules,
      startupTimeoutSec: s.spec.limits.startupTimeoutSec,
      toolTimeoutSec: s.spec.limits.toolTimeoutSec,
    };
    if (s.spec.transport === 'stdio') {
      if (s.stdio === undefined) throw new Error(`${MCP_DECLINE.notInstalled}: ${s.spec.id}`);
      const { launcher, specFile } = await writeMcpLaunch(
        configDir,
        s.spec,
        s.stdio.exec,
        mcpServerEnv(s.spec, secretEnv),
      );
      servers.push({
        ...base,
        transport: 'stdio',
        command: opts.node,
        args: [launcher, specFile],
        forwardEnv: MCP_FORWARD_ENV,
      });
      continue;
    }
    const remote = mcpRemoteOf(s.spec);
    if (remote === undefined) throw new Error(`${MCP_DECLINE.verification}: ${s.spec.id} has no URL`);
    servers.push({
      ...base,
      transport: s.spec.transport,
      url: remote.url,
      headers: Object.fromEntries(
        Object.entries(remote.headers ?? {}).map(([k, v]) => [k, header(s.spec.id, v)]),
      ),
    });
  }
  // A stdio server's secrets are in its launch file; only remote servers' secrets travel as env.
  const envOnly: Record<string, SecretString> = {};
  for (const name of remoteSecretEnvNames(mcp)) {
    const value = secretEnv[name];
    if (value !== undefined) envOnly[name] = value;
  }
  return { servers, configDir, secretEnv: envOnly };
}

/** The attempt's extra egress entries (the worker's own `egressAllow` is never changed). */
export function mcpEgressFor(mcp: VerifiedMcp | null, allowEgress: boolean): readonly string[] {
  if (mcp === null || !allowEgress) return [];
  return mcp.egressHosts;
}

/** The system note on the job's timeline listing the hosts added for this attempt (or why none were). */
export function mcpEgressNote(mcp: VerifiedMcp, allowEgress: boolean): string {
  const names = mcp.servers.map((s) => `${s.spec.id}@${s.spec.version}`).join(', ');
  if (!allowEgress) {
    return `MCP servers ${names}: no hosts added — this machine refuses MCP egress (localCeiling.allowMcpEgress: false); the servers are likely unreachable.`;
  }
  return `MCP servers ${names}: hosts added to this attempt's network allowlist: ${mcp.egressHosts.join(', ')}.`;
}
