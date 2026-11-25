import { createHash } from 'node:crypto';
import { MAX_TEXT } from '@remyral/protocol';
import { redactSecrets, type SecretEnv } from '../../secrets.js';

/** Default length of free-text summaries (tool input/output) carried in events. */
export const SUMMARY_CHARS = 2_000;

/** Truncate to `max` UTF-16 units, marking the cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '…[truncated]';
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/**
 * Every text that leaves an adapter in an event, result or note passes through
 * here: secret values of the job are replaced (ADR-0006, defence in depth — the
 * runtime may echo an env var) and the result fits the protocol `Text` bound.
 */
export function eventText(text: string, secrets: SecretEnv, max: number = MAX_TEXT): string {
  return truncate(redactSecrets(text, secrets), max);
}

/** Compact, single-line summary of a tool input or other structured value. */
export function summarize(value: unknown, secrets: SecretEnv, max: number = SUMMARY_CHARS): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      // JSON.stringify returns undefined for undefined/functions despite its declared type.
      const json: unknown = JSON.stringify(value);
      text = typeof json === 'string' ? json : '';
    } catch {
      text = '[unserializable]';
    }
  }
  return eventText(text, secrets, max);
}

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Map a runtime-provided id onto the protocol `Identifier` alphabet. Ids that
 * already conform are kept unchanged; others are sanitized and suffixed with a
 * short hash of the original so distinct ids stay distinct.
 */
export function toIdentifier(raw: string): string {
  if (IDENTIFIER.test(raw)) return raw;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128 - hash.length - 1);
  return `${cleaned.length > 0 ? cleaned : 'id'}-${hash}`;
}

const PROVIDER = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$/;

/** Provider id if it fits the protocol `usage.provider` pattern, else undefined (never a wrong value). */
export function protocolProvider(value: unknown): string | undefined {
  return typeof value === 'string' && PROVIDER.test(value) ? value : undefined;
}

/** Model id if it fits the protocol `usage.model` pattern, else undefined. */
export function protocolModel(value: unknown): string | undefined {
  return typeof value === 'string' && MODEL.test(value) ? value : undefined;
}

/** Non-negative integer or undefined (token counts from runtimes are untrusted input). */
export function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}
