export {
  DEFAULT_RULES,
  STREAM_MIN_LOOKBEHIND,
  charClassContinuation,
  untilContinuation,
  type BlockRule,
  type Continuation,
  type ContinuationResult,
  type PatternRule,
  type RedactionRule,
} from './redact/rules.js';
export { MIN_SECRET_LENGTH, SecretSet, SecretTooShortError, type Revealable } from './redact/secret-set.js';
export { Redactor, marker, type RedactorOptions, type Span } from './redact/redactor.js';
export { StreamRedactor, type StreamRedactorOptions } from './redact/stream.js';
export { SENSITIVE_KEY, redactDeep, type SerializeOptions } from './redact/deep.js';
export {
  LOG_LEVELS,
  createLogger,
  isLogLevel,
  type LogFields,
  type LogLevel,
  type LogSink,
  type LogThreshold,
  type Logger,
  type LoggerOptions,
} from './log/logger.js';
export {
  ALLOW_MARKER,
  CONTEXT_RULE_IDS,
  fingerprintOf,
  looksRandom,
  scanText,
  shannonEntropy,
  type ScanFinding,
  type ScanOptions,
} from './scan/scanner.js';
