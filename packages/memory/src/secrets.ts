import { Redactor } from '@remyral/observability';

/** Where a secret-looking value was found. Never carries the value itself. */
export interface SecretFinding {
  readonly field: string;
  /** 1-based line and column (UTF-16 code units) of the start of the match. */
  readonly line: number;
  readonly column: number;
  /** Redaction rule id, e.g. `anthropic-key`, `pem-private-key`, `secret-assignment`. */
  readonly rule: string;
}

// Pattern rules only (DEFAULT_RULES); there are no exact values to match at the master.
const scanner = new Redactor();

function position(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) {
    line += 1;
    lineStart = i + 1;
  }
  return { line, column: index - lineStart + 1 };
}

/**
 * Scans every given text field with the `@remyral/observability` secret patterns (ADR-0006, T-SEC-1).
 * A non-empty result means the write must be rejected; nothing of the matched value is returned.
 */
export function scanForSecrets(fields: Readonly<Record<string, string | null | undefined>>): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const field of Object.keys(fields).sort()) {
    const text = fields[field];
    if (text === null || text === undefined || text.length === 0) continue;
    for (const span of scanner.spans(text)) {
      out.push({ field, ...position(text, span.start), rule: span.label });
    }
  }
  return out;
}
