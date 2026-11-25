import type { WatchLanguage } from './watches.js';

/**
 * p18-plan-mode W4 (docs/design/p18-plan-mode.md, "Implementation (W4)"): the `chat.plan` notifications of a plan's owner —
 * the texts and the dedupe keys (pure; the service sends them through the notification path, so the owner's channel
 * preferences apply and one occurrence is one notification).
 *
 *  - `decision`: the assistant asked decisions (one per turn, however many it asked);
 *  - `blocked`: the assistant blocked an item with a reason (it cannot go on by itself), or an item failed its retries;
 *  - `waiting`: the plan waits for the owner — an item's card must be confirmed (one per card), or "Plana devam edeyim
 *    mi?" (cost brake, budget, no progress, a failed turn; one per stall);
 *  - `review`: the assistant changed the structure of an approved plan — it is back in review (one per version);
 *  - `done`: the plan is done (once);
 *  - `ready` (p18-leftovers): a plan was first written and its card waits for the owner's review (once per plan; a
 *    replacing plan is a new plan).
 *
 * Plan and item titles are model / person text: plain, bounded by the notification sanitizer; never the decision text
 * beyond its prompt's first 200 characters.
 */
export type PlanNoticeKind = 'decision' | 'blocked' | 'waiting' | 'review' | 'done' | 'ready';

export interface PlanNotice {
  readonly severity: 'info' | 'warning';
  readonly title: string;
  readonly body: string;
  readonly dedupeKey: string;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function planNotice(
  kind: PlanNoticeKind,
  lang: WatchLanguage,
  p: { readonly planId: string; readonly title: string },
  x: {
    /** What makes the occurrence unique (turn id, item key + revision, draft id, version, stall reason + revision). */
    readonly occurrence: string;
    readonly item?: string | null | undefined;
    readonly note?: string | null | undefined;
    readonly prompt?: string | null | undefined;
    readonly count?: number | undefined;
  },
): PlanNotice {
  const tr = lang === 'tr';
  const title = clip(p.title, 120);
  const item = x.item == null ? null : clip(x.item, 140);
  const note = x.note == null || x.note.trim() === '' ? null : clip(x.note, 300);
  const key = `chat.plan:${p.planId}:${kind}:${x.occurrence}`;
  switch (kind) {
    case 'decision': {
      const n = Math.max(1, x.count ?? 1);
      const prompt = x.prompt == null ? '' : clip(x.prompt, 200);
      return {
        severity: 'warning',
        title: tr ? `Plan senden karar bekliyor: ${title}` : `Your plan needs a decision: ${title}`,
        body: tr
          ? `${n > 1 ? `${String(n)} karar` : 'Bir karar'} bekliyor${prompt === '' ? '.' : `: “${prompt}”`}`
          : `${n > 1 ? `${String(n)} decisions wait` : 'A decision waits'}${prompt === '' ? '.' : `: “${prompt}”`}`,
        dedupeKey: key,
      };
    }
    case 'blocked':
      return {
        severity: 'warning',
        title: tr ? `Plan engellendi: ${title}` : `Plan blocked: ${title}`,
        body: tr
          ? `“${item ?? '—'}” ilerleyemiyor${note === null ? '.' : `: ${note}`}`
          : `“${item ?? '—'}” cannot go on${note === null ? '.' : `: ${note}`}`,
        dedupeKey: key,
      };
    case 'waiting':
      return {
        severity: 'warning',
        title: tr ? `Plan senden bekliyor: ${title}` : `Your plan waits for you: ${title}`,
        body:
          item !== null
            ? tr
              ? `“${item}” için bir kartı onaylaman gerekiyor.`
              : `A card for “${item}” needs your confirmation.`
            : tr
              ? `Plan kendi başına devam edemiyor${note === null ? '' : ` (${note})`}: sohbetten “Devam et”.`
              : `The plan cannot go on by itself${note === null ? '' : ` (${note})`}: “Continue” in the conversation.`,
        dedupeKey: key,
      };
    case 'review':
      return {
        severity: 'warning',
        title: tr ? `Plan yeniden incelemede: ${title}` : `Plan back in review: ${title}`,
        body: tr
          ? `Asistan onaylı planı değiştirdi${note === null ? '' : ` (${note})`}; yürütme yeniden onaylamanı bekliyor.`
          : `The assistant changed the approved plan${note === null ? '' : ` (${note})`}; execution waits for your approval.`,
        dedupeKey: key,
      };
    case 'ready': {
      const n = Math.max(0, x.count ?? 0);
      return {
        severity: 'info',
        title: tr ? `Plan incelemeni bekliyor: ${title}` : `Your plan is ready for review: ${title}`,
        body: tr
          ? `Asistan ${n > 0 ? `${String(n)} maddelik ` : ''}bir plan yazdı; onayla, değişiklik iste ya da vazgeç.`
          : `The assistant wrote a plan${n > 0 ? ` of ${String(n)} items` : ''}; approve it, ask for changes or drop it.`,
        dedupeKey: key,
      };
    }
    case 'done':
      return {
        severity: 'info',
        title: tr ? `Plan tamamlandı: ${title}` : `Plan done: ${title}`,
        body: tr
          ? 'Planın bütün maddeleri bitti ya da atlandı.'
          : 'Every item of the plan is done or skipped.',
        dedupeKey: key,
      };
  }
}
