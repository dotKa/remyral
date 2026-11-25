import { spawnOwnedProcess } from '../../process/owned-process.js';

export interface ProbeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface ProbeCommandOptions {
  readonly cwd: string;
  /** Complete environment (nothing else is inherited). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * Run a short diagnostic command (`--version`, `auth status`) as an owned
 * process tree with an explicit environment; the tree is always reaped.
 * Never sends input; output is bounded by the process helper's tail buffers.
 */
export async function runProbeCommand(
  command: string,
  args: readonly string[],
  opts: ProbeCommandOptions,
): Promise<ProbeCommandResult> {
  const proc = await spawnOwnedProcess({
    command,
    args,
    cwd: opts.cwd,
    env: opts.env,
    inheritEnv: [],
    stdin: 'ignore',
  });
  try {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      proc.exited.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(true);
        }, opts.timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) await proc.killTree();
    // Let the pipes drain after exit.
    await new Promise((r) => setImmediate(r));
    return {
      exitCode: timedOut ? null : (proc.exit?.code ?? null),
      stdout: proc.stdoutTail(),
      stderr: proc.stderrTail(),
      timedOut,
    };
  } finally {
    await proc.dispose();
  }
}
