/**
 * p22-run-attention (docs/design/p22-run-attention.md): an agent step that ended "succeeded" but could not do what it
 * was asked says so on one line of its final answer:
 *
 *   OUTCOME: partial — <what was not done and why>
 *   OUTCOME: none — <why nothing could be done>
 *
 * The master reads it from the step's result summary with this parser (the same rule for every runtime) and marks the
 * workflow run "needs attention", so the person and the assistant can tell a real result from an empty one. Untrusted
 * agent text: it only ever lowers a result's standing, never raises it or grants anything. Pure.
 */

export type StepOutcomeKind = 'partial' | 'none';

export interface StepOutcome {
  readonly kind: StepOutcomeKind;
  /** One plain line (bounded). */
  readonly note: string;
}

export const MAX_STEP_OUTCOME_NOTE = 300;
const MAX_SCAN = 64 * 1024;

// Upper-case keyword at the start of a line (optionally a bullet / bold), like LESSON:. The value words are fixed.
const LINE =
  /^\s{0,3}(?:[-*•]\s+)?(?:\*\*)?OUTCOME(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(partial|none|ok|done|PARTIAL|NONE|OK|DONE)\b(?:\*\*)?\s*(?:[—–:-]\s*)?(.*)$/u;
const FENCE = /^\s{0,3}(```|~~~)/u;

function tidy(s: string): string {
  return s
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The step's declared outcome, or null (no line, or `OUTCOME: ok` / `done`). The LAST such line outside fenced code
 * blocks wins (an agent may correct itself).
 */
export function parseStepOutcome(text: string): StepOutcome | null {
  let found: StepOutcome | null = null;
  let inFence = false;
  for (const raw of text.slice(-MAX_SCAN).split(/\r?\n/u)) {
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = LINE.exec(raw);
    if (m?.[1] === undefined) continue;
    const word = m[1].toLowerCase();
    if (word === 'ok' || word === 'done') {
      found = null;
      continue;
    }
    let note = tidy(m[2] ?? '');
    if (/^<.*>$/u.test(note)) note = '';
    if (note.length > MAX_STEP_OUTCOME_NOTE) note = `${note.slice(0, MAX_STEP_OUTCOME_NOTE - 1)}…`;
    found = { kind: word === 'none' ? 'none' : 'partial', note };
  }
  return found;
}

/** What an agent step is told (appended to every workflow AI step's task header). */
export const STEP_OUTCOME_NOTE =
  'If you could NOT fully do what this task asks — part of it was left undone, or nothing could be done (missing or ' +
  'incomplete input, a refused tool, nothing to change) — end your final answer with ONE line of its own: ' +
  '"OUTCOME: partial — <what was not done and why>" or "OUTCOME: none — <why nothing could be done>". ' +
  'Leave it out when the task was done. Never invent missing data to avoid it.';
