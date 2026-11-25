import { apiRequest, obj, type RequestOptions, ShapeError } from './client';
import { fetchBlob } from './download';

/**
 * p16-doctor (docs/design/p16-doctor.md §6): Ayarlar → Tanılama — the doctor runs, one machine's doctor, the support
 * settings and the redacted support report (build → preview → download / send). Owners and admins; sending and the
 * support settings may ask for an authenticator code (security policy event `support.report`).
 */

export type Severity = 'ok' | 'info' | 'warning' | 'error';

export interface Finding {
  readonly check: string;
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  readonly fix?: string;
  readonly docs?: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
  readonly subject?: string;
}

export interface Summary {
  readonly ok: number;
  readonly info: number;
  readonly warning: number;
  readonly error: number;
}

export interface WorkerReport {
  readonly schemaVersion: 1;
  readonly collectedAt: string;
  readonly mode: 'local' | 'remote';
  readonly workerVersion: string;
  readonly host: {
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
    readonly node: string;
  };
  readonly master: string | null;
  readonly summary: Summary;
  readonly findings: readonly Finding[];
}

export interface WorkerResult {
  readonly workerId: string;
  readonly name: string;
  readonly state: 'done' | 'pending' | 'failed' | 'unsupported' | 'offline';
  readonly source: 'doctor' | 'diagnostics' | null;
  readonly opId: string | null;
  readonly reason: string | null;
  readonly report: WorkerReport | null;
}

export interface DoctorRun {
  readonly id: string;
  readonly kind: 'manual' | 'daily' | 'chat';
  readonly scope: 'full' | 'light';
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly requestedBy: string | null;
  readonly summary: Summary;
  readonly findings: readonly Finding[];
  readonly workers: readonly WorkerResult[];
  readonly newProblems: number;
}

export interface DoctorOverview {
  readonly latest: DoctorRun | null;
  readonly latestDaily: DoctorRun | null;
  readonly runs: readonly {
    readonly id: string;
    readonly kind: DoctorRun['kind'];
    readonly scope: DoctorRun['scope'];
    readonly startedAt: string;
    readonly summary: Summary;
    readonly newProblems: number;
  }[];
}

export const SECTIONS = [
  'doctor',
  'workers',
  'status',
  'versions',
  'config',
  'logs',
  'failed_jobs',
  'job_prompts',
] as const;
export type Section = (typeof SECTIONS)[number];

export interface SupportSettings {
  /** null: no support address is set (the report is only downloaded). */
  readonly email: string | null;
  readonly defaultEmail: string | null;
  readonly smtpSource: 'settings' | 'notifications' | 'none';
  readonly smtp: {
    readonly host: string;
    readonly port: number;
    readonly security: 'starttls' | 'tls';
    readonly from: string;
    readonly username: string | null;
    readonly passwordSet: boolean;
  } | null;
  readonly updatedAt: string | null;
  readonly updatedBy: { readonly id: string; readonly username: string } | null;
}

export interface ReportFile {
  readonly path: string;
  readonly section: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly items?: number;
}

export interface ReportPreview {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly sections: readonly Section[];
  readonly logHours: number;
  readonly files: readonly ReportFile[];
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly filename: string;
  readonly overCap: boolean;
  readonly attachmentMaxBytes: number;
  readonly summary: string;
  readonly description: string | null;
  readonly recipient: string | null;
  readonly ccAddress: string | null;
  readonly smtpReady: boolean;
  readonly sent: {
    readonly at: string;
    readonly to: string;
    readonly cc: string | null;
    readonly attached: boolean;
  } | null;
}

export interface SendResult {
  readonly to: string;
  readonly cc: string | null;
  readonly attached: boolean;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sentAt: string;
}

type Opts = Omit<RequestOptions, 'body'>;

function parseRun(v: unknown): DoctorRun {
  const o = obj(v);
  if (typeof o.id !== 'string' || !Array.isArray(o.findings) || !Array.isArray(o.workers))
    throw new ShapeError('unexpected diagnostics run');
  return o as unknown as DoctorRun;
}

function parseOverview(v: unknown): DoctorOverview {
  const o = obj(v);
  if (!Array.isArray(o.runs)) throw new ShapeError('unexpected diagnostics');
  return {
    latest: o.latest === null ? null : parseRun(o.latest),
    latestDaily: o.latestDaily === null ? null : parseRun(o.latestDaily),
    runs: o.runs as DoctorOverview['runs'],
  };
}

function parseSettings(v: unknown): SupportSettings {
  const o = obj(v);
  if ((typeof o.email !== 'string' && o.email !== null) || typeof o.smtpSource !== 'string')
    throw new ShapeError('unexpected settings');
  return o as unknown as SupportSettings;
}

function parsePreview(v: unknown): ReportPreview {
  const o = obj(v);
  if (typeof o.id !== 'string' || !Array.isArray(o.files) || typeof o.summary !== 'string')
    throw new ShapeError('unexpected report preview');
  return o as unknown as ReportPreview;
}

export function getDoctor(opts: Opts = {}): Promise<DoctorOverview> {
  return apiRequest('GET', '/doctor', parseOverview, opts);
}

export function runDoctor(machines: boolean, opts: Opts = {}): Promise<DoctorRun> {
  return apiRequest('POST', '/doctor/runs', parseRun, { ...opts, body: { machines } });
}

export function requestMachineDoctor(
  workerId: string,
  opts: Opts = {},
): Promise<{ opId: string; source: 'doctor' | 'diagnostics' }> {
  return apiRequest(
    'POST',
    `/doctor/machines/${encodeURIComponent(workerId)}`,
    (v) => {
      const o = obj(v);
      if (typeof o.opId !== 'string') throw new ShapeError('unexpected machine doctor');
      return o as unknown as { opId: string; source: 'doctor' | 'diagnostics' };
    },
    { ...opts, body: {} },
  );
}

export function getMachineDoctor(
  workerId: string,
  opId: string,
  opts: Opts = {},
): Promise<{ state: string; reason: string | null; report: WorkerReport | null }> {
  return apiRequest(
    'GET',
    `/doctor/machines/${encodeURIComponent(workerId)}/ops/${encodeURIComponent(opId)}`,
    (v) => {
      const o = obj(v);
      if (typeof o.state !== 'string') throw new ShapeError('unexpected machine doctor');
      return o as unknown as { state: string; reason: string | null; report: WorkerReport | null };
    },
    opts,
  );
}

export function getSupportSettings(opts: Opts = {}): Promise<SupportSettings> {
  return apiRequest('GET', '/support/settings', parseSettings, opts);
}

export interface SettingsChange {
  /** null clears the support address. */
  readonly email?: string | null;
  readonly smtp?: {
    readonly host: string;
    readonly port: number;
    readonly security: 'starttls' | 'tls';
    readonly from: string;
    readonly username?: string | null;
    readonly password?: string | null;
  } | null;
}

export function putSupportSettings(body: SettingsChange, opts: Opts = {}): Promise<SupportSettings> {
  return apiRequest('PUT', '/support/settings', parseSettings, { ...opts, body });
}

export function buildReport(
  body: {
    readonly sections: readonly Section[];
    readonly hours: number;
    readonly description: string | null;
  },
  opts: Opts = {},
): Promise<ReportPreview> {
  return apiRequest('POST', '/support/reports', parsePreview, { ...opts, body });
}

export function getReport(id: string, opts: Opts = {}): Promise<ReportPreview> {
  return apiRequest('GET', `/support/reports/${encodeURIComponent(id)}`, parsePreview, opts);
}

export function sendReport(id: string, ccMe: boolean, opts: Opts = {}): Promise<SendResult> {
  return apiRequest(
    'POST',
    `/support/reports/${encodeURIComponent(id)}/send`,
    (v) => {
      const o = obj(v);
      if (typeof o.to !== 'string') throw new ShapeError('unexpected send result');
      return o as unknown as SendResult;
    },
    { ...opts, body: { ccMe } },
  );
}

/** The zip of a built report (fetch: a step-up or an expiry reaches the screen as an error). */
export function downloadReport(id: string, fetchImpl?: typeof fetch): ReturnType<typeof fetchBlob> {
  return fetchBlob(
    `/support/reports/${encodeURIComponent(id)}/download`,
    fetchImpl === undefined ? {} : { fetchImpl },
  );
}
