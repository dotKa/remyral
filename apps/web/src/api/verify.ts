import { API_PREFIX, apiRequest, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';

/**
 * p10-verify-health (apps/master/src/verify): a job's automatic verification ("Verify when done"), the project's
 * verification / health settings and the health checks after deploys. Every text field (findings, reasons, details)
 * is data from the master — partly from a verifier agent — and is rendered as text only.
 */

type Opts = Omit<RequestOptions, 'body'>;

export const VERIFY_MODES = ['off', 'report', 'gate'] as const;
export type VerifyMode = (typeof VERIFY_MODES)[number];

export type VerificationState =
  'waiting' | 'checking' | 'verifying' | 'passed' | 'warned' | 'failed' | 'error' | 'skipped';
const STATES: readonly VerificationState[] = [
  'waiting',
  'checking',
  'verifying',
  'passed',
  'warned',
  'failed',
  'error',
  'skipped',
];

export interface VerifyCheck {
  readonly source: 'master' | 'verifier';
  readonly id: string;
  readonly status: 'pass' | 'warn' | 'fail' | 'skipped';
  readonly detail: string | null;
}

export interface VerifyFinding {
  readonly source: 'master' | 'verifier';
  readonly severity: 'info' | 'warn' | 'fail';
  readonly kind: string;
  readonly message: string;
  readonly url: string | null;
}

export interface VerifyScreenshot {
  readonly jobId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly width: number | null;
}

export interface JobVerification {
  readonly id: string;
  readonly jobId: string;
  readonly mode: 'report' | 'gate';
  readonly runtime: string | null;
  readonly source: string;
  readonly state: VerificationState;
  readonly outputType: string | null;
  readonly verifierJobId: string | null;
  readonly verifierJobState: string | null;
  readonly checks: VerifyCheck[];
  readonly findings: VerifyFinding[];
  readonly screenshots: VerifyScreenshot[];
  readonly summary: string | null;
  readonly reason: string | null;
  /** p19-verifier-jobs: why an `error` verification could not run (cause id; null: unknown / older master). */
  readonly errorCause: string | null;
  readonly holdsDeploy: boolean;
  readonly hasDeployOnSuccess: boolean;
  readonly override: {
    readonly by: string | null;
    readonly at: string;
    readonly reason: string | null;
  } | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

/** Still on its way (worth polling). */
export function verificationOpen(s: VerificationState): boolean {
  return s === 'waiting' || s === 'checking' || s === 'verifying';
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : [];
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function parseChecks(v: unknown): VerifyCheck[] {
  return arr(v).map((c) => ({
    source: c.source === 'verifier' ? 'verifier' : 'master',
    id: typeof c.id === 'string' ? c.id : 'other',
    status: oneOf(c.status, ['pass', 'warn', 'fail', 'skipped'] as const, 'skipped'),
    detail: typeof c.detail === 'string' ? c.detail : null,
  }));
}

export function parseFindings(v: unknown): VerifyFinding[] {
  return arr(v).map((f) => ({
    source: f.source === 'verifier' ? 'verifier' : 'master',
    severity: oneOf(f.severity, ['info', 'warn', 'fail'] as const, 'info'),
    kind: typeof f.kind === 'string' ? f.kind : 'other',
    message: typeof f.message === 'string' ? f.message : '',
    url: typeof f.url === 'string' ? f.url : null,
  }));
}

export function parseScreenshots(v: unknown): VerifyScreenshot[] {
  const UUID = /^[0-9a-f-]{36}$/i;
  const ART = /^ws-[a-z0-9-]{1,100}$/;
  return arr(v).flatMap((s) =>
    typeof s.jobId === 'string' &&
    UUID.test(s.jobId) &&
    typeof s.artifactId === 'string' &&
    ART.test(s.artifactId)
      ? [
          {
            jobId: s.jobId,
            artifactId: s.artifactId,
            name: typeof s.name === 'string' ? s.name : s.artifactId,
            width: typeof s.width === 'number' ? s.width : null,
          },
        ]
      : [],
  );
}

/** Same-origin inline URL of a screenshot (the master's artifact route: jobs.read, image type, sandbox CSP). */
export function screenshotUrl(s: { readonly jobId: string; readonly artifactId: string }): string {
  return `${API_PREFIX}/jobs/${encodeURIComponent(s.jobId)}/artifacts/${encodeURIComponent(s.artifactId)}?inline=1`;
}

export function parseVerification(v: unknown): JobVerification | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const state = str(o, 'state');
  if (!(STATES as readonly string[]).includes(state)) throw new ShapeError('state');
  const mode = str(o, 'mode');
  if (mode !== 'report' && mode !== 'gate') throw new ShapeError('mode');
  const ov = o.override;
  return {
    id: str(o, 'id'),
    jobId: str(o, 'jobId'),
    mode,
    runtime: nullableStr(o, 'runtime'),
    source: str(o, 'source'),
    state: state as VerificationState,
    outputType: nullableStr(o, 'outputType'),
    verifierJobId: nullableStr(o, 'verifierJobId'),
    verifierJobState: nullableStr(o, 'verifierJobState'),
    checks: parseChecks(o.checks),
    findings: parseFindings(o.findings),
    screenshots: parseScreenshots(o.screenshots),
    summary: nullableStr(o, 'summary'),
    reason: nullableStr(o, 'reason'),
    errorCause: typeof o.errorCause === 'string' && o.errorCause !== '' ? o.errorCause : null,
    holdsDeploy: o.holdsDeploy === true,
    hasDeployOnSuccess: o.hasDeployOnSuccess === true,
    override:
      typeof ov === 'object' && ov !== null
        ? {
            by: nullableStr(ov as Record<string, unknown>, 'by'),
            at: str(ov as Record<string, unknown>, 'at'),
            reason: nullableStr(ov as Record<string, unknown>, 'reason'),
          }
        : null,
    createdAt: str(o, 'createdAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
  };
}

export function getJobVerification(jobId: string, opts: Opts = {}): Promise<JobVerification | null> {
  return apiRequest(
    'GET',
    `/jobs/${encodeURIComponent(jobId)}/verification`,
    (v) => parseVerification(obj(v).verification),
    opts,
  );
}

/** Deploy anyway (project admin; the master asks for a fresh authenticator code). */
export function overrideVerification(
  jobId: string,
  reason: string,
  opts: Opts = {},
): Promise<JobVerification> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/verification/override`,
    (v) => {
      const p = parseVerification(obj(v).verification);
      if (p === null) throw new ShapeError('verification');
      return p;
    },
    { ...opts, body: { reason } },
  );
}

/** p19-verifier-jobs: start a verification that could not run (state `error`) again (`jobs.create` in the project). */
export function retryVerification(jobId: string, opts: Opts = {}): Promise<JobVerification> {
  return apiRequest(
    'POST',
    `/jobs/${encodeURIComponent(jobId)}/verification/retry`,
    (v) => {
      const p = parseVerification(obj(v).verification);
      if (p === null) throw new ShapeError('verification');
      return p;
    },
    { ...opts, body: {} },
  );
}

// ------------------------------------------------------------------------------------- settings

export interface VerifySettings {
  readonly project: string;
  readonly verifyDefault: VerifyMode;
  readonly verifyRuntime: string | null;
  readonly testCommand: string | null;
  readonly healthAfterDeploy: boolean;
  readonly healthScreenshots: boolean;
  readonly healthKeyword: string | null;
  readonly autoRollback: boolean;
  readonly autoRollbackProduction: boolean;
  readonly updatedAt: string | null;
}

export type VerifySettingsInput = Omit<VerifySettings, 'project' | 'updatedAt'>;

function parseSettings(v: unknown): VerifySettings {
  const o = obj(v);
  return {
    project: str(o, 'project'),
    verifyDefault: oneOf(o.verifyDefault, VERIFY_MODES, 'off'),
    verifyRuntime: nullableStr(o, 'verifyRuntime'),
    testCommand: nullableStr(o, 'testCommand'),
    healthAfterDeploy: o.healthAfterDeploy !== false,
    healthScreenshots: o.healthScreenshots !== false,
    healthKeyword: nullableStr(o, 'healthKeyword'),
    autoRollback: o.autoRollback === true,
    autoRollbackProduction: o.autoRollbackProduction === true,
    updatedAt: nullableStr(o, 'updatedAt'),
  };
}

export function getVerifySettings(project: string, opts: Opts = {}): Promise<VerifySettings> {
  return apiRequest('GET', `/projects/${encodeURIComponent(project)}/verify-settings`, parseSettings, opts);
}

export function putVerifySettings(
  project: string,
  input: VerifySettingsInput,
  opts: Opts = {},
): Promise<VerifySettings> {
  return apiRequest('PUT', `/projects/${encodeURIComponent(project)}/verify-settings`, parseSettings, {
    ...opts,
    body: { ...input },
  });
}

// --------------------------------------------------------------------------------------- health

export type HealthState =
  'pending' | 'checking' | 'browser' | 'passed' | 'warned' | 'failed' | 'error' | 'skipped';
const HEALTH_STATES: readonly HealthState[] = [
  'pending',
  'checking',
  'browser',
  'passed',
  'warned',
  'failed',
  'error',
  'skipped',
];

export interface BrokenLink {
  readonly url: string;
  readonly kind: string;
  readonly status: number | null;
  readonly error: string | null;
  readonly from: string | null;
}

export interface DeployHealth {
  readonly id: string;
  readonly opsActionId: string | null;
  readonly previewId: string | null;
  readonly kind: string;
  readonly env: string | null;
  readonly url: string | null;
  readonly protected: boolean;
  readonly state: HealthState;
  readonly probe: {
    readonly ok: boolean | null;
    readonly statusCode: number | null;
    readonly latencyMs: number | null;
    readonly error: string | null;
    readonly detail: string | null;
    readonly tlsExpiresAt: string | null;
  } | null;
  readonly links: {
    readonly pages: number;
    readonly assets: number;
    readonly external: number;
    readonly broken: BrokenLink[];
    readonly truncated: boolean;
  } | null;
  readonly findings: VerifyFinding[];
  readonly browserJobId: string | null;
  readonly browserNote: string | null;
  readonly screenshots: VerifyScreenshot[];
  readonly rollbackActionId: string | null;
  readonly rollbackNote: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

export function healthOpen(s: HealthState): boolean {
  return s === 'pending' || s === 'checking' || s === 'browser';
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseHealth(v: unknown): DeployHealth | null {
  if (v === null || v === undefined) return null;
  const o = obj(v);
  const state = str(o, 'state');
  if (!(HEALTH_STATES as readonly string[]).includes(state)) throw new ShapeError('state');
  const p = typeof o.probe === 'object' && o.probe !== null ? (o.probe as Record<string, unknown>) : null;
  const l = typeof o.links === 'object' && o.links !== null ? (o.links as Record<string, unknown>) : null;
  return {
    id: str(o, 'id'),
    opsActionId: nullableStr(o, 'opsActionId'),
    previewId: nullableStr(o, 'previewId'),
    kind: str(o, 'kind'),
    env: nullableStr(o, 'env'),
    url: nullableStr(o, 'url'),
    protected: o.protected === true,
    state: state as HealthState,
    probe:
      p === null
        ? null
        : {
            ok: typeof p.ok === 'boolean' ? p.ok : null,
            statusCode: num(p.statusCode),
            latencyMs: num(p.latencyMs),
            error: typeof p.error === 'string' ? p.error : null,
            detail: typeof p.detail === 'string' ? p.detail : null,
            tlsExpiresAt: typeof p.tlsExpiresAt === 'string' ? p.tlsExpiresAt : null,
          },
    links:
      l === null
        ? null
        : {
            pages: num(l.pages) ?? 0,
            assets: num(l.assets) ?? 0,
            external: num(l.external) ?? 0,
            truncated: l.truncated === true,
            broken: arr(l.broken).map((b) => ({
              url: typeof b.url === 'string' ? b.url : '',
              kind: typeof b.kind === 'string' ? b.kind : 'page',
              status: num(b.status),
              error: typeof b.error === 'string' ? b.error : null,
              from: typeof b.from === 'string' ? b.from : null,
            })),
          },
    findings: parseFindings(o.findings),
    browserJobId: nullableStr(o, 'browserJobId'),
    browserNote: nullableStr(o, 'browserNote'),
    screenshots: parseScreenshots(o.screenshots),
    rollbackActionId: nullableStr(o, 'rollbackActionId'),
    rollbackNote: nullableStr(o, 'rollbackNote'),
    attempts: num(o.attempts) ?? 0,
    createdAt: str(o, 'createdAt'),
    finishedAt: nullableStr(o, 'finishedAt'),
  };
}

export function getActionHealth(actionId: string, opts: Opts = {}): Promise<DeployHealth | null> {
  return apiRequest(
    'GET',
    `/deploy/actions/${encodeURIComponent(actionId)}/health`,
    (v) => parseHealth(obj(v).health),
    opts,
  );
}

export function listDeployHealth(
  project: string,
  actions: readonly string[],
  opts: Opts = {},
): Promise<DeployHealth[]> {
  const q = new URLSearchParams({ project });
  if (actions.length > 0) q.set('actions', actions.slice(0, 100).join(','));
  return apiRequest(
    'GET',
    `/deploy-health?${q.toString()}`,
    (v) =>
      arr(obj(v).items).flatMap((i) => {
        const h = parseHealth(i);
        return h === null ? [] : [h];
      }),
    opts,
  );
}

export function recheckHealth(id: string, opts: Opts = {}): Promise<DeployHealth> {
  return apiRequest(
    'POST',
    `/deploy-health/${encodeURIComponent(id)}/recheck`,
    (v) => {
      const h = parseHealth(obj(v).health);
      if (h === null) throw new ShapeError('health');
      return h;
    },
    { ...opts, body: {} },
  );
}

/** Outputs site cards: the latest health check (null: none). */
export interface SiteHealthBadge {
  readonly id: string;
  readonly state: string;
  readonly checkedAt: string;
  readonly statusCode: number | null;
  readonly latencyMs: number | null;
  readonly broken: number;
  readonly screenshot: { readonly jobId: string; readonly artifactId: string } | null;
}

export function parseSiteHealth(v: unknown): SiteHealthBadge | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.state !== 'string' || typeof o.checkedAt !== 'string') return null;
  const shot = parseScreenshots(o.screenshot === null || o.screenshot === undefined ? [] : [o.screenshot])[0];
  return {
    id: o.id,
    state: o.state,
    checkedAt: o.checkedAt,
    statusCode: num(o.statusCode),
    latencyMs: num(o.latencyMs),
    broken: num(o.broken) ?? 0,
    screenshot: shot === undefined ? null : { jobId: shot.jobId, artifactId: shot.artifactId },
  };
}

export const HEALTH_TEXT: Readonly<Record<string, string>> = {
  pending: 'Checking…',
  checking: 'Checking…',
  browser: 'Taking screenshots…',
  passed: 'Healthy',
  warned: 'Healthy with warnings',
  failed: 'Unhealthy',
  error: 'Check failed',
  skipped: 'Not checked',
};

export const VERIFICATION_TEXT: Readonly<Record<VerificationState, string>> = {
  waiting: 'Waiting for the job',
  checking: 'Checking…',
  verifying: 'Verifier running…',
  passed: 'Passed',
  warned: 'Passed with warnings',
  failed: 'Failed',
  error: 'Could not run',
  skipped: 'Skipped',
};

/** Tone of a verification / health state for chips (StateChip tones). */
export function checkTone(s: string): 'ok' | 'attention' | 'danger' | 'signal' | 'neutral' {
  if (s === 'passed') return 'ok';
  if (s === 'warned') return 'attention';
  if (s === 'failed' || s === 'error') return 'danger';
  if (s === 'skipped') return 'neutral';
  return 'signal';
}
