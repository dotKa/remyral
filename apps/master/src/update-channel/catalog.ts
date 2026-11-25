import {
  type AcceptedCatalog,
  checkVersionCatalog,
  MAX_CATALOG_BYTES,
  MAX_MASTER_CATALOG_KEYS,
  ReleaseSignature,
  runtimePinFloor,
  VERSION_CATALOG_FEATURE,
  type VersionCatalog,
  type VersionCatalogStatusPayload,
  type WorkerToMaster,
} from '@remyral/protocol';
import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import type { WorkerHub } from '../workers/hub.js';
import type { WorkerSession } from '../workers/types.js';
import { type FetchFn, fetchSigned, readSignedFile, type SignedDocument, SourceError } from './sources.js';

/**
 * p17-update-channel (ADR-0065 §5–6): the version catalog on the master. Read from the release location and the
 * host-cached copy, accepted with the same function the workers use (`checkVersionCatalog`; keys: VERSION_CATALOG_KEYS
 * ∪ the verified worker feed's `catalogKeys`; the floor: this release's runtime pins), stored as exact bytes
 * (monotonic sequence) and sent to `version-catalog-v1` workers whose CAPABILITIES report an older one. The master
 * cannot make a worker accept anything: every worker verifies again with its own catalog keys.
 */

export interface CatalogSummary {
  readonly sequence: number;
  readonly keyId: string;
  readonly generatedAt: string;
  readonly receivedAt: string;
  readonly source: 'url' | 'file';
  readonly catalog: VersionCatalog;
}

export interface WorkerCatalogRow {
  readonly workerId: string;
  readonly enabled: boolean;
  readonly keys: number;
  readonly sequence: number;
  readonly lastSequence: number | null;
  readonly lastOutcome: string | null;
  readonly lastReason: string | null;
  readonly reportedAt: string;
}

export interface CatalogServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly hub: WorkerHub;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  /** VERSION_CATALOG=on (the feature flag). Off: nothing is read or sent. */
  readonly enabled: boolean;
  /** VERSION_CATALOG_KEYS. */
  readonly keys: readonly string[];
  /** The catalog keys the verified worker feed vouches for (release key). */
  readonly feedKeys?: () => readonly string[];
  readonly url: string | null;
  readonly file: string | null;
  readonly fetch?: FetchFn;
  readonly intervalMs?: number;
  readonly fileIntervalMs?: number;
}

const SIX_HOURS = 6 * 60 * 60_000;
const FIVE_MINUTES = 5 * 60_000;

interface StoredRow {
  sequence: number;
  catalog: Buffer;
  signature: unknown;
  key_id: string;
  sha256: string;
  generated_at: Date;
  received_at: Date;
  source: 'url' | 'file';
}

export class VersionCatalogService {
  #latest: (AcceptedCatalog & { summary: CatalogSummary; bytes: Buffer; signature: unknown }) | null = null;
  #loaded = false;
  #checkedAt: Date | null = null;
  #error: string | null = null;
  #lastUrl = 0;
  #lastFile = 0;
  #running: Promise<void> | null = null;
  /**
   * p22-ops-hygiene: refusals already reported (reason · detail · document hash). The same document refused for the
   * same reason again (the host copy is re-read every 5 min) is a debug line, not another warning and audit row —
   * 622 warnings a week on the test server. Bounded; a new reason or a new document is reported again.
   */
  readonly #reported = new Set<string>();
  /** connection id → the sequence sent over it (never twice per session). */
  readonly #sent = new Map<string, number>();

  constructor(private readonly d: CatalogServiceDeps) {}

  get configured(): boolean {
    return this.d.enabled && (this.d.url !== null || this.d.file !== null);
  }

  keys(): string[] {
    const all = [...this.d.keys, ...(this.d.feedKeys?.() ?? [])];
    return [...new Set(all)].slice(0, MAX_MASTER_CATALOG_KEYS);
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    const { rows } = await this.d.pool.query<StoredRow>(
      `SELECT sequence, catalog, signature, key_id, sha256, generated_at, received_at, source
         FROM version_catalogs ORDER BY sequence DESC LIMIT 1`,
    );
    const r = rows[0];
    if (r !== undefined) {
      const catalog = JSON.parse(r.catalog.toString('utf8')) as VersionCatalog;
      this.#latest = {
        sequence: r.sequence,
        catalog,
        sha256: r.sha256,
        bytes: r.catalog,
        signature: r.signature,
        summary: {
          sequence: r.sequence,
          keyId: r.key_id,
          generatedAt: r.generated_at.toISOString(),
          receivedAt: r.received_at.toISOString(),
          source: r.source,
          catalog,
        },
      };
    }
    this.#loaded = true;
  }

  /** The newest accepted catalog (null: none yet / not loaded yet). */
  latest(): CatalogSummary | null {
    return this.#latest?.summary ?? null;
  }

  async current(): Promise<CatalogSummary | null> {
    await this.#load();
    return this.latest();
  }

  status(): {
    configured: boolean;
    enabled: boolean;
    checkedAt: string | null;
    error: string | null;
    keys: number;
  } {
    return {
      configured: this.configured,
      enabled: this.d.enabled,
      checkedAt: this.#checkedAt?.toISOString() ?? null,
      error: this.#error,
      keys: this.keys().length,
    };
  }

  tick(): Promise<void> {
    if (!this.configured) return Promise.resolve();
    const t = this.d.clock().getTime();
    const urlDue = this.d.url !== null && t - this.#lastUrl >= (this.d.intervalMs ?? SIX_HOURS);
    const fileDue = this.d.file !== null && t - this.#lastFile >= (this.d.fileIntervalMs ?? FIVE_MINUTES);
    if (!urlDue && !fileDue) return Promise.resolve();
    return this.refresh({ url: urlDue, file: fileDue });
  }

  /** Reads the due sources now; never throws (problems end up in `status().error`). */
  refresh(which: { url?: boolean; file?: boolean } = { url: true, file: true }): Promise<void> {
    if (this.#running) return this.#running;
    this.#running = this.#refresh(which).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #refresh(which: { url?: boolean; file?: boolean }): Promise<void> {
    if (!this.configured) return;
    await this.#load();
    const now = this.d.clock();
    const found: SignedDocument[] = [];
    const problems: string[] = [];
    if (which.file === true && this.d.file !== null) {
      this.#lastFile = now.getTime();
      try {
        const doc = await readSignedFile(this.d.file, 'catalog.sig.json', MAX_CATALOG_BYTES);
        if (doc !== null) found.push(doc);
      } catch (err) {
        problems.push(err instanceof SourceError ? err.code : 'unreadable');
      }
    }
    if (which.url === true && this.d.url !== null) {
      this.#lastUrl = now.getTime();
      try {
        found.push(await fetchSigned(this.d.url, 'catalog.sig.json', MAX_CATALOG_BYTES, this.d.fetch));
      } catch (err) {
        problems.push(err instanceof SourceError ? err.code : 'unreachable');
      }
    }
    for (const doc of found) {
      const r = await this.accept(doc);
      if (r !== null && r !== 'accepted' && r !== 'already_current') problems.push(r);
    }
    this.#checkedAt = now;
    this.#error = problems[0] ?? null;
  }

  /** One candidate: the workers' acceptance rules against the stored newest. Returns the outcome / refusal code. */
  async accept(doc: SignedDocument): Promise<string | null> {
    await this.#load();
    const prev = this.#latest;
    const r = checkVersionCatalog(doc.bytes, doc.signature, {
      keys: this.keys(),
      previous: prev,
      floor: runtimePinFloor(),
      now: this.d.clock(),
    });
    if (!r.ok) {
      // A file copy older than what the URL brought is normal; anything else is reported and audited once.
      if (r.reason === 'not_newer') return null;
      const key = `${r.reason}\u0000${r.detail ?? ''}\u0000${createHash('sha256').update(doc.bytes).digest('hex')}`;
      if (this.#reported.has(key)) {
        this.d.log.debug(
          { reason: r.reason, source: doc.source },
          'version catalog refused again (already reported)',
        );
        return r.reason;
      }
      if (this.#reported.size >= 100) this.#reported.clear();
      this.#reported.add(key);
      this.d.log.warn({ reason: r.reason, detail: r.detail, source: doc.source }, 'version catalog refused');
      await this.d.audit.record({
        actor: { type: 'system', id: 'update-channel' },
        action: 'update_channel.catalog.refused',
        outcome: 'failure',
        target: null,
        metadata: { reason: r.reason, source: doc.source },
      });
      return r.reason;
    }
    if (r.alreadyCurrent) return 'already_current';
    const now = this.d.clock();
    const sig = ReleaseSignature.parse(doc.signature);
    await this.d.pool.query(
      `INSERT INTO version_catalogs (sequence, catalog, signature, key_id, sha256, generated_at, received_at, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (sequence) DO NOTHING`,
      [
        r.catalog.sequence,
        doc.bytes,
        JSON.stringify(sig),
        r.keyId,
        r.sha256,
        new Date(r.catalog.generatedAt),
        now,
        doc.source,
      ],
    );
    await this.d.pool.query(
      `DELETE FROM version_catalogs WHERE sequence NOT IN
         (SELECT sequence FROM version_catalogs ORDER BY sequence DESC LIMIT 10)`,
    );
    this.#latest = {
      sequence: r.catalog.sequence,
      catalog: r.catalog,
      sha256: r.sha256,
      bytes: doc.bytes,
      signature: sig,
      summary: {
        sequence: r.catalog.sequence,
        keyId: r.keyId,
        generatedAt: r.catalog.generatedAt,
        receivedAt: now.toISOString(),
        source: doc.source,
        catalog: r.catalog,
      },
    };
    await this.d.audit.record({
      actor: { type: 'system', id: 'update-channel' },
      action: 'update_channel.catalog.accepted',
      outcome: 'success',
      target: String(r.catalog.sequence),
      metadata: { keyId: r.keyId, source: doc.source, skipped: r.skipped.length },
    });
    await this.distributeToConnected();
    return 'accepted';
  }

  // ---------------------------------------------------------------- distribution

  async #send(session: WorkerSession): Promise<void> {
    const latest = this.#latest;
    if (latest === null || !this.d.enabled) return;
    if (this.#sent.get(session.connectionId) === latest.sequence) return;
    this.#sent.set(session.connectionId, latest.sequence);
    await session.send('APPLY_VERSION_CATALOG', {
      sequence: latest.sequence,
      catalog: latest.bytes.toString('base64'),
      signature: ReleaseSignature.parse(latest.signature),
    });
    await this.d.pool.query(
      'UPDATE worker_version_catalogs SET sent_sequence = $2, sent_at = $3 WHERE worker_id = $1',
      [session.workerId, latest.sequence, this.d.clock()],
    );
  }

  /** CAPABILITIES of a worker: store its catalog report; send the newest catalog when it holds an older one. */
  async onReport(
    session: WorkerSession,
    payload: Extract<WorkerToMaster, { type: 'CAPABILITIES' }>['payload'],
  ): Promise<void> {
    const report = payload.versionCatalog;
    if (!(payload.features ?? []).includes(VERSION_CATALOG_FEATURE) || report === undefined) return;
    await this.#load();
    await this.d.pool.query(
      `INSERT INTO worker_version_catalogs (worker_id, enabled, keys, sequence, key_id, skipped, reported_at,
                                            last_sequence, last_outcome, last_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $8::int IS NULL THEN NULL ELSE 'refused' END, $9)
       ON CONFLICT (worker_id) DO UPDATE SET enabled = EXCLUDED.enabled, keys = EXCLUDED.keys,
         sequence = EXCLUDED.sequence, key_id = EXCLUDED.key_id, skipped = EXCLUDED.skipped,
         reported_at = EXCLUDED.reported_at,
         last_sequence = COALESCE(EXCLUDED.last_sequence, worker_version_catalogs.last_sequence),
         last_outcome = COALESCE(EXCLUDED.last_outcome, worker_version_catalogs.last_outcome),
         last_reason = COALESCE(EXCLUDED.last_reason, worker_version_catalogs.last_reason)`,
      [
        session.workerId,
        report.enabled,
        report.keys,
        report.sequence,
        report.keyId ?? null,
        JSON.stringify(report.skipped ?? []),
        this.d.clock(),
        report.lastRefusal?.sequence ?? null,
        report.lastRefusal?.reason ?? null,
      ],
    );
    const latest = this.#latest;
    if (latest === null || !this.d.enabled || !report.enabled || report.keys === 0) return;
    if (report.sequence >= latest.sequence) return;
    // A worker that refused exactly this catalog is not asked again in a loop (its next session retries once).
    if (report.lastRefusal?.sequence === latest.sequence) return;
    await this.#send(session);
  }

  async onStatus(session: WorkerSession, p: VersionCatalogStatusPayload): Promise<void> {
    await this.d.pool.query(
      `UPDATE worker_version_catalogs SET last_sequence = $2, last_outcome = $3, last_reason = $4, reported_at = $5,
              sequence = CASE WHEN $3 IN ('accepted', 'already_current') THEN GREATEST(sequence, $2) ELSE sequence END
        WHERE worker_id = $1`,
      [session.workerId, p.sequence, p.outcome, p.reason ?? null, this.d.clock()],
    );
    if (p.outcome === 'refused') {
      this.d.log.warn(
        { workerId: session.workerId, sequence: p.sequence, reason: p.reason },
        'worker refused the catalog',
      );
    }
  }

  onSessionEnd(session: WorkerSession): void {
    this.#sent.delete(session.connectionId);
  }

  /** After a new catalog: send it to connected capable workers that hold an older one. */
  async distributeToConnected(): Promise<void> {
    const latest = this.#latest;
    if (latest === null || !this.d.enabled) return;
    const { rows } = await this.d.pool.query<{ worker_id: string }>(
      `SELECT worker_id FROM worker_version_catalogs
        WHERE enabled AND keys > 0 AND sequence < $1 AND (last_sequence IS DISTINCT FROM $1 OR last_outcome <> 'refused')`,
      [latest.sequence],
    );
    for (const { worker_id } of rows) {
      const session = this.d.hub.get(worker_id)?.session;
      if (session === undefined || session === null) continue;
      await this.#send(session).catch((err: unknown) => {
        this.d.log.error({ err, workerId: worker_id }, 'version catalog delivery failed');
      });
    }
  }

  async workers(): Promise<WorkerCatalogRow[]> {
    const { rows } = await this.d.pool.query<{
      worker_id: string;
      enabled: boolean;
      keys: number;
      sequence: number;
      last_sequence: number | null;
      last_outcome: string | null;
      last_reason: string | null;
      reported_at: Date;
    }>(
      `SELECT c.worker_id, c.enabled, c.keys, c.sequence, c.last_sequence, c.last_outcome, c.last_reason, c.reported_at
         FROM worker_version_catalogs c JOIN workers w ON w.id = c.worker_id
        WHERE w.revoked_at IS NULL ORDER BY c.worker_id`,
    );
    return rows.map((r) => ({
      workerId: r.worker_id,
      enabled: r.enabled,
      keys: r.keys,
      sequence: r.sequence,
      lastSequence: r.last_sequence,
      lastOutcome: r.last_outcome,
      lastReason: r.last_reason,
      reportedAt: r.reported_at.toISOString(),
    }));
  }
}
