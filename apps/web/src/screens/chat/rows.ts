import type { ChatDraft, ChatMessage } from '../../api/chat';

// p14-web-perf: the transcript grouping is pure; a module of its own so the Diyalog home (ops timeline) does not
// load the classic message renderers.

export type Row =
  | { readonly kind: 'message'; readonly m: ChatMessage; readonly drafts: ChatDraft[] }
  | { readonly kind: 'tools'; readonly items: ChatMessage[]; readonly drafts: ChatDraft[] };

/**
 * Groups consecutive tool messages and attaches each draft to the message (or tool group) that made it
 * (`meta.draftId` on the tool line). `messages` is the whole loaded transcript and `hidden` how many of its
 * oldest messages sit behind "Show earlier messages" (p9-chat-card-order): a draft anchored to a hidden
 * message stays hidden with it instead of falling to the bottom of the conversation. A draft whose anchor is
 * not loaded at all (an older server-side window) is placed by its creation time, so a card never moves when
 * newer messages arrive or its state changes; `leading` are those older than every shown message.
 */
export function buildRows(
  messages: readonly ChatMessage[],
  drafts: readonly ChatDraft[],
  hidden = 0,
): {
  rows: Row[];
  leading: ChatDraft[];
} {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const anchored = new Set<string>();
  for (const m of messages) {
    const id = typeof m.meta?.draftId === 'string' ? m.meta.draftId : null;
    if (id !== null && byId.has(id)) anchored.add(id);
  }
  const used = new Set<string>();
  const draftOf = (m: ChatMessage): ChatDraft[] => {
    const id = typeof m.meta?.draftId === 'string' ? m.meta.draftId : null;
    const d = id === null ? undefined : byId.get(id);
    if (d === undefined || used.has(d.id)) return [];
    used.add(d.id);
    return [d];
  };
  const visible = messages.slice(hidden);
  // Drafts without a loaded anchor, oldest first, slotted in after the last message created before them.
  const loose = drafts
    .filter((d) => !anchored.has(d.id))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let next = 0;
  const takeLoose = (before: string | null): ChatDraft[] => {
    const out: ChatDraft[] = [];
    const limit = before === null ? Number.POSITIVE_INFINITY : Date.parse(before);
    while (next < loose.length) {
      const d = loose[next];
      if (d === undefined || !(Date.parse(d.createdAt) < limit)) break;
      out.push(d);
      next += 1;
    }
    return out;
  };
  // Loose drafts older than the first shown message: shown above it only when nothing earlier is hidden.
  const before = takeLoose(visible[0]?.createdAt ?? null);
  const leading = hidden === 0 ? before : [];
  const rows: Row[] = [];
  visible.forEach((m, i) => {
    const last = rows.at(-1);
    if (m.role === 'tool' && last?.kind === 'tools') {
      last.items.push(m);
      last.drafts.push(...draftOf(m));
    } else if (m.role === 'tool') rows.push({ kind: 'tools', items: [m], drafts: draftOf(m) });
    else rows.push({ kind: 'message', m, drafts: draftOf(m) });
    const row = rows.at(-1);
    row?.drafts.push(...takeLoose(visible[i + 1]?.createdAt ?? null));
  });
  if (visible.length === 0 && hidden === 0) leading.push(...takeLoose(null));
  return { rows, leading };
}
