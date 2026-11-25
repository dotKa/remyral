import { Redactor, SENSITIVE_KEY } from '@remyral/observability';

/**
 * p16-doctor (docs/design/p16-doctor.md §5): the configuration part of the support report — an **allowlist** of master
 * settings, never the configuration object itself. Each entry names a dotted path and how it is shown:
 *
 * - `value`: a boolean, a finite number or a short plain string (≤ 120 characters, no `://` — URLs go through `origin`);
 * - `present`: only whether it is set (file paths, URLs with credentials, key lists …);
 * - `count`: the length of an array (trusted keys, internal origins);
 * - `origin`: scheme + host + port of a URL (never a path, user, password or query).
 *
 * A path whose last segment looks like a secret (password, token, key, secret …) is refused even if listed, and every
 * string passes the Redactor. Anything not listed is not in the report.
 */
export type SummaryMode = 'value' | 'present' | 'count' | 'origin';

export const CONFIG_ALLOWLIST: readonly (readonly [string, SummaryMode])[] = [
  ['nodeEnv', 'value'],
  ['port', 'value'],
  ['logLevel', 'value'],
  ['databaseUrl', 'present'],
  ['databasePoolMax', 'value'],
  ['redisUrl', 'present'],
  ['trustProxyHops', 'value'],
  ['clientIpHeader', 'present'],
  ['workerRotationRequiresApproval', 'value'],
  ['bodyLimitBytes', 'value'],
  ['shutdownTimeoutMs', 'value'],
  ['rateLimitScale', 'value'],
  ['leaseSigningKeyFile', 'present'],
  ['leaseTtlMs', 'value'],
  ['leaseOfflineGraceMs', 'value'],
  ['continuity', 'present'],
  ['loginWaitMs', 'value'],
  ['outputMaxFiles', 'value'],
  ['releasePublicKeys', 'count'],
  ['installers.publicOrigin', 'origin'],
  ['installers.publicDownloads', 'value'],
  ['workflowEngine.v2', 'value'],
  ['workflowEngine.v2ForV1', 'value'],
  ['skillsPublicKeys', 'count'],
  ['skillsPanelKeyFile', 'present'],
  ['notifications.intervalMs', 'value'],
  ['notifications.publicUrl', 'origin'],
  ['notifications.smtp', 'present'],
  ['notifications.smtp.host', 'value'],
  ['notifications.smtp.port', 'value'],
  ['notifications.smtp.security', 'value'],
  ['notifications.webhook', 'present'],
  ['notifications.push', 'present'],
  ['gitflow.github', 'present'],
  ['gitflow.plainGit', 'value'],
  ['gitflow.githubHost', 'value'],
  ['ops.internalOrigins', 'count'],
  ['ops.controlPlaneResources', 'count'],
  ['telemetry.serviceName', 'value'],
  ['telemetry.environment', 'value'],
  ['telemetry.otlp', 'present'],
  ['telemetry.metrics', 'present'],
  ['observability.logStore.retentionDays', 'value'],
  ['observability.logStore.minLevel', 'value'],
  ['observability.logStore.requests', 'value'],
  ['observability.traces.recentLimit', 'value'],
  ['observability.traces.slowMs', 'value'],
  ['search.provider.kind', 'value'],
  ['observability.statusWebUrl', 'present'],
  ['observability.releaseTag', 'value'],
  ['alertIntervalMs', 'value'],
  ['backupStatusDir', 'present'],
  ['fleetToolsFeed', 'value'],
  ['loginPersistence.trustedDeviceDays', 'value'],
  ['loginPersistence.rememberIdleDays', 'value'],
  ['loginPersistence.rememberAbsoluteDays', 'value'],
  ['stepUp.windowMinutes', 'value'],
  ['agentmagnify', 'present'],
];

const redactor = new Redactor();
/** Secret-looking last segments (the deep redactor's key rule plus `key` / `file` of key material). */
const SECRET_SEGMENT = /(?:password|passwd|secret|token|credential|cookie|privatekey|apikey)/i;

function at(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const seg of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

function originOf(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** The allowlisted, redacted configuration summary (`config.json` of the support report). */
export function configSummary(
  config: unknown,
  allowlist: readonly (readonly [string, SummaryMode])[] = CONFIG_ALLOWLIST,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (config === null || typeof config !== 'object') return out;
  for (const [path, mode] of allowlist) {
    const last = path.split('.').pop() ?? path;
    const v = at(config, path);
    if (mode === 'present') {
      out[path] = v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
      continue;
    }
    if (SENSITIVE_KEY.test(last) || SECRET_SEGMENT.test(last)) continue;
    if (mode === 'count') {
      out[path] = Array.isArray(v) ? v.length : 0;
      continue;
    }
    if (mode === 'origin') {
      const o = originOf(v);
      out[path] = o === null ? null : redactor.redact(o);
      continue;
    }
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[path] = v;
    else if (typeof v === 'string' && v.length <= 120 && !v.includes('://')) out[path] = redactor.redact(v);
    else if (v === null || v === undefined) out[path] = null;
  }
  return out;
}
