import {
  contentHash,
  parseNamespace,
  projectNamespace,
  type Role,
  roleAtLeast,
  scanForSecrets,
} from '@remyral/memory';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { withTransaction } from '../db/pool.js';
import {
  ContextError,
  ContextForbiddenError,
  ContextStepUpRequiredError,
  InvalidContextInputError,
} from '../context/errors.js';
import type { ContextPolicyService } from '../context/policy.js';
import { type ContextActor, type RequestMeta, roleIn, stepUpFresh } from '../context/store.js';
import { chatSnippet, keywordSnippet } from './chat-text.js';
import { cosine, type Embedder } from './embedder.js';
import { rowContent } from '../blobs/registry.js';

/**
 * Optional semantic search (p6-vector, docs/design/p6-vector.md): consent-bound capture of context
 * documents and job result summaries into a vector index, deletion/reindex driven by the context deletion
 * receipts, and an RBAC-scoped search.
 *
 * What is indexed: the current version of live context documents (title + content) and the latest result
 * summary of each job — never job prompts, logs, events, transcripts or secrets. Nothing of a namespace is
 * sent to the embedding provider unless that namespace's consent flag is on (audited).
 *
 * p10-semantic-defaults-chat: project search also finds project-linked ops chat messages (`chat_message`), indexed by
 * ChatKnowledge into `chat_embeddings` (scope `project`) — only while the thread's owner shares them (thread switch and
 * personal setting), the project's capture is on and the owner can still read the project; every condition is
 * re-checked at query time ({@link projectChatEligible}).
 */

export const MAX_QUERY_CHARS = 500;
/** Characters of a source that are embedded (title + content, clipped). */
export const MAX_EMBED_CHARS = 8000;
/** Candidates scored per search (brute force, docs/design/p6-vector.md §5). */
export const MAX_CANDIDATES = 20_000;
const SYNC_BATCH = 64;
const SNIPPET_CHARS = 240;

export class SearchUnavailableError extends ContextError {
  override name = 'SearchUnavailableError';
  readonly code = 'search_unavailable';
  readonly httpStatus = 409;
  readonly publicMessage = 'Semantic search is not configured on this server (SEARCH_PROVIDER).';
  constructor() {
    super('search provider not configured');
  }
}

export class SearchNotEnabledError extends ContextError {
  override name = 'SearchNotEnabledError';
  readonly code = 'search_not_enabled';
  readonly httpStatus = 409;
  readonly publicMessage = 'Semantic search is not enabled for this project.';
  constructor(readonly namespace: string) {
    super(`search not enabled for ${namespace.slice(0, 140)}`);
  }
}

export class SearchConsentConflictError extends ContextError {
  override name = 'SearchConsentConflictError';
  readonly code = 'search_consent_conflict';
  readonly httpStatus = 409;
  readonly publicMessage = 'The search setting was changed by someone else; reload and try again.';
  constructor() {
    super('search consent version conflict');
  }
}

export class SearchQueryRejectedError extends ContextError {
  override name = 'SearchQueryRejectedError';
  readonly code = 'search_query_rejected';
  readonly httpStatus = 400;
  readonly publicMessage = 'The query looks like it contains a secret; it was not sent anywhere.';
  constructor() {
    super('search query contains a secret-looking value');
  }
}

export class SearchRateLimitedError extends ContextError {
  override name = 'SearchRateLimitedError';
  readonly code = 'search_rate_limited';
  readonly httpStatus = 429;
  readonly publicMessage = 'Too many searches; try again in a minute.';
  constructor() {
    super('search rate limited');
  }
}

export class SearchProviderError extends ContextError {
  override name = 'SearchProviderError';
  readonly code = 'search_provider_error';
  readonly httpStatus = 502;
  readonly publicMessage = 'The embedding provider is unavailable; try again later.';
  constructor() {
    super('embedding provider failed');
  }
}

export interface SearchConsent {
  readonly namespace: string;
  readonly enabled: boolean;
  /** 0 = never set (off). */
  readonly version: number;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
  /** Vectors currently stored for the namespace. */
  readonly indexed: number;
  /**
   * p10-semantic-defaults-chat: where the setting came from — `explicit` (an admin changed it), `create` (chosen in the
   * create-project form), `platform_default` (the one-time backfill); null when never set.
   */
  readonly origin: 'explicit' | 'create' | 'platform_default' | null;
}

export interface SearchSettings extends SearchConsent {
  /** The server has a provider configured. */
  readonly available: boolean;
  /** Vector space of the configured provider (null when unavailable). */
  readonly model: string | null;
  /** p10-semantic-memory: provider label (`bedrock`, `http`, `local-hash`; null when unavailable). */
  readonly provider: string | null;
  /** p10-semantic-memory: vector length when known (configured, or seen in the stored vectors). */
  readonly dims: number | null;
  /**
   * p10-bedrock-integration-panel: where the active provider's configuration and credentials come from — `panel`
   * (Settings → Integrations), `environment` (stack.env keys), `instance role` (the AWS SDK default chain without
   * keys in the environment: EC2 instance profile); null when unavailable.
   */
  readonly source: ProviderSource | null;
  /** p10-bedrock-integration-panel: the Bedrock region (null for other providers). */
  readonly region: string | null;
}

/** p10-bedrock-integration-panel: where the active embedding provider is configured. */
export type ProviderSource = 'panel' | 'environment' | 'instance role';

/** p10-bedrock-integration-panel: what the provider resolver says about the active embedder. */
export interface ProviderMeta {
  readonly source: ProviderSource | null;
  /** Bedrock region (part of the provider identity: a change rebuilds the index); null for other providers. */
  readonly region: string | null;
}

/** Who caused a provider change (the audit actor); omitted: the indexer (system). */
export interface ProviderChangeActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

/** p10-semantic-memory: how a search was answered. */
export type SearchMode = 'semantic' | 'keyword';

/**
 * p10-semantic-memory: why a search with keyword fallback did not use the embeddings (shown as a hint):
 * no provider, capture off for the project, a secret-looking query (it would leave the system), the provider
 * failed, or the per-user provider rate limit.
 */
export type FallbackReason =
  'unavailable' | 'not_enabled' | 'query_rejected' | 'provider_error' | 'rate_limited';

export interface FindResult {
  readonly mode: SearchMode;
  readonly fallbackReason: FallbackReason | null;
  readonly items: readonly SearchHit[];
}

export interface FindOptions {
  readonly limit?: number | undefined;
  /** Only these source types (default all). */
  readonly types?: readonly SearchHit['type'][] | undefined;
  /** Fall back to keyword search instead of answering 409/400/429/502 (default false: the p6-vector contract). */
  readonly fallback?: boolean | undefined;
}

export type SearchHitType = 'context_doc' | 'job_summary' | 'chat_message';

/** p10-semantic-defaults-chat: where a project-linked chat hit comes from. */
export interface ChatProvenance {
  readonly author: 'user' | 'assistant';
  /** The thread owner's username (the person whose conversation it is). */
  readonly ownerName: string;
  readonly seq: number;
  readonly at: string;
  /** Only for the thread's owner (nobody else can open a conversation). */
  readonly threadId: string | null;
}

export interface SearchHit {
  readonly type: SearchHitType;
  readonly id: string;
  readonly namespace: string;
  readonly title: string;
  readonly snippet: string;
  readonly version: string;
  readonly score: number;
  readonly chat?: ChatProvenance;
}

/**
 * p10-semantic-defaults-chat (§12.4): SQL condition that a project-linked chat message `msg` of thread `t` may be shown
 * in project `project` — linked to it, the thread shares it, the owner did not switch indexing or sharing off, the
 * project's capture is on, and the owner can (still) read the project. `t` must be the message's chat_threads row.
 */
export function projectChatEligible(msg: string, project: string): string {
  return `EXISTS (SELECT 1 FROM chat_message_links l WHERE l.message_id = ${msg} AND l.project = ${project})
    AND t.project_share
    AND NOT EXISTS (SELECT 1 FROM chat_search_prefs pr
                     WHERE pr.user_id = t.user_id AND (NOT pr.index_enabled OR NOT pr.share_projects))
    AND EXISTS (SELECT 1 FROM search_consent c WHERE c.namespace = 'project:' || ${project} AND c.enabled)
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id
                  AND (u.role IN ('owner', 'admin') OR EXISTS (
                        SELECT 1 FROM project_memberships pm WHERE pm.user_id = u.id AND pm.project_id = ${project})))`;
}

export interface SyncStats {
  readonly receipts: number;
  readonly removed: number;
  readonly indexedDocs: number;
  readonly indexedJobs: number;
  /** Sources skipped because the secret scan found something (should never happen: writes are scanned). */
  readonly skippedSecrets: number;
}

const RANK: Readonly<Record<Role, number>> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

interface ConsentRow {
  namespace: string;
  enabled: boolean;
  source: 'explicit' | 'create' | 'platform_default';
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

/** Clip to MAX_EMBED_CHARS without splitting a surrogate pair. */
export function clip(text: string, max = MAX_EMBED_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

export function docText(title: string, content: string, max = MAX_EMBED_CHARS): string {
  return clip(`${title}\n\n${content}`, max);
}

/** Search terms of a keyword query: up to 6 distinct words of 2+ characters (lower-cased). */
export function keywordTerms(query: string): string[] {
  const words =
    query
      .toLowerCase()
      .normalize('NFKC')
      .match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2))].slice(0, 6);
}

/** `%…%` ILIKE pattern with LIKE wildcards escaped. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Simple fixed-window limiter per user (searches cost provider calls). */
class SearchLimiter {
  private readonly windows = new Map<string, { start: number; n: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number,
  ) {}
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (w === undefined || t - w.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: t, n: 1 });
      return true;
    }
    w.n += 1;
    return w.n <= this.perMinute;
  }
}

export interface SearchServiceDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly policy: ContextPolicyService;
  /** null: no provider configured — consent cannot be enabled, search answers 409 search_unavailable. */
  readonly embedder: Embedder | null;
  /** p10-bedrock-integration-panel: source/region of `embedder` (default: environment, no region). */
  readonly providerMeta?: ProviderMeta;
  readonly clock?: () => Date;
  /** Searches per user per minute (default 30). */
  readonly searchesPerMinute?: number;
}

export class SearchService {
  private readonly pool: pg.Pool;
  private readonly audit: AuditRecorder;
  private readonly policy: ContextPolicyService;
  #embedder: Embedder | null;
  #meta: ProviderMeta;
  private readonly clock: () => Date;
  private readonly limiter: SearchLimiter;
  private syncing: Promise<SyncStats> | null = null;

  constructor(deps: SearchServiceDeps) {
    this.pool = deps.pool;
    this.audit = deps.audit;
    this.policy = deps.policy;
    this.#embedder = deps.embedder;
    this.#meta = deps.providerMeta ?? {
      source: deps.embedder === null ? null : 'environment',
      region: null,
    };
    this.clock = deps.clock ?? (() => new Date());
    this.limiter = new SearchLimiter(deps.searchesPerMinute ?? 30, () => this.clock().getTime());
  }

  /** The active embedder (null: no provider). Swapped by the provider resolver (p10-bedrock-integration-panel). */
  get embedder(): Embedder | null {
    return this.#embedder;
  }

  get providerMeta(): ProviderMeta {
    return this.#meta;
  }

  /**
   * p10-bedrock-integration-panel: replaces the active provider (Settings → Integrations → AWS Bedrock, or the
   * environment fallback). The vector space is not touched here: `noteProvider` / the next indexer pass compare it
   * with the index and rebuild when the model or region changed.
   */
  setProvider(embedder: Embedder | null, meta: ProviderMeta): void {
    this.#embedder = embedder;
    this.#meta = embedder === null ? { source: null, region: null } : meta;
  }

  /**
   * p10-bedrock-integration-panel: records the active provider right away (a panel change): when its model or
   * region differs from the one the index was built with, the change is audited with the person as actor and the
   * stale vectors are dropped — the next indexer pass rebuilds every consented namespace.
   */
  async noteProvider(actor?: ProviderChangeActor): Promise<{ changed: boolean; removedVectors: number }> {
    const e = this.#embedder;
    if (e === null) return { changed: false, removedVectors: 0 };
    return this.noteModel(e.model, this.#meta.region, actor);
  }

  // ------------------------------------------------------------------------------------- consent

  private checkNamespace(namespace: string): void {
    const ns = parseNamespace(namespace);
    if (ns === null || ns.type === 'skill' || ns.type === 'machine') {
      throw new InvalidContextInputError([{ field: 'namespace', code: 'invalid_namespace' }]);
    }
  }

  private async consent(
    db: pg.Pool | pg.PoolClient,
    namespace: string,
    lock = false,
  ): Promise<SearchConsent> {
    const { rows } = await db.query<ConsentRow>(
      `SELECT namespace, enabled, version, updated_at, updated_by::text AS updated_by, source
         FROM search_consent WHERE namespace = $1${lock ? ' FOR UPDATE' : ''}`,
      [namespace],
    );
    const { rows: counted } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM search_embeddings WHERE namespace = $1',
      [namespace],
    );
    const r = rows[0];
    return {
      namespace,
      enabled: r?.enabled ?? false,
      version: r?.version ?? 0,
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
      indexed: counted[0]?.n ?? 0,
      origin: r?.source ?? null,
    };
  }

  /** The search setting of a namespace (anyone who can read the namespace's context). */
  async settings(user: ContextActor, namespace: string): Promise<SearchSettings> {
    this.checkNamespace(namespace);
    if (roleIn(user, namespace) === null) throw new ContextForbiddenError('not_visible');
    return { ...(await this.consent(this.pool, namespace)), ...(await this.providerInfo()) };
  }

  /** p10-semantic-memory: what Settings shows about the configured provider. */
  async providerInfo(): Promise<
    Pick<SearchSettings, 'available' | 'model' | 'provider' | 'dims' | 'source' | 'region'>
  > {
    const e = this.#embedder;
    if (e === null)
      return { available: false, model: null, provider: null, dims: null, source: null, region: null };
    let dims = e.dims ?? null;
    if (dims === null) {
      const { rows } = await this.pool.query<{ dims: number }>(
        'SELECT dims FROM search_embeddings WHERE model = $1 LIMIT 1',
        [e.model],
      );
      dims = rows[0]?.dims ?? null;
    }
    return {
      available: true,
      model: e.model,
      provider: e.provider ?? null,
      dims,
      source: this.#meta.source,
      region: this.#meta.region,
    };
  }

  /**
   * Turn capture for a namespace on or off (admin+ in the namespace, fresh step-up, optimistic, audited).
   * Turning it off deletes every vector of the namespace in the same transaction.
   */
  async setConsent(
    user: ContextActor,
    input: { readonly namespace: string; readonly enabled: boolean; readonly expectedVersion: number },
    meta: RequestMeta = {},
  ): Promise<SearchSettings> {
    const target = `search-consent:${input.namespace.slice(0, 140)}`;
    try {
      this.checkNamespace(input.namespace);
      const role = roleIn(user, input.namespace);
      if (role === null || !roleAtLeast(role, 'admin') || !roleAtLeast(user.role, 'admin')) {
        throw new ContextForbiddenError('role');
      }
      if (!stepUpFresh(user.mfaAt, this.clock(), user.stepUpMaxAgeMs)) throw new ContextStepUpRequiredError();
      if (input.enabled && this.#embedder === null) throw new SearchUnavailableError();
      const result = await withTransaction(this.pool, async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', [target]);
        const before = await this.consent(tx, input.namespace, true);
        if (before.version !== input.expectedVersion) throw new SearchConsentConflictError();
        const now = this.clock();
        await tx.query(
          `INSERT INTO search_consent (namespace, enabled, version, updated_at, updated_by)
           VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (namespace) DO UPDATE
             SET enabled = EXCLUDED.enabled, version = search_consent.version + 1,
                 updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by, source = 'explicit'`,
          [input.namespace, input.enabled, now, user.id],
        );
        let removed = 0;
        const ns = parseNamespace(input.namespace);
        const project = ns?.type === 'project' ? ns.project : null;
        if (!input.enabled) {
          const del = await tx.query('DELETE FROM search_embeddings WHERE namespace = $1', [input.namespace]);
          removed = del.rowCount ?? 0;
          if (project !== null) {
            // p10-semantic-defaults-chat: project-linked chat leaves the project's knowledge with it.
            const chat = await tx.query(
              `DELETE FROM chat_embeddings WHERE scope = 'project' AND project = $1`,
              [project],
            );
            removed += chat.rowCount ?? 0;
            // p17-embeddings: the project's work vectors (similar jobs, failures, automations) go with it.
            const work = await tx.query('DELETE FROM work_embeddings WHERE project = $1', [project]);
            removed += work.rowCount ?? 0;
          }
        } else if (project !== null) {
          // Threads linked to the project are re-read by the next chat pass (their project vectors are built).
          await tx.query(
            `UPDATE chat_threads SET search_synced_at = NULL
              WHERE id IN (SELECT thread_id FROM chat_message_links WHERE project = $1)`,
            [project],
          );
        }
        await this.audit.record(
          {
            actor: { type: 'user', id: user.id },
            action: 'context.search.consent',
            target,
            outcome: 'success',
            ...meta,
            metadata: {
              namespace: input.namespace,
              before: before.enabled,
              after: input.enabled,
              model: this.#embedder?.model ?? null,
              removedVectors: removed,
            },
          },
          tx,
        );
        return this.consent(tx, input.namespace);
      });
      return { ...result, ...(await this.providerInfo()) };
    } catch (err) {
      if (err instanceof ContextError) {
        await this.audit.record({
          actor: { type: 'user', id: user.id },
          action: 'context.search.consent',
          target,
          outcome: 'denied',
          ...meta,
          metadata: { namespace: input.namespace.slice(0, 140), code: err.code },
        });
      }
      throw err;
    }
  }

  /**
   * Rebuild a namespace's vectors (admin+, step-up, audited): pending deletion receipts are applied first,
   * then the namespace's vectors are dropped and rebuilt from the live sources.
   */
  async reindex(user: ContextActor, namespace: string, meta: RequestMeta = {}): Promise<SyncStats> {
    this.checkNamespace(namespace);
    const role = roleIn(user, namespace);
    if (role === null || !roleAtLeast(role, 'admin') || !roleAtLeast(user.role, 'admin')) {
      throw new ContextForbiddenError('role');
    }
    if (!stepUpFresh(user.mfaAt, this.clock(), user.stepUpMaxAgeMs)) throw new ContextStepUpRequiredError();
    if (this.#embedder === null) throw new SearchUnavailableError();
    const consent = await this.consent(this.pool, namespace);
    if (!consent.enabled) throw new SearchNotEnabledError(namespace);
    await this.applyReceipts();
    const del = await this.pool.query('DELETE FROM search_embeddings WHERE namespace = $1', [namespace]);
    await this.audit.record({
      actor: { type: 'user', id: user.id },
      action: 'context.search.reindex',
      target: `search-consent:${namespace.slice(0, 140)}`,
      outcome: 'success',
      ...meta,
      metadata: { namespace, removedVectors: del.rowCount ?? 0, model: this.#embedder.model },
    });
    return this.sync();
  }

  // ------------------------------------------------------------------------------------- indexing

  /** One indexer pass; concurrent callers share the running pass. */
  sync(): Promise<SyncStats> {
    if (this.syncing !== null) return this.syncing;
    const run = this.syncOnce().finally(() => {
      this.syncing = null;
    });
    this.syncing = run;
    return run;
  }

  /** `before` (p10-bedrock-integration-panel): runs before every pass (the provider resolver re-reads the panel). */
  startIndexer(
    intervalMs: number,
    onError: (err: unknown) => void,
    before?: () => Promise<void>,
  ): () => void {
    const timer = setInterval(() => {
      (before === undefined ? this.sync() : before().then(() => this.sync())).catch(onError);
    }, intervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
    };
  }

  private async syncOnce(): Promise<SyncStats> {
    const { receipts, removed: byReceipts } = await this.applyReceipts();
    // Belt and braces: vectors of namespaces whose consent is off (or was never on) are dropped.
    const off = await this.pool.query(
      `DELETE FROM search_embeddings e
        WHERE NOT EXISTS (SELECT 1 FROM search_consent c WHERE c.namespace = e.namespace AND c.enabled)`,
    );
    // p10-semantic-defaults-chat: project-linked chat of a project whose capture is off.
    await this.pool.query(
      `DELETE FROM chat_embeddings e
        WHERE e.scope = 'project'
          AND NOT EXISTS (SELECT 1 FROM search_consent c WHERE c.namespace = 'project:' || e.project AND c.enabled)`,
    );
    const embedder = this.#embedder;
    const region = this.#meta.region;
    if (embedder === null) {
      return {
        receipts,
        removed: byReceipts + (off.rowCount ?? 0),
        indexedDocs: 0,
        indexedJobs: 0,
        skippedSecrets: 0,
      };
    }
    // Vectors of another model are useless (different space): drop them, they are rebuilt below. p10-semantic-memory:
    // a provider/model change is recorded (audited once) — the rebuild below is the reindex it triggers.
    const stale = await this.noteModel(embedder.model, region);
    const docs = await this.indexDocs(embedder);
    const jobs = await this.indexJobs(embedder);
    return {
      receipts,
      removed: byReceipts + (off.rowCount ?? 0) + stale.removedVectors,
      indexedDocs: docs.indexed,
      indexedJobs: jobs.indexed,
      skippedSecrets: docs.skipped + jobs.skipped,
    };
  }

  /**
   * p10-semantic-memory: drops vectors of another model and, when the configured model differs from the one the
   * index was last built with, audits `context.search.provider_changed` (system actor) once. Returns the deletion.
   *
   * p10-bedrock-integration-panel: the Bedrock region is part of the provider identity — a region change drops every
   * vector (rebuilt by the pass) and is audited the same way. A state row without a region (written before the
   * region was tracked) with the same model adopts the region without a rebuild. A panel change passes the person as
   * the audit actor.
   */
  private async noteModel(
    model: string,
    region: string | null,
    actor?: ProviderChangeActor,
  ): Promise<{ changed: boolean; removedVectors: number }> {
    return withTransaction(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 11))', ['search-provider-state']);
      const { rows } = await tx.query<{ model: string; region: string | null }>(
        `SELECT model, region FROM search_provider_state WHERE name = 'active'`,
      );
      const before = rows[0]?.model ?? null;
      const beforeRegion = rows[0]?.region ?? null;
      const modelChanged = before !== model;
      const regionChanged =
        !modelChanged && beforeRegion !== null && region !== null && beforeRegion !== region;
      const del = regionChanged
        ? await tx.query('DELETE FROM search_embeddings')
        : await tx.query('DELETE FROM search_embeddings WHERE model <> $1', [model]);
      // p10-semantic-defaults-chat: chat vectors live in the same space; the chat pass rebuilds them.
      const chatDel = regionChanged
        ? await tx.query('DELETE FROM chat_embeddings')
        : await tx.query('DELETE FROM chat_embeddings WHERE model <> $1', [model]);
      if ((chatDel.rowCount ?? 0) > 0) await tx.query('UPDATE chat_threads SET search_synced_at = NULL');
      // p18-leftovers: the plans' vectors too.
      const planDel = regionChanged
        ? await tx.query('DELETE FROM chat_plan_embeddings')
        : await tx.query('DELETE FROM chat_plan_embeddings WHERE model <> $1', [model]);
      if ((planDel.rowCount ?? 0) > 0) await tx.query('UPDATE chat_plans SET search_synced_at = NULL');
      // p17-embeddings: work vectors (similar jobs, failures, automations) too; the related-work indexer rebuilds them.
      const workDel = regionChanged
        ? await tx.query('DELETE FROM work_embeddings')
        : await tx.query('DELETE FROM work_embeddings WHERE model <> $1', [model]);
      const removedVectors = (del.rowCount ?? 0) + (chatDel.rowCount ?? 0) + (workDel.rowCount ?? 0);
      if (modelChanged || beforeRegion !== region) {
        await tx.query(
          `INSERT INTO search_provider_state (name, model, region, changed_at) VALUES ('active', $1, $2, $3)
           ON CONFLICT (name) DO UPDATE
             SET model = EXCLUDED.model, region = EXCLUDED.region, changed_at = EXCLUDED.changed_at`,
          [model, region, this.clock()],
        );
      }
      const changed = (modelChanged && (before !== null || removedVectors > 0)) || regionChanged;
      if (changed) {
        await this.audit.record(
          {
            actor:
              actor === undefined
                ? { type: 'system', id: 'search-indexer' }
                : { type: 'user', id: actor.userId },
            action: 'context.search.provider_changed',
            target: 'search-provider',
            outcome: 'success',
            ...(actor === undefined ? {} : { ip: actor.ip ?? null, userAgent: actor.userAgent ?? null }),
            metadata: {
              before,
              after: model,
              ...(beforeRegion === null && region === null ? {} : { beforeRegion, afterRegion: region }),
              source: this.#meta.source,
              removedVectors,
            },
          },
          tx,
        );
      }
      return { changed, removedVectors };
    });
  }

  /**
   * Applies context deletion receipts after the stored cursor (p6-context-policy §4): delete / expire /
   * purge drop the document's vector, prune drops it when it was built from a pruned version. The cursor
   * advances in the same transaction as the deletions.
   */
  async applyReceipts(): Promise<{ receipts: number; removed: number }> {
    let total = 0;
    let removed = 0;
    for (;;) {
      const { rows } = await this.pool.query<{ receipt_cursor: string }>(
        `SELECT receipt_cursor::text FROM search_index_state WHERE name = 'context'`,
      );
      const cursor = rows[0]?.receipt_cursor ?? '0';
      const batch = await this.policy.receiptsSince(cursor, 500);
      if (batch.length === 0) break;
      await withTransaction(this.pool, async (tx) => {
        for (const r of batch) {
          const res =
            r.action === 'prune'
              ? await tx.query(
                  'DELETE FROM search_embeddings WHERE doc_id = $1 AND source_version = ANY($2::text[])',
                  [r.docId, r.versions.map(String)],
                )
              : await tx.query('DELETE FROM search_embeddings WHERE doc_id = $1', [r.docId]);
          removed += res.rowCount ?? 0;
        }
        const last = batch[batch.length - 1]?.id ?? cursor;
        await tx.query(
          `INSERT INTO search_index_state (name, receipt_cursor, updated_at) VALUES ('context', $1::bigint, $2)
           ON CONFLICT (name) DO UPDATE SET receipt_cursor = EXCLUDED.receipt_cursor, updated_at = EXCLUDED.updated_at
           WHERE search_index_state.receipt_cursor < EXCLUDED.receipt_cursor`,
          [last, this.clock()],
        );
      });
      total += batch.length;
      if (batch.length < 500) break;
    }
    return { receipts: total, removed };
  }

  private async store(
    embedder: Embedder,
    items: readonly {
      sourceType: 'context_doc' | 'job_summary';
      id: string;
      namespace: string;
      version: string;
      text: string;
    }[],
  ): Promise<{ indexed: number; skipped: number }> {
    const max = embedder.maxChars ?? MAX_EMBED_CHARS;
    const clean = items
      .map((i) => (i.text.length > max ? { ...i, text: clip(i.text, max) } : i))
      .filter((i) => i.text.trim().length > 0 && scanForSecrets({ text: i.text }).length === 0);
    const skipped = items.length - clean.length;
    let indexed = 0;
    for (let i = 0; i < clean.length; i += embedder.maxBatch) {
      const chunk = clean.slice(i, i + embedder.maxBatch);
      const vectors = await embedder.embed(
        chunk.map((c) => c.text),
        'document',
      );
      await withTransaction(this.pool, async (tx) => {
        for (const [k, c] of chunk.entries()) {
          const v = vectors[k];
          if (v === undefined) continue;
          const col = c.sourceType === 'context_doc' ? 'doc_id' : 'job_id';
          // The namespace may have been switched off while the provider answered: re-check under a share lock
          // on the consent row. setConsent holds it FOR UPDATE while it revokes and deletes, so either this
          // insert waits and sees `enabled = false`, or the revocation waits and deletes this vector too.
          const consent = await tx.query<{ enabled: boolean }>(
            'SELECT enabled FROM search_consent WHERE namespace = $1 FOR SHARE',
            [c.namespace],
          );
          if (consent.rows[0]?.enabled !== true) continue;
          const res = await tx.query(
            `INSERT INTO search_embeddings
               (source_type, ${col}, namespace, source_version, content_hash, model, dims, embedding, indexed_at)
             SELECT $1, $2, $3, $4, $5, $6, $7, $8::real[], $9
              WHERE EXISTS (SELECT 1 FROM search_consent WHERE namespace = $3 AND enabled)
             ON CONFLICT (${col}) WHERE ${col} IS NOT NULL DO UPDATE
               SET source_version = EXCLUDED.source_version, content_hash = EXCLUDED.content_hash,
                   model = EXCLUDED.model, dims = EXCLUDED.dims, embedding = EXCLUDED.embedding,
                   indexed_at = EXCLUDED.indexed_at`,
            [
              c.sourceType,
              c.id,
              c.namespace,
              c.version,
              contentHash(c.text),
              embedder.model,
              v.length,
              Array.from(v),
              this.clock(),
            ],
          );
          indexed += res.rowCount ?? 0;
        }
      });
    }
    return { indexed, skipped };
  }

  /** Current versions of live documents in consented namespaces whose vector is missing or outdated. */
  private async indexDocs(embedder: Embedder): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (;;) {
      const { rows } = await this.pool.query<{
        id: string;
        namespace: string;
        version: number;
        title: string;
        content: string;
      }>(
        `SELECT d.id, d.namespace, d.current_version AS version, v.title, v.content
           FROM context_documents d
           JOIN search_consent c ON c.namespace = d.namespace AND c.enabled
           JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
           LEFT JOIN search_embeddings e ON e.doc_id = d.id
          WHERE d.deleted_at IS NULL
            AND (e.id IS NULL OR e.source_version <> d.current_version::text OR e.model <> $1)
          ORDER BY d.updated_at, d.id
          LIMIT $2`,
        [embedder.model, SYNC_BATCH],
      );
      const fresh = rows.filter((r) => !seen.has(r.id));
      if (fresh.length === 0) break;
      for (const r of fresh) seen.add(r.id);
      const res = await this.store(
        embedder,
        fresh.map((r) => ({
          sourceType: 'context_doc' as const,
          id: r.id,
          namespace: r.namespace,
          version: String(r.version),
          text: docText(r.title, r.content),
        })),
      );
      indexed += res.indexed;
      skipped += res.skipped;
      if (rows.length < SYNC_BATCH) break;
    }
    return { indexed, skipped };
  }

  /** The latest result summary of each job of a consented project, when missing or outdated. */
  private async indexJobs(embedder: Embedder): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (;;) {
      const { rows } = await this.pool.query<{
        job_id: string;
        project: string;
        attempt_id: string;
        summary: string;
      }>(
        `SELECT s.job_id, s.project, s.attempt_id, s.summary
           FROM (
             SELECT DISTINCT ON (r.job_id) r.job_id, j.project, r.attempt_id::text AS attempt_id,
                    r.result->>'summary' AS summary
               FROM job_runs r
               JOIN jobs j ON j.id = r.job_id
               JOIN search_consent c ON c.namespace = 'project:' || j.project AND c.enabled
              WHERE r.result ? 'summary' AND jsonb_typeof(r.result->'summary') = 'string'
                AND length(r.result->>'summary') > 0
              ORDER BY r.job_id, r.result_received_at DESC NULLS LAST, r.created_at DESC
           ) s
           LEFT JOIN search_embeddings e ON e.job_id = s.job_id
          WHERE e.id IS NULL OR e.source_version <> s.attempt_id OR e.model <> $1
          ORDER BY s.job_id
          LIMIT $2`,
        [embedder.model, SYNC_BATCH],
      );
      const fresh = rows.filter((r) => !seen.has(r.job_id));
      if (fresh.length === 0) break;
      for (const r of fresh) seen.add(r.job_id);
      const res = await this.store(
        embedder,
        fresh.map((r) => ({
          sourceType: 'job_summary' as const,
          id: r.job_id,
          namespace: projectNamespace(r.project),
          version: r.attempt_id,
          text: clip(r.summary),
        })),
      );
      indexed += res.indexed;
      skipped += res.skipped;
      if (rows.length < SYNC_BATCH) break;
    }
    return { indexed, skipped };
  }

  // ------------------------------------------------------------------------------------- search

  /**
   * p10-semantic-defaults-chat: embeds a query for `userId` — a secret-looking query is never sent, the per-user
   * provider rate limit applies, a provider failure is a {@link SearchProviderError}. One call per search (project
   * search, chat search, and once per chat turn for the related-knowledge lookup, which reuses the vector).
   */
  async embedQuery(userId: string, query: string): Promise<Float32Array> {
    const embedder = this.#embedder;
    if (embedder === null) throw new SearchUnavailableError();
    const q = query.trim();
    // The query leaves the system (provider): never send a secret-looking one.
    if (scanForSecrets({ q }).length > 0) throw new SearchQueryRejectedError();
    if (!this.limiter.take(userId)) throw new SearchRateLimitedError();
    try {
      const [qv] = await embedder.embed(
        [clip(q, Math.min(embedder.maxChars ?? MAX_EMBED_CHARS, 2048))],
        'query',
      );
      if (qv === undefined) throw new Error('no vector');
      return qv;
    } catch {
      throw new SearchProviderError();
    }
  }

  /** p10-semantic-defaults-chat: whether `namespace` has capture on (no provider needed). */
  async captureOn(namespace: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM search_consent WHERE namespace = $1',
      [namespace],
    );
    return rows[0]?.enabled === true;
  }

  /**
   * Semantic search inside one project: its documents (document read role), the global documents granted
   * to it (account role) when `global` capture is on, its job summaries and (p10-semantic-defaults-chat) its
   * project-linked chat messages. Results are re-checked against the live rows, so a deleted or changed document
   * never appears from a stale vector.
   */
  async search(
    user: ContextActor,
    project: string,
    query: string,
    limit = 10,
    types?: readonly SearchHit['type'][],
  ): Promise<SearchHit[]> {
    const ns = projectNamespace(project);
    const role = roleIn(user, ns);
    if (role === null) throw new ContextForbiddenError('not_visible');
    if (this.#embedder === null) throw new SearchUnavailableError();
    const q = query.trim();
    if (q.length === 0 || q.length > MAX_QUERY_CHARS) {
      throw new InvalidContextInputError([{ field: 'q', code: q.length === 0 ? 'required' : 'too_long' }]);
    }
    const consent = await this.consent(this.pool, ns);
    if (!consent.enabled) throw new SearchNotEnabledError(ns);
    const qv = await this.embedQuery(user.id, q);
    return this.scoreProject(user, project, qv, { limit, types });
  }

  /**
   * Scores a project's sources against an already embedded query (the caller checked the project's capture). Chat
   * hits of `excludeThread` are left out (the related-knowledge lookup of a turn: that thread is already the
   * conversation). One hit per chat message (its best chunk).
   */
  async scoreProject(
    user: ContextActor,
    project: string,
    qv: Float32Array,
    opts: {
      readonly limit?: number | undefined;
      readonly types?: readonly SearchHit['type'][] | undefined;
      readonly excludeThread?: string | null | undefined;
    } = {},
  ): Promise<SearchHit[]> {
    const embedder = this.#embedder;
    const ns = projectNamespace(project);
    const role = roleIn(user, ns);
    if (embedder === null || role === null) return [];
    const types = opts.types;
    const { rows } = await this.pool.query<{
      kind: SearchHit['type'];
      id: string;
      namespace: string;
      version: string;
      read_role: Role | null;
      embedding: number[];
      extra: string | null;
    }>(
      `SELECT 'context_doc' AS kind, d.id::text AS id, d.namespace, e.source_version AS version,
              d.read_role, e.embedding, NULL::text AS extra
         FROM search_embeddings e
         JOIN context_documents d ON d.id = e.doc_id
        WHERE e.model = $1 AND d.deleted_at IS NULL AND e.source_version = d.current_version::text
          -- p11-memory-layers: superseded / expired / rejected records are history, not knowledge.
          AND NOT EXISTS (SELECT 1 FROM memory_records mr WHERE mr.doc_id = d.id
                            AND (mr.status <> 'active' OR mr.expires_at <= now()))
          AND (d.namespace = $2
               OR (d.namespace = 'global'
                   AND EXISTS (SELECT 1 FROM search_consent c WHERE c.namespace = 'global' AND c.enabled)
                   AND (d.project_scope = 'all'
                        OR (d.project_scope = 'listed' AND EXISTS (
                              SELECT 1 FROM context_doc_grants g WHERE g.doc_id = d.id AND g.project = $3)))))
       UNION ALL
       SELECT 'job_summary', e.job_id::text, e.namespace, e.source_version, NULL, e.embedding, NULL
         FROM search_embeddings e
         JOIN jobs j ON j.id = e.job_id
        WHERE e.model = $1 AND e.namespace = $2 AND j.project = $3
       UNION ALL
       SELECT 'chat_message', e.message_id::text, $2, e.chunk::text, NULL, e.embedding, e.attachment_id::text
         FROM chat_embeddings e
         JOIN chat_threads t ON t.id = e.thread_id
        WHERE e.scope = 'project' AND e.project = $3 AND e.model = $1
          AND ($5::uuid IS NULL OR e.thread_id <> $5::uuid)
          AND ${projectChatEligible('e.message_id', '$3')}
       LIMIT $4`,
      [embedder.model, ns, project, MAX_CANDIDATES, opts.excludeThread ?? null],
    );
    const best = new Map<string, (typeof rows)[number] & { score: number }>();
    for (const r of rows) {
      if (types !== undefined && !types.includes(r.kind)) continue;
      if (r.kind === 'context_doc') {
        const docRole = r.namespace === 'global' ? user.role : role;
        if (r.read_role === null || RANK[docRole] < RANK[r.read_role]) continue;
      }
      // jobs.read / chat in the project = viewer, as context.search.
      const score = cosine(qv, r.embedding);
      const key = `${r.kind}:${r.id}:${r.extra ?? ''}`;
      const prev = best.get(key);
      if (prev === undefined || score > prev.score) best.set(key, { ...r, score });
    }
    const scored = [...best.values()]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.min(Math.max(opts.limit ?? 10, 1), 50));
    return this.describe(user, scored);
  }

  /**
   * p10-semantic-memory: search with an optional keyword fallback (Context page, Outputs, chat `search_context`).
   * Semantic when a provider is configured and the project's capture is on; otherwise — or when the query looks like
   * a secret, the provider fails or the per-user provider limit is reached — keyword search over the same RBAC-scoped
   * sources, which never leaves the system. Without `fallback` the p6-vector contract (409/400/429/502) holds.
   */
  async find(
    user: ContextActor,
    project: string,
    query: string,
    opts: FindOptions = {},
  ): Promise<FindResult> {
    const limit = opts.limit ?? 10;
    try {
      return {
        mode: 'semantic',
        fallbackReason: null,
        items: await this.search(user, project, query, limit, opts.types),
      };
    } catch (err) {
      if (opts.fallback !== true) throw err;
      const reason: FallbackReason | null =
        err instanceof SearchUnavailableError
          ? 'unavailable'
          : err instanceof SearchNotEnabledError
            ? 'not_enabled'
            : err instanceof SearchQueryRejectedError
              ? 'query_rejected'
              : err instanceof SearchProviderError
                ? 'provider_error'
                : err instanceof SearchRateLimitedError
                  ? 'rate_limited'
                  : null;
      if (reason === null) throw err;
      return {
        mode: 'keyword',
        fallbackReason: reason,
        items: await this.keyword(user, project, query, limit, opts.types),
      };
    }
  }

  /**
   * p10-semantic-memory: keyword search (every term must occur in the title or text) over the project's live
   * documents, the global documents granted to it, its job summaries and (p10-semantic-defaults-chat) its shared
   * project-linked chat messages, with the same read-role rules as the semantic search. Nothing is sent anywhere.
   */
  async keyword(
    user: ContextActor,
    project: string,
    query: string,
    limit = 10,
    types?: readonly SearchHit['type'][],
    opts: { readonly excludeThread?: string | null | undefined } = {},
  ): Promise<SearchHit[]> {
    const ns = projectNamespace(project);
    const role = roleIn(user, ns);
    if (role === null) throw new ContextForbiddenError('not_visible');
    const q = query.trim();
    if (q.length === 0 || q.length > MAX_QUERY_CHARS) {
      throw new InvalidContextInputError([{ field: 'q', code: q.length === 0 ? 'required' : 'too_long' }]);
    }
    const terms = keywordTerms(q);
    if (terms.length === 0) return [];
    const patterns = terms.map(likeTerm);
    const wantDocs = types === undefined || types.includes('context_doc');
    const wantJobs = types === undefined || types.includes('job_summary');
    const wantChat = types === undefined || types.includes('chat_message');
    const out: (SearchHit & { readRole: Role | null })[] = [];
    if (wantDocs) {
      const { rows } = await this.pool.query<{
        id: string;
        namespace: string;
        version: string;
        read_role: Role;
        title: string;
        snippet: string;
        title_hits: number;
      }>(
        `SELECT d.id::text AS id, d.namespace, d.current_version::text AS version, d.read_role, v.title,
                left(v.content, $4) AS snippet,
                (SELECT count(*) FROM unnest($3::text[]) p WHERE v.title ILIKE p)::int AS title_hits
           FROM context_documents d
           JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
          WHERE d.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM memory_records mr WHERE mr.doc_id = d.id
                            AND (mr.status <> 'active' OR mr.expires_at <= now()))
            AND (d.namespace = $1
                 OR (d.namespace = 'global'
                     AND (d.project_scope = 'all'
                          OR (d.project_scope = 'listed' AND EXISTS (
                                SELECT 1 FROM context_doc_grants g WHERE g.doc_id = d.id AND g.project = $2)))))
            AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) p
                             WHERE NOT (v.title ILIKE p OR v.content ILIKE p))
          ORDER BY d.updated_at DESC
          LIMIT 500`,
        [ns, project, patterns, SNIPPET_CHARS],
      );
      for (const r of rows) {
        out.push({
          type: 'context_doc',
          id: r.id,
          namespace: r.namespace,
          title: r.title,
          snippet: r.snippet,
          version: r.version,
          score: Math.round(((1 + r.title_hits) / (1 + terms.length)) * 10_000) / 10_000,
          readRole: r.read_role,
        });
      }
    }
    if (wantJobs) {
      const { rows } = await this.pool.query<{ id: string; attempt: string; snippet: string }>(
        `SELECT s.job_id AS id, s.attempt_id AS attempt, left(s.summary, $3) AS snippet
           FROM (
             SELECT DISTINCT ON (r.job_id) r.job_id::text AS job_id, r.attempt_id::text AS attempt_id,
                    r.result->>'summary' AS summary, r.created_at
               FROM job_runs r JOIN jobs j ON j.id = r.job_id
              WHERE j.project = $1 AND r.result ? 'summary' AND jsonb_typeof(r.result->'summary') = 'string'
              ORDER BY r.job_id, r.result_received_at DESC NULLS LAST, r.created_at DESC
           ) s
          WHERE NOT EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE NOT (s.summary ILIKE p))
          ORDER BY s.created_at DESC
          LIMIT 200`,
        [project, patterns, SNIPPET_CHARS],
      );
      for (const r of rows) {
        out.push({
          type: 'job_summary',
          id: r.id,
          namespace: ns,
          title: `Job ${r.id.slice(0, 8)}`,
          snippet: r.snippet,
          version: r.attempt,
          score: Math.round((1 / (1 + terms.length)) * 10_000) / 10_000,
          readRole: null,
        });
      }
    }
    if (wantChat) {
      const { rows } = await this.pool.query<ChatRow>(
        `SELECT m.id::text AS id, m.seq, m.role, m.content, m.created_at, t.id::text AS thread_id,
                t.user_id::text AS owner_id, u.username
           FROM chat_message_links l
           JOIN chat_messages m ON m.id = l.message_id
           JOIN chat_threads t ON t.id = m.thread_id
           JOIN users u ON u.id = t.user_id
          WHERE l.project = $1 AND m.role IN ('user', 'assistant')
            AND ($3::uuid IS NULL OR t.id <> $3::uuid)
            AND ${projectChatEligible('m.id', '$1')}
            AND NOT EXISTS (SELECT 1 FROM unnest($2::text[]) p WHERE NOT (m.content ILIKE p))
          ORDER BY m.created_at DESC
          LIMIT 200`,
        [project, patterns, opts.excludeThread ?? null],
      );
      for (const r of rows) {
        out.push({
          ...chatHit(user, r, ns, keywordSnippet(r.content, terms)),
          score: Math.round((1 / (1 + terms.length)) * 10_000) / 10_000,
          readRole: null,
        });
      }
    }
    return out
      .filter((h) => {
        // Like the index (secret-scanned before embedding): a snippet with a secret-looking value is not shown.
        if (scanForSecrets({ title: h.title, snippet: h.snippet }).length > 0) return false;
        if (h.type !== 'context_doc') return true;
        const docRole = h.namespace === 'global' ? user.role : role;
        return h.readRole !== null && RANK[docRole] >= RANK[h.readRole];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(limit, 1), 50))
      .map(({ readRole: _r, ...hit }) => hit);
  }

  /**
   * p11-memory-layers: how relevant each indexed live document a job of `project` may receive (the project's and the
   * global ones) is to the job prompt — cosine of the prompt's query vector with each document's stored vector. Only
   * chooses which memories fit the bundle budget. Null when no provider is configured, the project's capture is off or
   * the prompt looks like it carries a secret (then nothing is sent and recency decides).
   */
  async promptRelevance(project: string, prompt: string): Promise<ReadonlyMap<string, number> | null> {
    const embedder = this.#embedder;
    if (embedder === null) return null;
    const ns = projectNamespace(project);
    const consent = await this.consent(this.pool, ns);
    if (!consent.enabled) return null;
    const text = clip(prompt.trim(), Math.min(embedder.maxChars ?? MAX_EMBED_CHARS, 2048));
    if (text === '' || scanForSecrets({ text }).length > 0) return null;
    const [qv] = await embedder.embed([text], 'query');
    if (qv === undefined) return null;
    const { rows } = await this.pool.query<{ id: string; embedding: number[] }>(
      `SELECT d.id::text AS id, e.embedding
         FROM search_embeddings e
         JOIN context_documents d ON d.id = e.doc_id
        WHERE e.model = $1 AND d.deleted_at IS NULL AND e.source_version = d.current_version::text
          AND (e.namespace = $2 OR e.namespace = 'global')
        LIMIT $3`,
      [embedder.model, ns, MAX_CANDIDATES],
    );
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.id, cosine(qv, r.embedding));
    return out;
  }

  /**
   * p10-semantic-memory: the most similar live document of a project for each text (memory-suggestion dedupe).
   * Null when no provider is configured or the project's capture is not consented — then nothing is sent and the
   * caller falls back to lexical dedupe. A text with a secret-looking value is never sent (its entry is null).
   */
  async similarDocs(
    project: string,
    texts: readonly string[],
  ): Promise<({ docId: string; score: number } | null)[] | null> {
    const embedded = await this.embedForProject(project, texts);
    if (embedded === null) return null;
    return this.nearestDocs(project, embedded);
  }

  /**
   * p17-auto-learning: the vectors of texts of a project (`document` purpose), with the same gates as every other
   * provider call — a provider configured and the project's search capture consented, empty and secret-looking texts
   * never sent (their slot is null). Null when the gates are closed.
   */
  async embedForProject(
    project: string,
    texts: readonly string[],
  ): Promise<{ model: string; vectors: (Float32Array | null)[] } | null> {
    const embedder = this.#embedder;
    if (embedder === null || texts.length === 0) return null;
    const consent = await this.consent(this.pool, projectNamespace(project));
    if (!consent.enabled) return null;
    const max = embedder.maxChars ?? MAX_EMBED_CHARS;
    const sendable = texts.map((t, i) => ({ i, text: clip(t, max) }));
    const clean = sendable.filter(
      (x) => x.text.trim().length > 0 && scanForSecrets({ text: x.text }).length === 0,
    );
    const vectors: (Float32Array | null)[] = texts.map(() => null);
    for (let k = 0; k < clean.length; k += embedder.maxBatch) {
      const chunk = clean.slice(k, k + embedder.maxBatch);
      const out = await embedder.embed(
        chunk.map((c) => c.text),
        'document',
      );
      chunk.forEach((c, j) => {
        const v = out[j];
        if (v !== undefined) vectors[c.i] = v;
      });
    }
    return { model: embedder.model, vectors };
  }

  /**
   * p17-memory-import: vectors of texts whose owner consented to sending them to the embedding provider for this one
   * comparison (the import's "compare by meaning" box) — never stored. The other gates are the usual ones: a provider
   * configured, empty and secret-looking texts never sent (their slot stays null). Null without a provider.
   */
  async embedConsented(
    texts: readonly string[],
  ): Promise<{ model: string; vectors: (Float32Array | null)[] } | null> {
    const embedder = this.#embedder;
    if (embedder === null || texts.length === 0) return null;
    const max = embedder.maxChars ?? MAX_EMBED_CHARS;
    const clean = texts
      .map((t, i) => ({ i, text: clip(t, max) }))
      .filter((x) => x.text.trim().length > 0 && scanForSecrets({ text: x.text }).length === 0);
    const vectors: (Float32Array | null)[] = texts.map(() => null);
    for (let k = 0; k < clean.length; k += embedder.maxBatch) {
      const chunk = clean.slice(k, k + embedder.maxBatch);
      const out = await embedder.embed(
        chunk.map((c) => c.text),
        'document',
      );
      chunk.forEach((c, j) => {
        const v = out[j];
        if (v !== undefined) vectors[c.i] = v;
      });
    }
    return { model: embedder.model, vectors };
  }

  /** p17-auto-learning: the most similar live, indexed document of the project for each vector (null stays null). */
  async nearestDocs(
    project: string,
    embedded: { readonly model: string; readonly vectors: readonly (ArrayLike<number> | null)[] },
  ): Promise<({ docId: string; score: number } | null)[]> {
    const { rows } = await this.pool.query<{ id: string; embedding: number[] }>(
      `SELECT d.id::text AS id, e.embedding
         FROM search_embeddings e
         JOIN context_documents d ON d.id = e.doc_id
        WHERE e.model = $1 AND e.namespace = $2 AND d.deleted_at IS NULL
          AND e.source_version = d.current_version::text
        LIMIT $3`,
      [embedded.model, projectNamespace(project), MAX_CANDIDATES],
    );
    return embedded.vectors.map((v) => {
      if (v === null) return null;
      let best: { docId: string; score: number } | null = null;
      for (const r of rows) {
        const score = cosine(v, r.embedding);
        if (best === null || score > best.score) best = { docId: r.id, score };
      }
      return best;
    });
  }

  private async describe(
    user: ContextActor,
    hits: readonly {
      kind: SearchHit['type'];
      id: string;
      namespace: string;
      version: string;
      score: number;
      extra: string | null;
    }[],
  ): Promise<SearchHit[]> {
    const docIds = hits.filter((h) => h.kind === 'context_doc').map((h) => h.id);
    const jobIds = hits.filter((h) => h.kind === 'job_summary').map((h) => h.id);
    const chatIds = hits.filter((h) => h.kind === 'chat_message').map((h) => h.id);
    const attIds = hits.flatMap((h) => (h.kind === 'chat_message' && h.extra !== null ? [h.extra] : []));
    const docs = new Map<string, { title: string; snippet: string }>();
    const jobs = new Map<string, { title: string; snippet: string }>();
    const chats = new Map<string, ChatRow>();
    const atts = new Map<string, { name: string; text: string }>();
    if (docIds.length > 0) {
      const { rows } = await this.pool.query<{
        id: string;
        title: string;
        snippet: string;
        record_type: string | null;
      }>(
        `SELECT d.id::text AS id, v.title, left(v.content, $2) AS snippet, mr.type AS record_type
           FROM context_documents d
           JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
           LEFT JOIN memory_records mr ON mr.doc_id = d.id
          WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL`,
        [docIds, SNIPPET_CHARS],
      );
      for (const r of rows) {
        docs.set(r.id, {
          // p11-memory-layers: a typed record says what it is ("[decision] …").
          title: r.record_type === null ? r.title : `[${r.record_type}] ${r.title}`,
          snippet: r.snippet,
        });
      }
    }
    if (jobIds.length > 0) {
      const { rows } = await this.pool.query<{ id: string; attempt: string; snippet: string | null }>(
        `SELECT r.job_id::text AS id, r.attempt_id::text AS attempt, left(r.result->>'summary', $2) AS snippet
           FROM job_runs r WHERE r.job_id = ANY($1::uuid[])`,
        [jobIds, SNIPPET_CHARS],
      );
      for (const r of rows) {
        if (r.snippet !== null)
          jobs.set(`${r.id}/${r.attempt}`, { title: `Job ${r.id.slice(0, 8)}`, snippet: r.snippet });
      }
    }
    if (chatIds.length > 0) {
      const { rows } = await this.pool.query<ChatRow>(
        `SELECT m.id::text AS id, m.seq, m.role, m.content, m.created_at, t.id::text AS thread_id,
                t.user_id::text AS owner_id, u.username
           FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id JOIN users u ON u.id = t.user_id
          WHERE m.id = ANY($1::uuid[])`,
        [chatIds],
      );
      for (const r of rows) chats.set(r.id, r);
    }
    if (attIds.length > 0) {
      const { rows } = await this.pool.query<{
        id: string;
        name: string;
        content: Buffer | null;
        blob_key: string | null;
      }>(
        `SELECT id::text AS id, name, content, blob_key FROM chat_attachments
          WHERE id = ANY($1::uuid[]) AND kind = 'text'`,
        [attIds],
      );
      for (const r of rows) {
        const bytes = await rowContent(r).catch(() => null);
        if (bytes !== null) atts.set(r.id, { name: r.name, text: bytes.toString('utf8') });
      }
    }
    const out: SearchHit[] = [];
    for (const h of hits) {
      if (h.kind === 'chat_message') {
        const c = chats.get(h.id);
        if (c === undefined) continue; // deleted between scoring and description
        const att = h.extra === null ? null : (atts.get(h.extra) ?? null);
        if (h.extra !== null && att === null) continue;
        const chunk = Number.parseInt(h.version, 10);
        const hit = chatHit(user, c, h.namespace, chatSnippet(att?.text ?? c.content, chunk));
        out.push({
          ...hit,
          ...(att === null ? {} : { title: `${hit.title} · ${att.name}` }),
          score: Math.round(h.score * 10_000) / 10_000,
        });
        continue;
      }
      const d = h.kind === 'context_doc' ? docs.get(h.id) : jobs.get(`${h.id}/${h.version}`);
      if (d === undefined) continue; // deleted between scoring and description
      out.push({
        type: h.kind,
        id: h.id,
        namespace: h.namespace,
        title: d.title,
        snippet: d.snippet,
        version: h.version,
        score: Math.round(h.score * 10_000) / 10_000,
      });
    }
    return out;
  }
}

/** A chat message row as the project search reads it. */
interface ChatRow {
  id: string;
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: Date;
  thread_id: string;
  owner_id: string;
  username: string;
}

/** p10-semantic-defaults-chat: a project-linked chat message as a search hit (the thread id only for its owner). */
function chatHit(user: ContextActor, r: ChatRow, namespace: string, snippet: string): SearchHit {
  return {
    type: 'chat_message',
    id: r.id,
    namespace,
    title: `Conversation of ${r.username}`,
    snippet,
    version: String(r.seq),
    score: 0,
    chat: {
      author: r.role,
      ownerName: r.username,
      seq: r.seq,
      at: r.created_at.toISOString(),
      threadId: r.owner_id === user.id ? r.thread_id : null,
    },
  };
}
