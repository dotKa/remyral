import { type Messages, messagesFor } from '@remyral/i18n';
import { STEP_UP_SESSION_ENDED } from '../../api/auth';
import { PENDING_LOGIN_ENDED, SESSION_ENDED } from '../../auth/AuthProvider';

/**
 * p12-diyalog-w4: the AuthProvider's session-ended notices in the user's language for the Diyalog sign-in screens
 * (i18n Phase 2: from the `auth.notice` catalog). The provider keeps its English constants (the classic screens and
 * their tests); any other text — a message the master phrased — passes through unchanged.
 */
const EVERYWHERE = /^Signed out everywhere \((\d+) sessions? ended\)\.$/;

export function noticeText(notice: string, t: Messages['auth']['notice']): string {
  const known: Readonly<Record<string, string>> = {
    [PENDING_LOGIN_ENDED]: t.pendingLoginEnded,
    [SESSION_ENDED]: t.sessionEnded,
    [STEP_UP_SESSION_ENDED]: t.stepUpSessionEnded,
    'You are signed out.': t.signedOut,
  };
  const hit = known[notice];
  if (hit !== undefined) return hit;
  const m = EVERYWHERE.exec(notice);
  if (m !== null) return t.signedOutEverywhere({ n: m[1] ?? '0' });
  return notice;
}

/** The Turkish form (kept for callers and tests that ask for Turkish explicitly). */
export function noticeTr(notice: string): string {
  return noticeText(notice, messagesFor('tr').auth.notice);
}
