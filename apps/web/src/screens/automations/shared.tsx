// ------------------------------------------------------------------- p6-automation-defaults (design §11a)

/** Approval policies that make an unattended run wait for a person. */
export function asksHuman(policy: string | null | undefined): boolean {
  return policy === 'ask-sensitive' || policy === 'ask-all';
}
