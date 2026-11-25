import { WorkerState } from '@remyral/protocol';
import { z } from 'zod';
import type { Logger } from '@remyral/observability';
import type { WorkerDaemon, DaemonStopInfo } from '../daemon/daemon.js';
import { runWorker, type RunWorkerDeps } from '../daemon/run.js';
import { atomicWriteFile, removeStaleTemps } from '../fs/atomic.js';
import { errnoCode, type FileOps } from '../fs/ops.js';
import { pathApi } from '../config/paths.js';
import { latchShutdownSignals } from './early-signals.js';
import { WORKER_VERSION } from '../probe/probe.js';

/**
 * `<dataDir>/status.json`: the running daemon's last known lifecycle status, for
 * `remyral-worker service status` (a separate process with no IPC to the daemon).
 * Written atomically (0600) on start, on every state change and on a graceful stop.
 * It is a *report*, never an input: on restart the daemon derives its status from
 * the durable store (state.json), not from this file.
 */
export const STATUS_FILE = 'status.json';

export const StatusFileContent = z.strictObject({
  version: z.literal(1),
  pid: z.number().int().positive(),
  workerVersion: z.string().max(64),
  /** `stopped` only after a graceful shutdown; a crash leaves the last live state behind. */
  state: z.union([WorkerState, z.literal('stopped')]),
  runningJobs: z.number().int().min(0),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  stopReason: z.string().max(200).nullable(),
});
export type StatusFileContent = z.infer<typeof StatusFileContent>;

export interface StatusFileOptions {
  ops: FileOps;
  dataDir: string;
  pid?: number;
  now?: () => Date;
  logger?: Pick<Logger, 'warn'>;
}

/** Serialized writer: the latest status wins, writes never overlap, failures are logged only. */
export class StatusFileWriter {
  readonly #path: string;
  readonly #startedAt: string;
  #queue: Promise<void> = Promise.resolve();
  #unsubscribe: (() => void) | null = null;
  #attached: Promise<void> = Promise.resolve();

  constructor(private readonly o: StatusFileOptions) {
    this.#path = pathApi(o.ops.platform).join(o.dataDir, STATUS_FILE);
    this.#startedAt = this.#now();
  }

  get path(): string {
    return this.#path;
  }

  #now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }

  write(
    state: StatusFileContent['state'],
    runningJobs: number,
    stopReason: string | null = null,
  ): Promise<void> {
    const content: StatusFileContent = {
      version: 1,
      pid: this.o.pid ?? process.pid,
      workerVersion: WORKER_VERSION,
      state,
      runningJobs,
      startedAt: this.#startedAt,
      updatedAt: this.#now(),
      stopReason: stopReason?.slice(0, 200) ?? null,
    };
    this.#queue = this.#queue
      .then(() => atomicWriteFile(this.o.ops, this.#path, `${JSON.stringify(content)}\n`, { mode: 0o600 }))
      .catch((error: unknown) => {
        // Status reporting must never take the daemon down.
        this.o.logger?.warn('could not write the status file', { path: this.#path, err: error });
      });
    return this.#queue;
  }

  /** Mirrors the daemon's state machine into the file until `close`. */
  attach(daemon: WorkerDaemon): Promise<void> {
    this.#attached = (async () => {
      // Leftover temp files of a write interrupted by a crash (before our first write).
      await removeStaleTemps(this.o.ops, this.o.dataDir, STATUS_FILE).catch(() => 0);
      this.#unsubscribe = daemon.machine.onTransition((r) => {
        void this.write(r.to.state, r.to.runningJobs);
      });
      const { state, runningJobs } = daemon.machine.status;
      await this.write(state, runningJobs);
    })();
    return this.#attached;
  }

  async close(stopReason: string): Promise<void> {
    await this.#attached;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.write('stopped', 0, stopReason);
  }
}

/**
 * `runWorker` plus the status file — what `remyral-worker run` executes under a service
 * manager. The final `stopped` record is written only after a graceful stop; a crash or
 * SIGKILL leaves the last live state, which `service status` recognizes as stale because
 * the recorded pid is no longer the service's main pid.
 */
export async function runWorkerWithStatusFile(deps: RunWorkerDeps): Promise<DaemonStopInfo> {
  let writer: StatusFileWriter | null = null;
  // Subscribe to stop signals before any await, so a stop during startup is not lost.
  const signals = latchShutdownSignals(deps.signals);
  let info: DaemonStopInfo;
  try {
    info = await runWorker({
      ...deps,
      signals,
      onStarted: (daemon, config) => {
        writer = new StatusFileWriter({ ops: deps.ops, dataDir: config.dataDir });
        void writer.attach(daemon);
        deps.onStarted?.(daemon, config);
      },
    });
  } finally {
    signals.close();
  }
  await (writer as StatusFileWriter | null)?.close(info.reason);
  return info;
}

/** Reads the status file; `null` if missing, `{ error }` if unreadable or invalid. */
export async function readStatusFile(
  ops: FileOps,
  dataDir: string,
): Promise<StatusFileContent | null | { error: string }> {
  const path = pathApi(ops.platform).join(dataDir, STATUS_FILE);
  let raw: Buffer | null;
  try {
    raw = await ops.readFile(path, 64 * 1024);
  } catch (error) {
    const code = errnoCode(error);
    return {
      error:
        code === 'EACCES' || code === 'EPERM'
          ? `${path}: permission denied (run as root/Administrator, or as the service user)`
          : `cannot read ${path}: ${(error as Error).message}`,
    };
  }
  if (raw === null) return null;
  try {
    const parsed = StatusFileContent.safeParse(JSON.parse(raw.toString('utf8')));
    return parsed.success ? parsed.data : { error: `${path} is not a valid status file` };
  } catch {
    return { error: `${path} is not valid JSON` };
  }
}
