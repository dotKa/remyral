import type { User } from '../api/auth';

export function recoveryCodesText(user: User, codes: readonly string[], now: Date = new Date()): string {
  return [
    'Remyral recovery codes',
    `Account: ${user.username}`,
    `Generated: ${now.toISOString()}`,
    '',
    'Each code works once, instead of an authenticator code. Keep this file offline or in a password',
    'manager, not on the phone that holds your authenticator app.',
    '',
    ...codes,
    '',
  ].join('\n');
}
