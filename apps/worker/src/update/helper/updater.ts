import { rmdir } from 'node:fs/promises';
import {
  compareReleaseVersions,
  type ManifestVerification,
  MAX_RELEASE_ARTIFACT_BYTES,
  MAX_RELEASE_MANIFEST_BYTES,
  nodeVersionAtLeast,
  type ReleaseManifest,
  ReleaseManifest as ReleaseManifestSchema,
  ReleaseVersion,
  sha256Hex,
  type UpdateDiagnostics,
  verifyReleaseArtifact,
  verifyReleaseManifest,
} from '@remyral/protocol';
import type { Logger } from '@remyral/observability';
import { pathApi } from '../../config/paths.js';
import type { UpdateSettings } from '../../config/schema.js';
import { atomicWriteFile } from '../../fs/atomic.js';
import type { FileOps } from '../../fs/ops.js';
import {
  ActivationRequest,
  ActiveVersion,
  HealthReport,
  readJsonDocument,
  readUntrustedFile,
  UnsafeFileError,
  type UpdateOutcome,
  UpdateResult,
  UpdaterState,
  type VersionRef,
} from '../files.js';
import {
  BUNDLE_NAME,
  type DataLayout,
  type InstallLayout,
  MANIFEST_NAME,
  SIGNATURE_NAME,
  versionDir,
} from '../layout.js';

/** How the updater restarts the worker service and learns which process the manager runs. */
export interface ServiceControl {
  restart(): Promise<void>;
  /** PID of the service's main process as the manager reports it; null if unknown/not comparable. */
  mainPid(): Promise<number | null>;
}

export interface UpdaterDeps {
  readonly ops: FileOps;
  readonly install: InstallLayout;
  readonly data: DataLayout;
  readonly settings: UpdateSettings;
  readonly trustedKeys: readonly string[];
  readonly service: ServiceControl;
  readonly logger: Logger;
  readonly nodeVersion?: string;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly healthPollMs?: number;
  /** Retained versions in `versions/` (active and previous are always kept). Default 3. */
  readonly keepVersions?: number;
  readonly pid?: number;
  /**
   * p6-worker-boot-diagnostics: evidence for a version that failed its health check (boot log, service output,
   * this updater's log), collected before the switch back. Absent: none is recorded.
   */
  readonly collectDiagnostics?: (input: {
    readonly version: string;
    readonly since: Date;
    readonly restartErrors: readonly string[];
  }) => Promise<UpdateDiagnostics | null>;
}

export type ApplyOutcome =
  { readonly kind: 'idle' } | { readonly kind: 'done'; readonly result: UpdateResult };

export class UpdaterError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'UpdaterError';
  }
}

const STALE_LOCK_MS = 30 * 60_000;
const IDLE_STATE: UpdaterState = {
  schema: 1,
  lastAttemptId: null,
  phase: 'idle',
  target: null,
  previous: null,
  attemptId: null,
  restartedAt: null,
};

interface Release {
  readonly manifest: ReleaseManifest;
  readonly manifestBytes: Buffer;
  readonly signature: unknown;
  readonly artifact: Buffer;
}

/**
 * The privileged half of signed updates (docs/design/p2-signed-updates.md). Runs as root/SYSTEM,
 * started by the service manager (systemd path unit, launchd WatchPaths, Windows scheduled task) —
 * never by the worker. It treats everything in the worker's data dir as hostile input:
 *
 * 1. reads the activation request and the staged files without following symlinks, as bounded
 *    regular files, and **re-verifies** the release signature against its own pinned keys, the
 *    artifact hash/size, channel, Node version, downgrade rule and owner floor;
 * 2. writes only into the root-owned install dir: a verified copy under `versions/<v>/`, then the active
 *    bundle by atomic rename (keeping the previous version's bytes for rollback);
 * 3. restarts the service and waits for the new daemon's health proof (session + heartbeat with the
 *    new version, by the manager's main PID); otherwise restores the previous bytes, restarts again
 *    and records `rolled_back`;
 * 4. records the outcome in the root-owned state dir, where the daemon reads and reports it.
 *
 * Each attempt is processed once (the attempt id is remembered); a crash during the health check is
 * resumed on the next run.
 */
export class Updater {
  readonly #p: ReturnType<typeof pathApi>;
  readonly #log: Logger;
  /** Errors of the service restarts of the current attempt (reported with the diagnostics). */
  #restartErrors: string[] = [];

  constructor(private readonly deps: UpdaterDeps) {
    this.#p = pathApi(deps.ops.platform);
    this.#log = deps.logger.child({ component: 'updater' });
  }

  #now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  #sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------- entry points

  /** Triggered run: resume a health check, or process a new activation request once. */
  async apply(): Promise<ApplyOutcome> {
    return this.#locked(async () => {
      const state = await this.#state();
      if (state.phase === 'health_check') {
        this.#log.warn('resuming an interrupted health check', { target: state.target?.version });
        return { kind: 'done', result: await this.#healthCheck(state) };
      }
      let request: ActivationRequest | null;
      try {
        request = await readJsonDocument(this.deps.data.requestFile, ActivationRequest, 4096);
      } catch (error) {
        this.#log.error('activation request is not a safe regular file; ignored', {
          err: error instanceof Error ? error.message : String(error),
        });
        return { kind: 'idle' };
      }
      if (request === null || request.attemptId === state.lastAttemptId) return { kind: 'idle' };
      this.#log.info('activation requested', { attemptId: request.attemptId, version: request.version });
      return { kind: 'done', result: await this.#activate(request, state) };
    });
  }

  /** Owner-initiated local rollback to a retained version (default: the previous one). */
  async rollback(toVersion?: string): Promise<UpdateResult> {
    return this.#locked(async () => {
      const state = await this.#state();
      const target = toVersion ?? state.previous?.version;
      if (target === undefined) throw new UpdaterError('no_previous_version', 'no retained previous version');
      const bytes = await this.#retained(target);
      if (bytes === null) throw new UpdaterError('version_not_retained', `version ${target} is not retained`);
      if (
        this.deps.settings.minVersion !== undefined &&
        ReleaseVersion.safeParse(target).success &&
        compareReleaseVersions(target, this.deps.settings.minVersion) < 0
      ) {
        throw new UpdaterError('below_minimum_version', `${target} is below the owner floor`);
      }
      const current = await this.#current();
      const ref = { version: target, sha256: sha256Hex(bytes) };
      const restartedAt = this.#now();
      await this.#switchTo(ref, bytes);
      await this.#restart();
      const healthy = await this.#waitHealthy(
        (h) => h.version === target || !ReleaseVersion.safeParse(target).success,
        restartedAt,
      );
      return this.#finish(
        { ...state, previous: current.ref },
        null,
        target,
        healthy ? 'succeeded' : 'failed',
        healthy ? 'manual_rollback' : 'health_check_failed',
        null,
        target,
      );
    });
  }

  /**
   * Installer path: verify a signed release and make it the active bundle without restarting (the
   * installer restarts the service). Refuses a downgrade unless `allowDowngrade`.
   */
  async adopt(input: {
    manifest: Buffer;
    signature: unknown;
    artifact: Buffer;
    allowDowngrade: boolean;
  }): Promise<{ version: string; changed: boolean }> {
    return this.#locked(async () => {
      const release = this.#verify(input.manifest, input.signature, input.artifact);
      const m = release.manifest;
      const current = await this.#current();
      if (current.ref?.sha256 === m.sha256) {
        await this.#storeVersion(release);
        await this.#writeActive({ version: m.version, sha256: m.sha256 });
        return { version: m.version, changed: false };
      }
      if (
        !input.allowDowngrade &&
        current.version !== null &&
        compareReleaseVersions(m.version, current.version) < 0
      ) {
        throw new UpdaterError(
          'downgrade_refused',
          `${m.version} is lower than the installed ${current.version}`,
        );
      }
      const state = await this.#state();
      const previous = current.bytes === null ? null : await this.#retain(current);
      await this.#storeVersion(release);
      await this.#switchTo({ version: m.version, sha256: m.sha256 }, release.artifact);
      await this.#writeState({ ...state, previous: previous ?? state.previous });
      await this.#prune(m.version, previous?.version ?? null);
      return { version: m.version, changed: true };
    });
  }

  async status(): Promise<{
    active: ActiveVersion | null;
    bundleSha256: string | null;
    retained: string[];
    state: UpdaterState;
    lastResult: UpdateResult | null;
  }> {
    const current = await this.#current();
    return {
      active: await readJsonDocument(this.deps.install.activeFile, ActiveVersion),
      bundleSha256: current.ref?.sha256 ?? null,
      retained: await this.#retainedVersions(),
      state: await this.#state(),
      lastResult: await readJsonDocument(this.deps.install.resultFile, UpdateResult),
    };
  }

  /** Verifies a release (installer `verify`, and every activation). Throws UpdaterError. */
  verifyRelease(manifest: Buffer, signature: unknown, artifact: Buffer): ReleaseManifest {
    return this.#verify(manifest, signature, artifact).manifest;
  }

  // ---------------------------------------------------------------- activation

  async #activate(request: ActivationRequest, prior: UpdaterState): Promise<UpdateResult> {
    this.#restartErrors = [];
    const state: UpdaterState = { ...prior, lastAttemptId: request.attemptId };
    const current = await this.#current();
    const activeName = current.version ?? current.ref?.version ?? 'unknown';
    const refuse = (reason: string, detail: string | null = null) =>
      this.#finish(state, request.attemptId, request.version, 'refused', reason, detail, activeName);

    if (!this.deps.settings.enabled) return refuse('updates_disabled');
    let release: Release;
    try {
      release = await this.#readStaged(request.version);
    } catch (error) {
      if (error instanceof UpdaterError) return refuse(error.reason, error.message);
      throw error;
    }
    const m = release.manifest;
    if (current.version !== null) {
      const cmp = compareReleaseVersions(m.version, current.version);
      if (cmp === 0) {
        return this.#finish(
          state,
          request.attemptId,
          m.version,
          'succeeded',
          'already_current',
          null,
          activeName,
        );
      }
      if (cmp < 0 && !request.rollback) {
        return refuse('downgrade_refused', `${m.version} is lower than ${current.version}`);
      }
    }
    if (
      this.deps.settings.minVersion !== undefined &&
      compareReleaseVersions(m.version, this.deps.settings.minVersion) < 0
    ) {
      return refuse('below_minimum_version', `owner floor is ${this.deps.settings.minVersion}`);
    }
    // A rollback request (written by the service account, offered by the master) may only return to the version this
    // machine ran before and still keeps under versions/ — the same bytes — never to any older signed release. The
    // owner's local `rollback [--to]` is not affected.
    if (
      current.version !== null &&
      compareReleaseVersions(m.version, current.version) < 0 &&
      !(await this.#isRetainedPrevious(prior, m.version, m.sha256))
    ) {
      return refuse(
        'rollback_not_retained',
        `${m.version} is not the retained previous version${prior.previous === null ? '' : ` (${prior.previous.version})`}`,
      );
    }

    const previous = current.bytes === null ? null : await this.#retain(current);
    if (previous === null) return refuse('no_active_bundle', 'nothing to roll back to');
    await this.#storeVersion(release);
    const target = { version: m.version, sha256: m.sha256 };
    const restartedAt = this.#now();
    const checking: UpdaterState = {
      ...state,
      phase: 'health_check',
      target,
      previous,
      attemptId: request.attemptId,
      restartedAt: restartedAt.toISOString(),
    };
    // Persist before switching: a crash from here on is resumed (health check → rollback).
    await this.#writeState(checking);
    await this.#switchTo(target, release.artifact);
    this.#log.info('activated; restarting the worker service', {
      version: m.version,
      previous: previous.version,
    });
    await this.#restart();
    return this.#healthCheck(checking);
  }

  async #healthCheck(state: UpdaterState): Promise<UpdateResult> {
    const target = state.target;
    const previous = state.previous;
    const restartedAt = new Date(state.restartedAt ?? this.#now().toISOString());
    if (target === null || previous === null) {
      await this.#writeState({ ...state, phase: 'idle' });
      throw new UpdaterError('corrupt_state', 'health check without target/previous');
    }
    const healthy = await this.#waitHealthy((h) => h.version === target.version, restartedAt);
    if (healthy) {
      this.#log.info('new version is healthy', { version: target.version });
      await this.#prune(target.version, previous.version);
      return this.#finish(state, state.attemptId, target.version, 'succeeded', null, null, target.version);
    }
    this.#log.error('new version failed its health check; rolling back', {
      version: target.version,
      previous: previous.version,
      timeoutSec: this.deps.settings.healthTimeoutSec,
    });
    // Before the switch back: the service output is still the failed version's.
    const diagnostics = await this.#collect(target.version, restartedAt);
    const bytes = await this.#retained(previous.version);
    if (bytes === null || sha256Hex(bytes) !== previous.sha256) {
      await this.#writeDiagnostics(state.attemptId, diagnostics);
      return this.#finish(
        state,
        state.attemptId,
        target.version,
        'failed',
        'rollback_unavailable',
        `previous ${previous.version} is not retained intact`,
        target.version,
      );
    }
    const rollbackAt = this.#now();
    await this.#switchTo(previous, bytes);
    await this.#restart();
    const back = await this.#waitHealthy((h) => h.version !== target.version, rollbackAt);
    await this.#writeDiagnostics(
      state.attemptId,
      diagnostics === null
        ? null
        : {
            ...diagnostics,
            ...(this.#restartErrors.length > 0 ? { restartErrors: this.#restartErrors.slice(-6) } : {}),
          },
    );
    return this.#finish(
      state,
      state.attemptId,
      target.version,
      'rolled_back',
      'health_check_failed',
      back
        ? `${target.version} did not connect and heartbeat within ${String(this.deps.settings.healthTimeoutSec)} s; ${previous.version} restored and healthy`
        : `${target.version} unhealthy; ${previous.version} restored but did not report healthy within ${String(this.deps.settings.healthTimeoutSec)} s either`,
      previous.version,
    );
  }

  async #waitHealthy(accept: (h: HealthReport) => boolean, since: Date): Promise<boolean> {
    const deadline = this.#now().getTime() + this.deps.settings.healthTimeoutSec * 1000;
    const poll = this.deps.healthPollMs ?? 1000;
    for (;;) {
      const h = await readJsonDocument(this.deps.data.healthFile, HealthReport, 4096).catch(() => null);
      if (h !== null && accept(h) && Date.parse(h.heartbeatAt) >= since.getTime()) {
        const pid = await this.deps.service.mainPid().catch(() => null);
        if (pid === null || pid === h.pid) return true;
      }
      if (this.#now().getTime() >= deadline) return false;
      await this.#sleep(poll);
    }
  }

  async #restart(): Promise<void> {
    try {
      await this.deps.service.restart();
    } catch (error) {
      // The health check decides; a failed restart simply never becomes healthy.
      const message = error instanceof Error ? error.message : String(error);
      this.#restartErrors.push(`${this.#now().toISOString()} ${message}`.slice(0, 500));
      this.#log.error('service restart failed', { err: message });
    }
  }

  async #collect(version: string, since: Date): Promise<UpdateDiagnostics | null> {
    if (this.deps.collectDiagnostics === undefined) return null;
    try {
      return await this.deps.collectDiagnostics({ version, since, restartErrors: [...this.#restartErrors] });
    } catch (error) {
      this.#log.warn('could not collect update diagnostics', {
        err: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** `state/last-diagnostics.json` (a separate file: older daemons parse last-result.json strictly). */
  async #writeDiagnostics(attemptId: string | null, diagnostics: UpdateDiagnostics | null): Promise<void> {
    if (attemptId === null || diagnostics === null) return;
    try {
      await this.#mkdirPublic(this.deps.install.stateDir);
      await this.#writePublic(
        this.deps.install.diagnosticsFile,
        `${JSON.stringify({ schema: 1, attemptId, diagnostics })}\n`,
      );
      this.#log.info('update diagnostics recorded', { attemptId, verdict: diagnostics.verdict });
    } catch (error) {
      this.#log.warn('could not write the update diagnostics', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---------------------------------------------------------------- verification

  async #readStaged(version: string): Promise<Release> {
    const dir = versionDir(this.deps.ops.platform, this.deps.data.stagedDir, version);
    const read = async (name: string, max: number) => {
      try {
        const bytes = await readUntrustedFile(this.#p.join(dir, name), max);
        if (bytes === null) throw new UpdaterError('not_staged', `${name} of ${version} is not staged`);
        return bytes;
      } catch (error) {
        if (error instanceof UnsafeFileError) throw new UpdaterError('unsafe_staged_file', error.message);
        throw error;
      }
    };
    const manifest = await read(MANIFEST_NAME, MAX_RELEASE_MANIFEST_BYTES);
    const sigRaw = await read(SIGNATURE_NAME, 4096);
    const artifact = await read(BUNDLE_NAME, MAX_RELEASE_ARTIFACT_BYTES);
    let signature: unknown;
    try {
      signature = JSON.parse(sigRaw.toString('utf8'));
    } catch {
      throw new UpdaterError('invalid_signature_document', 'signature is not JSON');
    }
    const release = this.#verify(manifest, signature, artifact);
    if (release.manifest.version !== version) {
      throw new UpdaterError(
        'manifest_mismatch',
        `staged manifest is ${release.manifest.version}, request ${version}`,
      );
    }
    return release;
  }

  #verify(manifestBytes: Buffer, signature: unknown, artifact: Buffer): Release {
    const v: ManifestVerification = verifyReleaseManifest(manifestBytes, signature, this.deps.trustedKeys);
    if (!v.ok) throw new UpdaterError(v.reason, v.detail ?? v.reason);
    const integrity = verifyReleaseArtifact(v.manifest, artifact);
    if (!integrity.ok)
      throw new UpdaterError(integrity.reason, 'artifact does not match the signed manifest');
    if (v.manifest.channel === 'canary' && this.deps.settings.channel !== 'canary') {
      throw new UpdaterError(
        'channel_not_allowed',
        'release is signed for canary; this machine accepts stable',
      );
    }
    const node = this.deps.nodeVersion ?? process.versions.node;
    if (!nodeVersionAtLeast(node, v.manifest.minNode)) {
      throw new UpdaterError('node_too_old', `release needs Node ${v.manifest.minNode}, this is ${node}`);
    }
    return { manifest: v.manifest, manifestBytes, signature, artifact };
  }

  // ---------------------------------------------------------------- install dir (root-owned)

  /** The active bundle and which version it is (by SHA-256, never by trusting a name). */
  async #current(): Promise<{ bytes: Buffer | null; version: string | null; ref: VersionRef | null }> {
    const bytes = await readUntrustedFile(this.deps.install.bundle, MAX_RELEASE_ARTIFACT_BYTES);
    if (bytes === null) return { bytes: null, version: null, ref: null };
    const sha256 = sha256Hex(bytes);
    const active = await readJsonDocument(this.deps.install.activeFile, ActiveVersion).catch(() => null);
    if (active?.sha256 === sha256 && ReleaseVersion.safeParse(active.version).success) {
      return { bytes, version: active.version, ref: { version: active.version, sha256 } };
    }
    for (const name of await this.#retainedVersions()) {
      const m = await this.#retainedManifest(name);
      if (m?.sha256 === sha256) return { bytes, version: m.version, ref: { version: m.version, sha256 } };
    }
    // An unsigned (development) install: keep it addressable for rollback by its hash.
    return { bytes, version: null, ref: { version: `unversioned-${sha256.slice(0, 12)}`, sha256 } };
  }

  async #retainedManifest(name: string): Promise<ReleaseManifest | null> {
    const raw = await readUntrustedFile(
      this.#p.join(versionDir(this.deps.ops.platform, this.deps.install.versionsDir, name), MANIFEST_NAME),
      MAX_RELEASE_MANIFEST_BYTES,
    ).catch(() => null);
    if (raw === null) return null;
    try {
      const m = ReleaseManifestSchema.safeParse(JSON.parse(raw.toString('utf8')));
      return m.success ? m.data : null;
    } catch {
      return null;
    }
  }

  /** The recorded previous version is `version` with exactly these bytes, and they are still retained intact. */
  async #isRetainedPrevious(state: UpdaterState, version: string, sha256: string): Promise<boolean> {
    const prev = state.previous;
    if (prev === null || prev.version !== version || prev.sha256 !== sha256) return false;
    const bytes = await this.#retained(prev.version).catch(() => null);
    return bytes !== null && sha256Hex(bytes) === prev.sha256;
  }

  async #retainedVersions(): Promise<string[]> {
    const names = await this.deps.ops.readdir(this.deps.install.versionsDir);
    return names.filter((n) => ReleaseVersion.safeParse(n).success || /^unversioned-[a-f0-9]{12}$/.test(n));
  }

  async #retained(name: string): Promise<Buffer | null> {
    if (!ReleaseVersion.safeParse(name).success && !/^unversioned-[a-f0-9]{12}$/.test(name)) return null;
    return readUntrustedFile(
      this.#p.join(versionDir(this.deps.ops.platform, this.deps.install.versionsDir, name), BUNDLE_NAME),
      MAX_RELEASE_ARTIFACT_BYTES,
    );
  }

  /** Make sure the currently active bytes are retained under `versions/` (rollback target). */
  async #retain(current: { bytes: Buffer | null; ref: VersionRef | null }): Promise<VersionRef | null> {
    if (current.bytes === null || current.ref === null) return null;
    const dir = versionDir(this.deps.ops.platform, this.deps.install.versionsDir, current.ref.version);
    const existing = await this.#retained(current.ref.version);
    if (existing === null || sha256Hex(existing) !== current.ref.sha256) {
      await this.#mkdirPublic(dir);
      await this.#writePublic(this.#p.join(dir, BUNDLE_NAME), current.bytes);
    }
    return current.ref;
  }

  async #storeVersion(release: Release): Promise<void> {
    const dir = versionDir(this.deps.ops.platform, this.deps.install.versionsDir, release.manifest.version);
    await this.#mkdirPublic(dir);
    // Written from the verified in-memory bytes, never copied from the staging path (no TOCTOU).
    await this.#writePublic(this.#p.join(dir, BUNDLE_NAME), release.artifact);
    await this.#writePublic(this.#p.join(dir, MANIFEST_NAME), release.manifestBytes);
    await this.#writePublic(this.#p.join(dir, SIGNATURE_NAME), `${JSON.stringify(release.signature)}\n`);
  }

  /** The atomic switch: verified bytes replace the active bundle in one rename. */
  async #switchTo(ref: VersionRef, bytes: Buffer): Promise<void> {
    await this.#writePublic(this.deps.install.bundle, bytes);
    await this.#writeActive(ref);
  }

  async #writeActive(ref: VersionRef): Promise<void> {
    const active: ActiveVersion = {
      schema: 1,
      version: ref.version,
      sha256: ref.sha256,
      activatedAt: this.#now().toISOString(),
    };
    await this.#mkdirPublic(this.deps.install.stateDir);
    await this.#writePublic(this.deps.install.activeFile, `${JSON.stringify(active)}\n`);
  }

  async #prune(active: string, previous: string | null): Promise<void> {
    const keep = Math.max(2, this.deps.keepVersions ?? 3);
    const names = (await this.#retainedVersions()).filter((n) => n !== active && n !== previous);
    const semver = names
      .filter((n) => ReleaseVersion.safeParse(n).success)
      .sort(compareReleaseVersions)
      .reverse();
    const others = names.filter((n) => !ReleaseVersion.safeParse(n).success);
    const room = Math.max(0, keep - 1 - (previous === null ? 0 : 1));
    for (const name of [...semver.slice(room), ...others]) {
      const dir = versionDir(this.deps.ops.platform, this.deps.install.versionsDir, name);
      for (const f of [BUNDLE_NAME, MANIFEST_NAME, SIGNATURE_NAME])
        await this.deps.ops.unlink(this.#p.join(dir, f));
      await rmdir(dir).catch(() => undefined);
    }
  }

  async #state(): Promise<UpdaterState> {
    return (
      (await readJsonDocument(this.deps.install.stateFile, UpdaterState).catch(() => null)) ?? IDLE_STATE
    );
  }

  async #writeState(state: UpdaterState): Promise<void> {
    await this.#mkdirPublic(this.deps.install.stateDir);
    await this.#writePublic(this.deps.install.stateFile, `${JSON.stringify(state)}\n`);
  }

  async #finish(
    state: UpdaterState,
    attemptId: string | null,
    version: string,
    outcome: UpdateOutcome,
    reason: string | null,
    detail: string | null,
    activeVersion: string,
  ): Promise<UpdateResult> {
    const result: UpdateResult = {
      schema: 1,
      attemptId,
      version,
      outcome,
      reason,
      detail: detail?.slice(0, 500) ?? null,
      activeVersion,
      finishedAt: this.#now().toISOString(),
    };
    await this.#writeState({
      ...state,
      phase: 'idle',
      target: null,
      attemptId: null,
      restartedAt: null,
      lastAttemptId: attemptId ?? state.lastAttemptId,
    });
    await this.#writePublic(this.deps.install.resultFile, `${JSON.stringify(result)}\n`);
    const level = outcome === 'succeeded' ? 'info' : 'error';
    this.#log[level]('update attempt finished', { attemptId, version, outcome, reason, activeVersion });
    return result;
  }

  /** Root-owned, world-readable (the service account runs the bundle and reads the state). */
  async #writePublic(path: string, data: string | Uint8Array): Promise<void> {
    await atomicWriteFile(this.deps.ops, path, data, { mode: 0o644 });
    if (this.deps.ops.platform !== 'win32') await this.deps.ops.chmod(path, 0o644);
  }

  async #mkdirPublic(dir: string): Promise<void> {
    await this.deps.ops.mkdir(dir, 0o755);
    if (this.deps.ops.platform !== 'win32') await this.deps.ops.chmod(dir, 0o755);
  }

  async #locked<T>(body: () => Promise<T>): Promise<T> {
    await this.#mkdirPublic(this.deps.install.stateDir);
    const lock = this.deps.install.lockFile;
    const take = () =>
      this.deps.ops.writeNew(
        lock,
        `${String(this.deps.pid ?? process.pid)} ${this.#now().toISOString()}\n`,
        0o600,
      );
    try {
      await take();
    } catch {
      const raw = (await this.deps.ops.readFile(lock, 256).catch(() => null))?.toString('utf8') ?? '';
      const [pidText, at] = raw.trim().split(' ');
      const pid = Number(pidText);
      const age = this.#now().getTime() - Date.parse(at ?? '');
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      if (alive && !(age > STALE_LOCK_MS))
        throw new UpdaterError('locked', 'another updater run is in progress');
      await this.deps.ops.unlink(lock);
      await take();
    }
    try {
      return await body();
    } finally {
      await this.deps.ops.unlink(lock);
    }
  }
}
