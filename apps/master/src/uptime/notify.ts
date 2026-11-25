import type { Queryable } from '../db/pool.js';
import type { NotificationDraft } from '../notifications/model.js';
import { projectRecipients } from '../notifications/recipients.js';
import { MonitorOutboxPayload } from './outbox.js';

/**
 * p8-uptime: monitor.down / monitor.up notifications for the project's operators and above (kind settings and channels
 * apply as for every kind). Text from the monitor's name, its project, the fixed cause code and the master's own
 * duration — never a response body or provider error text. A flapping monitor gets one `monitor.down` "is flapping"
 * notice; the changes while it flaps are not notified (src/uptime/state.ts).
 */

const CAUSE_TEXT: Readonly<Record<string, string>> = {
  timeout: 'timed out',
  dns: 'the host name does not resolve',
  address_refused: 'the host resolves to a non-public address',
  url_refused: 'the URL is not allowed',
  connect: 'connection refused or reset',
  network: 'network error',
  tls: 'TLS certificate refused',
  status: 'unexpected HTTP status',
  keyword: 'keyword check failed',
  slow: 'slower than the maximum latency',
  redirect: 'too many or invalid redirects',
  provider_down: 'the provider reports it down',
  provider_not_found: 'not found at the provider',
  invalid_config: 'the monitor settings are no longer valid',
};

export function causeText(code: string | null): string {
  if (code === null) return 'failed';
  return CAUSE_TEXT[code] ?? code.replace(/_/g, ' ');
}

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 48) return rest === 0 ? `${String(h)} h` : `${String(h)} h ${String(rest)} min`;
  return `${String(Math.round(h / 24))} days`;
}

export async function monitorNotifications(
  db: Queryable,
  event: { readonly payload: unknown },
): Promise<{ recipients: readonly string[]; draft: NotificationDraft }[]> {
  const parsed = MonitorOutboxPayload.safeParse(event.payload);
  if (!parsed.success) return [];
  const p = parsed.data;
  const { rows } = await db.query<{ project: string; name: string; type: string }>(
    'SELECT project, name, type FROM uptime_monitors WHERE id = $1',
    [p.monitorId],
  );
  const m = rows[0];
  if (m === undefined) return [];
  let incident: { started_at: Date; ended_at: Date | null; cause: string } | undefined;
  if (p.incidentId !== null) {
    const r = await db.query<{ started_at: Date; ended_at: Date | null; cause: string }>(
      'SELECT started_at, ended_at, cause FROM uptime_incidents WHERE id = $1 AND monitor_id = $2',
      [p.incidentId, p.monitorId],
    );
    incident = r.rows[0];
  }
  const link = `/uptime/${encodeURIComponent(p.monitorId)}`;
  const where = `${m.name} (${m.project})`;
  let draft: NotificationDraft;
  if (p.event === 'down') {
    draft = {
      kind: 'monitor.down',
      severity: 'critical',
      title: `Down: ${m.name}`,
      body: `${where} is down — ${causeText(incident?.cause ?? null)}.`,
      link,
      dedupeKey: `monitor.down:${p.monitorId}:${p.checkId}`,
    };
  } else if (p.event === 'up') {
    const took =
      incident?.ended_at === null || incident === undefined
        ? ''
        : ` after ${durationText(incident.ended_at.getTime() - incident.started_at.getTime())}`;
    draft = {
      kind: 'monitor.up',
      severity: 'info',
      title: `Up again: ${m.name}`,
      body: `${where} is up again${took}.`,
      link,
      dedupeKey: `monitor.up:${p.monitorId}:${p.checkId}`,
    };
  } else if (p.event === 'tls') {
    const t = await db.query<{ tls_expires_at: Date | null }>(
      'SELECT tls_expires_at FROM uptime_monitors WHERE id = $1',
      [p.monitorId],
    );
    const exp = t.rows[0]?.tls_expires_at ?? null;
    if (exp === null) return [];
    draft = {
      kind: 'monitor.down',
      severity: 'warning',
      title: `Certificate expires soon: ${m.name}`,
      body: `The TLS certificate of ${where} expires on ${exp.toISOString().slice(0, 10)}.`,
      link,
      dedupeKey: `monitor.tls:${p.monitorId}:${exp.toISOString().slice(0, 10)}`,
    };
  } else {
    draft = {
      kind: 'monitor.down',
      severity: 'warning',
      title: `Flapping: ${m.name}`,
      body: `${where} keeps going down and up. Further changes are not notified until it is stable for 30 minutes.`,
      link,
      dedupeKey: `monitor.flapping:${p.monitorId}:${p.checkId}`,
    };
  }
  return [{ recipients: await projectRecipients(db, m.project, 'operator'), draft }];
}
