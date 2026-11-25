import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type ProcessConfiner, spawnOwnedProcess } from '@remyral/agent-adapters';
import { parseEgressTarget } from '../sandbox/network.js';
import { DEFAULT_LIMITS, type ResourceLimits, type SandboxContext } from '../sandbox/types.js';
import { writeMcpLaunch } from './launcher.js';
import type { StdioProbeStarter } from './probe-op.js';
import { McpProbeError, type StdioProbeProcess } from './probe.js';

/**
 * p14-mcp-stdio (docs/design/p14-mcp-skills.md §2.8, §14.4): starts an installed stdio server for a tool-discovery
 * probe **inside the worker's host sandbox**, like a job attempt of its own: a scratch workspace under
 * `<workspaceRoot>/jobs/mcp-probe-<id>/`, the `host-restricted` confiner (Seatbelt on macOS, the per-job account on
 * Windows, the host baseline on Linux), network only to the server's declared hosts through the per-attempt proxy,
 * the default resource limits, and the same launcher a job uses (minimal env, the server's own env from a 0600 spec
 * file). Everything it created is removed when the probe ends. Without a ready host sandbox the probe is refused —
 * third-party code never runs unconfined in the worker's own account.
 */

export interface StdioProbeSandboxDeps {
  readonly workspaceRoot: string;
  /** Node that runs the launcher (the worker's own). */
  readonly nodePath: string;
  /** The `host-restricted` confiner; null when this machine has no ready host sandbox. */
  readonly confiner: ((ctx: SandboxContext) => ProcessConfiner) | null;
  readonly limits?: ResourceLimits;
}

export function sandboxedStdioStarter(d: StdioProbeSandboxDeps): StdioProbeStarter {
  return async ({ spec, exec, env, egressHosts }): Promise<StdioProbeProcess> => {
    if (d.confiner === null) {
      throw new McpProbeError(
        'sandbox_unavailable',
        'this machine has no ready host sandbox; local MCP servers are not started outside it',
      );
    }
    const attemptId = randomUUID();
    const jobId = `mcp-probe-${attemptId.slice(0, 8)}`;
    const jobDir = join(d.workspaceRoot, 'jobs', jobId);
    const workspace = join(jobDir, attemptId);
    const configDir = join(workspace, '.remyral-mcp');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const cleanup = () => rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    try {
      const { launcher, specFile } = await writeMcpLaunch(configDir, spec, exec, env);
      const confiner = d.confiner({
        jobId,
        attemptId,
        authMode: 'none',
        workspacePath: workspace,
        network: { mode: 'allowlist', targets: egressHosts.map(parseEgressTarget) },
        limits: d.limits ?? DEFAULT_LIMITS,
      });
      const proc = await spawnOwnedProcess({
        command: d.nodePath,
        args: [launcher, specFile],
        cwd: workspace,
        stdin: 'pipe',
        confiner,
      });
      const stdout = proc.child.stdout;
      if (stdout === null) {
        await proc.dispose().catch(() => undefined);
        throw new McpProbeError('start_failed', 'the MCP server has no stdout');
      }
      return {
        stdin: proc.stdin,
        stdout,
        exited: proc.exited,
        stop: async () => {
          await proc.terminate({ graceMs: 2_000 }).catch(() => undefined);
          await proc.dispose().catch(() => undefined);
          await cleanup();
        },
      };
    } catch (err) {
      await cleanup();
      throw err;
    }
  };
}
