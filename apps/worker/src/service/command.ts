import type { PathHost } from '../config/paths.js';
import type { FileOps } from '../fs/ops.js';
import type { System } from '../system/types.js';
import { collectServiceStatus, formatServiceStatus, STATUS_EXIT, statusExitCode } from './status.js';

export const SERVICE_USAGE = `  service status        Show the OS service (systemd / launchd / Windows SCM), the daemon's last
                        recorded lifecycle state and the durable store summary. Read-only.
    --config <path>     Config file (default: as for \`run\`).
    --json              Machine-readable output.
                        Exit: 0 running, 3 installed but not running, 4 not installed / unknown.
`;

export interface ServiceCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** `remyral-worker service status`. Never changes anything on disk or in the service manager. */
export async function serviceStatusCommand(
  sys: System,
  ops: FileOps,
  host: PathHost,
  io: ServiceCommandIo,
  options: { configPath: string | undefined; json: boolean },
): Promise<number> {
  const report = await collectServiceStatus(sys, ops, host, { configPath: options.configPath });
  if ('error' in report) {
    io.stderr(`remyral-worker: ${report.error}\n`);
    return STATUS_EXIT.unknown;
  }
  io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatServiceStatus(report));
  return statusExitCode(report);
}
