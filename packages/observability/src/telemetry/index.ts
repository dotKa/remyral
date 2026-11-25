export {
  activeTraceIds,
  createTelemetry,
  errorType,
  type LogSeverity,
  type OtlpOptions,
  type Telemetry,
  type TelemetryOptions,
} from './sdk.js';
export {
  ALLOWED_ATTRIBUTE,
  MAX_ATTRIBUTE_LENGTH,
  SanitizingSpanExporter,
  sanitizeAttributes,
  sanitizeSpan,
} from './sanitize.js';
export { parseHeaders, readHeadersFile } from './headers.js';
export {
  activeTraceparent,
  contextFromTraceparent,
  parseTraceparent,
  TRACEPARENT_PATTERN,
  traceparentOf,
  withTraceparent,
} from './propagation.js';
export {
  type RecentSpan,
  type RecentTrace,
  type RecentTraceSummary,
  RecentTraces,
  type RecentTracesOptions,
} from './recent.js';
export { MetricHistory, type MetricHistoryOptions } from './history.js';
