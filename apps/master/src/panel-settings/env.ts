import { OUTPUT_LIMITS } from '@remyral/protocol';
import type { PanelEnv, PanelEnvSecrets } from './service.js';

/**
 * p17-panel-settings: the environment's value of every panel setting (its explicit value or its default), built from
 * what the master was started with. main.ts passes the parts that only exist as environment / files (the webhook and
 * push channels, the HTTP search provider); compose.ts adds the ones it already receives as dependencies.
 */
const DAY_MS = 24 * 60 * 60_000;

export interface PanelEnvInput {
  readonly trustProxyHops?: number;
  readonly clientIpHeader?: { readonly header: string; readonly trustedSources: readonly string[] } | null;
  readonly loginPersistence?: {
    readonly trustedDeviceMs: number | null;
    readonly remember: { readonly idleMs: number; readonly absoluteMs: number } | null;
  };
  readonly rotationRequiresApproval?: boolean;
  readonly loginWaitMs?: number;
  /** p17-output-limits: JOB_OUTPUT_MAX_FILES. */
  readonly outputMaxFiles?: number;
  readonly logStore?: {
    readonly retentionDays: number;
    readonly minLevel: string;
    readonly requests: string;
  };
  readonly memory?: {
    readonly autoLearn?: boolean;
    readonly duplicateThreshold?: number;
    readonly chatPerThreadPerDay?: number;
  };
  readonly workflowEngine?: { readonly v2?: boolean; readonly v2ForV1?: boolean };
  readonly ops?: {
    readonly internalOrigins?: readonly string[];
    readonly controlPlaneResources?: readonly string[];
    readonly controlPlaneAddresses?: readonly string[];
  };
  /** Values only main.ts knows (NOTIFY_WEBHOOK_ALLOWLIST, PUSH_*, SEARCH_HTTP_*). */
  readonly extra?: PanelEnv;
}

export function panelEnvFrom(i: PanelEnvInput): PanelEnv {
  const lp = i.loginPersistence;
  const days = (ms: number | null | undefined): number | null =>
    ms === undefined ? null : ms === null ? 0 : Math.round(ms / DAY_MS);
  return {
    'net.trustProxyHops': i.trustProxyHops ?? 0,
    'net.clientIpHeader': i.clientIpHeader?.header ?? '',
    'net.clientIpSources': [...(i.clientIpHeader?.trustedSources ?? [])],
    'auth.rememberIdleDays': lp === undefined ? 7 : days(lp.remember === null ? null : lp.remember.idleMs),
    'auth.rememberAbsoluteDays':
      lp === undefined ? 30 : days(lp.remember === null ? null : lp.remember.absoluteMs),
    'auth.trustedDeviceDays': lp === undefined ? 30 : days(lp.trustedDeviceMs),
    'workers.rotationApproval': i.rotationRequiresApproval ?? false,
    'jobs.loginWaitMinutes': Math.round((i.loginWaitMs ?? 30 * 60_000) / 60_000),
    'jobs.outputMaxFiles': i.outputMaxFiles ?? OUTPUT_LIMITS.defaultMaxFiles,
    'logs.retentionDays': i.logStore?.retentionDays ?? 7,
    'logs.level': i.logStore?.minLevel ?? 'info',
    'logs.requests': i.logStore?.requests ?? 'problems',
    'memory.autoLearn': i.memory?.autoLearn ?? true,
    'memory.duplicateThreshold': i.memory?.duplicateThreshold ?? 0.9,
    'memory.chatPerThreadDay': i.memory?.chatPerThreadPerDay ?? 5,
    'workflow.engineV2': i.workflowEngine?.v2 === true,
    'workflow.engineV2ForV1': i.workflowEngine?.v2ForV1 === true,
    'ops.internalOrigins': [...(i.ops?.internalOrigins ?? [])],
    'ops.controlPlaneUuids': [...(i.ops?.controlPlaneResources ?? [])],
    'ops.controlPlaneAddresses': [...(i.ops?.controlPlaneAddresses ?? [])],
    ...i.extra,
  };
}

export interface PanelEnvDeps {
  /** NOTIFY_WEBHOOK_ALLOWLIST, PUSH_VAPID_SUBJECT, PUSH_ENDPOINT_ALLOWLIST, SEARCH_PROVIDER / SEARCH_HTTP_*. */
  readonly values?: PanelEnv;
  /** NOTIFY_WEBHOOK_SECRET_FILE, PUSH_VAPID_PRIVATE_KEY_FILE, SEARCH_HTTP_KEY_FILE — the files' content. */
  readonly secrets?: PanelEnvSecrets;
}
