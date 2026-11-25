import { DEFAULT_RULES, STREAM_MIN_LOOKBEHIND, type Continuation, type RedactionRule } from './rules.js';
import { SecretSet } from './secret-set.js';

/** A region of text to replace. */
export interface Span {
  start: number;
  end: number;
  /** Rule id, or `secret` / the registered label for exact values. */
  label: string;
  /**
   * The match touches the end of the scanned text and the secret may continue in
   * data not seen yet (stream redaction must hold it back).
   */
  openEnded: boolean;
  /** How to keep swallowing the secret if a stream has to force-close it. */
  continuation: Continuation | null;
}

export interface RedactorOptions {
  /** Exact values (first pass). A fresh empty set by default. */
  secrets?: SecretSet;
  /** Pattern rules (second pass). `DEFAULT_RULES` by default; `[]` disables patterns. */
  rules?: readonly RedactionRule[];
}

export function marker(label: string): string {
  return `[REDACTED:${label}]`;
}

/**
 * Two-pass redactor (ADR-0006 §4): exact values of registered secrets, then
 * well-known secret patterns. Overlapping matches are merged into one marker.
 * Stateless apart from the (mutable) secret set, so one instance can be shared.
 */
export class Redactor {
  readonly secrets: SecretSet;
  readonly rules: readonly RedactionRule[];

  constructor(options: RedactorOptions = {}) {
    this.secrets = options.secrets ?? new SecretSet();
    this.rules = options.rules ?? DEFAULT_RULES;
  }

  /** Characters a stream redactor must hold back so nothing is split across chunks. */
  lookbehind(): number {
    return Math.max(STREAM_MIN_LOOKBEHIND, this.secrets.maxLength());
  }

  /** Merged, sorted, non-overlapping spans to replace in `text`. */
  spans(text: string): Span[] {
    const raw: Span[] = [];
    for (const [value, label] of this.secrets.entries()) {
      let from = 0;
      for (;;) {
        const i = text.indexOf(value, from);
        if (i < 0) break;
        raw.push({ start: i, end: i + value.length, label, openEnded: false, continuation: null });
        from = i + 1;
      }
    }
    for (const rule of this.rules) {
      if (rule.kind === 'pattern') collectPattern(rule, text, raw);
      else collectBlock(rule, text, raw);
    }
    return merge(raw);
  }

  /** Redact a complete string. */
  redact(text: string): string {
    if (text.length === 0) return text;
    const spans = this.spans(text);
    if (spans.length === 0) return text;
    let out = '';
    let pos = 0;
    for (const s of spans) {
      out += text.slice(pos, s.start) + marker(s.label);
      pos = s.end;
    }
    return out + text.slice(pos);
  }

  /** True if `text` contains anything this redactor would replace. */
  matches(text: string): boolean {
    return this.spans(text).length > 0;
  }
}

function collectPattern(rule: Extract<RedactionRule, { kind: 'pattern' }>, text: string, out: Span[]): void {
  const re = new RegExp(rule.regex.source, rule.regex.flags);
  for (const m of text.matchAll(re)) {
    const whole = m.indices?.[0];
    if (!whole) continue;
    const target = rule.group === undefined ? whole : m.indices?.[rule.group];
    if (!target) continue;
    out.push({
      start: target[0],
      end: target[1],
      label: rule.id,
      openEnded: whole[1] === text.length,
      continuation: rule.continuation,
    });
  }
}

function collectBlock(rule: Extract<RedactionRule, { kind: 'block' }>, text: string, out: Span[]): void {
  const begin = new RegExp(rule.begin.source, rule.begin.flags);
  const end = new RegExp(rule.end.source, rule.end.flags);
  let b: RegExpExecArray | null;
  while ((b = begin.exec(text)) !== null) {
    end.lastIndex = b.index + b[0].length;
    const e = end.exec(text);
    if (e === null) {
      // BEGIN without END: everything after it is key material (fail closed).
      out.push({
        start: b.index,
        end: text.length,
        label: rule.id,
        openEnded: true,
        continuation: rule.continuation,
      });
      return;
    }
    const stop = e.index + e[0].length;
    out.push({ start: b.index, end: stop, label: rule.id, openEnded: false, continuation: null });
    begin.lastIndex = stop;
  }
}

function merge(spans: Span[]): Span[] {
  if (spans.length <= 1) return spans;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (last !== undefined && s.start < last.end) {
      if (s.end > last.end) {
        last.end = s.end;
        last.openEnded = s.openEnded;
        last.continuation = s.continuation ?? last.continuation;
      } else if (s.end === last.end && s.openEnded) {
        last.openEnded = true;
        last.continuation ??= s.continuation;
      }
      continue;
    }
    out.push({ ...s });
  }
  return out;
}
