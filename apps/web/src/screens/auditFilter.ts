import { type ActorType, type AuditFilter, type Outcome } from '../api/audit';

/**
 * Audit explorer (docs/design/p5-search-audit.md §6): filter bar, keyset-paginated results (table on wide
 * screens, cards on phones), a detail drawer with the redacted metadata, chain verification and export
 * through the step-up dialog. Every value shown can be attacker-influenced and is rendered as text.
 */

export interface AuditDraft {
  from: string;
  to: string;
  actorType: ActorType | '';
  actorId: string;
  action: string;
  target: string;
  outcome: Outcome | '';
  q: string;
}

export const EMPTY_AUDIT_DRAFT: AuditDraft = {
  from: '',
  to: '',
  actorType: '',
  actorId: '',
  action: '',
  target: '',
  outcome: '',
  q: '',
};

/** `datetime-local` value (local time, no zone) → ISO instant; empty or invalid → undefined. */
export function localToIso(value: string): string | undefined {
  if (value === '') return undefined;
  const t = new Date(value);
  return Number.isNaN(t.getTime()) ? undefined : t.toISOString();
}

export function toAuditFilter(d: AuditDraft): AuditFilter {
  const from = localToIso(d.from);
  const to = localToIso(d.to);
  return {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    actorType: d.actorType,
    actorId: d.actorId,
    action: d.action.trim().toLowerCase(),
    target: d.target,
    outcome: d.outcome,
    q: d.q,
  };
}
