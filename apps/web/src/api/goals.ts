import { apiRequest, int, nullableStr, obj, type RequestOptions, str } from './client';

/**
 * p20-outcome (docs/design/p20-outcome-contract.md): the caller's goals — one per open request of a conversation — and
 * the intervention cards of "Senden bekleyen". Titles, details and the user action are model / person text: rendered as
 * text only. Parsing is defensive (an older master has no goals: 404 → none).
 */

export type GoalState = 'open' | 'done' | 'intervention' | 'cancelled';
export type GoalOwner = 'assistant' | 'user' | 'job' | 'workflow' | 'system';
export type GoalOriginKind = 'plan' | 'job' | 'workflow_run' | 'watch';

export interface Goal {
  readonly id: string;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly origin: { readonly kind: GoalOriginKind; readonly id: string };
  readonly title: string;
  readonly outcomeCondition: string;
  readonly nextAction: string | null;
  readonly nextNote: string | null;
  readonly owner: GoalOwner;
  readonly blockedReason: string | null;
  readonly state: GoalState;
  readonly detail: string | null;
  readonly userAction: string | null;
  readonly interventions: number;
  readonly interventionAt: string | null;
  readonly updatedAt: string;
}

const ORIGINS: readonly GoalOriginKind[] = ['plan', 'job', 'workflow_run', 'watch'];
const OWNERS: readonly GoalOwner[] = ['assistant', 'user', 'job', 'workflow', 'system'];
const STATES: readonly GoalState[] = ['open', 'done', 'intervention', 'cancelled'];

export function parseGoal(v: unknown): Goal | null {
  try {
    const o = obj(v);
    const origin = obj(o.origin);
    const kind = str(origin, 'kind') as GoalOriginKind;
    const owner = str(o, 'owner') as GoalOwner;
    const state = str(o, 'state') as GoalState;
    if (!ORIGINS.includes(kind) || !OWNERS.includes(owner) || !STATES.includes(state)) return null;
    return {
      id: str(o, 'id'),
      threadId: nullableStr(o, 'threadId'),
      threadTitle: nullableStr(o, 'threadTitle'),
      origin: { kind, id: str(origin, 'id') },
      title: str(o, 'title'),
      outcomeCondition: str(o, 'outcomeCondition'),
      nextAction: nullableStr(o, 'nextAction'),
      nextNote: nullableStr(o, 'nextNote'),
      owner,
      blockedReason: nullableStr(o, 'blockedReason'),
      state,
      detail: nullableStr(o, 'detail'),
      userAction: nullableStr(o, 'userAction'),
      interventions: int(o, 'interventions'),
      interventionAt: nullableStr(o, 'interventionAt'),
      updatedAt: str(o, 'updatedAt'),
    };
  } catch {
    return null;
  }
}

/** The caller's goals in `state` (default: the open and intervention ones). */
export function listGoals(state: GoalState | 'live' = 'live', opts: RequestOptions = {}): Promise<Goal[]> {
  return apiRequest(
    'GET',
    `/chat/goals?state=${encodeURIComponent(state)}`,
    (v) => {
      const items = obj(v).items;
      return Array.isArray(items)
        ? items.flatMap((x) => {
            const g = parseGoal(x);
            return g === null ? [] : [g];
          })
        : [];
    },
    opts,
  );
}

/** "Devam ettir" / "Vazgeç" of an intervention card. */
export function goalAction(id: string, action: 'resume' | 'cancel'): Promise<Goal | null> {
  return apiRequest('POST', `/chat/goals/${encodeURIComponent(id)}/${action}`, parseGoal, { body: {} });
}
