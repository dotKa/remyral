import { type Messages, messagesFor } from '@remyral/i18n';
import type { DyState } from '../../StateBadge';

/**
 * p12-diyalog Faz 4 (Projeler): job and ops-action states in the Diyalog state vocabulary — the tone / icon family
 * plus the precise word (the badge always shows a word, never colour alone). The words come from the `projects`
 * catalog (p14-i18n-screens-c); callers without the hook pass nothing and get Turkish.
 */
type Words = Messages['projects'];
const TR: Words = messagesFor('tr').projects;

const JOB: Readonly<Record<string, DyState>> = {
  DRAFT: 'queued',
  QUEUED: 'queued',
  RESERVED: 'queued',
  STARTING: 'running',
  RUNNING: 'running',
  VERIFYING: 'running',
  AWAITING_APPROVAL: 'needs',
  SUCCEEDED: 'done',
  RETRY_WAIT: 'queued',
  FAILED: 'failed',
  CANCELLING: 'cancelled',
  CANCELLED: 'cancelled',
  BLOCKED: 'needs',
  LOST: 'failed',
  PAUSED: 'paused',
};

export function jobState(
  state: string,
  words: Words = TR,
): { readonly state: DyState; readonly label: string } {
  const s = JOB[state];
  const label = (words.jobStates as Readonly<Record<string, string>>)[state];
  return s === undefined || label === undefined ? { state: 'queued', label: state } : { state: s, label };
}

export const RUNNING_STATES: ReadonlySet<string> = new Set(['STARTING', 'RUNNING', 'VERIFYING']);
export const FAILED_STATES: ReadonlySet<string> = new Set(['FAILED', 'LOST']);

const OPS: Readonly<Record<string, DyState>> = {
  awaiting_approval: 'needs',
  refused: 'failed',
  denied: 'cancelled',
  expired: 'cancelled',
  executing: 'running',
  deploying: 'running',
  succeeded: 'done',
  failed: 'failed',
};

export function opsState(
  state: string,
  words: Words = TR,
): { readonly state: DyState; readonly label: string } {
  const s = OPS[state];
  const label = (words.opsStates as Readonly<Record<string, string>>)[state];
  return s === undefined || label === undefined ? { state: 'queued', label: state } : { state: s, label };
}

/** Account / project role words of `words` (Turkish by default). */
export function roleText(role: string, words: Words = TR): string {
  return (words.roles as Readonly<Record<string, string>>)[role] ?? role;
}

/** Project kind words of `words` (Turkish by default). */
export function kindText(kind: string, words: Words = TR): string {
  return (words.kinds as Readonly<Record<string, string>>)[kind] ?? kind;
}

/** Turkish role words, for callers outside Projeler that have not moved to the catalog yet. */
export const ROLE_TEXT: Readonly<Record<string, string>> = TR.roles;
