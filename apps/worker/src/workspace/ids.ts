import { InvalidWorkspaceIdError } from './errors.js';

/**
 * Ids become path segments (`<root>/jobs/<jobId>/<attemptId>`) and git ref
 * components (`rac/<jobId>/<attemptId>`). The protocol `Identifier` also allows
 * `:` and `..`, which are neither safe path segments nor valid ref components, so
 * the workspace applies a stricter alphabet and refuses instead of escaping.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function assertSafeSegment(field: string, value: string): void {
  if (!SEGMENT.test(value)) {
    throw new InvalidWorkspaceIdError(
      field,
      'must be 1-128 characters of [A-Za-z0-9_.-], starting with a letter or digit',
    );
  }
  if (value.includes('..')) throw new InvalidWorkspaceIdError(field, 'must not contain ".."');
  if (value.endsWith('.') || value.toLowerCase().endsWith('.lock')) {
    throw new InvalidWorkspaceIdError(field, 'must not end with "." or ".lock"');
  }
}

export function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new InvalidWorkspaceIdError('epoch', 'must be a non-negative safe integer');
  }
}

/** ADR-0004 §3: the only branch a job attempt may push. */
export function attemptBranch(jobId: string, attemptId: string): string {
  assertSafeSegment('jobId', jobId);
  assertSafeSegment('attemptId', attemptId);
  return `rac/${jobId}/${attemptId}`;
}

export const ATTEMPT_TRAILER_KEY = 'Remyral-Attempt';

/** Trailer value `<attemptId>/<epoch>` (ADR-0004 §3 idempotency key). */
export function attemptTrailerValue(attemptId: string, epoch: number): string {
  assertSafeSegment('attemptId', attemptId);
  assertEpoch(epoch);
  return `${attemptId}/${String(epoch)}`;
}

const TRAILER_LINE = new RegExp(`^${ATTEMPT_TRAILER_KEY}\\s*:`, 'i');

/**
 * Returns `message` with exactly one `Remyral-Attempt: <attemptId>/<epoch>` trailer.
 * Any existing `Remyral-Attempt` lines (e.g. written by the agent, which is
 * untrusted) are removed first, so an attempt cannot claim another's identity.
 */
export function withAttemptTrailer(message: string, attemptId: string, epoch: number): string {
  const value = attemptTrailerValue(attemptId, epoch);
  const lines = message
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !TRAILER_LINE.test(line));
  while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
  if (lines.length === 0) throw new InvalidWorkspaceIdError('commit message', 'must not be empty');
  const last = lines.at(-1) ?? '';
  // Join an existing trailer block (`Key: value` lines after a blank line), else start one.
  const lastParagraphStart = lines.lastIndexOf('');
  const inTrailerBlock =
    lastParagraphStart > 0 &&
    lines.slice(lastParagraphStart + 1).every((l) => /^[A-Za-z0-9-]+:\s/.test(l)) &&
    /^[A-Za-z0-9-]+:\s/.test(last);
  return `${lines.join('\n')}${inTrailerBlock ? '\n' : '\n\n'}${ATTEMPT_TRAILER_KEY}: ${value}\n`;
}
