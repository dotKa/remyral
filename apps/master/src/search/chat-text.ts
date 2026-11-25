import { scanForSecrets } from '@remyral/memory';
import { DEFAULT_RULES, Redactor } from '@remyral/observability';

/**
 * p10-semantic-defaults-chat (docs/design/p10-semantic-memory.md §12.3): what of a chat message is embedded and how
 * it is cut. Deterministic, so the indexer and the snippet reader (which re-cuts the live message, no text is stored
 * with a vector) agree on chunk N.
 */

/** Characters per chunk (Cohere v3 takes ≤ 2048 per text; a smaller chunk keeps one topic per vector). */
export const CHAT_CHUNK_CHARS = 1500;
/** Chunks per message part (the rest of a very long message is not indexed). */
export const MAX_CHAT_CHUNKS = 16;
/** Text attachments larger than this are not indexed (by design, only small ones are). */
export const MAX_INDEXED_ATTACHMENT_BYTES = 16 * 1024;
export const CHAT_SNIPPET_CHARS = 240;

const redactor = new Redactor({ rules: DEFAULT_RULES });

/** The message text as it may leave the system: secret patterns replaced, whitespace tidied. */
export function redactChatText(text: string): string {
  return redactor
    .redact(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the (already redacted) text still looks like it carries a secret: such a chunk is never sent. */
export function stillSecret(text: string): boolean {
  return scanForSecrets({ text }).length > 0;
}

/** Cut at the last paragraph / line / sentence / word boundary before `max` (never inside a surrogate pair). */
function cutAt(text: string, max: number): number {
  if (text.length <= max) return text.length;
  const window = text.slice(0, max);
  for (const sep of ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' ']) {
    const i = window.lastIndexOf(sep);
    if (i >= max * 0.5) return i + sep.length;
  }
  return /[\uD800-\uDBFF]$/.test(window) ? max - 1 : max;
}

/**
 * Chunks of a (redacted) message: paragraphs packed up to `max` characters, a longer paragraph cut at a sentence or
 * word boundary; at most {@link MAX_CHAT_CHUNKS}. Empty text: no chunks.
 */
export function chatChunks(text: string, max = CHAT_CHUNK_CHARS): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > 0 && out.length < MAX_CHAT_CHUNKS) {
    const n = cutAt(rest, max);
    const chunk = rest.slice(0, n).trim();
    if (chunk.length > 0) out.push(chunk);
    rest = rest.slice(n).trim();
  }
  return out;
}

/** Snippet of chunk `i` of a message (redacted), for display. */
export function chatSnippet(content: string, chunk: number, max = CHAT_SNIPPET_CHARS): string {
  const chunks = chatChunks(redactChatText(content));
  const c = chunks[Math.min(Math.max(chunk, 0), Math.max(chunks.length - 1, 0))] ?? '';
  return c.length > max ? `${c.slice(0, max - 1)}…` : c;
}

/** A keyword snippet: around the first matching term, redacted. */
export function keywordSnippet(content: string, terms: readonly string[], max = CHAT_SNIPPET_CHARS): string {
  const text = redactChatText(content);
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at - Math.floor(max / 3));
  const s = text.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${s}${start + max < text.length ? '…' : ''}`;
}

/**
 * p18-leftovers: the searchable text of a plan — its title, goal and, per phase, the phase title and the items' titles
 * and details (deleted items not; never a decision answer, a note or a link). Deterministic, so the indexer and the
 * snippet reader agree on chunk N.
 */
export function planSearchText(
  plan: { readonly title: string; readonly goal: string },
  items: readonly {
    readonly phase: number;
    readonly phaseTitle: string;
    readonly position: number;
    readonly title: string;
    readonly detail: string | null;
  }[],
): string {
  const lines = [plan.title, plan.goal];
  let phase = -1;
  for (const i of [...items].sort((a, b) => a.phase - b.phase || a.position - b.position)) {
    if (i.phase !== phase) {
      phase = i.phase;
      lines.push('', i.phaseTitle);
    }
    lines.push(`- ${i.title}${i.detail === null || i.detail.trim() === '' ? '' : `: ${i.detail}`}`);
  }
  return lines.join('\n');
}
