import { redactSecrets, type SecretEnv } from '../../secrets.js';

/** Upper bound for free text copied from a runtime into an event (messages). */
export const MAX_MESSAGE_CHARS = 16 * 1024;
/** Upper bound for tool input/output summaries. */
export const MAX_SUMMARY_CHARS = 2 * 1024;

/**
 * Text that leaves the adapter (events, results): secret values redacted
 * (defence in depth on top of p3-secrets-worker) and bounded in size.
 */
export function boundedText(text: string, secrets: SecretEnv, max = MAX_MESSAGE_CHARS): string {
  const redacted = redactSecrets(text, secrets);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

/** One-line summary of an arbitrary tool input/output value. */
export function summarize(value: unknown, secrets: SecretEnv, max = MAX_SUMMARY_CHARS): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      // JSON.stringify returns undefined for undefined/functions/symbols despite its typing.
      const json = JSON.stringify(value) as string | undefined;
      text = json ?? String(value);
    } catch {
      text = '[unserialisable]';
    }
  }
  return boundedText(text.replace(/\s+/g, ' ').trim(), secrets, max);
}

/** Resolve `promise` or `undefined` after `ms`. Never rejects because of the timer. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
