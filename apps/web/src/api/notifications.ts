import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/** Typed wrappers for the master's notification routes (apps/master/src/notifications/routes.ts). */

export const KINDS = [
  'approval.requested',
  'approval.expiring',
  'job.failed',
  'worker.offline',
  'budget.threshold',
  'worker.pending',
  'alert',
  'worker.config',
  'vault.credential',
  'project.execution',
  'automation.failed',
  'automation.waiting',
  'deploy.waiting',
  'deploy.failed',
  'deploy.succeeded',
  'chat.watch',
  'chat.note',
  // p8-cost-efficiency.
  'budget.paused',
  'report.weekly',
  // p8-uptime
  'monitor.down',
  'monitor.up',
  // p9-queue-priority
  'job.waiting',
  // p10-backup-restore
  'backup.failed',
  'restore_drill.failed',
  // p10-verify-health
  'verify.failed',
  'deploy.unhealthy',
  // p10-approval-pause
  'approval.stale',
  'job.paused',
  // p11-usage-limit-fallback
  'usage_limit.reached',
  'usage_limit.reset',
  // p11-limit-visibility
  'usage_limit.near',
  'memory.review_due',
  // p17-auto-learning
  'memory.auto_learned',
  // p12-deploy-feedback
  'deploy.fix_started',
  // p13-fleet-tools
  'tools.updates',
  // p14-skill-import
  'skills.panel_published',
  // p14-mcp-core
  'mcp.project_enabled',
  // p14-workflow-engine 14.2
  'workflow.notify',
  // p14-workflow-engine 14.4: a workflow failed N times in a row (its owners).
  'workflow.failed',
  // p14-ask-user
  'job.question',
  // p15-auto-mode
  'job.auto_fix',
  // p15-chat-failover
  'chat.failover',
  // p17-panel-settings Part 0
  'backup.change_pending',
  'account.recovery',
  // p17-worker-managed: a machine update was rolled back or failed.
  'worker.update_failed',
  // p17-chat-flow: a workflow's approval step waits for a decision.
  'workflow.approval',
  // p18-multi-project: a shared workflow's new version waits for this project's admins.
  'workflow.update_pending',
  // p18-plan-mode W4: a conversation's plan needs its owner (decision, blocked, back in review) or is done.
  'chat.plan',
  // p20-job-clock: a running job's time limit is nearly used up.
  'job.time_warning',
] as const;
export type NotificationKind = (typeof KINDS)[number];
export type Severity = 'info' | 'warning' | 'critical';

export interface AppNotification {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  /** Console-relative path or null (validated: never an absolute or protocol-relative URL). */
  readonly link: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationPage {
  readonly items: readonly AppNotification[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

export interface KindPreference {
  readonly kind: NotificationKind;
  readonly label: string;
  readonly description: string;
  readonly email: boolean;
  readonly webhook: boolean;
  /** p8-pwa: Web Push to the user's installed apps / browsers. */
  readonly push: boolean;
}

export interface NotificationPreferences {
  readonly kinds: readonly KindPreference[];
  readonly email: { readonly available: boolean; readonly address: string | null };
  readonly webhook: { readonly available: boolean; readonly url: string | null };
  /** p8-pwa: `devices` = registered push devices. */
  readonly push: { readonly available: boolean; readonly devices: number };
}

export interface PreferencesUpdate {
  readonly kinds?: readonly { kind: NotificationKind; email?: boolean; webhook?: boolean; push?: boolean }[];
  readonly email?: string | null;
  readonly webhookUrl?: string | null;
}

type Opts = Omit<RequestOptions, 'body'>;

function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  if (typeof v !== 'boolean') throw new ShapeError(`expected boolean at ${key}`);
  return v;
}

function kind(o: Record<string, unknown>): NotificationKind {
  const k = str(o, 'kind');
  if (!(KINDS as readonly string[]).includes(k)) throw new ShapeError('unknown kind');
  return k as NotificationKind;
}

/** Only in-app paths are kept as links: `/x` but not `//host` or `https://…`. */
export function safeLink(value: string | null): string | null {
  return value !== null && /^\/(?!\/)[A-Za-z0-9/_.:=?&%-]*$/.test(value) ? value : null;
}

function notification(v: unknown): AppNotification {
  const o = obj(v);
  const severity = str(o, 'severity');
  if (severity !== 'info' && severity !== 'warning' && severity !== 'critical')
    throw new ShapeError('severity');
  return {
    id: str(o, 'id'),
    kind: kind(o),
    severity,
    title: str(o, 'title'),
    body: str(o, 'body'),
    link: safeLink(nullableStr(o, 'link')),
    createdAt: str(o, 'createdAt'),
    readAt: nullableStr(o, 'readAt'),
  };
}

export function listNotifications(
  query: { unread?: boolean; limit?: number; cursor?: string } = {},
  opts: Opts = {},
): Promise<NotificationPage> {
  const params = new URLSearchParams();
  if (query.unread === true) params.set('unread', 'true');
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  const qs = params.toString();
  return apiRequest(
    'GET',
    `/notifications${qs === '' ? '' : `?${qs}`}`,
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.items)) throw new ShapeError('items');
      return {
        items: o.items.map(notification),
        unreadCount: int(o, 'unreadCount'),
        nextCursor: nullableStr(o, 'nextCursor'),
      };
    },
    opts,
  );
}

export function markRead(id: string, opts: Opts = {}): Promise<{ unreadCount: number }> {
  return apiRequest(
    'POST',
    `/notifications/${encodeURIComponent(id)}/read`,
    (v) => ({ unreadCount: int(obj(v), 'unreadCount') }),
    opts,
  );
}

export function markAllRead(opts: Opts = {}): Promise<{ updated: number }> {
  return apiRequest('POST', '/notifications/read-all', (v) => ({ updated: int(obj(v), 'updated') }), opts);
}

function preferences(v: unknown): NotificationPreferences {
  const o = obj(v);
  if (!Array.isArray(o.kinds)) throw new ShapeError('kinds');
  const channels = obj(o.channels);
  const email = obj(channels.email);
  const webhook = obj(channels.webhook);
  // Tolerant of a master without p8-pwa (no push fields): push is then unavailable.
  const push = channels.push === undefined ? null : obj(channels.push);
  return {
    kinds: o.kinds.map((k) => {
      const ko = obj(k);
      return {
        kind: kind(ko),
        label: str(ko, 'label'),
        description: str(ko, 'description'),
        email: bool(ko, 'email'),
        webhook: bool(ko, 'webhook'),
        push: ko.push === undefined ? false : bool(ko, 'push'),
      };
    }),
    email: { available: bool(email, 'available'), address: nullableStr(email, 'address') },
    webhook: { available: bool(webhook, 'available'), url: nullableStr(webhook, 'url') },
    push:
      push === null
        ? { available: false, devices: 0 }
        : { available: bool(push, 'available'), devices: int(push, 'devices') },
  };
}

export function getPreferences(opts: Opts = {}): Promise<NotificationPreferences> {
  return apiRequest('GET', '/notifications/preferences', preferences, opts);
}

export function updatePreferences(
  update: PreferencesUpdate,
  opts: Opts = {},
): Promise<NotificationPreferences> {
  return apiRequest('PUT', '/notifications/preferences', preferences, { ...opts, body: update });
}

// ------------------------------------------------------------------------------------------------ p8-pwa

export interface PushDevice {
  readonly id: string;
  readonly label: string;
  /** Push service host, e.g. `fcm.googleapis.com` (the endpoint itself is never sent back). */
  readonly service: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly lastSuccessAt: string | null;
}

export interface PushStatus {
  readonly available: boolean;
  /** VAPID public key (base64url) — the `applicationServerKey`. */
  readonly publicKey: string | null;
  readonly devices: readonly PushDevice[];
}

function pushDevice(v: unknown): PushDevice {
  const o = obj(v);
  return {
    id: str(o, 'id'),
    label: str(o, 'label'),
    service: str(o, 'service'),
    createdAt: str(o, 'createdAt'),
    lastSeenAt: str(o, 'lastSeenAt'),
    lastSuccessAt: nullableStr(o, 'lastSuccessAt'),
  };
}

export function getPushStatus(opts: Opts = {}): Promise<PushStatus> {
  return apiRequest(
    'GET',
    '/notifications/push',
    (v) => {
      const o = obj(v);
      if (!Array.isArray(o.devices)) throw new ShapeError('devices');
      return {
        available: bool(o, 'available'),
        publicKey: nullableStr(o, 'publicKey'),
        devices: o.devices.map(pushDevice),
      };
    },
    opts,
  );
}

/** The browser's `PushSubscription.toJSON()`. */
export interface SubscriptionJson {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
}

export function registerPushSubscription(
  sub: SubscriptionJson,
  opts: Opts = {},
): Promise<{ device: PushDevice; created: boolean }> {
  return apiRequest(
    'POST',
    '/notifications/push/subscriptions',
    (v) => {
      const o = obj(v);
      return { device: pushDevice(o.device), created: bool(o, 'created') };
    },
    { ...opts, body: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } } },
  );
}

export function revokePushDevice(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'DELETE',
    `/notifications/push/subscriptions/${encodeURIComponent(id)}`,
    () => undefined,
    opts,
  );
}

export function unsubscribePushEndpoint(
  endpoint: string,
  reason: 'user' | 'logout',
  opts: Opts = {},
): Promise<{ removed: boolean }> {
  return apiRequest(
    'POST',
    '/notifications/push/unsubscribe',
    (v) => ({ removed: bool(obj(v), 'removed') }),
    { ...opts, body: { endpoint, reason } },
  );
}

export function sendTestPush(opts: Opts = {}): Promise<{ sent: number }> {
  return apiRequest('POST', '/notifications/push/test', (v) => ({ sent: int(obj(v), 'sent') }), opts);
}
