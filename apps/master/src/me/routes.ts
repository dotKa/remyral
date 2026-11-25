import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { Locale } from '@remyral/i18n';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized } from '../http/route-auth.js';
import type { AuthzRule } from '../http/route-authz.js';
import type { UserLocaleService } from './locale.js';
import { THEMES, type UserThemeService } from './theme.js';
import {
  type DecisionDeferralService,
  DEFERRAL_KEY,
  DEFERRAL_MODES,
  MAX_DEFERRALS_PER_WRITE,
} from './deferrals.js';
import { ErrorBodySchema } from '../http/error-schema.js';

/** The caller's own account (p5-rbac `session.self`): any signed-in role, never another user's row. */
const SELF: AuthzRule = {
  action: 'session.self',
  resource: (request) => ({ ownerId: request.auth?.session.user.id ?? null }),
};

const ErrorBody = ErrorBodySchema;
const LocaleSchema = z.enum(['tr', 'en']) satisfies z.ZodType<Locale>;

/** `{"locale":"en"}` is 15 bytes; 1 KiB leaves room for whitespace and nothing else. */
export const ME_LOCALE_BODY_LIMIT = 1024;

/**
 * p14-i18n-foundation (ADR-0053): the caller's own preferences under `/me/*`. `PUT /me/locale` stores the
 * console language (`write` class, per-user budget, CSRF; no step-up: it changes only the language of text).
 * The effective language is read back with `GET /auth/session` (`locale`).
 */
export function meRoutes(
  locales: UserLocaleService,
  themes?: UserThemeService,
  deferrals?: DecisionDeferralService,
) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.put(
      '/me/locale',
      {
        config: { authz: SELF },
        bodyLimit: ME_LOCALE_BODY_LIMIT,
        schema: {
          tags: ['auth'],
          summary: 'Set the console language of the current user (tr = Turkish, en = English)',
          security: [{ session: [], csrf: [] }],
          body: z.strictObject({ locale: LocaleSchema }),
          response: {
            200: z.object({ locale: LocaleSchema, changed: z.boolean() }),
            400: ErrorBody,
            401: ErrorBody,
            403: ErrorBody,
            429: ErrorBody,
          },
        },
      },
      async (request) => {
        const userId = request.auth?.session.user.id;
        if (userId === undefined) throw unauthorized(); // unreachable: the auth hook ran first
        const { changed } = await locales.change(userId, request.body.locale, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        return { locale: request.body.locale, changed };
      },
    );
    if (deferrals !== undefined) deferralRoutes(app, deferrals);
    if (themes === undefined) return;
    // p17-remyral-brand: the console colour theme (light / dark / system = follow the device). Same class as the
    // language: own row only, CSRF, no step-up (presentation only). Read back with `GET /auth/session` (`theme`).
    const ThemeSchema = z.enum(THEMES);
    r.put(
      '/me/theme',
      {
        config: { authz: SELF },
        bodyLimit: ME_LOCALE_BODY_LIMIT,
        schema: {
          tags: ['auth'],
          summary:
            'Set the console colour theme of the current user (light, dark, or system = follow the device)',
          security: [{ session: [], csrf: [] }],
          body: z.strictObject({ theme: ThemeSchema }),
          response: {
            200: z.object({ theme: ThemeSchema, changed: z.boolean() }),
            400: ErrorBody,
            401: ErrorBody,
            403: ErrorBody,
            429: ErrorBody,
          },
        },
      },
      async (request) => {
        const userId = request.auth?.session.user.id;
        if (userId === undefined) throw unauthorized(); // unreachable: the auth hook ran first
        const { changed } = await themes.change(userId, request.body.theme, {
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
        return { theme: request.body.theme, changed };
      },
    );
  };
}

/** `{items:[…]}` of 200 keys of ≤ 241 characters plus mode and time: well under 64 KiB. */
export const ME_DEFERRALS_BODY_LIMIT = 64 * 1024;

const DeferralKey = z.string().regex(DEFERRAL_KEY);
const DeferralMode = z.enum(DEFERRAL_MODES);
const DeferralBody = z.object({ key: z.string(), mode: DeferralMode, until: z.string() });

/**
 * p20-decisions (docs/design/p20-decisions.md): the caller's own put-off / ignored decisions of "Senden bekleyen" —
 * read by the sidebar badge, the home and /needs alike, on every device. Own rows only (`session.self`); writes are
 * the `write` class with CSRF and an audit row; no step-up (presentation of one's own lists; nothing is decided).
 */
function deferralRoutes(app: FastifyInstance, deferrals: DecisionDeferralService): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const meta = (request: { ip: string; headers: Record<string, unknown> }) => ({
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
  });
  r.get(
    '/me/deferrals',
    {
      config: { authz: SELF },
      schema: {
        tags: ['auth'],
        summary:
          'The decisions the current user put off (snooze, a day) or ignored (a week) on "Senden bekleyen" — only those still in force',
        security: [{ session: [] }],
        response: {
          200: z.object({ items: z.array(DeferralBody) }),
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
        },
      },
    },
    async (request) => {
      const userId = request.auth?.session.user.id;
      if (userId === undefined) throw unauthorized(); // unreachable: the auth hook ran first
      return { items: await deferrals.list(userId) };
    },
  );
  r.put(
    '/me/deferrals',
    {
      config: { authz: SELF },
      bodyLimit: ME_DEFERRALS_BODY_LIMIT,
      schema: {
        tags: ['auth'],
        summary:
          'Put decisions off (snooze) or ignore them for the current user; until absent: a day / a week, at most a week; a past until is skipped',
        security: [{ session: [], csrf: [] }],
        body: z.strictObject({
          items: z
            .array(
              z.strictObject({
                key: DeferralKey,
                mode: DeferralMode,
                until: z.iso.datetime({ offset: true }).optional(),
              }),
            )
            .min(1)
            .max(MAX_DEFERRALS_PER_WRITE),
        }),
        response: {
          200: z.object({ stored: z.number().int() }),
          400: ErrorBody,
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
        },
      },
    },
    async (request) => {
      const userId = request.auth?.session.user.id;
      if (userId === undefined) throw unauthorized(); // unreachable: the auth hook ran first
      return deferrals.put(userId, request.body.items, meta(request));
    },
  );
  r.delete(
    '/me/deferrals',
    {
      config: { authz: SELF },
      schema: {
        tags: ['auth'],
        summary:
          'Bring put-off / ignored decisions back for the current user: one (key) or every one of a mode (mode)',
        security: [{ session: [], csrf: [] }],
        querystring: z
          .strictObject({ key: DeferralKey.optional(), mode: DeferralMode.optional() })
          .refine((q) => q.key !== undefined || q.mode !== undefined, { message: 'key or mode is required' }),
        response: {
          200: z.object({ removed: z.number().int() }),
          400: ErrorBody,
          401: ErrorBody,
          403: ErrorBody,
          429: ErrorBody,
        },
      },
    },
    async (request) => {
      const userId = request.auth?.session.user.id;
      if (userId === undefined) throw unauthorized(); // unreachable: the auth hook ran first
      return deferrals.remove(userId, request.query, meta(request));
    },
  );
}
