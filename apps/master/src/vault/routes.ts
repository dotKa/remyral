import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { offsetQuery, pageArray, pageFields } from '../http/pagination.js';
import { requireStepUp } from '../auth/hooks.js';
import { actorOf } from '../workers/routes.js';
import { CredentialInvalidError, type VaultService } from './service.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { MAX_CREDENTIAL_PROJECTS } from './projects.js';

const ErrorBody = ErrorBodySchema.extend({
  issues: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
});
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody, 404: ErrorBody, 409: ErrorBody };

/** Up to 32 workers × ≤ 22 KB ciphertext each. */
const VAULT_BODY_LIMIT = 1024 * 1024;
const MAX_WORKERS = 32;

const CredentialParams = z.object({ id: z.string().min(1).max(64) });
/** p22-vault-projects: a project allowlist (null: every project). */
const ProjectList = z.array(z.string().min(1).max(64)).min(1).max(MAX_CREDENTIAL_PROJECTS).nullable();
const WorkerParams = z.object({ id: z.string().min(1).max(64) });

/** Ciphertext for one worker. Only the shape is checked here; the service validates it fully. */
const SealedForWorker = z.strictObject({
  workerId: z.string().min(1).max(64),
  keyId: z.string().min(1).max(64),
  sealed: z.record(z.string(), z.unknown()),
});

const WorkerStatusView = z.object({
  workerId: z.string(),
  displayName: z.string(),
  version: z.number().int(),
  keyId: z.string(),
  status: z.enum(['pending', 'applied', 'rejected', 'revoking', 'revoked', 'needs_reseal', 'unsupported']),
  ackedVersion: z.number().int().nullable(),
  ackedAt: z.string().nullable(),
  reason: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});

/** Metadata only: no response schema has a field for a value or a ciphertext. */
const CredentialBody = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  env: z.string(),
  description: z.string().nullable(),
  version: z.number().int(),
  state: z.enum(['active', 'revoked']),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  /** p14-workflow-engine 14.3: hosts of an http-auth / smtp credential (null: other kinds). */
  allowedHosts: z.array(z.string()).nullable(),
  /** p22-vault-projects: the projects an http-auth / smtp credential may be used by (null: every project). */
  projects: z.array(z.string()).nullable(),
  workers: z.array(WorkerStatusView),
});

const VaultWorkerBody = z.object({
  workerId: z.string(),
  displayName: z.string(),
  state: z.string(),
  connected: z.boolean(),
  supported: z.boolean(),
  /** p15-chat-vault: can hold http-auth / smtp credentials (function-v1). */
  functionSupported: z.boolean(),
  key: z
    .object({
      keyId: z.string(),
      publicKey: z.string(),
      fingerprint: z.string(),
      createdAt: z.string(),
      pinnedAt: z.string(),
    })
    .nullable(),
  previousKeyId: z.string().nullable(),
});

async function handled<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CredentialInvalidError) {
      return reply.code(400).send({ error: err.code, message: err.publicMessage, issues: [...err.issues] });
    }
    throw err;
  }
}

/**
 * Credential vault API (p5-credentials-models, ADR-0016). Admin only; every write needs step-up and CSRF and is
 * audited. Write-only by construction: requests carry ciphertext sealed in the administrator's browser to each
 * worker's pinned vault key, responses carry metadata — no route accepts or returns a plaintext value.
 */
export function vaultRoutes(service: VaultService, clock: () => Date = () => new Date()) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['vault'];
    const session = [{ session: [] }];
    const csrf = [{ session: [], csrf: [] }];
    // Account-security class (p5-stepup-window): a TOTP from the last 10 minutes on every session type, even
    // remember-me / trusted-device sessions — a vault write changes what every runtime authenticates with.
    const stepUp = requireStepUp('always-fresh', clock);

    r.get(
      '/vault/workers',
      {
        config: { authz: { action: 'vault.read' } },
        schema: {
          tags,
          summary: 'Workers with their pinned vault public key (fingerprint) and vault support',
          security: session,
          response: { 200: z.object({ items: z.array(VaultWorkerBody) }), ...errors },
        },
      },
      async () => ({ items: await service.workers() }),
    );

    r.get(
      '/vault/credentials',
      {
        config: { authz: { action: 'vault.read' } },
        schema: {
          tags,
          summary: 'Vault credentials — metadata and per-worker delivery state only (values are never shown)',
          security: session,
          querystring: z.object(offsetQuery(500)),
          response: { 200: z.object({ items: z.array(CredentialBody), ...pageFields }), ...errors },
        },
      },
      async (request) => pageArray(await service.list(), request.query),
    );

    r.post(
      '/vault/credentials',
      {
        config: { authz: { action: 'vault.write' } },
        bodyLimit: VAULT_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Create a credential from values sealed in the browser to each worker (admin, step-up)',
          security: csrf,
          body: z.strictObject({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            kind: z.string().min(1).max(64),
            env: z.string().min(1).max(128),
            description: z.string().max(500).optional(),
            /** p14-workflow-engine 14.3: required for http-auth / smtp (`host` or `host:port`, ≤ 16). */
            allowedHosts: z.array(z.string().min(1).max(260)).max(16).optional(),
            /** p22-vault-projects: http-auth / smtp only; absent or null: every project. */
            projects: ProjectList.optional(),
            workers: z.array(SealedForWorker).min(1).max(MAX_WORKERS),
          }),
          response: { 200: CredentialBody, ...errors },
        },
      },
      async (request, reply) => handled(reply, () => service.create(request.body, actorOf(request))),
    );

    r.put(
      '/vault/credentials/:id/value',
      {
        config: { authz: { action: 'vault.write' } },
        bodyLimit: VAULT_BODY_LIMIT,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Rotate a credential: a new version sealed for the listed workers; workers not listed lose it (admin, step-up)',
          security: csrf,
          params: CredentialParams,
          body: z.strictObject({
            expectedVersion: z.number().int().min(1),
            workers: z.array(SealedForWorker).min(1).max(MAX_WORKERS),
          }),
          response: { 200: CredentialBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.setValue(request.params.id, request.body, actorOf(request))),
    );

    r.patch(
      '/vault/credentials/:id',
      {
        config: { authz: { action: 'vault.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Set which projects may use an http-auth / smtp credential (null: every project; unknown ids refused) (admin, step-up)',
          security: csrf,
          params: CredentialParams,
          body: z.strictObject({ projects: ProjectList }),
          response: { 200: CredentialBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.setProjects(request.params.id, request.body, actorOf(request))),
    );

    r.post(
      '/vault/credentials/:id/unshare',
      {
        config: { authz: { action: 'vault.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Remove a credential from some workers (deleted on them) (admin, step-up)',
          security: csrf,
          params: CredentialParams,
          body: z.strictObject({ workerIds: z.array(z.string().min(1).max(64)).min(1).max(1000) }),
          response: { 200: CredentialBody, ...errors },
        },
      },
      async (request, reply) =>
        handled(reply, () => service.unshare(request.params.id, request.body.workerIds, actorOf(request))),
    );

    r.delete(
      '/vault/credentials/:id',
      {
        config: { authz: { action: 'vault.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Revoke a credential everywhere; workers delete it and every ciphertext is erased (admin, step-up)',
          security: csrf,
          params: CredentialParams,
          response: { 200: CredentialBody, ...errors },
        },
      },
      async (request, reply) => handled(reply, () => service.revoke(request.params.id, actorOf(request))),
    );

    r.post(
      '/vault/workers/:id/rotate-key',
      {
        config: { authz: { action: 'vault.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Ask a worker to generate a new vault key (stored credentials stay valid) (admin, step-up)',
          security: csrf,
          params: WorkerParams,
          response: { 200: z.object({ requested: z.boolean() }), ...errors },
        },
      },
      async (request) => service.rotateKey(request.params.id, actorOf(request)),
    );
  };
}
