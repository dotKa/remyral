import { DEFAULT_RULES, Redactor, redactDeep } from '@remyral/observability';
import {
  CREDENTIAL_TOKEN_NAME,
  credentialTokenNames,
  detectSecrets,
  type FunctionEgress,
  type FunctionResult,
  removedSecretToken,
  replaceFindings,
} from '@remyral/protocol';
import type { AuditRecorder } from '../audit/audit.js';
import { authorize, type Subject } from '../authz/model.js';
import type { Pool, Queryable } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  buildFunction,
  functionFailure,
  FunctionRequestError,
  readFunctionResult,
} from '../workflows/v2/functions.js';
import type { ConfirmContext } from './drafts.js';
import type { MentionChip, MentionItem } from './mentions.js';
import type { DraftPlan } from './settings-actions.js';
import type { ChatStore, DraftRecord } from './store.js';
import { CREDENTIAL_NOT_ALLOWED_FOR_PROJECT, credentialAllowsProject } from '../vault/projects.js';

/**
 * p15-chat-vault (docs/design/p15-chat-vault.md): vault credentials in the Sohbet chat — by reference only.
 *
 * - {@link scrubUserText}: the master's own pass over every user message before it is stored or given to a model: a
 *   secret-looking value a client did not replace becomes `{{secret:removed:…}}` (the browser already replaces what it
 *   recognises, so normally nothing is left). Nothing can recover a removed value.
 * - `{{credential:NAME}}` tokens and `@credential` mentions resolve to chips and a metadata block (name, kind, bound
 *   hosts, machines holding it) — never a value, never ciphertext. Only users who may read the vault (admins) see
 *   credential metadata; for anyone else a token stays a name.
 * - `run_http_request` (`http_request` card): ONE function job on a worker (p14 14.3 HTTP executor: DNS + address check,
 *   the project's HTTP allowlist, the credential attached only for its bound hosts, the response redacted on the worker
 *   and again here) — the master never opens the connection. The turn waits for the result, bounded.
 * - `propose_credential_save` (`credential_save` card): completed by the user's browser (it seals the value to the
 *   chosen machines' vault keys and creates the credential through `/vault/credentials`); {@link markSaved} only links
 *   the card to the credential the browser created.
 */

const redactor = new Redactor({ rules: DEFAULT_RULES });

/** The user's text with every secret-looking value replaced by a removed-secret token. */
export function scrubUserText(text: string): { text: string; removed: number } {
  const found = detectSecrets(text);
  let out = found.length === 0 ? text : replaceFindings(text, found, (f) => removedSecretToken(f.provider));
  // Second pass: the platform redactor's patterns (anything the chat detector does not know).
  // Our own tokens are never redacted again (`secret:{{…}}` would look like an assignment to the platform rules).
  const tokens = [...out.matchAll(/\{\{(?:credential|secret):[^{}\s]{1,120}\}\}/g)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
  const spans = redactor
    .spans(out)
    .filter((sp) => !tokens.some(([a, b]) => sp.start < (b as number) && sp.end > (a as number)));
  let removed = found.length;
  if (spans.length > 0) {
    let next = '';
    let pos = 0;
    for (const s of spans) {
      next += out.slice(pos, s.start) + removedSecretToken(s.label);
      pos = s.end;
    }
    out = next + out.slice(pos);
    removed += spans.length;
  }
  return { text: out, removed };
}

export interface CredentialMeta {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly allowedHosts: readonly string[] | null;
  readonly machines: readonly string[];
  /** p22-vault-projects: the projects that may use it (null: every project). */
  readonly projects: readonly string[] | null;
}

/** What a user message keeps about a referenced credential (`meta.credentials`, rendered as a chip). */
export interface CredentialChip {
  readonly name: string;
  readonly id: string | null;
  readonly kind: string | null;
  readonly allowedHosts: readonly string[] | null;
  readonly machines: number;
}

/** Response body characters given back to the model (the full body stays in the job's result artifact). */
const MAX_BODY_PREVIEW = 8_000;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
/** Headers a request never takes from the model (credentials only through the vault; hop-by-hop headers). */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'private-token',
  'x-goog-api-key',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

export interface ChatCredentialsDeps {
  readonly db: Pool;
  readonly store: ChatStore;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  /** Creates a submitted function job for the user (JobStore in production). */
  readonly jobs: () => {
    create(input: { project: string; spec: Record<string, unknown>; userId: string }): Promise<string>;
  } | null;
  /** The project's HTTP policy (Projects → Policy → HTTP izin listesi). */
  readonly egress: () => { effective(project: string): Promise<FunctionEgress> } | null;
  /** Polling interval while a turn waits for a request's result (tests shorten it). */
  readonly pollMs?: number;
}

type Body = { type: 'json' | 'text' | 'form'; value: unknown };

function fail(code: 'invalid' | 'forbidden' | 'not_found' | 'unavailable', message: string): DraftPlan {
  return { ok: false, code, message };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export class ChatCredentials {
  constructor(private readonly deps: ChatCredentialsDeps) {}

  /** Whether `subject` may see vault credential metadata (and use credentials in requests). */
  visible(subject: Subject): boolean {
    return authorize(subject, 'vault.read').allow;
  }

  // ------------------------------------------------------------------------------------------- lookups

  async #machines(db: Queryable, ids: readonly string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (ids.length === 0) return out;
    const { rows } = await db.query<{ credential_id: string; display_name: string }>(
      `SELECT r.credential_id, w.display_name FROM vault_credential_workers r
         JOIN vault_credentials c ON c.id = r.credential_id JOIN workers w ON w.id = r.worker_id
        WHERE r.credential_id = ANY($1) AND r.state = 'active' AND r.acked_version = c.version
        ORDER BY w.display_name`,
      [[...ids]],
    );
    for (const r of rows) out.set(r.credential_id, [...(out.get(r.credential_id) ?? []), r.display_name]);
    return out;
  }

  /** Active credentials whose id or exact name is `ref` (several: ambiguous). */
  async find(ref: string, db: Queryable = this.deps.db): Promise<CredentialMeta[]> {
    const { rows } = await db.query<{
      id: string;
      name: string;
      kind: string;
      allowed_hosts: string[] | null;
      projects: string[] | null;
    }>(
      `SELECT id, name, kind, allowed_hosts, projects FROM vault_credentials
        WHERE state = 'active' AND (id = $1 OR name = $1) ORDER BY (id = $1) DESC, updated_at DESC LIMIT 5`,
      [ref],
    );
    const exactId = rows.filter((r) => r.id === ref);
    const pick = exactId.length > 0 ? exactId : rows;
    const machines = await this.#machines(
      db,
      pick.map((r) => r.id),
    );
    return pick.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      allowedHosts: r.allowed_hosts,
      machines: machines.get(r.id) ?? [],
      projects: r.projects,
    }));
  }

  /** `@` picker entries (type `credential`): name and kind, never a value. Empty for users without vault.read. */
  async search(subject: Subject, q: string, limit: number): Promise<MentionItem[]> {
    if (!this.visible(subject)) return [];
    const like = `%${q
      .trim()
      .slice(0, 100)
      .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const { rows } = await this.deps.db.query<{
      id: string;
      name: string;
      kind: string;
      allowed_hosts: string[] | null;
    }>(
      `SELECT id, name, kind, allowed_hosts FROM vault_credentials
        WHERE state = 'active' AND (name ILIKE $1 OR id ILIKE $1) ORDER BY lower(name) LIMIT $2`,
      [like, limit],
    );
    return rows.map((r) => ({
      type: 'credential' as const,
      id: r.id,
      project: null,
      label: r.name,
      detail:
        r.allowed_hosts === null || r.allowed_hosts.length === 0
          ? r.kind
          : `${r.kind} · ${r.allowed_hosts.slice(0, 2).join(', ')}`,
    }));
  }

  #block(c: CredentialMeta): Record<string, unknown> {
    return {
      type: 'vault credential',
      name: c.name,
      id: c.id,
      kind: c.kind,
      allowedHosts: c.allowedHosts,
      machines: c.machines,
      // p22-vault-projects: null = every project may use it.
      projects: c.projects ?? 'all',
      value: 'never shown — sealed on the machines',
      use:
        c.kind === 'http-auth'
          ? `run_http_request with credential "${c.name}" for a URL on ${(c.allowedHosts ?? []).join(', ') || 'its bound hosts'}`
          : c.kind === 'generic'
            ? 'a job environment variable only once a project gives it to its jobs (Projeler → Politika → Ortam değişkenleri; p19-project-env) — jobs of other projects never see it; run_http_request takes http-auth credentials only'
            : 'an agent runtime / environment credential (Ayarlar → Kimlik bilgileri); run_http_request takes http-auth credentials only',
    };
  }

  /** An `@credential` mention, resolved for the sender (null: not visible / unknown — dropped). */
  async mention(subject: Subject, id: string): Promise<{ chip: MentionChip; data: unknown } | null> {
    if (!this.visible(subject) || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id)) return null;
    const c = (await this.find(id)).find((x) => x.id === id);
    if (c === undefined) return null;
    return { chip: { type: 'credential', id: c.id, project: null, label: c.name }, data: this.#block(c) };
  }

  /**
   * The `{{credential:NAME}}` tokens of a message: chips (meta.credentials) and metadata blocks for the model.
   * p22-vault-projects: with `projects` (the conversation's working projects) a credential one of them may not use is
   * not resolved — its block says so and gives no id.
   */
  async tokens(
    subject: Subject,
    text: string,
    projects?: readonly string[],
  ): Promise<{ chips: CredentialChip[]; blocks: unknown[] }> {
    const names = credentialTokenNames(text)
      .filter((n) => CREDENTIAL_TOKEN_NAME.test(n))
      .slice(0, 10);
    if (names.length === 0) return { chips: [], blocks: [] };
    if (!this.visible(subject))
      return {
        chips: names.map((name) => ({ name, id: null, kind: null, allowedHosts: null, machines: 0 })),
        blocks: [],
      };
    const chips: CredentialChip[] = [];
    const blocks: unknown[] = [];
    for (const name of names) {
      const found = await this.find(name);
      const c = found.length === 1 ? found[0] : undefined;
      const outside =
        c === undefined ? [] : (projects ?? []).filter((p) => !credentialAllowsProject(c.projects, p));
      if (c !== undefined && outside.length > 0) {
        chips.push({ name, id: null, kind: null, allowedHosts: null, machines: 0 });
        blocks.push({
          type: 'vault credential',
          name,
          state: `not allowed for project ${outside.join(', ')} (${CREDENTIAL_NOT_ALLOWED_FOR_PROJECT}): an administrator can add the project in Ayarlar → Kimlik bilgileri → Projeler`,
        });
        continue;
      }
      if (c === undefined) {
        chips.push({ name, id: null, kind: null, allowedHosts: null, machines: 0 });
        blocks.push({
          type: 'vault credential',
          name,
          state: found.length === 0 ? 'not in the vault' : 'ambiguous: several credentials have this name',
        });
        continue;
      }
      chips.push({
        name,
        id: c.id,
        kind: c.kind,
        allowedHosts: c.allowedHosts,
        machines: c.machines.length,
      });
      blocks.push(this.#block(c));
    }
    return { chips, blocks };
  }

  // ------------------------------------------------------------------------------------------- run_http_request

  /** Validates a request and builds its function spec (the same checks as a workflow HTTP node). */
  async #build(
    subject: Subject,
    project: string,
    i: Record<string, unknown>,
  ): Promise<
    | {
        ok: true;
        built: Awaited<ReturnType<typeof buildFunction>>;
        request: Record<string, unknown>;
        credential: { id: string; name: string; placement: string; headerName?: string } | null;
      }
    | { ok: false; out: DraftPlan }
  > {
    let url: URL;
    try {
      url = new URL(String(i.url));
    } catch {
      return { ok: false, out: fail('invalid', 'url: not an absolute http(s) URL.') };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return { ok: false, out: fail('invalid', 'url: only http and https.') };
    if (url.username !== '' || url.password !== '')
      return {
        ok: false,
        out: fail(
          'invalid',
          'url: credentials in the URL are refused — use a vault credential (credential).',
        ),
      };
    const headers = (i.headers as Record<string, string> | undefined) ?? {};
    for (const h of Object.keys(headers)) {
      if (FORBIDDEN_HEADERS.has(h.toLowerCase()))
        return {
          ok: false,
          out: fail(
            'invalid',
            `headers.${h}: credentials go only through a vault credential (credential + placement), never as a header value.`,
          ),
        };
    }
    const query = (i.query as Record<string, string> | undefined) ?? {};
    const body = i.body as Body | undefined;
    // A raw secret in what the model wrote (it never had one: only a leaked value could be here).
    const probe = JSON.stringify({ url: url.toString(), headers, query, body: body?.value ?? null });
    if (detectSecrets(probe).length > 0 || redactor.spans(probe).length > 0)
      return {
        ok: false,
        out: fail(
          'invalid',
          'The request contains a secret-looking value. Use a vault credential reference (credential) instead.',
        ),
      };
    let credential: { id: string; name: string; placement: string; headerName?: string } | null = null;
    const ref = str(i.credential);
    if (ref !== undefined) {
      if (!this.visible(subject))
        return {
          ok: false,
          out: fail('forbidden', 'Only administrators may use vault credentials in requests.'),
        };
      const found = await this.find(ref.replace(/^@/, '').replace(/^\{\{credential:(.+)\}\}$/, '$1'));
      if (found.length === 0)
        return { ok: false, out: fail('not_found', `Vault credential ${ref} not found.`) };
      if (found.length > 1)
        return {
          ok: false,
          out: fail(
            'invalid',
            `Several vault credentials are named ${ref}: pass one of their ids (${found.map((f) => f.id).join(', ')}).`,
          ),
        };
      const c = found[0] as CredentialMeta;
      // p22-vault-projects: only a credential the project may use (fail closed, audited).
      if (!credentialAllowsProject(c.projects, project)) {
        await this.deps.audit.record({
          actor: { type: 'user', id: subject.userId },
          action: 'chat.http_request',
          target: `project:${project}`,
          outcome: 'denied',
          metadata: { project, vaultId: c.id, denial: CREDENTIAL_NOT_ALLOWED_FOR_PROJECT },
        });
        return {
          ok: false,
          out: fail(
            'forbidden',
            `${CREDENTIAL_NOT_ALLOWED_FOR_PROJECT}: vault credential ${c.name} is not allowed for project ${project}. An administrator can add the project in Ayarlar → Kimlik bilgileri → Projeler.`,
          ),
        };
      }
      if (c.kind !== 'http-auth')
        return {
          ok: false,
          out: fail(
            'invalid',
            `Vault credential ${c.name} is a ${c.kind} credential (for agent runtimes). Requests take http-auth credentials bound to their hosts: the user can save the key again as "HTTP kimlik doğrulama" with the API host.`,
          ),
        };
      const placement = str(i.placement) ?? 'bearer';
      const headerName = str(i.headerName);
      credential = {
        id: c.id,
        name: c.name,
        placement,
        ...(headerName === undefined ? {} : { headerName }),
      };
    }
    const egress = (await this.deps.egress()?.effective(project)) ?? { mode: 'open' as const, hosts: [] };
    const method = str(i.method) ?? (body === undefined ? 'GET' : 'POST');
    const config: Record<string, unknown> = {
      origin: url.origin,
      path: `${url.pathname}${url.search}`,
      method,
      ...(Object.keys(query).length === 0 ? {} : { query }),
      headers: { ...headers, 'User-Agent': 'Remyral-Chat/1.0' },
      ...(body === undefined ? {} : { body }),
      timeoutSec: typeof i.timeoutSec === 'number' ? i.timeoutSec : 30,
      responseType: str(i.responseType) ?? 'json',
      followRedirects: 3,
      ...(credential === null
        ? {}
        : {
            auth: {
              credential: credential.id,
              placement: credential.placement,
              ...(credential.headerName === undefined ? {} : { name: credential.headerName }),
            },
          }),
    };
    try {
      const built = await buildFunction({
        db: this.deps.db,
        node: { id: 'chat', type: 'http.request', config },
        config,
        value: null,
        key: `chat-${String(this.deps.clock().getTime())}-${Math.random().toString(36).slice(2, 10)}`,
        egress,
        project,
      });
      return {
        ok: true,
        built,
        credential,
        request: {
          method,
          url: url.toString(),
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(Object.keys(query).length === 0 ? {} : { query }),
          ...(body === undefined ? {} : { body }),
          responseType: config.responseType,
          timeoutSec: config.timeoutSec,
        },
      };
    } catch (err) {
      if (err instanceof FunctionRequestError)
        return { ok: false, out: fail('invalid', `${err.code}: ${err.message}`) };
      throw err;
    }
  }

  async planHttp(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    const project = String(i.project);
    const d = authorize(subject, 'jobs.create', { project });
    if (!d.allow)
      return d.reason === 'not_visible'
        ? fail('not_found', `Project ${project} not found.`)
        : fail('forbidden', `The signed-in user may not start jobs in project ${project}.`);
    if (this.deps.jobs() === null)
      return fail('unavailable', 'HTTP requests are not available on this master.');
    const b = await this.#build(subject, project, i);
    if (!b.ok) return b.out;
    const host = new URL(String(b.request.url)).host;
    return {
      ok: true,
      title:
        `${String(b.request.method)} ${host}${b.credential === null ? '' : ` · @${b.credential.name}`}`.slice(
          0,
          200,
        ),
      project,
      payload: {
        op: 'http_request',
        project,
        request: b.request,
        credential: b.credential,
        ...(typeof i.reason === 'string' ? { reason: i.reason } : {}),
      },
      describe: {
        request: { method: b.request.method, url: b.request.url },
        ...(b.credential === null
          ? {}
          : { credential: { name: b.credential.name, placement: b.credential.placement } }),
        runsOn: 'a worker machine with function-v1 (and the credential, when one is attached)',
      },
    };
  }

  /** Runs a confirmed `http_request` card: one submitted function job, as the confirming user. */
  async run(ctx: ConfirmContext, d: DraftRecord): Promise<Record<string, unknown>> {
    const jobs = this.deps.jobs();
    if (jobs === null)
      throw new HttpError(
        503,
        'unavailable',
        'HTTP requests from the chat are not available.',
        {},
        {},
        { reason: 'http' },
      );
    const project = String(d.payload.project);
    if (!authorize(ctx.subject, 'jobs.create', { project }).allow)
      throw new HttpError(403, 'forbidden', `You may not start jobs in project ${project}.`);
    const request = (d.payload.request ?? {}) as Record<string, unknown>;
    const cred = d.payload.credential as
      { id: string; placement: string; headerName?: string } | null | undefined;
    const b = await this.#build(ctx.subject, project, {
      ...request,
      ...(cred === null || cred === undefined
        ? {}
        : {
            credential: cred.id,
            placement: cred.placement,
            ...(cred.headerName === undefined ? {} : { headerName: cred.headerName }),
          }),
    });
    if (!b.ok) {
      const o = b.out as Extract<DraftPlan, { ok: false }>;
      throw new HttpError(
        o.code === 'forbidden' ? 403 : o.code === 'not_found' ? 404 : 400,
        'http_request_refused',
        o.message,
      );
    }
    const timeout = Number(request.timeoutSec ?? 30);
    const spec: Record<string, unknown> = {
      kind: 'function',
      function: b.built.spec,
      projectId: project,
      runtime: 'claude-code',
      prompt: `Chat HTTP request (no agent): ${String(request.method)} ${new URL(String(request.url)).host}.`,
      sandboxProfile: 'container',
      approvalPolicy: 'deny-sensitive',
      sourceTrust: 'untrusted',
      limits: { maxDurationSec: Math.min(Math.max(timeout * 4 + 60, 30), 600) },
      role: 'chore',
    };
    const jobId = await jobs.create({ project, spec, userId: ctx.subject.userId });
    return {
      jobId,
      project,
      method: request.method,
      url: request.url,
      ...(cred === null || cred === undefined
        ? {}
        : { credential: (d.payload.credential as { name: string }).name }),
    };
  }

  /** The job's state and, once it ended, the bounded and redacted response the model gets. */
  async result(jobId: string): Promise<Record<string, unknown>> {
    const { rows } = await this.deps.db.query<{ state: string }>(
      'SELECT state::text AS state FROM jobs WHERE id = $1',
      [jobId],
    );
    const state = rows[0]?.state;
    if (state === undefined) return { jobId, state: 'unknown' };
    if (!TERMINAL.has(state))
      return { jobId, state, done: false, hint: 'still running: read it again with http_request_result' };
    if (state === 'CANCELLED')
      return {
        jobId,
        state,
        done: true,
        error: 'no_worker',
        message: 'No machine took the request in time (or it was cancelled).',
      };
    if (state === 'FAILED') {
      const f = await functionFailure(this.deps.db, jobId);
      return { jobId, state, done: true, error: f.code, message: redactor.redact(f.message) };
    }
    const r: FunctionResult | null = await readFunctionResult(this.deps.db, jobId);
    if (r?.type !== 'http') return { jobId, state, done: true, error: 'no_result' };
    let body: unknown = r.body ?? null;
    let truncated = r.truncated;
    const json = typeof body === 'string' ? body : JSON.stringify(body);
    if (json.length > MAX_BODY_PREVIEW) {
      body = `${json.slice(0, MAX_BODY_PREVIEW)}…`;
      truncated = true;
    }
    return redactDeep(
      {
        jobId,
        state,
        done: true,
        status: r.status,
        headers: r.headers,
        body,
        bodyEncoding: r.bodyEncoding,
        truncated,
        sizeBytes: r.sizeBytes,
        finalUrl: r.finalUrl,
        credentialAttached: r.credentialAttached,
        durationMs: r.durationMs,
      },
      redactor,
    ) as Record<string, unknown>;
  }

  /** Waits (bounded) for the job of a request to end. */
  async await(jobId: string, ms: number): Promise<Record<string, unknown>> {
    const until = Date.now() + ms;
    const step = this.deps.pollMs ?? 250;
    for (;;) {
      const r = await this.result(jobId);
      if (r.done !== false || Date.now() >= until) return r;
      await new Promise((resolve) => setTimeout(resolve, step));
    }
  }

  /** http_request_result: only for a request the caller started from the chat. */
  async readFor(userId: string, jobId: string, ms: number): Promise<Record<string, unknown> | null> {
    const { rowCount } = await this.deps.db.query(
      `SELECT 1 FROM chat_drafts WHERE user_id = $1 AND kind = 'http_request' AND result->>'jobId' = $2`,
      [userId, jobId],
    );
    if ((rowCount ?? 0) === 0) return null;
    return this.await(jobId, ms);
  }

  // ------------------------------------------------------------------------------------------- credential_save

  async planSave(subject: Subject, i: Record<string, unknown>): Promise<DraftPlan> {
    if (!authorize(subject, 'vault.write').allow)
      return fail(
        'forbidden',
        'Only administrators can save credentials in the vault. Tell the user to ask an administrator; the pasted value was not sent anywhere.',
      );
    const name = String(i.name);
    if ((await this.find(name)).some((c) => c.name === name))
      return fail(
        'invalid',
        `A vault credential named ${name} exists already: propose another name (e.g. ${name}_2).`,
      );
    const hosts = Array.isArray(i.allowedHosts) ? i.allowedHosts.map(String) : [];
    if (i.kind === 'http-auth' && hosts.length === 0)
      return fail(
        'invalid',
        'An http-auth credential needs allowedHosts (the API host, e.g. api.openai.com).',
      );
    return {
      ok: true,
      title: `${name} → vault`,
      project: null,
      payload: {
        op: 'credential_save',
        name,
        kind: i.kind,
        ...(typeof i.secret === 'string' ? { secret: i.secret } : {}),
        ...(typeof i.provider === 'string' ? { provider: i.provider } : {}),
        ...(hosts.length === 0 ? {} : { allowedHosts: hosts }),
        ...(typeof i.description === 'string' ? { description: i.description } : {}),
      },
      describe: {
        completedBy:
          "the user's browser: it seals the value to the machines' vault keys (the master and you never see it). Say that the card in this conversation saves it.",
      },
    };
  }

  /**
   * The browser created credential `credentialId` for the open `credential_save` card `draftId`: the card is done.
   * Checks: the caller's own open card, the credential exists, is active and was created by the caller.
   */
  async markSaved(
    actor: { userId: string; ip: string; userAgent: string | null },
    draftId: string,
    credentialId: string,
  ): Promise<{ draft: DraftRecord; credential: CredentialMeta }> {
    const d = await this.deps.store.draft(actor.userId, draftId);
    if (d.kind !== 'credential_save')
      throw new HttpError(
        400,
        'invalid_request',
        'This card does not save a credential.',
        {},
        {},
        { reason: 'credential_save' },
      );
    if (d.state !== 'proposed')
      throw new HttpError(409, 'draft_not_open', `The draft is ${d.state}.`, {}, {}, { state: d.state });
    const { rows } = await this.deps.db.query<{ created_by: string | null; state: string }>(
      'SELECT created_by::text AS created_by, state FROM vault_credentials WHERE id = $1',
      [credentialId],
    );
    const row = rows[0];
    if (row === undefined || row.state !== 'active' || row.created_by !== actor.userId)
      throw new HttpError(404, 'credential_not_found', 'Credential not found.');
    const c = (await this.find(credentialId)).find((x) => x.id === credentialId) as CredentialMeta;
    await this.deps.store.decideDraft(d.id, 'confirmed', {
      credentialId: c.id,
      name: c.name,
      kind: c.kind,
      token: `{{credential:${c.name}}}`,
    });
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      action: 'chat.draft.confirm',
      target: `chat-draft:${d.id}`,
      outcome: 'success',
      ip: actor.ip,
      userAgent: actor.userAgent,
      metadata: { kind: d.kind, via: 'browser', credentialId: c.id, threadId: d.threadId },
    });
    return { draft: await this.deps.store.draft(actor.userId, draftId), credential: c };
  }
}
