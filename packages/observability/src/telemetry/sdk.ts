import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type Attributes,
  context,
  INVALID_SPAN_CONTEXT,
  type Meter,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { type IMetricReader, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { Redactor } from '../redact/redactor.js';
import { SanitizingSpanExporter, sanitizeAttributes } from './sanitize.js';

/** OTLP/HTTP export (docs/design/p6-observability.md §3). Off unless an endpoint is configured. */
export interface OtlpOptions {
  /** Base URL of an OTLP/HTTP receiver, e.g. `http://otel-collector:4318` (`/v1/{traces,metrics,logs}` appended). */
  readonly endpoint: string;
  /** Extra headers (e.g. a collector API key read from a file by the caller). Never logged. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly metricIntervalMs?: number;
  readonly timeoutMs?: number;
  /** Also export log records given to {@link Telemetry.emitLog}. Default true. */
  readonly logs?: boolean;
}

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly environment?: string;
  readonly otlp?: OtlpOptions | null;
  /** Serve metrics in the Prometheus text format through {@link Telemetry.metricsHandler}. Default false. */
  readonly prometheus?: boolean;
  readonly redactor?: Redactor;
  /** Test seams: replace the exporters (spans are still sanitized; processed synchronously). */
  readonly spanExporter?: SpanExporter;
  readonly metricReaders?: readonly IMetricReader[];
  /**
   * p16-observability: extra span processors that see every finished span (e.g. {@link RecentTraces}). Spans are then
   * recorded even without an exporter (`tracing` is true); they still leave the process only through the exporter.
   */
  readonly spanProcessors?: readonly SpanProcessor[];
}

export type LogSeverity = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** A process's telemetry: a tracer (no-op unless spans are exported), a meter and optional exporters. */
export interface Telemetry {
  readonly tracer: Tracer;
  readonly meter: Meter;
  /** True when spans are recorded (OTLP, a test exporter or an in-process span processor). */
  readonly tracing: boolean;
  /** p16-observability: true when spans leave the process (OTLP or a test exporter). */
  readonly exporting: boolean;
  /** Prometheus text exposition of all metrics; null when `prometheus` is off. */
  readonly metricsHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null;
  /**
   * Runs `fn` inside a new active span (child of the current one). Attributes go through the attribute
   * policy at export; exceptions are recorded with their type only and rethrown.
   */
  span<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T>;
  /** OTLP log export of an already redacted record (no-op without OTLP logs). */
  emitLog(severity: LogSeverity, body: string, attributes?: Attributes): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let contextManagerInstalled = false;
/** Async context propagation (AsyncLocalStorage); installed once per process, before the first span. */
function ensureContextManager(): void {
  if (contextManagerInstalled) return;
  contextManagerInstalled = true;
  const cm = new AsyncLocalStorageContextManager();
  cm.enable();
  // Returns false when another manager is already registered (e.g. by an embedding process): keep it.
  context.setGlobalContextManager(cm);
}

const SEVERITY: Readonly<Record<LogSeverity, SeverityNumber>> = {
  trace: SeverityNumber.TRACE,
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
};

function otlpUrl(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

/** Error class name only (never the message: it may carry data). */
export function errorType(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : 'Error';
}

export function createTelemetry(opts: TelemetryOptions): Telemetry {
  const redactor = opts.redactor ?? new Redactor();
  const resource = resourceFromAttributes({
    'service.name': opts.serviceName,
    'service.namespace': 'remyral',
    ...(opts.serviceVersion === undefined ? {} : { 'service.version': opts.serviceVersion }),
    ...(opts.environment === undefined ? {} : { 'deployment.environment.name': opts.environment }),
  });
  const otlp = opts.otlp ?? null;
  const headers = otlp?.headers === undefined ? {} : { ...otlp.headers };
  const timeoutMillis = otlp?.timeoutMs ?? 10_000;

  // ---- traces
  let tracerProvider: TracerProvider | null = null;
  const exporter: SpanExporter | null =
    opts.spanExporter ??
    (otlp === null
      ? null
      : new OTLPTraceExporter({ url: otlpUrl(otlp.endpoint, 'traces'), headers, timeoutMillis }));
  const extra = opts.spanProcessors ?? [];
  if (exporter !== null || extra.length > 0) {
    ensureContextManager();
    const processors: SpanProcessor[] = [...extra];
    if (exporter !== null) {
      const clean = new SanitizingSpanExporter(exporter, redactor);
      processors.push(
        opts.spanExporter === undefined
          ? new BatchSpanProcessor({ exporter: clean, maxQueueSize: 2048, scheduledDelayMillis: 5_000 })
          : new SimpleSpanProcessor({ exporter: clean }),
      );
    }
    tracerProvider = new TracerProvider({ resource, spanProcessors: processors });
  }
  const tracer: Tracer =
    tracerProvider === null
      ? trace.getTracer('remyral-noop')
      : tracerProvider.getTracer('remyral', opts.serviceVersion);

  // ---- metrics
  const readers: IMetricReader[] = [...(opts.metricReaders ?? [])];
  let prometheus: PrometheusExporter | null = null;
  if (opts.prometheus === true) {
    prometheus = new PrometheusExporter({ preventServerStart: true });
    readers.push(prometheus);
  }
  if (otlp !== null) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlpUrl(otlp.endpoint, 'metrics'), headers, timeoutMillis }),
        exportIntervalMillis: otlp.metricIntervalMs ?? 60_000,
      }),
    );
  }
  const meterProvider = new MeterProvider({ resource, readers });
  const meter = meterProvider.getMeter('remyral', opts.serviceVersion);

  // ---- logs
  let loggerProvider: LoggerProvider | null = null;
  if (otlp !== null && otlp.logs !== false) {
    loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter({ url: otlpUrl(otlp.endpoint, 'logs'), headers, timeoutMillis }),
        }),
      ],
    });
  }
  const otelLogger = loggerProvider?.getLogger('remyral', opts.serviceVersion) ?? null;

  const tracing = tracerProvider !== null;
  return {
    tracer,
    meter,
    tracing,
    exporting: exporter !== null,
    metricsHandler:
      prometheus === null
        ? null
        : (() => {
            const p = prometheus;
            return (req: IncomingMessage, res: ServerResponse) => {
              p.getMetricsRequestHandler(req, res);
            };
          })(),
    async span<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
      if (!tracing) return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
      return tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
          return await fn(span);
        } catch (err) {
          span.setAttribute('error.type', errorType(err));
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw err;
        } finally {
          span.end();
        }
      });
    },
    emitLog(severity, body, attributes = {}) {
      if (otelLogger === null) return;
      otelLogger.emit({
        severityNumber: SEVERITY[severity],
        severityText: severity,
        body: redactor.redact(body).slice(0, 8_192),
        attributes: sanitizeAttributes(attributes, redactor),
        context: context.active(),
      });
    },
    async forceFlush() {
      await Promise.allSettled([
        tracerProvider?.forceFlush(),
        meterProvider.forceFlush(),
        loggerProvider?.forceFlush(),
      ]);
    },
    async shutdown() {
      await Promise.allSettled([
        tracerProvider?.shutdown(),
        meterProvider.shutdown(),
        loggerProvider?.shutdown(),
      ]);
    },
  };
}

/** trace_id / span_id of the active span (log correlation), or an empty object. */
export function activeTraceIds(): { trace_id?: string; span_id?: string } {
  const sc = trace.getActiveSpan()?.spanContext();
  if (sc === undefined || !trace.isSpanContextValid(sc)) return {};
  return { trace_id: sc.traceId, span_id: sc.spanId };
}
