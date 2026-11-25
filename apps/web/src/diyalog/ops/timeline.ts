import type { ChatDraft, ChatMessage, ThreadDetail } from '../../api/chat';
import type { QuestionSet } from '../../api/questions';
import type { OpsItem } from '../../api/opsThread';
import { type Formatter, type Messages, messagesFor } from '@remyral/i18n';
import { buildRows, type Row } from '../../screens/chat/rows';
import { TR_FORMAT } from '../common/time';
import { type AssistantCodeCard, parseAssistantCodeCard } from '../code/refs';
import { type ChatImage, parseChatImages } from '../chat/images';

/**
 * p12-diyalog Faz 1: one time-ordered thread from two sources — the system events / live cards of `GET /ops-thread`
 * and the ops chat conversation. The chat keeps its own order (rows with their drafts, the classic anchoring); its
 * items get a non-decreasing time so a stable merge never reorders a conversation. Day changes get a separator line.
 * Pure: tested without rendering.
 */
export type TimelineItem =
  | { readonly kind: 'ops'; readonly key: string; readonly at: string; readonly item: OpsItem }
  | { readonly kind: 'row'; readonly key: string; readonly at: string; readonly row: Row }
  | { readonly kind: 'draft'; readonly key: string; readonly at: string; readonly d: ChatDraft }
  /** p14-ask-user: the assistant's question card, after the tool row that asked it. */
  | { readonly kind: 'question'; readonly key: string; readonly at: string; readonly q: QuestionSet }
  /**
   * p15-chat-cards-scroll: every card one assistant turn produced (drafts, question cards), as one strip BELOW the
   * turn's last message. `pending`: the turn is still being written — the strip is held back (only "n kart
   * hazırlanıyor") until the answer is complete.
   */
  | {
      readonly kind: 'cards';
      readonly key: string;
      readonly at: string;
      readonly cards: readonly StripCard[];
      readonly pending: boolean;
    }
  /**
   * p20-chat-images: the images one assistant turn showed (show_image's `meta.images`), after the turn's last row and
   * above its card strip. Shown at once — it waits for nothing, also while the answer is still being written.
   */
  | {
      readonly kind: 'images';
      readonly key: string;
      readonly at: string;
      readonly images: readonly ChatImage[];
    }
  | { readonly kind: 'day'; readonly key: string; readonly at: string; readonly label: string }
  /**
   * p16-chat-complete: a block of rows an edit / regenerate / retry replaced, folded where it stood ("N mesaj
   * değiştirildi"); its cards are folded with it.
   */
  | {
      readonly kind: 'superseded';
      readonly key: string;
      readonly at: string;
      readonly messages: readonly ChatMessage[];
    };

/** p15-chat-cards-scroll: one card of a turn's strip. */
export type StripCard =
  | { readonly kind: 'draft'; readonly key: string; readonly d: ChatDraft }
  | {
      readonly kind: 'question';
      readonly key: string;
      readonly q: QuestionSet;
      /** p20-decisions: a plan decision closed by a newer plan — the key of that plan's latest card. */
      readonly newer?: string | undefined;
    }
  /** p18-plan-mode: the plan a plan tool wrote / revised (the card reads the live plan). */
  | {
      readonly kind: 'plan';
      readonly key: string;
      readonly planId: string;
      readonly version: number;
      readonly at: string;
      /**
       * p20-decisions: a later turn wrote the same plan again — the key of that newer card (this one folds as "Yerine
       * geçti" and leads there); absent on the plan's latest card.
       */
      readonly newer?: string | undefined;
    }
  /** p18-plan-mode: the assistant suggests planning first (answered once a later message of the person exists). */
  | {
      readonly kind: 'proposal';
      readonly key: string;
      readonly reason: string;
      readonly answered: boolean;
      readonly at: string;
    }
  /** p19-ide W4: open_code / open_diff — an "Aç" card that opens the code viewer / reviewer (never by itself). */
  | {
      readonly kind: 'code';
      readonly key: string;
      readonly card: AssistantCodeCard;
      readonly at: string;
    };

/** When a strip card was made (the strip's place in time). */
export function cardAt(c: StripCard): string {
  return c.kind === 'draft' ? c.d.createdAt : c.kind === 'question' ? c.q.createdAt : c.at;
}

/**
 * p18-plan-mode: the plan / proposal cards a turn's tool lines made. One card per plan: a turn that writes a plan and
 * then revises it (plan_create, plan_update_items, …) shows it once, at its last write.
 */
function planCards(items: readonly ChatMessage[], all: readonly ChatMessage[]): StripCard[] {
  const cards = items.flatMap((m): StripCard[] => {
    const meta = m.meta;
    if (meta === null || m.role !== 'tool') return [];
    // p19-ide W4: the assistant showed code or a diff.
    const code = parseAssistantCodeCard(meta.codeCard);
    if (code !== null) return [{ kind: 'code', key: `code:${m.id}`, card: code, at: m.createdAt }];
    if (typeof meta.planId === 'string')
      return [
        {
          kind: 'plan',
          key: `plan:${m.id}`,
          planId: meta.planId,
          version: typeof meta.planVersion === 'number' ? meta.planVersion : 1,
          at: m.createdAt,
        },
      ];
    const p = meta.proposal;
    if (typeof p === 'object' && p !== null && typeof (p as { reason?: unknown }).reason === 'string')
      return [
        {
          kind: 'proposal',
          key: `proposal:${m.id}`,
          reason: (p as { reason: string }).reason,
          answered: all.some((x) => x.role === 'user' && x.seq > m.seq),
          at: m.createdAt,
        },
      ];
    return [];
  });
  const last = new Map<string, StripCard>();
  for (const c of cards) if (c.kind === 'plan') last.set(c.planId, c);
  return cards
    .filter((c) => c.kind !== 'plan' || last.get(c.planId) === c)
    .map((c) => {
      if (c.kind !== 'plan') return c;
      const newer = latestPlanCard(all, c.planId);
      return newer === null || newer === c.key ? c : { ...c, newer };
    });
}

/**
 * p20-decisions: a question's strip card; a plan decision its plan's replacement closed (`plan_superseded`) leads to the
 * conversation's latest card of another plan.
 */
function questionCard(q: QuestionSet, all: readonly ChatMessage[]): StripCard {
  const card: StripCard = { kind: 'question', key: `question:${q.id}`, q };
  if (q.state !== 'cancelled' || q.closeReason !== 'plan_superseded' || typeof q.planId !== 'string')
    return card;
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    const id = m?.meta?.planId;
    if (m?.role === 'tool' && m.supersededAt === undefined && typeof id === 'string' && id !== q.planId)
      return { ...card, newer: `plan:${m.id}` };
  }
  return card;
}

/** p20-decisions: the key of the conversation's latest card of a plan (its last plan tool line), or null. */
function latestPlanCard(all: readonly ChatMessage[], planId: string): string | null {
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i];
    if (m?.role === 'tool' && m.supersededAt === undefined && m.meta?.planId === planId)
      return `plan:${m.id}`;
  }
  return null;
}

function rowAt(row: Row): string {
  return row.kind === 'message' ? row.m.createdAt : (row.items[0]?.createdAt ?? '');
}

/**
 * Chat items in conversation order with a non-decreasing `at`.
 *
 * p15-chat-cards-scroll (approval cards must not sit above the answer's text): a turn runs from one of the person's
 * messages to the next; the cards it produced (the drafts its tool lines made, its question cards, drafts slotted in by
 * time) no longer sit between the tool lines and the answer — they follow the turn's last row as ONE `cards` item.
 * While the conversation's turn is open (`detail.turn`), the last turn's strip is `pending`.
 */
export function chatItems(detail: ThreadDetail | null): TimelineItem[] {
  if (detail === null) return [];
  // p14-ask-user: the answer message of a question card is shown by the card itself (answered, read-only).
  const shown = detail.messages.filter((m) => typeof m.meta?.answerTo !== 'string');
  // p16-chat-complete: superseded rows (and the cards they made) fold into blocks where they stood.
  const messages = shown.filter((m) => m.supersededAt === undefined);
  const blocks: ChatMessage[][] = [];
  for (const m of shown) {
    if (m.supersededAt === undefined) continue;
    const block = blocks.at(-1);
    const prev = block?.at(-1);
    const between = prev !== undefined && messages.some((c) => c.seq > prev.seq && c.seq < m.seq);
    if (block === undefined || prev === undefined || between || prev.supersededBy !== m.supersededBy)
      blocks.push([m]);
    else block.push(m);
  }
  const foldedDrafts = new Set(
    blocks.flat().flatMap((m) => (typeof m.meta?.draftId === 'string' ? [m.meta.draftId] : [])),
  );
  const { rows, leading } = buildRows(
    messages,
    detail.drafts.filter((d) => !foldedDrafts.has(d.id)),
  );
  const questions = new Map((detail.questions ?? []).map((q) => [q.id, q] as const));
  const questionsOf = (ms: readonly ChatMessage[]): QuestionSet[] =>
    ms.flatMap((m) => {
      const id = m.meta?.questionId;
      const q = typeof id === 'string' ? questions.get(id) : undefined;
      return q === undefined ? [] : [q];
    });
  const out: TimelineItem[] = [];
  let last = '';
  const later = (iso: string): string => {
    if (last === '' || Date.parse(iso) >= Date.parse(last)) last = iso;
    return last;
  };
  const draftCard = (d: ChatDraft): StripCard => ({ kind: 'draft', key: `draft:${d.id}`, d });
  // p20-chat-images: a turn's shown images (from its tool lines), placed right before the turn's card strip.
  const images = (key: string, list: readonly ChatImage[], at: string): void => {
    if (list.length === 0) return;
    out.push({ kind: 'images', key: `images:${key}`, at: later(at), images: list });
  };
  const strip = (key: string, cards: readonly StripCard[], pending: boolean): void => {
    if (cards.length === 0) return;
    const newest = cards.map(cardAt).reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
    out.push({ kind: 'cards', key: `cards:${key}`, at: later(newest), cards, pending });
  };
  strip('leading', leading.map(draftCard), false);
  let turn: { key: string; cards: StripCard[]; images: ChatImage[]; imagesAt: string } | null = null;
  let nextBlock = 0;
  const fold = (beforeSeq: number): void => {
    while (nextBlock < blocks.length) {
      const b = blocks[nextBlock];
      const first = b?.[0];
      if (b === undefined || first === undefined || first.seq > beforeSeq) return;
      if (turn !== null) {
        images(turn.key, turn.images, turn.imagesAt);
        strip(turn.key, turn.cards, false);
        turn = null;
      }
      out.push({ kind: 'superseded', key: `sup:${first.id}`, at: later(first.createdAt), messages: b });
      nextBlock += 1;
    }
  };
  for (const row of rows) {
    fold(row.kind === 'message' ? row.m.seq : (row.items[0]?.seq ?? 0));
    const key = row.kind === 'message' ? `m:${row.m.id}` : `t:${row.items[0]?.id ?? ''}`;
    if (turn === null || (row.kind === 'message' && row.m.role === 'user')) {
      if (turn !== null) {
        images(turn.key, turn.images, turn.imagesAt);
        strip(turn.key, turn.cards, false);
      }
      turn = { key, cards: [], images: [], imagesAt: '' };
    }
    out.push({ kind: 'row', key, at: later(rowAt(row)), row });
    turn.cards.push(...row.drafts.map(draftCard));
    for (const q of questionsOf(row.kind === 'message' ? [row.m] : row.items))
      turn.cards.push(questionCard(q, messages));
    if (row.kind === 'tools') {
      turn.cards.push(...planCards(row.items, messages));
      for (const m of row.items) {
        if (m.role !== 'tool' || m.meta === null) continue;
        const shown = parseChatImages(m.meta.images);
        if (shown.length === 0) continue;
        // The same image shown twice in one turn appears once.
        const id = (x: ChatImage): string => `${x.jobId}:${x.source === 'output' ? x.artifactId : x.path}`;
        const have = new Set(turn.images.map(id));
        for (const x of shown) {
          if (have.has(id(x))) continue;
          have.add(id(x));
          turn.images.push(x);
        }
        turn.imagesAt = m.createdAt;
      }
    }
  }
  if (turn !== null) {
    images(turn.key, turn.images, turn.imagesAt);
    strip(turn.key, turn.cards, detail.turn !== null);
  }
  fold(Number.MAX_SAFE_INTEGER);
  return out;
}

/** The words and formatters a day label is said with (the caller's language; Turkish by default). */
export interface DayWords {
  readonly t: Messages;
  readonly f: Formatter;
}

const TR_DAY: DayWords = { t: messagesFor('tr'), f: TR_FORMAT };

/** "Bugün, Pazartesi 19 Ekim" / "Dün, Pazar 18 Ekim" / "Cumartesi 17 Ekim" ("Today, Monday 19 October" in English). */
export function dayLabel(iso: string, now: Date = new Date(), words: DayWords = TR_DAY): string {
  const d = new Date(iso);
  const { t, f } = words;
  const weekday = f.dateWith(d, { weekday: 'long' });
  const date = f.dateWith(d, { day: 'numeric', month: 'long' });
  const text = `${weekday.charAt(0).toLocaleUpperCase(f.locale === 'tr' ? 'tr-TR' : 'en-GB')}${weekday.slice(1)} ${date}`;
  const start = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return t.home.day.today({ date: text });
  if (days === 1) return t.home.day.yesterday({ date: text });
  return text;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1)}-${String(d.getDate())}`;
}

/** Merges ops items (oldest first) and chat items (conversation order) by time; ties keep system events first. */
export function buildTimeline(
  ops: readonly OpsItem[],
  chat: readonly TimelineItem[],
  now: Date = new Date(),
  words: DayWords = TR_DAY,
): TimelineItem[] {
  const a: TimelineItem[] = ops.map((item) => ({ kind: 'ops', key: item.id, at: item.at, item }));
  const merged: TimelineItem[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < chat.length) {
    const x = a[i];
    const y = chat[j];
    if (y === undefined || (x !== undefined && Date.parse(x.at) <= Date.parse(y.at))) {
      if (x !== undefined) merged.push(x);
      i++;
    } else {
      merged.push(y);
      j++;
    }
  }
  const out: TimelineItem[] = [];
  let day = '';
  for (const t of merged) {
    const k = dayKey(t.at);
    if (k !== day && !Number.isNaN(Date.parse(t.at))) {
      day = k;
      out.push({ kind: 'day', key: `day:${k}`, at: t.at, label: dayLabel(t.at, now, words) });
    }
    out.push(t);
  }
  return out;
}

/** Failures stay decisions for a day (the classic Home "Needs you" window, and the master's open set). */
export const FAILED_WINDOW_MS = 24 * 3600_000;

/** Is this thread item an open decision (counts toward "1 / 5" and the pinned summary)? */
export function isOpenDecision(item: OpsItem, now: number, dismissed: ReadonlySet<string>): boolean {
  switch (item.type) {
    case 'approval:request':
      return item.approval.status === 'pending';
    case 'deploy:action':
      return item.deploy.state === 'awaiting_approval';
    case 'merge:integration':
      return (
        item.merge.state === 'ready' || item.merge.state === 'needs_human' || item.merge.state === 'failed'
      );
    case 'job:failed':
      return (
        !dismissed.has(`failed:${item.job.id}`) &&
        now - Date.parse(item.job.stateChangedAt) <= FAILED_WINDOW_MS
      );
    case 'limit:paused':
      return Date.parse(item.limit.resumeAt) > now;
    case 'workflow:approval':
      return item.approval.state === 'waiting';
    default:
      return false;
  }
}
