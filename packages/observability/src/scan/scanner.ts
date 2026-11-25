import { createHash } from 'node:crypto';
import { Redactor } from '../redact/redactor.js';
import { DEFAULT_RULES, type RedactionRule } from '../redact/rules.js';

/**
 * Secret scanner for repositories and build output (p7-secrets-scan, gitleaks-equivalent). Uses the same
 * rules as runtime redaction (`DEFAULT_RULES`), so a format the redactor knows is also refused in Git:
 *
 *  - **strong** rules (vendor prefixes, PEM private keys, JWTs) always report;
 *  - **context** rules (`secret-assignment`, `url-credentials`, `authorization-header`, `bearer-token`)
 *    report only when the captured value looks random (entropy, length, mixed alphabet) — in source code
 *    `password: z.string()` or `token=${value}` are not secrets;
 *  - a **high-entropy** rule reports long random-looking quoted literals with no context at all.
 *
 * Findings never carry the value: only a short preview (first 4 characters + length) and a fingerprint
 * (rule + SHA-256 of the value) that allowlists can name without containing the secret.
 */
export interface ScanFinding {
  readonly rule: string;
  /** 1-based. */
  readonly line: number;
  readonly column: number;
  /** `abcd…(40)` — never the full value. */
  readonly preview: string;
  /** `<rule>:<first 16 hex of sha256(value)>`, stable across paths and line moves. */
  readonly fingerprint: string;
}

export interface ScanOptions {
  readonly rules?: readonly RedactionRule[];
  /** Minimum Shannon entropy (bits/char) of a context-rule value (default 3.5). */
  readonly minEntropy?: number;
  /** Minimum length of a context-rule value (default 16). */
  readonly minContextLength?: number;
  /** Report long random literals without context (default true). */
  readonly highEntropy?: boolean;
  /** Exact values that must never appear (canaries); reported as rule `canary`. */
  readonly canaries?: readonly string[];
}

/** A line containing this marker is never reported (like `gitleaks:allow`). */
export const ALLOW_MARKER = 'secret-scan: allow';

export const CONTEXT_RULE_IDS: ReadonlySet<string> = new Set([
  'secret-assignment',
  'url-credentials',
  'authorization-header',
  'bearer-token',
]);

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Property chains (`process.env.API_KEY`), template/placeholder syntax and plain words are not secrets. */
const NOT_A_VALUE =
  /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|\$\{.*\}?|<[^>]*>?|\{\{.*|%[A-Za-z_]+%?|[a-z]+(?:[_-][a-z]+)*|[A-Z]+(?:_[A-Z0-9]+)*)$/;

/** Does a captured context value look like a credential rather than code or a placeholder? */
export function looksRandom(value: string, minEntropy = 3.5, minLength = 16): boolean {
  const v = value.replace(/^["'`]|["'`]$/g, '');
  if (v.length < minLength || NOT_A_VALUE.test(v)) return false;
  if (/[()[\]{}\s]/.test(v)) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (/^(.)\1+$/.test(v) || /(?:x{6,}|X{6,}|\*{4,}|\.{3,})/.test(v)) return false;
  return shannonEntropy(v) >= minEntropy;
}

/** Quoted base64/base64url/hex-free literals of ≥ 40 characters with upper, lower and digits. */
const HIGH_ENTROPY_LITERAL = /(["'`])([A-Za-z0-9+/_=-]{40,512})\1/g;

function preview(value: string): string {
  return `${value.slice(0, 4)}…(${String(value.length)})`;
}

export function fingerprintOf(rule: string, value: string): string {
  return `${rule}:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`;
}

function lineIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function locate(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
}

/** Scans one text (a file's content). Pure; findings are deduplicated per (rule, offset). */
export function scanText(text: string, opts: ScanOptions = {}): ScanFinding[] {
  const minEntropy = opts.minEntropy ?? 3.5;
  const minContext = opts.minContextLength ?? 16;
  const redactor = new Redactor({ rules: opts.rules ?? DEFAULT_RULES });
  const starts = lineIndex(text);
  const lineOf = (offset: number): string => {
    const { line } = locate(starts, offset);
    return text.slice(starts[line - 1] ?? 0, starts[line] ?? text.length);
  };
  const out: ScanFinding[] = [];
  const seen = new Set<string>();
  const report = (rule: string, start: number, value: string): void => {
    const key = `${rule}@${String(start)}`;
    if (seen.has(key) || (rule !== 'canary' && lineOf(start).includes(ALLOW_MARKER))) return;
    seen.add(key);
    const at = locate(starts, start);
    out.push({ rule, ...at, preview: preview(value), fingerprint: fingerprintOf(rule, value) });
  };

  for (const span of redactor.spans(text)) {
    const value = text.slice(span.start, span.end);
    if (CONTEXT_RULE_IDS.has(span.label) && !looksRandom(value, minEntropy, minContext)) continue;
    report(span.label, span.start, value);
  }
  if (opts.highEntropy ?? true) {
    for (const m of text.matchAll(HIGH_ENTROPY_LITERAL)) {
      const value = m[2] ?? '';
      if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) continue;
      if (shannonEntropy(value) < 4.2) continue;
      report('high-entropy-string', m.index + 1, value);
    }
  }
  for (const canary of opts.canaries ?? []) {
    if (canary.length === 0) continue;
    let from = 0;
    for (;;) {
      const i = text.indexOf(canary, from);
      if (i < 0) break;
      report('canary', i, canary);
      from = i + 1;
    }
  }
  return out.sort((a, b) => a.line - b.line || a.column - b.column);
}
