import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  appendFile,
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Logger } from '@remyral/observability';
import {
  type AdminOp,
  adminGrantWindow,
  adminOpDigest,
  type LeaseKey,
  MAX_ADMIN_SESSION_MS,
  verifyAdminCommand,
  verifyAdminSession,
} from '@remyral/protocol';
import { INSTALLER_WORKER_USERS, windowsServiceSid } from '../../sandbox/host/identity.js';
import {
  ADMIN_HEARTBEAT_MS,
  ADMIN_HELPER_MARKER,
  AdminCommandRequest,
  type AdminCommandResult,
  AdminSessionRequest,
  type AdminSessionStatus,
  brokerDir,
  brokerResultPath,
  brokerStatusPath,
  brokerWorkDir,
  commandRequestDir,
  endMarkerPath,
  heartbeatPath,
  MAX_ADMIN_REQUEST_BYTES,
  sessionRequestPath,
} from '../../machine-admin/shared.js';
import { ADMIN_BINDING_MARKER, adminBindCommand, type BindingRead } from '../../machine-admin/binding.js';
import { readUntrustedFile, UnsafeFileError } from '../files.js';
import type { HostConfinement } from './host-confinement.js';
import { fetchMasterLeaseKeys, masterOrigin } from './prepare.js';

/**
 * The elevated broker of AI machine administration (p5-machine-admin, ADR-0021) — part of the root/SYSTEM helper
 * of p2-signed-updates (`remyral-worker-updater.mjs admin-session`), never of the worker.
 *
 * Started by the OS for a pending session request (Windows: the SYSTEM scheduled task `RemyralWorkerAdmin`, every
 * minute; Linux: `remyral-worker-admin.path` → `.service`; macOS: the `com.remyral.worker.admin` LaunchDaemon's
 * WatchPaths). It
 *  1. reads `<dataDir>/machine-admin/session-request.json` defensively and refuses it unless the session grant is
 *     signed by the master (pinned `masterLeaseKeys`, else keys it fetches over TLS itself), inside a window of at
 *     most 12 h, not seen before, and the root-owned config does not veto machine administration
 *     (`localCeiling.allowMachineAdmin: false`);
 *  2. runs the session in the foreground: every request file in the session's request dir must carry a master
 *     grant bound to this worker, job, attempt, epoch, the request id, a ≤ 5-minute window and the operation
 *     digest; replays are refused; then the operation runs as root / SYSTEM (exec, write_file, read_file);
 *  3. answers only in its own install dir (`<install>/state/machine-admin/<sessionId>/`, readable by the worker's
 *     service account and nobody else) and never writes into the worker's data dir;
 *  4. ends when the grant expires, the worker writes the end marker, or the worker's heartbeat goes stale.
 *
 * It logs request ids, kinds, digests and exit codes — never command text or output (the master keeps the
 * command log; the helper's own log is not redacted).
 *
 * Marker for the worker: remana-admin-helper/v1 (ADMIN_HELPER_MARKER).
 */
export const ADMIN_HELPER = ADMIN_HELPER_MARKER;
/** This helper binds sessions to the machine's recorded worker id (machine-admin/binding.ts). */
export const ADMIN_BINDING = ADMIN_BINDING_MARKER;

const OUTPUT_TAIL = 64 * 1024;
const SEEN_FILE = 'admin-seen.json';

export interface AdminExecSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  /** Windows `cmd.exe /s /c "…"` needs the command line exactly as given. */
  readonly verbatim?: boolean;
}

export interface AdminExecResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly spawnError?: string;
}

export type AdminExec = (spec: AdminExecSpec) => Promise<AdminExecResult>;

export interface AdminHelperDeps {
  readonly platform: NodeJS.Platform;
  readonly dataDir: string;
  readonly installDir: string;
  readonly pinnedKeys: readonly LeaseKey[] | null;
  readonly masterUrl: string;
  /** False when the root-owned config sets `localCeiling.allowMachineAdmin: false`. */
  readonly allowMachineAdmin: boolean;
  /**
   * The worker id this machine's helper serves, from the root-owned `<install>/state/admin-binding.json`. Sessions
   * are refused while it is missing or invalid, and for any other worker id (one master signs for every worker).
   */
  readonly binding: BindingRead;
  /**
   * Security fix (host profile without confinement): root's own check whether host jobs here can be confined
   * (host-confinement.ts). While they cannot, sessions are refused unless the owner opted in explicitly
   * (`localCeiling.allowMachineAdmin: true`). Absent (tests): not checked.
   */
  readonly hostConfinement?: () => Promise<HostConfinement>;
  readonly machineAdminOptIn?: boolean;
  /** The root-owned config file (named in refusals). */
  readonly configPath?: string;
  /** The Node binary for the owner's `admin-bind` command line in refusals (default: this process's). */
  readonly nodePath?: string;
  readonly logger: Logger;
  readonly fetchKeys?: (origin: string) => Promise<readonly LeaseKey[]>;
  readonly now?: () => Date;
  readonly exec?: AdminExec;
  /** Restricts the broker dir to SYSTEM/root, admins and the worker's service account (tests: a no-op). */
  readonly protectDir?: (dir: string) => Promise<void>;
  readonly pollMs?: number;
  /** A session whose worker heartbeat is older than this ends (default 3 × heartbeat). */
  readonly heartbeatMaxAgeMs?: number;
  /** How long a fresh session may wait for the first heartbeat (default 2 min). */
  readonly startGraceMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

export interface AdminSessionOutcome {
  readonly state: 'idle' | 'refused' | 'ended';
  readonly sessionId?: string;
  readonly reason?: string;
  readonly commands: number;
}

function tail(s: string): { text: string; cut: boolean } {
  return s.length > OUTPUT_TAIL ? { text: s.slice(-OUTPUT_TAIL), cut: true } : { text: s, cut: false };
}

/** Spawns without a shell; kills the whole tree on timeout. */
export const nodeAdminExec: AdminExec = (spec) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn(spec.file, [...spec.args], {
      cwd: spec.cwd,
      env: spec.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(spec.verbatim === true ? { windowsVerbatimArguments: true } : {}),
    });
    const keep = (prev: string, chunk: Buffer): string => {
      const next = prev + chunk.toString('utf8');
      if (next.length > OUTPUT_TAIL * 2) {
        truncated = true;
        return next.slice(-OUTPUT_TAIL);
      }
      return next;
    };
    child.stdout.on('data', (c: Buffer) => {
      stdout = keep(stdout, c);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr = keep(stderr, c);
    });
    const kill = (): void => {
      timedOut = true;
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), [
          '/T',
          '/F',
          '/PID',
          String(child.pid),
        ]);
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
    };
    const timer = setTimeout(kill, spec.timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, truncated, timedOut, spawnError: err.code ?? err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const o = tail(stdout);
      const e = tail(stderr);
      resolve({
        exitCode: code,
        stdout: o.text,
        stderr: e.text,
        truncated: truncated || o.cut || e.cut,
        timedOut,
      });
    });
  });

async function sha256File(path: string, maxBytes = 64 * 1024 * 1024): Promise<string | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > maxBytes) return null;
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return null;
  }
}

export class AdminHelper {
  readonly #d: AdminHelperDeps;
  readonly #seenPath: string;

  constructor(d: AdminHelperDeps) {
    this.#d = d;
    this.#seenPath = join(d.installDir, 'state', SEEN_FILE);
  }

  #now(): Date {
    return this.#d.now?.() ?? new Date();
  }

  #sleep(ms: number): Promise<void> {
    return this.#d.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));
  }

  async #seen(): Promise<Record<string, number>> {
    try {
      const raw = JSON.parse(await readFile(this.#seenPath, 'utf8')) as unknown;
      return raw !== null && typeof raw === 'object' ? (raw as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  async #remember(id: string, until: number): Promise<void> {
    const now = this.#now().getTime();
    const seen = Object.fromEntries(Object.entries(await this.#seen()).filter(([, t]) => t > now));
    seen[id] = until;
    await mkdir(dirname(this.#seenPath), { recursive: true });
    await writeFile(this.#seenPath, JSON.stringify(seen), { mode: 0o600 });
  }

  async #writeJson(path: string, value: unknown): Promise<void> {
    const tmp = `${path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o640 });
    if (this.#d.platform !== 'win32') await chmod(tmp, 0o640);
    await rename(tmp, path);
  }

  async #status(
    sessionId: string,
    s: Omit<AdminSessionStatus, 'v' | 'sessionId' | 'updatedAt'>,
  ): Promise<void> {
    await this.#writeJson(brokerStatusPath(this.#d.installDir, sessionId), {
      v: 1,
      sessionId,
      ...s,
      updatedAt: this.#now().toISOString(),
    } satisfies AdminSessionStatus);
  }

  /** The installer's protection of the broker dir: only SYSTEM/root, admins and the worker account can read it. */
  async #protect(dir: string): Promise<void> {
    if (this.#d.protectDir !== undefined) return this.#d.protectDir(dir);
    if (this.#d.platform === 'win32') {
      const sid = windowsServiceSid('RemyralWorker');
      const r = await (this.#d.exec ?? nodeAdminExec)({
        file: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
        args: [
          dir,
          '/inheritance:r',
          '/grant:r',
          '*S-1-5-18:(OI)(CI)F',
          '*S-1-5-32-544:(OI)(CI)F',
          `*${sid}:(OI)(CI)RX`,
          '/Q',
        ],
        cwd: dir,
        timeoutMs: 60_000,
        env: process.env,
      });
      if (r.exitCode !== 0) throw new Error(`icacls failed (${String(r.exitCode)})`);
      return;
    }
    const user = INSTALLER_WORKER_USERS[this.#d.platform];
    const r = await (this.#d.exec ?? nodeAdminExec)({
      file: '/usr/bin/id',
      args: ['-g', user ?? 'remyral-worker'],
      cwd: '/',
      timeoutMs: 10_000,
      env: { PATH: '/usr/bin:/bin' },
    });
    const gid = Number(r.stdout.trim());
    if (r.exitCode !== 0 || !Number.isInteger(gid)) throw new Error(`group of ${user ?? '?'} unknown`);
    await chown(dir, 0, gid);
    // setgid: result files written by root inherit the worker's group (0640 → readable by the worker only).
    await chmod(dir, 0o2750);
    // The parent `<install>/state/machine-admin` was created by root as 0750: the worker could not reach its own
    // session dir and every session ended in helper_not_started. 0711: the worker may pass through to the session id
    // it knows, but cannot list the other sessions.
    await chmod(dirname(dir), 0o711);
  }

  /**
   * Processes a pending session request, if any, and runs the session to its end. Returns `idle` when there is
   * nothing to do (the OS trigger fires on every change of the request dir).
   */
  async runPending(): Promise<AdminSessionOutcome> {
    const log = this.#d.logger;
    let raw: Buffer | null;
    try {
      raw = await readUntrustedFile(sessionRequestPath(this.#d.dataDir), MAX_ADMIN_REQUEST_BYTES);
    } catch (err) {
      log.warn('admin session request refused', {
        reason: err instanceof UnsafeFileError ? err.message : 'unreadable',
      });
      return { state: 'idle', commands: 0 };
    }
    if (raw === null) return { state: 'idle', commands: 0 };
    let req: AdminSessionRequest;
    try {
      req = AdminSessionRequest.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      log.warn('admin session request is not a valid document; ignored');
      return { state: 'idle', commands: 0 };
    }
    const sessionId = req.session.sessionId;
    if ((await this.#seen())[sessionId] !== undefined) return { state: 'idle', commands: 0 };
    const dir = brokerDir(this.#d.installDir, sessionId);
    await mkdir(dir, { recursive: true, mode: 0o750 });
    await this.#protect(dir);
    const refuse = async (reason: string, detail: string): Promise<AdminSessionOutcome> => {
      await this.#remember(sessionId, this.#now().getTime() + 24 * 3600_000);
      await this.#status(sessionId, { state: 'refused', reason, detail: detail.slice(0, 500) });
      log.warn('admin session refused', { sessionId, reason });
      return { state: 'refused', sessionId, reason, commands: 0 };
    };
    if (!this.#d.allowMachineAdmin) {
      return refuse(
        'disabled_locally',
        'the local config forbids machine administration (localCeiling.allowMachineAdmin)',
      );
    }
    // Bound to THIS machine: the request's worker id is the service account's claim; the binding is root's.
    const bind = adminBindCommand(this.#d.platform, this.#d.nodePath ?? process.execPath, this.#d.installDir);
    if (this.#d.binding.state !== 'bound') {
      return refuse(
        'helper_not_bound',
        `${this.#d.binding.state === 'invalid' ? `${this.#d.binding.detail}. ` : ''}machine administration on this machine is not bound to its worker yet; run once as root / Administrator: ${bind} (or re-run the installer kit)`,
      );
    }
    if (req.workerId !== this.#d.binding.binding.workerId) {
      return refuse(
        'wrong_worker',
        `the session is signed for worker ${req.workerId}, this machine serves ${this.#d.binding.binding.workerId} (paired again? then: ${bind} --replace)`,
      );
    }
    const window = adminGrantWindow(req.session, this.#now(), MAX_ADMIN_SESSION_MS);
    if (window !== 'ok') return refuse(window, 'the session grant is outside its validity window');
    let keys: readonly LeaseKey[];
    try {
      keys =
        this.#d.pinnedKeys ??
        (await (this.#d.fetchKeys ?? fetchMasterLeaseKeys)(masterOrigin(this.#d.masterUrl)));
    } catch (err) {
      return refuse(
        'keys_unavailable',
        `cannot obtain the master's lease keys: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const binding = {
      workerId: req.workerId,
      jobId: req.jobId,
      attemptId: req.attemptId,
      epoch: req.epoch,
      sessionId,
      issuedAt: req.session.issuedAt,
      expiresAt: req.session.expiresAt,
    };
    const verdict = verifyAdminSession(binding, req.session.signature, keys);
    if (verdict !== 'ok') {
      return refuse(
        verdict === 'missing' ? 'unsigned' : 'bad_signature',
        'the session grant is not signed by the master',
      );
    }
    // Job code of an unconfined host attempt runs as the service account: with machine administration that is a path
    // to root. Checked after the signature (it starts processes), before anything runs.
    if (this.#d.hostConfinement !== undefined && this.#d.machineAdminOptIn !== true) {
      const host = await this.#d.hostConfinement().catch((err: unknown): HostConfinement => ({
        confined: false,
        detail: `the check failed: ${err instanceof Error ? err.message : String(err)}`,
      }));
      if (!host.confined) {
        return refuse(
          'host_unconfined',
          `host jobs on this machine run without filesystem confinement: ${host.detail}. Machine administration is refused in this state unless the owner opts in: localCeiling.allowMachineAdmin: true in ${this.#d.configPath ?? 'the worker config'} (root / Administrator), then restart the worker`,
        );
      }
    }
    const expiresAt = Date.parse(req.session.expiresAt);
    await this.#remember(sessionId, expiresAt + 24 * 3600_000);
    await mkdir(brokerWorkDir(this.#d.installDir, sessionId), { recursive: true, mode: 0o700 });
    await this.#status(sessionId, { state: 'ready', pid: process.pid, expiresAt: req.session.expiresAt });
    log.info('admin session started', { sessionId, jobId: req.jobId, attemptId: req.attemptId });
    const commands = await this.#loop(req, keys, expiresAt);
    await this.#cleanup(sessionId);
    await this.#status(sessionId, { state: 'ended', reason: commands.reason });
    log.info('admin session ended', { sessionId, reason: commands.reason, commands: commands.count });
    return { state: 'ended', sessionId, reason: commands.reason, commands: commands.count };
  }

  async #loop(
    req: AdminSessionRequest,
    keys: readonly LeaseKey[],
    expiresAt: number,
  ): Promise<{ reason: string; count: number }> {
    const sessionId = req.session.sessionId;
    const started = this.#now().getTime();
    const processed = new Set<string>();
    let count = 0;
    const pollMs = this.#d.pollMs ?? 250;
    const maxAge = this.#d.heartbeatMaxAgeMs ?? ADMIN_HEARTBEAT_MS * 3;
    const grace = this.#d.startGraceMs ?? 120_000;
    for (;;) {
      if (this.#d.signal?.aborted === true) return { reason: 'stopped', count };
      const now = this.#now().getTime();
      if (now > expiresAt) return { reason: 'expired', count };
      if ((await lstat(endMarkerPath(this.#d.dataDir, sessionId)).catch(() => null)) !== null) {
        return { reason: 'ended_by_worker', count };
      }
      const hb = await lstat(heartbeatPath(this.#d.dataDir, sessionId)).catch(() => null);
      const last = hb?.mtimeMs ?? null;
      if (last === null ? now - started > grace : now - last > maxAge)
        return { reason: 'worker_gone', count };
      const names = await readdir(commandRequestDir(this.#d.dataDir, sessionId)).catch(() => [] as string[]);
      for (const name of names.sort()) {
        if (!/^[0-9a-f-]{36}\.json$/.test(name) || processed.has(name)) continue;
        processed.add(name);
        await this.#command(req, keys, join(commandRequestDir(this.#d.dataDir, sessionId), name));
        count += 1;
      }
      await this.#sleep(pollMs);
    }
  }

  async #command(req: AdminSessionRequest, keys: readonly LeaseKey[], file: string): Promise<void> {
    const log = this.#d.logger;
    const sessionId = req.session.sessionId;
    let cmd: AdminCommandRequest;
    try {
      const raw = await readUntrustedFile(file, MAX_ADMIN_REQUEST_BYTES);
      if (raw === null) return;
      cmd = AdminCommandRequest.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      log.warn('admin command request unreadable or invalid; ignored', { sessionId });
      return;
    }
    const started = Date.now();
    const answer = (r: Omit<AdminCommandResult, 'v' | 'requestId' | 'durationMs'>): Promise<void> =>
      this.#writeJson(brokerResultPath(this.#d.installDir, sessionId, cmd.requestId), {
        v: 1,
        requestId: cmd.requestId,
        durationMs: Date.now() - started,
        ...r,
      } satisfies AdminCommandResult);
    const refused = (reason: string, detail: string) =>
      answer({ state: 'refused', reason, stdout: '', stderr: detail, truncated: false });
    if (!file.endsWith(`${cmd.requestId}.json`))
      return refused('request_mismatch', 'file name and request id differ');
    const seenKey = `cmd:${cmd.requestId}`;
    if ((await this.#seen())[seenKey] !== undefined)
      return refused('replayed', 'this request id ran already');
    const window = adminGrantWindow(cmd.grant, this.#now());
    if (window !== 'ok') return refused(window, 'the command grant is outside its validity window');
    const verdict = verifyAdminCommand(
      {
        workerId: req.workerId,
        jobId: req.jobId,
        attemptId: req.attemptId,
        epoch: req.epoch,
        requestId: cmd.requestId,
        issuedAt: cmd.grant.issuedAt,
        expiresAt: cmd.grant.expiresAt,
        op: cmd.op,
      },
      cmd.grant.signature,
      keys,
    );
    if (verdict !== 'ok')
      return refused('bad_signature', 'the command is not signed by the master for this session');
    await this.#remember(seenKey, Date.parse(cmd.grant.expiresAt) + 24 * 3600_000);
    const digest = adminOpDigest(cmd.op);
    log.info('admin command accepted', { sessionId, requestId: cmd.requestId, kind: cmd.op.kind, digest });
    try {
      const result = await this.#execute(sessionId, cmd.requestId, cmd.op);
      await answer(result);
      log.info('admin command finished', {
        sessionId,
        requestId: cmd.requestId,
        state: result.state,
        exitCode: result.exitCode ?? null,
      });
    } catch (err) {
      await answer({
        state: 'failed',
        reason: 'broker_error',
        stdout: '',
        stderr: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        truncated: false,
      });
    }
  }

  #env(): NodeJS.ProcessEnv {
    const env = { ...(this.#d.env ?? process.env) };
    if (this.#d.platform !== 'win32') {
      env.PATH ??= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
      env.HOME ??= this.#d.platform === 'darwin' ? '/var/root' : '/root';
      env.LANG ??= 'C.UTF-8';
    }
    return env;
  }

  async #execute(
    sessionId: string,
    requestId: string,
    op: AdminOp,
  ): Promise<Omit<AdminCommandResult, 'v' | 'requestId' | 'durationMs'>> {
    const exec = this.#d.exec ?? nodeAdminExec;
    const work = brokerWorkDir(this.#d.installDir, sessionId);
    if (op.kind === 'exec') {
      const cwd = op.cwd ?? work;
      if (!isAbsolute(cwd))
        return { state: 'refused', reason: 'cwd_not_absolute', stdout: '', stderr: '', truncated: false };
      const sysRoot = (this.#d.env ?? process.env).SystemRoot ?? 'C:\\Windows';
      let spec: AdminExecSpec;
      let script: string | null = null;
      if (op.shell === 'powershell') {
        if (this.#d.platform !== 'win32') {
          return {
            state: 'refused',
            reason: 'shell_unsupported',
            stdout: '',
            stderr: 'powershell is a Windows shell here',
            truncated: false,
          };
        }
        script = join(work, `cmd-${requestId}.ps1`);
        // UTF-8 with BOM: Windows PowerShell 5.1 reads a BOM-less script as the ANSI code page.
        await writeFile(
          script,
          `\uFEFF[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n${op.command.replace(/\r?\n/g, '\r\n')}\r\n`,
          { mode: 0o600 },
        );
        spec = {
          file: join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          cwd,
          timeoutMs: op.timeoutSec * 1000,
          env: this.#env(),
        };
      } else if (op.shell === 'cmd') {
        if (this.#d.platform !== 'win32') {
          return {
            state: 'refused',
            reason: 'shell_unsupported',
            stdout: '',
            stderr: 'cmd is a Windows shell',
            truncated: false,
          };
        }
        if (op.command.length > 8000) {
          return {
            state: 'refused',
            reason: 'command_too_long',
            stdout: '',
            stderr: 'cmd.exe takes at most 8191 characters; use powershell',
            truncated: false,
          };
        }
        spec = {
          file: join(sysRoot, 'System32', 'cmd.exe'),
          args: ['/d', '/s', '/c', `"${op.command}"`],
          cwd,
          timeoutMs: op.timeoutSec * 1000,
          env: this.#env(),
          verbatim: true,
        };
      } else {
        if (this.#d.platform === 'win32') {
          return {
            state: 'refused',
            reason: 'shell_unsupported',
            stdout: '',
            stderr: `${op.shell} is not available on Windows; use powershell`,
            truncated: false,
          };
        }
        spec = {
          file: op.shell === 'bash' ? '/bin/bash' : '/bin/sh',
          args: ['-c', op.command],
          cwd,
          timeoutMs: op.timeoutSec * 1000,
          env: this.#env(),
        };
      }
      try {
        const r = await exec(spec);
        if (r.spawnError !== undefined) {
          return {
            state: 'failed',
            reason: 'spawn_failed',
            exitCode: null,
            stdout: '',
            stderr: r.spawnError,
            truncated: false,
          };
        }
        return {
          state: r.exitCode === 0 && !r.timedOut ? 'succeeded' : 'failed',
          ...(r.timedOut ? { reason: 'timeout' } : r.exitCode === 0 ? {} : { reason: 'nonzero_exit' }),
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          truncated: r.truncated,
        };
      } finally {
        if (script !== null) await rm(script, { force: true }).catch(() => undefined);
      }
    }
    if (op.kind === 'write_file') {
      const bytes = Buffer.from(op.content, 'base64');
      const before = await sha256File(op.path);
      const exists = (await lstat(op.path).catch(() => null)) !== null;
      if (op.mode === 'create' && exists) {
        return {
          state: 'failed',
          reason: 'file_exists',
          stdout: '',
          stderr: `${op.path} exists`,
          truncated: false,
        };
      }
      if (op.mode === 'append') await appendFile(op.path, bytes);
      else await writeFile(op.path, bytes, { flag: op.mode === 'create' ? 'wx' : 'w' });
      const after = await sha256File(op.path);
      return {
        state: 'succeeded',
        exitCode: 0,
        stdout: `${op.mode === 'append' ? 'appended' : 'wrote'} ${String(bytes.length)} bytes`,
        stderr: '',
        truncated: false,
        file: { path: op.path, bytes: bytes.length, sha256Before: before, sha256After: after },
      };
    }
    // read_file
    const flags = constants.O_RDONLY;
    const fh = await open(op.path, flags);
    try {
      const st = await fh.stat();
      if (!st.isFile())
        return {
          state: 'failed',
          reason: 'not_a_file',
          stdout: '',
          stderr: `${op.path} is not a file`,
          truncated: false,
        };
      const n = Math.min(st.size, op.maxBytes);
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, 0);
      return {
        state: 'succeeded',
        exitCode: 0,
        stdout: '',
        stderr: '',
        truncated: st.size > op.maxBytes,
        file: {
          path: op.path,
          bytes: bytesRead,
          sha256Before: await sha256File(op.path),
          sha256After: null,
          content: buf.subarray(0, bytesRead).toString('base64'),
        },
      };
    } finally {
      await fh.close();
    }
  }

  /** Command results may hold sensitive output: they are removed when the session ends. */
  async #cleanup(sessionId: string): Promise<void> {
    const dir = brokerDir(this.#d.installDir, sessionId);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      if (n === 'status.json') continue;
      await rm(join(dir, n), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
