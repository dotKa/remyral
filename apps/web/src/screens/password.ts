/** Mirrors the master's policy minimum (ADR-0009 §3); the master remains the authority (common list etc.). */
export const MIN_PASSWORD_LENGTH = 12;

export interface NewPasswordErrors {
  newPassword?: string;
  confirmation?: string;
}

/** Client-side checks before the request: length (code points) and confirmation. */
export function validateNewPassword(newPassword: string, confirmation: string): NewPasswordErrors {
  const errors: NewPasswordErrors = {};
  if (Array.from(newPassword).length < MIN_PASSWORD_LENGTH) {
    errors.newPassword = `Use at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }
  if (confirmation !== newPassword) errors.confirmation = 'The passwords do not match.';
  return errors;
}
