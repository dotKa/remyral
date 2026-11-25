import { canAnimate, MOTION_FALLBACK, motionOff, tokenEase, tokenMs } from '../motionKit';

/**
 * p17-chat-send-motion (docs/design/p17-panel-motion.md §3.6): the person's message on its way from the composer to
 * the thread. While `POST …/messages` runs, the Sohbet thread shows a pending bubble ("Gönderiliyor…", no tail yet);
 * it lands from the composer's place (a short FLIP: rise + scale, transform and opacity only). When the sent message
 * comes back from the master it takes the pending bubble's place under the same thread key (no second entrance): its
 * corner grows the tail and its time line fades in. A failed send removes the pending bubble; the composer keeps the
 * text and shakes once.
 */

export interface PendingSend {
  /** Changes on every send (the pending row's key). */
  readonly n: number;
  /** What the bubble shows (the text that was sent). */
  readonly text: string;
  /** The id of the newest user message when the send started: a newer one is this send, back from the master. */
  readonly before: string | null;
  /** Where the text sat in the composer (viewport), or null (a suggestion chip, an "Asistana sor" question). */
  readonly from: SendOrigin | null;
  /** The master took it (the send resolved): the record only lives on for the render that settles the message. */
  readonly done?: boolean | undefined;
}

export interface SendOrigin {
  readonly top: number;
  readonly right: number;
}

/** The thread key of a pending send (and of the sent message that takes its place). */
export function pendingKey(n: number): string {
  return `pending:${String(n)}`;
}

/** At most this far (px) below its place the bubble starts: a short rise, never a flight across the screen. */
export const SEND_RISE_MAX = 160;
/** …and at most this far to the side. */
const SEND_SIDE_MAX = 24;

/** Where the composer's text sits now (the field of `root`'s composer), or null when there is none. */
export function composerOrigin(root: ParentNode | null): SendOrigin | null {
  const field = root?.querySelector<HTMLElement>('[data-chat-composer]') ?? null;
  if (field === null) return null;
  const r = field.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, right: r.right };
}

/**
 * Lands the pending bubble `el` from `from` (FLIP: it is already in its final place; it starts translated back towards
 * the composer, a little smaller and fainter, and eases to its place over --dy-m-enter). Returns false when it did not
 * animate (motion off, no Web Animations, no origin) — the bubble's CSS entrance (`dy-m-send`) then runs instead,
 * which reduced motion turns off. Called after the thread scrolled to its end, so both places are current.
 */
export function landSend(el: HTMLElement, from: SendOrigin | null): boolean {
  if (from === null || motionOff(el) || !canAnimate(el)) return false;
  const to = el.getBoundingClientRect();
  const dy = Math.max(0, Math.min(SEND_RISE_MAX, from.top - to.top));
  const dx = Math.max(-SEND_SIDE_MAX, Math.min(SEND_SIDE_MAX, from.right - to.right));
  el.dataset.flown = '';
  const start = `translate(${String(dx)}px,${String(dy)}px) scale(0.96)`; // i18n-ignore: CSS transform value
  el.animate(
    [
      { transform: start, opacity: 0.4 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: tokenMs(el, '--dy-m-enter', MOTION_FALLBACK.enter), easing: tokenEase(el) },
  );
  return true;
}
