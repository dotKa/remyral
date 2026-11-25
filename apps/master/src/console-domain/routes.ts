import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { actorOf } from '../workers/routes.js';
import { ConsoleDomainError, TLS_MODES } from './domain.js';
import type { ConsoleDomainService, ConsoleDomainStatus, DomainRequestView } from './service.js';

/**
 * p17-domain-wizard (docs/design/p17-domain-wizard.md): Kurulum sihirbazı → Alan adı ve erişim.
 *
 * - `GET /console-domain` (`console.domain.read`, owner): the effective address, where it comes from, the host
 *   applier and the latest domain change request (the wizard polls it while a change is applied).
 * - `POST /console-domain/dns-check` (`console.domain.read`): "DNS bu sunucuyu gösteriyor mu?" for a typed name.
 * - `PUT /console-domain` (`console.domain.write`, step-up event `console.domain`): save the domain — the setting, or
 *   a signed request for the remyral-ctl host. `DELETE /console-domain`: back to the environment's address.
 *   `POST /console-domain/request/cancel`: withdraw a request the host has not picked up.
 */
const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 409: ErrorBody, 503: ErrorBody };
const tags = ['console-domain'];
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];
const Tls = z.enum(TLS_MODES);
const State = z.enum([
  'pending',
  'applying',
  'applied',
  'rolled_back',
  'failed',
  'refused',
  'expired',
  'cancelled',
]);

const RequestBody = z.object({
  id: z.string(),
  domain: z.string(),
  tls: Tls,
  previousDomain: z.string(),
  state: State,
  detail: z.string().nullable(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  updatedAt: z.string(),
});

export const ConsoleDomainBody = z.object({
  origin: z.string().nullable(),
  source: z.enum(['setting', 'environment', 'none']),
  setting: z
    .object({ origin: z.string(), source: z.enum(['owner', 'host-applier']), updatedAt: z.string() })
    .nullable(),
  environment: z.string().nullable(),
  host: z.object({
    managed: z.boolean(),
    lastSeen: z.string().nullable(),
    version: z.string().nullable(),
    domain: z.string().nullable(),
    tls: Tls.nullable(),
    acmeEmail: z.string().nullable(),
    httpsPort: z.number().int().nullable(),
  }),
  request: RequestBody.nullable(),
});

const DnsBody = z.object({
  domain: z.string(),
  addresses: z.array(z.string()),
  expected: z.array(z.string()),
  verdict: z.enum(['match', 'cloudflare', 'mismatch', 'not_found', 'unknown', 'error']),
  detail: z.string().nullable(),
  checkedAt: z.string(),
});

const SaveBody = z.object({
  mode: z.enum(['setting', 'host']),
  origin: z.string().nullable(),
  request: RequestBody.nullable(),
  status: ConsoleDomainBody,
});

/** One literal site per code (the console's error catalog is checked against them, scripts/i18n). */
function fail(err: unknown): never {
  if (!(err instanceof ConsoleDomainError)) throw err;
  const m = err.message;
  switch (err.code) {
    case 'invalid_domain':
      throw new HttpError(400, 'invalid_domain', m);
    case 'invalid_email':
      throw new HttpError(400, 'invalid_email', m);
    case 'email_required':
      throw new HttpError(400, 'email_required', m);
    case 'letsencrypt_needs_standard_ports':
      throw new HttpError(400, 'letsencrypt_needs_standard_ports', m);
    case 'domain_unchanged':
      throw new HttpError(409, 'domain_unchanged', m);
    case 'domain_change_in_progress':
      throw new HttpError(409, 'domain_change_in_progress', m);
    case 'no_pending_request':
      throw new HttpError(409, 'no_pending_request', m);
    case 'host_applier_unavailable':
      throw new HttpError(503, 'host_applier_unavailable', m);
  }
}

const copyRequest = (r: DomainRequestView | null) => (r === null ? null : { ...r });
const copyStatus = (s: ConsoleDomainStatus) => ({
  ...s,
  setting: s.setting === null ? null : { ...s.setting },
  host: { ...s.host },
  request: copyRequest(s.request),
});

export function consoleDomainRoutes(deps: {
  readonly service: ConsoleDomainService;
  readonly clock: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const read = { authz: { action: 'console.domain.read' as const } };
    const write = { authz: { action: 'console.domain.write' as const } };
    const stepUp = requireStepUp(undefined, deps.clock);

    r.get(
      '/console-domain',
      {
        config: read,
        schema: {
          tags,
          summary:
            "The console's public address (setting, else PUBLIC_ORIGIN), the host applier and the latest domain change",
          security: session,
          response: { 200: ConsoleDomainBody, ...errors },
        },
      },
      async () => copyStatus(await deps.service.status()),
    );

    r.post(
      '/console-domain/dns-check',
      {
        config: read,
        schema: {
          tags,
          summary: 'Resolve a domain (A / AAAA) and compare it with the addresses of this server',
          security: csrf,
          body: z.strictObject({ domain: z.string().max(300) }),
          response: { 200: DnsBody, ...errors },
        },
      },
      async (request) => {
        const res = await deps.service.checkDns(request.body.domain).catch(fail);
        return { ...res, addresses: [...res.addresses], expected: [...res.expected] };
      },
    );

    r.put(
      '/console-domain',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Save the console domain: the public address now (no host applier), or a signed change request for the remyral-ctl host (owners; step-up by policy; audited)',
          security: csrf,
          body: z.strictObject({
            domain: z.string().max(300),
            tls: Tls.optional(),
            email: z.string().max(300).optional(),
          }),
          response: { 200: SaveBody, ...errors },
        },
      },
      async (request) => {
        const b = request.body;
        const out = await deps.service
          .save(actorOf(request), {
            domain: b.domain,
            ...(b.tls === undefined ? {} : { tls: b.tls }),
            ...(b.email === undefined ? {} : { email: b.email }),
          })
          .catch(fail);
        const status = copyStatus(await deps.service.status());
        return out.mode === 'setting'
          ? { mode: out.mode, origin: out.origin, request: null, status }
          : { mode: out.mode, origin: null, request: copyRequest(out.request), status };
      },
    );

    r.delete(
      '/console-domain',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            "Forget the saved address: links use the environment's PUBLIC_ORIGIN / NOTIFY_PUBLIC_URL again",
          security: csrf,
          response: { 200: ConsoleDomainBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.clear(actorOf(request)).catch(fail);
        return copyStatus(await deps.service.status());
      },
    );

    r.post(
      '/console-domain/request/cancel',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Withdraw a domain change request the host has not picked up yet',
          security: csrf,
          response: { 200: ConsoleDomainBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.cancel(actorOf(request)).catch(fail);
        return copyStatus(await deps.service.status());
      },
    );
  };
}
