import { type OriginInput, originOf } from '../console-domain/origin.js';
import { randomUUID } from 'node:crypto';
import {
  isSubscribableEventType,
  type SubscribableEventType,
  WEBHOOK_CATALOG_VERSION,
  WEBHOOK_HEADERS,
  type WebhookEnvelope,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { type Pool, type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import { cleanText } from '../notifications/model.js';
import { globalRecipients } from '../notifications/recipients.js';
import type { NotificationService } from '../notifications/service.js';
import { type AuditRow, eventsFromAudit, type ProducedEvent, SOURCE_ACTIONS } from './catalog.js';
import type { WebhookSender } from './sender.js';
import { newWebhookSecret, secretHint, signatureHeader } from './signing.js';
import {
  type HeaderInput,
  headerNameProblem,
  headerValueProblem,
  internalOriginProblem,
  MAX_HEADERS,
  mustBeSecret,
  targetProblem,
} from './targets.js';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md, ADR-0059): subscriptions, the producer (audit cursor → durable
 * delivery rows, in one transaction) and the deliverer (fenced claims, retries with backoff and jitter, auto-disable).
 *
 * Delivery guarantees: at least once per (subscription, event) — the delivery row is written in the transaction that
 * moves the cursor; a claim is a lease (`claim_token`, `claimed_until`) taken with `FOR UPDATE SKIP LOCKED`, so with
 * several masters exactly one sends a given delivery at a time, and a sender that dies mid-request leaves it due
 * again after the lease (the receiver deduplicates on `X-Remyral-Delivery`). Results are written only under the
 * claim's token (a stale sender cannot overwrite a newer attempt). Ordering per subscription is best effort: due
 * deliveries go out in event order, one at a time per subscription and pass, but a retry waits while newer events
 * are sent (no head-of-line blocking); receivers order by `occurredAt` / the event they reference.
 */
export interface WebhookOptions {
  /** Audit rows read per producer pass. */
  readonly batchSize: number;
  /** Deliveries claimed per deliverer pass. */
  readonly deliverBatch: number;
  /** A claim is a lease of this length (longer than the request timeout). */
  readonly claimMs: number;
  /** Delay before attempt 2, 3, …; after the last delay's attempt fails the delivery is failed. */
  readonly backoffMs: readonly number[];
  /** ± this fraction of random jitter on every delay (0 = none; tests). */
  readonly jitter: number;
  /** Consecutive failed attempts (across deliveries) after which a subscription is disabled. */
  readonly autoDisableAfter: number;
  /** Finished deliveries (and pending ones older than this) are removed / expired. */
  readonly retentionMs: number;
  readonly maxSubscriptions: number;
  /** Subscriptions served in parallel per pass. */
  readonly concurrency: number;
  readonly defaultOverlapHours: number;
  readonly maxOverlapHours: number;
}

export const DEFAULT_WEBHOOK_OPTIONS: WebhookOptions = {
  batchSize: 500,
  deliverBatch: 100,
  claimMs: 60_000,
  backoffMs: [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000],
  jitter: 0.1,
  autoDisableAfter: 15,
  retentionMs: 30 * 24 * 3_600_000,
  maxSubscriptions: 50,
  concurrency: 4,
  defaultOverlapHours: 24,
  maxOverlapHours: 168,
};

export interface WebhookServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** 32-byte sub-key (`box.deriveKey('webhooks-out')`) sealing secrets and secret header values at rest. */
  readonly sealKey: Buffer;
  readonly sender: WebhookSender;
  /** Public console URL for absolute links in payloads (null: console-relative paths; p17-domain-wizard: live). */
  readonly publicUrl: OriginInput;
  readonly notifications: () => NotificationService | null;
  readonly log?: FastifyBaseLogger;
  readonly options?: Partial<WebhookOptions>;
  /** Jitter source (tests: fixed). */
  readonly random?: () => number;
}

export interface WebhookActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export const SUBSCRIPTION_STATES = ['active', 'paused', 'disabled'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export const DELIVERY_STATUSES = ['pending', 'succeeded', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface HeaderView {
  readonly name: string;
  /** Plain values only; a secret header's value is never shown. */
  readonly value: string | null;
  readonly secret: boolean;
  readonly hint: string | null;
}

export interface SubscriptionView {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly project: string | null;
  readonly eventTypes: SubscribableEventType[];
  readonly includeDetails: boolean;
  readonly headers: HeaderView[];
  readonly secretHint: string;
  readonly secretCreatedAt: Date;
  /** The secret was shown (at creation, or once on request). */
  readonly secretRevealed: boolean;
  /** The previous secret is still signed with until then (rotation overlap). */
  readonly previousValidUntil: Date | null;
  readonly state: SubscriptionState;
  readonly disabledReason: string | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: Date | null;
  readonly lastFailureAt: Date | null;
  readonly createdAt: Date;
  readonly createdBy: { id: string; username: string } | null;
  readonly updatedAt: Date;
  readonly stats: { readonly pending: number; readonly succeeded24h: number; readonly failed24h: number };
}

export interface DeliveryView {
  readonly id: string;
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly project: string | null;
  readonly status: DeliveryStatus;
  readonly test: boolean;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly lastLatencyMs: number | null;
  readonly lastAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export interface AttemptView {
  readonly attempt: number;
  readonly startedAt: Date;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly responseExcerpt: string | null;
}

export interface SubscriptionInput {
  readonly name: string;
  readonly url: string;
  readonly project?: string | null | undefined;
  readonly eventTypes: readonly string[];
  readonly includeDetails?: boolean | undefined;
  readonly headers?: readonly HeaderInput[] | undefined;
}

export interface SettingsView {
  readonly internalOrigins: string[];
  readonly updatedAt: Date | null;
  readonly updatedBy: { id: string; username: string } | null;
}

interface StoredHeader {
  readonly name: string;
  readonly value?: string;
  readonly sealed?: string;
  readonly hint?: string;
}

interface SubRow {
  id: string;
  name: string;
  url: string;
  project: string | null;
  event_types: string[];
  include_details: boolean;
  headers: StoredHeader[];
  secret_sealed: Buffer;
  secret_hint: string;
  secret_created_at: Date;
  secret_revealed_at: Date | null;
  previous_secret_sealed: Buffer | null;
  previous_valid_until: Date | null;
  state: SubscriptionState;
  disabled_reason: string | null;
  consecutive_failures: number;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  created_at: Date;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: Date;
}

const SUB_COLS = `s.id::text AS id, s.name, s.url, s.project, s.event_types, s.include_details, s.headers,
  s.secret_sealed, s.secret_hint, s.secret_created_at, s.secret_revealed_at, s.previous_secret_sealed,
  s.previous_valid_until, s.state, s.disabled_reason, s.consecutive_failures, s.last_success_at, s.last_failure_at,
  s.created_at, s.created_by::text AS created_by, u.username AS created_by_name, s.updated_at`;
const SUB_FROM = 'webhook_subscriptions s LEFT JOIN users u ON u.id = s.created_by';

interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_id: string;
  event_type: string;
  project: string | null;
  body: string;
  status: DeliveryStatus;
  is_test: boolean;
  attempts: number;
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
  last_latency_ms: number | null;
  last_attempt_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
  seq: string;
}

const DELIVERY_COLS = `d.id::text AS id, d.subscription_id::text AS subscription_id, d.event_id::text AS event_id,
  d.event_type, d.project, d.body, d.status, d.is_test, d.attempts, d.next_attempt_at, d.last_status_code,
  d.last_error, d.last_latency_ms, d.last_attempt_at, d.created_at, d.finished_at, d.seq::text AS seq`;

/** Advisory-lock key of the producer (`webhook` in ASCII): one producer pass at a time across masters. */
const PRODUCER_LOCK = 0x776562686f6f6bn;
const USER_AGENT = `Remyral-Webhooks/1 (catalog v${String(WEBHOOK_CATALOG_VERSION)})`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(
  field: string,
  problem: string,
  message: string,
  extra: Record<string, unknown> = {},
): HttpError {
  return new HttpError(422, 'invalid_webhook', message, {}, {}, { reason: field, problem, ...extra });
}

function notFound(): HttpError {
  return new HttpError(404, 'webhook_not_found', 'Webhook not found.');
}

export class WebhookService {
  readonly #box: SecretBox;
  readonly #options: WebhookOptions;
  readonly #random: () => number;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #again = false;

  constructor(private readonly deps: WebhookServiceDeps) {
    this.#box = new SecretBox(deps.sealKey);
    this.#options = { ...DEFAULT_WEBHOOK_OPTIONS, ...deps.options };
    this.#random = deps.random ?? Math.random;
  }

  get options(): WebhookOptions {
    return this.#options;
  }

  #now(): Date {
    return this.deps.clock();
  }

  #link(path: string): string {
    const base = originOf(this.deps.publicUrl);
    return base === null ? path : `${base}${path}`;
  }

  // ------------------------------------------------------------------------------------------------ settings

  async settings(db: Queryable = this.deps.pool): Promise<SettingsView> {
    const { rows } = await db.query<{
      internal_origins: string[];
      updated_at: Date | null;
      updated_by: string | null;
      username: string | null;
    }>(
      `SELECT w.internal_origins, w.updated_at, w.updated_by::text AS updated_by, u.username
         FROM webhook_settings w LEFT JOIN users u ON u.id = w.updated_by WHERE w.id = 1`,
    );
    const r = rows[0];
    return {
      internalOrigins: [...(r?.internal_origins ?? [])],
      updatedAt: r?.updated_at ?? null,
      updatedBy:
        r?.updated_by === null || r?.updated_by === undefined
          ? null
          : { id: r.updated_by, username: r.username ?? '' },
    };
  }

  async #internal(db: Queryable = this.deps.pool): Promise<Set<string>> {
    return new Set((await this.settings(db)).internalOrigins);
  }

  /** The owner's exact internal origins (a trust-model change: owner + code, audited with before / after). */
  async setInternalOrigins(actor: WebhookActor, origins: readonly string[]): Promise<SettingsView> {
    const list = [...new Set(origins.map((o) => o.trim()))].sort();
    if (list.length > 32)
      throw invalid('internalOrigins', 'too_many', 'At most 32 internal origins.', { max: 32 });
    for (const o of list) {
      const p = internalOriginProblem(o);
      if (p !== null)
        throw invalid(
          'internalOrigins',
          p,
          `${o}: an internal target must be an exact https:// origin (scheme, host and port only).`,
          { detail: o },
        );
    }
    return withTransaction(this.deps.pool, async (tx) => {
      const before = await this.settings(tx);
      await tx.query(
        'UPDATE webhook_settings SET internal_origins = $1, updated_at = $2, updated_by = $3 WHERE id = 1',
        [list, this.#now(), actor.userId],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.settings.update',
          target: 'webhook-settings',
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { before: before.internalOrigins, after: list },
        },
        tx,
      );
      return this.settings(tx);
    });
  }

  // ------------------------------------------------------------------------------------------------ subscriptions

  #view(r: SubRow, stats?: SubscriptionView['stats']): SubscriptionView {
    return {
      id: r.id,
      name: r.name,
      url: r.url,
      project: r.project,
      eventTypes: r.event_types.filter(isSubscribableEventType),
      includeDetails: r.include_details,
      headers: r.headers.map((h) => ({
        name: h.name,
        value: h.sealed === undefined ? (h.value ?? null) : null,
        secret: h.sealed !== undefined,
        hint: h.sealed === undefined ? null : (h.hint ?? null),
      })),
      secretHint: r.secret_hint,
      secretCreatedAt: r.secret_created_at,
      secretRevealed: r.secret_revealed_at !== null,
      previousValidUntil:
        r.previous_valid_until !== null && r.previous_valid_until > this.#now()
          ? r.previous_valid_until
          : null,
      state: r.state,
      disabledReason: r.disabled_reason,
      consecutiveFailures: r.consecutive_failures,
      lastSuccessAt: r.last_success_at,
      lastFailureAt: r.last_failure_at,
      createdAt: r.created_at,
      createdBy: r.created_by === null ? null : { id: r.created_by, username: r.created_by_name ?? '' },
      updatedAt: r.updated_at,
      stats: stats ?? { pending: 0, succeeded24h: 0, failed24h: 0 },
    };
  }

  async #stats(db: Queryable, ids: readonly string[]): Promise<Map<string, SubscriptionView['stats']>> {
    const out = new Map<string, SubscriptionView['stats']>();
    if (ids.length === 0) return out;
    const since = new Date(this.#now().getTime() - 24 * 3_600_000);
    const { rows } = await db.query<{ id: string; pending: string; ok: string; failed: string }>(
      `SELECT subscription_id::text AS id,
              count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE status = 'succeeded' AND finished_at >= $2) AS ok,
              count(*) FILTER (WHERE status = 'failed' AND finished_at >= $2) AS failed
         FROM webhook_deliveries WHERE subscription_id = ANY($1::uuid[]) AND NOT is_test
        GROUP BY subscription_id`,
      [[...ids], since],
    );
    for (const r of rows)
      out.set(r.id, { pending: Number(r.pending), succeeded24h: Number(r.ok), failed24h: Number(r.failed) });
    return out;
  }

  async list(): Promise<SubscriptionView[]> {
    const { rows } = await this.deps.pool.query<SubRow>(
      `SELECT ${SUB_COLS} FROM ${SUB_FROM} ORDER BY s.created_at, s.id`,
    );
    const stats = await this.#stats(
      this.deps.pool,
      rows.map((r) => r.id),
    );
    return rows.map((r) => this.#view(r, stats.get(r.id)));
  }

  async #row(db: Queryable, id: string, lock = false): Promise<SubRow> {
    if (!UUID.test(id)) throw notFound();
    const { rows } = await db.query<SubRow>(
      `SELECT ${SUB_COLS} FROM ${SUB_FROM} WHERE s.id = $1${lock ? ' FOR UPDATE OF s' : ''}`,
      [id],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    return r;
  }

  async get(id: string): Promise<SubscriptionView> {
    const r = await this.#row(this.deps.pool, id);
    return this.#view(r, (await this.#stats(this.deps.pool, [id])).get(id));
  }

  #seal(value: string, aad: string): string {
    return this.#box.encrypt(Buffer.from(value, 'utf8'), aad).toString('base64');
  }

  #unseal(sealed: string | Buffer, aad: string): string {
    const blob = typeof sealed === 'string' ? Buffer.from(sealed, 'base64') : sealed;
    return this.#box.decrypt(blob, aad).toString('utf8');
  }

  async #validate(
    db: Queryable,
    id: string,
    input: SubscriptionInput,
    existing: readonly StoredHeader[],
  ): Promise<{
    name: string;
    url: string;
    project: string | null;
    eventTypes: SubscribableEventType[];
    headers: StoredHeader[];
  }> {
    const name = cleanText(input.name, 80);
    if (name.length === 0) throw invalid('name', 'empty', 'Give the webhook a name.');
    const url = input.url.trim();
    const problem = targetProblem(url, await this.#internal(db));
    if (problem !== null)
      throw invalid(
        'url',
        problem,
        problem === 'not_https'
          ? 'Only https:// targets are allowed.'
          : problem === 'forbidden_host' || problem === 'address_refused'
            ? 'This address is internal (loopback, private, link-local or metadata); webhooks only go to public addresses unless the owner lists the exact origin as an internal target.'
            : problem === 'port_refused'
              ? 'Only ports 443 and 8443 are allowed (other ports only for an internal target).'
              : 'The target URL is not valid (https://, no user name or password in it, no #fragment).',
      );
    const project = input.project ?? null;
    if (project !== null) {
      const { rowCount } = await db.query('SELECT 1 FROM projects WHERE id = $1', [project]);
      if ((rowCount ?? 0) === 0) throw new HttpError(404, 'project_not_found', 'Project not found.');
    }
    const types = [...new Set(input.eventTypes)];
    if (types.length === 0) throw invalid('eventTypes', 'empty', 'Choose at least one event.');
    const unknown = types.find((t) => !isSubscribableEventType(t));
    if (unknown !== undefined)
      throw invalid('eventTypes', 'unknown_event', `${unknown}: not an event of the catalog.`, {
        detail: unknown,
      });
    const headers = this.#headers(id, input.headers ?? [], existing);
    return { name, url, project, eventTypes: types.filter(isSubscribableEventType).sort(), headers };
  }

  #headers(id: string, input: readonly HeaderInput[], existing: readonly StoredHeader[]): StoredHeader[] {
    if (input.length > MAX_HEADERS)
      throw invalid('headers', 'too_many', `At most ${String(MAX_HEADERS)} custom headers.`, {
        max: MAX_HEADERS,
      });
    const seen = new Set<string>();
    const out: StoredHeader[] = [];
    for (const h of input) {
      const name = h.name.trim();
      const np = headerNameProblem(name);
      if (np !== null)
        throw invalid(
          'headers',
          np,
          np === 'reserved_name'
            ? `${name}: this header is set by Remyral and cannot be changed.`
            : `${name}: not a valid header name.`,
          { detail: name },
        );
      const lower = name.toLowerCase();
      if (seen.has(lower))
        throw invalid('headers', 'duplicate_name', `${name}: given twice.`, { detail: name });
      seen.add(lower);
      if (h.secret === true) {
        if (h.keep === true && (h.value === undefined || h.value === '')) {
          const prev = existing.find((e) => e.name.toLowerCase() === lower && e.sealed !== undefined);
          if (prev === undefined)
            throw invalid('headers', 'missing_value', `${name}: enter the secret value.`, { detail: name });
          out.push({ ...prev, name });
          continue;
        }
        const value = h.value ?? '';
        const vp = headerValueProblem(value);
        if (vp !== null) throw invalid('headers', vp, `${name}: the value is not valid.`, { detail: name });
        out.push({
          name,
          sealed: this.#seal(value, `webhook-header:${id}:${lower}`),
          hint: value.length <= 8 ? '••••' : `${value.slice(0, 2)}…${value.slice(-2)}`,
        });
        continue;
      }
      if (mustBeSecret(name))
        throw invalid(
          'headers',
          'credential_must_be_secret',
          `${name}: a header that carries a credential is stored only as a secret (write-only); mark it secret.`,
          { detail: name },
        );
      const value = h.value ?? '';
      const vp = headerValueProblem(value);
      if (vp !== null) throw invalid('headers', vp, `${name}: the value is not valid.`, { detail: name });
      out.push({ name, value });
    }
    return out;
  }

  #auditTarget(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return 'invalid';
    }
  }

  /** Creates a subscription; the secret is in this answer only (`reveal: false` — the assistant's card — keeps it). */
  async create(
    actor: WebhookActor,
    input: SubscriptionInput,
    opts: { reveal?: boolean; source?: 'console' | 'chat' | 'api' } = {},
  ): Promise<{ subscription: SubscriptionView; secret: string | null }> {
    const id = randomUUID();
    const now = this.#now();
    const secret = newWebhookSecret();
    const reveal = opts.reveal ?? true;
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows: cnt } = await tx.query<{ n: string }>('SELECT count(*) AS n FROM webhook_subscriptions');
      if (Number(cnt[0]?.n ?? 0) >= this.#options.maxSubscriptions)
        throw new HttpError(
          409,
          'webhook_limit',
          `At most ${String(this.#options.maxSubscriptions)} webhooks.`,
          {},
          {},
          { max: this.#options.maxSubscriptions },
        );
      const v = await this.#validate(tx, id, input, []);
      await tx.query(
        `INSERT INTO webhook_subscriptions (id, name, url, project, event_types, include_details, headers,
           secret_sealed, secret_hint, secret_created_at, secret_revealed_at, state, created_at, created_by,
           updated_at, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $10, $12, $10, $12)`,
        [
          id,
          v.name,
          v.url,
          v.project,
          v.eventTypes,
          input.includeDetails === true,
          JSON.stringify(v.headers),
          this.#box.encrypt(Buffer.from(secret, 'utf8'), `webhook-secret:${id}`),
          secretHint(secret),
          now,
          reveal ? now : null,
          actor.userId,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.create',
          target: `webhook:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            name: v.name,
            origin: this.#auditTarget(v.url),
            project: v.project,
            eventTypes: v.eventTypes,
            includeDetails: input.includeDetails === true,
            headers: v.headers.map((h) => h.name),
            source: opts.source ?? 'console',
          },
        },
        tx,
      );
      return { subscription: this.#view(await this.#row(tx, id)), secret: reveal ? secret : null };
    });
  }

  async update(actor: WebhookActor, id: string, input: SubscriptionInput): Promise<SubscriptionView> {
    return withTransaction(this.deps.pool, async (tx) => {
      const cur = await this.#row(tx, id, true);
      const v = await this.#validate(tx, id, input, cur.headers);
      await tx.query(
        `UPDATE webhook_subscriptions SET name = $2, url = $3, project = $4, event_types = $5, include_details = $6,
           headers = $7, updated_at = $8, updated_by = $9 WHERE id = $1`,
        [
          id,
          v.name,
          v.url,
          v.project,
          v.eventTypes,
          input.includeDetails === true,
          JSON.stringify(v.headers),
          this.#now(),
          actor.userId,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.update',
          target: `webhook:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            before: { origin: this.#auditTarget(cur.url), project: cur.project, eventTypes: cur.event_types },
            after: { origin: this.#auditTarget(v.url), project: v.project, eventTypes: v.eventTypes },
            urlChanged: cur.url !== v.url,
            headers: v.headers.map((h) => h.name),
            includeDetails: input.includeDetails === true,
          },
        },
        tx,
      );
      return this.#view(await this.#row(tx, id));
    });
  }

  /** Pause (no new deliveries are queued, pending ones wait) or resume (also a disabled one: the counter resets). */
  async setState(
    actor: WebhookActor,
    id: string,
    state: 'active' | 'paused',
    source: 'console' | 'chat' | 'api' = 'console',
  ): Promise<SubscriptionView> {
    return withTransaction(this.deps.pool, async (tx) => {
      const cur = await this.#row(tx, id, true);
      if (cur.state !== state) {
        await tx.query(
          `UPDATE webhook_subscriptions SET state = $2, disabled_reason = NULL,
             consecutive_failures = CASE WHEN $2 = 'active' THEN 0 ELSE consecutive_failures END,
             updated_at = $3, updated_by = $4 WHERE id = $1`,
          [id, state, this.#now(), actor.userId],
        );
        await this.deps.audit.record(
          {
            actor: { type: 'user', id: actor.userId },
            action: state === 'active' ? 'webhook.resume' : 'webhook.pause',
            target: `webhook:${id}`,
            outcome: 'success',
            ip: actor.ip ?? null,
            userAgent: actor.userAgent ?? null,
            metadata: { before: cur.state, after: state, source },
          },
          tx,
        );
      }
      return this.#view(await this.#row(tx, id));
    });
  }

  async remove(actor: WebhookActor, id: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const cur = await this.#row(tx, id, true);
      await tx.query('DELETE FROM webhook_subscriptions WHERE id = $1', [id]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.delete',
          target: `webhook:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { name: cur.name, origin: this.#auditTarget(cur.url) },
        },
        tx,
      );
    });
  }

  /**
   * A new secret; the previous one keeps signing (a second `v1`) for `overlapHours` (default 24, at most 168; 0 = at
   * once). The new secret is in this answer only.
   */
  async rotate(
    actor: WebhookActor,
    id: string,
    overlapHours: number = this.#options.defaultOverlapHours,
  ): Promise<{ subscription: SubscriptionView; secret: string }> {
    if (!Number.isInteger(overlapHours) || overlapHours < 0 || overlapHours > this.#options.maxOverlapHours)
      throw invalid(
        'overlapHours',
        'out_of_range',
        `The overlap is 0 to ${String(this.#options.maxOverlapHours)} hours.`,
        { max: this.#options.maxOverlapHours },
      );
    const now = this.#now();
    const secret = newWebhookSecret();
    return withTransaction(this.deps.pool, async (tx) => {
      const cur = await this.#row(tx, id, true);
      const old = this.#unseal(cur.secret_sealed, `webhook-secret:${id}`);
      const until = overlapHours === 0 ? null : new Date(now.getTime() + overlapHours * 3_600_000);
      await tx.query(
        `UPDATE webhook_subscriptions SET secret_sealed = $2, secret_hint = $3, secret_created_at = $4,
           secret_revealed_at = $4, previous_secret_sealed = $5, previous_valid_until = $6, updated_at = $4,
           updated_by = $7 WHERE id = $1`,
        [
          id,
          this.#box.encrypt(Buffer.from(secret, 'utf8'), `webhook-secret:${id}`),
          secretHint(secret),
          now,
          until === null
            ? null
            : this.#box.encrypt(Buffer.from(old, 'utf8'), `webhook-secret-previous:${id}`),
          until,
          actor.userId,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.secret.rotate',
          target: `webhook:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { overlapHours, previousValidUntil: until?.toISOString() ?? null },
        },
        tx,
      );
      return { subscription: this.#view(await this.#row(tx, id)), secret };
    });
  }

  /** Shows a never-shown secret once (a subscription the assistant created: its secret never passes the chat). */
  async revealSecret(actor: WebhookActor, id: string): Promise<{ secret: string }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const cur = await this.#row(tx, id, true);
      if (cur.secret_revealed_at !== null)
        throw new HttpError(
          409,
          'webhook_secret_shown',
          'The secret was already shown once; rotate it to get a new one.',
        );
      await tx.query('UPDATE webhook_subscriptions SET secret_revealed_at = $2 WHERE id = $1', [
        id,
        this.#now(),
      ]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.secret.reveal',
          target: `webhook:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
        },
        tx,
      );
      return { secret: this.#unseal(cur.secret_sealed, `webhook-secret:${id}`) };
    });
  }

  // ------------------------------------------------------------------------------------------------ delivery log

  #deliveryView(r: DeliveryRow): DeliveryView {
    return {
      id: r.id,
      subscriptionId: r.subscription_id,
      eventId: r.event_id,
      eventType: r.event_type,
      project: r.project,
      status: r.status,
      test: r.is_test,
      attempts: r.attempts,
      nextAttemptAt: r.status === 'pending' ? r.next_attempt_at : null,
      lastStatusCode: r.last_status_code,
      lastError: r.last_error,
      lastLatencyMs: r.last_latency_ms,
      lastAttemptAt: r.last_attempt_at,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    };
  }

  async deliveries(
    id: string,
    q: { status?: DeliveryStatus | undefined; limit?: number | undefined; before?: string | undefined } = {},
  ): Promise<{ items: DeliveryView[]; nextCursor: string | null }> {
    await this.#row(this.deps.pool, id);
    const limit = Math.max(1, Math.min(200, q.limit ?? 50));
    const before = q.before !== undefined && /^\d{1,19}$/.test(q.before) ? q.before : null;
    const { rows } = await this.deps.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLS} FROM webhook_deliveries d
        WHERE d.subscription_id = $1 AND ($2::text IS NULL OR d.status = $2) AND ($3::bigint IS NULL OR d.seq < $3)
        ORDER BY d.seq DESC LIMIT $4`,
      [id, q.status ?? null, before, limit + 1],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => this.#deliveryView(r)),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.seq ?? null) : null,
    };
  }

  async delivery(
    id: string,
    deliveryId: string,
  ): Promise<{ delivery: DeliveryView; attempts: AttemptView[]; body: string }> {
    if (!UUID.test(deliveryId)) throw notFound();
    const { rows } = await this.deps.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLS} FROM webhook_deliveries d WHERE d.id = $1 AND d.subscription_id = $2`,
      [deliveryId, id],
    );
    const r = rows[0];
    if (r === undefined) throw notFound();
    const { rows: att } = await this.deps.pool.query<{
      attempt: number;
      started_at: Date;
      latency_ms: number | null;
      status_code: number | null;
      error: string | null;
      response_excerpt: string | null;
    }>(
      `SELECT attempt, started_at, latency_ms, status_code, error, response_excerpt
         FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt, id`,
      [deliveryId],
    );
    return {
      delivery: this.#deliveryView(r),
      attempts: att.map((a) => ({
        attempt: a.attempt,
        startedAt: a.started_at,
        latencyMs: a.latency_ms,
        statusCode: a.status_code,
        error: a.error,
        responseExcerpt: a.response_excerpt,
      })),
      body: r.body,
    };
  }

  /** Sends a finished delivery again (same id and body; the attempt count continues). */
  async redeliver(actor: WebhookActor, id: string, deliveryId: string): Promise<DeliveryView> {
    if (!UUID.test(deliveryId)) throw notFound();
    const view = await withTransaction(this.deps.pool, async (tx) => {
      await this.#row(tx, id);
      const { rows } = await tx.query<DeliveryRow>(
        `UPDATE webhook_deliveries d SET status = 'pending', finished_at = NULL, next_attempt_at = $3,
           claim_token = NULL, claimed_until = NULL
          WHERE d.id = $1 AND d.subscription_id = $2 AND d.status <> 'pending' AND NOT d.is_test
          RETURNING ${DELIVERY_COLS}`,
        [deliveryId, id, this.#now()],
      );
      const r = rows[0];
      if (r === undefined) {
        const { rowCount } = await tx.query(
          'SELECT 1 FROM webhook_deliveries WHERE id = $1 AND subscription_id = $2',
          [deliveryId, id],
        );
        if ((rowCount ?? 0) === 0) throw notFound();
        throw new HttpError(
          409,
          'webhook_delivery_pending',
          'This delivery is still being delivered (or is a test delivery).',
        );
      }
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'webhook.redeliver',
          target: `webhook:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { deliveryId, eventType: r.event_type, attempts: r.attempts },
        },
        tx,
      );
      return this.#deliveryView(r);
    });
    this.kick();
    return view;
  }

  /** "Send test": one `webhook.test` delivery sent now (any state), one attempt, not counted for auto-disable. */
  async test(actor: WebhookActor, id: string): Promise<{ delivery: DeliveryView; attempts: AttemptView[] }> {
    const sub = await this.#row(this.deps.pool, id);
    const now = this.#now();
    const deliveryId = randomUUID();
    const eventId = randomUUID();
    const envelope: WebhookEnvelope = {
      id: eventId,
      type: 'webhook.test',
      catalogVersion: WEBHOOK_CATALOG_VERSION,
      occurredAt: now.toISOString(),
      project: null,
      data: { subscriptionId: id, message: `Test delivery from Remyral for “${sub.name}”.`.slice(0, 200) },
    };
    const token = randomUUID();
    await this.deps.pool.query(
      `INSERT INTO webhook_deliveries (id, subscription_id, event_id, event_type, project, body, status, is_test,
         attempts, next_attempt_at, claim_token, claimed_until, created_at)
       VALUES ($1, $2, $3, 'webhook.test', NULL, $4, 'pending', true, 1, $5, $6, $7, $5)`,
      [
        deliveryId,
        id,
        eventId,
        JSON.stringify(envelope),
        now,
        token,
        new Date(now.getTime() + this.#options.claimMs),
      ],
    );
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'webhook.test',
      target: `webhook:${id}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { deliveryId },
    });
    await this.#send(
      {
        id: deliveryId,
        body: JSON.stringify(envelope),
        attempts: 1,
        eventId,
        eventType: 'webhook.test',
        test: true,
      },
      sub,
      token,
      await this.#internal(),
    );
    const out = await this.delivery(id, deliveryId);
    return { delivery: out.delivery, attempts: out.attempts };
  }

  /** The assistant's read: subscriptions and the recent failed attempts (no secret, no body). */
  async recentFailures(limit = 20): Promise<
    {
      subscriptionId: string;
      name: string;
      deliveryId: string;
      eventType: string;
      status: DeliveryStatus;
      attempts: number;
      lastStatusCode: number | null;
      lastError: string | null;
      lastAttemptAt: Date | null;
    }[]
  > {
    const since = new Date(this.#now().getTime() - 24 * 3_600_000);
    const { rows } = await this.deps.pool.query<{
      subscription_id: string;
      name: string;
      id: string;
      event_type: string;
      status: DeliveryStatus;
      attempts: number;
      last_status_code: number | null;
      last_error: string | null;
      last_attempt_at: Date | null;
    }>(
      `SELECT d.subscription_id::text AS subscription_id, s.name, d.id::text AS id, d.event_type, d.status,
              d.attempts, d.last_status_code, d.last_error, d.last_attempt_at
         FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
        WHERE d.last_attempt_at >= $1 AND (d.last_error IS NOT NULL OR d.last_status_code NOT BETWEEN 200 AND 299)
        ORDER BY d.last_attempt_at DESC LIMIT $2`,
      [since, Math.max(1, Math.min(100, limit))],
    );
    return rows.map((r) => ({
      subscriptionId: r.subscription_id,
      name: r.name,
      deliveryId: r.id,
      eventType: r.event_type,
      status: r.status,
      attempts: r.attempts,
      lastStatusCode: r.last_status_code,
      lastError: r.last_error,
      lastAttemptAt: r.last_attempt_at,
    }));
  }

  // ------------------------------------------------------------------------------------------------ producing

  /**
   * One producer pass: audit entries above the cursor → catalog events → one delivery row per matching active
   * subscription, written in the transaction that advances the cursor (a crash never loses or duplicates one).
   */
  async consume(): Promise<{ rows: number; events: number; deliveries: number }> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows: lock } = await tx.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_xact_lock(${PRODUCER_LOCK.toString()}) AS ok`,
      );
      if (lock[0]?.ok !== true) return { rows: 0, events: 0, deliveries: 0 };
      const { rows: cur } = await tx.query<{ floor_id: string }>(
        "SELECT floor_id::text AS floor_id FROM webhook_consumer WHERE name = 'audit' FOR UPDATE",
      );
      const floor = cur[0]?.floor_id ?? '0';
      const { rows: subs } = await tx.query<{
        id: string;
        project: string | null;
        event_types: string[];
        include_details: boolean;
      }>(
        "SELECT id::text AS id, project, event_types, include_details FROM webhook_subscriptions WHERE state = 'active'",
      );
      if (subs.length === 0) {
        // Nothing listens: move past everything committed so far (no backlog when the first webhook is made).
        await tx.query(
          `UPDATE webhook_consumer SET floor_id = GREATEST(floor_id, COALESCE((SELECT max(id) FROM audit_events), 0))
            WHERE name = 'audit'`,
        );
        return { rows: 0, events: 0, deliveries: 0 };
      }
      const { rows } = await tx.query<AuditRow>(
        `SELECT id::text AS id, occurred_at, actor_type, action, target, outcome, metadata FROM audit_events
          WHERE id > $1 ORDER BY id LIMIT $2`,
        [floor, this.#options.batchSize],
      );
      if (rows.length === 0) return { rows: 0, events: 0, deliveries: 0 };
      const ctx = { db: tx, link: (p: string) => this.#link(p) };
      let events = 0;
      let deliveries = 0;
      const now = this.#now();
      for (const row of rows) {
        if (!SOURCE_ACTIONS.has(row.action)) continue;
        let produced: ProducedEvent[];
        await tx.query('SAVEPOINT webhook_map');
        try {
          produced = await eventsFromAudit(ctx, row);
          await tx.query('RELEASE SAVEPOINT webhook_map');
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT webhook_map');
          // A mapping error must not stall the cursor: the entry is skipped and reported (ids only).
          this.deps.log?.error(
            { auditId: row.id, action: row.action, errName: err instanceof Error ? err.name : 'error' },
            'webhook event mapping failed; entry skipped',
          );
          continue;
        }
        for (const e of produced) {
          events += 1;
          const targets = subs.filter(
            (s) => s.event_types.includes(e.type) && (s.project === null || s.project === e.project),
          );
          for (const s of targets) {
            const envelope: WebhookEnvelope = {
              id: e.id,
              type: e.type,
              catalogVersion: WEBHOOK_CATALOG_VERSION,
              occurredAt: e.occurredAt.toISOString(),
              project: e.project,
              data: s.include_details ? e.detailed : e.data,
            };
            const ins = await tx.query(
              `INSERT INTO webhook_deliveries (id, subscription_id, event_id, event_type, project, audit_id, body,
                 status, attempts, next_attempt_at, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $8)
               ON CONFLICT (subscription_id, event_id) DO NOTHING`,
              [randomUUID(), s.id, e.id, e.type, e.project, e.auditId, JSON.stringify(envelope), now],
            );
            deliveries += ins.rowCount ?? 0;
          }
        }
      }
      await tx.query("UPDATE webhook_consumer SET floor_id = $1 WHERE name = 'audit'", [
        rows[rows.length - 1]?.id,
      ]);
      return { rows: rows.length, events, deliveries };
    });
  }

  // ------------------------------------------------------------------------------------------------ delivering

  #delay(attempts: number): number {
    const base = this.#options.backoffMs[Math.max(0, attempts - 1)] ?? 0;
    const j = this.#options.jitter;
    return Math.max(1_000, Math.round(base * (1 + (this.#random() * 2 - 1) * j)));
  }

  /** Total attempts of a delivery: the first one plus one per backoff step. */
  get maxAttempts(): number {
    return this.#options.backoffMs.length + 1;
  }

  /** Claims due deliveries (fenced lease) and sends them: in order per subscription, subscriptions in parallel. */
  async deliverDue(): Promise<{ claimed: number; succeeded: number; failed: number; retried: number }> {
    const now = this.#now();
    const token = randomUUID();
    const { rows } = await this.deps.pool.query<{
      id: string;
      subscription_id: string;
      body: string;
      attempts: number;
      event_id: string;
      event_type: string;
      seq: string;
    }>(
      `UPDATE webhook_deliveries d SET claim_token = $1, claimed_until = $2, attempts = d.attempts + 1
        WHERE d.id IN (
          SELECT x.id FROM webhook_deliveries x JOIN webhook_subscriptions s ON s.id = x.subscription_id
           WHERE x.status = 'pending' AND NOT x.is_test AND x.next_attempt_at <= $3
             AND (x.claimed_until IS NULL OR x.claimed_until <= $3) AND s.state = 'active'
           ORDER BY x.seq LIMIT $4 FOR UPDATE OF x SKIP LOCKED)
        RETURNING d.id::text AS id, d.subscription_id::text AS subscription_id, d.body, d.attempts,
                  d.event_id::text AS event_id, d.event_type, d.seq::text AS seq`,
      [token, new Date(now.getTime() + this.#options.claimMs), now, this.#options.deliverBatch],
    );
    const tally = { claimed: rows.length, succeeded: 0, failed: 0, retried: 0 };
    if (rows.length === 0) return tally;
    const bySub = new Map<string, typeof rows>();
    for (const r of [...rows].sort((a, b) => Number(BigInt(a.seq) - BigInt(b.seq)))) {
      const list = bySub.get(r.subscription_id) ?? [];
      list.push(r);
      bySub.set(r.subscription_id, list);
    }
    const internal = await this.#internal();
    const queue = [...bySub.entries()];
    const worker = async (): Promise<void> => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        const [subId, list] = next;
        let sub: SubRow;
        try {
          sub = await this.#row(this.deps.pool, subId);
        } catch {
          continue; // deleted meanwhile (its deliveries are gone with it)
        }
        for (const d of list) {
          // Disabled by an earlier failure of this pass: the rest stays pending (released for later).
          if (sub.state !== 'active') {
            await this.#release(d.id, token);
            continue;
          }
          const out = await this.#send(
            {
              id: d.id,
              body: d.body,
              attempts: d.attempts,
              eventId: d.event_id,
              eventType: d.event_type,
              test: false,
            },
            sub,
            token,
            internal,
          );
          if (out === 'succeeded') tally.succeeded += 1;
          else if (out === 'failed') tally.failed += 1;
          else if (out === 'retry') tally.retried += 1;
          if (out === 'retry' || out === 'failed') {
            const disabled = await this.#countFailure(sub);
            if (disabled) sub = { ...sub, state: 'disabled' };
          } else if (out === 'succeeded') {
            await this.deps.pool.query(
              'UPDATE webhook_subscriptions SET consecutive_failures = 0, last_success_at = $2 WHERE id = $1',
              [sub.id, this.#now()],
            );
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#options.concurrency, queue.length) }, () => worker()),
    );
    return tally;
  }

  async #release(deliveryId: string, token: string): Promise<void> {
    await this.deps.pool.query(
      `UPDATE webhook_deliveries SET attempts = GREATEST(attempts - 1, 0), claim_token = NULL, claimed_until = NULL
        WHERE id = $1 AND claim_token = $2`,
      [deliveryId, token],
    );
  }

  /** One attempt of a claimed delivery; the result is written only while the claim is still ours. */
  async #send(
    d: {
      readonly id: string;
      readonly body: string;
      readonly attempts: number;
      readonly eventId: string;
      readonly eventType: string;
      readonly test: boolean;
    },
    sub: SubRow,
    token: string,
    internal: ReadonlySet<string>,
  ): Promise<'succeeded' | 'failed' | 'retry' | 'lost'> {
    const startedAt = this.#now();
    const problem = targetProblem(sub.url, internal);
    let status: number | null = null;
    let error: string | null = null;
    let latency: number | null = null;
    let excerpt: string | null = null;
    if (problem !== null) {
      error = 'target_refused';
    } else {
      let headers: Record<string, string>;
      try {
        headers = this.#requestHeaders(sub, d, startedAt);
      } catch {
        headers = {};
        error = 'secret_unreadable';
      }
      if (error === null) {
        const internalOrigin = internal.has(new URL(sub.url).origin);
        const res = await this.deps.sender({ url: sub.url, headers, body: d.body, internal: internalOrigin });
        status = res.status;
        latency = res.latencyMs;
        if (res.error !== null) error = res.error;
        else if (status !== null && (status < 200 || status > 299)) error = `http_${String(status)}`;
        if (res.body !== null && res.body.length > 0) {
          const text = cleanText(res.body.subarray(0, 1024).toString('utf8'), 1024);
          excerpt = text === '' ? null : text;
        }
      }
    }
    const ok = error === null;
    const at = this.#now();
    const final = ok || d.test || d.attempts >= this.maxAttempts;
    const res = await this.deps.pool.query(
      `UPDATE webhook_deliveries SET status = $3, finished_at = $4, next_attempt_at = $5, claim_token = NULL,
         claimed_until = NULL, last_status_code = $6, last_error = $7, last_latency_ms = $8, last_attempt_at = $9
        WHERE id = $1 AND claim_token = $2`,
      [
        d.id,
        token,
        ok ? 'succeeded' : final ? 'failed' : 'pending',
        final ? at : null,
        final ? at : new Date(at.getTime() + this.#delay(d.attempts)),
        status,
        error,
        latency,
        startedAt,
      ],
    );
    if ((res.rowCount ?? 0) === 0) return 'lost'; // the lease expired and another sender owns the delivery now
    await this.deps.pool.query(
      `INSERT INTO webhook_delivery_attempts (delivery_id, attempt, started_at, latency_ms, status_code, error,
         response_excerpt) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [d.id, d.attempts, startedAt, latency, status, error, excerpt],
    );
    if (!ok)
      this.deps.log?.warn(
        { webhookId: sub.id, deliveryId: d.id, attempt: d.attempts, error, final },
        'webhook delivery attempt failed',
      );
    return ok ? 'succeeded' : final ? 'failed' : 'retry';
  }

  #requestHeaders(
    sub: SubRow,
    d: {
      readonly id: string;
      readonly body: string;
      readonly attempts: number;
      readonly eventId: string;
      readonly eventType: string;
    },
    at: Date,
  ): Record<string, string> {
    const secrets = [this.#unseal(sub.secret_sealed, `webhook-secret:${sub.id}`)];
    if (
      sub.previous_secret_sealed !== null &&
      sub.previous_valid_until !== null &&
      sub.previous_valid_until > at
    )
      secrets.push(this.#unseal(sub.previous_secret_sealed, `webhook-secret-previous:${sub.id}`));
    const t = Math.floor(at.getTime() / 1000);
    const custom: Record<string, string> = {};
    for (const h of sub.headers) {
      custom[h.name] =
        h.sealed === undefined
          ? (h.value ?? '')
          : this.#unseal(h.sealed, `webhook-header:${sub.id}:${h.name.toLowerCase()}`);
    }
    return {
      ...custom,
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      [WEBHOOK_HEADERS.signature]: signatureHeader(secrets, t, d.body),
      [WEBHOOK_HEADERS.delivery]: d.id,
      [WEBHOOK_HEADERS.eventId]: d.eventId,
      [WEBHOOK_HEADERS.event]: d.eventType,
      [WEBHOOK_HEADERS.attempt]: String(d.attempts),
    };
  }

  /** Counts a failed attempt; at the threshold the subscription is disabled, audited and the admins are told. */
  async #countFailure(sub: SubRow): Promise<boolean> {
    return withTransaction(this.deps.pool, async (tx) => {
      const { rows } = await tx.query<{ consecutive_failures: number; state: SubscriptionState }>(
        `UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1, last_failure_at = $2
          WHERE id = $1 RETURNING consecutive_failures, state`,
        [sub.id, this.#now()],
      );
      const r = rows[0];
      if (r === undefined || r.state !== 'active' || r.consecutive_failures < this.#options.autoDisableAfter)
        return false;
      await tx.query(
        `UPDATE webhook_subscriptions SET state = 'disabled', disabled_reason = 'consecutive_failures', updated_at = $2
          WHERE id = $1`,
        [sub.id, this.#now()],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'system', id: 'webhooks' },
          action: 'webhook.disabled',
          target: `webhook:${sub.id}`,
          outcome: 'success',
          metadata: { reason: 'consecutive_failures', failures: r.consecutive_failures },
        },
        tx,
      );
      const n = this.deps.notifications();
      if (n !== null) {
        await n.notify(tx, await globalRecipients(tx, 'admin'), {
          kind: 'webhook.disabled',
          severity: 'warning',
          title: `Webhook “${sub.name}” was turned off`,
          body: `The last ${String(r.consecutive_failures)} delivery attempts to ${this.#auditTarget(sub.url)} failed, so the webhook was turned off. Deliveries wait; check the receiver, then resume it in Settings → Webhooks (the delivery log shows each attempt).`,
          link: '/settings/webhooks',
          dedupeKey: `webhook.disabled:${sub.id}:${this.#now().toISOString()}`,
        });
      }
      return true;
    });
  }

  // ------------------------------------------------------------------------------------------------ housekeeping

  /** Deletes finished deliveries past the retention; expires pending ones that old (a long-paused webhook). */
  async prune(): Promise<{ deleted: number; expired: number }> {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - this.#options.retentionMs);
    const exp = await this.deps.pool.query(
      `UPDATE webhook_deliveries SET status = 'failed', last_error = 'expired', finished_at = $2, claim_token = NULL,
         claimed_until = NULL WHERE status = 'pending' AND created_at < $1`,
      [cutoff, now],
    );
    const del = await this.deps.pool.query('DELETE FROM webhook_deliveries WHERE finished_at < $1', [cutoff]);
    return { deleted: del.rowCount ?? 0, expired: exp.rowCount ?? 0 };
  }

  async runOnce(): Promise<{ deliveries: number; succeeded: number; failed: number; retried: number }> {
    let produced = 0;
    for (let i = 0; i < 10; i++) {
      const c = await this.consume();
      produced += c.deliveries;
      if (c.rows < this.#options.batchSize) break;
    }
    const d = await this.deliverDue();
    return { deliveries: produced, succeeded: d.succeeded, failed: d.failed, retried: d.retried };
  }

  /** Background loop (compose.ts); returns a stop function. Errors are reported, never thrown. */
  start(intervalMs: number, onError: (err: unknown) => void): () => void {
    let lastPrune = 0;
    const tick = (): void => {
      if (this.#running) {
        this.#again = true;
        return;
      }
      this.#running = true;
      const work = async (): Promise<void> => {
        await this.runOnce();
        if (Date.now() - lastPrune > 3_600_000) {
          lastPrune = Date.now();
          await this.prune();
        }
      };
      work()
        .catch(onError)
        .finally(() => {
          this.#running = false;
          if (this.#again) {
            this.#again = false;
            setImmediate(tick);
          }
        });
    };
    this.#timer = setInterval(tick, intervalMs);
    this.#timer.unref();
    this.#kick = tick;
    return () => {
      if (this.#timer !== null) clearInterval(this.#timer);
      this.#timer = null;
      this.#kick = null;
    };
  }

  #kick: (() => void) | null = null;

  /** Runs a pass soon (after a redelivery); a no-op without the background loop (tests drive runOnce()). */
  kick(): void {
    const k = this.#kick;
    if (k !== null) setImmediate(k);
  }
}
