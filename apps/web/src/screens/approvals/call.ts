/**
 * p10-approval-readable (docs/design/p10-approval-readable.md §5): a readable approval card. The agent's own
 * description comes first, labelled as its unverified claim; then the command exactly as it will run (unescaped,
 * wrapped, collapsed after 12 lines, copyable, optionally broken at its top-level separators); then the other fields;
 * then a static "what this touches" reading. Every string is untrusted runtime text and is rendered as React text only.
 */

export const COLLAPSE_LINES = 12;
