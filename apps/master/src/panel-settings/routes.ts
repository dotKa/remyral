import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireStepUp } from '../auth/hooks.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { actorOf } from '../workers/routes.js';
import { isPanelSection, PANEL_SECTIONS, type PanelSection, type SettingValue } from './registry.js';
import type { PanelSettingsService, SectionUpdate } from './service.js';

/**
 * p17-panel-settings (docs/design/p17-panel-settings.md §3): the panel side of the master-stored settings.
 *
 * - `GET /panel-settings/:section` (`settings.panel.read`, admin+): every setting of the section — effective value,
 *   the environment's value, the source ("panel" / "env"), whether a secret is set (never its value), whether a change
 *   needs a restart.
 * - `PUT /panel-settings/:section` (`settings.panel.write`, owners; step-up event `settings.panel`, safe core): values
 *   (null = back to the environment), secrets (write-only; null = remove), secrets the master generates. A section may
 *   add its own check before the save ({@link PanelRouteHooks.beforeSave}, e.g. the network section's lock-out guard).
 * - `GET /panel-settings/history` (`settings.panel.read`): the last saves (keys, non-secret values, who, when).
 */
const ErrorBody = ErrorBodySchema;
const Details = z.record(z.string(), z.unknown());
const errors = {
  400: ErrorBody.extend({ key: z.string().optional() }),
  401: ErrorBody,
  403: ErrorBody,
  404: ErrorBody,
  409: ErrorBody.extend({ details: Details.optional() }),
  503: ErrorBody,
};
const tags = ['panel-settings'];
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];

const Value = z.union([z.boolean(), z.number(), z.string(), z.array(z.string())]);

export const SettingBody = z.object({
  key: z.string(),
  kind: z.string(),
  env: z.string(),
  value: Value.nullable(),
  envValue: Value.nullable(),
  source: z.enum(['panel', 'env']),
  options: z.array(z.string()).nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  restart: z.boolean(),
  sensitive: z.boolean(),
  secretSet: z.boolean(),
  generated: z.enum(['random', 'vapid', 'ed25519']).nullable(),
});
export const SectionBody = z.object({
  section: z.enum(PANEL_SECTIONS),
  version: z.number().int(),
  fields: z.array(SettingBody),
  updatedAt: z.string().nullable(),
  /** Section-specific read-only facts (e.g. the client IP the master sees for this request). */
  info: Details,
});

export interface PanelRouteHooks {
  /** Extra facts for the section view (computed per request). */
  readonly info?: (
    section: PanelSection,
    request: FastifyRequest,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Runs before a save (may throw an HttpError, e.g. a confirmation the owner must give). */
  readonly beforeSave?: (
    section: PanelSection,
    update: SectionUpdate,
    request: FastifyRequest,
    confirm: readonly string[],
  ) => Promise<void> | void;
  /** Runs after a save (e.g. re-reading a dependent provider). */
  readonly afterSave?: (section: PanelSection, request: FastifyRequest) => Promise<void> | void;
}

function copy(v: SettingValue | null): boolean | number | string | string[] | null {
  return Array.isArray(v) ? [...(v as readonly string[])] : (v as boolean | number | string | null);
}

export function panelSettingsRoutes(deps: {
  readonly service: PanelSettingsService;
  readonly clock: () => Date;
  readonly hooks?: PanelRouteHooks;
}) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const stepUp = requireStepUp(undefined, deps.clock);
    const view = async (section: PanelSection, request: FastifyRequest) => {
      const v = deps.service.view(section);
      return {
        section: v.section,
        version: v.version,
        updatedAt: v.updatedAt,
        fields: v.fields.map((f) => ({
          ...f,
          value: copy(f.value),
          envValue: copy(f.envValue),
          options: f.options === null ? null : [...f.options],
        })),
        info: (await deps.hooks?.info?.(section, request)) ?? {},
      };
    };
    const sectionOf = (raw: string): PanelSection => {
      if (!isPanelSection(raw)) throw new HttpError(404, 'not_found', 'Not found.');
      return raw;
    };

    r.get(
      '/panel-settings/history',
      {
        config: { authz: { action: 'settings.panel.read' as const } },
        schema: {
          tags,
          summary: 'The last saves of the panel settings (keys, non-secret values, who, when)',
          security: session,
          response: {
            200: z.object({
              items: z.array(
                z.object({
                  version: z.number(),
                  section: z.string(),
                  changes: z.unknown(),
                  changedAt: z.string(),
                  changedBy: z.string().nullable(),
                }),
              ),
            }),
            ...errors,
          },
        },
      },
      async () => ({ items: [...(await deps.service.history(30))] }),
    );

    r.get(
      '/panel-settings/:section',
      {
        config: { authz: { action: 'settings.panel.read' as const } },
        schema: {
          tags,
          summary:
            'A section of the master-stored settings: effective value, the environment default, the source, secrets as "set" only',
          security: session,
          params: z.object({ section: z.string().max(32) }),
          response: { 200: SectionBody, ...errors },
        },
      },
      async (request) => view(sectionOf(request.params.section), request),
    );

    r.put(
      '/panel-settings/:section',
      {
        config: { authz: { action: 'settings.panel.write' as const } },
        preHandler: stepUp,
        schema: {
          tags,
          summary:
            'Change settings of a section (owners; values — null returns to the environment; write-only secrets; generated keys); audited and versioned',
          security: csrf,
          params: z.object({ section: z.string().max(32) }),
          body: z.strictObject({
            values: z.record(z.string().max(64), Value.nullable()).optional(),
            secrets: z.record(z.string().max(64), z.string().max(8192).nullable()).optional(),
            generate: z.array(z.string().max(64)).max(10).optional(),
            version: z.number().int().min(0).optional(),
            /** Confirmations the section asked for (e.g. `client_ip_change`). */
            confirm: z.array(z.string().max(40)).max(10).optional(),
          }),
          response: {
            200: SectionBody.extend({ generated: z.record(z.string(), z.string()) }),
            ...errors,
          },
        },
      },
      async (request) => {
        const section = sectionOf(request.params.section);
        const { confirm, ...update } = request.body;
        await deps.hooks?.beforeSave?.(section, update, request, confirm ?? []);
        const out = await deps.service.update(actorOf(request), section, update);
        await deps.hooks?.afterSave?.(section, request);
        return { ...(await view(section, request)), generated: { ...out.generated } };
      },
    );
  };
}
