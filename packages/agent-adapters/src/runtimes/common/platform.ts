import { execFile } from 'node:child_process';
import type { ArchT, OsFamilyT } from '../../capabilities.js';

export function currentOs(platform: NodeJS.Platform = process.platform): OsFamilyT {
  if (platform === 'win32') return 'win32';
  if (platform === 'linux') return 'linux';
  return 'darwin';
}

export function currentArch(arch: string = process.arch): ArchT {
  return arch === 'x64' ? 'x64' : 'arm64';
}

/** `darwin-arm64` etc.; the key of the per-platform contract-test record. */
export function platformKey(os: OsFamilyT, arch: ArchT): `${OsFamilyT}-${ArchT}` {
  return `${os}-${arch}`;
}

export interface CommandOutput {
  /** False when the executable could not be started at all (ENOENT, EACCES). */
  readonly started: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run a short-lived runtime command (version / auth status) with an explicit,
 * minimal environment and a hard timeout. Output is bounded. Never pass secrets
 * here: probe commands do not need credentials.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  opts: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs: number },
): Promise<CommandOutput> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        env: opts.env,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        timeout: opts.timeoutMs,
        maxBuffer: 256 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const code = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code : 0;
        if (typeof code === 'string') {
          // ENOENT / EACCES: the binary is not usable.
          resolve({ started: false, exitCode: null, stdout: '', stderr });
          return;
        }
        resolve({
          started: true,
          exitCode: typeof code === 'number' ? code : err ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/** First `x.y.z` (optionally with a pre-release suffix) in a `--version` output. */
export function parseVersion(output: string): string | undefined {
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1];
}
