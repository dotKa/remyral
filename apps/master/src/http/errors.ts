import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { dependencyOf } from '../infra/dependency-health.js';

/**
 * p14-i18n-errors (i18n Phase 3, ADR-0053 §5): the values a client needs to say an error in its own language —
 * the same values the English `message` already shows (a size limit, a name, a state), never anything more. Only
 * strings, finite numbers and booleans; at most {@link ERROR_PARAMS_MAX_KEYS} keys, keys of at most 40 word
 * characters, strings cut to {@link ERROR_PARAM_STRING_MAX} characters. A variant sentence of one code is chosen
 * by `params.reason` (a fixed sub-code), e.g. `not_found` + `{ reason: 'project' }`.
 */
export type ErrorParamValue = string | number | boolean;
export type ErrorParams = Readonly<Record<string, ErrorParamValue>>;

export const ERROR_PARAMS_MAX_KEYS = 12;
export const ERROR_PARAM_STRING_MAX = 300;
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Keeps the client-safe primitives of `params` within the bounds above (anything else is dropped). */
export function boundedParams(params: Readonly<Record<string, unknown>>): ErrorParams {
  const out: Record<string, ErrorParamValue> = {};
  let n = 0;
  for (const [k, v] of Object.entries(params)) {
    if (n >= ERROR_PARAMS_MAX_KEYS) break;
    if (!PARAM_KEY.test(k)) continue;
    if (typeof v === 'string')
      out[k] = v.length > ERROR_PARAM_STRING_MAX ? v.slice(0, ERROR_PARAM_STRING_MAX) : v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else continue;
    n += 1;
  }
  return out;
}

/**
 * Errors with a public, client-safe code and message. Anything else becomes a generic 500 whose details
 * (message, stack) are logged server-side only.
 */
export class HttpError extends Error {
  /** p14-i18n-errors: the bounded parameters sent as `params` (empty: none). */
  readonly params: ErrorParams;

  constructor(
    readonly statusCode: number,
    readonly code: string,
    /** English, as before: the API / CLI / log text and the fallback for clients that do not know `code`. */
    readonly publicMessage: string,
    readonly headers: Readonly<Record<string, string>> = {},
    /**
     * Extra client-safe fields sent next to `error`/`message` (never overriding them). The route's response
     * schema must declare them, or the serializer drops them.
     */
    readonly details: Readonly<Record<string, unknown>> = {},
    /**
     * p14-i18n-errors: the values interpolated into `publicMessage` (and `reason` for a variant sentence), so the
     * console can say it in the user's language (`@remyral/i18n` `errors`). Declared by `ErrorBodySchema`.
     */
    params: Readonly<Record<string, unknown>> = {},
  ) {
    super(publicMessage);
    this.name = 'HttpError';
    this.params = boundedParams(params);
  }
}

export interface ErrorBody {
  readonly error: string;
  readonly message: string;
  readonly params?: ErrorParams;
}

const GENERIC: Record<number, ErrorBody> = {
  400: { error: 'bad_request', message: 'The request is invalid.' },
  401: { error: 'unauthorized', message: 'Authentication required.' },
  403: { error: 'forbidden', message: 'Not allowed.' },
  404: { error: 'not_found', message: 'Not found.' },
  405: { error: 'method_not_allowed', message: 'Method not allowed.' },
  413: { error: 'payload_too_large', message: 'Request body too large.' },
  415: { error: 'unsupported_media_type', message: 'Content-Type must be application/json.' },
  429: { error: 'rate_limited', message: 'Too many requests. Try again later.' },
};

function genericFor(status: number): ErrorBody {
  return GENERIC[status] ?? { error: 'internal_error', message: 'Internal server error.' };
}

/** The JSON body of an `HttpError`: details, then `error`/`message`, then `params` when there are any. */
export function httpErrorBody(err: HttpError): Record<string, unknown> {
  return {
    ...err.details,
    error: err.code,
    message: err.publicMessage,
    ...(Object.keys(err.params).length > 0 ? { params: err.params } : {}),
  };
}

/** p22-ops-hygiene: the answer while Redis / Postgres do not answer (fail closed, the client may retry). */
function dependencyUnavailable(): HttpError {
  return new HttpError(
    503,
    'dependency_unavailable',
    'A service the console depends on is not answering; try again in a few seconds.',
    { 'retry-after': '5' },
  );
}

export interface ErrorHandlingOptions {
  /**
   * p22-ops-hygiene: told about a dependency outage behind a request (the shared health gate logs it once per
   * transition). Returns false when nobody took it (the handler then logs a warning itself).
   */
  readonly dependencyDown?: (err: unknown) => boolean;
}

export function registerErrorHandling(app: FastifyInstance, opts: ErrorHandlingOptions = {}): void {
  app.setErrorHandler((err: FastifyError | HttpError, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      // p16-api-tokens: a service's own step-up check refused a token request — a token can never give a code, so
      // say that instead of asking for one.
      const token = request.auth?.token;
      const e =
        token !== undefined && err.code === 'step_up_required'
          ? new HttpError(
              403,
              'token_step_up_refused',
              `This action asks for an authenticator code under the security policy (${request.auth?.stepUpEvent ?? 'unmapped'}); an API token cannot provide one.`,
              {},
              {},
              { event: request.auth?.stepUpEvent ?? 'unmapped' },
            )
          : err;
      for (const [k, v] of Object.entries(e.headers)) void reply.header(k, v);
      return reply.code(e.statusCode).send(httpErrorBody(e));
    }
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (err.validation) {
      // Report which fields failed, never the received values.
      request.log.info({ validationContext: err.validationContext }, 'request validation failed');
      return reply.code(400).send(genericFor(400));
    }
    if (status >= 400 && status < 500) {
      request.log.info({ errCode: err.code, statusCode: status }, 'client error');
      return reply.code(status).send(genericFor(status));
    }
    // p22-ops-hygiene: Redis / Postgres not answering (e.g. the rate limiter's bounded Redis call) is a 503 with
    // Retry-After — not an "unhandled error" per request.
    const dependency = dependencyOf(err);
    if (dependency !== null) {
      if (opts.dependencyDown?.(err) !== true) {
        request.log.warn({ dependency, errMessage: err.message.slice(0, 200) }, 'dependency unavailable');
      } else {
        request.log.debug({ dependency }, 'request refused: dependency unavailable');
      }
      const e = dependencyUnavailable();
      for (const [k, v] of Object.entries(e.headers)) void reply.header(k, v);
      return reply.code(e.statusCode).send(httpErrorBody(e));
    }
    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send(genericFor(500));
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(genericFor(404)));
}
