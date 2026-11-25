import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/** Typed wrappers for the master's release routes (apps/master/src/releases/routes.ts, p2-signed-updates). */

export interface ReleaseInfo {
  readonly version: string;
  readonly channel: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly keyId: string;
  readonly uploadedAt: string;
}

export interface ChannelInfo {
  readonly channel: string;
  readonly version: string;
  readonly rolloutPercent: number;
  readonly updatedAt: string;
}

export interface AttemptInfo {
  readonly id: string;
  readonly workerId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly status: string;
  readonly reason: string | null;
  /** The updater's one-line explanation (e.g. "1.0.22 did not connect and heartbeat within 90 s; …"). */
  readonly detail: string | null;
  /** p6-worker-boot-diagnostics: boot verdict of the attached evidence; null when none. */
  readonly verdict: string | null;
  readonly hasDiagnostics: boolean;
  readonly updatedAt: string;
}

/** p6-worker-boot-diagnostics: the evidence of a failed attempt (GET /releases/attempts/:id/diagnostics). */
export interface AttemptDiagnostics {
  readonly collectedBy: 'updater' | 'worker';
  readonly verdict: string;
  readonly bootLog: readonly string[];
  readonly serviceOutput: readonly string[];
  readonly updaterLog: readonly string[];
  readonly restartErrors: readonly string[];
}

const optLines = (o: Record<string, unknown>, key: string): string[] =>
  o[key] === undefined ? [] : strArray(o, key);

export function getAttemptDiagnostics(
  attemptId: string,
  opts: Opts = {},
): Promise<AttemptDiagnostics | null> {
  return apiRequest(
    'GET',
    `/releases/attempts/${encodeURIComponent(attemptId)}/diagnostics`,
    (v) => {
      const o = obj(v);
      if (o.diagnostics === null) return null;
      const d = obj(o.diagnostics);
      const by = str(d, 'collectedBy');
      return {
        collectedBy: by === 'updater' ? 'updater' : 'worker',
        verdict: str(d, 'verdict'),
        bootLog: optLines(d, 'bootLog'),
        serviceOutput: optLines(d, 'serviceOutput'),
        updaterLog: optLines(d, 'updaterLog'),
        restartErrors: optLines(d, 'restartErrors'),
      };
    },
    opts,
  );
}

export interface ReleasesOverview {
  readonly releases: readonly ReleaseInfo[];
  readonly channels: readonly ChannelInfo[];
  readonly attempts: readonly AttemptInfo[];
}

type Opts = Omit<RequestOptions, 'body'>;

function list<T>(o: Record<string, unknown>, key: string, item: (v: Record<string, unknown>) => T): T[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new ShapeError(`expected ${key}[]`);
  return v.map((x) => item(obj(x)));
}

function release(o: Record<string, unknown>): ReleaseInfo {
  return {
    version: str(o, 'version'),
    channel: str(o, 'channel'),
    sha256: str(o, 'sha256'),
    sizeBytes: int(o, 'sizeBytes'),
    keyId: str(o, 'keyId'),
    uploadedAt: str(o, 'uploadedAt'),
  };
}

function channel(o: Record<string, unknown>): ChannelInfo {
  return {
    channel: str(o, 'channel'),
    version: str(o, 'version'),
    rolloutPercent: int(o, 'rolloutPercent'),
    updatedAt: str(o, 'updatedAt'),
  };
}

function attempt(a: Record<string, unknown>): AttemptInfo {
  return {
    id: str(a, 'id'),
    workerId: str(a, 'workerId'),
    fromVersion: str(a, 'fromVersion'),
    toVersion: str(a, 'toVersion'),
    status: str(a, 'status'),
    reason: nullableStr(a, 'reason'),
    // Tolerant: a master before p6-worker-boot-diagnostics sends neither field.
    detail: a.detail === undefined ? null : nullableStr(a, 'detail'),
    verdict: a.verdict === undefined ? null : nullableStr(a, 'verdict'),
    hasDiagnostics: a.hasDiagnostics === true,
    updatedAt: str(a, 'updatedAt'),
  };
}

export function getReleases(opts: Opts = {}): Promise<ReleasesOverview> {
  return apiRequest(
    'GET',
    '/releases',
    (v) => {
      const o = obj(v);
      return {
        releases: list(o, 'releases', release),
        channels: list(o, 'channels', channel),
        attempts: list(o, 'attempts', attempt),
      };
    },
    opts,
  );
}

/** p9-pagination: one keyset page of the update attempts (newest first; `attemptsNextCursor`). */
export function getReleaseAttempts(
  page: { readonly cursor: string | null; readonly limit: number },
  opts: Opts = {},
): Promise<{ items: AttemptInfo[]; nextCursor: string | null }> {
  const q = new URLSearchParams({ limit: String(page.limit) });
  if (page.cursor !== null) q.set('cursor', page.cursor);
  return apiRequest(
    'GET',
    `/releases?${q.toString()}`,
    (v) => {
      const o = obj(v);
      return {
        items: list(o, 'attempts', attempt),
        nextCursor: typeof o.attemptsNextCursor === 'string' ? o.attemptsNextCursor : null,
      };
    },
    opts,
  );
}

/**
 * Upload the `release.json` document written by `scripts/release/sign.mjs` (manifest, detached
 * signature and artifact). The master refuses it unless the release key signature verifies.
 */
export function uploadRelease(document: unknown, opts: Opts = {}): Promise<ReleaseInfo> {
  return apiRequest('POST', '/releases', (v) => release(obj(v)), { ...opts, body: document });
}

export function promoteRelease(
  channelName: string,
  version: string,
  rolloutPercent: number,
  opts: Opts = {},
): Promise<ChannelInfo> {
  return apiRequest('PUT', `/releases/channels/${encodeURIComponent(channelName)}`, (v) => channel(obj(v)), {
    ...opts,
    body: { version, rolloutPercent },
  });
}

/** p17-worker-managed: what `POST /workers/:id/update` changed (202). */
export interface WorkerUpdateTarget {
  readonly workerId: string;
  readonly channel: string;
  readonly targetVersion: string | null;
  readonly rollback: boolean;
  readonly force: boolean;
}

/**
 * p17-worker-managed: a machine's update channel and/or explicit target version (step-up). Only `channel`: follow the
 * channel (clears a pin); `version`: pin it; `rollback: true` for a version lower than the running one; `force`: do not
 * wait for running jobs. Re-sending the version that failed retries it (a new intent).
 */
export function targetWorkerUpdate(
  workerId: string,
  body: {
    readonly channel?: string;
    readonly version?: string;
    readonly rollback?: boolean;
    readonly force?: boolean;
  },
  opts: Opts = {},
): Promise<WorkerUpdateTarget> {
  return apiRequest(
    'POST',
    `/workers/${encodeURIComponent(workerId)}/update`,
    (v) => {
      const o = obj(v);
      return {
        workerId: str(o, 'workerId'),
        channel: str(o, 'channel'),
        targetVersion: nullableStr(o, 'targetVersion'),
        rollback: o.rollback === true,
        force: o.force === true,
      };
    },
    { ...opts, body },
  );
}

// ------------------------------------------------------------------ chunked upload (p6-release-upload)

export interface ReleaseUploadInfo {
  readonly id: string;
  readonly totalBytes: number;
  readonly partSize: number;
  readonly partCount: number;
  /** 0-based indexes of the parts the master holds. */
  readonly received: readonly number[];
  readonly expiresAt: string;
}

function uploadInfo(o: Record<string, unknown>): ReleaseUploadInfo {
  const received = o.received;
  if (!Array.isArray(received) || !received.every((n) => typeof n === 'number' && Number.isInteger(n))) {
    throw new ShapeError('expected received[]');
  }
  return {
    id: str(o, 'id'),
    totalBytes: int(o, 'totalBytes'),
    partSize: int(o, 'partSize'),
    partCount: int(o, 'partCount'),
    received: received as number[],
    expiresAt: str(o, 'expiresAt'),
  };
}

type PartOpts = Pick<RequestOptions, 'fetchImpl' | 'cookieString' | 'signal'>;

/** Starts a chunked upload of a release.json (step-up): its size, SHA-256 (hex) and the part size. */
export function startReleaseUpload(
  input: { totalBytes: number; sha256: string; partSize: number },
  opts: PartOpts = {},
): Promise<ReleaseUploadInfo> {
  return apiRequest('POST', '/releases/uploads', (v) => uploadInfo(obj(v)), { ...opts, body: input });
}

/** Which parts of an upload the master holds (to resume). */
export function getReleaseUpload(id: string, opts: PartOpts = {}): Promise<ReleaseUploadInfo> {
  return apiRequest('GET', `/releases/uploads/${encodeURIComponent(id)}`, (v) => uploadInfo(obj(v)), opts);
}

/** Sends part `n` (0-based) as raw bytes with its SHA-256; a retry overwrites. */
export function putReleaseUploadPart(
  id: string,
  n: number,
  bytes: Blob | ArrayBuffer,
  sha256: string,
  opts: PartOpts = {},
): Promise<{ n: number; received: number }> {
  return apiRequest(
    'PUT',
    `/releases/uploads/${encodeURIComponent(id)}/parts/${String(n)}`,
    (v) => {
      const o = obj(v);
      return { n: int(o, 'n'), received: int(o, 'received') };
    },
    {
      ...opts,
      rawBody: bytes,
      contentType: 'application/octet-stream',
      headers: { 'X-Part-SHA256': sha256 },
    },
  );
}

/** Assembles the upload; the master verifies it exactly like a direct upload (step-up). */
export function completeReleaseUpload(id: string, opts: PartOpts = {}): Promise<ReleaseInfo> {
  return apiRequest(
    'POST',
    `/releases/uploads/${encodeURIComponent(id)}/complete`,
    (v) => release(obj(v)),
    opts,
  );
}

/** Cancels an upload and drops its parts on the master. */
export function abortReleaseUpload(id: string, opts: PartOpts = {}): Promise<void> {
  return apiRequest('DELETE', `/releases/uploads/${encodeURIComponent(id)}`, () => undefined, opts);
}
