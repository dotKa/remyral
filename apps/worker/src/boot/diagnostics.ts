import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  type BootVerdict,
  MAX_UPDATE_DIAGNOSTIC_LINE,
  MAX_UPDATE_DIAGNOSTIC_LINES,
  MAX_UPDATE_DIAGNOSTICS_BYTES,
  type UpdateDiagnostics,
} from '@remyral/protocol';
import type { Redactor } from '@remyral/observability';
import { pathApi } from '../config/paths.js';
import { BOOT_LOG } from './guard.js';

/**
 * p6-worker-boot-diagnostics: evidence for an update attempt that did not come up — collected by the privileged
 * updater right after a failed health check (before it switches back, so the service output is still the failed
 * version's), or by the daemon when it reports the attempt and the updater left none (an updater installed before
 * this change). Everything is bounded and redacted; it is display text for the panel's update history.
 */

/** Reads the end of a file (at most `maxBytes`, starting at a line boundary); null when absent / refused. */
export type TailReader = (path: string, maxBytes: number) => Promise<string | null>;

const TAIL_BYTES = 64 * 1024;
const BOOT_LINES = 20;
const SERVICE_LINES = 30;
const SHAWL_LINES = 12;
const UPDATER_LINES = 20;
/** Records of the failed version may be stamped slightly before the updater's restart timestamp. */
const SINCE_SLACK_MS = 10_000;

/**
 * Tail of a file that a less privileged account may control, for a privileged reader: the last component is not
 * followed (`O_NOFOLLOW`), only a regular file, and — on POSIX, when `ownerUid` is given — only a file owned by
 * that account (a hard link to a root-owned file is refused: the updater must never ship a file the worker
 * could not read itself). Never throws.
 */
export async function readTailSafe(
  path: string,
  maxBytes: number,
  opts: { ownerUid?: number | null } = {},
): Promise<string | null> {
  const flags =
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let handle;
  try {
    handle = await open(path, flags);
  } catch {
    return null;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    if (
      process.platform !== 'win32' &&
      opts.ownerUid !== undefined &&
      opts.ownerUid !== null &&
      st.uid !== opts.ownerUid
    ) {
      return null;
    }
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    let read = 0;
    while (read < buf.length) {
      const r = await handle.read(buf, read, buf.length - read, start + read);
      if (r.bytesRead === 0) break;
      read += r.bytesRead;
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface ParsedBootRecord {
  readonly raw: string;
  readonly event: string;
  readonly version: string;
  readonly at: number;
  readonly origin: string | null;
}

function parseBootLines(text: string): ParsedBootRecord[] {
  const out: ParsedBootRecord[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const r = JSON.parse(raw) as { event?: unknown; version?: unknown; ts?: unknown; origin?: unknown };
      if (typeof r.event !== 'string' || typeof r.version !== 'string' || typeof r.ts !== 'string') continue;
      out.push({
        raw,
        event: r.event,
        version: r.version,
        at: Date.parse(r.ts),
        origin: typeof r.origin === 'string' ? r.origin : null,
      });
    } catch {
      // not a boot record
    }
  }
  return out;
}

/** What the boot log says about `version` since `since` (see protocol `BootVerdict`). Pure. */
export function bootVerdict(bootLogText: string | null, version: string, since: Date | null): BootVerdict {
  if (bootLogText === null) return 'no_boot_log';
  const all = parseBootLines(bootLogText);
  if (all.length === 0) return 'no_boot_log';
  const from = since === null ? -Infinity : since.getTime() - SINCE_SLACK_MS;
  const mine = all.filter((r) => r.version === version && r.at >= from);
  if (!mine.some((r) => r.event === 'start')) return 'never_started';
  // A configuration / permission / keystore problem is a deliberate exit 78, not a crash.
  if (mine.some((r) => r.event === 'fatal' && r.origin !== 'config')) return 'crashed';
  if (mine.some((r) => r.event === 'exit' || r.event === 'fatal')) return 'exited';
  if (!mine.some((r) => r.event === 'ready')) return 'hung_before_ready';
  return 'started';
}

/** Where the service manager writes the worker's stdout/stderr (and, on Windows, shawl's own log). */
export function serviceOutputFiles(
  platform: NodeJS.Platform,
  env: (name: string) => string | undefined,
): { output: string | null; wrapper: string | null } {
  switch (platform) {
    case 'win32': {
      const p = pathApi('win32');
      const logs = p.join(
        env('ProgramData') ?? env('PROGRAMDATA') ?? 'C:\\ProgramData',
        'RemyralWorker',
        'logs',
      );
      // infra/worker/windows/install.ps1: shawl --log-dir <logs> --log-as shawl --log-cmd-as remyral-worker
      return {
        output: p.join(logs, 'remyral-worker_rCURRENT.log'),
        wrapper: p.join(logs, 'shawl_rCURRENT.log'),
      };
    }
    case 'darwin':
      // infra/worker/macos/com.remyral.worker.plist StandardOutPath / StandardErrorPath
      return { output: '/Library/Logs/RemyralWorker/remyral-worker.log', wrapper: null };
    default:
      return { output: null, wrapper: null }; // Linux: the journal (read by the updater with journalctl)
  }
}

function lastLines(text: string | null, n: number): string[] {
  if (text === null) return [];
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-n);
}

/** Service output without the JSON log lines of other versions (the restored version keeps appending). */
function outputOf(text: string | null, version: string, n: number): string[] {
  return lastLines(text, n * 4)
    .filter((l) => {
      if (!l.startsWith('{')) return true;
      try {
        const v = (JSON.parse(l) as { version?: unknown }).version;
        return typeof v !== 'string' || v === version;
      } catch {
        return true;
      }
    })
    .slice(-n);
}

export interface CollectDiagnosticsOptions {
  readonly collectedBy: 'updater' | 'worker';
  readonly platform: NodeJS.Platform;
  readonly env: (name: string) => string | undefined;
  readonly dataDir: string;
  /** `<installDir>/state/updater.log` (null: not read). */
  readonly updaterLog: string | null;
  /** The version that failed. */
  readonly version: string;
  /** When it was (re)started; null: unknown. */
  readonly since: Date | null;
  readonly read: TailReader;
  /** Linux updater: the service's journal since `since` (fixed `journalctl` arguments). */
  readonly journal?: () => Promise<string | null>;
  readonly restartErrors?: readonly string[];
  readonly redactor: Pick<Redactor, 'redact'>;
}

export async function collectUpdateDiagnostics(o: CollectDiagnosticsOptions): Promise<UpdateDiagnostics> {
  const p = pathApi(o.platform);
  const bootText = await o.read(p.join(o.dataDir, 'logs', BOOT_LOG), TAIL_BYTES);
  const verdict = bootVerdict(bootText, o.version, o.since);
  const records = bootText === null ? [] : parseBootLines(bootText);
  const from = o.since === null ? -Infinity : o.since.getTime() - SINCE_SLACK_MS;
  const mine = records.filter((r) => r.version === o.version && r.at >= from).map((r) => r.raw);
  // Nothing of the failed version: the last records of any version show what did run.
  const bootLog = (mine.length > 0 ? mine : records.map((r) => r.raw)).slice(-BOOT_LINES);

  const files = serviceOutputFiles(o.platform, o.env);
  const serviceOutput: string[] = [];
  if (files.output !== null) {
    serviceOutput.push(...outputOf(await o.read(files.output, TAIL_BYTES), o.version, SERVICE_LINES));
  }
  if (files.wrapper !== null) {
    serviceOutput.push(
      ...lastLines(await o.read(files.wrapper, TAIL_BYTES), SHAWL_LINES).map((l) => `[shawl] ${l}`),
    );
  }
  if (o.journal !== undefined) {
    serviceOutput.push(...outputOf(await o.journal().catch(() => null), o.version, SERVICE_LINES));
  }
  const updaterLog =
    o.updaterLog === null ? [] : lastLines(await o.read(o.updaterLog, TAIL_BYTES), UPDATER_LINES);

  const clean = (lines: readonly string[], max = MAX_UPDATE_DIAGNOSTIC_LINES): string[] =>
    lines.slice(-max).map((l) => {
      const r = o.redactor.redact(l);
      return r.length > MAX_UPDATE_DIAGNOSTIC_LINE ? `${r.slice(0, MAX_UPDATE_DIAGNOSTIC_LINE - 1)}…` : r;
    });
  const d = {
    collectedBy: o.collectedBy,
    verdict,
    bootLog: clean(bootLog),
    serviceOutput: clean(serviceOutput),
    updaterLog: clean(updaterLog),
    restartErrors: (o.restartErrors ?? []).slice(-6).map((e) => o.redactor.redact(e).slice(0, 500)),
    redacted: true as const,
  };
  return fitDiagnostics(d);
}

/** Drops the oldest lines (updater log first, then service output, then boot log) until the bound holds. */
export function fitDiagnostics(d: UpdateDiagnostics): UpdateDiagnostics {
  const out = {
    ...d,
    bootLog: [...(d.bootLog ?? [])],
    serviceOutput: [...(d.serviceOutput ?? [])],
    updaterLog: [...(d.updaterLog ?? [])],
  };
  const size = () => Buffer.byteLength(JSON.stringify(out), 'utf8');
  for (const key of ['updaterLog', 'serviceOutput', 'bootLog'] as const) {
    while (size() > MAX_UPDATE_DIAGNOSTICS_BYTES && out[key].length > 0) out[key].shift();
  }
  const { bootLog, serviceOutput, updaterLog, restartErrors, ...rest } = out;
  return {
    ...rest,
    ...(bootLog.length > 0 ? { bootLog } : {}),
    ...(serviceOutput.length > 0 ? { serviceOutput } : {}),
    ...(updaterLog.length > 0 ? { updaterLog } : {}),
    ...(restartErrors !== undefined && restartErrors.length > 0 ? { restartErrors } : {}),
  };
}
