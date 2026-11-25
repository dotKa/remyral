import { redactDeep, type SerializeOptions } from '../redact/deep.js';
import { Redactor } from '../redact/redactor.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** `silent` disables output entirely. */
export type LogThreshold = LogLevel | 'silent';

const SEVERITY: Record<LogThreshold, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

export type LogFields = Readonly<Record<string, unknown>>;

/** Receives one complete JSON line (without trailing newline). */
export type LogSink = (line: string) => void;

export interface LoggerOptions extends SerializeOptions {
  level?: LogThreshold;
  /** Default: write to process.stderr. */
  sink?: LogSink;
  /** Shared redactor; register secrets on `redactor.secrets`. A default one is created otherwise. */
  redactor?: Redactor;
  clock?: () => Date;
  /** Fields included on every record (e.g. `{ component: 'worker' }`). */
  fields?: LogFields;
}

export interface Logger {
  readonly level: LogThreshold;
  readonly redactor: Redactor;
  isLevelEnabled(level: LogLevel): boolean;
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every record; shares sink, level and redactor. */
  child(fields: LogFields): Logger;
  /** Lines the sink failed to accept (a logging failure cannot itself be logged). */
  readonly droppedLines: number;
  /**
   * p17-worker-managed: changes the threshold of this logger and every logger sharing its sink (children included).
   * Optional: loggers built elsewhere (fakes) may not support it.
   */
  setLevel?(level: LogThreshold): void;
}

const RESERVED = new Set(['ts', 'level', 'msg']);

interface Shared {
  level: LogThreshold;
  sink: LogSink;
  redactor: Redactor;
  clock: () => Date;
  serialize: SerializeOptions;
  dropped: number;
}

/**
 * Structured JSON-lines logger. Every record — message, field keys and values,
 * error messages and stacks — passes through the redactor before it reaches the
 * sink; there is no unredacted code path.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const { level, sink, redactor, clock, fields, ...serialize } = options;
  const shared: Shared = {
    level: level ?? 'info',
    sink:
      sink ??
      ((line) => {
        process.stderr.write(`${line}\n`);
      }),
    redactor: redactor ?? new Redactor(),
    clock: clock ?? (() => new Date()),
    serialize,
    dropped: 0,
  };
  return new JsonLogger(shared, fields ?? {});
}

class JsonLogger implements Logger {
  constructor(
    private readonly shared: Shared,
    private readonly bound: LogFields,
  ) {}

  get level(): LogThreshold {
    return this.shared.level;
  }

  get redactor(): Redactor {
    return this.shared.redactor;
  }

  get droppedLines(): number {
    return this.shared.dropped;
  }

  isLevelEnabled(level: LogLevel): boolean {
    return SEVERITY[level] >= SEVERITY[this.shared.level];
  }

  setLevel(level: LogThreshold): void {
    this.shared.level = level;
  }

  trace(msg: string, fields?: LogFields): void {
    this.write('trace', msg, fields);
  }
  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }
  fatal(msg: string, fields?: LogFields): void {
    this.write('fatal', msg, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(this.shared, { ...this.bound, ...fields });
  }

  private write(level: LogLevel, msg: string, fields: LogFields | undefined): void {
    if (!this.isLevelEnabled(level)) return;
    const { redactor, serialize } = this.shared;
    const record: Record<string, unknown> = {
      ts: this.shared.clock().toISOString(),
      level,
      msg: redactDeep(msg, redactor, serialize),
    };
    const merged = redactDeep({ ...this.bound, ...fields }, redactor, serialize) as Record<string, unknown>;
    for (const [key, value] of Object.entries(merged)) {
      record[RESERVED.has(key) ? `_${key}` : key] = value;
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({
        ts: record['ts'],
        level,
        msg: record['msg'],
        logError: 'unserializable fields',
      });
    }
    try {
      this.shared.sink(line);
    } catch {
      this.shared.dropped++;
    }
  }
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
