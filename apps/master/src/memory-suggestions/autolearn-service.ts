import {
  contradiction,
  type ContradictionReason,
  type Evidence,
  projectNamespace,
  type RecordType,
  scanForSecrets,
} from '@remyral/memory';
import type { AuditRecorder } from '../audit/audit.js';
import type { ContextActor } from '../context/store.js';
import type { Pool, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { AutoLearned, MemoryRecordService } from '../memory-records/service.js';
import type { SearchService } from '../search/service.js';
import {
  AUTO_LEARN_POLICY_VERSION,
  type AutoLearnMode,
  cluster,
  type ClusterItem,
  decide,
  effectiveType,
  projectLanguage,
  type Verdict,
} from './auto-learn.js';
import { bestLexical, classify, LEXICAL_THRESHOLDS, type Thresholds } from './dedupe.js';

/**
 * p17-auto-learning (docs/design/p17-auto-learning.md §4–§6): runs the auto-learning policy over a project's pending
 * memory suggestions — when suggestions arrive (only the clusters that contain them) and as the one-off backfill
 * (every pending suggestion, dry-run first). Steps, per project, under a per-project advisory lock:
 *
 *  1. Vectors: the stored vector of each suggestion (consented projects); missing ones are embedded (backfill only).
 *  2. Already known: a suggestion that duplicates a live memory document (semantic ≥ the duplicate threshold, or
 *     lexical ≥ 0.8) is merged into that document (`merged`, `merged_doc_id`) — nothing new to learn.
 *  3. Clusters: near-duplicates (TR/EN twins included, by meaning) become one suggestion — the best-written text in the
 *     project's language stays, the others are `merged` into it and listed as its evidence.
 *  4. Verdict per remaining suggestion ({@link decide}): accepted (review in 30 days) / expiring (14-day expiry) / left
 *     for a person with the reasons. Accepting creates a typed record as the system (`system:auto-learn`), with the
 *     auto-learned provenance; everything is audited.
 *
 * Idempotent: a merged or accepted suggestion is no longer pending; a second run only re-states the human verdicts.
 */

/** The platform acting under the auto-learning policy (never a person; audited as actor type `system`). */
export const AUTO_LEARN_ACTOR: ContextActor = {
  id: 'system:auto-learn',
  role: 'operator',
  mfaAt: null,
  system: true,
};
const ACTOR = { type: 'system' as const, id: AUTO_LEARN_ACTOR.id };

export interface MergedSource {
  readonly suggestionId: string;
  readonly jobId: string | null;
  readonly threadId: string | null;
  readonly chatMessageId: string | null;
  readonly title: string;
}

export interface TypeCounts {
  merged: number;
  known: number;
  accepted: number;
  expiring: number;
  human: number;
}

export interface AutoLearnProjectStats {
  readonly project: string;
  readonly mode: AutoLearnMode;
  readonly semantic: boolean;
  readonly pending: number;
  readonly byType: Record<RecordType, TypeCounts>;
  readonly totals: TypeCounts;
  /** Why suggestions stay with a person (reason → count). */
  readonly humanReasons: Record<string, number>;
}

export interface AutoLearnRunStats {
  readonly dryRun: boolean;
  readonly policyVersion: number;
  readonly projects: readonly AutoLearnProjectStats[];
  readonly totals: TypeCounts;
}

interface PendingRow {
  id: string;
  project: string;
  source: string;
  rule: string;
  title: string;
  content: string;
  record_type: RecordType | null;
  runtime: string | null;
  job_id: string | null;
  thread_id: string | null;
  chat_message_id: string | null;
  created_by: string | null;
  created_at: Date;
  embedding: number[] | null;
  embedding_model: string | null;
  replaces_doc_id: string | null;
  evidence: MergedSource[];
}

interface Known {
  readonly docId: string;
  readonly score: number;
  readonly method: 'semantic' | 'lexical';
}

interface Assessment {
  known: Known | null;
  replaces: { docId: string; reason: 'similar' | ContradictionReason } | null;
  similarToRecord: boolean;
}

export interface AutoLearnerDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly search: SearchService;
  readonly records: MemoryRecordService;
  readonly clock: () => Date;
  readonly semantic: Thresholds;
  /** The SQL condition of a visible suggestion (alias `s`): chat suggestions only while still shared. */
  readonly visible: string;
  readonly log?: { warn(obj: Record<string, unknown>, msg: string): void } | undefined;
}

const EMPTY = (): TypeCounts => ({ merged: 0, known: 0, accepted: 0, expiring: 0, human: 0 });
const TYPES: readonly RecordType[] = ['rule', 'fact', 'decision', 'lesson'];
const DAY_MS = 86_400_000;
const MAX_PENDING = 2_000;

function sourceKey(r: Pick<PendingRow, 'id' | 'job_id' | 'thread_id' | 'chat_message_id'>): string {
  if (r.job_id !== null) return `job:${r.job_id}`;
  if (r.thread_id !== null) return `thread:${r.thread_id}`;
  if (r.chat_message_id !== null) return `chat:${r.chat_message_id}`;
  return `suggestion:${r.id}`;
}

function asSource(r: PendingRow): MergedSource {
  return {
    suggestionId: r.id,
    jobId: r.job_id,
    threadId: r.thread_id,
    chatMessageId: r.chat_message_id,
    title: r.title.slice(0, 120),
  };
}

function secretIn(r: Pick<PendingRow, 'title' | 'content'>): boolean {
  return (
    /\[REDACTED/u.test(r.title) ||
    /\[REDACTED/u.test(r.content) ||
    scanForSecrets({ title: r.title, content: r.content }).length > 0
  );
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class AutoLearner {
  constructor(private readonly d: AutoLearnerDeps) {}

  /** The project's auto-learning setting (no settings row: `safe`, the default). */
  async mode(project: string, db: Queryable = this.d.pool): Promise<AutoLearnMode> {
    const { rows } = await db.query<{ auto_learn: AutoLearnMode }>(
      'SELECT auto_learn FROM memory_suggestion_settings WHERE project = $1',
      [project],
    );
    return rows[0]?.auto_learn ?? 'safe';
  }

  /** Projects with pending suggestions (the backfill's scope). */
  async projectsWithPending(): Promise<string[]> {
    const { rows } = await this.d.pool.query<{ project: string }>(
      `SELECT DISTINCT s.project FROM memory_suggestions s WHERE s.state = 'pending' AND ${this.d.visible}
        ORDER BY s.project`,
    );
    return rows.map((r) => r.project);
  }

  /**
   * Runs the policy over one project. `only`: the suggestions that just arrived (only clusters containing one of them
   * are touched; nothing is embedded again). `dryRun`: nothing is written (texts may still be embedded to compare).
   */
  async run(
    project: string,
    opts: { readonly dryRun: boolean; readonly only?: readonly string[] },
  ): Promise<AutoLearnProjectStats> {
    const lock = await this.d.pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock(hashtextextended($1, 17))', [`memory-autolearn:${project}`]);
      return await this.runLocked(project, opts);
    } finally {
      await lock
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 17))', [`memory-autolearn:${project}`])
        .catch(() => undefined);
      lock.release();
    }
  }

  private async runLocked(
    project: string,
    opts: { readonly dryRun: boolean; readonly only?: readonly string[] },
  ): Promise<AutoLearnProjectStats> {
    const mode = await this.mode(project);
    const byType = Object.fromEntries(TYPES.map((t) => [t, EMPTY()])) as Record<RecordType, TypeCounts>;
    const humanReasons: Record<string, number> = {};
    const { rows: pending } = await this.d.pool.query<PendingRow>(
      `SELECT s.id::text AS id, s.project, s.source, s.rule, s.title, s.content, s.record_type, s.runtime,
              s.job_id::text AS job_id, s.thread_id::text AS thread_id, s.chat_message_id::text AS chat_message_id,
              s.created_by::text AS created_by, s.created_at, s.embedding, s.embedding_model,
              s.replaces_doc_id::text AS replaces_doc_id, s.evidence
         FROM memory_suggestions s
        WHERE s.project = $1 AND s.state = 'pending' AND ${this.d.visible}
        ORDER BY s.created_at, s.id LIMIT ${String(MAX_PENDING)}`,
      [project],
    );
    const stats = (semantic: boolean): AutoLearnProjectStats => {
      const totals = EMPTY();
      for (const t of TYPES) {
        for (const k of Object.keys(totals) as (keyof TypeCounts)[]) totals[k] += byType[t][k];
      }
      return { project, mode, semantic, pending: pending.length, byType, totals, humanReasons };
    };
    if (mode === 'off' || pending.length === 0) return stats(false);

    // 1. Vectors.
    const model = this.d.search.embedder?.model ?? null;
    const vectors = new Map<string, ArrayLike<number>>();
    for (const r of pending) {
      if (model !== null && r.embedding !== null && r.embedding_model === model)
        vectors.set(r.id, r.embedding);
    }
    let semantic = vectors.size > 0;
    if (opts.only === undefined && model !== null) {
      const missing = pending.filter((r) => !vectors.has(r.id));
      if (missing.length > 0) {
        try {
          const out = await this.d.search.embedForProject(
            project,
            missing.map((r) => `${r.title}\n\n${r.content}`),
          );
          if (out !== null && out.model === model) {
            semantic = true;
            for (const [i, r] of missing.entries()) {
              const v = out.vectors[i];
              if (v === null || v === undefined) continue;
              vectors.set(r.id, v);
              if (!opts.dryRun) {
                await this.d.pool.query(
                  'UPDATE memory_suggestions SET embedding = $2, embedding_model = $3 WHERE id = $1',
                  [r.id, Array.from(v), model],
                );
              }
            }
          }
        } catch (err) {
          this.d.log?.warn(
            { errName: err instanceof Error ? err.name : 'error' },
            'auto-learning: embedding failed, lexical only',
          );
        }
      }
    }

    // 2. Known already / may replace / resembles a record.
    const targets =
      opts.only === undefined ? pending : pending.filter((r) => opts.only?.includes(r.id) === true);
    const assess = await this.assess(project, pending, vectors, model);
    const now = this.d.clock();
    const live = pending.filter((r) => assess.get(r.id)?.known == null);
    for (const r of pending) {
      const a = assess.get(r.id);
      if (a?.known == null) continue;
      if (opts.only !== undefined && !opts.only.includes(r.id)) continue;
      byType[effectiveType(r.record_type, r.rule)].known += 1;
      if (!opts.dryRun) await this.mergeIntoDoc(r, a.known, now);
    }

    // 3. Clusters (by meaning when vectors exist, else words), only within one record type.
    const lang = await this.language(project, pending);
    const items: ClusterItem[] = live.map((r) => ({
      id: r.id,
      type: effectiveType(r.record_type, r.rule),
      title: r.title,
      content: r.content,
      createdAt: r.created_at,
      sourceKey: sourceKey(r),
      vector: vectors.get(r.id) ?? null,
    }));
    const byId = new Map(pending.map((r) => [r.id, r]));
    const touched = new Set(targets.map((r) => r.id));
    for (const c of cluster(items, lang)) {
      const members = [c.keeper, ...c.merged];
      if (opts.only !== undefined && !members.some((id) => touched.has(id))) continue;
      const keeper = byId.get(c.keeper);
      if (keeper === undefined) continue;
      const type = effectiveType(keeper.record_type, keeper.rule);
      const mergedRows = c.merged.map((id) => byId.get(id)).filter((r): r is PendingRow => r !== undefined);
      byType[type].merged += mergedRows.length;
      // Evidence: the keeper's own merged sources + each merged suggestion and what had been merged into it.
      const evidence: MergedSource[] = [...keeper.evidence];
      for (const m of mergedRows) evidence.push(asSource(m), ...m.evidence);
      const sources = new Set([
        sourceKey(keeper),
        ...evidence.map((e) =>
          sourceKey({
            id: e.suggestionId,
            job_id: e.jobId,
            thread_id: e.threadId,
            chat_message_id: e.chatMessageId,
          }),
        ),
      ]).size;
      if (!opts.dryRun && mergedRows.length > 0) await this.mergeInto(keeper, mergedRows, evidence, now);

      // 4. The verdict for the cluster (its keeper), conservative over all members.
      const as = members.map((id) => assess.get(id));
      const replaces = as.find((a) => a?.replaces != null)?.replaces ?? null;
      const verdict = decide({
        mode,
        type,
        scope: 'project',
        title: keeper.title,
        content: keeper.content,
        replaces: replaces !== null,
        similarToRecord: as.some((a) => a?.similarToRecord === true),
        secret: [keeper, ...mergedRows].some(secretIn),
        sources,
      });
      if (verdict.outcome === 'human') {
        byType[type].human += 1;
        for (const reason of verdict.reasons) humanReasons[reason] = (humanReasons[reason] ?? 0) + 1;
        if (!opts.dryRun) await this.markHuman(keeper, verdict.reasons, replaces, now);
        continue;
      }
      if (opts.dryRun) {
        byType[type][verdict.outcome] += 1;
        continue;
      }
      const ok = await this.accept(keeper, type, verdict, sources, evidence, now);
      if (ok) byType[type][verdict.outcome] += 1;
      else byType[type].human += 1;
    }
    return stats(semantic);
  }

  /**
   * The project's language: what its people read the console in (members and the global owners / admins; no choice =
   * Turkish, the workspace default), by majority; without people, the language most suggestions are written in.
   */
  private async language(project: string, pending: readonly PendingRow[]): Promise<'tr' | 'en'> {
    const { rows } = await this.d.pool.query<{ locale: string; n: number }>(
      `SELECT coalesce(u.locale, 'tr') AS locale, count(*)::int AS n
         FROM users u
         LEFT JOIN project_memberships m ON m.user_id = u.id AND m.project_id = $1
        WHERE u.disabled_at IS NULL AND u.kind = 'human' AND (u.role IN ('owner', 'admin') OR m.role IS NOT NULL)
        GROUP BY 1`,
      [project],
    );
    if (rows.length === 0) return projectLanguage(pending.map((r) => `${r.title} ${r.content}`));
    const tr = rows.find((r) => r.locale === 'tr')?.n ?? 0;
    const en = rows.find((r) => r.locale === 'en')?.n ?? 0;
    return en > tr ? 'en' : 'tr';
  }

  /** Per suggestion: an already-known document, a record it may replace, or one it only resembles. */
  private async assess(
    project: string,
    pending: readonly PendingRow[],
    vectors: ReadonlyMap<string, ArrayLike<number>>,
    model: string | null,
  ): Promise<Map<string, Assessment>> {
    const { rows: docs } = await this.d.pool.query<{ id: string; text: string }>(
      `SELECT d.id::text AS id, v.title || ' ' || left(v.content, 2000) AS text
         FROM context_documents d JOIN context_doc_versions v ON v.doc_id = d.id AND v.version = d.current_version
        WHERE d.namespace = $1 AND d.deleted_at IS NULL
          AND (d.kind = 'memory' OR EXISTS (SELECT 1 FROM memory_records mr WHERE mr.doc_id = d.id))
          AND NOT EXISTS (SELECT 1 FROM memory_records mr
                           WHERE mr.doc_id = d.id AND mr.status IN ('superseded', 'expired', 'rejected'))
        LIMIT 2000`,
      [projectNamespace(project)],
    );
    const live = new Set(docs.map((d) => d.id));
    const { rows: active } = await this.d.pool.query<{ id: string; type: RecordType; statement: string }>(
      `SELECT doc_id::text AS id, type, statement FROM memory_records WHERE project = $1 AND status = 'active'`,
      [project],
    );
    const records = new Map(active.map((r) => [r.id, r]));
    let nearest: ({ docId: string; score: number } | null)[] = pending.map(() => null);
    if (model !== null && vectors.size > 0) {
      try {
        nearest = await this.d.search.nearestDocs(project, {
          model,
          vectors: pending.map((r) => vectors.get(r.id) ?? null),
        });
      } catch (err) {
        this.d.log?.warn(
          { errName: err instanceof Error ? err.name : 'error' },
          'auto-learning: semantic comparison failed',
        );
      }
    }
    const out = new Map<string, Assessment>();
    for (const [i, r] of pending.entries()) {
      const type = effectiveType(r.record_type, r.rule);
      const a: Assessment = { known: null, replaces: null, similarToRecord: false };
      const sem = nearest[i] ?? null;
      const semLive = sem !== null && live.has(sem.docId) ? sem : null;
      const lex = bestLexical(`${r.title} ${r.content}`, docs);
      const semVerdict = semLive === null ? 'new' : classify(semLive.score, this.d.semantic);
      const lexVerdict = lex === null ? 'new' : classify(lex.score, LEXICAL_THRESHOLDS);
      // A stored "may replace" whose record is still active counts too.
      const stored = r.replaces_doc_id === null ? undefined : records.get(r.replaces_doc_id);
      const candidates = [
        ...(semLive !== null && semVerdict !== 'new' ? [semLive.docId] : []),
        ...(lex !== null && lexVerdict !== 'new' ? [lex.id] : []),
        ...(stored === undefined ? [] : [stored.id]),
      ];
      for (const docId of new Set(candidates)) {
        const rec = records.get(docId);
        const reason = rec === undefined ? null : contradiction(r.content, rec.statement);
        if (rec !== undefined && reason !== null) {
          a.replaces = { docId, reason };
          break;
        }
      }
      if (a.replaces === null) {
        if (semVerdict === 'duplicate' && semLive !== null) {
          a.known = { docId: semLive.docId, score: semLive.score, method: 'semantic' };
        } else if (lexVerdict === 'duplicate' && lex !== null) {
          a.known = { docId: lex.id, score: lex.score, method: 'lexical' };
        } else if (candidates.length > 0) {
          // Close to an active record of the same type: it may be an update of that one (p11 "may replace").
          const sameType = candidates.find((id) => records.get(id)?.type === type);
          if (sameType !== undefined) a.replaces = { docId: sameType, reason: 'similar' };
          else a.similarToRecord = true;
        }
      }
      out.set(r.id, a);
    }
    return out;
  }

  private async mergeIntoDoc(r: PendingRow, known: Known, now: Date): Promise<void> {
    const res = await this.d.pool.query(
      `UPDATE memory_suggestions
          SET state = 'merged', merged_doc_id = $2, decided_at = $3, decided_by = NULL, auto_outcome = 'merged',
              auto_reasons = $4, auto_policy = $5, auto_at = $3
        WHERE id = $1 AND state = 'pending'`,
      [r.id, known.docId, now, [`known:${known.method}`], AUTO_LEARN_POLICY_VERSION],
    );
    if ((res.rowCount ?? 0) === 0) return;
    await this.d.audit.record({
      actor: ACTOR,
      action: 'memory.suggestion.merge',
      target: `memory-suggestion:${r.id}`,
      outcome: 'success',
      metadata: {
        project: r.project,
        suggestionId: r.id,
        intoDocument: known.docId,
        score: Math.round(known.score * 1000) / 1000,
        method: known.method,
        policyVersion: AUTO_LEARN_POLICY_VERSION,
      },
    });
  }

  private async mergeInto(
    keeper: PendingRow,
    merged: readonly PendingRow[],
    evidence: readonly MergedSource[],
    now: Date,
  ): Promise<void> {
    const ids = merged.map((m) => m.id);
    const done = await withTransaction(this.d.pool, async (tx) => {
      const claimed = await tx.query<{ id: string }>(
        `UPDATE memory_suggestions
            SET state = 'merged', merged_into = $2, decided_at = $3, decided_by = NULL, auto_outcome = 'merged',
                auto_reasons = '{cluster}', auto_policy = $4, auto_at = $3, evidence = '[]'::jsonb
          WHERE id = ANY($1::uuid[]) AND state = 'pending'
          RETURNING id::text AS id`,
        [ids, keeper.id, now, AUTO_LEARN_POLICY_VERSION],
      );
      const got = new Set(claimed.rows.map((r) => r.id));
      // Earlier merges into the folded suggestions now point at the keeper.
      await tx.query('UPDATE memory_suggestions SET merged_into = $2 WHERE merged_into = ANY($1::uuid[])', [
        [...got],
        keeper.id,
      ]);
      await tx.query('UPDATE memory_suggestions SET evidence = $2 WHERE id = $1', [
        keeper.id,
        JSON.stringify(evidence.filter((e) => e.suggestionId !== keeper.id).slice(0, 50)),
      ]);
      return [...got];
    });
    if (done.length === 0) return;
    await this.d.audit.record({
      actor: ACTOR,
      action: 'memory.suggestion.merge',
      target: `memory-suggestion:${keeper.id}`,
      outcome: 'success',
      metadata: {
        project: keeper.project,
        keeper: keeper.id,
        merged: done,
        policyVersion: AUTO_LEARN_POLICY_VERSION,
      },
    });
  }

  private async markHuman(
    r: PendingRow,
    reasons: readonly string[],
    replaces: { docId: string; reason: 'similar' | ContradictionReason } | null,
    now: Date,
  ): Promise<void> {
    await this.d.pool.query(
      `UPDATE memory_suggestions
          SET auto_outcome = 'human', auto_reasons = $2, auto_policy = $3, auto_at = $4,
              replaces_doc_id = coalesce($5::uuid, replaces_doc_id),
              replaces_reason = CASE WHEN $5::uuid IS NULL THEN replaces_reason ELSE $6 END
        WHERE id = $1 AND state = 'pending'`,
      [
        r.id,
        reasons.slice(0, 20),
        AUTO_LEARN_POLICY_VERSION,
        now,
        replaces?.docId ?? null,
        replaces?.reason ?? null,
      ],
    );
  }

  /** Accepts as the system: claim, typed record with auto-learned provenance, audit. False when it lost the race. */
  private async accept(
    r: PendingRow,
    type: RecordType,
    verdict: Extract<Verdict, { outcome: 'accepted' | 'expiring' }>,
    sources: number,
    merged: readonly MergedSource[],
    now: Date,
  ): Promise<boolean> {
    const claimed = await this.d.pool.query(
      `UPDATE memory_suggestions
          SET state = 'accepted', decided_at = $2, decided_by = NULL, auto_accepted = true, auto_outcome = $3,
              auto_reasons = $4, auto_policy = $5, auto_at = $2
        WHERE id = $1 AND state = 'pending'`,
      [r.id, now, verdict.outcome, verdict.reasons, AUTO_LEARN_POLICY_VERSION],
    );
    if ((claimed.rowCount ?? 0) === 0) return false;
    const evidence: Evidence[] = [];
    const seen = new Set<string>();
    const add = (kind: 'job' | 'chat', ref: string | null): void => {
      if (ref === null || seen.has(`${kind}:${ref}`) || evidence.length >= 20) return;
      seen.add(`${kind}:${ref}`);
      evidence.push({ kind, ref });
    };
    add('job', r.job_id);
    add('chat', r.chat_message_id);
    for (const m of merged) {
      add('job', m.jobId);
      add('chat', m.chatMessageId);
    }
    const autoLearned: AutoLearned = {
      policyVersion: AUTO_LEARN_POLICY_VERSION,
      reasons: [...verdict.reasons],
      confidence: verdict.confidence,
      sources,
      at: now.toISOString(),
    };
    const runtimeScope = type === 'lesson' && r.runtime !== null;
    let docId: string;
    try {
      const out = await this.d.records.create(
        AUTO_LEARN_ACTOR,
        {
          scope: runtimeScope ? `project:${r.project}+runtime:${r.runtime ?? ''}` : `project:${r.project}`,
          type,
          title: r.title,
          statement: r.content,
          evidence,
          confidence: verdict.confidence,
          ...(verdict.reviewInDays === null
            ? {}
            : { reviewBy: dateOnly(new Date(now.getTime() + verdict.reviewInDays * DAY_MS)) }),
          ...(verdict.expiresInDays === null
            ? {}
            : { expiresAt: new Date(now.getTime() + verdict.expiresInDays * DAY_MS).toISOString() }),
        },
        {},
        {
          author:
            r.source === 'chat' ? 'human' : r.source === 'agent' && type === 'lesson' ? 'runtime' : 'agent',
          authorRef: r.job_id ?? r.created_by ?? null,
          suggestionId: r.id,
          importSource: `memory suggestion ${r.id} (auto-learning policy v${String(AUTO_LEARN_POLICY_VERSION)})`,
          changeNote: 'Auto-accepted memory suggestion (auto-learning)',
          autoLearned,
        },
      );
      docId = out.record.id;
    } catch (err) {
      // Not accepted after all (e.g. the secret scan of the context store refused it): back to a person.
      await this.d.pool.query(
        `UPDATE memory_suggestions
            SET state = 'pending', decided_at = NULL, decided_by = NULL, auto_accepted = false, auto_outcome = 'human',
                auto_reasons = $2
          WHERE id = $1 AND state = 'accepted' AND accepted_doc_id IS NULL`,
        [r.id, [`accept_failed:${err instanceof Error ? err.name : 'error'}`.slice(0, 80)]],
      );
      this.d.log?.warn(
        { errName: err instanceof Error ? err.name : 'error', suggestionId: r.id },
        'auto-learning: accept failed, left for a person',
      );
      return false;
    }
    await this.d.pool.query('UPDATE memory_suggestions SET accepted_doc_id = $2 WHERE id = $1', [
      r.id,
      docId,
    ]);
    await this.d.audit.record({
      actor: ACTOR,
      action: 'memory.suggestion.accept',
      target: `memory-suggestion:${r.id}`,
      outcome: 'success',
      metadata: {
        project: r.project,
        suggestionId: r.id,
        documentId: docId,
        jobId: r.job_id,
        source: r.source,
        rule: r.rule,
        auto: true,
        outcome: verdict.outcome,
        policyVersion: AUTO_LEARN_POLICY_VERSION,
        reasons: verdict.reasons,
        confidence: verdict.confidence,
        sources,
      },
    });
    return true;
  }
}
