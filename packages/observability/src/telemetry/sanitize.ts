import type { Attributes, AttributeValue } from '@opentelemetry/api';
import { type ExportResult, ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter, TimedEvent } from '@opentelemetry/sdk-trace';
import { Redactor } from '../redact/redactor.js';

/**
 * Telemetry attribute policy (docs/design/p6-observability.md §5): telemetry carries identifiers,
 * enumerations and numbers only — never prompts, summaries, repository content, error messages, URLs with
 * query strings, headers or secrets. Every exported span passes through {@link SanitizingSpanExporter},
 * which keeps only allowlisted attribute keys, drops event payloads and status messages, caps string
 * lengths and runs every remaining string through the secret redactor. Code that adds an attribute
 * outside the allowlist therefore loses it at export instead of leaking it.
 */
export const ALLOWED_ATTRIBUTE =
  /^(?:remyral\.(?:job\.(?:id|state|from|to|trigger|outcome|runtime|kind)|attempt\.(?:id|epoch)|worker\.(?:id|state|message)|project|runtime|phase|step|component|session\.reason|hints|count|alert\.rule|chat\.(?:turn|outcome|reason))|http\.(?:request\.method|route|response\.status_code)|db\.(?:system\.name|operation\.name)|messaging\.(?:system|operation\.name|destination\.name)|error\.type|exception\.type|service\.(?:name|version|namespace|instance\.id)|deployment\.environment\.name|telemetry\.sdk\.(?:name|language|version))$/;

/** Longest string attribute value that is exported (identifiers are far shorter). */
export const MAX_ATTRIBUTE_LENGTH = 256;

/** A value token: identifiers, enumerations, versions, routes. Anything else is replaced. */
const SAFE_TEXT = /^[A-Za-z0-9_.:/@+\-<>*]*$/;

function cleanValue(v: AttributeValue | undefined, redactor: Redactor): AttributeValue | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const r = redactor.redact(v).slice(0, MAX_ATTRIBUTE_LENGTH);
    return SAFE_TEXT.test(r) ? r : '[filtered]';
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'number' || typeof x === 'boolean')) return v;
  return undefined;
}

/** Keeps allowlisted keys with safe values (see {@link ALLOWED_ATTRIBUTE}). */
export function sanitizeAttributes(attrs: Attributes, redactor: Redactor = new Redactor()): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (!ALLOWED_ATTRIBUTE.test(k)) continue;
    const c = cleanValue(v, redactor);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** A copy of `span` that can be exported: allowlisted attributes, no event payloads, no status text. */
export function sanitizeSpan(span: ReadableSpan, redactor: Redactor): ReadableSpan {
  const events: TimedEvent[] = span.events.map((e) => ({
    name: e.name === 'exception' ? 'exception' : cleanName(e.name),
    time: e.time,
    attributes: sanitizeAttributes(e.attributes ?? {}, redactor),
    droppedAttributesCount: 0,
  }));
  return {
    name: cleanName(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext === undefined ? {} : { parentSpanContext: span.parentSpanContext }),
    startTime: span.startTime,
    endTime: span.endTime,
    // The status message is free text (often an error message): only the code is exported.
    status: { code: span.status.code },
    attributes: sanitizeAttributes(span.attributes, redactor),
    links: span.links.map((l) => ({
      context: l.context,
      attributes: sanitizeAttributes(l.attributes ?? {}, redactor),
    })),
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Span names are code-chosen constants; anything else is collapsed. */
function cleanName(name: string): string {
  return /^[A-Za-z0-9_. /:{}-]{1,96}$/.test(name) ? name : 'span';
}

/** Wraps an exporter so nothing outside the attribute policy is ever exported. */
export class SanitizingSpanExporter implements SpanExporter {
  readonly #inner: SpanExporter;
  readonly #redactor: Redactor;

  constructor(inner: SpanExporter, redactor: Redactor = new Redactor()) {
    this.#inner = inner;
    this.#redactor = redactor;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let clean: ReadableSpan[];
    try {
      clean = spans.map((s) => sanitizeSpan(s, this.#redactor));
    } catch (err) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: err instanceof Error ? err : new Error('sanitize'),
      });
      return;
    }
    this.#inner.export(clean, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush?.() ?? Promise.resolve();
  }
}
