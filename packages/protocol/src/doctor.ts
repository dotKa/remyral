import { z } from 'zod';
import { NonNegativeInt, Timestamp } from './common.js';

/**
 * p16-doctor (docs/design/p16-doctor.md, ADR-0062): diagnostics ("doctor") on the master and on every machine, and the
 * redacted support report a customer can download or send to the vendor by e-mail.
 *
 * A **finding** is one result of one check: a closed check id, a closed code (the console translates check and code;
 * the English `message` / `fix` are the fallback and the text of the report), a severity, small parameters and a docs
 * link. Nothing secret: identifiers, numbers, states, host names and closed codes — every string is redacted by its
 * producer and again by the master before it is stored, shown or packed.
 */

export const DOCTOR_FEATURE = 'doctor-v1';

export const DoctorSeverity = z.enum(['ok', 'info', 'warning', 'error']);
export type DoctorSeverity = z.infer<typeof DoctorSeverity>;

/** `db.reachable`, `workers.offline`, `master.dns` … */
export const DoctorCheckId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}(?:\.[a-z0-9_]{1,32}){0,3}$/, 'dotted lower_snake check id');
/** `ok`, `slow`, `pending_migrations`, `dns_failed` … */
export const DoctorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'lower_snake finding code');

const ParamKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/);
export const DoctorParams = z
  .record(ParamKey, z.union([z.string().max(200), z.number(), z.boolean()]))
  .refine((r) => Object.keys(r).length <= 12, 'at most 12 parameters');
export type DoctorParams = z.infer<typeof DoctorParams>;

export const DoctorFinding = z.object({
  check: DoctorCheckId,
  code: DoctorCode,
  severity: DoctorSeverity,
  /** English, one line (the report's text and the console's fallback). */
  message: z.string().min(1).max(500),
  /** English suggested fix (absent for `ok`). */
  fix: z.string().max(500).optional(),
  /** The page of the owner guide (`docs/guide/tr/tanilama.md#…`) or a console path (`/settings/system`). */
  docs: z.string().max(200).optional(),
  params: DoctorParams.optional(),
  /** What the finding is about (a machine id, a job id, a webhook name …); part of its identity. */
  subject: z.string().max(120).optional(),
});
export type DoctorFinding = z.infer<typeof DoctorFinding>;

export const DoctorSummary = z.object({
  ok: NonNegativeInt,
  info: NonNegativeInt,
  warning: NonNegativeInt,
  error: NonNegativeInt,
});
export type DoctorSummary = z.infer<typeof DoctorSummary>;

export const SEVERITY_RANK: Readonly<Record<DoctorSeverity, number>> = {
  ok: 0,
  info: 1,
  warning: 2,
  error: 3,
};

/** Counts per severity. */
export function summarizeFindings(findings: readonly Pick<DoctorFinding, 'severity'>[]): DoctorSummary {
  const s = { ok: 0, info: 0, warning: 0, error: 0 };
  for (const f of findings) s[f.severity] += 1;
  return s;
}

/** The identity of a finding across runs (the daily run notifies only new ones). */
export function findingKey(f: Pick<DoctorFinding, 'check' | 'code' | 'subject'>): string {
  return `${f.check}|${f.code}|${f.subject ?? ''}`;
}

/** Worst first, then by check id. */
export function sortFindings<T extends Pick<DoctorFinding, 'severity' | 'check'>>(
  findings: readonly T[],
): T[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.check.localeCompare(b.check),
  );
}

export const WORKER_DOCTOR_SCHEMA_VERSION = 1;
export const MAX_WORKER_FINDINGS = 64;

/**
 * `remyral-worker doctor --json` and OPS_UPDATE `doctor` (with `doctor-v1`): what the machine itself sees — config,
 * connectivity to the master (DNS, TCP/TLS, HTTP), clock against the master, service, data directory, disk, Node / npm,
 * git, runtimes (installed, version against the pin, login state — never an identity or a token) and sandbox
 * prerequisites. `local`: the CLI on the machine (also when the worker cannot reach the master); `remote`: requested by
 * the master over the worker's own session.
 */
export const WorkerDoctorReport = z.object({
  schemaVersion: z.literal(WORKER_DOCTOR_SCHEMA_VERSION),
  collectedAt: Timestamp,
  mode: z.enum(['local', 'remote']),
  workerVersion: z.string().max(64),
  host: z.object({
    platform: z.string().max(32),
    release: z.string().max(128),
    arch: z.string().max(16),
    node: z.string().max(32),
  }),
  /** The master origin from the config (scheme + host + port only), null when the config could not be read. */
  master: z.string().max(300).nullable(),
  summary: DoctorSummary,
  findings: z.array(DoctorFinding).max(MAX_WORKER_FINDINGS),
});
export type WorkerDoctorReport = z.infer<typeof WorkerDoctorReport>;

// ------------------------------------------------------------------------------------------------ support report

/**
 * Sections of the support report bundle. `job_prompts` is opt-in (never preselected): job prompts and summaries can
 * contain customer data; everything else is metadata.
 */
export const SUPPORT_REPORT_SECTIONS = [
  'doctor',
  'workers',
  'status',
  'versions',
  'config',
  'logs',
  'failed_jobs',
  'job_prompts',
] as const;
export const SupportReportSection = z.enum(SUPPORT_REPORT_SECTIONS);
export type SupportReportSection = z.infer<typeof SupportReportSection>;
export const DEFAULT_SUPPORT_SECTIONS: readonly SupportReportSection[] = SUPPORT_REPORT_SECTIONS.filter(
  (s) => s !== 'job_prompts',
);

/**
 * Default recipient of the support e-mail (owner-editable, Ayarlar → Tanılama). None: a fresh install e-mails its
 * diagnostics report nowhere until the owner enters an address (the report can always be downloaded).
 */
export const DEFAULT_SUPPORT_EMAIL: string | null = null;
/** Hours of warn / error log lines in the report (default, maximum). */
export const SUPPORT_LOG_HOURS_DEFAULT = 24;
export const SUPPORT_LOG_HOURS_MAX = 72;
/** Largest attachment the support e-mail carries; a larger bundle is a download plus a summary-only mail. */
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_DESCRIPTION_MAX = 4000;
