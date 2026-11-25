/**
 * p14-i18n-reasons (i18n Phase 4): what a reason sentence may name — the runtime's display name ("Claude Code") and
 * the machine's display name ("mac-1"), each null when the screen does not know it (the sentence then says "this
 * runtime" / "this machine"). Both are untrusted text (worker names): interpolated as text only.
 */
export interface ReasonVars {
  readonly runtime: string | null;
  readonly machine: string | null;
}
