import { apiRequest, int, nullableStr, obj, str, strArray } from './client';

/**
 * p16-webhooks-out (docs/design/p16-webhooks-out.md §8, ADR-0059): Ayarlar → Webhook'lar — outgoing webhooks, the
 * event catalog, the delivery log, the owner's internal targets. A signing secret arrives only in the answer of
 * create / rotate / reveal and is never stored by the console.
 */

export type WebhookState = 'active' | 'paused' | 'disabled';
export type DeliveryStatus = 'pending' | 'succeeded' | 'failed';

export interface WebhookHeader {
  readonly name: string;
  readonly value: string | null;
  readonly secret: boolean;
  readonly hint: string | null;
}

export interface Webhook {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly project: string | null;
  readonly eventTypes: readonly string[];
  readonly includeDetails: boolean;
  readonly headers: readonly WebhookHeader[];
  readonly secretHint: string;
  readonly secretCreatedAt: string;
  readonly secretRevealed: boolean;
  readonly previousValidUntil: string | null;
  readonly state: WebhookState;
  readonly disabledReason: string | null;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: string | null;
  readonly lastFailureAt: string | null;
  readonly createdAt: string;
  readonly createdBy: { readonly id: string; readonly username: string } | null;
  readonly stats: { readonly pending: number; readonly succeeded24h: number; readonly failed24h: number };
}

export interface CatalogEvent {
  readonly type: string;
  readonly description: string;
  readonly global: boolean;
  readonly subscribable: boolean;
  readonly example: Record<string, unknown>;
}

export interface WebhookCatalog {
  readonly catalogVersion: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly groups: Readonly<Record<string, readonly string[]>>;
  readonly events: readonly CatalogEvent[];
}

export interface Delivery {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly project: string | null;
  readonly status: DeliveryStatus;
  readonly test: boolean;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly lastLatencyMs: number | null;
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export interface DeliveryAttempt {
  readonly attempt: number;
  readonly startedAt: string;
  readonly latencyMs: number | null;
  readonly statusCode: number | null;
  readonly error: string | null;
  readonly responseExcerpt: string | null;
}

export interface WebhookSettings {
  readonly internalOrigins: readonly string[];
  readonly updatedAt: string | null;
  readonly updatedBy: { readonly id: string; readonly username: string } | null;
}

export interface HeaderInput {
  readonly name: string;
  readonly value?: string;
  readonly secret?: boolean;
  readonly keep?: boolean;
}

export interface WebhookInput {
  readonly name: string;
  readonly url: string;
  readonly project?: string | null;
  readonly eventTypes: readonly string[];
  readonly includeDetails?: boolean;
  readonly headers?: readonly HeaderInput[];
}

const numOrNull = (o: Record<string, unknown>, k: string): number | null =>
  typeof o[k] === 'number' ? o[k] : null;

function user(v: unknown): { id: string; username: string } | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  return { id: str(o, 'id'), username: str(o, 'username') };
}

export function parseWebhook(v: unknown): Webhook {
  const o = obj(v);
  const s = obj(o.stats ?? {});
  const state = o.state === 'paused' || o.state === 'disabled' ? o.state : 'active';
  return {
    id: str(o, 'id'),
    name: str(o, 'name'),
    url: str(o, 'url'),
    project: nullableStr(o, 'project'),
    eventTypes: strArray(o, 'eventTypes'),
    includeDetails: o.includeDetails === true,
    headers: Array.isArray(o.headers)
      ? o.headers.map((h) => {
          const x = obj(h);
          return {
            name: str(x, 'name'),
            value: nullableStr(x, 'value'),
            secret: x.secret === true,
            hint: nullableStr(x, 'hint'),
          };
        })
      : [],
    secretHint: str(o, 'secretHint'),
    secretCreatedAt: str(o, 'secretCreatedAt'),
    secretRevealed: o.secretRevealed === true,
    previousValidUntil: nullableStr(o, 'previousValidUntil'),
    state,
    disabledReason: nullableStr(o, 'disabledReason'),
    consecutiveFailures: int(o, 'consecutiveFailures'),
    lastSuccessAt: nullableStr(o, 'lastSuccessAt'),
    lastFailureAt: nullableStr(o, 'lastFailureAt'),
    createdAt: str(o, 'createdAt'),
    createdBy: user(o.createdBy),
    stats: {
      pending: typeof s.pending === 'number' ? s.pending : 0,
      succeeded24h: typeof s.succeeded24h === 'number' ? s.succeeded24h : 0,
      failed24h: typeof s.failed24h === 'number' ? s.failed24h : 0,
    },
  };
}

export function parseDelivery(v: unknown): Delivery {
  const o = obj(v);
  const status = o.status === 'succeeded' || o.status === 'failed' ? o.status : 'pending';
  return {
    id: str(o, 'id'),
    eventId: str(o, 'eventId'),
    eventType: str(o, 'eventType'),
    project: nullableStr(o, 'project'),
    status,
    test: o.test === true,
    attempts: int(o, 'attempts'),
    nextAttemptAt: nullableStr(o, 'nextAttemptAt'),
    lastStatusCode: numOrNull(o, 'lastStatusCode'),
    lastError: nullableStr(o, 'lastError'),
    lastLatencyMs: numOrNull(o, 'lastLatencyMs'),
    lastAttemptAt: nullableStr(o, 'lastAttemptAt'),
    createdAt: str(o, 'createdAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
  };
}

function parseAttempt(v: unknown): DeliveryAttempt {
  const o = obj(v);
  return {
    attempt: int(o, 'attempt'),
    startedAt: str(o, 'startedAt'),
    latencyMs: numOrNull(o, 'latencyMs'),
    statusCode: numOrNull(o, 'statusCode'),
    error: nullableStr(o, 'error'),
    responseExcerpt: nullableStr(o, 'responseExcerpt'),
  };
}

function parseSettings(v: unknown): WebhookSettings {
  const o = obj(v);
  return {
    internalOrigins: strArray(o, 'internalOrigins'),
    updatedAt: nullableStr(o, 'updatedAt'),
    updatedBy: user(o.updatedBy),
  };
}

function parseCatalog(v: unknown): WebhookCatalog {
  const o = obj(v);
  const groups = obj(o.groups ?? {});
  return {
    catalogVersion: int(o, 'catalogVersion'),
    headers: Object.fromEntries(
      Object.entries(obj(o.headers ?? {})).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
    groups: Object.fromEntries(Object.keys(groups).map((k) => [k, strArray(groups, k)])),
    events: Array.isArray(o.events)
      ? o.events.map((e) => {
          const x = obj(e);
          return {
            type: str(x, 'type'),
            description: str(x, 'description'),
            global: x.global === true,
            subscribable: x.subscribable === true,
            example: obj(x.example ?? {}),
          };
        })
      : [],
  };
}

const enc = encodeURIComponent;

export function getWebhookCatalog(): Promise<WebhookCatalog> {
  return apiRequest('GET', '/webhooks/catalog', parseCatalog);
}

export function listWebhooks(): Promise<{ items: Webhook[]; maxAttempts: number }> {
  return apiRequest('GET', '/webhooks', (b) => {
    const o = obj(b);
    return {
      items: Array.isArray(o.items) ? o.items.map(parseWebhook) : [],
      maxAttempts: typeof o.maxAttempts === 'number' ? o.maxAttempts : 7,
    };
  });
}

export function createWebhook(input: WebhookInput): Promise<{ webhook: Webhook; secret: string }> {
  return apiRequest(
    'POST',
    '/webhooks',
    (b) => ({ webhook: parseWebhook(obj(b).webhook), secret: str(obj(b), 'secret') }),
    { body: input },
  );
}

export function deleteWebhook(id: string): Promise<void> {
  return apiRequest('DELETE', `/webhooks/${enc(id)}`, () => undefined);
}

export function setWebhookState(id: string, state: 'paused' | 'active'): Promise<Webhook> {
  return apiRequest('POST', `/webhooks/${enc(id)}/${state === 'paused' ? 'pause' : 'resume'}`, (b) =>
    parseWebhook(obj(b).webhook),
  );
}

export function rotateWebhookSecret(
  id: string,
  overlapHours: number,
): Promise<{ webhook: Webhook; secret: string }> {
  return apiRequest(
    'POST',
    `/webhooks/${enc(id)}/rotate`,
    (b) => ({ webhook: parseWebhook(obj(b).webhook), secret: str(obj(b), 'secret') }),
    { body: { overlapHours } },
  );
}

export function revealWebhookSecret(id: string): Promise<string> {
  return apiRequest('POST', `/webhooks/${enc(id)}/secret`, (b) => str(obj(b), 'secret'));
}

export function testWebhook(id: string): Promise<{ delivery: Delivery; attempts: DeliveryAttempt[] }> {
  return apiRequest('POST', `/webhooks/${enc(id)}/test`, (b) => {
    const o = obj(b);
    return {
      delivery: parseDelivery(o.delivery),
      attempts: Array.isArray(o.attempts) ? o.attempts.map(parseAttempt) : [],
    };
  });
}

export function listDeliveries(
  id: string,
  q: { status?: DeliveryStatus; before?: string } = {},
): Promise<{ items: Delivery[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (q.status !== undefined) params.set('status', q.status);
  if (q.before !== undefined) params.set('before', q.before);
  const qs = params.toString();
  return apiRequest('GET', `/webhooks/${enc(id)}/deliveries${qs === '' ? '' : `?${qs}`}`, (b) => {
    const o = obj(b);
    return {
      items: Array.isArray(o.items) ? o.items.map(parseDelivery) : [],
      nextCursor: nullableStr(o, 'nextCursor'),
    };
  });
}

export function getDelivery(
  id: string,
  deliveryId: string,
): Promise<{ delivery: Delivery; attempts: DeliveryAttempt[]; body: string }> {
  return apiRequest('GET', `/webhooks/${enc(id)}/deliveries/${enc(deliveryId)}`, (b) => {
    const o = obj(b);
    return {
      delivery: parseDelivery(o.delivery),
      attempts: Array.isArray(o.attempts) ? o.attempts.map(parseAttempt) : [],
      body: str(o, 'body'),
    };
  });
}

export function redeliver(id: string, deliveryId: string): Promise<Delivery> {
  return apiRequest('POST', `/webhooks/${enc(id)}/deliveries/${enc(deliveryId)}/redeliver`, (b) =>
    parseDelivery(obj(b).delivery),
  );
}

export function getWebhookSettings(): Promise<WebhookSettings> {
  return apiRequest('GET', '/webhooks/settings', parseSettings);
}

export function setInternalOrigins(origins: readonly string[]): Promise<WebhookSettings> {
  return apiRequest('PUT', '/webhooks/settings', parseSettings, { body: { internalOrigins: origins } });
}

/** The receiver-side check the console shows next to a new secret (Node.js). */
export function verifySnippet(): string {
  return [
    "const [t, ...sigs] = req.headers['x-remyral-signature'].split(',');",
    'const ts = Number(t.slice(2));',
    "const want = crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');",
    'const ok = Math.abs(Date.now() / 1000 - ts) < 300 && sigs.some((s) => s === `v1=${want}`);',
  ].join('\n');
}
