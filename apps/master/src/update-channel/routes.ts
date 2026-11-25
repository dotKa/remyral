import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { ReleaseVersion } from '@remyral/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { actorOf } from '../workers/routes.js';
import type { VersionCatalogService } from './catalog.js';
import { UPDATE_POLICIES, type UpdateChannelService } from './service.js';
import type { OwnerUpgradeService } from './upgrade.js';

/**
 * p17-update-channel (ADR-0065, docs/design/p17-update-channel.md §3): Ayarlar → Sürümler → Güncelleme kanalı.
 * Reading is `releases.read`; "Şimdi kontrol et" and "Güncelle" are `releases.publish` (admins; "Güncelle" with the
 * step-up of the `releases.publish` event); the policy is the owner's (`updates.channel.write`, same event).
 */
const ErrorBody = ErrorBodySchema;
const errors = {
  400: ErrorBody,
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody,
  502: ErrorBody,
};

const Release = z.object({
  version: z.string(),
  bump: z.string(),
  state: z.string(),
  error: z.string().nullable(),
  publishedAt: z.string(),
  summary: z.string(),
  notes: z.string(),
  protocolVersions: z.array(z.string()),
  imported: z.boolean(),
});
const CatalogItem = z.object({
  kind: z.enum(['runtime', 'tool']),
  item: z.string(),
  version: z.string(),
  verified: z.boolean(),
  verifiedAt: z.string().nullable(),
});
export const UpdateChannelBody = z.object({
  configured: z.boolean(),
  policy: z.enum(['patch_auto', 'manual', 'auto']),
  soakMinutes: z.number().int(),
  feed: z.object({
    source: z.enum(['url', 'file']).nullable(),
    keyId: z.string().nullable(),
    generatedAt: z.string().nullable(),
    checkedAt: z.string().nullable(),
    error: z.string().nullable(),
  }),
  stableVersion: z.string().nullable(),
  releases: z.array(Release),
  rollout: z
    .object({
      id: z.string(),
      version: z.string(),
      stage: z.string(),
      trigger: z.enum(['policy', 'owner']),
      startedAt: z.string(),
      stageAt: z.string(),
      finishedAt: z.string().nullable(),
      reason: z.string().nullable(),
      canary: z.array(z.object({ workerId: z.string(), status: z.string() })),
    })
    .nullable(),
  catalog: z.object({
    configured: z.boolean(),
    enabled: z.boolean(),
    checkedAt: z.string().nullable(),
    error: z.string().nullable(),
    keys: z.number().int(),
    sequence: z.number().int().nullable(),
    keyId: z.string().nullable(),
    generatedAt: z.string().nullable(),
    items: z.array(CatalogItem),
    workers: z.array(
      z.object({
        workerId: z.string(),
        enabled: z.boolean(),
        keys: z.number().int(),
        sequence: z.number().int(),
        lastOutcome: z.string().nullable(),
        lastReason: z.string().nullable(),
        reportedAt: z.string(),
      }),
    ),
  }),
});

export function updateChannelRoutes(deps: {
  readonly service: UpdateChannelService;
  readonly catalog: VersionCatalogService;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['releases'];
    const stepUp = requireStepUp(undefined, deps.clock);
    const body = async () => {
      const view = await deps.service.view();
      const cat = await deps.catalog.current();
      const st = deps.catalog.status();
      const items: z.infer<typeof CatalogItem>[] = [];
      for (const [item, list] of Object.entries(cat?.catalog.runtimes ?? {})) {
        for (const e of list)
          items.push({
            kind: 'runtime',
            item,
            version: e.version,
            verified: e.verified,
            verifiedAt: e.verifiedAt ?? null,
          });
      }
      for (const [item, list] of Object.entries(cat?.catalog.tools ?? {})) {
        for (const e of list)
          items.push({
            kind: 'tool',
            item,
            version: e.version,
            verified: e.verified,
            verifiedAt: e.verifiedAt ?? null,
          });
      }
      return {
        ...view,
        releases: view.releases.map((x) => ({ ...x, protocolVersions: [...x.protocolVersions] })),
        rollout: view.rollout === null ? null : { ...view.rollout, canary: [...view.rollout.canary] },
        catalog: {
          ...st,
          sequence: cat?.sequence ?? null,
          keyId: cat?.keyId ?? null,
          generatedAt: cat?.generatedAt ?? null,
          items,
          workers: (await deps.catalog.workers()).map((w) => ({
            workerId: w.workerId,
            enabled: w.enabled,
            keys: w.keys,
            sequence: w.sequence,
            lastOutcome: w.lastOutcome,
            lastReason: w.lastReason,
            reportedAt: w.reportedAt,
          })),
        },
      };
    };

    r.get(
      '/update-channel',
      {
        config: { authz: { action: 'releases.read' } },
        schema: {
          tags,
          summary:
            'Worker update channel: feed state, policy, releases from the feed, rollout, version catalog',
          security: [{ session: [] }],
          response: { 200: UpdateChannelBody, ...errors },
        },
      },
      () => body(),
    );
    r.post(
      '/update-channel/check',
      {
        config: { authz: { action: 'releases.publish' } },
        schema: {
          tags,
          summary:
            'Read the worker release feed and the version catalog now (release location and host cache)',
          security: [{ session: [], csrf: [] }],
          response: { 200: UpdateChannelBody, ...errors },
        },
      },
      async () => {
        await deps.service.check();
        await deps.catalog.refresh();
        return body();
      },
    );
    r.put(
      '/update-channel/policy',
      {
        config: { authz: { action: 'updates.channel.write' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary: 'Which worker releases roll out by themselves (owner; patch_auto by default)',
          security: [{ session: [], csrf: [] }],
          body: z.object({
            policy: z.enum(UPDATE_POLICIES as unknown as ['patch_auto', 'manual', 'auto']),
            soakMinutes: z.number().int().min(0).max(10_080).optional(),
          }),
          response: { 200: UpdateChannelBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.setPolicy(request.body, actorOf(request));
        return body();
      },
    );
    r.post(
      '/update-channel/releases/:version/install',
      {
        config: { authz: { action: 'releases.publish' } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            '"Güncelle": import the release if needed and roll it out, canary machines first (on a running canary stage: to every machine now)',
          security: [{ session: [], csrf: [] }],
          params: z.object({ version: ReleaseVersion }),
          response: { 200: UpdateChannelBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.install(request.params.version, actorOf(request));
        return body();
      },
    );
  };
}

const UpgradeBody = z.object({
  id: z.string(),
  kind: z.enum(['runtime', 'tool']),
  item: z.string(),
  version: z.string(),
  fromVersion: z.string().nullable(),
  state: z.string(),
  canaryResult: z.string().nullable(),
  actionId: z.string().nullable(),
  policies: z.record(z.string(), z.object({ before: z.number().int().nullable(), after: z.number().int() })),
  createdAt: z.string(),
});

/**
 * p17-update-channel (ADR-0065 §10): the owner upgrades one runtime / tool to an exact upstream version
 * (canary first, then on confirmation the fleet plus a new runtime policy version; one-click rollback). Owner-only
 * (`updates.channel.write`, step-up event `releases.publish`); the list is `releases.read`.
 */
export function ownerUpgradeRoutes(deps: {
  readonly service: OwnerUpgradeService;
  readonly clock?: () => Date;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const tags = ['releases'];
    const stepUp = requireStepUp(undefined, deps.clock);
    const write = { authz: { action: 'updates.channel.write' as const } };
    r.get(
      '/owner-upgrades',
      {
        config: { authz: { action: 'releases.read' } },
        schema: {
          tags,
          summary: 'Owner upgrades of runtimes / tools to exact upstream versions (newest first)',
          security: [{ session: [] }],
          response: { 200: z.object({ upgrades: z.array(UpgradeBody) }), ...errors },
        },
      },
      async () => ({
        upgrades: (await deps.service.list()).map((u) => ({ ...u, policies: { ...u.policies } })),
      }),
    );
    r.post(
      '/owner-upgrades',
      {
        config: write,
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Upgrade a runtime / tool to an exact upstream version: resolved from its official source with its published integrity, installed on the canary first',
          security: [{ session: [], csrf: [] }],
          body: z.object({
            kind: z.enum(['runtime', 'tool']),
            item: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
            version: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,63}$/),
          }),
          response: { 200: UpgradeBody, ...errors },
        },
      },
      async (request) => {
        const u = await deps.service.start(request.body, actorOf(request));
        return { ...u, policies: { ...u.policies } };
      },
    );
    for (const step of ['confirm', 'rollback'] as const) {
      r.post(
        `/owner-upgrades/:id/${step}`,
        {
          config: write,
          preHandler: stepUp,
          schema: {
            tags,
            summary:
              step === 'confirm'
                ? 'After the canary: every machine, and a new runtime policy version holding (or following) the version'
                : 'Back to the previous runtime policy version and the previous version on every machine',
            security: [{ session: [], csrf: [] }],
            params: z.object({ id: z.uuid() }),
            response: { 200: UpgradeBody, ...errors },
          },
        },
        async (request) => {
          const actor = actorOf(request);
          const u =
            step === 'confirm'
              ? await deps.service.confirm(request.params.id, actor)
              : await deps.service.rollback(request.params.id, actor);
          return { ...u, policies: { ...u.policies } };
        },
      );
    }
  };
}
