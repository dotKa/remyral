import {
  APPROVAL_SHELLS,
  type ApprovalDetails,
  type ApprovalHeadline,
  type ApprovalHints,
  approvalHeadline,
} from '@remyral/protocol/approval-details';

/**
 * p10-approval-readable: tolerant parsers for the additive approval fields (`details`, `hints`, `headline`). An older
 * master sends none of them: the request is then shown from `summary` as before. Every string is untrusted runtime
 * text — React renders it as text, never as HTML.
 */

export type { ApprovalDetails, ApprovalHeadline, ApprovalHints };

function s(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export function parseApprovalDetails(v: unknown): ApprovalDetails | null {
  const o = record(v);
  const tool = o === null ? undefined : s(o, 'tool');
  if (o === null || tool === undefined) return null;
  const out: { -readonly [K in keyof ApprovalDetails]: ApprovalDetails[K] } = { tool };
  const description = s(o, 'description');
  if (description !== undefined) out.description = description;
  const command = s(o, 'command');
  if (command !== undefined) out.command = command;
  if (o.commandTruncated === true) out.commandTruncated = true;
  const shell = APPROVAL_SHELLS.find((x) => x === o.shell);
  if (shell !== undefined) out.shell = shell;
  const cwd = s(o, 'cwd');
  if (cwd !== undefined) out.cwd = cwd;
  const root = s(o, 'workspaceRoot');
  if (root !== undefined) out.workspaceRoot = root;
  const paths = strings(o.paths);
  if (paths.length > 0) out.paths = paths;
  if (typeof o.morePaths === 'number' && o.morePaths > 0) out.morePaths = o.morePaths;
  const url = s(o, 'url');
  if (url !== undefined) out.url = url;
  return out;
}

export function parseApprovalHints(v: unknown): ApprovalHints | null {
  const o = record(v);
  if (o === null) return null;
  return {
    runs: strings(o.runs),
    reaches: strings(o.reaches),
    writes: strings(o.writes),
    deletes: strings(o.deletes),
    installs: strings(o.installs),
    envVars: strings(o.envVars),
    outside: strings(o.outside),
    elevated: o.elevated === true,
    safeVerdict: o.safeVerdict === 'read' || o.safeVerdict === 'workspace_write' ? o.safeVerdict : null,
    partial: o.partial === true,
  };
}

/** The master's headline, or the same reading done here (older master: from the summary). */
export function parseApprovalHeadline(
  v: unknown,
  details: ApprovalDetails | null,
  summary: string,
): ApprovalHeadline {
  const o = record(v);
  const text = o === null ? undefined : s(o, 'text');
  const source = o?.source;
  if (text !== undefined && (source === 'agent' || source === 'command' || source === 'summary'))
    return { text, source };
  return approvalHeadline(details, summary);
}
