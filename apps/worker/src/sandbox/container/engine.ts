import { execFile } from 'node:child_process';
import { SandboxSetupError } from '../errors.js';

/**
 * Thin wrapper around the Docker/Podman CLI. Arguments are argv arrays (never a
 * shell); the environment is an allowlist (the engine client needs to find its
 * socket/context, nothing else); secrets never pass through here — job secrets
 * reach `docker run` only through the confined process' environment.
 */

export interface EngineResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type EngineExec = (
  binary: string,
  args: readonly string[],
  opts: { timeoutMs: number; env: Record<string, string> },
) => Promise<EngineResult>;

/** Variables the engine CLI may need to reach its daemon. */
export const ENGINE_CLIENT_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_CERT_PATH',
  'DOCKER_TLS_VERIFY',
  'CONTAINER_HOST',
  'CONTAINERS_CONF',
  // Windows essentials (Docker Desktop CLI on a Windows host is not a supported job host; kept for tooling)
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

const defaultExec: EngineExec = (binary, args, opts) =>
  new Promise((resolve) => {
    execFile(
      binary,
      [...args],
      { timeout: opts.timeoutMs, env: opts.env, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });

export interface ContainerState {
  readonly running: boolean;
  readonly exitCode: number | null;
  readonly oomKilled: boolean;
}

export interface EngineInfo {
  readonly reachable: boolean;
  /** `true` rootless, `false` rootful, `null` unknown. */
  readonly rootless: boolean | null;
  readonly os: string;
  readonly arch: string;
  /** Docker Desktop / Podman machine (daemon in a VM, not on this host). */
  readonly vm: boolean;
}

export class ContainerEngine {
  readonly binary: string;
  readonly #exec: EngineExec;
  readonly #env: Record<string, string>;

  constructor(opts: { binary?: string; exec?: EngineExec; sourceEnv?: NodeJS.ProcessEnv } = {}) {
    this.binary = opts.binary ?? 'docker';
    this.#exec = opts.exec ?? defaultExec;
    const source = opts.sourceEnv ?? process.env;
    this.#env = {};
    for (const name of ENGINE_CLIENT_ENV) {
      const v = source[name];
      if (v !== undefined) this.#env[name] = v;
    }
  }

  /** Environment for the engine client (also the base env of the confined `docker run`). */
  get clientEnv(): Readonly<Record<string, string>> {
    return this.#env;
  }

  async exec(args: readonly string[], timeoutMs = 60_000): Promise<EngineResult> {
    return this.#exec(this.binary, args, { timeoutMs, env: { ...this.#env } });
  }

  async must(args: readonly string[], what: string, timeoutMs = 60_000): Promise<string> {
    const r = await this.exec(args, timeoutMs);
    if (r.code !== 0) {
      throw new SandboxSetupError(
        `${this.binary} ${what} failed (${String(r.code)}): ${r.stderr.trim().slice(0, 500)}`,
      );
    }
    return r.stdout;
  }

  async info(): Promise<EngineInfo> {
    const r = await this.exec(['info', '--format', '{{json .}}'], 15_000);
    if (r.code !== 0) return { reachable: false, rootless: null, os: '', arch: '', vm: false };
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    } catch {
      return { reachable: true, rootless: null, os: '', arch: '', vm: false };
    }
    const secopts = Array.isArray(parsed.SecurityOptions) ? (parsed.SecurityOptions as unknown[]) : [];
    const rootless = secopts.some((s) => typeof s === 'string' && s.includes('rootless'));
    const osName = typeof parsed.OperatingSystem === 'string' ? parsed.OperatingSystem : '';
    // Podman: `host.security.rootless`
    const host = parsed.host as { security?: { rootless?: boolean } } | undefined;
    return {
      reachable: true,
      rootless: host?.security?.rootless ?? rootless,
      os: typeof parsed.OSType === 'string' ? parsed.OSType : '',
      arch: typeof parsed.Architecture === 'string' ? parsed.Architecture : '',
      vm: /Docker Desktop|podman machine/i.test(osName),
    };
  }

  async imageExists(ref: string): Promise<boolean> {
    return (await this.exec(['image', 'inspect', '--format', '{{.Id}}', ref], 15_000)).code === 0;
  }

  async state(name: string): Promise<ContainerState | null> {
    const r = await this.exec(['container', 'inspect', '--format', '{{json .State}}', name], 15_000);
    if (r.code !== 0) return null;
    try {
      const s = JSON.parse(r.stdout) as { Running?: boolean; ExitCode?: number; OOMKilled?: boolean };
      return { running: s.Running === true, exitCode: s.ExitCode ?? null, oomKilled: s.OOMKilled === true };
    } catch {
      return null;
    }
  }

  /** Force-removes containers; missing ones are fine. */
  async removeContainers(names: readonly string[]): Promise<void> {
    if (names.length === 0) return;
    const r = await this.exec(['rm', '--force', '--volumes', ...names], 60_000);
    if (r.code !== 0 && !/No such container|no container with name/i.test(r.stderr)) {
      throw new SandboxSetupError(`${this.binary} rm failed: ${r.stderr.trim().slice(0, 500)}`);
    }
  }

  async removeNetwork(name: string): Promise<void> {
    const r = await this.exec(['network', 'rm', name], 60_000);
    if (r.code !== 0 && !/not found|No such network|no such network/i.test(r.stderr)) {
      throw new SandboxSetupError(`${this.binary} network rm failed: ${r.stderr.trim().slice(0, 500)}`);
    }
  }

  /** Sends a signal to the container's init (fire-and-forget friendly). */
  async signal(name: string, signal: string): Promise<void> {
    await this.exec(['kill', '--signal', signal, name], 15_000);
  }
}
