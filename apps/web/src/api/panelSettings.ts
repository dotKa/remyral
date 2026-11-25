import { apiRequest, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p17-panel-settings (docs/design/p17-panel-settings.md): the master-stored settings over the environment —
 * `GET / PUT /panel-settings/:section`, `GET /panel-settings/mail`, `POST /panel-settings/mail/test`
 * (apps/master/src/panel-settings/routes.ts, notifications/mail-routes.ts).
 */
type Opts = Omit<RequestOptions, 'body'>;

export type PanelValue = boolean | number | string | readonly string[];

export const PANEL_SECTIONS = [
  'notifications',
  'search',
  'network',
  'sessions',
  'jobs',
  'logs',
  'memory',
  'workflows',
  'ops',
] as const;
export type PanelSection = (typeof PANEL_SECTIONS)[number];

export interface PanelField {
  readonly key: string;
  readonly kind: 'bool' | 'int' | 'number' | 'enum' | 'string' | 'list' | 'secret';
  readonly env: string;
  readonly value: PanelValue | null;
  readonly envValue: PanelValue | null;
  readonly source: 'panel' | 'env';
  readonly options: readonly string[] | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly restart: boolean;
  readonly sensitive: boolean;
  readonly secretSet: boolean;
  readonly generated: 'random' | 'vapid' | null;
}

export interface PanelSectionView {
  readonly section: PanelSection;
  readonly version: number;
  readonly fields: readonly PanelField[];
  readonly updatedAt: string | null;
  readonly info: Readonly<Record<string, unknown>>;
  /** After a save that generated something: shown once (a VAPID public key, a webhook secret). */
  readonly generated: Readonly<Record<string, string>>;
}

function value(v: unknown): PanelValue | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return null;
}

const KINDS = ['bool', 'int', 'number', 'enum', 'string', 'list', 'secret'] as const;

export function parseSection(body: unknown): PanelSectionView {
  const o = obj(body);
  const fields = Array.isArray(o.fields) ? o.fields : [];
  const gen = o.generated === undefined || o.generated === null ? {} : obj(o.generated);
  return {
    section: str(o, 'section') as PanelSection,
    version: typeof o.version === 'number' ? o.version : 0,
    updatedAt: nullableStr(o, 'updatedAt'),
    info: o.info === undefined || o.info === null ? {} : obj(o.info),
    generated: Object.fromEntries(
      Object.entries(gen).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ),
    fields: fields.map((raw) => {
      const f = obj(raw);
      const kind = str(f, 'kind');
      return {
        key: str(f, 'key'),
        kind: ((KINDS as readonly string[]).includes(kind) ? kind : 'string') as PanelField['kind'],
        env: str(f, 'env'),
        value: value(f.value),
        envValue: value(f.envValue),
        source: f.source === 'panel' ? 'panel' : 'env',
        options: Array.isArray(f.options)
          ? f.options.filter((x): x is string => typeof x === 'string')
          : null,
        min: typeof f.min === 'number' ? f.min : null,
        max: typeof f.max === 'number' ? f.max : null,
        restart: f.restart === true,
        sensitive: f.sensitive === true,
        secretSet: f.secretSet === true,
        generated: f.generated === 'random' || f.generated === 'vapid' ? f.generated : null,
      };
    }),
  };
}

export function getPanelSection(section: PanelSection, opts: Opts = {}): Promise<PanelSectionView> {
  return apiRequest('GET', `/panel-settings/${section}`, parseSection, opts);
}

export interface PanelSave {
  readonly values?: Readonly<Record<string, PanelValue | null>>;
  readonly secrets?: Readonly<Record<string, string | null>>;
  readonly generate?: readonly string[];
  readonly version?: number;
  readonly confirm?: readonly string[];
}

export function savePanelSection(
  section: PanelSection,
  input: PanelSave,
  opts: Opts = {},
): Promise<PanelSectionView> {
  return apiRequest('PUT', `/panel-settings/${section}`, parseSection, { ...opts, body: input });
}

export interface MailView {
  readonly source: 'panel' | 'env' | 'none';
  readonly host: string | null;
  readonly port: number | null;
  readonly security: string | null;
  readonly from: string | null;
  readonly username: string | null;
  readonly passwordSet: boolean;
}

export function getMail(opts: Opts = {}): Promise<MailView> {
  return apiRequest(
    'GET',
    '/panel-settings/mail',
    (b) => {
      const o = obj(b);
      const source = o.source === 'panel' || o.source === 'env' ? o.source : 'none';
      return {
        source,
        host: nullableStr(o, 'host'),
        port: typeof o.port === 'number' ? o.port : null,
        security: nullableStr(o, 'security'),
        from: nullableStr(o, 'from'),
        username: nullableStr(o, 'username'),
        passwordSet: o.passwordSet === true,
      };
    },
    opts,
  );
}

export function testMail(
  to: string,
  opts: Opts = {},
): Promise<{ readonly ok: boolean; readonly to: string; readonly error: string | null }> {
  return apiRequest(
    'POST',
    '/panel-settings/mail/test',
    (b) => {
      const o = obj(b);
      return { ok: o.ok === true, to: str(o, 'to'), error: nullableStr(o, 'error') };
    },
    { ...opts, body: to.trim() === '' ? {} : { to: to.trim() } },
  );
}

// ---------------------------------------------------------------- Part 5: key rotation

export interface KeyItem {
  readonly item: 'webhookHmac' | 'skillsPanel' | 'leaseSigning' | 'totp';
  readonly online: boolean;
  readonly source: 'panel' | 'env' | 'none';
  readonly keyId: string | null;
  readonly publicKey: string | null;
  readonly pending: boolean;
  readonly retired: readonly string[];
  readonly actions: readonly string[];
  readonly procedure: readonly string[];
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function getKeys(opts: Opts = {}): Promise<readonly KeyItem[]> {
  return apiRequest(
    'GET',
    '/panel-settings/keys',
    (b) => {
      const o = obj(b);
      return (Array.isArray(o.items) ? o.items : []).map((raw) => {
        const i = obj(raw);
        return {
          item: str(i, 'item') as KeyItem['item'],
          online: i.online === true,
          source: i.source === 'panel' || i.source === 'env' ? i.source : 'none',
          keyId: nullableStr(i, 'keyId'),
          publicKey: nullableStr(i, 'publicKey'),
          pending: i.pending === true,
          retired: strs(i.retired),
          actions: strs(i.actions),
          procedure: strs(i.procedure),
        };
      });
    },
    opts,
  );
}

export function keyDryRun(item: string, action: string, opts: Opts = {}): Promise<readonly string[]> {
  return apiRequest(
    'GET',
    `/panel-settings/keys/${encodeURIComponent(item)}/dry-run?action=${encodeURIComponent(action)}`,
    (b) => strs(obj(b).effect),
    opts,
  );
}

export function keyApply(
  item: string,
  action: string,
  opts: Opts = {},
): Promise<{ readonly secret: string | null; readonly publicKey: string | null }> {
  return apiRequest(
    'POST',
    `/panel-settings/keys/${encodeURIComponent(item)}/${encodeURIComponent(action)}`,
    (b) => {
      const o = obj(b);
      return { secret: nullableStr(o, 'secret'), publicKey: nullableStr(o, 'publicKey') };
    },
    opts,
  );
}

// ---------------------------------------------------------------- Part 6: the workflow pre-check

export interface WorkflowCheck {
  readonly total: number;
  readonly v1: number;
  readonly v2: number;
  readonly v1Workflows: number;
  readonly openRuns: { readonly engine1: number; readonly engine2: number };
  readonly failures: readonly { readonly id: string; readonly reason: string }[];
  readonly lines: readonly string[];
}

export function runWorkflowCheck(opts: Opts = {}): Promise<WorkflowCheck> {
  return apiRequest(
    'POST',
    '/panel-settings/workflows/check',
    (b) => {
      const o = obj(b);
      const runs = obj(o.openRuns ?? {});
      const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
      return {
        total: n(o.total),
        v1: n(o.v1),
        v2: n(o.v2),
        v1Workflows: n(o.v1Workflows),
        openRuns: { engine1: n(runs.engine1), engine2: n(runs.engine2) },
        failures: (Array.isArray(o.failures) ? o.failures : []).map((f) => {
          const x = obj(f);
          return { id: str(x, 'id'), reason: str(x, 'reason') };
        }),
        lines: strs(o.lines),
      };
    },
    opts,
  );
}

// ---------------------------------------------------------------- Part 7: maintenance jobs

export const MAINTENANCE_KINDS = ['blobs-migrate', 'search-backfill', 'memory-autolearn'] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number];

export interface MaintenanceJob {
  readonly id: string;
  readonly kind: MaintenanceKind;
  readonly params: {
    readonly mode?: string;
    readonly kinds?: readonly string[];
    readonly projects?: readonly string[];
  };
  readonly dryRun: boolean;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  readonly progress: {
    readonly done: number;
    readonly total: number | null;
    readonly step: string;
    readonly lines: readonly string[];
  };
  readonly report: unknown;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly startedBy: string | null;
}

export function parseJob(b: unknown): MaintenanceJob {
  const o = obj(b);
  const p = obj(o.params ?? {});
  const g = obj(o.progress ?? {});
  const state = str(o, 'state');
  return {
    id: str(o, 'id'),
    kind: str(o, 'kind') as MaintenanceKind,
    params: {
      ...(typeof p.mode === 'string' ? { mode: p.mode } : {}),
      ...(Array.isArray(p.kinds) ? { kinds: strs(p.kinds) } : {}),
      ...(Array.isArray(p.projects) ? { projects: strs(p.projects) } : {}),
    },
    dryRun: o.dryRun === true,
    state: (['running', 'done', 'failed', 'cancelled'].includes(state)
      ? state
      : 'failed') as MaintenanceJob['state'],
    progress: {
      done: typeof g.done === 'number' ? g.done : 0,
      total: typeof g.total === 'number' ? g.total : null,
      step: typeof g.step === 'string' ? g.step : '',
      lines: strs(g.lines),
    },
    report: o.report ?? null,
    error: nullableStr(o, 'error'),
    startedAt: str(o, 'startedAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
    startedBy: nullableStr(o, 'startedBy'),
  };
}

export function listJobs(opts: Opts = {}): Promise<readonly MaintenanceJob[]> {
  return apiRequest(
    'GET',
    '/maintenance/jobs',
    (b) => {
      const o = obj(b);
      return (Array.isArray(o.items) ? o.items : []).map(parseJob);
    },
    opts,
  );
}

export function getJob(id: string, opts: Opts = {}): Promise<MaintenanceJob> {
  return apiRequest('GET', `/maintenance/jobs/${encodeURIComponent(id)}`, parseJob, opts);
}

export function startJob(
  input: {
    readonly kind: MaintenanceKind;
    readonly dryRun: boolean;
    readonly params: { readonly mode?: string; readonly kinds?: readonly string[] };
  },
  opts: Opts = {},
): Promise<MaintenanceJob> {
  return apiRequest('POST', '/maintenance/jobs', parseJob, { ...opts, body: input });
}

export function cancelJob(id: string, opts: Opts = {}): Promise<MaintenanceJob> {
  return apiRequest('POST', `/maintenance/jobs/${encodeURIComponent(id)}/cancel`, parseJob, opts);
}

// ---------------------------------------------------------------- Part 4: account recovery

export type RecoveryAction = 'reset-mfa' | 'reset-password' | 'unlock';

export interface RecoveryOutcome {
  readonly status: 'applied' | 'pending';
  readonly temporaryPassword: string | null;
  readonly requestId: string | null;
}

const parseOutcome = (b: unknown): RecoveryOutcome => {
  const o = obj(b);
  return {
    status: o.status === 'pending' ? 'pending' : 'applied',
    temporaryPassword: nullableStr(o, 'temporaryPassword'),
    requestId: nullableStr(o, 'requestId'),
  };
};

export function recoverUser(
  userId: string,
  action: RecoveryAction,
  reason: string,
  opts: Opts = {},
): Promise<RecoveryOutcome> {
  return apiRequest('POST', `/users/${encodeURIComponent(userId)}/recover`, parseOutcome, {
    ...opts,
    body: { action, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) },
  });
}

export interface RecoveryRequest {
  readonly id: string;
  readonly action: RecoveryAction;
  readonly target: { readonly id: string; readonly username: string };
  readonly requestedBy: string | null;
  readonly reason: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
}

export function listRecoveryRequests(opts: Opts = {}): Promise<readonly RecoveryRequest[]> {
  return apiRequest(
    'GET',
    '/users/recovery-requests',
    (b) => {
      const o = obj(b);
      return (Array.isArray(o.items) ? o.items : []).map((raw) => {
        const i = obj(raw);
        const t = obj(i.target ?? {});
        return {
          id: str(i, 'id'),
          action: str(i, 'action') as RecoveryAction,
          target: { id: str(t, 'id'), username: str(t, 'username') },
          requestedBy: nullableStr(i, 'requestedBy'),
          reason: typeof i.reason === 'string' ? i.reason : '',
          requestedAt: str(i, 'requestedAt'),
          expiresAt: str(i, 'expiresAt'),
        };
      });
    },
    opts,
  );
}

export function approveRecovery(id: string, opts: Opts = {}): Promise<RecoveryOutcome> {
  return apiRequest('POST', `/users/recovery-requests/${encodeURIComponent(id)}/approve`, parseOutcome, opts);
}

export function cancelRecovery(id: string, opts: Opts = {}): Promise<void> {
  return apiRequest(
    'POST',
    `/users/recovery-requests/${encodeURIComponent(id)}/cancel`,
    () => undefined,
    opts,
  );
}
