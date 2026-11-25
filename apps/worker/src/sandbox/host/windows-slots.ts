import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  jobRunnerArgs,
  powershellExe,
  runFile,
  WINDOWS_JOBRUN_SHA256,
  type JobRunnerSpec,
  type RunFile,
} from './windows-jobrun.js';

/**
 * Per-job Windows accounts for concurrent host-restricted attempts (p9-windows-host-isolation, T-SBX-4).
 *
 * Without per-attempt filesystem confinement every host attempt ran as the worker service account, so two
 * attempts could read and modify each other's workspaces and the worker refused a second one. On Windows each
 * concurrent attempt now runs as its own low-privilege local account `remyral-job-<n>` from a small pool:
 *
 *  - the privileged Prepare (`remyral-job-slots.ps1`, run as SYSTEM by the helper) creates/rotates the accounts, the
 *    group `remyral-job-slots` (batch logon only; interactive, RDP, network and service logon denied), a random
 *    password per account stored only as a DPAPI LocalMachine blob in `<config dir>\job-slots\` (SYSTEM,
 *    Administrators and the worker service may read it — never a slot account) and `slots.json`;
 *  - the worker restricts each attempt's directories to SYSTEM, Administrators, the worker (full) and the attempt's
 *    slot account (modify), with an `OWNER RIGHTS` entry that takes away the owner's implicit right to rewrite the
 *    permissions of the files it creates, and starts the runtime through the job runner as that account;
 *  - before running host attempts in parallel the worker proves on this machine that slot A cannot read or write
 *    slot B's workspace, the worker data dir or the credential files (cross-access self-test, below). Until it has
 *    passed for the current pool generation, host attempts stay one at a time (today's behaviour).
 *
 * Everything here is pure or takes an injectable runner; the Windows-only parts are UNVERIFIED on a real machine.
 */

export const SLOT_GROUP = 'remyral-job-slots';
export const SLOT_USER_PATTERN = /^remyral-job-([1-9][0-9]?)$/;
export const MAX_SLOTS = 16;
/** Accounts the helper provisions when the config does not say (`sandbox.windowsJobSlots`). */
export const DEFAULT_SLOT_COUNT = 4;
/** Folder next to config.json (admin-owned; the worker may only read it). */
export const SLOT_STATE_DIR = 'job-slots';
export const SLOTS_FILE = 'slots.json';
export const SELFTEST_FILE = 'job-slots-selftest.json';

const SID = /^S-1-5(-\d{1,10}){1,14}$/;
const Sid = z.string().regex(SID);

const WIN_SYSTEM = 'S-1-5-18';
const WIN_ADMINISTRATORS = 'S-1-5-32-544';
/** OWNER RIGHTS: limits what the owner of a file may do beyond the explicit entries (no implicit WRITE_DAC). */
const WIN_OWNER_RIGHTS = 'S-1-3-4';

export const SlotState = z
  .object({
    v: z.literal(1),
    generation: z.string().regex(/^[0-9a-f-]{36}$/),
    provisionedAt: z.string().max(40),
    group: z.object({ name: z.literal(SLOT_GROUP), sid: Sid }),
    workerSid: Sid,
    slots: z
      .array(
        z.object({
          index: z.number().int().min(1).max(MAX_SLOTS),
          user: z.string().regex(SLOT_USER_PATTERN),
          sid: Sid,
        }),
      )
      .min(1)
      .max(MAX_SLOTS),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    for (const slot of s.slots) {
      if (slot.user !== `remyral-job-${String(slot.index)}`) {
        ctx.addIssue({ code: 'custom', message: `slot ${String(slot.index)} is not named after its index` });
      }
      for (const key of [slot.user, slot.sid, `#${String(slot.index)}`]) {
        if (seen.has(key)) ctx.addIssue({ code: 'custom', message: `duplicate slot ${key}` });
        seen.add(key);
      }
      if (slot.sid === s.workerSid || slot.sid === s.group.sid) {
        ctx.addIssue({ code: 'custom', message: 'a slot SID equals the worker or group SID' });
      }
    }
  });
export type SlotState = z.infer<typeof SlotState>;

export interface JobSlot {
  readonly index: number;
  readonly user: string;
  readonly sid: string;
  /** DPAPI blob of the account's password (read by the job runner, never by the worker's JS). */
  readonly credentialFile: string;
}

export function slotStateDir(configDir: string): string {
  return join(configDir, SLOT_STATE_DIR);
}

export function slotsOf(state: SlotState, stateDir: string): JobSlot[] {
  return [...state.slots]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ ...s, credentialFile: join(stateDir, `${s.user}.cred`) }));
}

/**
 * Slot count the helper provisions: `sandbox.windowsJobSlots`, else max(maxParallelJobs, 4), within 1..16; 0 when
 * the owner turned per-job accounts off (`windowsJobSlots: 0`).
 */
export function provisionCount(configured: number | undefined, maxParallelJobs: number | undefined): number {
  if (configured === 0) return 0;
  const want = configured ?? Math.max(maxParallelJobs ?? 1, DEFAULT_SLOT_COUNT);
  return Math.min(MAX_SLOTS, Math.max(1, Math.floor(want)));
}

export type SlotStateLoad =
  | { readonly ok: true; readonly state: SlotState; readonly slots: readonly JobSlot[] }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/** Reads `slots.json`; never throws. `workerSid` must be the running worker's own SID. */
export async function loadSlotState(
  stateDir: string,
  workerSid: string | null | undefined,
  read: (path: string) => Promise<string> = (p) => readFile(p, 'utf8'),
): Promise<SlotStateLoad> {
  let text: string;
  try {
    text = await read(join(stateDir, SLOTS_FILE));
  } catch {
    return {
      ok: false,
      code: 'job_slots_unprovisioned',
      detail: 'no per-job accounts on this machine yet (run Prepare with the privileged helper)',
    };
  }
  let parsed: SlotState;
  try {
    parsed = SlotState.parse(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch (err) {
    return {
      ok: false,
      code: 'job_slots_invalid',
      detail: `${SLOTS_FILE} is not valid: ${err instanceof Error ? err.message : String(err)}`.slice(0, 280),
    };
  }
  if (workerSid === null || workerSid === undefined || parsed.workerSid !== workerSid) {
    return {
      ok: false,
      code: 'job_slots_worker_mismatch',
      detail: `the per-job accounts were prepared for ${parsed.workerSid}, the worker runs as ${workerSid ?? 'an unknown SID'}`,
    };
  }
  return { ok: true, state: parsed, slots: slotsOf(parsed, stateDir) };
}

// ------------------------------------------------------------------------------------------- ACLs

function assertSid(sid: string): void {
  if (!SID.test(sid)) throw new RangeError(`not a SID: ${sid}`);
}

/**
 * icacls arguments for an attempt directory of a slot attempt: protected DACL with SYSTEM, Administrators, the
 * worker (full: it resets the permissions after the attempt) and the slot account (modify). `OWNER RIGHTS`
 * (synchronize only) removes the owner's implicit READ_CONTROL/WRITE_DAC, so the slot account cannot take the
 * worker's entries off the files it creates through ordinary permission changes.
 */
export function slotAttemptAclArgs(dir: string, workerSid: string, slotSid: string): string[] {
  assertSid(workerSid);
  assertSid(slotSid);
  if (workerSid === slotSid) throw new RangeError('slot SID equals the worker SID');
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    `*${WIN_SYSTEM}:(OI)(CI)F`,
    `*${WIN_ADMINISTRATORS}:(OI)(CI)F`,
    `*${workerSid}:(OI)(CI)F`,
    `*${slotSid}:(OI)(CI)M`,
    `*${WIN_OWNER_RIGHTS}:(OI)(CI)(S)`,
    '/Q',
  ];
}

/**
 * Adds a grant for a SID on a path the worker owns (mirror objects, package caches: inheritable on a directory;
 * `inherit: false` for a single file such as `.claude.json`).
 */
export function slotGrantArgs(path: string, sid: string, access: 'RX' | 'M', inherit = true): string[] {
  assertSid(sid);
  return [path, '/grant', `*${sid}:${inherit ? '(OI)(CI)' : ''}${access}`, '/Q'];
}

/**
 * p14-mcp-stdio: protected DACL of a local MCP server install (`<dataDir>\mcp\<id>\<version>`): SYSTEM,
 * Administrators and the worker full (it installs and removes it); the per-job account group read + execute only —
 * a job can run the server but never change its files. `OWNER RIGHTS` (synchronize) drops the owner's implicit
 * WRITE_DAC so nothing else can re-grant itself write.
 */
export function mcpInstallAclArgs(dir: string, workerSid: string, slotGroupSid: string): string[] {
  assertSid(workerSid);
  assertSid(slotGroupSid);
  if (workerSid === slotGroupSid) throw new RangeError('slot group SID equals the worker SID');
  return [
    dir,
    '/inheritance:r',
    '/grant:r',
    `*${WIN_SYSTEM}:(OI)(CI)F`,
    `*${WIN_ADMINISTRATORS}:(OI)(CI)F`,
    `*${workerSid}:(OI)(CI)F`,
    `*${slotGroupSid}:(OI)(CI)RX`,
    `*${WIN_OWNER_RIGHTS}:(OI)(CI)(S)`,
    '/Q',
  ];
}

/** Removes every grant of a SID from a directory (children re-inherit). */
export function slotRevokeArgs(dir: string, sid: string): string[] {
  assertSid(sid);
  return [dir, '/remove:g', `*${sid}`, '/Q'];
}

export async function icacls(args: readonly string[], run: RunFile = runFile): Promise<void> {
  const r = await run('icacls.exe', args, 600_000);
  if (r.code !== 0) {
    throw new Error(
      `icacls ${args[0] ?? ''} failed (${String(r.code)}): ${(r.stderr || r.stdout).trim().slice(0, 200)}` +
        (r.code === 5 ? ICACLS_DENIED_HINT : ''),
    );
  }
}

/**
 * p22-harness-gaps: exit 5 (access denied) on a folder in the worker's own data dir means the worker does not own it —
 * typically left by the pre-rename service account (windows-worker-1 2026-11-02). Only an administrator can take it back.
 */
export const ICACLS_DENIED_HINT =
  ' — the worker service does not own this folder (an earlier service account may still own it): re-run the Windows ' +
  'installer kit as Administrator (it gives the data and workspace folders to the service), or as Administrator run ' +
  '`icacls <data dir> /setowner "NT SERVICE\\RemyralWorker" /T /C`';

// ------------------------------------------------------------------------------------------- pool

export interface SlotLease {
  readonly slot: JobSlot;
  /** First spawn of this attempt on the slot (prepare ACLs and grants). */
  readonly first: boolean;
}

/**
 * Which attempt holds which account. An attempt keeps its slot for all of its spawns (reference counted); a slot is
 * never shared by two attempts. A slot whose cleanup failed is quarantined until the pool is reloaded (Prepare).
 */
export class SlotPool {
  readonly #slots: readonly JobSlot[];
  /** attempt → its account; `cleaning`: the attempt is done, its account is being cleaned (still not free). */
  readonly #held = new Map<string, { slot: JobSlot; refs: number; cleaning: boolean }>();
  readonly #quarantined = new Map<number, string>();

  constructor(slots: readonly JobSlot[]) {
    this.#slots = slots;
  }

  get size(): number {
    return this.#slots.length;
  }

  /** Slots that can take an attempt at all (not quarantined). */
  healthy(): number {
    return this.#slots.length - this.#quarantined.size;
  }

  inUse(): number {
    return this.#held.size;
  }

  quarantined(): readonly { index: number; reason: string }[] {
    return [...this.#quarantined].map(([index, reason]) => ({ index, reason }));
  }

  holder(attemptId: string): JobSlot | undefined {
    return this.#held.get(attemptId)?.slot;
  }

  acquire(attemptId: string): SlotLease | null {
    const have = this.#held.get(attemptId);
    if (have !== undefined) {
      if (have.cleaning) return null;
      have.refs++;
      return { slot: have.slot, first: false };
    }
    const busy = new Set([...this.#held.values()].map((h) => h.slot.index));
    const free = this.#slots.find((s) => !busy.has(s.index) && !this.#quarantined.has(s.index));
    if (free === undefined) return null;
    this.#held.set(attemptId, { slot: free, refs: 1, cleaning: false });
    return { slot: free, first: true };
  }

  /**
   * Drops one reference; `last` = the attempt no longer uses the account. The account stays taken until
   * `finish()` (its cleanup must not race the next attempt on it).
   */
  release(attemptId: string): { slot: JobSlot; last: boolean } | null {
    const have = this.#held.get(attemptId);
    if (have === undefined || have.cleaning) return null;
    have.refs--;
    if (have.refs > 0) return { slot: have.slot, last: false };
    have.cleaning = true;
    return { slot: have.slot, last: true };
  }

  /** The account's cleanup is over: it is free again (unless quarantined). */
  finish(attemptId: string): void {
    if (this.#held.get(attemptId)?.cleaning === true) this.#held.delete(attemptId);
  }

  quarantine(index: number, reason: string): void {
    this.#quarantined.set(index, reason.slice(0, 200));
  }

  /**
   * A reloaded pool (Prepare rotated the passwords) keeps the running attempts on the accounts they hold, so an
   * account is never handed to a second attempt; holds of accounts the new pool no longer has stay counted too.
   */
  adopt(previous: SlotPool): void {
    for (const [attemptId, h] of previous.#held) {
      const same = this.#slots.find((s) => s.index === h.slot.index) ?? h.slot;
      this.#held.set(attemptId, { slot: same, refs: h.refs, cleaning: h.cleaning });
    }
  }
}

// ------------------------------------------------------------------------------------- job runner

/** The spec's `runAs` (remyral-jobrun.ps1 accepts only `remyral-job-<n>` names). */
export function runAsSpec(slot: JobSlot): NonNullable<JobRunnerSpec['runAs']> {
  if (!SLOT_USER_PATTERN.test(slot.user)) throw new RangeError(`not a per-job account: ${slot.user}`);
  return { user: slot.user, credentialFile: slot.credentialFile };
}

/** Spec files live in the worker-only data dir: a slot account must never be able to swap one (runAs). */
export async function writeJobSpec(dataDir: string, spec: JobRunnerSpec): Promise<string> {
  const dir = join(dataDir, 'sandbox', 'specs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `jobrun-${randomBytes(12).toString('hex')}.json`);
  await writeFile(file, JSON.stringify(spec), { mode: 0o600 });
  return file;
}

/** PowerShell single-quoted literal. */
function psLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** `powershell -EncodedCommand` takes base64 of UTF-16LE. */
export function encodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * What an attempt may leave behind as its account outside the job object, removed by the account itself (the worker
 * account may not touch another account's processes or tasks): scheduled tasks it registered for itself (a later
 * trigger would run as the same account while it serves the next attempt) and processes started through WMI, COM
 * or such a task. Tasks first — `taskkill` also ends this PowerShell.
 */
export function sweepScript(slot: JobSlot, env: NodeJS.ProcessEnv = process.env): string {
  if (!SLOT_USER_PATTERN.test(slot.user)) throw new RangeError(`not a per-job account: ${slot.user}`);
  const root = env.SystemRoot ?? 'C:\\Windows';
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$u = ${psLiteral(slot.user)}`,
    "Get-ScheduledTask | Where-Object { $_.Principal.UserId -ceq $u -or $_.Principal.UserId -clike ('*\\' + $u) } |",
    '  Unregister-ScheduledTask -Confirm:$false',
    `& ${psLiteral(`${root}\\System32\\taskkill.exe`)} /F /FI ('USERNAME eq ' + $u) | Out-Null`,
  ].join('\n');
}

export function sweepCommandLine(slot: JobSlot, env: NodeJS.ProcessEnv = process.env): string {
  return `"${powershellExe(env)}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand(
    sweepScript(slot, env),
  )}`;
}

// ------------------------------------------------------------------------------------- self-test

export interface ProbeTarget {
  readonly path: string;
  readonly kind: 'dir' | 'file';
}

/**
 * The probe a slot account runs: who am I, can I use my own dir, can I touch the partner's dir, can I read the
 * secrets. Prints one line `remyral-slot-probe sid=… own-write=ok …`; ASCII only, culture-independent.
 */
export function probeScript(own: string, other: string | null, secrets: readonly ProbeTarget[]): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    'function T([scriptblock]$b) {',
    "  try { & $b | Out-Null; return 'ok' } catch {",
    '    $e = $_.Exception',
    '    while ($null -ne $e) {',
    "      if ($e -is [UnauthorizedAccessException] -or $e -is [Security.SecurityException]) { return 'denied' }",
    '      $e = $e.InnerException',
    '    }',
    "    return 'error'",
    '  }',
    '}',
    `$own = ${psLiteral(own)}`,
    "$out = @('remyral-slot-probe', ('sid=' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value))",
    "$out += 'own-write=' + (T { [IO.File]::WriteAllText((Join-Path $own 'probe.txt'), 'x') })",
    "$out += 'own-read=' + (T { [IO.File]::ReadAllText((Join-Path $own 'marker.txt')) })",
  ];
  if (other !== null) {
    lines.push(
      `$other = ${psLiteral(other)}`,
      "$out += 'other-read=' + (T { [IO.File]::ReadAllText((Join-Path $other 'marker.txt')) })",
      "$out += 'other-list=' + (T { [IO.Directory]::GetFileSystemEntries($other) })",
      "$out += 'other-write=' + (T { [IO.File]::WriteAllText((Join-Path $other 'intruder.txt'), 'x') })",
    );
  }
  secrets.forEach((s, i) => {
    const op =
      s.kind === 'dir'
        ? `[IO.Directory]::GetFileSystemEntries(${psLiteral(s.path)})`
        : `[IO.File]::ReadAllBytes(${psLiteral(s.path)})`;
    lines.push(`$out += 'secret-${String(i)}=' + (T { ${op} })`);
  });
  lines.push("[Console]::Out.WriteLine(($out -join ' '))");
  return lines.join('\n');
}

export interface ProbeVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

/** Checks one probe output line against what isolation requires. */
export function evaluateProbe(
  stdout: string,
  expectSid: string,
  hasOther: boolean,
  secretCount: number,
): ProbeVerdict {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('remyral-slot-probe '));
  if (line === undefined)
    return { ok: false, detail: 'no probe output (the account could not run PowerShell?)' };
  const f = new Map(
    line
      .split(' ')
      .slice(1)
      .map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i), kv.slice(i + 1)] as const;
      }),
  );
  const want: [string, string][] = [
    ['sid', expectSid],
    ['own-write', 'ok'],
    ['own-read', 'ok'],
  ];
  if (hasOther) want.push(['other-read', 'denied'], ['other-list', 'denied'], ['other-write', 'denied']);
  for (let i = 0; i < secretCount; i++) want.push([`secret-${String(i)}`, 'denied']);
  const bad = want.filter(([k, v]) => f.get(k) !== v).map(([k, v]) => `${k}=${f.get(k) ?? '?'} (want ${v})`);
  return bad.length === 0
    ? { ok: true, detail: hasOther ? 'own ok; partner, secrets denied' : 'own ok; secrets denied' }
    : { ok: false, detail: bad.join(', ').slice(0, 280) };
}

export const SlotSelfTestRecord = z.object({
  v: z.literal(1),
  generation: z.string().max(64),
  jobRunnerSha: z.string().max(64),
  ok: z.boolean(),
  at: z.string().max(40),
  detail: z.string().max(300),
  slots: z
    .array(z.object({ user: z.string().max(32), ok: z.boolean(), detail: z.string().max(300) }))
    .max(16),
});
export type SlotSelfTestRecord = z.infer<typeof SlotSelfTestRecord>;

export interface SlotSelfTestDeps {
  readonly state: SlotState;
  readonly slots: readonly JobSlot[];
  readonly stateDir: string;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  /** The verified job runner script. */
  readonly jobRunner: string;
  readonly run?: RunFile;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Applies icacls arguments (default: icacls.exe through `run`). */
  readonly acl?: (args: readonly string[]) => Promise<void>;
}

/**
 * Cross-access self-test: per slot a directory restricted to that slot (exactly the attempt ACL), a marker file in
 * each, then every slot runs the probe through the job runner as itself against its own directory, the next slot's
 * directory, the worker data dir, the credential folder and its own credential file. Passes only if every slot runs
 * as its own SID, can use its own directory and is denied everything else.
 */
export async function runSlotSelfTest(d: SlotSelfTestDeps): Promise<SlotSelfTestRecord> {
  const run = d.run ?? runFile;
  const acl = d.acl ?? ((args: readonly string[]) => icacls(args, run));
  const now = d.now ?? (() => new Date());
  const base = join(d.workspaceRoot, 'sandboxes', `.slot-selftest-${d.state.generation.slice(0, 8)}`);
  const results: SlotSelfTestRecord['slots'] = [];
  const record = (ok: boolean, detail: string): SlotSelfTestRecord => ({
    v: 1,
    generation: d.state.generation,
    jobRunnerSha: WINDOWS_JOBRUN_SHA256,
    ok,
    at: now().toISOString(),
    detail: detail.slice(0, 300),
    slots: results,
  });
  try {
    await rm(base, { recursive: true, force: true });
    const dirs: string[] = [];
    for (const slot of d.slots) {
      const dir = join(base, `slot-${String(slot.index)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marker.txt'), randomBytes(8).toString('hex'));
      await acl(slotAttemptAclArgs(dir, d.state.workerSid, slot.sid));
      dirs.push(dir);
    }
    for (const [i, slot] of d.slots.entries()) {
      const other = d.slots.length > 1 ? (dirs[(i + 1) % dirs.length] ?? null) : null;
      const secrets: ProbeTarget[] = [
        { path: d.dataDir, kind: 'dir' },
        { path: d.stateDir, kind: 'dir' },
        { path: slot.credentialFile, kind: 'file' },
      ];
      const own = dirs[i] ?? base;
      const ps = powershellExe(d.env);
      const spec: JobRunnerSpec = {
        v: 1,
        commandLine: `"${ps}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodedCommand(
          probeScript(own, other, secrets),
        )}`,
        cwd: own,
        memoryBytes: 512 * 1024 ** 2,
        maxProcesses: 16,
        cpuRatePercent: 100,
        runAs: runAsSpec(slot),
      };
      const specFile = await writeJobSpec(d.dataDir, spec);
      // The probe runs as the slot account, which cannot write the worker's TEMP: Windows PowerShell 5.1 then
      // falls back to ConstrainedLanguage (its policy test file cannot be created) and the probe fails. Point
      // TEMP/TMP at a directory inside the slot's own folder, as the host runner does for real attempts.
      const tmp = join(own, 'tmp');
      await mkdir(tmp, { recursive: true });
      const env = { ...(d.env ?? process.env), TEMP: tmp, TMP: tmp };
      const r = await run(ps, jobRunnerArgs(d.jobRunner, specFile), 120_000, env);
      await rm(specFile, { force: true });
      const verdict =
        r.code === 0
          ? evaluateProbe(r.stdout, slot.sid, other !== null, secrets.length)
          : { ok: false, detail: `exit ${String(r.code)}: ${(r.stderr || r.stdout).trim()}`.slice(0, 280) };
      results.push({ user: slot.user, ok: verdict.ok, detail: verdict.detail });
    }
  } catch (err) {
    return record(false, `self-test error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
  const failed = results.filter((r) => !r.ok);
  return failed.length === 0
    ? record(true, `${String(results.length)} account(s): each denied the others' workspaces and the secrets`)
    : record(false, failed.map((f) => `${f.user}: ${f.detail}`).join('; '));
}

export async function readSelfTestRecord(dataDir: string): Promise<SlotSelfTestRecord | null> {
  try {
    return SlotSelfTestRecord.parse(
      JSON.parse(await readFile(join(dataDir, 'sandbox', SELFTEST_FILE), 'utf8')),
    );
  } catch {
    return null;
  }
}

export async function writeSelfTestRecord(dataDir: string, r: SlotSelfTestRecord): Promise<void> {
  const file = join(dataDir, 'sandbox', SELFTEST_FILE);
  await mkdir(join(dataDir, 'sandbox'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${String(process.pid)}.tmp`;
  await writeFile(tmp, JSON.stringify(r), { mode: 0o600 });
  await rename(tmp, file);
}

/** A stored result counts only for the same pool generation and the same job runner. */
export function selfTestCurrent(r: SlotSelfTestRecord | null, state: SlotState): boolean {
  return r !== null && r.ok && r.generation === state.generation && r.jobRunnerSha === WINDOWS_JOBRUN_SHA256;
}

// ------------------------------------------------------------------ worker token privileges (live finding 2026-10-17)

/** Privileges the worker service token needs to start a job as a slot account (granted by `job_slots_provision`). */
export const WORKER_TOKEN_PRIVILEGES = ['SeAssignPrimaryTokenPrivilege', 'SeIncreaseQuotaPrivilege'] as const;

export type TokenPrivilegeCheck =
  | { readonly checked: true; readonly missing: readonly string[] }
  | { readonly checked: false; readonly detail: string };

/**
 * Privilege names in `whoami /priv /fo csv /nh` output. The first column is the constant privilege name (the
 * description is localised); a privilege is listed when it is in the token, enabled or not.
 */
export function parseWhoamiPrivileges(stdout: string): Set<string> {
  return new Set([...stdout.matchAll(/^\s*"(Se[A-Za-z]{1,60}Privilege)"/gm)].map((m) => m[1] ?? ''));
}

/**
 * Which of {@link WORKER_TOKEN_PRIVILEGES} this process's token lacks. A newly granted LSA right reaches a service
 * only with a new service logon (a full stop/start of the Windows service); a restart of node under the same
 * service process (shawl) keeps the old token — seen live on 1.0.29.
 */
export async function checkWorkerTokenPrivileges(
  run: RunFile = runFile,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TokenPrivilegeCheck> {
  const whoami = `${env.SystemRoot ?? 'C:\\Windows'}\\System32\\whoami.exe`;
  const r = await run(whoami, ['/priv', '/fo', 'csv', '/nh'], 15_000).catch((err: unknown) => ({
    code: -1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }));
  const have = r.code === 0 ? parseWhoamiPrivileges(r.stdout) : new Set<string>();
  if (have.size === 0) {
    return {
      checked: false,
      detail: `whoami /priv: exit ${String(r.code)} ${(r.stderr || r.stdout).trim()}`.slice(0, 200),
    };
  }
  return { checked: true, missing: WORKER_TOKEN_PRIVILEGES.filter((p) => !have.has(p)) };
}

/** A job runner / self-test error that means the token lacks the privileges (remyral-jobrun.ps1 EnablePrivilege). */
export function isMissingTokenPrivilegeError(text: string): boolean {
  return /does not hold (SeAssignPrimaryTokenPrivilege|SeIncreaseQuotaPrivilege)/.test(text);
}

/** The owner-facing reason when the privileges are granted (LSA) but not in this process's token. */
export function serviceRestartDetail(missing: readonly string[]): string {
  const names = (missing.length > 0 ? missing : WORKER_TOKEN_PRIVILEGES).join(' and ');
  return `restart the RemyralWorker service: ${names} were granted, but this worker's token lacks them (Restart-Service RemyralWorker as Administrator, or privileged Prepare again; a worker process restart keeps the old token)`.slice(
    0,
    300,
  );
}
