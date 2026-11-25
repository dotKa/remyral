import { accountFolderReclaimArgs } from '../../accounts/accounts.js';
import { WINDOWS_JOBRUN_SHA256, runFile, type JobRunnerState, type RunFile } from './windows-jobrun.js';
import { unshareLoginStores, type LoginStoreCheck } from './windows-login-store.js';
import {
  checkWorkerTokenPrivileges,
  isMissingTokenPrivilegeError,
  loadSlotState,
  readSelfTestRecord,
  runSlotSelfTest,
  selfTestCurrent,
  SlotPool,
  type JobSlot,
  type SlotSelfTestRecord,
  type SlotState,
  type SlotStateLoad,
  serviceRestartDetail,
  type TokenPrivilegeCheck,
  writeSelfTestRecord,
} from './windows-slots.js';

/**
 * Owns the per-job account pool of a Windows worker (p9-windows-host-isolation): loads `slots.json`, keeps the
 * cross-access self-test result, decides whether host attempts may run in parallel and how many, and says why not.
 *
 * Usable only when all hold: the worker identity is verified (its SID is what the pool was prepared for), the job
 * runner is verified, `slots.json` is valid, and the self-test passed on this machine for this pool generation and
 * this job runner. Otherwise `concurrency()` is 1 — exactly the behaviour before this change.
 */

export interface SlotControllerDeps {
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  /** The worker's own SID (identity check); null when unknown/unverified. */
  readonly workerSid: string | null;
  readonly identityVerified: boolean;
  readonly jobRunner: () => JobRunnerState | undefined;
  readonly run?: RunFile;
  readonly env?: NodeJS.ProcessEnv;
  /** Tests: replaces the file reads/writes and the self-test. */
  readonly readState?: (path: string) => Promise<string>;
  readonly selfTest?: typeof runSlotSelfTest;
  readonly readRecord?: (dataDir: string) => Promise<SlotSelfTestRecord | null>;
  readonly writeRecord?: (dataDir: string, r: SlotSelfTestRecord) => Promise<void>;
  /** Tests: which job-runner privileges this process's token lacks (default: `whoami /priv`). */
  readonly tokenPrivileges?: () => Promise<TokenPrivilegeCheck>;
  /**
   * p9-windows-slots-local-login: the worker's subscription login stores (`windows-login-store.ts`
   * `loginStorePaths`). When non-empty, the pool is used only after they were proven not shared with the slots.
   */
  readonly loginStores?: readonly string[];
  /** Tests: replaces the login-store check. */
  readonly unshareLogin?: typeof unshareLoginStores;
  /**
   * p13-runtime-accounts: the folders of the added subscription accounts that exist now. On every verify those not lent
   * to a running attempt are taken back from any per-job account (owner + entries); lending needs that to pass.
   */
  readonly accountFolders?: () => Promise<readonly string[]>;
}

export interface SlotStatus {
  /** Per-job accounts are used (host attempts may run in parallel up to `concurrency`). */
  readonly active: boolean;
  readonly code?: string;
  readonly detail: string;
  readonly accounts: number;
  readonly healthy: number;
  readonly inUse: number;
  readonly selfTest: SlotSelfTestRecord | null;
}

export class WindowsSlotController {
  readonly #d: SlotControllerDeps;
  #load: SlotStateLoad | null = null;
  #pool: SlotPool | null = null;
  #record: SlotSelfTestRecord | null = null;
  #running: Promise<SlotSelfTestRecord | null> | null = null;
  /**
   * Privileges the pool needs that this process's token lacks (null = not checked / check unavailable). The token of
   * a process never gains privileges, so a non-empty result holds until the service restarts.
   */
  #tokenMissing: readonly string[] | null = null;
  /** Last login-store check (null: not run yet for this process). */
  #login: LoginStoreCheck | null = null;
  /** p13-runtime-accounts: account folders lent to a running attempt now (never reclaimed under it). */
  readonly #lent = new Map<string, number>();
  /** p13-runtime-accounts: the last account-folder reclaim (null: not run yet). */
  #accounts: { readonly ok: boolean; readonly detail?: string } | null = null;

  constructor(d: SlotControllerDeps) {
    this.#d = d;
  }

  get state(): SlotState | null {
    return this.#load?.ok === true ? this.#load.state : null;
  }

  get pool(): SlotPool | null {
    return this.#pool;
  }

  /** Reads `slots.json` and the stored self-test result; keeps running attempts on their accounts. */
  async reload(): Promise<void> {
    const load = await loadSlotState(this.#d.stateDir, this.#d.workerSid, this.#d.readState);
    this.#load = load;
    if (load.ok) {
      const pool = new SlotPool(load.slots);
      if (this.#pool !== null) pool.adopt(this.#pool);
      this.#pool = pool;
    } else if (this.#pool !== null && this.#pool.inUse() === 0) {
      this.#pool = null;
    }
    this.#record = await (this.#d.readRecord ?? readSelfTestRecord)(this.#d.dataDir);
  }

  /**
   * Runs the cross-access self-test unless a current passing result exists (`force`: always). Never throws; a
   * concurrent call shares the running test.
   */
  async verify(force = false): Promise<SlotSelfTestRecord | null> {
    if (this.#running !== null) return this.#running;
    this.#running = this.#verify(force).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #verify(force: boolean): Promise<SlotSelfTestRecord | null> {
    await this.reload();
    const load = this.#load;
    const jr = this.#d.jobRunner();
    if (load?.ok !== true || jr?.script === undefined || !jr.verified || !this.#d.identityVerified)
      return null;
    // p9-windows-slots-local-login: the subscription login store is never shared with the slots (checked and taken
    // back on every verify; cheap - one icacls listing per existing store).
    await this.checkLoginStores();
    await this.reclaimAccountFolders();
    if (!force && selfTestCurrent(this.#record, load.state)) return this.#record;
    // A valid pool means the privileged step granted the worker service its two privileges (LSA); whether this
    // process's token holds them is a separate question (live 2026-10-17: only a full service stop/start brings
    // them). Without them every slot fails with ERROR_NOT_ALL_ASSIGNED: say "restart the service" and keep no
    // failed record that would outlive the restart.
    if ((this.#tokenMissing?.length ?? 0) > 0) return null;
    const token = await (
      this.#d.tokenPrivileges ?? (() => checkWorkerTokenPrivileges(this.#d.run, this.#d.env))
    )().catch(() => null);
    if (token?.checked === true) {
      this.#tokenMissing = token.missing;
      if (token.missing.length > 0) return null;
    }
    const record = await (this.#d.selfTest ?? runSlotSelfTest)({
      state: load.state,
      slots: load.slots,
      stateDir: this.#d.stateDir,
      workspaceRoot: this.#d.workspaceRoot,
      dataDir: this.#d.dataDir,
      jobRunner: jr.script,
      ...(this.#d.run === undefined ? {} : { run: this.#d.run }),
      ...(this.#d.env === undefined ? {} : { env: this.#d.env }),
    });
    this.#record = record;
    await (this.#d.writeRecord ?? writeSelfTestRecord)(this.#d.dataDir, record).catch(() => undefined);
    return record;
  }

  /**
   * Proves that no login store of the worker grants the slot group (or a slot) access, removing an old grant
   * (p9-windows-slots-local-login). Never throws; the result gates `status()`.
   */
  async checkLoginStores(): Promise<LoginStoreCheck | null> {
    const paths = this.#d.loginStores ?? [];
    const load = this.#load;
    if (paths.length === 0 || load?.ok !== true || this.#d.workerSid === null) return null;
    this.#login = await (this.#d.unshareLogin ?? unshareLoginStores)({
      paths,
      workerSid: this.#d.workerSid,
      groupSid: load.state.group.sid,
      ...(this.#d.run === undefined ? {} : { run: this.#d.run }),
    }).catch((err: unknown): LoginStoreCheck => ({
      ok: false,
      code: 'job_slots_login_shared',
      detail: `login store check failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    }));
    return this.#login;
  }

  /** The last login-store check (null: not run / not applicable). */
  get loginStore(): LoginStoreCheck | null {
    return this.#login;
  }

  /** p13-runtime-accounts: an attempt's slot got Modify on this account folder (host runner). */
  markLent(folder: string): void {
    this.#lent.set(folder, (this.#lent.get(folder) ?? 0) + 1);
  }

  /** p13-runtime-accounts: the folder was taken back after the attempt's last process. */
  markReturned(folder: string): void {
    const n = (this.#lent.get(folder) ?? 1) - 1;
    if (n <= 0) this.#lent.delete(folder);
    else this.#lent.set(folder, n);
  }

  /**
   * p13-runtime-accounts: every account folder not lent right now is owned by the worker and grants no slot (group or
   * account) anything. Never throws; a failure keeps account logins off the per-job accounts (`accountLending`).
   */
  async reclaimAccountFolders(): Promise<void> {
    const load = this.#load;
    const list = this.#d.accountFolders;
    if (list === undefined || load?.ok !== true || this.#d.workerSid === null) return;
    const run = this.#d.run ?? runFile;
    try {
      const folders = (await list()).filter((f) => !this.#lent.has(f));
      const sids = [load.state.group.sid, ...load.slots.map((x) => x.sid)];
      for (const folder of folders) {
        for (const args of accountFolderReclaimArgs(folder, this.#d.workerSid, sids)) {
          const r = await run('icacls.exe', args, 600_000);
          // `/remove:g` of a SID without an entry exits 0; anything else is a real failure.
          if (r.code !== 0) {
            throw new Error(`icacls ${folder} ${args[1] ?? ''}: exit ${String(r.code)}`);
          }
        }
      }
      this.#accounts = { ok: true };
    } catch (err) {
      this.#accounts = {
        ok: false,
        detail:
          `account folders could not be taken back from the per-job accounts (${err instanceof Error ? err.message : String(err)})`.slice(
            0,
            300,
          ),
      };
    }
  }

  /**
   * p13-runtime-accounts: added subscription accounts may be lent to per-job accounts (the pool is active and the
   * account folders were taken back since this process started).
   */
  accountLending(): boolean {
    return this.status().active && (this.#d.accountFolders === undefined || this.#accounts?.ok === true);
  }

  status(): SlotStatus {
    const load = this.#load;
    const pool = this.#pool;
    const base = {
      accounts: load?.ok === true ? load.slots.length : 0,
      healthy: pool?.healthy() ?? 0,
      inUse: pool?.inUse() ?? 0,
      selfTest: this.#record,
    };
    if (!this.#d.identityVerified || this.#d.workerSid === null) {
      return {
        ...base,
        active: false,
        code: 'worker_identity_unsafe',
        detail: 'per-job accounts need the verified worker service account',
      };
    }
    if (load === null)
      return { ...base, active: false, code: 'job_slots_unchecked', detail: 'not checked yet' };
    if (!load.ok) return { ...base, active: false, code: load.code, detail: load.detail };
    const jr = this.#d.jobRunner();
    if (jr?.verified !== true) {
      return {
        ...base,
        active: false,
        code: 'job_runner_missing',
        detail: 'the job runner is not verified (run Prepare)',
      };
    }
    const tokenMissing = this.#tokenMissing ?? [];
    const r0 = this.#record;
    if (
      tokenMissing.length > 0 ||
      (this.#tokenMissing === null &&
        r0 !== null &&
        !r0.ok &&
        r0.generation === load.state.generation &&
        isMissingTokenPrivilegeError(r0.detail))
    ) {
      return {
        ...base,
        active: false,
        code: 'job_slots_service_restart',
        detail: serviceRestartDetail(tokenMissing),
      };
    }
    if ((this.#d.loginStores ?? []).length > 0) {
      const login = this.#login;
      if (login === null) {
        return {
          ...base,
          active: false,
          code: 'job_slots_unchecked',
          detail: 'checking that the subscription login store is not shared with the per-job accounts',
        };
      }
      if (!login.ok) return { ...base, active: false, code: login.code, detail: login.detail };
    }
    if (!selfTestCurrent(this.#record, load.state)) {
      const r = this.#record;
      const failed =
        r !== null &&
        !r.ok &&
        r.generation === load.state.generation &&
        r.jobRunnerSha === WINDOWS_JOBRUN_SHA256;
      return {
        ...base,
        active: false,
        code: failed ? 'job_slots_selftest_failed' : 'job_slots_unverified',
        detail: failed
          ? `cross-access self-test failed: ${r.detail}`
          : 'the cross-access self-test has not passed for these accounts yet (run Prepare)',
      };
    }
    if ((pool?.healthy() ?? 0) === 0) {
      return {
        ...base,
        active: false,
        code: 'job_slots_quarantined',
        detail: 'every per-job account is quarantined after a failed cleanup (run Prepare)',
      };
    }
    return {
      ...base,
      active: true,
      detail: `${String(base.healthy)} per-job account(s) for API-key runtimes (subscription logins run one at a time as the worker account, never shared with them); cross-access self-test passed ${this.#record?.at ?? ''}`,
    };
  }

  /** Parallel host attempts this worker can isolate: the healthy accounts (≥ 1), bounded by `maxParallelJobs`. */
  concurrency(maxParallelJobs: number): number {
    const s = this.status();
    if (!s.active) return 1;
    return Math.max(1, Math.min(s.healthy, Math.max(1, Math.floor(maxParallelJobs))));
  }

  /** The pool when per-job accounts are in use, else null (attempts run as the worker account, one at a time). */
  activePool(): SlotPool | null {
    return this.status().active ? this.#pool : null;
  }

  /** Releases of attempts that started before a pool became inactive still need the pool. */
  anyPool(): SlotPool | null {
    return this.#pool;
  }

  slotFor(attemptId: string): JobSlot | undefined {
    return this.#pool?.holder(attemptId);
  }
}
