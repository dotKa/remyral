import { createHash, randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import {
  posixTreeKiller,
  spawnOwnedProcess,
  type ConfinedSpawn,
  type OwnedProcess,
  type ProcessConfiner,
  type ProcessTreeKiller,
  type SpawnPlan,
} from '@remyral/agent-adapters';
import type { RuntimeKind } from '@remyral/protocol';
import { CONTAINER_WORKSPACE } from '../attempt-git.js';
import { SandboxRequestError, SandboxSetupError, SandboxUnavailableError } from '../errors.js';
import { formatTarget, normalizeNetworkPolicy } from '../network.js';
import type { ProfileCapability } from '../policy.js';
import type { SandboxContext, SandboxLaunchRequest, SandboxRunner } from '../types.js';
import { isInside } from '../../workspace/paths.js';
import {
  attemptMounts,
  type BindMount,
  buildRunArgs,
  CONTAINER_HOME,
  CONTAINER_USER,
  EGRESS_PROXY_ALIAS,
  EGRESS_PROXY_PORT,
} from './args.js';
import { ContainerEngine, type ContainerState } from './engine.js';

/**
 * ADR-0007 `container` profile: one container per runtime process, from a
 * pinned runtime image, on Linux with rootless Docker or Podman.
 *
 * Network:
 *  - `none` → `--network none`.
 *  - `allowlist` → a per-job `--internal` network (no route out, no external
 *    DNS) shared only with a per-job egress proxy sidecar, which is additionally
 *    attached to the egress network. The job reaches the outside only as HTTPS
 *    CONNECT tunnels to allowlisted hosts (egress/proxy.ts).
 *
 * Ownership: the owned process is the attached `docker run` client; the tree
 * killer kills/removes the *container* (killing the client alone would leave it
 * running) and then the client's process group.
 */

export interface ContainerRunnerOptions {
  readonly engine: ContainerEngine;
  /** Runtime image per runtime (`default` for anything else). Pinned by digest in production. */
  readonly images: Partial<Record<RuntimeKind | 'default', string>>;
  /** Image of the egress proxy sidecar. */
  readonly proxyImage: string;
  /** Network the proxy uses to reach the internet. Default `bridge`. */
  readonly egressNetwork?: string;
  readonly user?: string;
  /**
   * Allow a non-Linux engine host (Docker Desktop VM). ADR-0007 defines the profile
   * for Linux workers; this is for development and the test suite on macOS only.
   */
  readonly allowNonLinuxHost?: boolean;
  readonly platform?: NodeJS.Platform;
  /** Timeout for the proxy to report ready. Default 20 s. */
  readonly proxyReadyTimeoutMs?: number;
}

/**
 * Same-path bind mounts for paths named on the runtime's command line (SandboxContext.runtimeMounts):
 * read-write only inside this attempt's sandbox dir (the adapter's per-attempt state), read-only only
 * for regular files (operator extensions). Anything else is refused, never widened.
 */
async function runtimeMounts(ctx: SandboxContext): Promise<BindMount[]> {
  const out: BindMount[] = [];
  for (const m of ctx.runtimeMounts ?? []) {
    const real = await realpath(m.path).catch(() => null);
    if (real === null) throw new SandboxRequestError('runtimeMounts', `${m.path} does not exist`);
    if (!m.readOnly) {
      const own = ctx.git?.sandboxDir ?? ctx.sandboxDir;
      const sandboxDir = own === undefined ? null : await realpath(own);
      if (sandboxDir === null || !isInside(sandboxDir, real) || real === sandboxDir) {
        throw new SandboxRequestError(
          'runtimeMounts',
          `${m.path} is not inside the attempt's sandbox dir; only per-attempt state may be mounted writable`,
        );
      }
    } else if (!(await lstat(real)).isFile()) {
      throw new SandboxRequestError('runtimeMounts', `${m.path}: read-only runtime mounts must be files`);
    }
    out.push({ source: real, target: m.path, readOnly: m.readOnly });
  }
  return out;
}

/**
 * p14-mcp-stdio: read-only same-path mounts of the job's local MCP server installs. Each must be a directory inside the
 * MCP root (after resolving symlinks); anything else is refused, never widened.
 */
async function mcpMounts(ctx: SandboxContext): Promise<BindMount[]> {
  if (ctx.mcpMounts === undefined || ctx.mcpMounts.dirs.length === 0) return [];
  const root = await realpath(ctx.mcpMounts.root).catch(() => null);
  if (root === null) throw new SandboxRequestError('mcpMounts', `${ctx.mcpMounts.root} does not exist`);
  const out: BindMount[] = [];
  for (const dir of ctx.mcpMounts.dirs) {
    const real = await realpath(dir).catch(() => null);
    if (real === null) throw new SandboxRequestError('mcpMounts', `${dir} does not exist`);
    if (!isInside(root, real) || real === root || !(await lstat(real)).isDirectory()) {
      throw new SandboxRequestError('mcpMounts', `${dir} is not an MCP install directory`);
    }
    out.push({ source: real, target: dir, readOnly: true });
  }
  return out;
}

interface Resources {
  readonly container: string;
  readonly proxy?: string;
  readonly network?: string;
}

/** Variables set in every job container (non-secret). */
function containerBaseEnv(): Record<string, string> {
  return {
    HOME: CONTAINER_HOME,
    TMPDIR: '/tmp',
    PATH: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
    LANG: 'C.UTF-8',
    // The runtime user does not own the bind-mounted files on every engine; the
    // container is the boundary, so git may trust them (command-line scope config).
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  };
}

export class ContainerSandboxRunner implements SandboxRunner {
  readonly profile = 'container' as const;
  readonly kind: string;
  readonly #o: ContainerRunnerOptions;
  readonly #final = new Map<string, ContainerState | null>();
  readonly #byPid = new Map<number, string>();
  /** p22-previews-inputs: job id → its job containers (created by this runner, not yet disposed), oldest first. */
  readonly #byJob = new Map<string, string[]>();

  constructor(opts: ContainerRunnerOptions) {
    this.#o = opts;
    this.kind = `container:${opts.engine.binary}`;
  }

  /** Readiness for `selectProfile` (engine reachable, rootless on Linux, images present). */
  async check(runtime?: RuntimeKind): Promise<ProfileCapability> {
    const platform = this.#o.platform ?? process.platform;
    if (platform !== 'linux' && this.#o.allowNonLinuxHost !== true) {
      return {
        ready: false,
        reasonCode: 'profile_unsupported_on_os',
        reason: `the container profile is defined for Linux workers (this is ${platform})`,
        remedy: 'schedule container jobs on a Linux worker',
      };
    }
    const info = await this.#o.engine.info();
    if (!info.reachable) {
      return {
        ready: false,
        reasonCode: 'engine_unavailable',
        reason: `${this.#o.engine.binary} daemon not reachable`,
        remedy:
          'start the rootless engine for the worker user (systemctl --user start docker / podman.socket)',
      };
    }
    if (platform === 'linux' && info.rootless !== true) {
      return {
        ready: false,
        reasonCode: 'engine_unavailable',
        reason: `${this.#o.engine.binary} is not rootless (ADR-0007, T-SBX-3)`,
        remedy: 'install rootless Docker (dockerd-rootless-setuptool.sh) or Podman for the worker user',
      };
    }
    const images = [this.#image(runtime), this.#o.proxyImage];
    for (const img of images) {
      if (img === undefined || !(await this.#o.engine.imageExists(img))) {
        return {
          ready: false,
          reasonCode: 'image_unavailable',
          reason: `image ${img ?? `(none configured for ${runtime ?? 'default'})`} is not present locally (never pulled at job time)`,
          remedy: 'build/pull the pinned images: node infra/worker/images/build.mjs',
        };
      }
    }
    return { ready: true };
  }

  #image(runtime?: RuntimeKind): string | undefined {
    return (runtime === undefined ? undefined : this.#o.images[runtime]) ?? this.#o.images.default;
  }

  /** Engine state of the container captured right before removal (exit code, OOM kill). */
  finalState(proc: OwnedProcess): ContainerState | null | undefined {
    const name = this.#byPid.get(proc.pid);
    return name === undefined ? undefined : this.#final.get(name);
  }

  /**
   * p22-previews-inputs: the job containers of a job this runner created and has not removed yet (the newest last) —
   * where a preview of a container-profile job looks for its server.
   */
  jobContainers(jobId: string): readonly string[] {
    return [...(this.#byJob.get(jobId) ?? [])];
  }

  /** The engine (p22-previews-inputs: the preview port relay runs `exec` through it). */
  get engine(): ContainerEngine {
    return this.#o.engine;
  }

  /** Container name of a launched process (for audit/diagnostics). */
  containerName(proc: OwnedProcess): string | undefined {
    return this.#byPid.get(proc.pid);
  }

  confiner(ctx: SandboxContext): ProcessConfiner {
    return { kind: this.kind, confine: (plan) => this.#confine(ctx, plan) };
  }

  async launch(req: SandboxLaunchRequest): Promise<OwnedProcess> {
    let lastName: string | undefined;
    const base = this.confiner(req);
    const confiner: ProcessConfiner = {
      kind: base.kind,
      confine: async (plan) => {
        const c = await base.confine(plan);
        lastName = c.args[c.args.indexOf('--name') + 1];
        return c;
      },
    };
    const proc = await spawnOwnedProcess({
      command: req.command,
      args: req.args,
      cwd: req.workspacePath,
      env: req.env,
      inheritEnv: [],
      ...(req.secretEnv ? { secretEnv: req.secretEnv } : {}),
      ...(req.stdin ? { stdin: req.stdin } : {}),
      ...(req.maxBufferBytes ? { maxBufferBytes: req.maxBufferBytes } : {}),
      confiner,
    });
    if (lastName !== undefined) this.#byPid.set(proc.pid, lastName);
    return proc;
  }

  async #confine(ctx: SandboxContext, plan: SpawnPlan): Promise<ConfinedSpawn> {
    const engine = this.#o.engine;
    const image = this.#image(ctx.runtime);
    if (image === undefined) {
      throw new SandboxUnavailableError(
        'container',
        'image_unavailable',
        `no runtime image configured for ${ctx.runtime ?? 'default'}`,
        'set sandbox.container.images in the worker config',
      );
    }
    if (ctx.packageCaches !== undefined) {
      // ADR-0029: container jobs never share a package cache (nothing of a container run persists).
      throw new SandboxRequestError('packageCaches', 'the container profile gets no shared package cache');
    }
    const network = normalizeNetworkPolicy(ctx.network);
    const id = createHash('sha256').update(`${ctx.jobId}/${ctx.attemptId}`).digest('hex').slice(0, 12);
    const suffix = randomBytes(4).toString('hex');
    const res: { container: string; proxy?: string; network?: string } = {
      container: `remyral-job-${id}-${suffix}`,
    };
    const labels = { 'remyral.job': ctx.jobId, 'remyral.attempt': ctx.attemptId, 'remyral.sandbox': 'job' };
    const dispose = this.#disposer(res, ctx.jobId);
    try {
      const env: Record<string, string> = { ...containerBaseEnv() };
      // Runtime env from the plan, minus host-specific paths that are meaningless inside.
      for (const [k, v] of Object.entries(plan.env)) {
        if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR' || k === 'TMP' || k === 'TEMP') continue;
        env[k] = v;
      }
      let netName = 'none';
      if (network.mode === 'allowlist' || network.mode === 'web') {
        netName = `remyral-net-${id}-${suffix}`;
        res.network = netName;
        await engine.must(
          [
            'network',
            'create',
            '--internal',
            '--label',
            'remyral.sandbox=job',
            '--label',
            `remyral.job=${ctx.jobId}`,
            netName,
          ],
          'network create',
        );
        res.proxy = `remyral-egress-${id}-${suffix}`;
        await this.#startProxy(
          res.proxy,
          netName,
          network.targets.map(formatTarget),
          ctx.jobId,
          network.mode === 'web',
          network.refusalHint,
        );
        const proxyUrl = `http://${EGRESS_PROXY_ALIAS}:${String(EGRESS_PROXY_PORT)}`;
        Object.assign(env, {
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          HTTP_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          NO_PROXY: '',
          no_proxy: '',
          NODE_USE_ENV_PROXY: '1',
        });
      }
      const args = buildRunArgs({
        name: res.container,
        image,
        labels,
        network: netName,
        user: this.#o.user ?? CONTAINER_USER,
        limits: ctx.limits,
        mounts: [
          ...attemptMounts({ workspacePath: ctx.workspacePath, git: ctx.git }),
          ...(await runtimeMounts(ctx)),
          ...(await mcpMounts(ctx)),
        ],
        workdir: CONTAINER_WORKSPACE,
        envNames: Object.keys(env).sort(),
        stdin: true,
        command: ctx.containerCommand ?? plan.command,
        args: plan.args,
      });
      this.#byJob.set(ctx.jobId, [...(this.#byJob.get(ctx.jobId) ?? []), res.container]);
      return {
        command: engine.binary,
        args,
        cwd: ctx.workspacePath,
        // The client's own env (socket/context) + the job env, forwarded by name.
        env: { ...engine.clientEnv, ...env },
        treeKiller: this.#killer(res.container),
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  async #startProxy(
    name: string,
    network: string,
    allow: string[],
    jobId: string,
    web = false,
    hint?: string,
  ): Promise<void> {
    const engine = this.#o.engine;
    await engine.must(
      [
        'run',
        '--detach',
        '--name',
        name,
        '--pull',
        'never',
        '--label',
        'remyral.sandbox=egress-proxy',
        '--label',
        `remyral.job=${jobId}`,
        '--network',
        network,
        '--network-alias',
        EGRESS_PROXY_ALIAS,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        CONTAINER_USER,
        '--memory',
        '134217728b',
        '--memory-swap',
        '134217728b',
        '--pids-limit',
        '64',
        '--cpus',
        '0.5',
        '--env',
        `REMYRAL_EGRESS_ALLOW=${allow.join(',')}`,
        '--env',
        `REMYRAL_EGRESS_PORT=${String(EGRESS_PROXY_PORT)}`,
        // p5-research-workspace: `web` also tunnels to any public host on 443 (same address checks).
        ...(web ? ['--env', 'REMYRAL_EGRESS_MODE=web'] : []),
        // p14-repo-egress: the 403 body names the policy and where to change it (older sidecar images ignore it).
        ...(hint === undefined ? [] : ['--env', `REMYRAL_EGRESS_HINT=${hint}`]),
        '--',
        this.#o.proxyImage,
      ],
      'run egress proxy',
    );
    await engine.must(['network', 'connect', this.#o.egressNetwork ?? 'bridge', name], 'network connect');
    const deadline = Date.now() + (this.#o.proxyReadyTimeoutMs ?? 20_000);
    while (Date.now() < deadline) {
      const logs = await engine.exec(['logs', name], 10_000);
      if (logs.stdout.includes('"event":"ready"')) return;
      const st = await engine.state(name);
      if (st !== null && !st.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new SandboxSetupError(`egress proxy ${name} did not become ready`);
  }

  /**
   * p11-session-continuity: removes every container (and egress proxy) of one attempt — after a worker crash a container
   * outlives its client. Selected by the labels the runner sets (`remyral.job` + `remyral.attempt`; proxies by job).
   */
  async removeAttemptContainers(jobId: string, attemptId: string): Promise<number> {
    const engine = this.#o.engine;
    const list = async (filters: string[]): Promise<string[]> => {
      const r = await engine.exec(
        ['ps', '--all', '--quiet', ...filters.flatMap((f) => ['--filter', `label=${f}`])],
        30_000,
      );
      if (r.code !== 0) throw new Error(`${engine.binary} ps failed: ${r.stderr.trim().slice(0, 300)}`);
      return r.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{6,64}$/.test(l));
    };
    const ids = [
      ...(await list([`remyral.job=${jobId}`, `remyral.attempt=${attemptId}`])),
      ...(await list([`remyral.job=${jobId}`, 'remyral.sandbox=egress-proxy'])),
    ];
    await engine.removeContainers([...new Set(ids)]);
    return ids.length;
  }

  #killer(container: string): ProcessTreeKiller {
    const engine = this.#o.engine;
    const local = posixTreeKiller();
    return {
      kind: 'container',
      detached: true,
      signal: (pid, sig) => {
        void engine.signal(container, sig);
        return local.signal(pid, sig) || true;
      },
      kill: async (pid) => {
        await this.#capture(container);
        await engine.removeContainers([container]);
        local.signal(pid, 'SIGKILL');
      },
    };
  }

  async #capture(container: string): Promise<void> {
    if (!this.#final.has(container)) this.#final.set(container, await this.#o.engine.state(container));
  }

  #disposer(res: Resources, jobId: string): () => Promise<void> {
    let done: Promise<void> | undefined;
    return () => {
      done ??= (async () => {
        const left = (this.#byJob.get(jobId) ?? []).filter((n) => n !== res.container);
        if (left.length === 0) this.#byJob.delete(jobId);
        else this.#byJob.set(jobId, left);
        const engine = this.#o.engine;
        await this.#capture(res.container);
        const names = [res.container, ...(res.proxy ? [res.proxy] : [])];
        await engine.removeContainers(names);
        if (res.network) await engine.removeNetwork(res.network);
      })();
      return done;
    };
  }
}
