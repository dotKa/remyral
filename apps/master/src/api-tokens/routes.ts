import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { realStepUpFields, requireStepUp } from '../auth/hooks.js';
import { ROLES } from '../auth/users.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { authzOf } from '../http/route-authz.js';
import { MAX_CIDRS } from './cidr.js';
import { TOKEN_KINDS } from './format.js';
import { TOKEN_SCOPES } from './scopes.js';
import {
  type ApiTokenRecord,
  type ApiTokenService,
  MAX_OVERLAP_MINUTES,
  type ServiceAccountRecord,
  type TokenActor,
  TOKEN_STATES,
} from './service.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** p16-api-tokens: the token service and the use-counter flush (tests). */
    readonly apiTokens: { readonly service: ApiTokenService; flushUsage(): Promise<void> };
  }
}

const errors = {
  400: ErrorBodySchema,
  401: ErrorBodySchema,
  403: ErrorBodySchema,
  404: ErrorBodySchema,
  409: ErrorBodySchema,
};

const Iso = z.string();
const Ref = z.object({ id: z.string(), username: z.string() });
const Role = z.enum(ROLES);
const Uuid = z.uuid();

export const TokenBody = z.object({
  id: z.string(),
  kind: z.enum(TOKEN_KINDS),
  principal: z.object({ id: z.string(), username: z.string(), role: Role }),
  name: z.string(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  grantedEvents: z.array(z.string()),
  allowedCidrs: z.array(z.string()),
  hint: z.string().describe('Prefix and first / last characters, never the secret.'),
  expiresAt: Iso,
  createdAt: Iso,
  createdBy: Ref.nullable(),
  rotatedAt: Iso.nullable(),
  previousValidUntil: Iso.nullable().describe(
    'The previous secret still works until then (rotation overlap).',
  ),
  revokedAt: Iso.nullable(),
  revokedBy: Ref.nullable(),
  lastUsedAt: Iso.nullable(),
  lastUsedIp: z.string().nullable(),
  useCount: z.number().int(),
  state: z.enum(TOKEN_STATES),
});

const IssuedBody = z.object({
  token: TokenBody,
  secret: z
    .string()
    .describe(
      'The token. Shown once: it is not stored and cannot be shown again. Send it as `Authorization: Bearer`.',
    ),
});

const RulesBody = z.object({
  personal: z.boolean(),
  maxDays: z.number().int(),
  defaultDays: z.number().int(),
  eventGrants: z.boolean(),
  scopes: z.array(z.enum(TOKEN_SCOPES)),
  grantableEvents: z.array(z.string()),
  maxCidrs: z.number().int(),
  maxOverlapMinutes: z.number().int(),
});

const ServiceAccountBody = z.object({
  id: z.string(),
  name: z.string(),
  role: Role,
  description: z.string().nullable(),
  disabled: z.boolean(),
  createdAt: Iso,
  createdBy: Ref.nullable(),
  memberships: z.array(z.object({ project: z.string(), role: z.string() })),
  tokens: z.array(TokenBody),
});

const CreateBody = z.strictObject({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string().max(40)).min(1).max(TOKEN_SCOPES.length),
  expiresInDays: z.number().int().min(1).max(3650),
  allowedCidrs: z.array(z.string().max(64)).max(MAX_CIDRS).optional(),
  grantedEvents: z.array(z.string().max(64)).max(64).optional(),
});

const RotateBody = z.strictObject({
  overlapMinutes: z.number().int().min(0).max(MAX_OVERLAP_MINUTES).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function tokenJson(t: ApiTokenRecord): z.infer<typeof TokenBody> {
  return {
    id: t.id,
    kind: t.kind,
    principal: { ...t.principal },
    name: t.name,
    scopes: [...t.scopes],
    grantedEvents: [...t.grantedEvents],
    allowedCidrs: [...t.allowedCidrs],
    hint: t.hint,
    expiresAt: t.expiresAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    createdBy: t.createdBy,
    rotatedAt: iso(t.rotatedAt),
    previousValidUntil: iso(t.previousValidUntil),
    revokedAt: iso(t.revokedAt),
    revokedBy: t.revokedBy,
    lastUsedAt: iso(t.lastUsedAt),
    lastUsedIp: t.lastUsedIp,
    useCount: t.useCount,
    state: t.state,
  };
}

function accountJson(a: ServiceAccountRecord): z.infer<typeof ServiceAccountBody> {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    description: a.description,
    disabled: a.disabled,
    createdAt: a.createdAt.toISOString(),
    createdBy: a.createdBy,
    memberships: [...a.memberships],
    tokens: a.tokens.map(tokenJson),
  };
}

function actorOf(request: FastifyRequest): TokenActor {
  const a = authzOf(request);
  return {
    userId: a.subject.userId,
    role: a.subject.role,
    realMfaAt: realStepUpFields(request).mfaAt,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  };
}

/** Own-resource declaration (`tokens.self` is self-only). */
const own = {
  action: 'tokens.self' as const,
  resource: (request: FastifyRequest) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
}

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md, ADR-0058): Ayarlar → API anahtarları (own tokens), every token for
 * admins, Ayarlar → Servis hesapları. Never reachable with a token (the actions have no token scope). Creating and
 * rotating carry the step-up event `api.tokens` (safe core), service-account create / change `users.roles`; revoking
 * never asks. The secret is in the create / rotate answer only (`cache-control: no-store`).
 */
export function apiTokenRoutes(service: ApiTokenService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['api-tokens'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    const stepUp = requireStepUp(undefined, clock);

    // ---------------------------------------------------------------- own tokens

    r.get(
      '/me/api-tokens',
      {
        config: { authz: own },
        schema: {
          tags,
          summary:
            'Your API tokens (never secrets) and the rules for a new one (scopes your role can give, lifetimes)',
          security: session,
          response: { 200: z.object({ items: z.array(TokenBody), rules: RulesBody }), ...errors },
        },
      },
      async (request) => {
        const a = authzOf(request);
        const [items, rules] = await Promise.all([
          service.list({ principalId: a.subject.userId, kind: 'personal' }),
          service.creationRules(a.subject.role),
        ]);
        return {
          items: items.map(tokenJson),
          rules: { ...rules, maxCidrs: MAX_CIDRS, maxOverlapMinutes: MAX_OVERLAP_MINUTES },
        };
      },
    );

    r.post(
      '/me/api-tokens',
      {
        config: {
          authz: { ...own, auditDenied: { action: 'api_token.create', target: () => 'api-token:new' } },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create a personal API token: name, scopes (narrowing your role), lifetime in days (required, at most the policy maximum), optional allowed IP ranges and — admins, when the policy allows it, with a fresh code — step-up events it may pass. The secret is in this answer only.',
          security: csrf,
          body: CreateBody,
          response: { 201: IssuedBody, ...errors },
        },
      },
      async (request, reply) => {
        const a = actorOf(request);
        const out = await service.create(a, 'personal', a.userId, request.body);
        noStore(reply);
        return reply.code(201).send({ token: tokenJson(out.token), secret: out.secret });
      },
    );

    r.post(
      '/me/api-tokens/:id/rotate',
      {
        config: { authz: { ...own, auditDenied: { action: 'api_token.rotate', target: () => 'api-token' } } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'A new secret for your token; the previous one keeps working for overlapMinutes (default 60, at most 1440). Optional new lifetime (default: as long as before). The secret is in this answer only.',
          security: csrf,
          params: z.object({ id: Uuid }),
          body: RotateBody,
          response: { 200: IssuedBody, ...errors },
        },
      },
      async (request, reply) => {
        const a = actorOf(request);
        const out = await service.rotate(
          a,
          request.params.id,
          { principalId: a.userId, kind: 'personal' },
          request.body,
        );
        noStore(reply);
        return { token: tokenJson(out.token), secret: out.secret };
      },
    );

    r.delete(
      '/me/api-tokens/:id',
      {
        config: { authz: own },
        schema: {
          tags,
          summary: 'Revoke your token at once (also its rotation overlap). Audited.',
          security: csrf,
          params: z.object({ id: Uuid }),
          response: { 200: z.object({ token: TokenBody }), ...errors },
        },
      },
      async (request) => {
        const a = actorOf(request);
        return { token: tokenJson(await service.revoke(a, request.params.id, { ownerId: a.userId })) };
      },
    );

    // ---------------------------------------------------------------- every token (admins)

    r.get(
      '/api-tokens',
      {
        config: { authz: { action: 'tokens.admin' } },
        schema: {
          tags,
          summary: 'Every API token, personal and service account (admins; never secrets)',
          security: session,
          querystring: z.object({ kind: z.enum(TOKEN_KINDS).optional(), ...offsetQuery(1000) }),
          response: { 200: z.object({ items: z.array(TokenBody), ...pageFields }), ...errors },
        },
      },
      async (request) => {
        const all = await service.list(request.query.kind === undefined ? {} : { kind: request.query.kind });
        const page = pageArray(all, request.query);
        return { items: page.items.map(tokenJson), total: page.total };
      },
    );

    r.delete(
      '/api-tokens/:id',
      {
        config: { authz: { action: 'tokens.admin' } },
        schema: {
          tags,
          summary: 'Revoke any token (admins). Audited.',
          security: csrf,
          params: z.object({ id: Uuid }),
          response: { 200: z.object({ token: TokenBody }), ...errors },
        },
      },
      async (request) => ({ token: tokenJson(await service.revoke(actorOf(request), request.params.id)) }),
    );

    // ---------------------------------------------------------------- service accounts

    r.get(
      '/service-accounts',
      {
        config: { authz: { action: 'serviceaccounts.read' } },
        schema: {
          tags,
          summary: 'Service accounts with role, project memberships and tokens (admins; never secrets)',
          security: session,
          response: {
            200: z.object({ items: z.array(ServiceAccountBody), rules: RulesBody }),
            ...errors,
          },
        },
      },
      async (request) => {
        const [items, rules] = await Promise.all([
          service.listServiceAccounts(),
          service.creationRules(authzOf(request).subject.role),
        ]);
        return {
          items: items.map(accountJson),
          rules: { ...rules, personal: true, maxCidrs: MAX_CIDRS, maxOverlapMinutes: MAX_OVERLAP_MINUTES },
        };
      },
    );

    r.post(
      '/service-accounts',
      {
        config: {
          authz: {
            action: 'serviceaccounts.manage',
            auditDenied: { action: 'service_account.create', target: () => 'service-account:new' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create a service account: a non-human principal with a role (at most yours, never owner) and project memberships (PUT /projects/:id/members), no password and no login. Audited.',
          security: csrf,
          body: z.strictObject({
            name: z.string().min(3).max(32),
            role: z.enum(['admin', 'operator', 'viewer']),
            description: z.string().max(500).nullable().optional(),
          }),
          response: { 201: ServiceAccountBody, ...errors },
        },
      },
      async (request, reply) => {
        const a = await service.createServiceAccount(actorOf(request), request.body);
        return reply.code(201).send(accountJson(a));
      },
    );

    r.patch(
      '/service-accounts/:id',
      {
        config: {
          authz: {
            action: 'serviceaccounts.manage',
            auditDenied: { action: 'service_account.update', target: () => 'service-account' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change a service account’s role, description or state (disabled: its tokens stop at once). Audited.',
          security: csrf,
          params: z.object({ id: Uuid }),
          body: z.strictObject({
            role: z.enum(['admin', 'operator', 'viewer']).optional(),
            description: z.string().max(500).nullable().optional(),
            disabled: z.boolean().optional(),
          }),
          response: { 200: ServiceAccountBody, ...errors },
        },
      },
      async (request) =>
        accountJson(await service.updateServiceAccount(actorOf(request), request.params.id, request.body)),
    );

    r.post(
      '/service-accounts/:id/tokens',
      {
        config: {
          authz: {
            action: 'serviceaccounts.manage',
            auditDenied: { action: 'api_token.create', target: () => 'api-token:new' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Create a token for a service account (same fields as a personal token; scopes narrow the account’s role). The secret is in this answer only.',
          security: csrf,
          params: z.object({ id: Uuid }),
          body: CreateBody,
          response: { 201: IssuedBody, ...errors },
        },
      },
      async (request, reply) => {
        const out = await service.create(actorOf(request), 'service', request.params.id, request.body);
        noStore(reply);
        return reply.code(201).send({ token: tokenJson(out.token), secret: out.secret });
      },
    );

    r.post(
      '/service-accounts/:id/tokens/:tokenId/rotate',
      {
        config: {
          authz: {
            action: 'serviceaccounts.manage',
            auditDenied: { action: 'api_token.rotate', target: () => 'api-token' },
          },
        },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'A new secret for a service account’s token (overlap as for personal tokens). The secret is in this answer only.',
          security: csrf,
          params: z.object({ id: Uuid, tokenId: Uuid }),
          body: RotateBody,
          response: { 200: IssuedBody, ...errors },
        },
      },
      async (request, reply) => {
        const out = await service.rotate(
          actorOf(request),
          request.params.tokenId,
          { principalId: request.params.id, kind: 'service' },
          request.body,
        );
        noStore(reply);
        return { token: tokenJson(out.token), secret: out.secret };
      },
    );
  };
}
