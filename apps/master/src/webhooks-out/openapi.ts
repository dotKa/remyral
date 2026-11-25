import {
  exampleEnvelope,
  GLOBAL_EVENT_TYPES,
  WEBHOOK_CATALOG_VERSION,
  WEBHOOK_DATA_SCHEMAS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADERS,
} from '@remyral/protocol';
import { z } from 'zod';

/**
 * p16-webhooks-out: the catalog as OpenAPI 3.1 `webhooks` (one operation per event type: the request the master sends
 * to a receiver), served with /openapi.json and shown on the console's API page.
 */
export function webhooksOpenApi(): Record<string, unknown> {
  const headerParams = [
    {
      name: WEBHOOK_HEADERS.signature,
      in: 'header',
      required: true,
      description:
        '`t=<unix seconds>,v1=<hex>` — HMAC-SHA256 of `<t>.<raw body>` keyed with the webhook secret (`whsec_…`, its UTF-8 bytes). During a secret rotation one `v1` per valid secret. Compare in constant time; refuse a `t` older than 5 minutes.',
      schema: { type: 'string' },
    },
    {
      name: WEBHOOK_HEADERS.delivery,
      in: 'header',
      required: true,
      description: 'Delivery id — the same on every retry and redelivery: deduplicate on it (at-least-once).',
      schema: { type: 'string', format: 'uuid' },
    },
    {
      name: WEBHOOK_HEADERS.eventId,
      in: 'header',
      required: true,
      description: 'Event id (the body’s `id`).',
      schema: { type: 'string', format: 'uuid' },
    },
    {
      name: WEBHOOK_HEADERS.event,
      in: 'header',
      required: true,
      description: 'Event type (the body’s `type`).',
      schema: { type: 'string' },
    },
    {
      name: WEBHOOK_HEADERS.attempt,
      in: 'header',
      required: true,
      description: 'Attempt number, 1 for the first.',
      schema: { type: 'integer', minimum: 1 },
    },
  ];
  const out: Record<string, unknown> = {};
  for (const type of WEBHOOK_EVENT_TYPES) {
    const data = z.toJSONSchema(WEBHOOK_DATA_SCHEMAS[type], { unrepresentable: 'any' });
    delete (data as { $schema?: unknown }).$schema;
    out[type] = {
      post: {
        operationId: `webhook_${type.replaceAll('.', '_')}`,
        summary: WEBHOOK_EVENT_DESCRIPTIONS[type],
        description: `Catalog version ${String(WEBHOOK_CATALOG_VERSION)}. ${
          GLOBAL_EVENT_TYPES.includes(type) ? 'A global event: `project` is null.' : ''
        } Answer any 2xx within 10 seconds; anything else (or a timeout) is retried after 1 min, 5 min, 30 min, 2 h, 6 h and 24 h (±10 %). Redirects are not followed.`.trim(),
        tags: ['webhooks'],
        parameters: headerParams,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'type', 'catalogVersion', 'occurredAt', 'project', 'data'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  type: { const: type },
                  catalogVersion: { const: WEBHOOK_CATALOG_VERSION },
                  occurredAt: { type: 'string', format: 'date-time' },
                  project: { type: ['string', 'null'] },
                  data,
                },
              },
              example: exampleEnvelope(type),
            },
          },
        },
        responses: {
          '2XX': { description: 'Received (the body is ignored; at most 1 KiB is kept, redacted).' },
        },
      },
    };
  }
  return out;
}
