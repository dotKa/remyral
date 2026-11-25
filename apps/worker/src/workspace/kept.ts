import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger, Redactor } from '@remyral/observability';
import {
  isWorkfilePath,
  type KeptWorkfiles,
  pickEvictions,
  type WorkfileEntry,
  WORKFILES_LIMITS,
  type WorkfilesDataPayload,
  workfilesEffectiveExpiry,
  workfilesKey,
  type WorkfilesOutcome,
  type WorkfilesReadOp,
  type WorkfilesRemovedReason,
  type WorkfilesReport,
  type WorkfilesRequestPayload,
  type WorkfilesStatusPayload,
} from '@remyral/protocol';
import { errnoCode } from '../fs/ops.js';
import { UnsafePathError } from './errors.js';
import { assertSafeSegment } from './ids.js';
import { assertRealDir, assertRealInside, ensureDirInside, isInside } from './paths.js';
import { prePushScanner } from './secret-scan.js';

/**
 * p15-workspace-retention (docs/design/p15-workspace-retention.md §3): the kept working directories of workspace jobs.
 *
 * Layout under the (real) workspace root, next to `jobs/`:
 *   kept/<jobId>/<attemptId>/                 the attempt's whole scratch directory (`in/`, `out/`, anything else)
 *   .remyral/kept/<jobId>__<attemptId>.json    its record (0600): project, outcome, size, expiry, pin
 *
 * - **keep**: the attempt's scratch dir is *moved* (same file system, atomic) at the end of the job instead of being
 *   removed; text files are scanned with the pre-push rules + the job's exact secret values and redacted in place,
 *   a binary with a hit is removed (counted in the record). Then the machine cap is applied: the oldest unpinned
 *   directories are evicted first ({@link pickEvictions}); the one kept now never is.
 * - **reads** never follow a symbolic link (O_NOFOLLOW on the file, real path of its directory checked inside the kept
 *   directory); links, sockets and devices are listed as `other` and never read or copied.
 * - **expiry** is the master's (it sweeps and extends while a deploy / service / follow-up needs the files); the worker
 *   removes a directory on its own only {@link WORKFILES_LIMITS.localGraceMs} after its expiry or pin, so a master
 *   that is away does not leave the disk filling up.
 * - **seed**: a follow-up attempt starts from kept files — copied on this machine, or fetched through the master
 *   (relay) — into its own new scratch dir; the source is never modified.
 */

export interface KeptRecord extends KeptWorkfiles {
  readonly dropped: number;
  readonly redacted: number;
}

export interface KeepOptions {
  readonly projectId: string;
  readonly outcome: WorkfilesOutcome;
  readonly expiresAt: string;
  readonly maxBytes: number;
  /** The job's redactor (its secret values): text is redacted, binaries with a hit removed. */
  readonly redactor?: Redactor;
}

export interface KeptWorkdirsOptions {
  /** The workspace manager's real root. */
  readonly root: string;
  readonly logger?: Logger;
  readonly clock?: () => Date;
  /** The cap applied when no job told one yet (reports). */
  readonly defaultMaxBytes?: number;
  /** Called after every keep / removal (WORKFILES_STATUS). */
  readonly onChange?: (status: WorkfilesStatusPayload) => void;
}

/** The scratch directory being kept (the manager's ScratchWorkspace). */
export interface KeptSource {
  readonly jobId: string;
  readonly attemptId: string;
  readonly path: string;
}

/** Where a seed is copied to (the new attempt's ScratchWorkspace). */
export interface SeedTarget {
  readonly path: string;
  readonly inDir: string;
}

export interface SeedResult {
  readonly files: number;
  readonly bytes: number;
  /** Files left out (limits, links, read errors). */
  readonly skipped: number;
  readonly truncated: boolean;
}

const META = '.remyral';
const TEXT_SCAN_MAX = 5 * 1024 * 1024;

export class KeptWorkdirs {
  readonly #root: string;
  readonly #opts: KeptWorkdirsOptions;
  readonly #records = new Map<string, KeptRecord>();
  #maxBytes: number;
  readonly #busy = new Map<string, Promise<unknown>>();

  private constructor(root: string, opts: KeptWorkdirsOptions) {
    this.#root = root;
    this.#opts = opts;
    this.#maxBytes = opts.defaultMaxBytes ?? WORKFILES_LIMITS.machineCapBytesDefault;
  }

  /** Creates the layout and loads the records (a record whose directory is gone is dropped). */
  static async create(opts: KeptWorkdirsOptions): Promise<KeptWorkdirs> {
    const root = await realpath(opts.root);
    await ensureDirInside(root, ['kept']);
    await ensureDirInside(root, [META, 'kept']);
    const k = new KeptWorkdirs(root, opts);
    await k.#load();
    return k;
  }

  #now(): Date {
    return this.#opts.clock?.() ?? new Date();
  }

  async #load(): Promise<void> {
    const dir = join(this.#root, META, 'kept');
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const rec = JSON.parse(await readFile(join(dir, name), 'utf8')) as KeptRecord;
        assertSafeSegment('jobId', rec.jobId);
        assertSafeSegment('attemptId', rec.attemptId);
        if ((await lstat(this.#dir(rec.jobId, rec.attemptId)).catch(() => null)) === null) {
          await rm(join(dir, name), { force: true });
          continue;
        }
        this.#records.set(workfilesKey(rec), rec);
      } catch {
        await rm(join(dir, name), { force: true });
      }
    }
  }

  #dir(jobId: string, attemptId: string): string {
    return join(this.#root, 'kept', jobId, attemptId);
  }

  #recordFile(jobId: string, attemptId: string): string {
    return join(this.#root, META, 'kept', `${jobId}__${attemptId}.json`);
  }

  /** One operation per kept directory at a time (keep, delete, extend, seed copy). */
  async #exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#busy.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.#busy.set(key, settled);
    void settled.then(() => {
      if (this.#busy.get(key) === settled) this.#busy.delete(key);
    });
    return next;
  }

  /** The kept directories, newest first. */
  list(): KeptRecord[] {
    return [...this.#records.values()].sort(
      (a, b) => b.keptAt.localeCompare(a.keptAt) || workfilesKey(a).localeCompare(workfilesKey(b)),
    );
  }

  get(jobId: string, attemptId: string): KeptRecord | null {
    return this.#records.get(workfilesKey({ jobId, attemptId })) ?? null;
  }

  report(): WorkfilesReport {
    const kept = this.list();
    return {
      maxBytes: this.#maxBytes,
      usedBytes: kept.reduce((n, r) => n + r.sizeBytes, 0),
      kept: kept.slice(0, WORKFILES_LIMITS.reportMax).map(publicRecord),
    };
  }

  #emit(
    kept: readonly KeptRecord[],
    removed: { jobId: string; attemptId: string; reason: WorkfilesRemovedReason }[],
  ): void {
    if (this.#opts.onChange === undefined) return;
    const r = this.report();
    try {
      this.#opts.onChange({ ...r, kept: kept.map(publicRecord), removed });
    } catch {
      // reporting only
    }
  }

  /**
   * Moves the attempt's scratch directory to `kept/` (instead of removing it), scans it, writes its record and applies
   * the machine cap. Returns the record and what was evicted for room.
   */
  async keep(ws: KeptSource, opts: KeepOptions): Promise<{ record: KeptRecord; evicted: KeptRecord[] }> {
    assertSafeSegment('jobId', ws.jobId);
    assertSafeSegment('attemptId', ws.attemptId);
    assertSafeSegment('projectId', opts.projectId);
    const key = workfilesKey(ws);
    const record = await this.#exclusive(key, async () => {
      const src = join(this.#root, 'jobs', ws.jobId, ws.attemptId);
      await assertRealDir(src);
      const real = await assertRealInside(this.#root, src);
      if (real !== src) throw new UnsafePathError(src, `resolves to ${real}`);
      await ensureDirInside(this.#root, ['kept', ws.jobId]);
      const dest = this.#dir(ws.jobId, ws.attemptId);
      if ((await lstat(dest).catch(() => null)) !== null) await rm(dest, { recursive: true, force: true });
      await rename(src, dest);
      await rmdir(dirname(src)).catch(() => undefined);
      await chmod(dest, 0o700).catch(() => undefined);
      const scan = await scanKept(dest, opts.redactor);
      const rec: KeptRecord = {
        jobId: ws.jobId,
        attemptId: ws.attemptId,
        projectId: opts.projectId,
        outcome: opts.outcome,
        sizeBytes: scan.bytes,
        files: scan.files,
        keptAt: this.#now().toISOString(),
        expiresAt: opts.expiresAt,
        pinnedUntil: null,
        dropped: scan.dropped,
        redacted: scan.redacted,
      };
      await this.#write(rec);
      return rec;
    });
    this.#maxBytes = opts.maxBytes;
    const evicted = await this.#evict(new Set([key]));
    this.#opts.logger?.info('workspace kept', {
      jobId: ws.jobId,
      attemptId: ws.attemptId,
      bytes: record.sizeBytes,
      files: record.files,
      dropped: record.dropped,
      redacted: record.redacted,
      evicted: evicted.length,
    });
    this.#emit(
      [record],
      evicted.map((e) => ({ jobId: e.jobId, attemptId: e.attemptId, reason: 'evicted' as const })),
    );
    return { record, evicted };
  }

  async #write(rec: KeptRecord): Promise<void> {
    await writeFile(this.#recordFile(rec.jobId, rec.attemptId), `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    this.#records.set(workfilesKey(rec), rec);
  }

  async #evict(protect: ReadonlySet<string>): Promise<KeptRecord[]> {
    const victims = pickEvictions(this.list(), this.#maxBytes, this.#now(), protect);
    const out: KeptRecord[] = [];
    for (const v of victims) {
      if (await this.#remove(v.jobId, v.attemptId)) out.push(v);
    }
    return out;
  }

  async #remove(jobId: string, attemptId: string): Promise<boolean> {
    const key = workfilesKey({ jobId, attemptId });
    return this.#exclusive(key, async () => {
      const rec = this.#records.get(key);
      const dir = this.#dir(jobId, attemptId);
      if ((await lstat(dir).catch(() => null)) !== null) {
        await assertRealDir(dir);
        const real = await assertRealInside(this.#root, dir);
        if (real !== dir) throw new UnsafePathError(dir, `resolves to ${real}`);
        await rm(dir, { recursive: true, force: true });
      }
      await rmdir(dirname(dir)).catch(() => undefined);
      await rm(this.#recordFile(jobId, attemptId), { force: true });
      this.#records.delete(key);
      return rec !== undefined;
    });
  }

  /** Removes a kept directory (the master's delete: a person's "Temizle", expiry or eviction). */
  async remove(jobId: string, attemptId: string, reason: WorkfilesRemovedReason): Promise<boolean> {
    assertSafeSegment('jobId', jobId);
    assertSafeSegment('attemptId', attemptId);
    const removed = await this.#remove(jobId, attemptId);
    if (removed) {
      this.#opts.logger?.info('kept workspace removed', { jobId, attemptId, reason });
      this.#emit([], [{ jobId, attemptId, reason }]);
    }
    return removed;
  }

  /** The master moves the expiry (retention change) or pins the files (a deploy / service / follow-up needs them). */
  async extend(
    jobId: string,
    attemptId: string,
    expiresAt: string,
    pinnedUntil: string | null,
  ): Promise<KeptRecord | null> {
    const key = workfilesKey({ jobId, attemptId });
    const rec = await this.#exclusive(key, async () => {
      const cur = this.#records.get(key);
      if (cur === undefined) return null;
      const next: KeptRecord = { ...cur, expiresAt, pinnedUntil };
      await this.#write(next);
      return next;
    });
    if (rec !== null) this.#emit([rec], []);
    return rec;
  }

  /** Removes what expired (and is not pinned) more than the local grace ago. */
  async sweep(): Promise<KeptRecord[]> {
    const now = this.#now().getTime();
    const out: KeptRecord[] = [];
    for (const r of this.list()) {
      if (workfilesEffectiveExpiry(r) + WORKFILES_LIMITS.localGraceMs >= now) continue;
      if (await this.#remove(r.jobId, r.attemptId)) out.push(r);
    }
    if (out.length > 0) {
      this.#opts.logger?.info('expired kept workspaces removed', { count: out.length });
      this.#emit(
        [],
        out.map((r) => ({ jobId: r.jobId, attemptId: r.attemptId, reason: 'expired' as const })),
      );
    }
    return out;
  }

  /** The listing of a kept directory (links etc. as `other`; at most {@link WORKFILES_LIMITS.listMax}). */
  async entries(
    jobId: string,
    attemptId: string,
  ): Promise<{ entries: WorkfileEntry[]; truncated: boolean } | null> {
    const base = await this.#base(jobId, attemptId);
    if (base === null) return null;
    const entries: WorkfileEntry[] = [];
    const truncated = await walk(base, '', 0, (e) => {
      if (entries.length >= WORKFILES_LIMITS.listMax) return false;
      entries.push({ path: e.rel, kind: e.kind, size: e.size, mtime: e.mtime });
      return true;
    });
    return { entries, truncated };
  }

  /** One chunk of one file (never through a link). */
  async read(
    jobId: string,
    attemptId: string,
    path: string,
    offset: number,
  ): Promise<{ data: Buffer; eof: boolean; size: number } | null> {
    const base = await this.#base(jobId, attemptId);
    if (base === null || !isWorkfilePath(path)) return null;
    return readChunk(base, path, offset);
  }

  async #base(jobId: string, attemptId: string): Promise<string | null> {
    try {
      assertSafeSegment('jobId', jobId);
      assertSafeSegment('attemptId', attemptId);
    } catch {
      return null;
    }
    if (!this.#records.has(workfilesKey({ jobId, attemptId }))) return null;
    const dir = this.#dir(jobId, attemptId);
    try {
      await assertRealDir(dir);
      const real = await assertRealInside(this.#root, dir);
      return real === dir ? real : null;
    } catch {
      return null;
    }
  }

  /** Copies a kept directory of this machine into a new attempt's scratch dir (the source is never changed). */
  async seedLocal(jobId: string, attemptId: string, target: SeedTarget): Promise<SeedResult | null> {
    const base = await this.#base(jobId, attemptId);
    if (base === null) return null;
    return this.#exclusive(workfilesKey({ jobId, attemptId }), () => copyTree(base, target));
  }

  /** Answers a WORKFILES_REQUEST of the master. */
  async handle(req: WorkfilesRequestPayload): Promise<WorkfilesDataPayload> {
    const op = req.op;
    const base = { requestId: req.requestId };
    try {
      switch (op.op) {
        case 'list':
        case 'read':
          return await this.answerRead(req.jobId, req.attemptId, op, req.requestId);
        case 'delete': {
          const removed = await this.remove(
            req.jobId,
            req.attemptId,
            op.reason === 'user' ? 'deleted' : op.reason,
          );
          return { ...base, status: removed ? 'ok' : 'not_found' };
        }
        case 'extend': {
          const rec = await this.extend(req.jobId, req.attemptId, op.expiresAt, op.pinnedUntil);
          return rec === null
            ? { ...base, status: 'not_found' }
            : { ...base, status: 'ok', kept: publicRecord(rec) };
        }
      }
    } catch (err) {
      this.#opts.logger?.warn('workfiles request failed', { jobId: req.jobId, op: op.op, err });
      return { ...base, status: 'error', detail: 'the machine could not read the kept files' };
    }
  }

  /** list / read answer (also what a relayed seed reads). */
  async answerRead(
    jobId: string,
    attemptId: string,
    op: WorkfilesReadOp,
    requestId: string,
  ): Promise<WorkfilesDataPayload> {
    if (op.op === 'list') {
      const l = await this.entries(jobId, attemptId);
      return l === null
        ? { requestId, status: 'not_found' }
        : { requestId, status: 'ok', entries: l.entries, truncated: l.truncated };
    }
    const c = await this.read(jobId, attemptId, op.path, op.offset);
    if (c === null) return { requestId, status: 'not_found' };
    return {
      requestId,
      status: 'ok',
      offset: op.offset,
      data: c.data.toString('base64'),
      eof: c.eof,
      size: c.size,
    };
  }
}

function publicRecord(r: KeptRecord): KeptWorkfiles {
  return {
    jobId: r.jobId,
    attemptId: r.attemptId,
    projectId: r.projectId,
    outcome: r.outcome,
    sizeBytes: r.sizeBytes,
    files: r.files,
    keptAt: r.keptAt,
    expiresAt: r.expiresAt,
    pinnedUntil: r.pinnedUntil,
    dropped: r.dropped,
    redacted: r.redacted,
  };
}

interface WalkEntry {
  readonly rel: string;
  readonly abs: string;
  readonly kind: 'file' | 'dir' | 'other';
  readonly size: number;
  readonly mtime: string;
}

/** Depth-first walk without following links. `visit` false stops; returns true when stopped early (truncated). */
async function walk(
  dir: string,
  prefix: string,
  depth: number,
  visit: (e: WalkEntry) => boolean | Promise<boolean>,
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return false;
  }
  names.sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (!isWorkfilePath(rel)) continue;
    const abs = join(dir, name);
    const st = await lstat(abs).catch(() => null);
    if (st === null) continue;
    const kind = st.isSymbolicLink() ? 'other' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
    const e: WalkEntry = {
      rel,
      abs,
      kind,
      size: kind === 'file' ? st.size : 0,
      mtime: st.mtime.toISOString(),
    };
    if (!(await visit(e))) return true;
    if (kind === 'dir' && depth + 1 < WORKFILES_LIMITS.depthMax) {
      if (await walk(abs, rel, depth + 1, visit)) return true;
    }
  }
  return false;
}

/** Size and file count; text redacted in place, binaries with a secret hit removed. */
async function scanKept(
  dir: string,
  redactor: Redactor | undefined,
): Promise<{ bytes: number; files: number; dropped: number; redacted: number }> {
  const scanner = redactor === undefined ? null : prePushScanner(redactor.secrets);
  let bytes = 0;
  let files = 0;
  let dropped = 0;
  let redacted = 0;
  await walk(dir, '', 0, async (e) => {
    if (e.kind !== 'file') return true;
    if (scanner !== null && e.size <= TEXT_SCAN_MAX) {
      const content = await readNoFollowWhole(e.abs).catch(() => null);
      if (content !== null) {
        if (isText(content)) {
          const text = content.toString('utf8');
          const clean = scanner.redact(text);
          if (clean !== text) {
            const st = await lstat(e.abs);
            await chmod(e.abs, 0o600).catch(() => undefined);
            await writeFile(e.abs, clean, 'utf8');
            await chmod(e.abs, st.mode & 0o777).catch(() => undefined);
            redacted++;
            bytes += Buffer.byteLength(clean, 'utf8');
            files++;
            return true;
          }
        } else if (scanner.spans(content.toString('latin1')).length > 0) {
          await rm(e.abs, { force: true });
          dropped++;
          return true;
        }
      }
    }
    bytes += e.size;
    files++;
    return true;
  });
  return { bytes, files, dropped, redacted };
}

function isText(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

async function readNoFollowWhole(path: string): Promise<Buffer> {
  const fh = await open(path, constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0));
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** One chunk of `base/path`: the file is opened without following a link, its directory must resolve inside `base`. */
async function readChunk(
  base: string,
  path: string,
  offset: number,
): Promise<{ data: Buffer; eof: boolean; size: number } | null> {
  const abs = join(base, ...path.split('/'));
  try {
    const parent = await realpath(dirname(abs));
    if (!isInside(base, parent)) return null;
  } catch {
    return null;
  }
  let fh;
  try {
    fh = await open(abs, constants.O_RDONLY | ((constants.O_NOFOLLOW as number | undefined) ?? 0));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ELOOP') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = Math.max(0, Math.min(WORKFILES_LIMITS.readChunkBytes, st.size - offset));
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const r = await fh.read(buf, got, want - got, offset + got);
      if (r.bytesRead === 0) break;
      got += r.bytesRead;
    }
    return { data: buf.subarray(0, got), eof: offset + got >= st.size, size: st.size };
  } finally {
    await fh.close();
  }
}

/** Where a kept path goes in the new attempt: `in/…` into the new `in/` (read-only, never replacing), else as is. */
function targetPath(target: SeedTarget, rel: string): { abs: string; input: boolean } {
  const parts = rel.split('/');
  if (parts[0] === 'in' && parts.length > 1)
    return { abs: join(target.inDir, ...parts.slice(1)), input: true };
  return { abs: join(target.path, ...parts), input: false };
}

async function ensureParent(target: SeedTarget, rel: string): Promise<void> {
  const parts = rel.split('/').slice(0, -1);
  if (parts.length === 0) return;
  if (parts[0] === 'in') {
    if (parts.length > 1) await ensureDirInside(target.inDir, parts.slice(1));
    return;
  }
  await ensureDirInside(target.path, parts);
}

/** Copies a kept tree into a new scratch dir (links skipped, existing files kept, limits applied). */
async function copyTree(base: string, target: SeedTarget): Promise<SeedResult> {
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  const truncated = await walk(base, '', 0, async (e) => {
    if (e.kind === 'other') {
      skipped++;
      return true;
    }
    if (e.kind === 'dir') {
      if (e.rel !== 'in') await ensureParent(target, `${e.rel}/x`).catch(() => undefined);
      return true;
    }
    if (files >= WORKFILES_LIMITS.transferMaxFiles || bytes + e.size > WORKFILES_LIMITS.transferMaxBytes) {
      skipped++;
      return files < WORKFILES_LIMITS.transferMaxFiles;
    }
    const to = targetPath(target, e.rel);
    try {
      await ensureParent(target, e.rel);
      // The source file must still be a regular file inside the kept directory (no link swapped in).
      const src = await regularFileInside(base, e.rel);
      if (src === null) {
        skipped++;
        return true;
      }
      await copyFile(src, to.abs, constants.COPYFILE_EXCL);
      await chmod(to.abs, to.input ? 0o444 : 0o600).catch(() => undefined);
      files++;
      bytes += e.size;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') skipped++;
    }
    return true;
  });
  return { files, bytes, skipped, truncated };
}

/** The absolute path of a regular file inside `base` (checked: not a link, directory resolves inside). */
async function regularFileInside(base: string, rel: string): Promise<string | null> {
  const abs = join(base, ...rel.split('/'));
  const st = await lstat(abs).catch(() => null);
  if (st === null || !st.isFile()) return null;
  const parent = await realpath(dirname(abs)).catch(() => null);
  return parent !== null && isInside(base, parent) ? abs : null;
}

/** Fetches a kept directory through the master (relay) into a new scratch dir. */
export async function seedFromRemote(
  fetch: (op: WorkfilesReadOp) => Promise<WorkfilesDataPayload>,
  target: SeedTarget,
): Promise<SeedResult | null> {
  const list = await fetch({ op: 'list' });
  if (list.status !== 'ok' || list.entries === undefined) return null;
  let files = 0;
  let bytes = 0;
  let skipped = 0;
  let truncated = list.truncated === true;
  for (const e of list.entries) {
    if (e.kind === 'dir') {
      if (e.path !== 'in') await ensureParent(target, `${e.path}/x`).catch(() => undefined);
      continue;
    }
    if (e.kind !== 'file' || !isWorkfilePath(e.path)) {
      skipped++;
      continue;
    }
    if (
      files >= WORKFILES_LIMITS.transferMaxFiles ||
      bytes + e.size > WORKFILES_LIMITS.transferMaxBytes ||
      e.size > WORKFILES_LIMITS.fileMaxBytes
    ) {
      skipped++;
      truncated = true;
      continue;
    }
    const parts: Buffer[] = [];
    let got = 0;
    let ok = true;
    for (let offset = 0; ;) {
      const r = await fetch({ op: 'read', path: e.path, offset });
      if (r.status !== 'ok' || r.data === undefined) {
        ok = false;
        break;
      }
      const chunk = Buffer.from(r.data, 'base64');
      parts.push(chunk);
      got += chunk.length;
      offset += chunk.length;
      if (got > WORKFILES_LIMITS.fileMaxBytes) {
        ok = false;
        break;
      }
      if (r.eof === true) break;
      if (chunk.length === 0) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      skipped++;
      continue;
    }
    const to = targetPath(target, e.path);
    try {
      await ensureParent(target, e.path);
      const fh = await open(to.abs, 'wx', 0o600);
      try {
        await fh.writeFile(Buffer.concat(parts));
      } finally {
        await fh.close();
      }
      if (to.input) await chmod(to.abs, 0o444).catch(() => undefined);
      files++;
      bytes += got;
    } catch (err) {
      if (errnoCode(err) !== 'EEXIST') skipped++;
    }
  }
  return { files, bytes, skipped, truncated };
}
