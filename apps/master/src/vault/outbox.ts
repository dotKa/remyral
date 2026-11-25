import { z } from 'zod';

/**
 * Credential vault events on the shared outbox (p5-credentials-models). Identifiers only — never a value or a
 * ciphertext; consumers re-read Postgres.
 */
export const OUTBOX_TOPIC_VAULT = 'vault.credential';
export const VaultOutboxPayload = z.strictObject({
  event: z.enum(['created', 'rotated', 'unshared', 'revoked', 'rejected', 'key_changed']),
  credentialId: z.string().max(64).optional(),
  workerId: z.string().max(128).optional(),
  version: z.number().int().min(1).optional(),
  reason: z
    .string()
    .regex(/^[a-z0-9_]{1,64}$/)
    .optional(),
});
export type VaultOutboxPayload = z.infer<typeof VaultOutboxPayload>;
