import type { PriorityClass } from '@remyral/protocol';
import type { Queryable } from '../db/pool.js';

/**
 * p9-queue-priority §5: a chat draft is Normal unless the USER asks for urgency in their own words.
 * The assistant prompt says so; this is the master-side guard behind it — the model's `priorityClass: "urgent"` stands
 * only when the user message of the same turn contains an urgency word. Text from tools, jobs, documents or
 * attachments never reaches this check (only the stored user message of the turn does), so job output or a prompt
 * injection in data cannot make a job urgent.
 */
const URGENCY =
  /(^|[^\p{L}\p{N}])(acil(en)?|hemen|öncelikli|oncelikli|ivedi(en)?|derhal|asap|urgent(ly)?|right now|immediately|top priority|high priority)(?=$|[^\p{L}\p{N}])/iu;

export function expressesUrgency(text: string): boolean {
  const t = text.normalize('NFC');
  // Turkish casing: "ACİL" / "ÖNCELİKLİ" lower-case to "acil" only with the Turkish rules (İ → i), English words
  // ("IMMEDIATELY") only with the default ones (I → i, not ı).
  return URGENCY.test(t.toLocaleLowerCase('tr-TR')) || URGENCY.test(t.toLowerCase());
}

/** The user message the turn answers (the latest one stored before the turn started), or null. */
async function turnUserMessage(db: Queryable, threadId: string, turnId: string): Promise<string | null> {
  const { rows } = await db.query<{ content: string }>(
    `SELECT m.content FROM chat_messages m
      WHERE m.thread_id = $1 AND m.role = 'user'
        AND m.created_at <= (SELECT t.created_at FROM chat_turns t WHERE t.id = $2 AND t.thread_id = $1)
      ORDER BY m.seq DESC LIMIT 1`,
    [threadId, turnId],
  );
  return rows[0]?.content ?? null;
}

/**
 * The class a draft gets: the model's choice, except that `urgent` without the user's own urgency words becomes
 * `normal` (with a note for the model to pass on).
 */
export async function draftPriorityClass(
  db: Queryable,
  caller: { readonly threadId: string; readonly turnId: string },
  requested: unknown,
): Promise<{ readonly priorityClass: PriorityClass; readonly note: string | null }> {
  if (requested !== 'urgent' && requested !== 'background') return { priorityClass: 'normal', note: null };
  if (requested === 'background') return { priorityClass: 'background', note: null };
  const text = await turnUserMessage(db, caller.threadId, caller.turnId);
  if (text !== null && expressesUrgency(text)) return { priorityClass: 'urgent', note: null };
  return {
    priorityClass: 'normal',
    note: 'priorityClass "urgent" was not applied: the user’s message does not ask for urgency (acil, hemen, öncelikli, ASAP, urgent …). The card is Normal; the user can change it on the card.',
  };
}

/** p10-chat-job-actions: "run it now / şimdi çalıştır / öne al / başa al" (besides the urgency words). */
const RUN_NOW =
  /(^|[^\p{L}\p{N}])(run (it |this |that |the job |them )?now|start (it |this |that )?now|go first|şimdi (çalıştır|başlat)|simdi (calistir|baslat)|öne al|one al|başa al|basa al|sıranın başına|en öne)(?=$|[^\p{L}\p{N}])/iu;

/**
 * p10-chat-job-actions: a `run_now` card stands only when the user message of the same turn asks for it — the urgency
 * words, or "run now" in their own words. Tool results and job output never reach this check.
 */
export function asksToRunNowText(text: string): boolean {
  const t = text.normalize('NFC');
  return expressesUrgency(t) || RUN_NOW.test(t.toLocaleLowerCase('tr-TR')) || RUN_NOW.test(t.toLowerCase());
}

export async function asksToRunNow(
  db: Queryable,
  caller: { readonly threadId: string; readonly turnId: string },
): Promise<boolean> {
  const text = await turnUserMessage(db, caller.threadId, caller.turnId);
  return text !== null && asksToRunNowText(text);
}
