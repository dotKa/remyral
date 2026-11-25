import { apiRequest, int, nullableStr, obj, type RequestOptions, ShapeError, str } from './client';
import { type DownloadOptions, downloadExport, type ExportResult } from './download';

/**
 * Typed wrappers for the audit explorer API (apps/master/src/audit/routes.ts,
 * docs/design/p5-search-audit.md). Targets, user agents and metadata can carry attacker-chosen text:
 * render them as text only.
 */

export const ACTOR_TYPES = ['user', 'worker', 'system', 'anonymous'] as const;
export const OUTCOMES = ['success', 'failure', 'denied', 'error'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export type Outcome = (typeof OUTCOMES)[number];

export interface AuditFilter {
  readonly from?: string;
  readonly to?: string;
  readonly actorType?: ActorType | '';
  readonly actorId?: string;
  readonly action?: string;
  readonly target?: string;
  readonly outcome?: Outcome | '';
  readonly q?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly actor: { readonly type: string; readonly id: string | null };
  readonly action: string;
  readonly target: string | null;
  readonly outcome: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly prevHash: string;
  readonly hash: string;
}

export interface AuditPage {
  readonly items: AuditEvent[];
  readonly nextCursor: string | null;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly fromId: string | null;
  readonly toId: string | null;
  readonly brokenAtId: string | null;
  readonly reason: string | null;
  readonly headHash: string | null;
  readonly anchored: string;
  readonly verifiedAt: string;
}

type Opts = Omit<RequestOptions, 'body'>;

/** Query string with only the filled-in fields, in a stable order. */
export function auditQuery(
  filter: AuditFilter,
  extra: Record<string, string | null | undefined> = {},
): string {
  const params = new URLSearchParams();
  const add = (k: string, v: string | null | undefined): void => {
    const t = v?.trim();
    if (t) params.append(k, t);
  };
  add('from', filter.from);
  add('to', filter.to);
  add('actorType', filter.actorType);
  add('actorId', filter.actorId);
  add('action', filter.action);
  add('target', filter.target);
  add('outcome', filter.outcome);
  add('q', filter.q);
  for (const [k, v] of Object.entries(extra)) add(k, v);
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

function parseEvent(v: unknown): AuditEvent {
  const o = obj(v);
  const actor = obj(o.actor);
  return {
    id: str(o, 'id'),
    occurredAt: str(o, 'occurredAt'),
    actor: { type: str(actor, 'type'), id: nullableStr(actor, 'id') },
    action: str(o, 'action'),
    target: nullableStr(o, 'target'),
    outcome: str(o, 'outcome'),
    ip: nullableStr(o, 'ip'),
    userAgent: nullableStr(o, 'userAgent'),
    metadata: obj(o.metadata),
    prevHash: str(o, 'prevHash'),
    hash: str(o, 'hash'),
  };
}

function array<T>(v: unknown, item: (x: unknown) => T): T[] {
  if (!Array.isArray(v)) throw new ShapeError('expected array');
  return v.map(item);
}

export function listAudit(
  filter: AuditFilter,
  cursor: string | null,
  opts: Opts & { readonly limit?: number } = {},
): Promise<AuditPage> {
  return apiRequest(
    'GET',
    `/audit${auditQuery(filter, { limit: String(opts.limit ?? 50), cursor })}`,
    (v) => {
      const o = obj(v);
      return { items: array(o.items, parseEvent), nextCursor: nullableStr(o, 'nextCursor') };
    },
    opts,
  );
}

export function verifyAuditChain(
  range: { fromId?: string; toId?: string },
  opts: Opts = {},
): Promise<VerifyResult> {
  const params = new URLSearchParams();
  if (range.fromId) params.append('fromId', range.fromId);
  if (range.toId) params.append('toId', range.toId);
  const qs = params.toString();
  return apiRequest(
    'GET',
    `/audit/verify${qs ? `?${qs}` : ''}`,
    (v) => {
      const o = obj(v);
      if (typeof o.ok !== 'boolean') throw new ShapeError('expected ok');
      return {
        ok: o.ok,
        checked: int(o, 'checked'),
        fromId: nullableStr(o, 'fromId'),
        toId: nullableStr(o, 'toId'),
        brokenAtId: nullableStr(o, 'brokenAtId'),
        reason: nullableStr(o, 'reason'),
        headHash: nullableStr(o, 'headHash'),
        anchored: str(o, 'anchored'),
        verifiedAt: str(o, 'verifiedAt'),
      };
    },
    opts,
  );
}

/** `cursor`: the manifest's `next_cursor` of a truncated export, to continue after it. */
export function exportAudit(
  filter: AuditFilter,
  format: 'jsonl' | 'csv',
  cursor: string | null = null,
  opts: DownloadOptions = {},
): Promise<ExportResult> {
  return downloadExport(
    `/audit/export${auditQuery(filter, { format, cursor })}`,
    `audit-export.${format}`,
    opts,
  );
}
