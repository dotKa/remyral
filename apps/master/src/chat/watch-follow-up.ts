import type { FastifyBaseLogger } from 'fastify';
import type { ActorContext } from '../workers/fleet.js';
import type { AuditRecorder } from '../audit/audit.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../http/errors.js';
import {
  claimDelivery,
  completeDelivery,
  type DeliveryRef,
  failDelivery,
  reapDeliveries,
  releaseDelivery,
} from './deliveries.js';
import { parseStepOutcome } from '@remyral/protocol';
import { attentionLine, workflowRunResult } from './flow-model.js';
import { attentionWords } from './job-result.js';

/**
 * p19-watch-follow-up: work must not sit idle — it continues, or asks for the person's intervention, so nobody has
 * to keep checking on it. A check
 * watch of a conversation that ended WITHOUT its condition (timed out, can never be met — a service that gave up, a job
 * that ended otherwise —, the watched record is gone, the check limit) hands the conversation back to the assistant: one
 * system-written turn (`meta.origin = 'watch'`, never `byUser`) that finds out why and carries on, or tells the person
 * exactly what they have to do. The watch's own end note and notification are posted as before.
 *
 * Bounded: once per watch (`chat_watches.follow_up`, claimed with an UPDATE), only within {@link FOLLOW_UP_WINDOW_MS} of
 * the end, at most {@link FOLLOW_UP_CAP} per conversation in {@link FOLLOW_UP_CAP_WINDOW_MS} (a follow-up whose new
 * watch fails again cannot loop), not when the person wrote in the conversation after the watch ended (they are on it),
 * never in an archived conversation. A busy conversation or an unavailable assistant only delays it.
 *
 * p20-outcome (docs/design/p20-outcome-contract.md): the hand-off is a leased claim in `chat_deliveries` (key
 * `watch:<id>`); `follow_up = 'sent'` is written in the transaction that creates the turn. A claim that never became a
 * turn (the process died in between) expires after its lease and the watch is taken up again within the window.
 */

export const FOLLOW_UP_WINDOW_MS = 30 * 60_000;
export const FOLLOW_UP_CAP = 3;
export const FOLLOW_UP_CAP_WINDOW_MS = 6 * 3600_000;
const BATCH = 20;

/** What the follow-ups need of the chat service. */
export interface FollowUpChat {
  idle(threadId: string): Promise<boolean>;
  send(
    actor: ActorContext,
    threadId: string,
    text: string,
    opts: {
      readonly followUp: { readonly watchId: string };
      readonly delivery?: DeliveryRef;
      /** oss-sec3: the text carries words from outside the person (a job's attention, a log line, a found name / URL). */
      readonly untrusted?: boolean;
    },
  ): Promise<{ turnId: string }>;
}

export interface WatchFollowUpDeps {
  readonly pool: Pool;
  readonly audit: AuditRecorder;
  readonly clock: () => Date;
  readonly log: FastifyBaseLogger;
  readonly chat: () => FollowUpChat | null;
}

interface EndedRow {
  id: string;
  user_id: string;
  thread_id: string;
  label: string;
  language: 'tr' | 'en';
  state: string;
  end_reason: string | null;
  last_check: { summary?: unknown; value?: unknown } | null;
  ended_at: Date;
  archived: boolean;
  user_wrote: boolean;
  recent: number;
  target_kind: string;
  target_uuid: string | null;
  next_step: string | null;
  /** The watched job's / run's own state now (null for other targets). */
  target_state: string | null;
}

/** Why the watch ended, in the language of the conversation (the last check's own words when it has them). */
export function endReasonText(
  lang: 'tr' | 'en',
  endReason: string | null,
  lastSummary: string | null,
): string {
  const tr = lang === 'tr';
  const last = lastSummary === null || lastSummary.trim() === '' ? null : lastSummary.trim();
  if (endReason === 'expired')
    return tr
      ? `süresi içinde gerçekleşmedi${last === null ? '' : ` (son kontrol: ${last})`}`
      : `it did not happen in time${last === null ? '' : ` (last check: ${last})`}`;
  if (endReason === 'check_limit')
    return tr
      ? `kontrol sınırına ulaşıldı${last === null ? '' : ` (son kontrol: ${last})`}`
      : `the check limit was reached${last === null ? '' : ` (last check: ${last})`}`;
  if (endReason === 'never:gone') return tr ? 'takip edilen kayıt artık yok' : 'the watched record is gone';
  if (last !== null) return last;
  return tr ? 'koşul artık sağlanamaz' : 'the condition can no longer be met';
}

/** The system-written message of the follow-up turn (an instruction to the assistant; the console shows one line). */
export function followUpText(lang: 'tr' | 'en', label: string, reason: string): string {
  return lang === 'tr'
    ? `Takip sonuçsuz bitti: ${label} — ${reason}. Kullanıcının bu konuşmada istediği işe kendiliğinden devam et: ` +
        'nedenini okumalarla bul (service_logs, list_services, describe_job, describe_worker); düzeltebileceğin bir ' +
        'şeyse düzelt ve sonucu beklemek gerekiyorsa yeni bir takip kur. Aynı yöntemi aynen tekrar deneme. Düzeltme ' +
        'senin elinde değilse (bir onay, bir anahtar, bir karar, makineye erişim) kullanıcıya kısaca ne olduğunu ve ' +
        'tam olarak ne yapması gerektiğini söyle. Kısa yaz.'
    : `The watch ended without its condition: ${label} — ${reason}. Carry on with the work the user asked for in this ` +
        'conversation by yourself: find out why with reads (service_logs, list_services, describe_job, ' +
        'describe_worker); if you can fix it, fix it and create a new watch when the result has to be waited for. Do ' +
        'not repeat the same approach unchanged. If the fix is not in your hands (an approval, a key, a decision, ' +
        'access to the machine), tell the user briefly what happened and exactly what they have to do. Be brief.';
}

/**
 * p22-run-attention: the system-written message when a watched run succeeded while a step could not do its work.
 */
export function attentionFollowUpText(lang: 'tr' | 'en', label: string, runId: string, why: string): string {
  const w = why === '' ? '' : ` — ${why}`;
  return lang === 'tr'
    ? `Workflow başarılı bitti ama dikkat istiyor: ${label} (run ${runId})${w}. Kullanıcının bu konuşmada istediği işe ` +
        'kendiliğinden devam et: run’ı ve adımlarını oku (describe_workflow_run, describe_job), neden eksik kaldığını ' +
        'bul; workflow’u ya da girdisini düzeltip yeniden çalıştırabiliyorsan yap ve sonucu beklemek gerekiyorsa takip ' +
        'kur. Aynı run’ı aynen tekrar çalıştırma. Düzeltme senin elinde değilse kullanıcıya kısaca ne olduğunu ve tam ' +
        'olarak ne yapması gerektiğini söyle. Kısa yaz.'
    : `The workflow run succeeded but needs attention: ${label} (run ${runId})${w}. Carry on with the work the user ` +
        'asked for in this conversation by yourself: read the run and its steps (describe_workflow_run, describe_job) ' +
        'and find out why it fell short; if you can fix the workflow or its input and run it again, do so and create a ' +
        'watch when the result has to be waited for. Do not rerun the same run unchanged. If the fix is not in your ' +
        'hands, tell the user briefly what happened and exactly what they have to do. Be brief.';
}

/** p22-run-attention: the system-written message when a watched job succeeded while its agent could not do the task. */
export function jobAttentionFollowUpText(
  lang: 'tr' | 'en',
  label: string,
  jobId: string,
  why: string,
): string {
  const w = why === '' ? '' : ` — ${why}`;
  return lang === 'tr'
    ? `İş bitti ama dikkat istiyor: ${label} (iş ${jobId})${w}. Kullanıcının bu konuşmada istediği işe kendiliğinden ` +
        'devam et: işin sonucunu ve günlüklerini oku (describe_job), neden eksik kaldığını bul; eksik olan senin ' +
        'sağlayabileceğin bir şeyse (girdi, talimat, ayar) düzeltip işi yeniden başlat ve sonucu beklemek gerekiyorsa ' +
        'takip kur. Aynı işi aynen tekrar başlatma. Düzeltme senin elinde değilse kullanıcıya kısaca ne olduğunu ve tam ' +
        'olarak ne yapması gerektiğini söyle. Kısa yaz.'
    : `The job finished but needs attention: ${label} (job ${jobId})${w}. Carry on with the work the user asked for in ` +
        'this conversation by yourself: read the job’s result and logs (describe_job) and find out why it fell short; if ' +
        'what is missing is something you can provide (input, instructions, a setting), fix it and start the job again, ' +
        'and create a watch when the result has to be waited for. Do not start the same job unchanged. If the fix is not ' +
        'in your hands, tell the user briefly what happened and exactly what they have to do. Be brief.';
}

/**
 * p22-watch-next-step: the system-written message when a watch the assistant gave a next step to has ended — the
 * conversation is handed back so the step the assistant promised is done now.
 */
export function nextStepFollowUpText(
  lang: 'tr' | 'en',
  label: string,
  outcome: string,
  nextStep: string,
): string {
  return lang === 'tr'
    ? `Beklediğin şey bitti: ${label} — ${outcome}. Bunun ardından yapacağını söylediğin adım: "${nextStep}". ` +
        'Bu adımı şimdi kendiliğinden yap (gerekiyorsa önce sonucu oku: describe_job, describe_workflow_run). Sonuç ' +
        'beklediğin gibi değilse (başarısız, eksik) nedenini bul; düzeltebiliyorsan düzelt, değilse kullanıcıya kısaca ' +
        'ne olduğunu ve tam olarak ne yapması gerektiğini söyle. Yine bir şeyin bitmesini bekleyeceksen yeni takibe ' +
        'yeni bir nextStep ver. İstek tamamen bittiyse ne çıktığını tek kısa mesajla söyle.'
    : `What you were waiting for has ended: ${label} — ${outcome}. The step you said you would take next: ` +
        `"${nextStep}". Do that step now by yourself (read the result first when you need it: describe_job, ` +
        'describe_workflow_run). If the result is not what you expected (failed, incomplete), find out why; fix it if ' +
        'you can, otherwise tell the user briefly what happened and exactly what they have to do. If you wait for ' +
        'something again, give the new watch its own nextStep. When the whole request is done, say what came out in ' +
        'one short message.';
}

/** p22-watch-next-step: how the watched thing ended, in words. */
export function watchOutcomeText(
  lang: 'tr' | 'en',
  state: string,
  endReason: string | null,
  targetState: string | null,
  lastSummary: string | null,
): string {
  const tr = lang === 'tr';
  if (targetState !== null) {
    const s = targetState.toLowerCase();
    if (s === 'succeeded' || s === 'completed' || s === 'done')
      return endReason === 'attention'
        ? tr
          ? 'başarılı bitti ama dikkat istiyor'
          : 'it succeeded but needs attention'
        : tr
          ? 'başarıyla bitti'
          : 'it succeeded';
    return tr ? `bitti, durumu: ${s}` : `it ended, state: ${s}`;
  }
  if (state === 'done' && (endReason === 'fired' || endReason === null))
    return tr ? 'koşul sağlandı' : 'the condition was met';
  return endReasonText(lang, endReason, lastSummary);
}

export class WatchFollowUps {
  #lastStep = 0;
  /** Watches whose follow-up this process is sending. */
  readonly #sending = new Set<string>();

  constructor(private readonly deps: WatchFollowUpDeps) {}

  step(everyMs = 5_000): { name: string; run: () => Promise<number> } {
    return {
      name: 'chat-watch-follow-ups',
      run: async () => {
        const t = this.deps.clock().getTime();
        if (t - this.#lastStep < everyMs) return 0;
        this.#lastStep = t;
        return this.tick();
      },
    };
  }

  /** One pass: the check watches that ended without their condition lately get their follow-up turn. */
  async tick(): Promise<number> {
    const chat = this.deps.chat();
    if (chat === null) return 0;
    const now = this.deps.clock();
    // p20-outcome: claims whose lease ran out without a turn are free again (their watch keeps follow_up NULL).
    try {
      for (const r of await reapDeliveries(this.deps.pool, 'watch', now))
        this.deps.log.info({ watchId: r.refId }, 'watch follow-up lease expired; taken up again');
    } catch (err) {
      this.deps.log.warn({ err }, 'watch follow-up claims not reaped');
    }
    const { rows } = await this.deps.pool.query<EndedRow>(
      `SELECT w.id::text AS id, w.user_id::text AS user_id, w.thread_id::text AS thread_id, w.label, w.language,
              w.target_kind, w.target_uuid::text AS target_uuid,
              w.state, w.end_reason, w.last_check, w.ended_at, (t.archived_at IS NOT NULL) AS archived,
              w.next_step,
              CASE w.target_kind
                WHEN 'job' THEN (SELECT j.state::text FROM jobs j WHERE j.id = w.target_uuid)
                WHEN 'workflow_run' THEN (SELECT r.state::text FROM workflow_runs r WHERE r.id = w.target_uuid)
              END AS target_state,
              EXISTS (SELECT 1 FROM chat_messages m
                       WHERE m.thread_id = w.thread_id AND m.role = 'user' AND m.created_at > w.ended_at
                         AND COALESCE(m.meta->>'origin', '') NOT IN ('plan', 'watch')) AS user_wrote,
              (SELECT count(*)::int FROM chat_watches o
                WHERE o.thread_id = w.thread_id AND o.follow_up = 'sent' AND o.ended_at >= $2) AS recent
         FROM chat_watches w JOIN chat_threads t ON t.id = w.thread_id
        WHERE w.follow_up IS NULL AND w.ended_at >= $1
          AND ((w.target_kind = 'check'
                AND (w.state = 'expired' OR (w.state = 'done' AND w.end_reason IS DISTINCT FROM 'fired')))
            -- p22-run-attention: a watched run that succeeded while a step could not do its work.
            OR (w.target_kind IN ('workflow_run', 'job') AND w.state = 'done' AND w.end_reason = 'attention')
            -- p22-watch-next-step: the assistant said what it does once this ends — however it ended.
            OR (w.next_step IS NOT NULL AND w.state IN ('done', 'expired') AND w.end_reason IS DISTINCT FROM 'cancelled'))
        ORDER BY w.ended_at LIMIT ${String(BATCH)}`,
      [new Date(now.getTime() - FOLLOW_UP_WINDOW_MS), new Date(now.getTime() - FOLLOW_UP_CAP_WINDOW_MS)],
    );
    let n = 0;
    for (const r of rows) {
      try {
        if (await this.#followUp(chat, r)) n++;
      } catch (err) {
        this.deps.log.warn({ err, watchId: r.id }, 'watch follow-up failed');
      }
    }
    return n;
  }

  /** p22-run-attention: the job's `OUTCOME:` line in words ('' when it has none any more). */
  async #jobAttention(jobId: string, lang: 'tr' | 'en'): Promise<string> {
    const { rows } = await this.deps.pool.query<{ summary: string | null }>(
      `SELECT r.result->>'summary' AS summary FROM job_runs r WHERE r.job_id = $1::uuid
        ORDER BY r.created_at DESC, r.attempt_id DESC LIMIT 1`,
      [jobId],
    );
    const a = parseStepOutcome(rows[0]?.summary ?? '');
    return a === null ? '' : attentionWords(a, lang);
  }

  async #followUp(chat: FollowUpChat, r: EndedRow): Promise<boolean> {
    if (this.#sending.has(r.id)) return false;
    const skip = r.archived
      ? 'archived'
      : r.user_wrote
        ? 'user_active'
        : r.recent >= FOLLOW_UP_CAP
          ? 'cap'
          : null;
    if (skip !== null) {
      await this.#mark(r.id, `skipped:${skip}`);
      return false;
    }
    // A turn running in the conversation (perhaps the very turn that is handling it): try again on the next pass.
    if (!(await chat.idle(r.thread_id))) return false;
    const claim = await this.#claim(r);
    if (claim === null) return false;
    this.#sending.add(r.id);
    try {
      const summary = typeof r.last_check?.summary === 'string' ? r.last_check.summary : null;
      // oss-sec3: a check's summary may quote what it found (a log line, an output's name, a URL); a job's or a run's
      // attention words come from the agent. Such a follow-up turn counts as having read untrusted content.
      const found = r.last_check?.value;
      let untrusted =
        summary !== null &&
        typeof found === 'object' &&
        found !== null &&
        ['line', 'name', 'url'].some((k) => typeof (found as Record<string, unknown>)[k] === 'string');
      const attention = async (words: Promise<string>): Promise<string> => {
        const w = await words;
        if (w.trim() !== '') untrusted = true;
        return w;
      };
      const text =
        r.next_step !== null
          ? nextStepFollowUpText(
              r.language,
              r.label,
              watchOutcomeText(r.language, r.state, r.end_reason, r.target_state, summary),
              r.next_step,
            )
          : r.target_kind === 'job'
            ? jobAttentionFollowUpText(
                r.language,
                r.label,
                r.target_uuid ?? '',
                await attention(this.#jobAttention(r.target_uuid ?? '', r.language)),
              )
            : r.target_kind === 'workflow_run'
              ? attentionFollowUpText(
                  r.language,
                  r.label,
                  r.target_uuid ?? '',
                  await attention(
                    (async () =>
                      attentionLine(
                        (await workflowRunResult(this.deps.pool, r.target_uuid ?? '').catch(() => null))
                          ?.attention ?? [],
                        r.language,
                      ))(),
                  ),
                )
              : followUpText(r.language, r.label, endReasonText(r.language, r.end_reason, summary));
      let turnId: string;
      try {
        turnId = (
          await chat.send({ userId: r.user_id, ip: 'system', userAgent: null }, r.thread_id, text, {
            followUp: { watchId: r.id },
            delivery: claim,
            ...(untrusted ? { untrusted: true } : {}),
          })
        ).turnId;
      } catch (err) {
        const code = err instanceof HttpError ? err.code : 'error';
        // Taken over after the lease ran out: the other attempt sends it.
        if (code === 'delivery_superseded') return false;
        if (code === 'turn_in_progress' || code === 'rate_limited' || code === 'assistant_unavailable') {
          // Only delayed: released for the next pass (within the window).
          await releaseDelivery(this.deps.pool, claim, code, this.deps.clock());
          return false;
        }
        await failDelivery(
          this.deps.pool,
          claim,
          code === 'cost_brake_active' || code === 'budget_exceeded' ? 'budget' : 'error',
          this.deps.clock(),
        );
        await this.#mark(
          r.id,
          code === 'cost_brake_active' || code === 'budget_exceeded' ? 'skipped:budget' : 'skipped:error',
          true,
        );
        this.deps.log.info({ watchId: r.id, code }, 'watch follow-up not sent');
        return false;
      }
      // The chat service wrote "sent" with the turn; a sender that does not (a test double) is completed here.
      await completeDelivery(this.deps.pool, claim, turnId, this.deps.clock());
      await this.deps.audit
        .record({
          actor: { type: 'system', id: 'chat-watches' },
          action: 'chat.watch.follow_up',
          target: `chat-watch:${r.id}`,
          outcome: 'success',
          metadata: { userId: r.user_id, threadId: r.thread_id, turnId, endReason: r.end_reason },
        })
        .catch(() => undefined);
      return true;
    } finally {
      this.#sending.delete(r.id);
    }
  }

  /** p20-outcome: the leased claim of the watch's hand-off (one live claim, also with several replicas). */
  async #claim(r: EndedRow): Promise<DeliveryRef | null> {
    return claimDelivery(this.deps.pool, {
      key: `watch:${r.id}`,
      kind: 'watch',
      refId: r.id,
      threadId: r.thread_id,
      now: this.deps.clock(),
    });
  }

  async #mark(id: string, value: string, overwrite = false): Promise<void> {
    await this.deps.pool.query(
      `UPDATE chat_watches SET follow_up = $2 WHERE id = $1${overwrite ? '' : ' AND follow_up IS NULL'}`,
      [id, value],
    );
  }
}
