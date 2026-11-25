import {
  compareReleaseVersions,
  MAX_RELEASE_ARTIFACT_BYTES,
  type MasterToWorker,
  nodeVersionAtLeast,
  ReleaseSignature,
  ReleaseVersion,
  verifyReleaseArtifact,
  verifyReleaseManifest,
  type WorkerToMaster,
} from '@remyral/protocol';
import { Redactor, type Logger } from '@remyral/observability';
import { z } from 'zod';
import type { UpdateSettings } from '../config/schema.js';
import { pathApi } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';
import type { FileOps } from '../fs/ops.js';
import { DownloadError, type Downloader } from './download.js';
import { collectUpdateDiagnostics, readTailSafe, type TailReader } from '../boot/diagnostics.js';
import { readJsonDocument, UpdateDiagnosticsFile, UpdateResult, UpdaterState } from './files.js';
import {
  bundleName,
  type DataLayout,
  type InstallLayout,
  MANIFEST_NAME,
  SIGNATURE_NAME,
  versionDir,
} from './layout.js';

/** `failed` outcomes after which the new version had been started (so its boot evidence matters). */
const FAILURE_WITH_EVIDENCE = new Set(['health_check_failed', 'rollback_unavailable']);
const DEFAULT_REDACTOR = new Redactor();

export type UpdateOffer = Extract<MasterToWorker, { type: 'UPDATE_AVAILABLE' }>['payload'];
export type UpdateStatusPayload = Extract<WorkerToMaster, { type: 'UPDATE_STATUS' }>['payload'];

/** What the daemon lends the update agent (wired in `WorkerDaemon.start`). */
export interface UpdateHost {
  /** UPDATE_STATUS control message to the master (rejects while no session is up). */
  send(payload: UpdateStatusPayload): Promise<void>;
  /** Jobs whose processes run on this worker right now. */
  runningJobs(): number;
  /** Accept no new jobs while waiting to update (the master sees `draining`). */
  beginLocalDrain(): void;
  /** Undo {@link beginLocalDrain} (unless the master itself asked to drain). */
  endLocalDrain(): void;
  /** State machine → `updating`; false when not allowed right now (e.g. jobs still running). */
  updateStarted(): boolean;
  /** State machine back from `updating` after a failed activation. */
  updateFailed(): void;
}

/** Hooks the daemon calls (kept tiny so job-execution work in the daemon does not collide with this). */
export interface DaemonUpdateHooks {
  attach(host: UpdateHost): void;
  onSessionEstablished(negotiatedVersion: string): void;
  onHeartbeatSent(): void;
  onUpdateAvailable(offer: UpdateOffer): void;
  stop(): void;
}

export interface UpdateAgentDeps {
  readonly ops: FileOps;
  readonly data: DataLayout;
  readonly install: InstallLayout;
  readonly settings: UpdateSettings;
  readonly currentVersion: string;
  readonly trustedKeys: readonly string[];
  readonly download: Downloader;
  readonly logger: Logger;
  readonly nodeVersion?: string;
  readonly now?: () => Date;
  readonly pid?: number;
  /** How long to wait for the privileged updater to act on a request. Default 5 min. */
  readonly activationTimeoutMs?: number;
  /** How often to re-check for running jobs while deferred. Default 5 s. */
  readonly idlePollMs?: number;
  /** After a start, look for the updater's outcome this often (default 2 s), this many times (60). */
  readonly followUpMs?: number;
  readonly followUpRounds?: number;
  /** Health file write attempts per heartbeat (Windows rename races with the updater reading it). */
  readonly healthWriteAttempts?: number;
  readonly healthWriteRetryMs?: number;
  /** p6-worker-boot-diagnostics: redaction of collected evidence (default: patterns only). */
  readonly redactor?: Pick<Redactor, 'redact'>;
  readonly env?: (name: string) => string | undefined;
  /** Test seam for reading log tails. */
  readonly readTail?: TailReader;
}

const ManifestDocument = z.strictObject({
  manifest: z.base64().max(16 * 1024),
  signature: ReleaseSignature,
});

const ReportedDocument = z.strictObject({ schema: z.literal(1), attemptIds: z.array(z.uuid()).max(32) });

class Refusal extends Error {
  constructor(
    readonly phase: 'refused' | 'failed' | 'succeeded',
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(`${reason}${detail === undefined ? '' : `: ${detail}`}`);
  }
}

/**
 * The unprivileged half of signed updates (docs/design/p2-signed-updates.md): receive UPDATE_AVAILABLE,
 * download and fully verify the release (pinned key, SHA-256/size, channel, downgrade, protocol, Node),
 * stage it in the data dir, wait until no job runs (unless forced), then ask the privileged updater to
 * activate it. It never touches the install dir — it cannot (read-only for the service account).
 * After the restart, the new daemon proves its health (session + heartbeat) through `update-health.json`
 * and reports the updater's final outcome to the master.
 */
export class UpdateAgent implements DaemonUpdateHooks {
  #host: UpdateHost | null = null;
  #negotiatedVersion: string | null = null;
  #sessionEstablishedAt: Date | null = null;
  #healthWritten = false;
  #healthWriting = false;
  #busy: Promise<void> = Promise.resolve();
  #inFlight: string | null = null;
  #activationTimer: NodeJS.Timeout | null = null;
  #followUpTimer: NodeJS.Timeout | null = null;
  #stopped = false;
  #drainedForUpdate = false;
  readonly #log: Logger;
  readonly #p: ReturnType<typeof pathApi>;

  constructor(private readonly deps: UpdateAgentDeps) {
    this.#log = deps.logger.child({ component: 'update' });
    this.#p = pathApi(deps.ops.platform);
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  attach(host: UpdateHost): void {
    this.#host = host;
  }

  onSessionEstablished(negotiatedVersion: string): void {
    this.#negotiatedVersion = negotiatedVersion;
    this.#sessionEstablishedAt = this.#now();
    this.#healthWritten = false;
  }

  onHeartbeatSent(): void {
    if (this.#stopped) return;
    if (!this.#healthWritten && !this.#healthWriting && this.#sessionEstablishedAt !== null) {
      // A failed write is retried on the next heartbeat: without the file the updater rolls this version back.
      this.#healthWriting = true;
      void this.#writeHealth(this.#sessionEstablishedAt)
        .then((ok) => {
          this.#healthWritten = ok;
        })
        .finally(() => {
          this.#healthWriting = false;
        });
      this.#followUp();
    }
    void this.reportResult();
  }

  /**
   * Right after a (re)start the updater may still be deciding (health check, rollback): look for its
   * outcome every few seconds for a while instead of waiting for the next heartbeat.
   */
  #followUp(): void {
    if (this.#followUpTimer !== null) return;
    let rounds = 0;
    this.#followUpTimer = setInterval(() => {
      rounds += 1;
      if (this.#stopped || rounds > (this.deps.followUpRounds ?? 60)) {
        if (this.#followUpTimer !== null) clearInterval(this.#followUpTimer);
        this.#followUpTimer = null;
        return;
      }
      void this.reportResult();
    }, this.deps.followUpMs ?? 2_000);
    this.#followUpTimer.unref();
  }

  onUpdateAvailable(offer: UpdateOffer): void {
    if (this.#stopped) return;
    if (this.#inFlight !== null) {
      this.#log.info('update offer ignored: another attempt is in progress', {
        attemptId: offer.attemptId,
        inFlight: this.#inFlight,
      });
      return;
    }
    this.#inFlight = offer.attemptId;
    this.#busy = this.#busy.then(() => this.#process(offer)).finally(() => undefined);
  }

  /** p17-disk-selfclean: an update attempt is being downloaded, staged or activated (its staged files stay). */
  inFlight(): boolean {
    return this.#inFlight !== null;
  }

  /** Resolves when the current attempt reached activation or a final outcome (tests). */
  async settled(): Promise<void> {
    await this.#busy;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#activationTimer !== null) clearTimeout(this.#activationTimer);
    this.#activationTimer = null;
    if (this.#followUpTimer !== null) clearInterval(this.#followUpTimer);
    this.#followUpTimer = null;
  }

  // ------------------------------------------------------------------ attempt

  async #process(offer: UpdateOffer): Promise<void> {
    const report = (phase: UpdateStatusPayload['phase'], reason?: string, detail?: string) =>
      this.#report({
        attemptId: offer.attemptId,
        version: offer.version,
        phase,
        ...(reason === undefined ? {} : { reason }),
        ...(detail === undefined ? {} : { detail: detail.slice(0, 500) }),
        currentVersion: this.deps.currentVersion,
      });
    let activating = false;
    try {
      this.#checkOffer(offer);
      await this.#checkRollbackTarget(offer);
      await this.#checkUpdaterIdle();
      await report('downloading');
      await this.#downloadVerifyStage(offer);
      await this.#waitUntilIdle(offer, async () => {
        await report('deferred', 'jobs_running');
      });
      if (this.#stopped) return;
      await this.#requestActivation(offer);
      activating = true;
      await report('activating');
    } catch (error) {
      if (error instanceof Refusal) {
        this.#log.warn('update not applied', {
          attemptId: offer.attemptId,
          version: offer.version,
          phase: error.phase,
          reason: error.reason,
          detail: error.detail,
        });
        await report(error.phase, error.reason, error.detail);
      } else {
        this.#log.error('update attempt failed', { attemptId: offer.attemptId, err: error });
        await report('failed', 'internal', error instanceof Error ? error.message : undefined);
      }
    } finally {
      if (!activating) {
        this.#inFlight = null;
        this.#endDrain();
      }
    }
  }

  #checkOffer(offer: UpdateOffer): void {
    const s = this.deps.settings;
    if (!s.enabled) throw new Refusal('refused', 'updates_disabled');
    if (this.deps.trustedKeys.length === 0) {
      throw new Refusal('refused', 'no_trusted_keys', 'no release public key is pinned or configured');
    }
    if (offer.channel === 'canary' && s.channel !== 'canary') {
      throw new Refusal('refused', 'channel_not_allowed', 'this worker only accepts stable releases');
    }
    const current = ReleaseVersion.safeParse(this.deps.currentVersion);
    if (current.success) {
      const cmp = compareReleaseVersions(offer.version, current.data);
      if (cmp === 0) throw new Refusal('succeeded', 'already_current');
      if (cmp < 0 && !offer.rollback) {
        throw new Refusal('refused', 'downgrade_refused', `${offer.version} is lower than ${current.data}`);
      }
    }
    if (s.minVersion !== undefined && compareReleaseVersions(offer.version, s.minVersion) < 0) {
      throw new Refusal('refused', 'below_minimum_version', `owner floor is ${s.minVersion}`);
    }
  }

  /**
   * A rollback offer (a lower version) may only return to the previous version the privileged updater recorded and
   * still retains under versions/ — the legitimate rollback — never to an arbitrary older signed release. The updater
   * checks this again (with the bytes) before it activates anything.
   */
  async #checkRollbackTarget(offer: UpdateOffer): Promise<void> {
    const current = ReleaseVersion.safeParse(this.deps.currentVersion);
    if (!offer.rollback || !current.success || compareReleaseVersions(offer.version, current.data) >= 0)
      return;
    const state = await readJsonDocument(this.deps.install.stateFile, UpdaterState).catch(() => null);
    const previous = state?.previous ?? null;
    if (previous === null || previous.version !== offer.version || previous.sha256 !== offer.sha256) {
      throw new Refusal(
        'refused',
        'rollback_not_retained',
        `${offer.version} is not the retained previous version${previous === null ? '' : ` (${previous.version})`}`,
      );
    }
  }

  /** The privileged updater is mid health-check (e.g. it is rolling back): do not queue another request. */
  async #checkUpdaterIdle(): Promise<void> {
    const state = await readJsonDocument(this.deps.install.stateFile, UpdaterState).catch(() => null);
    if (state?.phase === 'health_check') {
      throw new Refusal(
        'failed',
        'updater_busy',
        'the privileged updater is still checking a previous update',
      );
    }
  }

  async #downloadVerifyStage(offer: UpdateOffer): Promise<void> {
    const docBytes = await this.#fetch(offer.manifestUrl, offer.downloadToken, 64 * 1024);
    let doc: z.infer<typeof ManifestDocument>;
    try {
      doc = ManifestDocument.parse(JSON.parse(docBytes.toString('utf8')));
    } catch {
      throw new Refusal('refused', 'invalid_manifest', 'malformed manifest document');
    }
    const manifestBytes = Buffer.from(doc.manifest, 'base64');
    const verified = verifyReleaseManifest(manifestBytes, doc.signature, this.deps.trustedKeys);
    if (!verified.ok) throw new Refusal('refused', verified.reason, verified.detail);
    const m = verified.manifest;
    if (m.version !== offer.version || m.sha256 !== offer.sha256 || m.size !== offer.size) {
      throw new Refusal('refused', 'manifest_mismatch', 'the signed manifest does not match the offer');
    }
    if (m.channel === 'canary' && this.deps.settings.channel !== 'canary') {
      throw new Refusal('refused', 'channel_not_allowed', 'release is signed for canary only');
    }
    const negotiated = this.#negotiatedVersion;
    if (negotiated === null || !m.protocolVersions.includes(negotiated)) {
      throw new Refusal(
        'refused',
        'protocol_incompatible',
        `release speaks ${m.protocolVersions.join(', ')}; the master session uses ${negotiated ?? 'none'}`,
      );
    }
    const node = this.deps.nodeVersion ?? process.versions.node;
    if (!nodeVersionAtLeast(node, m.minNode)) {
      throw new Refusal('refused', 'node_too_old', `release needs Node ${m.minNode}, this is ${node}`);
    }
    // More bytes than the signed size is tampering, not a transport problem.
    const artifact = await this.#fetch(
      offer.artifactUrl,
      offer.downloadToken,
      Math.min(m.size, MAX_RELEASE_ARTIFACT_BYTES),
      'size_mismatch',
    );
    const integrity = verifyReleaseArtifact(m, artifact);
    if (!integrity.ok) throw new Refusal('refused', integrity.reason);

    // Stage (data dir, service account): the updater re-verifies everything before activation.
    const { ops } = this.deps;
    await ops.mkdir(this.deps.data.stagedDir, 0o700);
    for (const old of await ops.readdir(this.deps.data.stagedDir)) {
      if (old !== m.version) await this.#removeStaged(old);
    }
    const dir = versionDir(ops.platform, this.deps.data.stagedDir, m.version);
    await ops.mkdir(dir, 0o700);
    await atomicWriteFile(ops, this.#p.join(dir, bundleName()), artifact, { mode: 0o600 });
    await atomicWriteFile(ops, this.#p.join(dir, MANIFEST_NAME), manifestBytes, { mode: 0o600 });
    await atomicWriteFile(ops, this.#p.join(dir, SIGNATURE_NAME), `${JSON.stringify(doc.signature)}\n`, {
      mode: 0o600,
    });
    this.#log.info('release verified and staged', {
      version: m.version,
      sha256: m.sha256,
      keyId: verified.keyId,
    });
  }

  async #removeStaged(version: string): Promise<void> {
    if (!ReleaseVersion.safeParse(version).success) return;
    const dir = versionDir(this.deps.ops.platform, this.deps.data.stagedDir, version);
    for (const f of [bundleName(), MANIFEST_NAME, SIGNATURE_NAME])
      await this.deps.ops.unlink(this.#p.join(dir, f));
  }

  async #fetch(path: string, token: string, maxBytes: number, tooLarge?: string): Promise<Buffer> {
    try {
      return await this.deps.download(path, token, maxBytes);
    } catch (error) {
      if (error instanceof DownloadError && error.reason === 'too_large' && tooLarge !== undefined) {
        throw new Refusal('refused', tooLarge, error.message);
      }
      if (error instanceof DownloadError)
        throw new Refusal('failed', `download_${error.reason}`, error.message);
      throw error;
    }
  }

  async #waitUntilIdle(offer: UpdateOffer, deferred: () => Promise<void>): Promise<void> {
    const host = this.#host;
    if (host === null || offer.force || host.runningJobs() === 0) return;
    this.#log.info('update staged; waiting for running jobs to finish (draining)', {
      version: offer.version,
      runningJobs: host.runningJobs(),
    });
    this.#drainedForUpdate = true;
    host.beginLocalDrain();
    await deferred();
    const poll = this.deps.idlePollMs ?? 5_000;
    while (!this.#stopped && host.runningJobs() > 0) {
      await new Promise((resolve) => setTimeout(resolve, poll));
    }
  }

  #endDrain(): void {
    if (!this.#drainedForUpdate) return;
    this.#drainedForUpdate = false;
    this.#host?.endLocalDrain();
  }

  async #requestActivation(offer: UpdateOffer): Promise<void> {
    const { ops } = this.deps;
    await ops.mkdir(this.deps.data.updatesDir, 0o700);
    const request = {
      schema: 1,
      attemptId: offer.attemptId,
      version: offer.version,
      rollback: offer.rollback,
      requestedAt: this.#now().toISOString(),
    };
    await atomicWriteFile(ops, this.deps.data.requestFile, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    if (this.#host?.updateStarted() !== true) {
      this.#log.warn('state machine refused `updating` (forced update with running jobs?); continuing');
    }
    this.#log.info('activation requested from the privileged updater; the service will restart', {
      version: offer.version,
      attemptId: offer.attemptId,
    });
    const timeout = this.deps.activationTimeoutMs ?? 5 * 60_000;
    this.#activationTimer = setTimeout(() => {
      this.#activationTimer = null;
      void this.#activationTimedOut(offer);
    }, timeout);
    this.#activationTimer.unref();
  }

  async #activationTimedOut(offer: UpdateOffer): Promise<void> {
    if (this.#stopped || this.#inFlight !== offer.attemptId) return;
    this.#log.error('the privileged updater did not act on the activation request; is it installed?', {
      attemptId: offer.attemptId,
    });
    await this.deps.ops.unlink(this.deps.data.requestFile).catch(() => undefined);
    this.#inFlight = null;
    this.#endDrain();
    this.#host?.updateFailed();
    await this.#report({
      attemptId: offer.attemptId,
      version: offer.version,
      phase: 'failed',
      reason: 'updater_unavailable',
      currentVersion: this.deps.currentVersion,
    });
  }

  // ------------------------------------------------------------------ health + results

  /**
   * Windows: the SYSTEM updater polls the health file every second, and a rename over a file another process has
   * open fails with EPERM / EBUSY / EACCES — retried a few times here, then again on the next heartbeat (1.1.4 was
   * rolled back on windows-worker-1 because its single write lost this race).
   */
  async #writeHealth(sessionEstablishedAt: Date): Promise<boolean> {
    const report = {
      schema: 1,
      version: this.deps.currentVersion,
      pid: this.deps.pid ?? process.pid,
      sessionEstablishedAt: sessionEstablishedAt.toISOString(),
      heartbeatAt: this.#now().toISOString(),
    };
    const attempts = this.deps.healthWriteAttempts ?? 5;
    for (let i = 1; ; i++) {
      try {
        await atomicWriteFile(this.deps.ops, this.deps.data.healthFile, `${JSON.stringify(report)}\n`, {
          mode: 0o600,
        });
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const busy = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
        if (!busy || i >= attempts) {
          this.#log.warn('could not write the update health file', { err: error, attempt: i });
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, this.deps.healthWriteRetryMs ?? 200));
      }
    }
  }

  /** Reports the updater's last outcome once (it survives restarts in the root-owned state dir). */
  async reportResult(): Promise<void> {
    let result: UpdateResult | null;
    try {
      result = await readJsonDocument(this.deps.install.resultFile, UpdateResult);
    } catch {
      return;
    }
    if (result?.attemptId === null || result === null) return;
    const attemptId = result.attemptId;
    const reported = await this.#reported();
    if (reported.includes(attemptId)) return;
    if (this.#inFlight === attemptId) {
      // The updater answered without restarting us (refused / failed before the switch).
      if (this.#activationTimer !== null) clearTimeout(this.#activationTimer);
      this.#activationTimer = null;
      this.#inFlight = null;
      this.#endDrain();
      if (result.outcome !== 'succeeded') this.#host?.updateFailed();
    }
    const version = ReleaseVersion.safeParse(result.version);
    if (!version.success) return;
    const diagnostics =
      result.outcome === 'rolled_back' ||
      (result.outcome === 'failed' && result.reason !== null && FAILURE_WITH_EVIDENCE.has(result.reason))
        ? await this.#diagnostics(attemptId, version.data, result)
        : null;
    const sent = await this.#report({
      attemptId,
      version: version.data,
      phase: result.outcome,
      ...(result.reason === null ? {} : { reason: result.reason }),
      ...(result.detail === null ? {} : { detail: result.detail }),
      currentVersion: this.deps.currentVersion,
      ...(diagnostics === null ? {} : { diagnostics }),
    });
    if (sent) await this.#markReported([...reported, attemptId].slice(-32));
  }

  /**
   * p6-worker-boot-diagnostics: the updater's evidence for this attempt, else (an updater installed before this
   * change) what this daemon can read itself: the boot log, the service manager's capture of stdout/stderr and the
   * updater's log. Never throws; null when nothing could be collected.
   */
  async #diagnostics(
    attemptId: string,
    version: string,
    result: UpdateResult,
  ): Promise<UpdateStatusPayload['diagnostics'] | null> {
    try {
      const file = await readJsonDocument(
        this.deps.install.diagnosticsFile,
        UpdateDiagnosticsFile,
        64 * 1024,
      ).catch(() => null);
      if (file !== null && file.attemptId === attemptId) return file.diagnostics;
      const finished = Date.parse(result.finishedAt);
      // The failed version ran between its restart and the rollback: at most two health timeouts before the end.
      const since = Number.isNaN(finished)
        ? null
        : new Date(finished - (2 * this.deps.settings.healthTimeoutSec + 180) * 1000);
      return await collectUpdateDiagnostics({
        collectedBy: 'worker',
        platform: this.deps.ops.platform,
        env: this.deps.env ?? ((name) => process.env[name]),
        dataDir: this.deps.data.dataDir,
        updaterLog: this.deps.install.updaterLog,
        version,
        since,
        read: this.deps.readTail ?? ((path, max) => readTailSafe(path, max)),
        redactor: this.deps.redactor ?? DEFAULT_REDACTOR,
      });
    } catch (error) {
      this.#log.warn('could not collect update diagnostics', { err: error });
      return null;
    }
  }

  async #reported(): Promise<string[]> {
    try {
      const raw = await this.deps.ops.readFile(this.deps.data.reportedFile, 16 * 1024);
      if (raw === null) return [];
      const doc = ReportedDocument.safeParse(JSON.parse(raw.toString('utf8')));
      return doc.success ? doc.data.attemptIds : [];
    } catch {
      return [];
    }
  }

  async #markReported(attemptIds: string[]): Promise<void> {
    await this.deps.ops.mkdir(this.deps.data.updatesDir, 0o700);
    await atomicWriteFile(
      this.deps.ops,
      this.deps.data.reportedFile,
      `${JSON.stringify({ schema: 1, attemptIds })}\n`,
      { mode: 0o600 },
    );
  }

  async #report(payload: UpdateStatusPayload): Promise<boolean> {
    try {
      if (this.#host === null) return false;
      await this.#host.send(payload);
      return true;
    } catch (error) {
      this.#log.debug('UPDATE_STATUS not sent', { phase: payload.phase, err: error });
      return false;
    }
  }
}
