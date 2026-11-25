import { DEFAULT_RULES, Redactor } from '@remyral/observability';
import { z } from 'zod';
import { ApprovalDetailsSchema } from '@remyral/protocol';
import {
  APPROVAL_DETAIL_LIMITS,
  type ApprovalDetails,
  type ApprovalHeadline,
  type ApprovalHints,
  approvalHeadline,
  approvalHints,
  clip,
  hasApprovalDetails,
  multiLine,
  oneLine,
} from '@remyral/protocol/approval-details';

/**
 * p10-approval-readable (docs/design/p10-approval-readable.md §3): the master's half of the structured approval
 * details. A worker's `details` are validated (protocol schema), every string is cleaned and passed through the
 * pattern redactor again (the worker only knows the job's exact secret values; a token typed into a command is caught
 * here), then cut per field. Reads re-validate the stored JSON (rows are never trusted to have the current shape) and
 * derive the headline and the static hints on the fly, so a better reading needs no data migration.
 */

const redactor = new Redactor({ rules: DEFAULT_RULES });

function line(s: string, max: number): string {
  return clip(oneLine(redactor.redact(s)), max);
}

/** The details to store for a request, or null (absent, invalid or empty). Never throws. */
export function detailsToStore(raw: unknown): ApprovalDetails | null {
  if (raw === undefined || raw === null) return null;
  const parsed = ApprovalDetailsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data;
  const L = APPROVAL_DETAIL_LIMITS;
  const out: { -readonly [K in keyof ApprovalDetails]: ApprovalDetails[K] } = {
    tool: line(d.tool, L.tool) || 'tool',
  };
  if (d.description !== undefined) {
    const v = line(d.description, L.description);
    if (v !== '') out.description = v;
  }
  if (d.command !== undefined) {
    const v = multiLine(redactor.redact(d.command));
    if (v.trim() !== '') {
      out.command = clip(v, L.command);
      if (d.commandTruncated === true || v.length > L.command) out.commandTruncated = true;
      if (d.shell !== undefined) out.shell = d.shell;
    }
  }
  if (d.cwd !== undefined && d.cwd.trim() !== '') out.cwd = line(d.cwd, L.cwd);
  if (d.workspaceRoot !== undefined && d.workspaceRoot.trim() !== '')
    out.workspaceRoot = line(d.workspaceRoot, L.cwd);
  if (d.paths !== undefined) {
    const paths = d.paths.map((p) => line(p, L.path)).filter((p) => p !== '');
    if (paths.length > 0) out.paths = paths.slice(0, L.paths);
  }
  if (d.morePaths !== undefined && d.morePaths > 0) out.morePaths = d.morePaths;
  if (d.url !== undefined && d.url.trim() !== '') out.url = line(d.url, L.url);
  return hasApprovalDetails(out) ? out : null;
}

/** Stored details (jsonb) → the current shape, or null. */
export function storedDetails(v: unknown): ApprovalDetails | null {
  if (v === null || v === undefined) return null;
  const parsed = ApprovalDetailsSchema.safeParse(v);
  if (!parsed.success) return null;
  // JSON has no `undefined` values: the parsed object is an ApprovalDetails as stored.
  const d = parsed.data as ApprovalDetails;
  return hasApprovalDetails(d) ? d : null;
}

export interface DetailsView {
  readonly details: ApprovalDetails | null;
  readonly hints: ApprovalHints | null;
  readonly headline: ApprovalHeadline;
}

/** What the API shows next to a request: the details, the static hints (when there is something to read) and one line. */
export function detailsView(details: ApprovalDetails | null, summary: string): DetailsView {
  let hints: ApprovalHints | null = null;
  if (
    details !== null &&
    (details.command !== undefined || details.paths !== undefined || details.url !== undefined)
  ) {
    try {
      hints = approvalHints(details);
    } catch {
      hints = null; // a reading aid; it never fails a request
    }
  }
  return { details, hints, headline: approvalHeadline(details, summary) };
}

/** One bounded plain-text line for notifications and chat notes: the agent's claim labelled as such, or the command. */
export function headlineSentence(h: ApprovalHeadline, max = 160): string | null {
  if (h.source === 'summary') return null;
  const text = clip(h.text, max);
  return h.source === 'agent' ? `The agent says (unverified): “${text}”` : `Command: ${text}`;
}

/** p10-approval-readable: a static reading of the command (not a guarantee). */
export const ApprovalHintsBody = z.object({
  runs: z.array(z.string()),
  reaches: z.array(z.string()),
  writes: z.array(z.string()),
  deletes: z.array(z.string()),
  installs: z.array(z.string()),
  envVars: z.array(z.string()),
  outside: z.array(z.string()),
  elevated: z.boolean(),
  safeVerdict: z.enum(['read', 'workspace_write']).nullable(),
  partial: z.boolean(),
});

export const ApprovalHeadlineBody = z.object({
  text: z.string(),
  source: z.enum(['agent', 'command', 'summary']),
});

/** Hints for a live `approval_request` event (its payload's `details`), or null. */
export function eventHints(payload: Record<string, unknown>): ApprovalHints | null {
  return detailsView(storedDetails(payload.details), '').hints;
}
