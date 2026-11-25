import { createHash, randomUUID } from 'node:crypto';
import {
  BITBUCKET_API_URL,
  GITLAB_COM_URL,
  type GitHostConnectionInput,
  type GitHostConnectionPatch,
  type GitHostConnectionView,
  type GitHostKind,
  type GitHostRepository,
  type GitHostTestResult,
  type GitHostTokenKind,
  gitHostBaseUrlProblem,
  gitHostScopeProblem,
  gitHostWebHost,
  GIT_HOST_PUSH_USERNAME,
  normalizeGitHostBaseUrl,
} from '@remyral/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { AuditRecorder } from '../audit/audit.js';
import { SecretBox } from '../auth/secret-box.js';
import { type Queryable, withTransaction } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  type CreatedRepository,
  createHostRepository,
  HostApiError,
  type HostTarget,
  type HostTokenFacts,
  listHostRepositories,
  rotateGitLabToken,
  testHostToken,
} from './git-host-api.js';
import type { FetchFn } from './github-app.js';
import { ProviderError } from './types.js';

/**
 * p16-git-providers (ADR-0061, docs/design/p16-git-providers.md §2): Ayarlar → Entegrasyonlar → GitLab / Bitbucket.
 *
 * - A connection holds an API token (the master's merge requests, checks, merges) and optionally a separate push-only
 *   token (what workers get, job-scoped, over JOB_CREDENTIAL). Both are AES-256-GCM encrypted at rest (HKDF sub-key
 *   `git-host`, AAD `git-host:<id>`), never returned, logged or audited, never put into a model's context.
 * - Saving runs the connection test: a token the host refuses, or one that does not reach its scope, is not stored.
 * - GitLab reports a token's expiry (`personal_access_tokens/self`); Bitbucket does not — the admin may enter it. Both
 *   dates feed the ops-safety expiry list. GitLab tokens with `api` / `self_rotate` rotate through the host API.
 */

export interface GitHostServiceDeps {
  readonly pool: pg.Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** The master SecretBox (its `deriveKey('git-host')` keys this store). */
  readonly box: SecretBox;
  readonly log?: Pick<FastifyBaseLogger, 'warn'>;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  /** How long decrypted tokens stay cached in memory (default 15 s; a rotation elsewhere is seen within it). */
  readonly cacheMs?: number;
}

export interface GitHostActor {
  readonly userId: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

interface Row {
  id: string;
  kind: GitHostKind;
  label: string;
  base_url: string;
  web_host: string;
  token_kind: GitHostTokenKind;
  scope: string;
  secrets: Buffer;
  token_fingerprint: string;
  push_token_fingerprint: string | null;
  expires_at: Date | null;
  push_expires_at: Date | null;
  remote_token_id: string | null;
  token_updated_at: Date;
  last_test: Record<string, unknown> | null;
  last_test_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface Secrets {
  readonly token: string;
  readonly pushToken?: string;
}

/** A worker push credential (HTTPS basic: username + token). */
export interface HostPushCredential {
  readonly token: string;
  readonly username: string;
  readonly expiresAt: Date;
}

/** The connection facts a provider needs (no secret). */
export interface HostConnectionRef extends HostTarget {
  readonly id: string;
  readonly webHost: string;
  readonly version: number;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 12);

function bad(code: string, message: string, reason?: string): HttpError {
  return new HttpError(422, code, message, {}, {}, reason === undefined ? {} : { reason });
}

const concurrentChange = (): HttpError =>
  new HttpError(
    409,
    'conflict',
    'The connection changed concurrently. Reload and try again.',
    {},
    {},
    { reason: 'git_host' },
  );

const unreachable = (status = 503): HttpError =>
  new HttpError(status, 'git_host_unreachable', 'The host could not be reached.');

function gitlabDate(raw: string | null): Date | null {
  if (raw === null || raw === '') return null;
  // GitLab answers a date (`2027-01-31`): the token stops working at the end of that day (UTC).
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59Z` : raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function testJson(f: HostTokenFacts, at: Date): GitHostTestResult {
  return {
    ok: f.ok,
    code: f.code.slice(0, 64),
    detail: f.detail,
    tokenName: f.tokenName,
    scopes: [...f.scopes].slice(0, 32),
    expiresAt: f.expiresAt,
    missingScopes: [...f.missingScopes].slice(0, 32),
    checkedAt: at.toISOString(),
  };
}

const TEST_MESSAGES: Readonly<Record<string, string>> = {
  unauthorized: 'The host refused the token (wrong, expired or revoked).',
  forbidden: 'The token is valid but may not read its scope.',
  not_found: 'The host does not know the token or its scope.',
  scope_mismatch: 'The token does not reach the project, group, repository or workspace given as its scope.',
  missing_scopes: 'The token lacks a scope the git flow needs.',
  inactive: 'The token is revoked or inactive.',
  unreachable: 'The host could not be reached.',
};

export class GitHostService {
  readonly #box: SecretBox;
  readonly #cache = new Map<string, { at: number; version: number; secrets: Secrets }>();

  constructor(private readonly deps: GitHostServiceDeps) {
    this.#box = new SecretBox(deps.box.deriveKey('git-host'));
  }

  // ------------------------------------------------------------------------------------------------ reading

  async list(): Promise<GitHostConnectionView[]> {
    const { rows } = await this.deps.pool.query<Row>(
      'SELECT * FROM git_host_connections ORDER BY lower(label)',
    );
    const used = await this.#projectsByConnection();
    return rows.map((r) => this.#view(r, used.get(r.id) ?? []));
  }

  async get(id: string, db: Queryable = this.deps.pool): Promise<GitHostConnectionView> {
    const r = await this.#row(id, db);
    const used = await this.#projectsByConnection(db, id);
    return this.#view(r, used.get(id) ?? []);
  }

  /** The non-secret facts a provider / config check needs. */
  async ref(id: string, db: Queryable = this.deps.pool): Promise<HostConnectionRef> {
    const r = await this.#row(id, db);
    return this.#ref(r);
  }

  #ref(r: Row): HostConnectionRef {
    return {
      id: r.id,
      kind: r.kind,
      baseUrl: r.base_url,
      webHost: r.web_host,
      tokenKind: r.token_kind,
      scope: r.scope,
      version: r.version,
    };
  }

  /** The API token (master use only: providers, repository listing). */
  async apiToken(id: string): Promise<string> {
    return (await this.#secrets(id)).token;
  }

  /**
   * A worker push credential: the push-only token when one is stored, else the API token (ADR-0061 §2). Read on every
   * request (cached briefly): a rotated token reaches the next fetch / push.
   */
  async pushCredential(id: string): Promise<HostPushCredential | null> {
    const r = await this.#row(id).catch(() => null);
    if (r === null) return null;
    let s: Secrets;
    try {
      s = await this.#secrets(id, r);
    } catch {
      return null;
    }
    const separate = s.pushToken !== undefined;
    const expires = separate ? r.push_expires_at : r.expires_at;
    const now = this.deps.clock();
    if (expires !== null && expires.getTime() <= now.getTime()) return null;
    // The worker treats the credential as short-lived: it asks again before the next fetch / push.
    const oneHour = new Date(now.getTime() + 3_600_000);
    return {
      token: separate ? (s.pushToken ?? s.token) : s.token,
      username: GIT_HOST_PUSH_USERNAME[r.kind],
      expiresAt: expires !== null && expires < oneHour ? expires : oneHour,
    };
  }

  async #secrets(id: string, known?: Row): Promise<Secrets> {
    const now = this.deps.clock().getTime();
    const hit = this.#cache.get(id);
    const r = known ?? (await this.#row(id));
    if (hit !== undefined && hit.version === r.version && now - hit.at < (this.deps.cacheMs ?? 15_000)) {
      return hit.secrets;
    }
    const secrets = this.#decrypt(r);
    this.#cache.set(id, { at: now, version: r.version, secrets });
    return secrets;
  }

  // ------------------------------------------------------------------------------------------------ writing

  /** Validates the non-secret fields and returns the normalised target. */
  #target(input: {
    kind: GitHostKind;
    baseUrl?: string | undefined;
    tokenKind: GitHostTokenKind;
    scope: string;
  }): {
    target: HostTarget;
    webHost: string;
  } {
    const raw =
      input.kind === 'bitbucket' ? BITBUCKET_API_URL : (input.baseUrl ?? '').trim() || GITLAB_COM_URL;
    const urlProblem = gitHostBaseUrlProblem(input.kind, raw);
    if (urlProblem !== null) {
      throw bad(
        'git_host_invalid',
        'The host address is not valid: https only, without credentials, query or /api path; Bitbucket is Cloud only.',
        'url',
      );
    }
    const scope = input.scope.trim().replace(/^\/+|\/+$/g, '');
    const scopeProblem = gitHostScopeProblem(input.kind, input.tokenKind, scope);
    if (scopeProblem !== null) {
      throw bad('git_host_invalid', 'The token kind and its scope do not fit together.', 'scope');
    }
    const baseUrl = normalizeGitHostBaseUrl(raw);
    return {
      target: { kind: input.kind, baseUrl, tokenKind: input.tokenKind, scope },
      webHost: gitHostWebHost(input.kind, baseUrl),
    };
  }

  /** Tests the API token, then the push token; `pushExpiresAt`: what GitLab reports for the push token. */
  async #test(
    target: HostTarget,
    token: string,
    push: string | undefined,
  ): Promise<HostTokenFacts & { readonly pushExpiresAt?: string | null }> {
    const f = await testHostToken(target, token, 'api', this.deps.fetch, this.deps.timeoutMs);
    if (!f.ok || push === undefined) return f;
    const p = await testHostToken(target, push, 'push', this.deps.fetch, this.deps.timeoutMs);
    return p.ok
      ? { ...f, pushExpiresAt: p.expiresAt }
      : { ...p, code: `push_${p.code}`.slice(0, 64), detail: p.detail ?? 'push token' };
  }

  /** The push token's expiry: GitLab's own answer, else what the admin entered. */
  #pushExpiry(
    kind: GitHostKind,
    facts: { readonly pushExpiresAt?: string | null },
    entered: Date | null,
  ): Date | null {
    return kind === 'gitlab' ? (gitlabDate(facts.pushExpiresAt ?? null) ?? entered) : entered;
  }

  #refuse(f: HostTokenFacts): never {
    const base = f.code.replace(/^push_/, '');
    const what = f.code.startsWith('push_') ? 'Push token: ' : '';
    throw new HttpError(
      422,
      'git_host_test_failed',
      `${what}${TEST_MESSAGES[base] ?? `The connection test failed (${f.code}).`}`,
      {},
      { test: testJson(f, this.deps.clock()) },
      { reason: what !== '' ? 'push' : base in TEST_MESSAGES ? base : 'other' },
    );
  }

  /** "Bağlantıyı test et" before saving: nothing is stored. */
  async testDraft(input: GitHostConnectionInput): Promise<GitHostTestResult> {
    const { target } = this.#target(input);
    return testJson(await this.#test(target, input.token, input.pushToken), this.deps.clock());
  }

  async create(actor: GitHostActor, input: GitHostConnectionInput): Promise<GitHostConnectionView> {
    const { target, webHost } = this.#target(input);
    const facts = await this.#test(target, input.token, input.pushToken);
    if (!facts.ok) this.#refuse(facts);
    const id = randomUUID();
    const now = this.deps.clock();
    const secrets: Secrets = {
      token: input.token,
      ...(input.pushToken === undefined ? {} : { pushToken: input.pushToken }),
    };
    const expiresAt =
      target.kind === 'gitlab'
        ? (gitlabDate(facts.expiresAt) ?? this.#date(input.expiresAt))
        : this.#date(input.expiresAt);
    return withTransaction(this.deps.pool, async (tx) => {
      const dup = await tx.query('SELECT 1 FROM git_host_connections WHERE lower(label) = lower($1)', [
        input.label.trim(),
      ]);
      if ((dup.rowCount ?? 0) > 0)
        throw new HttpError(409, 'git_host_label_taken', 'A connection with this name exists.');
      await tx.query(
        `INSERT INTO git_host_connections (id, kind, label, base_url, web_host, token_kind, scope, secrets,
           token_fingerprint, push_token_fingerprint, expires_at, push_expires_at, remote_token_id, token_updated_at,
           last_test, last_test_at, version, created_by, created_at, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $14, 1, $16, $14, $16, $14)`,
        [
          id,
          target.kind,
          input.label.trim(),
          target.baseUrl,
          webHost,
          target.tokenKind,
          target.scope,
          this.#encrypt(id, secrets),
          fingerprint(input.token),
          input.pushToken === undefined ? null : fingerprint(input.pushToken),
          expiresAt,
          input.pushToken === undefined
            ? null
            : this.#pushExpiry(target.kind, facts, this.#date(input.pushExpiresAt)),
          facts.remoteId,
          now,
          testJson(facts, now),
          actor.userId,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'git_host.connect',
          target: `git_host:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            kind: target.kind,
            label: input.label.trim(),
            host: webHost,
            tokenKind: target.tokenKind,
            scope: target.scope,
            tokenFingerprint: fingerprint(input.token),
            separatePushToken: input.pushToken !== undefined,
          },
        },
        tx,
      );
      return this.get(id, tx);
    });
  }

  async update(
    actor: GitHostActor,
    id: string,
    patch: GitHostConnectionPatch,
  ): Promise<GitHostConnectionView> {
    const current = await this.#row(id);
    if (current.version !== patch.expectedVersion) {
      throw concurrentChange();
    }
    const old = this.#decryptOrNull(current);
    if (old === null && patch.token === undefined) {
      throw bad('git_host_token_required', 'The stored token can no longer be read; enter the token again.');
    }
    const token = patch.token ?? old?.token ?? '';
    const pushToken = patch.pushToken === null ? undefined : (patch.pushToken ?? old?.pushToken);
    const tokenChanged = patch.token !== undefined || patch.pushToken !== undefined;
    const target = this.#ref(current);
    let facts: (HostTokenFacts & { readonly pushExpiresAt?: string | null }) | null = null;
    if (tokenChanged) {
      facts = await this.#test(target, token, pushToken);
      if (!facts.ok) this.#refuse(facts);
    }
    const now = this.deps.clock();
    const expiresAt =
      patch.expiresAt !== undefined
        ? this.#date(patch.expiresAt ?? undefined)
        : facts !== null && current.kind === 'gitlab'
          ? gitlabDate(facts.expiresAt)
          : patch.token !== undefined
            ? null
            : current.expires_at;
    const pushExpiresAt =
      pushToken === undefined
        ? null
        : patch.pushExpiresAt !== undefined
          ? this.#date(patch.pushExpiresAt ?? undefined)
          : patch.pushToken !== undefined
            ? this.#pushExpiry(current.kind, facts ?? {}, null)
            : current.push_expires_at;
    return withTransaction(this.deps.pool, async (tx) => {
      const label = patch.label?.trim() ?? current.label;
      if (label.toLowerCase() !== current.label.toLowerCase()) {
        const dup = await tx.query(
          'SELECT 1 FROM git_host_connections WHERE lower(label) = lower($1) AND id <> $2',
          [label, id],
        );
        if ((dup.rowCount ?? 0) > 0)
          throw new HttpError(409, 'git_host_label_taken', 'A connection with this name exists.');
      }
      const res = await tx.query(
        `UPDATE git_host_connections SET label = $3, secrets = $4, token_fingerprint = $5, push_token_fingerprint = $6,
                expires_at = $7, push_expires_at = $8, remote_token_id = COALESCE($9, remote_token_id),
                token_updated_at = $10, last_test = COALESCE($11, last_test),
                last_test_at = CASE WHEN $11::jsonb IS NULL THEN last_test_at ELSE $12 END,
                version = version + 1, updated_by = $13, updated_at = $12
          WHERE id = $1 AND version = $2`,
        [
          id,
          patch.expectedVersion,
          label,
          this.#encrypt(id, { token, ...(pushToken === undefined ? {} : { pushToken }) }),
          fingerprint(token),
          pushToken === undefined ? null : fingerprint(pushToken),
          expiresAt,
          pushExpiresAt,
          facts?.remoteId ?? null,
          tokenChanged ? now : current.token_updated_at,
          facts === null ? null : testJson(facts, now),
          now,
          actor.userId,
        ],
      );
      if (res.rowCount !== 1) throw concurrentChange();
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: tokenChanged ? 'git_host.token.replace' : 'git_host.update',
          target: `git_host:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            kind: current.kind,
            label,
            tokenReplaced: patch.token !== undefined,
            pushToken:
              patch.pushToken === undefined ? 'unchanged' : patch.pushToken === null ? 'removed' : 'replaced',
            tokenFingerprint: fingerprint(token),
            expiresAt: iso(expiresAt),
          },
        },
        tx,
      );
      this.#cache.delete(id);
      return this.get(id, tx);
    });
  }

  async remove(actor: GitHostActor, id: string): Promise<void> {
    await withTransaction(this.deps.pool, async (tx) => {
      const r = await this.#row(id, tx);
      const used = await tx.query<{ project: string }>(
        'SELECT project FROM project_git_configs WHERE host_connection_id = $1 ORDER BY project',
        [id],
      );
      if (used.rows.length > 0) {
        throw new HttpError(
          409,
          'git_host_in_use',
          `Projects still use this connection: ${used.rows.map((p) => p.project).join(', ')}.`,
          {},
          {},
          {
            projects: used.rows
              .map((p) => p.project)
              .join(', ')
              .slice(0, 200),
          },
        );
      }
      await tx.query('DELETE FROM git_host_connections WHERE id = $1', [id]);
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'git_host.disconnect',
          target: `git_host:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: { kind: r.kind, label: r.label, tokenFingerprint: r.token_fingerprint },
        },
        tx,
      );
    });
    this.#cache.delete(id);
  }

  /** Re-tests a stored connection and records the result (and GitLab's current expiry). */
  async test(id: string): Promise<GitHostTestResult> {
    const r = await this.#row(id);
    const now = this.deps.clock();
    const s = this.#decryptOrNull(r);
    const facts: HostTokenFacts & { readonly pushExpiresAt?: string | null } =
      s === null
        ? {
            ok: false,
            code: 'undecryptable',
            detail: 'the master key changed',
            tokenName: null,
            scopes: [],
            expiresAt: null,
            missingScopes: [],
            remoteId: null,
          }
        : await this.#test(this.#ref(r), s.token, s.pushToken);
    const gitlab = r.kind === 'gitlab' && facts.ok;
    const pushExpiry = gitlabDate(facts.pushExpiresAt ?? null);
    await this.deps.pool.query(
      `UPDATE git_host_connections SET last_test = $2, last_test_at = $3,
              expires_at = CASE WHEN $4::boolean THEN $5 ELSE expires_at END,
              push_expires_at = CASE WHEN $4::boolean AND $6::timestamptz IS NOT NULL THEN $6 ELSE push_expires_at END
        WHERE id = $1`,
      [id, testJson(facts, now), now, gitlab, gitlab ? gitlabDate(facts.expiresAt) : null, pushExpiry],
    );
    return testJson(facts, now);
  }

  /**
   * GitLab self-rotation: a new API token with a new expiry (default 90 days, at most 365), the old one revoked by
   * GitLab at once. The push token (when separate) is not rotated here (a push-only token cannot rotate itself).
   */
  async rotate(actor: GitHostActor, id: string, days = 90): Promise<GitHostConnectionView> {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw bad('git_host_invalid', 'Choose 1 to 365 days for the new token.', 'rotation_days');
    }
    const r = await this.#row(id);
    if (r.kind !== 'gitlab') {
      throw new HttpError(
        409,
        'git_host_not_rotatable',
        'Bitbucket tokens cannot be rotated through the API: create a new token and enter it.',
      );
    }
    const s = this.#decryptOrNull(r);
    if (s === null)
      throw bad('git_host_token_required', 'The stored token can no longer be read; enter the token again.');
    const expires = new Date(this.deps.clock().getTime() + days * 86_400_000).toISOString().slice(0, 10);
    let next: Awaited<ReturnType<typeof rotateGitLabToken>>;
    try {
      next = await rotateGitLabToken(this.#ref(r), s.token, expires, this.deps.fetch, this.deps.timeoutMs);
    } catch (err) {
      if (err instanceof HostApiError) {
        throw new HttpError(
          err.code === 'forbidden' ? 409 : 422,
          'git_host_rotation_failed',
          err.message,
          {},
          {},
          { reason: err.code },
        );
      }
      if (err instanceof ProviderError) throw unreachable();
      throw err;
    }
    const now = this.deps.clock();
    await withTransaction(this.deps.pool, async (tx) => {
      // The old token is already dead on GitLab: store the new one even if someone edited the label meanwhile.
      await tx.query(
        `UPDATE git_host_connections SET secrets = $2, token_fingerprint = $3, expires_at = $4,
                remote_token_id = COALESCE($5, remote_token_id), token_updated_at = $6, version = version + 1,
                updated_by = $7, updated_at = $6
          WHERE id = $1`,
        [
          id,
          this.#encrypt(id, {
            token: next.token,
            ...(s.pushToken === undefined ? {} : { pushToken: s.pushToken }),
          }),
          fingerprint(next.token),
          gitlabDate(next.expiresAt),
          next.remoteId,
          now,
          actor.userId,
        ],
      );
      await this.deps.audit.record(
        {
          actor: { type: 'user', id: actor.userId },
          action: 'git_host.token.rotate',
          target: `git_host:${id}`,
          outcome: 'success',
          ip: actor.ip ?? null,
          userAgent: actor.userAgent ?? null,
          metadata: {
            kind: r.kind,
            label: r.label,
            previousFingerprint: r.token_fingerprint,
            tokenFingerprint: fingerprint(next.token),
            expiresAt: next.expiresAt,
          },
        },
        tx,
      );
    });
    this.#cache.delete(id);
    return this.get(id);
  }

  async repositories(id: string, q = ''): Promise<GitHostRepository[]> {
    const r = await this.#row(id);
    try {
      return await listHostRepositories(
        this.#ref(r),
        await this.apiToken(id),
        q,
        this.deps.fetch,
        this.deps.timeoutMs,
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        this.deps.log?.warn(
          { connection: id, err: err.message.slice(0, 200) },
          'git host: repository listing failed',
        );
        throw unreachable(err.transient ? 503 : 502);
      }
      throw err;
    }
  }

  async createRepository(
    actor: GitHostActor,
    id: string,
    input: {
      readonly name: string;
      readonly description?: string;
      readonly private: boolean;
      readonly namespace?: string;
    },
  ): Promise<CreatedRepository> {
    const r = await this.#row(id);
    let out: CreatedRepository;
    try {
      out = await createHostRepository(
        this.#ref(r),
        await this.apiToken(id),
        input,
        this.deps.fetch,
        this.deps.timeoutMs,
      );
    } catch (err) {
      if (err instanceof HostApiError) {
        const status =
          err.code === 'exists' ? 409 : err.code === 'forbidden' || err.code === 'not_supported' ? 409 : 422;
        throw new HttpError(status, 'git_host_repo_refused', err.message, {}, {}, { reason: err.code });
      }
      if (err instanceof ProviderError) throw unreachable();
      throw err;
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'git_host.repository.create',
      target: `git_host:${id}`,
      outcome: 'success',
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      metadata: { kind: r.kind, repository: out.fullPath, created: out.created, private: out.private },
    });
    return out;
  }

  /** ops-safety background pass: GitLab connections whose last test is older than `everyMs` are re-tested. */
  async refreshExpiries(everyMs: number, force = false): Promise<string[]> {
    const now = this.deps.clock().getTime();
    const { rows } = await this.deps.pool.query<{ id: string; last_test_at: Date | null }>(
      "SELECT id, last_test_at FROM git_host_connections WHERE kind = 'gitlab'",
    );
    const checked: string[] = [];
    for (const r of rows) {
      if (!force && r.last_test_at !== null && now - r.last_test_at.getTime() < everyMs) continue;
      try {
        await this.test(r.id);
        checked.push(`githost:${r.id.replaceAll('-', '')}`);
      } catch (err) {
        this.deps.log?.warn(
          { connection: r.id, err: err instanceof Error ? err.message.slice(0, 200) : 'error' },
          'git host: expiry check failed',
        );
      }
    }
    return checked;
  }

  // ------------------------------------------------------------------------------------------------ helpers

  #date(raw: string | undefined): Date | null {
    if (raw === undefined) return null;
    const d = new Date(raw);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  async #row(id: string, db: Queryable = this.deps.pool): Promise<Row> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new HttpError(404, 'git_host_not_found', 'No such git host connection.');
    const { rows } = await db.query<Row>('SELECT * FROM git_host_connections WHERE id = $1', [id]);
    const r = rows[0];
    if (r === undefined) throw new HttpError(404, 'git_host_not_found', 'No such git host connection.');
    return r;
  }

  async #projectsByConnection(db: Queryable = this.deps.pool, only?: string): Promise<Map<string, string[]>> {
    const { rows } = await db.query<{ host_connection_id: string; project: string }>(
      `SELECT host_connection_id, project FROM project_git_configs
        WHERE host_connection_id IS NOT NULL ${only === undefined ? '' : 'AND host_connection_id = $1'}
        ORDER BY project`,
      only === undefined ? [] : [only],
    );
    const out = new Map<string, string[]>();
    for (const r of rows)
      out.set(r.host_connection_id, [...(out.get(r.host_connection_id) ?? []), r.project]);
    return out;
  }

  #view(r: Row, projects: readonly string[]): GitHostConnectionView {
    const usable = this.#decryptOrNull(r) !== null;
    const last = r.last_test;
    const scopes = Array.isArray(last?.scopes)
      ? (last.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    return {
      id: r.id,
      kind: r.kind,
      label: r.label,
      baseUrl: r.base_url,
      webHost: r.web_host,
      tokenKind: r.token_kind,
      scope: r.scope,
      tokenFingerprint: r.token_fingerprint,
      pushTokenFingerprint: r.push_token_fingerprint,
      separatePushToken: r.push_token_fingerprint !== null,
      expiresAt: iso(r.expires_at),
      pushExpiresAt: iso(r.push_expires_at),
      rotatable: r.kind === 'gitlab' && (scopes.includes('api') || scopes.includes('self_rotate')),
      tokenUpdatedAt: r.token_updated_at.toISOString(),
      lastTest: last === null ? null : (last as unknown as GitHostTestResult),
      usable,
      projects: [...projects],
      version: r.version,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    };
  }

  #encrypt(id: string, s: Secrets): Buffer {
    return this.#box.encrypt(Buffer.from(JSON.stringify(s), 'utf8'), `git-host:${id}`);
  }

  #decrypt(r: Row): Secrets {
    const raw = JSON.parse(this.#box.decrypt(r.secrets, `git-host:${r.id}`).toString('utf8')) as unknown;
    const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    if (typeof o.token !== 'string') throw new Error('stored git host token is malformed');
    return { token: o.token, ...(typeof o.pushToken === 'string' ? { pushToken: o.pushToken } : {}) };
  }

  #decryptOrNull(r: Row): Secrets | null {
    try {
      return this.#decrypt(r);
    } catch {
      return null;
    }
  }
}
