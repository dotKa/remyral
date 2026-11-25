import {
  type BlobUploadGrantPayload,
  type BlobUploadStatusPayload,
  INPUT_CHUNK_BYTES,
  type InputBundleEntry,
  type InputBundleOp,
  type RecoverableJob,
  SKILL_FILE_CHUNK_BYTES,
  type WorkerToMaster,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { FleetSessionHandler, type FleetSessionDeps } from '../workers/sessions.js';
import type { WorkerSession } from '../workers/types.js';
import { LEASE_HELD_UNTIL_SQL } from '../jobs/store.js';

type CredentialRequest = Extract<WorkerToMaster, { type: 'CREDENTIAL_REQUEST' }>;
type InputRequest = Extract<WorkerToMaster, { type: 'JOB_INPUT_REQUEST' }>;

/** p5-research-workspace: slices of a workspace job's input files (WorkspaceService.inputSlice). */
export interface JobInputSource {
  inputSlice(
    jobId: string,
    inputId: string,
    offset: number,
    max: number,
  ): Promise<{ data: Buffer; eof: boolean } | null>;
}

/** p14-skill-catalogs: slices of the files of skills pinned to a job (SkillService.fileSlice). */
export interface SkillFileSource {
  fileSlice(
    jobId: string,
    manifestSha256: string,
    path: string,
    offset: number,
    max: number,
  ): Promise<{ data: Buffer; eof: boolean } | null>;
}

type SkillFileRequest = Extract<WorkerToMaster, { type: 'SKILL_FILE_REQUEST' }>;
type InputBundleRequest = Extract<WorkerToMaster, { type: 'INPUT_BUNDLE_REQUEST' }>;
type BlobUploadRequest = Extract<WorkerToMaster, { type: 'BLOB_UPLOAD_REQUEST' }>;
type BlobUploadComplete = Extract<WorkerToMaster, { type: 'BLOB_UPLOAD_COMPLETE' }>;

/** p17-object-storage: upload grants and verification of large outputs (BlobUploads). */
export interface BlobUploadSink {
  grant(
    workerId: string,
    jobId: string,
    p: BlobUploadRequest['payload'],
  ): Promise<Omit<BlobUploadGrantPayload, 'attemptId' | 'epoch' | 'requestId'>>;
  complete(
    workerId: string,
    jobId: string,
    p: BlobUploadComplete['payload'],
  ): Promise<Omit<BlobUploadStatusPayload, 'attemptId' | 'epoch' | 'requestId'>>;
}

/** p16-zip-job-input: pages / slices of a job's input bundle (InputUploadService.slice). */
export interface InputBundleSource {
  slice(
    jobId: string,
    op: InputBundleOp,
  ): Promise<
    | { readonly kind: 'list'; readonly entries: InputBundleEntry[]; readonly total: number }
    | { readonly kind: 'read'; readonly data: Buffer; readonly eof: boolean }
    | null
  >;
}

/** A short-lived, job-scoped git credential (ADR-0006 §3, T-WRK-4). */
export interface GitCredential {
  readonly token: string;
  readonly username?: string;
  readonly expiresAt: Date;
}

/**
 * Mints per-job, per-repository git tokens (p4-git-flow implements a GitHub App installation-token
 * provider). `null` = no credential for this repository (public or ssh repositories).
 */
export interface GitCredentialProvider {
  issue(job: {
    readonly jobId: string;
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
  }): Promise<GitCredential | null>;
  /**
   * p15-services: a short-lived READ-ONLY token for the worker's own checkout of a project's repository for a
   * service (never in the service's environment). Absent / null: none (public repositories).
   */
  issueReadOnly?(req: {
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
  }): Promise<GitCredential | null>;
  /**
   * p19-ide W2: a short-lived **write** token for one "Gönder" of an IDE workspace (the daemon pushes the workspace's own
   * `remyral/ide/…` branch with it; it never enters the IDE). Only for the project's configured repository.
   */
  issueIdePush?(req: {
    readonly project: string;
    readonly repositoryUrl: string;
    readonly workerId: string;
    readonly workspaceId: string;
  }): Promise<GitCredential | null>;
}

export const noGitCredentials: GitCredentialProvider = { issue: () => Promise.resolve(null) };

export interface RunningJobReport {
  readonly jobId: string;
  readonly attemptId: string;
  readonly epoch: number;
}

export interface OrchestrationSessionDeps extends FleetSessionDeps {
  readonly audit: AuditRecorder;
  readonly credentials?: GitCredentialProvider;
  /** p5-research-workspace: input files of workspace jobs (absent: every JOB_INPUT_REQUEST is refused). */
  readonly inputs?: () => JobInputSource | null;
  /** p16-zip-job-input: job input bundles (absent: every INPUT_BUNDLE_REQUEST is refused). */
  readonly inputBundles?: () => InputBundleSource | null;
  /** p17-object-storage: large output uploads (absent: every BLOB_UPLOAD_REQUEST is refused). */
  readonly blobUploads?: () => BlobUploadSink | null;
  /** p14-skill-catalogs: files of deferred skills (absent: every SKILL_FILE_REQUEST is refused). */
  readonly skillFiles?: () => SkillFileSource | null;
  /** p8-orchestration (ADR-0031): SUBTASK_REQUEST of running jobs (absent: every request goes unanswered). */
  readonly subtasks?: () => {
    onRequest(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'SUBTASK_REQUEST' }>,
    ): Promise<void>;
  } | null;
  /** p14-ask-user: QUESTION_REQUEST of running jobs (absent: every request goes unanswered). */
  readonly questions?: () => {
    onRequest(
      session: WorkerSession,
      message: Extract<WorkerToMaster, { type: 'QUESTION_REQUEST' }>,
    ): Promise<void>;
  } | null;
  /** Called after a session started (the reconciler re-examines that worker's jobs). */
  readonly onWorkerConnected?: (workerId: string) => void;
  /** p11-session-continuity: CHECKPOINT_REPORT of running jobs (absent: dropped). */
  readonly checkpoints?: () => {
    onCheckpoint(
      workerId: string,
      jobId: string,
      payload: Extract<WorkerToMaster, { type: 'CHECKPOINT_REPORT' }>['payload'],
    ): Promise<boolean>;
  } | null;
}

/**
 * Fleet session handler plus the job-facing control messages (p4-leases): CREDENTIAL_REQUEST, and the
 * running-jobs list each HEARTBEAT carries (input for resume decisions, p4-recovery).
 */
export class OrchestrationSessionHandler extends FleetSessionHandler {
  readonly #running = new Map<string, readonly RunningJobReport[]>();
  /** p11-session-continuity: attempts a restarted worker reported it can resume (HEARTBEAT `recoverableJobs`). */
  readonly #recoverable = new Map<string, readonly RecoverableJob[]>();
  /** Workers whose current session already sent a HEARTBEAT (their running-jobs list is authoritative). */
  readonly #reported = new Set<string>();
  readonly #o: OrchestrationSessionDeps;

  constructor(deps: OrchestrationSessionDeps) {
    super(deps);
    this.#o = deps;
  }

  /** Jobs the connected worker last reported as running (empty when not connected). */
  runningJobs(workerId: string): readonly RunningJobReport[] {
    return this.deps.hub.isConnected(workerId) ? (this.#running.get(workerId) ?? []) : [];
  }

  /** p11-session-continuity: what the connected worker last reported as resumable after its restart. */
  recoverableJobs(workerId: string): readonly RecoverableJob[] {
    return this.deps.hub.isConnected(workerId) ? (this.#recoverable.get(workerId) ?? []) : [];
  }

  /** Workers with a non-empty `recoverableJobs` report. */
  workersWithRecoverable(): string[] {
    return [...this.#recoverable.entries()]
      .filter(([w, r]) => r.length > 0 && this.deps.hub.isConnected(w))
      .map(([w]) => w);
  }

  isConnectedWorker(workerId: string): boolean {
    return this.deps.hub.isConnected(workerId);
  }

  hasReported(workerId: string): boolean {
    return this.deps.hub.isConnected(workerId) && this.#reported.has(workerId);
  }

  override async onSessionStart(session: WorkerSession): Promise<void> {
    this.#reported.delete(session.workerId);
    this.#running.delete(session.workerId);
    this.#recoverable.delete(session.workerId);
    await super.onSessionStart(session);
    this.#o.onWorkerConnected?.(session.workerId);
  }

  override async onSessionEnd(session: WorkerSession, reason: string): Promise<void> {
    if (!this.deps.hub.isConnected(session.workerId)) {
      this.#running.delete(session.workerId);
      this.#reported.delete(session.workerId);
      this.#recoverable.delete(session.workerId);
    }
    await super.onSessionEnd(session, reason);
  }

  override async onMessage(session: WorkerSession, message: WorkerToMaster): Promise<void> {
    if (message.type === 'HEARTBEAT') {
      this.#running.set(
        session.workerId,
        message.payload.runningJobs.map((j) => ({ jobId: j.jobId, attemptId: j.attemptId, epoch: j.epoch })),
      );
      this.#recoverable.set(session.workerId, message.payload.recoverableJobs ?? []);
      this.#reported.add(session.workerId);
    }
    if (message.type === 'CHECKPOINT_REPORT') {
      await this.#o
        .checkpoints?.()
        ?.onCheckpoint(session.workerId, message.jobId, message.payload)
        .catch((err: unknown) => {
          this.deps.log.warn({ err, workerId: session.workerId }, 'checkpoint report not stored');
        });
      return;
    }
    if (message.type === 'CREDENTIAL_REQUEST') {
      await this.#credential(session, message);
      return;
    }
    if (message.type === 'JOB_INPUT_REQUEST') {
      await this.#input(session, message);
      return;
    }
    if (message.type === 'SKILL_FILE_REQUEST') {
      await this.#skillFile(session, message);
      return;
    }
    if (message.type === 'INPUT_BUNDLE_REQUEST') {
      await this.#inputBundle(session, message);
      return;
    }
    if (message.type === 'BLOB_UPLOAD_REQUEST' || message.type === 'BLOB_UPLOAD_COMPLETE') {
      await this.#blobUpload(session, message);
      return;
    }
    if (message.type === 'SUBTASK_REQUEST') {
      await this.#o.subtasks?.()?.onRequest(session, message);
      return;
    }
    if (message.type === 'QUESTION_REQUEST') {
      await this.#o.questions?.()?.onRequest(session, message);
      return;
    }
    await super.onMessage(session, message);
  }

  /**
   * JOB_INPUT_DATA (p5-research-workspace) is a control message (seq 0): input bytes are read from Postgres per
   * request and never written to `worker_outbox`. Only the worker holding the job's live lease under that
   * attempt/epoch gets data; the first slice of each input is audited.
   */
  async #input(session: WorkerSession, message: InputRequest): Promise<void> {
    const p = message.payload;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [message.jobId, p.epoch, p.attemptId, session.workerId, now],
    );
    const reply = (status: 'ok' | 'refused' | 'not_found', data = '', eof = true) =>
      session
        .send(
          'JOB_INPUT_DATA',
          {
            attemptId: p.attemptId,
            epoch: p.epoch,
            requestId: p.requestId,
            inputId: p.inputId,
            status,
            offset: p.offset,
            data,
            eof,
          },
          { jobId: message.jobId },
        )
        .catch(() => undefined);
    const source = this.#o.inputs?.() ?? null;
    if (rows.length === 0 || source === null) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'job.input.read',
        target: `job:${message.jobId.slice(0, 64)}`,
        outcome: 'denied',
        metadata: {
          inputId: p.inputId,
          epoch: p.epoch,
          denial: source === null ? 'unsupported' : 'stale_epoch',
        },
      });
      await reply('refused');
      return;
    }
    const slice = await source.inputSlice(message.jobId, p.inputId, p.offset, INPUT_CHUNK_BYTES);
    if (slice === null) {
      await reply('not_found');
      return;
    }
    if (p.offset === 0) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'job.input.read',
        target: `job:${message.jobId}`,
        outcome: 'success',
        metadata: { inputId: p.inputId, epoch: p.epoch },
      });
    }
    await reply('ok', slice.data.toString('base64'), slice.eof);
  }

  /**
   * INPUT_BUNDLE_DATA (p16-zip-job-input) is a control message (seq 0), never written to `worker_outbox`: a page of the
   * listing or a slice of one file of the input bundle **the job recorded** (job_input_uploads), only for the worker
   * holding the job's live lease under that attempt/epoch. The worker checks every file's size and SHA-256 against the
   * listing and the listing against the signed assignment's `bundleSha256`. Refusals and the first page are audited.
   */
  async #inputBundle(session: WorkerSession, message: InputBundleRequest): Promise<void> {
    const p = message.payload;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [message.jobId, p.epoch, p.attemptId, session.workerId, now],
    );
    const reply = (
      status: 'ok' | 'refused' | 'not_found',
      extra: Record<string, unknown> = {},
    ): Promise<void> =>
      session
        .send(
          'INPUT_BUNDLE_DATA',
          { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId, status, ...extra },
          { jobId: message.jobId },
        )
        .catch(() => undefined);
    const source = this.#o.inputBundles?.() ?? null;
    if (rows.length === 0 || source === null) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'job.input_bundle.read',
        target: `job:${message.jobId.slice(0, 64)}`,
        outcome: 'denied',
        metadata: { epoch: p.epoch, op: p.op.op, denial: source === null ? 'unsupported' : 'stale_epoch' },
      });
      await reply('refused');
      return;
    }
    const slice = await source.slice(message.jobId, p.op);
    if (slice === null) {
      await reply('not_found');
      return;
    }
    if (slice.kind === 'list') {
      if (p.op.op === 'list' && p.op.offset === 0) {
        await this.#o.audit.record({
          actor: { type: 'worker', id: session.workerId },
          action: 'job.input_bundle.read',
          target: `job:${message.jobId}`,
          outcome: 'success',
          metadata: { epoch: p.epoch, files: slice.total },
        });
      }
      await reply('ok', { entries: slice.entries, total: slice.total });
      return;
    }
    await reply('ok', {
      offset: p.op.op === 'read' ? p.op.offset : 0,
      data: slice.data.toString('base64'),
      eof: slice.eof,
    });
  }

  /** True when `workerId` holds the job's live lease under this attempt / epoch. */
  async #liveLease(workerId: string, jobId: string, attemptId: string, epoch: number): Promise<boolean> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [jobId, epoch, attemptId, workerId, this.deps.clock()],
    );
    return rows.length > 0;
  }

  /**
   * p17-object-storage: BLOB_UPLOAD_REQUEST → BLOB_UPLOAD_GRANT and BLOB_UPLOAD_COMPLETE → BLOB_UPLOAD_STATUS (control
   * messages, never in the outbox), only for the worker holding the job's live lease. The verification after COMPLETE
   * reads the whole object back, so it runs without blocking this session's other messages.
   */
  async #blobUpload(session: WorkerSession, message: BlobUploadRequest | BlobUploadComplete): Promise<void> {
    const p = message.payload;
    const sink = this.#o.blobUploads?.() ?? null;
    const live =
      sink !== null && (await this.#liveLease(session.workerId, message.jobId, p.attemptId, p.epoch));
    const base = { attemptId: p.attemptId, epoch: p.epoch, requestId: p.requestId };
    if (!live) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: message.type === 'BLOB_UPLOAD_REQUEST' ? 'blob.upload.grant' : 'blob.upload.verify',
        target: `job:${message.jobId.slice(0, 64)}`,
        outcome: 'denied',
        metadata: { epoch: p.epoch, denial: sink === null ? 'unsupported' : 'stale_epoch' },
      });
      if (message.type === 'BLOB_UPLOAD_REQUEST') {
        await session
          .send(
            'BLOB_UPLOAD_GRANT',
            { ...base, status: 'refused', reason: sink === null ? 'not_configured' : 'stale' },
            { jobId: message.jobId },
          )
          .catch(() => undefined);
      } else {
        await session
          .send(
            'BLOB_UPLOAD_STATUS',
            { ...base, uploadId: message.payload.uploadId, status: 'refused', reason: 'stale_lease' },
            { jobId: message.jobId },
          )
          .catch(() => undefined);
      }
      return;
    }
    if (message.type === 'BLOB_UPLOAD_REQUEST') {
      const reply = await sink
        .grant(session.workerId, message.jobId, message.payload)
        .catch((err: unknown) => {
          this.deps.log.error({ err, jobId: message.jobId }, 'blob upload grant failed');
          return { status: 'refused' as const, reason: 'unavailable' as const };
        });
      await session
        .send('BLOB_UPLOAD_GRANT', { ...base, ...reply }, { jobId: message.jobId })
        .catch(() => undefined);
      return;
    }
    const complete = message.payload;
    void sink
      .complete(session.workerId, message.jobId, complete)
      .catch((err: unknown) => {
        this.deps.log.error({ err, jobId: message.jobId }, 'blob upload verification failed');
        return { uploadId: complete.uploadId, status: 'failed' as const, reason: 'verification_error' };
      })
      .then((status) =>
        session
          .send('BLOB_UPLOAD_STATUS', { ...base, ...status }, { jobId: message.jobId })
          .catch(() => undefined),
      );
  }

  /**
   * SKILL_FILE_DATA (p14-skill-catalogs) is a control message (seq 0), never written to `worker_outbox`: one slice of a
   * file of a skill **pinned to that job** (job_skill_pins, by manifest SHA-256), only for the worker holding the job's
   * live lease under that attempt/epoch. The worker checks every byte against the signed manifest itself; the master
   * only refuses to hand out anything else. Refusals are audited; served slices are covered by `skill.issue`.
   */
  async #skillFile(session: WorkerSession, message: SkillFileRequest): Promise<void> {
    const p = message.payload;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [message.jobId, p.epoch, p.attemptId, session.workerId, now],
    );
    const reply = (status: 'ok' | 'refused' | 'not_found', data = '', eof = true) =>
      session
        .send(
          'SKILL_FILE_DATA',
          {
            attemptId: p.attemptId,
            epoch: p.epoch,
            requestId: p.requestId,
            manifestSha256: p.manifestSha256,
            path: p.path,
            status,
            offset: p.offset,
            data,
            eof,
          },
          { jobId: message.jobId },
        )
        .catch(() => undefined);
    const source = this.#o.skillFiles?.() ?? null;
    if (rows.length === 0 || source === null) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'skill.file.read',
        target: `job:${message.jobId.slice(0, 64)}`,
        outcome: 'denied',
        metadata: {
          manifestSha256: p.manifestSha256,
          epoch: p.epoch,
          denial: source === null ? 'unsupported' : 'stale_epoch',
        },
      });
      await reply('refused');
      return;
    }
    const slice = await source.fileSlice(
      message.jobId,
      p.manifestSha256,
      p.path,
      p.offset,
      SKILL_FILE_CHUNK_BYTES,
    );
    if (slice === null) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'skill.file.read',
        target: `job:${message.jobId}`,
        outcome: 'denied',
        metadata: { manifestSha256: p.manifestSha256, epoch: p.epoch, denial: 'not_pinned' },
      });
      await reply('not_found');
      return;
    }
    await reply('ok', slice.data.toString('base64'), slice.eof);
  }

  /**
   * JOB_CREDENTIAL is a control message (seq 0): the token is only held in memory while it is sent and
   * never reaches `worker_outbox`, logs or the audit log (which records the issuance, not the value).
   * Only the worker holding the job's live lease under that attempt/epoch gets one.
   */
  async #credential(session: WorkerSession, message: CredentialRequest): Promise<void> {
    const p = message.payload;
    const now = this.deps.clock();
    const { rows } = await this.deps.pool.query<{ project: string; url: string | null }>(
      `SELECT j.project, j.spec->'repository'->>'url' AS url
         FROM jobs j JOIN leases l ON l.job_id = j.id
        WHERE j.id::text = $1 AND l.epoch = $2 AND l.attempt_id::text = $3 AND l.worker_id = $4
          AND l.released_at IS NULL AND ${LEASE_HELD_UNTIL_SQL('l')} > $5 AND j.lease_epoch = l.epoch`,
      [message.jobId, p.epoch, p.attemptId, session.workerId, now],
    );
    const job = rows[0];
    const reply = (status: 'granted' | 'unavailable' | 'refused', cred?: GitCredential) =>
      session
        .send(
          'JOB_CREDENTIAL',
          {
            attemptId: p.attemptId,
            epoch: p.epoch,
            requestId: p.requestId,
            kind: 'git',
            status,
            ...(cred
              ? {
                  token: cred.token,
                  expiresAt: cred.expiresAt.toISOString(),
                  ...(cred.username ? { username: cred.username } : {}),
                }
              : {}),
          },
          { jobId: message.jobId },
        )
        .catch(() => undefined);
    if (job === undefined || job.url === null) {
      await this.#o.audit.record({
        actor: { type: 'worker', id: session.workerId },
        action: 'job.credential.issue',
        target: `job:${message.jobId.slice(0, 64)}`,
        outcome: 'denied',
        metadata: { kind: 'git', epoch: p.epoch, denial: 'stale_epoch' },
      });
      await reply('refused');
      return;
    }
    const cred = await (this.#o.credentials ?? noGitCredentials).issue({
      jobId: message.jobId,
      project: job.project,
      repositoryUrl: job.url,
      workerId: session.workerId,
    });
    await this.#o.audit.record({
      actor: { type: 'worker', id: session.workerId },
      action: 'job.credential.issue',
      target: `job:${message.jobId}`,
      outcome: 'success',
      metadata: {
        kind: 'git',
        epoch: p.epoch,
        status: cred === null ? 'unavailable' : 'granted',
        ...(cred === null ? {} : { expiresAt: cred.expiresAt.toISOString() }),
        // p15-git-central: git-central-v1 workers ask right before each fetch / push (and once more on a refusal).
        purpose: p.purpose ?? 'fetch',
        ...(p.retry === true ? { retry: true } : {}),
      },
    });
    await reply(cred === null ? 'unavailable' : 'granted', cred ?? undefined);
  }
}
