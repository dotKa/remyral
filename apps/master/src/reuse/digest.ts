import { createHash } from 'node:crypto';

/**
 * p6-result-reuse (docs/design/p6-result-reuse.md §2): digests that identify "the same job" before dispatch. Pure.
 *
 * - prompt: Unicode NFC, lower case, every whitespace run collapsed to one space, trimmed. "Fix the README" and
 *   "  fix   the\nreadme " are the same prompt; anything else (punctuation, wording) is a different one. The offer is
 *   always explicit, so a case-only difference that matters (an identifier) is the user's call.
 * - inputs (workspace jobs): the sorted (name, sha256) pairs of the input files — content and name, never the
 *   upload order or where a file came from (upload, continued artifact).
 *
 * Versioned (`v1`) so a later normalisation change never matches jobs digested the old way.
 */

const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function normalisePrompt(prompt: string): string {
  return prompt.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

export function promptDigest(prompt: string): string {
  return sha256(`remana-prompt-v1\n${normalisePrompt(prompt)}`);
}

/** Workflow steps: the run id is part of every step prompt (header, `{{run.id}}`); masked so runs can match. */
export function workflowStepPromptDigest(prompt: string, runId: string): string {
  return promptDigest(runId === '' ? prompt : prompt.split(runId).join('{run}'));
}

export interface InputFingerprint {
  readonly name: string;
  readonly sha256: string;
}

export function inputsDigest(inputs: readonly InputFingerprint[]): string {
  const pairs = inputs
    .map((i) => [i.name, i.sha256.toLowerCase()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return sha256(`remana-inputs-v1\n${JSON.stringify(pairs)}`);
}

export function isDigest(v: unknown): v is string {
  return typeof v === 'string' && DIGEST.test(v);
}

/** "2 h ago", "35 min ago", "just now" — the offer's wording (master side: chat drafts, run reasons). */
export function ageText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${String(min)} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${String(h)} h ago`;
  return `${String(Math.floor(h / 24))} days ago`;
}
