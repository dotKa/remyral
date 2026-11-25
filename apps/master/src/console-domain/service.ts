import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuditRecorder } from '../audit/audit.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { checkDns, type DnsCheckResult, type Resolver, systemResolver } from './dns.js';
import { ConsoleDomainError, normaliseDomain, normaliseEmail, originFor, type TlsMode } from './domain.js';
import {
  type ApplierHeartbeat,
  DOMAIN_CHANGE_KIND,
  type HostSigner,
  isoSeconds,
  newNonce,
  pendingRequestId,
  readHeartbeat,
  readResult,
  removeRequest,
  writeRequest,
} from './host-files.js';
import { hostOfOrigin, type OriginSource } from './origin.js';

/**
 * p17-domain-wizard (docs/design/p17-domain-wizard.md, ADR-0063 amendment 2026-10-24): the console's public address.
 *
 * - **Precedence:** the stored setting (`console_domain_setting`, owner-editable) wins; else the environment
 *   (PUBLIC_ORIGIN, else the origin of NOTIFY_PUBLIC_URL). Every link builder reads {@link current} at the moment it
 *   builds a link, so a saved address is used at once. The setting is re-read every tick (another master instance).
 * - **Saving on an install without a host applier** (Coolify / EC2, routing elsewhere): only the setting changes; the
 *   operator of that platform routes the name.
 * - **Saving on a remyral-ctl install** (a fresh applier heartbeat): a signed domain change request is written for the
 *   host (`remyral-ctl apply-pending`); the setting follows when the host reports the new name healthy (`applied`).
 *   A failed change rolls back on the host; the setting stays.
 *
 * Owners only (`console.domain.write`), security policy event `console.domain`; every change audited.
 */

export interface ConsoleDomainActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export type RequestState =
  'pending' | 'applying' | 'applied' | 'rolled_back' | 'failed' | 'refused' | 'expired' | 'cancelled';

export interface DomainRequestView {
  readonly id: string;
  readonly domain: string;
  readonly tls: TlsMode;
  readonly previousDomain: string;
  readonly state: RequestState;
  readonly detail: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
}

export interface ConsoleDomainStatus {
  /** The effective public origin (what links use now). */
  readonly origin: string | null;
  readonly source: 'setting' | 'environment' | 'none';
  readonly setting: {
    readonly origin: string;
    readonly source: 'owner' | 'host-applier';
    readonly updatedAt: string;
  } | null;
  /** PUBLIC_ORIGIN / the origin of NOTIFY_PUBLIC_URL (the fallback). */
  readonly environment: string | null;
  /** The remyral-ctl host applier: `managed` when its heartbeat is fresh. */
  readonly host: {
    readonly managed: boolean;
    readonly lastSeen: string | null;
    readonly version: string | null;
    readonly domain: string | null;
    readonly tls: TlsMode | null;
    readonly acmeEmail: string | null;
    readonly httpsPort: number | null;
  };
  /** The open request, else the latest one of the last 24 hours. */
  readonly request: DomainRequestView | null;
}

export type SaveOutcome =
  | { readonly mode: 'setting'; readonly origin: string }
  | { readonly mode: 'host'; readonly request: DomainRequestView };

export interface ConsoleDomainDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** PUBLIC_ORIGIN, else the origin of NOTIFY_PUBLIC_URL. */
  readonly envOrigin: string | null;
  /** NOTIFY_PUBLIC_URL as configured (notification links; may carry a path). */
  readonly envNotifyUrl: string | null;
  /** HOST_APPLIER_DIR (`requests/` writable, `status/` read-only); null: not a remyral-ctl layout. */
  readonly hostDir: string | null;
  readonly signer: HostSigner | null;
  readonly resolver?: Resolver;
  /** A heartbeat older than this means no applier (default 5 min; the host writes one every minute). */
  readonly heartbeatMaxAgeMs?: number;
  /** A request nobody picked up is withdrawn after this (default 15 min; the host refuses it too). */
  readonly requestTtlMs?: number;
  /** An `applying` request without a final result is failed after this (default 30 min). */
  readonly applyingTimeoutMs?: number;
  readonly dnsTimeoutMs?: number;
  readonly log?: { warn(obj: unknown, msg: string): void };
}

interface SettingRow {
  public_origin: string;
  source: 'owner' | 'host-applier';
  updated_at: Date;
}

interface RequestRow {
  id: string;
  domain: string;
  tls_mode: TlsMode;
  previous_domain: string;
  state: RequestState;
  detail: string | null;
  requested_at: Date;
  expires_at: Date;
  updated_at: Date;
}

const OPEN: readonly RequestState[] = ['pending', 'applying'];
const REQUEST_COLUMNS =
  'id, domain, tls_mode, previous_domain, state, detail, requested_at, expires_at, updated_at';

function view(r: RequestRow): DomainRequestView {
  return {
    id: r.id,
    domain: r.domain,
    tls: r.tls_mode,
    previousDomain: r.previous_domain,
    state: r.state,
    detail: r.detail,
    requestedAt: r.requested_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class ConsoleDomainService implements OriginSource {
  #setting: SettingRow | null = null;
  #reconciling: Promise<void> | null = null;

  constructor(private readonly deps: ConsoleDomainDeps) {}

  private now(): Date {
    return this.deps.clock();
  }

  private get requestsDir(): string | null {
    return this.deps.hostDir === null ? null : join(this.deps.hostDir, 'requests');
  }

  private get statusDir(): string | null {
    return this.deps.hostDir === null ? null : join(this.deps.hostDir, 'status');
  }

  /** The effective origin (setting, else environment). Synchronous: link builders call it per link. */
  current(): string | null {
    return this.#setting?.public_origin ?? this.deps.envOrigin;
  }

  /** The saved address (null: none saved — the environment applies). */
  saved(): string | null {
    return this.#setting?.public_origin ?? null;
  }

  /** A live origin: the saved address, else `fallback` (a consumer's own configured value). */
  overlay(fallback: string | null | undefined): OriginSource {
    return { current: () => this.saved() ?? fallback ?? null };
  }

  /** The base of notification links: the setting, else NOTIFY_PUBLIC_URL (without a trailing slash). */
  notifyBase(): string | null {
    if (this.#setting !== null) return this.#setting.public_origin;
    return this.deps.envNotifyUrl?.replace(/\/+$/, '') ?? null;
  }

  /** Every host name the console answers to as far as the master knows (protected from ops changes). */
  consoleHosts(): string[] {
    const hosts = [hostOfOrigin(this.deps.envOrigin), hostOfOrigin(this.#setting?.public_origin ?? null)];
    return [...new Set(hosts.filter((h): h is string => h !== null))];
  }

  /** Re-reads the stored setting. */
  async load(db: Queryable = this.deps.pool): Promise<void> {
    const { rows } = await db.query<SettingRow>(
      'SELECT public_origin, source, updated_at FROM console_domain_setting WHERE id = 1',
    );
    this.#setting = rows[0] ?? null;
  }

  /** Orchestrator tick: the setting (another instance may have saved it) and the host's result. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.load();
      await this.reconcile();
    } catch (err) {
      this.deps.log?.warn({ err }, 'console domain tick failed');
    }
  }

  async heartbeat(): Promise<{ beat: ApplierHeartbeat | null; fresh: boolean }> {
    const dir = this.statusDir;
    if (dir === null) return { beat: null, fresh: false };
    const beat = await readHeartbeat(dir);
    if (beat === null) return { beat: null, fresh: false };
    const age = this.now().getTime() - beat.at.getTime();
    return { beat, fresh: age <= (this.deps.heartbeatMaxAgeMs ?? 5 * 60_000) && age > -5 * 60_000 };
  }

  private async openRequest(db: Queryable = this.deps.pool): Promise<RequestRow | null> {
    const { rows } = await db.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM console_domain_requests WHERE state = ANY($1::text[])`,
      [OPEN],
    );
    return rows[0] ?? null;
  }

  private async latestRequest(): Promise<RequestRow | null> {
    const open = await this.openRequest();
    if (open !== null) return open;
    const { rows } = await this.deps.pool.query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM console_domain_requests
        WHERE requested_at > $1 ORDER BY requested_at DESC, updated_at DESC LIMIT 1`,
      [new Date(this.now().getTime() - 24 * 60 * 60_000)],
    );
    return rows[0] ?? null;
  }

  async status(): Promise<ConsoleDomainStatus> {
    await this.load();
    await this.reconcile();
    const { beat, fresh } = await this.heartbeat();
    const req = await this.latestRequest();
    const s = this.#setting;
    const origin = this.current();
    return {
      origin,
      source: s !== null ? 'setting' : origin !== null ? 'environment' : 'none',
      setting:
        s === null
          ? null
          : { origin: s.public_origin, source: s.source, updatedAt: s.updated_at.toISOString() },
      environment: this.deps.envOrigin,
      host: {
        managed: fresh && this.deps.signer !== null,
        lastSeen: beat?.at.toISOString() ?? null,
        version: beat?.version ?? null,
        domain: beat?.domain ?? null,
        tls: beat?.tls ?? null,
        acmeEmail: beat?.acmeEmail ?? null,
        httpsPort: beat?.httpsPort ?? null,
      },
      request: req === null ? null : view(req),
    };
  }

  /** "DNS bu sunucuyu gösteriyor mu?" for a name the owner typed. */
  async checkDns(input: string): Promise<DnsCheckResult> {
    const domain = normaliseDomain(input);
    const { beat } = await this.heartbeat();
    const known = [hostOfOrigin(this.current()), beat?.domain ?? null].filter((h): h is string => h !== null);
    return checkDns({
      domain,
      resolver: this.deps.resolver ?? systemResolver,
      knownHosts: [...new Set(known)],
      knownAddresses: beat?.addresses ?? [],
      now: this.now(),
      ...(this.deps.dnsTimeoutMs === undefined ? {} : { timeoutMs: this.deps.dnsTimeoutMs }),
    });
  }

  private async putSetting(
    db: Queryable,
    origin: string,
    source: 'owner' | 'host-applier',
    userId: string | null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO console_domain_setting (id, public_origin, source, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET public_origin = EXCLUDED.public_origin, source = EXCLUDED.source,
              updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [origin, source, this.now(), userId],
    );
  }

  private auditActor(actor: ConsoleDomainActor) {
    return {
      actor: { type: 'user' as const, id: actor.userId },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
    };
  }

  /**
   * Saves the console's domain. Without a host applier: the setting changes now. With one: a signed request goes to
   * the host (unless only the setting differs from what the host serves).
   */
  async save(
    actor: ConsoleDomainActor,
    input: { readonly domain: string; readonly tls?: TlsMode; readonly email?: string },
  ): Promise<SaveOutcome> {
    const domain = normaliseDomain(input.domain);
    const { beat, fresh } = await this.heartbeat();
    const managed = fresh && beat !== null && this.deps.signer !== null && this.requestsDir !== null;
    const previous = this.current();
    if (!managed) {
      const origin = originFor(domain, null);
      await withTransaction(this.deps.pool, async (tx) => {
        await this.putSetting(tx, origin, 'owner', actor.userId);
        await this.deps.audit.record(
          {
            ...this.auditActor(actor),
            action: 'console.domain.set',
            target: 'console-domain',
            outcome: 'success',
            metadata: { origin, previous, applied: 'setting-only' },
          },
          tx,
        );
      });
      await this.load();
      return { mode: 'setting', origin };
    }
    const tls = input.tls ?? beat.tls;
    const email = input.email === undefined || input.email.trim() === '' ? '' : normaliseEmail(input.email);
    if (domain === beat.domain && tls === beat.tls && (email === '' || email === beat.acmeEmail)) {
      // The host already serves this name: only the links follow (e.g. the setting was unset).
      const origin = originFor(domain, beat.httpsPort);
      if (this.#setting?.public_origin === origin) {
        throw new ConsoleDomainError('domain_unchanged', 'The console already uses this domain.');
      }
      await withTransaction(this.deps.pool, async (tx) => {
        await this.putSetting(tx, origin, 'owner', actor.userId);
        await this.deps.audit.record(
          {
            ...this.auditActor(actor),
            action: 'console.domain.set',
            target: 'console-domain',
            outcome: 'success',
            metadata: { origin, previous, applied: 'host-already-serves' },
          },
          tx,
        );
      });
      await this.load();
      return { mode: 'setting', origin };
    }
    if (tls === 'letsencrypt' && beat.httpsPort !== 443) {
      throw new ConsoleDomainError(
        'letsencrypt_needs_standard_ports',
        'Let’s Encrypt needs the standard ports 80 and 443 on this host.',
      );
    }
    if (tls === 'letsencrypt' && email === '' && beat.acmeEmail === null) {
      throw new ConsoleDomainError(
        'email_required',
        'Let’s Encrypt needs an e-mail address for expiry notices.',
      );
    }
    const now = this.now();
    const id = randomUUID();
    const nonce = newNonce();
    const expiresAt = new Date(now.getTime() + (this.deps.requestTtlMs ?? 15 * 60_000));
    const signer = this.deps.signer;
    const requestsDir = this.requestsDir;
    const row = await withTransaction(this.deps.pool, async (tx) => {
      if ((await this.openRequest(tx)) !== null) {
        throw new ConsoleDomainError(
          'domain_change_in_progress',
          'A domain change is already waiting for the host or being applied.',
        );
      }
      const { rows } = await tx.query<RequestRow>(
        `INSERT INTO console_domain_requests
           (id, domain, tls_mode, acme_email, previous_domain, nonce, state, requested_by, requested_at, expires_at,
            updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $8)
         RETURNING ${REQUEST_COLUMNS}`,
        [id, domain, tls, email === '' ? null : email, beat.domain, nonce, actor.userId, now, expiresAt],
      );
      const r = rows[0];
      if (r === undefined) throw new Error('domain change request was not stored');
      await this.deps.audit.record(
        {
          ...this.auditActor(actor),
          action: 'console.domain.request',
          target: id,
          outcome: 'success',
          metadata: { domain, tls, previousDomain: beat.domain, emailGiven: email !== '' },
        },
        tx,
      );
      // Written inside the transaction: a failed write leaves no request row behind.
      try {
        await writeRequest(
          requestsDir,
          {
            kind: DOMAIN_CHANGE_KIND,
            id,
            nonce,
            domain,
            tls,
            email,
            previousDomain: beat.domain,
            createdAt: isoSeconds(now),
            expiresAt: isoSeconds(expiresAt),
          },
          signer,
        );
      } catch (err) {
        this.deps.log?.warn({ err }, 'writing the domain change request failed');
        throw new ConsoleDomainError(
          'host_applier_unavailable',
          'The request could not be written for the host (is the host directory mounted writable?).',
        );
      }
      return r;
    }).catch((err: unknown) => {
      // The one-open-request index catches a concurrent save.
      if ((err as { code?: string }).code === '23505') {
        throw new ConsoleDomainError(
          'domain_change_in_progress',
          'A domain change is already waiting for the host or being applied.',
        );
      }
      throw err;
    });
    return { mode: 'host', request: view(row) };
  }

  /** Back to the environment's address (PUBLIC_ORIGIN / NOTIFY_PUBLIC_URL). */
  async clear(actor: ConsoleDomainActor): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ public_origin: string }>(
        'DELETE FROM console_domain_setting WHERE id = 1 RETURNING public_origin',
      );
      await this.deps.audit.record(
        {
          ...this.auditActor(actor),
          action: 'console.domain.clear',
          target: 'console-domain',
          outcome: 'success',
          metadata: { previous: rows[0]?.public_origin ?? null, environment: this.deps.envOrigin },
        },
        tx,
      );
    });
    await this.load();
  }

  /** Withdraws a request the host has not picked up yet. */
  async cancel(actor: ConsoleDomainActor): Promise<void> {
    const requestsDir = this.requestsDir;
    await withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE console_domain_requests SET state = 'cancelled', updated_at = $1
          WHERE state = 'pending' RETURNING id`,
        [this.now()],
      );
      const id = rows[0]?.id;
      if (id === undefined) {
        throw new ConsoleDomainError('no_pending_request', 'No domain change is waiting for the host.');
      }
      if (requestsDir !== null) await removeRequest(requestsDir);
      await this.deps.audit.record(
        { ...this.auditActor(actor), action: 'console.domain.cancel', target: id, outcome: 'success' },
        tx,
      );
    });
  }

  /** Moves the open request by the host's result file and the clock. Single-flight. */
  reconcile(): Promise<void> {
    if (this.#reconciling) return this.#reconciling;
    this.#reconciling = this.doReconcile().finally(() => {
      this.#reconciling = null;
    });
    return this.#reconciling;
  }

  private async finish(
    open: RequestRow,
    state: Exclude<RequestState, 'pending' | 'applying'>,
    detail: string | null,
    settingOrigin: string | null,
  ): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE console_domain_requests SET state = $2, detail = $3, updated_at = $4
          WHERE id = $1 AND state = ANY($5::text[])`,
        [open.id, state, detail?.slice(0, 500) ?? null, this.now(), OPEN],
      );
      if (rowCount === 0) return; // another instance got there first
      if (settingOrigin !== null) await this.putSetting(tx, settingOrigin, 'host-applier', null);
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'host-applier' },
          action: state === 'applied' ? 'console.domain.applied' : `console.domain.${state}`,
          target: open.id,
          outcome: state === 'applied' ? 'success' : 'failure',
          metadata: {
            domain: open.domain,
            previousDomain: open.previous_domain,
            ...(detail === null ? {} : { detail: detail.slice(0, 300) }),
            ...(settingOrigin === null ? {} : { origin: settingOrigin }),
          },
        },
        tx,
      );
    });
    if (settingOrigin !== null) await this.load();
  }

  private async doReconcile(): Promise<void> {
    const open = await this.openRequest();
    if (open === null) return;
    const statusDir = this.statusDir;
    const requestsDir = this.requestsDir;
    const result = statusDir === null ? null : await readResult(statusDir);
    const now = this.now();
    if (result !== null && result.at.getTime() >= open.requested_at.getTime() - 1_000) {
      const mine = result.id === open.id;
      // A refusal the host could not attribute (the signature did not verify) concerns the waiting request.
      const unattributed = result.id === '' && result.state === 'refused' && open.state === 'pending';
      if (mine || unattributed) {
        if (result.state === 'applying') {
          if (open.state === 'pending') {
            await this.deps.pool.query(
              `UPDATE console_domain_requests SET state = 'applying', updated_at = $2 WHERE id = $1 AND state = 'pending'`,
              [open.id, now],
            );
          }
          return;
        }
        if (requestsDir !== null) {
          // The host consumes the file; remove a leftover only if it is this request's.
          if ((await pendingRequestId(requestsDir)) === open.id) await removeRequest(requestsDir);
        }
        if (result.state === 'applied') {
          const { beat } = await this.heartbeat();
          const port = beat !== null && beat.domain === open.domain ? beat.httpsPort : null;
          await this.finish(open, 'applied', result.detail || null, originFor(open.domain, port));
          return;
        }
        await this.finish(open, result.state, result.detail || null, null);
        return;
      }
    }
    if (open.state === 'pending' && now.getTime() > open.expires_at.getTime()) {
      if (requestsDir !== null && (await pendingRequestId(requestsDir)) === open.id) {
        await removeRequest(requestsDir);
      }
      await this.finish(open, 'expired', 'the host applier did not pick the request up in time', null);
      return;
    }
    if (
      open.state === 'applying' &&
      now.getTime() - open.updated_at.getTime() > (this.deps.applyingTimeoutMs ?? 30 * 60_000)
    ) {
      await this.finish(open, 'failed', 'the host applier did not report a result', null);
    }
  }
}
