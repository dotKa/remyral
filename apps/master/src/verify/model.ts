import { RuntimeKind } from '@remyral/protocol';
import { z } from 'zod';
import { HttpError } from '../http/errors.js';

/**
 * p10-verify-health (docs/design/p10-verify-health.md): modes, project settings, the verifier's report contract and
 * the rules that turn checks into a state. Everything a verifier (an agent) reports is untrusted data: it is parsed
 * against a closed schema, clipped, stripped of control characters and only its enums decide anything.
 */

/**
 * SQL predicate (over the deploy-on-success alias `d`) that is true while a gate verification holds the job's deploy
 * (ADR-0035). Used by `DeployOnSuccessService.tick` and its view.
 */
export const GATE_HOLDS_SQL = `EXISTS (SELECT 1 FROM job_verifications gv WHERE gv.job_id = d.job_id
  AND gv.mode = 'gate' AND gv.override_at IS NULL AND gv.state IN ('waiting', 'checking', 'verifying', 'failed', 'error'))`;

export const VERIFY_MODES = ['off', 'report', 'gate'] as const;
export const VerifyMode = z.enum(VERIFY_MODES);
export type VerifyMode = z.infer<typeof VerifyMode>;

/** `POST /jobs` body field. */
export const VerifyRequest = z.strictObject({
  mode: VerifyMode,
  runtime: RuntimeKind.optional(),
});
export type VerifyRequest = z.infer<typeof VerifyRequest>;

export type VerificationState =
  'waiting' | 'checking' | 'verifying' | 'passed' | 'warned' | 'failed' | 'error' | 'skipped';
export type OutputType = 'site' | 'repo' | 'docs' | 'none';
export type VerificationSource = 'request' | 'project' | 'template' | 'automation' | 'chat';

export type Status = 'pass' | 'warn' | 'fail';
export type CheckStatus = Status | 'skipped';
export type Severity = 'info' | 'warn' | 'fail';

export interface Check {
  readonly source: 'master' | 'verifier';
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string | null;
}

export interface Finding {
  readonly source: 'master' | 'verifier';
  readonly severity: Severity;
  readonly kind: string;
  readonly message: string;
  readonly url?: string;
}

export interface Screenshot {
  readonly jobId: string;
  readonly artifactId: string;
  readonly name: string;
  readonly width: number | null;
}

export const LIMITS = {
  checks: 20,
  findings: 100,
  screenshots: 4,
  screenshotBytes: 2 * 1024 * 1024,
  reportBytes: 256 * 1024,
  text: 300,
  url: 500,
  testCommand: 300,
  keyword: 100,
  overrideReason: 500,
  /** The verifier's own time limit (seconds) when the parent's is larger. */
  verifierMaxDurationSec: 30 * 60,
  /** Docs: external links checked through the guarded probe. */
  docsExternalLinks: 20,
  docsFiles: 20,
  /** Static bundle check bounds. */
  bundlePages: 200,
  bundleRefs: 5_000,
} as const;

/** Control characters and bidirectional overrides (they can disguise text) are replaced by spaces. */
function unsafeChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Removes control / bidi characters and clips. Text from a verifier is shown as text only. */
export function cleanText(v: unknown, max: number = LIMITS.text): string {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v.slice(0, max * 2)) out += unsafeChar(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  return out.trim().slice(0, max);
}

/** An http(s) URL without credentials, clipped; null otherwise. */
export function cleanUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username !== '' || u.password !== '') return null;
    return u.href.slice(0, LIMITS.url);
  } catch {
    return null;
  }
}

const CHECK_IDS = [
  'build',
  'lint',
  'test',
  'screenshot-desktop',
  'screenshot-phone',
  'console',
  'requests',
  'links',
  'other',
] as const;
const FINDING_KINDS = ['console', 'request', 'link', 'build', 'lint', 'test', 'layout', 'other'] as const;

/** The verifier's `report.json` (version 1). Lenient on unknown keys (dropped), strict on enums. */
export const VerifierReport = z.object({
  version: z.literal(1),
  status: z.enum(['pass', 'warn', 'fail']),
  summary: z.string().max(10_000).optional(),
  checks: z
    .array(
      z.object({
        id: z.string().max(64),
        status: z.enum(['pass', 'warn', 'fail', 'skipped']),
        detail: z.string().max(10_000).optional(),
      }),
    )
    .max(200)
    .default([]),
  findings: z
    .array(
      z.object({
        severity: z.enum(['info', 'warn', 'fail']),
        kind: z.string().max(64),
        message: z.string().max(10_000),
        url: z.string().max(10_000).optional(),
      }),
    )
    .max(1_000)
    .default([]),
  screenshots: z
    .array(z.object({ file: z.string().max(200), width: z.number().int().min(1).max(10_000).optional() }))
    .max(50)
    .default([]),
});

export interface ParsedReport {
  readonly status: Status;
  readonly summary: string | null;
  readonly checks: Check[];
  readonly findings: Finding[];
  readonly screenshots: { readonly file: string; readonly width: number | null }[];
}

/** Parses the verifier's report bytes; null when it is missing, too large, not JSON or not the contract. */
export function parseVerifierReport(bytes: Buffer | null): ParsedReport | null {
  if (bytes === null || bytes.length === 0 || bytes.length > LIMITS.reportBytes) return null;
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  const p = VerifierReport.safeParse(json);
  if (!p.success) return null;
  const r = p.data;
  return {
    status: r.status,
    summary: r.summary === undefined ? null : cleanText(r.summary, 1_000) || null,
    checks: r.checks.slice(0, LIMITS.checks).map((c) => ({
      source: 'verifier' as const,
      id: (CHECK_IDS as readonly string[]).includes(c.id) ? c.id : 'other',
      status: c.status,
      detail: c.detail === undefined ? null : cleanText(c.detail) || null,
    })),
    findings: r.findings.slice(0, LIMITS.findings).map((f) => {
      const url = cleanUrl(f.url);
      return {
        source: 'verifier' as const,
        severity: f.severity,
        kind: (FINDING_KINDS as readonly string[]).includes(f.kind) ? f.kind : 'other',
        message: cleanText(f.message) || '(no message)',
        ...(url === null ? {} : { url }),
      };
    }),
    screenshots: r.screenshots
      .filter((s) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}\.png$/.test(s.file))
      .slice(0, LIMITS.screenshots)
      .map((s) => ({ file: s.file, width: s.width ?? null })),
  };
}

const RANK: Readonly<Record<Status, number>> = { pass: 0, warn: 1, fail: 2 };

/** The worse of two statuses. */
export function worse(a: Status, b: Status): Status {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The overall status of a set of checks and findings and (optionally) the verifier's own word: the worst of all —
 * a failed check or a `fail` finding makes it `fail` whatever the verifier's status says; a verifier can only make
 * the result worse, never better than its checks.
 */
export function combine(
  checks: readonly Check[],
  findings: readonly Finding[],
  verifierStatus: Status | null,
): Status {
  let s: Status = verifierStatus ?? 'pass';
  for (const c of checks) if (c.status !== 'skipped') s = worse(s, c.status);
  for (const f of findings) if (f.severity !== 'info') s = worse(s, f.severity);
  return s;
}

export function stateOf(s: Status): 'passed' | 'warned' | 'failed' {
  return s === 'pass' ? 'passed' : s === 'warn' ? 'warned' : 'failed';
}

/** PNG signature. */
export function isPng(b: Buffer): boolean {
  return (
    b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  );
}

// ------------------------------------------------------------------------------------- project settings

export interface VerifySettings {
  readonly project: string;
  readonly verifyDefault: VerifyMode;
  readonly verifyRuntime: RuntimeKind | null;
  readonly testCommand: string | null;
  readonly healthAfterDeploy: boolean;
  readonly healthScreenshots: boolean;
  readonly healthKeyword: string | null;
  readonly autoRollback: boolean;
  readonly autoRollbackProduction: boolean;
  readonly updatedAt: string | null;
  readonly updatedBy: string | null;
}

export function defaultSettings(project: string): VerifySettings {
  return {
    project,
    verifyDefault: 'off',
    verifyRuntime: null,
    testCommand: null,
    healthAfterDeploy: true,
    healthScreenshots: true,
    healthKeyword: null,
    autoRollback: false,
    autoRollbackProduction: false,
    updatedAt: null,
    updatedBy: null,
  };
}

const NoNul = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'no control characters');

export const VerifySettingsInput = z
  .strictObject({
    verifyDefault: VerifyMode,
    verifyRuntime: RuntimeKind.nullable(),
    testCommand: NoNul(LIMITS.testCommand).nullable(),
    healthAfterDeploy: z.boolean(),
    healthScreenshots: z.boolean(),
    healthKeyword: NoNul(LIMITS.keyword).nullable(),
    autoRollback: z.boolean(),
    autoRollbackProduction: z.boolean(),
  })
  .refine((s) => s.autoRollback || !s.autoRollbackProduction, {
    message: 'auto-rollback for production needs auto-rollback switched on',
    path: ['autoRollbackProduction'],
  });
export type VerifySettingsInput = z.infer<typeof VerifySettingsInput>;

export class VerifyError extends HttpError {}
