import { useEffect, useRef, useState } from 'react';
import { motionOff } from '../motionKit';

/**
 * p19-chat-stream-motion: the answer being written shows at a steady pace instead of in the bursts the stream brings
 * (the worker sends what the model wrote every ~60 ms, a few words at a time). What arrived is revealed frame by frame:
 * at least {@link MIN_CPS} characters a second, faster the more is waiting (the backlog drains in {@link DRAIN_S}), so
 * the text never falls behind the stream. Once the turn ended (`done`) the rest drains at once-ish ({@link DONE_S}) —
 * the finished answer replaces the text a moment later. Text already there when the view opens (an answer being
 * written when the conversation is opened) stands still, and with less motion everything shows as it arrives.
 */
export const MIN_CPS = 90;
export const DRAIN_S = 0.35;
export const DONE_S = 0.12;
/** At most this often (ms) the revealed text re-renders (the answer's markdown is parsed on each). */
const FRAME_MS = 32;
/** A cut inside a word moves to its end when that is this close (no half words, fewer half `**marks**`). */
const WORD_MAX = 12;

/** How many characters to show after `dt` seconds: from `shown`, towards `total`. */
export function nextReveal(shown: number, total: number, dt: number, done: boolean): number {
  if (shown >= total) return total;
  const backlog = total - shown;
  const cps = Math.max(MIN_CPS, backlog / (done ? DONE_S : DRAIN_S));
  return Math.min(total, shown + Math.max(1, cps * dt));
}

/** `text` cut at `n` characters, moved to the end of the word it falls in when that is near. */
export function cutAt(text: string, n: number): string {
  if (n >= text.length) return text;
  const rest = text.slice(n, n + WORD_MAX);
  const end = rest.search(/\s/);
  return text.slice(0, end === -1 ? n : n + end);
}

export function useSmoothText(target: string, done: boolean): string {
  const [shown, setShown] = useState(target.length);
  const pos = useRef(target.length);
  const goal = useRef({ target, done });
  goal.current = { target, done };
  // A new answer (or a text that does not continue the shown one) starts from its beginning.
  if (pos.current > target.length) pos.current = 0;
  const total = target.length;

  // Restarted on every change of the text: the loop runs while it is behind and stops once it caught up.
  useEffect(() => {
    if (pos.current >= total) return;
    if (
      typeof requestAnimationFrame !== 'function' ||
      motionOff(document.querySelector('[data-ui="diyalog"]'))
    ) {
      pos.current = goal.current.target.length;
      setShown(pos.current);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let painted = 0;
    const step = (now: number): void => {
      const g = goal.current;
      pos.current = nextReveal(pos.current, g.target.length, (now - last) / 1000, g.done);
      last = now;
      const end = pos.current >= g.target.length;
      if (end || now - painted >= FRAME_MS) {
        painted = now;
        setShown(pos.current);
      }
      if (!end) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [total, done]);

  const n = Math.min(shown, pos.current);
  return n >= total ? target : cutAt(target, Math.floor(n));
}
