import { apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str, strArray } from './client';

/**
 * p17-host-actions (docs/design/p17-host-actions.md): requests the remyral-ctl host applier carries out —
 * `GET /host-actions`, `GET /host-actions/requests/:id`, `POST /host-actions/upgrade`, `POST /host-actions/rollback`,
 * `POST /host-actions/requests/:id/cancel` (apps/master/src/host-actions/routes.ts).
 */

type Opts = Omit<RequestOptions, 'body'>;

export const HOST_ACTION_STATES = [
  'pending',
  'applying',
  'applied',
  'scheduled',
  'rolled_back',
  'held',
  'failed',
  'refused',
  'expired',
  'cancelled',
] as const;
export type HostActionState = (typeof HOST_ACTION_STATES)[number];
export const OPEN_STATES: readonly HostActionState[] = ['pending', 'applying'];

export interface HostAction {
  readonly id: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, string | boolean | number | null>>;
  readonly state: HostActionState;
  readonly step: string | null;
  readonly detail: string | null;
  readonly log: readonly string[];
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface Applier {
  readonly managed: boolean;
  readonly lastSeen: string | null;
  readonly version: string | null;
  readonly kinds: readonly string[];
  readonly current: string | null;
  readonly previous: string | null;
  readonly releases: readonly string[];
}

export interface HostActions {
  readonly applier: Applier;
  readonly open: HostAction | null;
  readonly recent: readonly HostAction[];
}

export function parseHostAction(v: unknown): HostAction {
  const o = obj(v);
  const state = str(o, 'state');
  if (!(HOST_ACTION_STATES as readonly string[]).includes(state))
    throw new ShapeError('unknown request state');
  const p = obj(o.params ?? {});
  const params: Record<string, string | boolean | number | null> = {};
  for (const [k, x] of Object.entries(p)) {
    if (x === null || typeof x === 'string' || typeof x === 'boolean' || typeof x === 'number') params[k] = x;
  }
  return {
    id: str(o, 'id'),
    kind: str(o, 'kind'),
    params,
    state: state as HostActionState,
    step: nullableStr(o, 'step'),
    detail: nullableStr(o, 'detail'),
    log: strArray(o, 'log'),
    requestedAt: str(o, 'requestedAt'),
    expiresAt: str(o, 'expiresAt'),
    updatedAt: str(o, 'updatedAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
  };
}

export function parseApplier(v: unknown): Applier {
  const a = obj(v);
  return {
    managed: a.managed === true,
    lastSeen: nullableStr(a, 'lastSeen'),
    version: nullableStr(a, 'version'),
    kinds: strArray(a, 'kinds'),
    current: nullableStr(a, 'current'),
    previous: nullableStr(a, 'previous'),
    releases: strArray(a, 'releases'),
  };
}

export function parseHostActions(body: unknown): HostActions {
  const o = obj(body);
  return {
    applier: parseApplier(o.applier),
    open: o.open === null || o.open === undefined ? null : parseHostAction(o.open),
    recent: Array.isArray(o.recent) ? o.recent.map(parseHostAction) : [],
  };
}

export function getHostActions(opts: Opts = {}): Promise<HostActions> {
  return apiRequest('GET', '/host-actions', parseHostActions, opts);
}

/** The console polls this while a request runs (also while the master restarts during an upgrade). */
export function getHostAction(id: string, opts: Opts = {}): Promise<HostAction> {
  return apiRequest('GET', `/host-actions/requests/${encodeURIComponent(id)}`, parseHostAction, opts);
}

export function requestUpgrade(
  input: { readonly version: string; readonly acceptBreaking: boolean },
  opts: Opts = {},
): Promise<HostAction> {
  return apiRequest('POST', '/host-actions/upgrade', parseHostAction, { ...opts, body: input });
}

export function requestRollback(
  input: {
    readonly version: string;
    readonly backupId?: string | null;
    readonly restoreDatabase?: boolean;
    readonly confirm?: string;
  },
  opts: Opts = {},
): Promise<HostAction> {
  return apiRequest('POST', '/host-actions/rollback', parseHostAction, { ...opts, body: input });
}

export function cancelHostAction(id: string, opts: Opts = {}): Promise<HostAction> {
  return apiRequest('POST', `/host-actions/requests/${encodeURIComponent(id)}/cancel`, parseHostAction, opts);
}

// ---------------------------------------------------------------- backups (part 3)

export interface HostBackupSettings {
  readonly time: string;
  readonly intervalMinutes: string;
  readonly keepDaily: string;
  readonly keepWeekly: string;
  readonly keepMonthly: string;
  readonly keepRecentHours: string;
  readonly drillEnabled: string;
  readonly drillWeekday: string;
  readonly drillTime: string;
  readonly walArchive: string;
  readonly recipients: readonly string[];
  readonly offsite: string;
  /** p17-panel-settings Part 0: changes waiting for the host time lock (72 h, the host's own clock). */
  readonly pending: readonly PendingBackupChange[];
  /** The last waiting changes the host applied, cancelled or superseded (newest last). */
  readonly changes: readonly { change: string; state: string; id: string; at: string }[];
}

export interface PendingBackupChange {
  readonly change: 'recipients' | 'offsite';
  readonly id: string;
  readonly since: string;
  readonly until: string;
  readonly added: readonly string[];
  readonly target: string;
}

function parsePending(v: unknown): PendingBackupChange | null {
  const o = obj(v);
  const change = s(o, 'change');
  if (change !== 'recipients' && change !== 'offsite') return null;
  return {
    change,
    id: s(o, 'id'),
    since: s(o, 'since'),
    until: s(o, 'until'),
    added: strArray(o, 'added'),
    target: s(o, 'target'),
  };
}

export interface OffsiteConfig {
  readonly provider: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly pathStyle: boolean;
}

export interface BackupManage {
  readonly applier: Applier;
  readonly settings: HostBackupSettings | null;
  readonly offsite: {
    readonly config: OffsiteConfig | null;
    readonly keyIdHint: string | null;
    readonly keyFingerprint: string | null;
    readonly lastTest: Readonly<Record<string, unknown>> | null;
    readonly lastTestAt: string | null;
    readonly updatedAt: string | null;
    readonly storageKeysAvailable: boolean;
  };
  readonly open: HostAction | null;
  readonly recent: readonly HostAction[];
}

const s = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? o[k] : '');

export function parseBackupManage(body: unknown): BackupManage {
  const o = obj(body);
  const st = o.settings === null || o.settings === undefined ? null : obj(o.settings);
  const off = obj(o.offsite);
  const cfg = off.config === null || off.config === undefined ? null : obj(off.config);
  return {
    applier: parseApplier(o.applier),
    settings:
      st === null
        ? null
        : {
            time: s(st, 'time'),
            intervalMinutes: s(st, 'intervalMinutes'),
            keepDaily: s(st, 'keepDaily'),
            keepWeekly: s(st, 'keepWeekly'),
            keepMonthly: s(st, 'keepMonthly'),
            keepRecentHours: s(st, 'keepRecentHours'),
            drillEnabled: s(st, 'drillEnabled'),
            drillWeekday: s(st, 'drillWeekday'),
            drillTime: s(st, 'drillTime'),
            walArchive: s(st, 'walArchive'),
            recipients: strArray(st, 'recipients'),
            offsite: s(st, 'offsite'),
            pending: Array.isArray(st.pending)
              ? st.pending.flatMap((x) => {
                  const p = parsePending(x);
                  return p === null ? [] : [p];
                })
              : [],
            changes: Array.isArray(st.changes)
              ? st.changes.map((x) => {
                  const c = obj(x);
                  return { change: s(c, 'change'), state: s(c, 'state'), id: s(c, 'id'), at: s(c, 'at') };
                })
              : [],
          },
    offsite: {
      config:
        cfg === null
          ? null
          : {
              provider: s(cfg, 'provider'),
              endpoint: s(cfg, 'endpoint'),
              region: s(cfg, 'region'),
              bucket: s(cfg, 'bucket'),
              prefix: s(cfg, 'prefix'),
              pathStyle: cfg.pathStyle === true,
            },
      keyIdHint: nullableStr(off, 'keyIdHint'),
      keyFingerprint: nullableStr(off, 'keyFingerprint'),
      lastTest: off.lastTest === null || off.lastTest === undefined ? null : obj(off.lastTest),
      lastTestAt: nullableStr(off, 'lastTestAt'),
      updatedAt: nullableStr(off, 'updatedAt'),
      storageKeysAvailable: off.storageKeysAvailable === true,
    },
    open: o.open === null || o.open === undefined ? null : parseHostAction(o.open),
    recent: Array.isArray(o.recent) ? o.recent.map(parseHostAction) : [],
  };
}

export function getBackupManage(opts: Opts = {}): Promise<BackupManage> {
  return apiRequest('GET', '/backups/manage', parseBackupManage, opts);
}
export function runBackupNow(reason: string, opts: Opts = {}): Promise<HostAction> {
  return apiRequest('POST', '/backups/run', parseHostAction, { ...opts, body: { reason } });
}
export function startDrill(backupId: string | null, opts: Opts = {}): Promise<HostAction> {
  return apiRequest('POST', '/backups/drill', parseHostAction, { ...opts, body: { backupId } });
}

export interface BackupSettingsInput {
  readonly time: string;
  readonly intervalMinutes: number | null;
  readonly keepDaily: number | null;
  readonly keepWeekly: number | null;
  readonly keepMonthly: number | null;
  readonly keepRecentHours: number | null;
  readonly drillEnabled: boolean;
  readonly drillWeekday: string;
  readonly drillTime: string;
  readonly walArchive: boolean;
  readonly recipients: readonly string[];
}
export function saveBackupSettings(input: BackupSettingsInput, opts: Opts = {}): Promise<HostAction> {
  return apiRequest('PUT', '/backups/settings', parseHostAction, { ...opts, body: input });
}

export interface OffsiteInput extends OffsiteConfig {
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly useStorageKeys?: boolean;
}
export function testOffsite(
  input: OffsiteInput,
  opts: Opts = {},
): Promise<Readonly<Record<string, unknown>>> {
  return apiRequest('POST', '/backups/offsite/test', (b) => obj(b), { ...opts, body: input });
}
export function saveOffsite(
  input: OffsiteInput,
  opts: Opts = {},
): Promise<{ readonly test: Readonly<Record<string, unknown>>; readonly request: HostAction | null }> {
  return apiRequest(
    'PUT',
    '/backups/offsite',
    (b) => {
      const o = obj(b);
      return {
        test: obj(o.test),
        request: o.request === null || o.request === undefined ? null : parseHostAction(o.request),
      };
    },
    { ...opts, body: input },
  );
}
export function clearOffsite(opts: Opts = {}): Promise<{ readonly request: HostAction | null }> {
  return apiRequest(
    'DELETE',
    '/backups/offsite',
    (b) => {
      const o = obj(b);
      return { request: o.request === null || o.request === undefined ? null : parseHostAction(o.request) };
    },
    opts,
  );
}
export function restoreBackup(backupId: string, confirm: string, opts: Opts = {}): Promise<HostAction> {
  return apiRequest('POST', '/backups/restore', parseHostAction, { ...opts, body: { backupId, confirm } });
}

/** p17-panel-settings Part 0: "İptal et" — withdraws a change waiting for the host time lock (it never applies one). */
export function cancelBackupChange(
  change: 'recipients' | 'offsite' | 'all',
  opts: Opts = {},
): Promise<HostAction> {
  return apiRequest('POST', '/backups/changes/cancel', parseHostAction, { ...opts, body: { change } });
}

/** The waiting changes alone ("Senden bekleyenler"); owners — others get 403 (silently absent there). */
export function listPendingBackupChanges(opts: Opts = {}): Promise<readonly PendingBackupChange[]> {
  return apiRequest(
    'GET',
    '/backups/pending-changes',
    (b) => {
      const o = obj(b);
      return Array.isArray(o.items)
        ? o.items.flatMap((x) => {
            const i = obj(x);
            const p = parsePending({ ...i, id: i.requestId });
            return p === null ? [] : [p];
          })
        : [];
    },
    opts,
  );
}
