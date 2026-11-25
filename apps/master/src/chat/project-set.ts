import { ASSISTANT_TOOLS, type AssistantToolName } from '@remyral/protocol';

/**
 * p18-multi-project W3 (docs/design/p18-multi-project.md §2.3, §3 rule 4): the write rules of a conversation's working
 * projects — pure, so the matrix is unit-tested. Applied by ChatTools only for turns on an assistant worker that knows
 * the working projects (`assistant-projects-v1`) and only when the conversation has at least one working project
 * (a conversation without projects keeps today's behaviour).
 *
 * - A write (a `draft` tool) whose `project` (or one of draft_job_batch's / draft_automation's `projects`) is outside the set →
 *   `project_not_in_thread`. set_thread_projects itself changes the set and is exempt.
 * - draft_workflow_run without `project` while the workflow is available in more than one working project →
 *   `project_required` (ChatTools decides that, it needs the attachments).
 * - Plan items: a `project` outside the set → `project_not_in_thread`; a job / workflow item without a project while the
 *   set has more than one member → `project_required`.
 */

export type ProjectSetRefusal = {
  readonly ok: false;
  readonly code: 'project_not_in_thread' | 'project_required';
  readonly message: string;
};

/** Tools exempt from the set rule (they change the set). */
const EXEMPT: ReadonlySet<AssistantToolName> = new Set<AssistantToolName>(['set_thread_projects']);

/** The projects a write tool's input names (empty: none named — the tool derives its project, e.g. from a job). */
export function writeTargets(tool: AssistantToolName, input: Record<string, unknown>): string[] {
  if (ASSISTANT_TOOLS[tool].kind !== 'draft' || EXEMPT.has(tool)) return [];
  const out: string[] = [];
  if (typeof input.project === 'string') out.push(input.project);
  // p18-multi-project W4: draft_automation `projects` (the same automation in several projects).
  if ((tool === 'draft_job_batch' || tool === 'draft_automation') && Array.isArray(input.projects))
    for (const p of input.projects) if (typeof p === 'string') out.push(p);
  return [...new Set(out)];
}

export function notInSetMessage(projects: readonly string[], set: readonly string[]): string {
  return `${projects.join(', ')} ${projects.length === 1 ? 'is' : 'are'} not among this conversation's working projects (${set.join(', ')}). Ask the user, or — when their request clearly names ${projects.length === 1 ? 'that project' : 'those projects'} — add ${projects.length === 1 ? 'it' : 'them'} with set_thread_projects (the whole new set) and try again.`;
}

/** The set rule for one tool call (null: allowed). */
export function projectSetRefusal(
  tool: AssistantToolName,
  input: Record<string, unknown>,
  set: readonly string[],
): ProjectSetRefusal | null {
  if (set.length === 0) return null;
  const outside = writeTargets(tool, input).filter((p) => !set.includes(p));
  if (outside.length === 0) return null;
  return { ok: false, code: 'project_not_in_thread', message: notInSetMessage(outside, set) };
}

export function projectRequiredMessage(set: readonly string[], what: string): string {
  return `This conversation works on several projects (${set.join(', ')}): name the project of ${what} (project). If the user did not make it clear, ask them with ask_user.`;
}

/** A plan item as plan_create / plan_update_items `add` write it. */
interface PlanItemLike {
  readonly key?: unknown;
  readonly owner?: unknown;
  readonly project?: unknown;
}

/** Items of a plan_create / plan_update_items input (add ops and set_project ops). */
function planItems(tool: AssistantToolName, input: Record<string, unknown>): PlanItemLike[] {
  if (tool === 'plan_create' && Array.isArray(input.phases)) {
    return input.phases.flatMap((ph: unknown) => {
      const items = (ph as { items?: unknown }).items;
      return Array.isArray(items) ? (items as PlanItemLike[]) : [];
    });
  }
  if (tool === 'plan_update_items' && Array.isArray(input.ops)) {
    return input.ops.flatMap((o: unknown): PlanItemLike[] => {
      const op = o as { op?: unknown; item?: unknown; key?: unknown; project?: unknown };
      if (op.op === 'add' && typeof op.item === 'object' && op.item !== null) return [op.item];
      // set_project to null is checked by the owner of the stored item (not known here) — only a named project.
      if (op.op === 'set_project' && typeof op.project === 'string')
        return [{ key: op.key, project: op.project }];
      return [];
    });
  }
  return [];
}

/** The plan rule (p18-plan-mode §2: `project` in the set, required for job / workflow items when it has several). */
export function planProjectRefusal(
  tool: AssistantToolName,
  input: Record<string, unknown>,
  set: readonly string[],
): ProjectSetRefusal | null {
  if (set.length === 0) return null;
  const items = planItems(tool, input);
  const outside = [
    ...new Set(
      items.flatMap((i) => (typeof i.project === 'string' && !set.includes(i.project) ? [i.project] : [])),
    ),
  ];
  if (outside.length > 0)
    return { ok: false, code: 'project_not_in_thread', message: notInSetMessage(outside, set) };
  if (set.length > 1) {
    const missing = items
      .filter((i) => (i.owner === 'job' || i.owner === 'workflow') && typeof i.project !== 'string')
      .map((i) => (typeof i.key === 'string' ? i.key : '?'));
    if (missing.length > 0)
      return {
        ok: false,
        code: 'project_required',
        message: projectRequiredMessage(set, `the job / workflow items ${missing.slice(0, 10).join(', ')}`),
      };
  }
  return null;
}
