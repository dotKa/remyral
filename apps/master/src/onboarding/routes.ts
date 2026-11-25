import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import { authzOf } from '../http/route-authz.js';
import { ONBOARDING_STEPS, OnboardingError, type OnboardingService } from './service.js';

/**
 * p16-selfhost-onboarding §5: the first-run wizard's progress (owners only, `onboarding.manage`; no authenticator
 * code: the steps that change something sensitive — the security preset, connections — go through their own routes
 * and their own codes).
 */
const ErrorBody = ErrorBodySchema;
const errors = { 400: ErrorBody, 401: ErrorBody, 403: ErrorBody };
const tags = ['onboarding'];
const session = [{ session: [] }];
const csrf = [{ session: [], csrf: [] }];
const Step = z.enum(ONBOARDING_STEPS);

export const OnboardingBody = z.object({
  visible: z.boolean(),
  completedAt: z.string().nullable(),
  organisationName: z.string().nullable(),
  steps: z.array(z.object({ id: Step, state: z.enum(['todo', 'done', 'skipped']), detected: z.boolean() })),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  current: Step,
});

export function onboardingRoutes(deps: { readonly service: OnboardingService }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const manage = { authz: { action: 'onboarding.manage' as const } };
    const view = async (request: FastifyRequest): Promise<z.infer<typeof OnboardingBody>> => {
      const s = authzOf(request).subject;
      const v = await deps.service.view({ userId: s.userId, role: s.role });
      return { ...v, steps: v.steps.map((x) => ({ ...x })), progress: { ...v.progress } };
    };
    const fail = (err: unknown): never => {
      if (err instanceof OnboardingError)
        throw new HttpError(
          400,
          err.code === 'unknown_step' ? 'unknown_step' : 'invalid_organisation_name',
          err.message,
        );
      throw err;
    };

    r.get(
      '/onboarding',
      {
        config: manage,
        schema: {
          tags,
          summary:
            'The first-run wizard: steps (explicit marks + detected facts), progress, the resume point',
          security: session,
          response: { 200: OnboardingBody, ...errors },
        },
      },
      async (request) => view(request),
    );

    r.put(
      '/onboarding/organisation',
      {
        config: manage,
        schema: {
          tags,
          summary: 'Name the organisation (1-80 characters of plain text); marks the step done',
          security: csrf,
          body: z.strictObject({ name: z.string().max(200) }),
          response: { 200: OnboardingBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.setOrganisation(authzOf(request).subject.userId, request.body.name).catch(fail);
        return view(request);
      },
    );

    r.put(
      '/onboarding/steps/:step',
      {
        config: manage,
        schema: {
          tags,
          summary: 'Mark a wizard step done or skipped, or clear the mark (todo)',
          security: csrf,
          params: z.object({ step: z.string().max(40) }),
          body: z.strictObject({ state: z.enum(['todo', 'done', 'skipped']) }),
          response: { 200: OnboardingBody, ...errors },
        },
      },
      async (request) => {
        await deps.service
          .markStep(authzOf(request).subject.userId, request.params.step, request.body.state)
          .catch(fail);
        return view(request);
      },
    );

    r.post(
      '/onboarding/complete',
      {
        config: manage,
        schema: {
          tags,
          summary: 'Finish the wizard ("Hazırsın"): it is no longer shown',
          security: csrf,
          response: { 200: OnboardingBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.complete(authzOf(request).subject.userId);
        return view(request);
      },
    );

    r.post(
      '/onboarding/reopen',
      {
        config: manage,
        schema: {
          tags,
          summary: 'Show the wizard again (Ayarlar → Sistem durumu → Kurulum sihirbazı)',
          security: csrf,
          response: { 200: OnboardingBody, ...errors },
        },
      },
      async (request) => {
        await deps.service.reopen(authzOf(request).subject.userId);
        return view(request);
      },
    );
  };
}
