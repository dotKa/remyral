import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConnectionCaps } from '../http/connection-caps.js';
import { CONNECTION_CAPS } from '../http/rate-policy.js';
import type { AutomationService } from './service.js';

/**
 * p14-workflow-engine 14.4 (design §20.5): the answer of a webhook call whose workflow trigger holds the request
 * (`responseMode: wait`) — the run's `control.respond` answer, `failed` when the run ended before answering, or null
 * (answer with the normal 202: not held, timeout, client gone, no answer).
 */
export type WebhookResponder = (
  automationId: string,
  automationRunId: string,
  signal: AbortSignal,
) => Promise<
  | {
      readonly kind: 'answer';
      readonly answer: { status: number; headers: Readonly<Record<string, string>>; body: string };
    }
  | { readonly kind: 'failed' }
  | null
>;

/** p14-workflow-engine 14.2: resumes a waiting workflow node (`/v1/hooks/wait/:token`); absent: 404. */
export type WaitReceiver = (
  token: string,
  headers: { timestamp?: string | undefined; nonce?: string | undefined; signature?: string | undefined },
  raw: Buffer,
  meta: { readonly ip: string | null },
) => Promise<{ status: 202 | 400 | 404; body: Record<string, unknown> }>;

/**
 * Inbound automation triggers (docs/design/p6-automations.md §8): `POST /v1/hooks/github` (GitHub App deliveries,
 * `X-Hub-Signature-256`) and `POST /v1/hooks/<automation id>` (Remyral-signed webhooks). Public — no session, no
 * CSRF — and authenticated by the signature over the **raw body**: this plugin scope replaces the JSON parser with
 * one that keeps the bytes (Fastify parsers are encapsulated per plugin, other routes are unaffected). Routed by
 * Traefik (`PathPrefix(/v1/hooks/)`), rate-limited per IP by the `public` class, body-limited per route.
 */

export const GITHUB_HOOK_BODY_LIMIT = 1024 * 1024;
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
/** p14-workflow-engine 14.2: a webhook wait's resume payload (stored as untrusted data). */
export const WAIT_HOOK_BODY_LIMIT = 64 * 1024;

function header(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' ? v : undefined;
}

function rawOf(request: FastifyRequest): Buffer {
  return Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
}

export function automationHookRoutes(deps: {
  readonly service: AutomationService;
  readonly waits?: WaitReceiver;
  /** p14-workflow-engine 14.4: answers of held webhook calls (absent: every call is answered at once). */
  readonly respond?: WebhookResponder;
  /** Concurrent held calls (default CONNECTION_CAPS.webhookWait per master process). */
  readonly holdCaps?: ConnectionCaps;
}) {
  const holds = deps.holdCaps ?? new ConnectionCaps(CONNECTION_CAPS.webhookWait);
  return (app: FastifyInstance): void => {
    const keepBytes = (
      _req: FastifyRequest,
      body: Buffer,
      done: (err: Error | null, body?: Buffer) => void,
    ) => {
      done(null, body);
    };
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, keepBytes);
    // GitHub Apps default to form-encoded deliveries (`payload=<json>`) unless the hook is set to JSON.
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, keepBytes);

    app.post(
      '/v1/hooks/github',
      {
        config: { auth: 'public' },
        bodyLimit: GITHUB_HOOK_BODY_LIMIT,
        schema: { hide: true },
      },
      async (request, reply) => {
        const out = await deps.service.receiveGitHub(
          {
            event: header(request, 'x-github-event'),
            delivery: header(request, 'x-github-delivery'),
            signature: header(request, 'x-hub-signature-256'),
            contentType: header(request, 'content-type'),
            // p17-chat-github: which App sent it (several GitHub App connections; each has its own secret).
            hookTargetType: header(request, 'x-github-hook-installation-target-type'),
            hookTargetId: header(request, 'x-github-hook-installation-target-id'),
          },
          rawOf(request),
        );
        return reply.code(out.status).header('cache-control', 'no-store').send(out.body);
      },
    );

    // p14-workflow-engine 14.2: a workflow's webhook wait — capability token (+ the Remyral signature of the workflow's
    // webhook trigger unless the node is token-only); unknown / used / expired tokens all answer 404.
    app.post<{ Params: { token: string } }>(
      '/v1/hooks/wait/:token',
      {
        config: { auth: 'public' },
        bodyLimit: WAIT_HOOK_BODY_LIMIT,
        schema: { hide: true },
      },
      async (request, reply) => {
        const out =
          deps.waits === undefined
            ? { status: 404 as const, body: { error: 'not_found', message: 'Not found.' } }
            : await deps.waits(
                request.params.token,
                {
                  timestamp: header(request, 'x-remyral-timestamp'),
                  nonce: header(request, 'x-remyral-nonce'),
                  signature: header(request, 'x-remyral-signature'),
                },
                rawOf(request),
                { ip: request.ip },
              );
        return reply.code(out.status).header('cache-control', 'no-store').send(out.body);
      },
    );

    app.post<{ Params: { id: string } }>(
      '/v1/hooks/:id',
      {
        config: { auth: 'public' },
        bodyLimit: WEBHOOK_BODY_LIMIT,
        schema: { hide: true },
      },
      async (request, reply) => {
        const out = await deps.service.receiveWebhook(
          request.params.id,
          {
            timestamp: header(request, 'x-remyral-timestamp'),
            nonce: header(request, 'x-remyral-nonce'),
            signature: header(request, 'x-remyral-signature'),
          },
          rawOf(request),
          { ip: request.ip },
        );
        // 14.4: a workflow trigger with `responseMode: wait` holds the accepted call for its `control.respond`.
        const runs = (out.body as { runs?: unknown }).runs;
        const automationRun = Array.isArray(runs) && typeof runs[0] === 'string' ? runs[0] : null;
        if (out.status === 202 && automationRun !== null && deps.respond !== undefined) {
          const release = holds.tryAcquire(request.params.id);
          if (release !== null) {
            const ctl = new AbortController();
            const onClose = (): void => {
              ctl.abort();
            };
            reply.raw.once('close', onClose);
            try {
              const held = await deps.respond(request.params.id, automationRun, ctl.signal);
              if (held?.kind === 'answer' && !ctl.signal.aborted) {
                const a = held.answer;
                const headers: Record<string, string> = {
                  'cache-control': 'no-store',
                  ...a.headers,
                  'x-content-type-options': 'nosniff',
                  'content-security-policy': "sandbox; default-src 'none'",
                };
                return await reply.code(a.status).headers(headers).send(a.body);
              }
              if (held?.kind === 'failed')
                return await reply
                  .code(500)
                  .header('cache-control', 'no-store')
                  .send({ error: 'workflow_failed', message: 'The workflow ended before it answered.' });
            } finally {
              reply.raw.off('close', onClose);
              release();
            }
          }
        }
        return reply.code(out.status).header('cache-control', 'no-store').send(out.body);
      },
    );
  };
}
