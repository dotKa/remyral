import type { WatchThen, WatchThenMode } from '@remyral/protocol';
import type { Subject } from '../authz/model.js';
import type { EffectiveSecurityPolicy } from '../security-policy/model.js';
import { eventOfDraft } from '../security-policy/events.js';
import { type ChatDirectActions, type DirectPlanInput, directDecision } from './direct.js';
import type { ToolCaller, ToolOutcome } from './tools.js';

/**
 * p15-watch-autorun (docs/design/p15-watch-autorun.md): the `then` step of a watch (`create_watch`) runs by itself when
 * its condition is met — through the very policy machinery the chat uses for the user's direct commands
 * (p15-autonomy / p15-chat-execute-default): {@link directDecision} when the watch is created (was it the user's own
 * request, and do they want to confirm first?) and {@link ChatDirectActions.execute} when it fires (the security
 * policy's `autonomy.chatDirect`, the step's event and its authenticator-code rule, the user's role re-checked, audit
 * `chat.direct_action` with `trigger: watch`). Nothing here is a second policy.
 */

/** The draft tool a `then` step is built with (the same checks as the assistant's own call). */
export type ThenTool = 'draft_workflow_run' | 'draft_job_message' | 'draft_deploy';

export function thenTool(then: WatchThen): ThenTool {
  switch (then.action) {
    case 'workflow_run':
      return 'draft_workflow_run';
    case 'job_message':
      return 'draft_job_message';
    case 'deploy':
      return 'draft_deploy';
  }
}

/** The draft kind a `then` step's card has (its step-up event: {@link eventOfDraft}). */
export function thenDraftKind(then: WatchThen): string {
  // p19-watch-deploy: draft_deploy builds an `ops_action` card.
  return then.action === 'deploy' ? 'ops_action' : then.action;
}

/** p19-watch-deploy: the draft_deploy input of a `deploy` step. */
export function deployInput(then: Extract<WatchThen, { action: 'deploy' }>): Record<string, unknown> {
  return {
    project: then.project,
    action: then.restart === true ? 'coolify.restart' : 'coolify.deploy',
    ...(then.env === undefined ? {} : { env: then.env }),
    ...(then.force === undefined || then.restart === true ? {} : { force: then.force }),
  };
}

/** The turn a tool call belongs to (who started it), as the chat service knows it. */
export interface TurnOrigin {
  /** The turn answers a message a person wrote (not a system-written one). */
  readonly byUser: boolean;
  /** p22-watch-next-step: the watch this system-written follow-up turn carries on after (absent: none). */
  readonly followUpWatch?: string | undefined;
  /** p22-slow-tools: the person's consent a system-written turn carries (a late tool result handed back). */
  readonly consentAt?: Date | undefined;
  /** The assistant worker advertises `assistant-propose-v1`. */
  readonly proposeAware: () => Promise<boolean>;
  /**
   * p18-plan-autonomy: a continuation turn of a plan — the plan as it stands now. An approved, autonomous plan stores
   * `auto` like a draft of that turn runs (the owner's consent was given with the approval).
   */
  readonly plan?: (() => Promise<DirectPlanInput | null>) | undefined;
  /**
   * oss-sec3: what made the turn untrusted so far (empty: clean). A tainted turn stores a `then` step as `ask` and
   * gives a new watch no consent of the person for its next step.
   */
  readonly tainted?: (() => Promise<ReadonlySet<string>>) | undefined;
}

/** oss-sec3: whether the turn has read untrusted content (unknown: tainted — fail closed). */
export async function turnTainted(turn: TurnOrigin | undefined): Promise<boolean> {
  if (turn?.tainted === undefined) return false;
  try {
    return (await turn.tainted()).size > 0;
  } catch {
    return true;
  }
}

/**
 * The stored mode of a new watch's `then`: `auto` when the chat would run that draft at once for this turn (the user's
 * own message; the assistant passed `mode: auto`, or left it out on a propose-aware worker), else `ask`. A turn no
 * person started stores `auto` only as a continuation of an approved, autonomous plan (p18-plan-autonomy); otherwise
 * never (`refused`).
 */
export async function thenModeAtCreate(
  then: WatchThen,
  turn: TurnOrigin | undefined,
): Promise<{ readonly mode: WatchThenMode; readonly refused: boolean | 'untrusted' }> {
  const wanted = then.mode;
  const plan = turn?.byUser === false && turn.plan !== undefined ? await turn.plan() : null;
  const d = directDecision({
    tool: thenTool(then),
    execute: wanted === 'auto',
    propose: wanted === 'ask',
    byUser: turn?.byUser ?? false,
    proposeAware: wanted === undefined && turn !== undefined ? await turn.proposeAware() : false,
    ...(plan === null ? {} : { plan }),
    tainted: await turnTainted(turn),
  });
  return {
    mode: d.run === null ? 'ask' : 'auto',
    // oss-sec3: held for untrusted content — the forecast says why the step will be a card.
    refused: d.held !== undefined ? 'untrusted' : d.refused !== undefined,
  };
}

export type ThenForecast =
  | 'runs'
  | 'card_asked'
  | 'card_not_user_turn'
  | 'card_untrusted'
  | 'card_policy'
  | 'card_code'
  | 'policy_unknown';

/** What happens now if the condition were met (the policy is read again when it really is). */
export function thenForecast(
  then: WatchThen,
  refused: boolean | 'untrusted',
  policy: EffectiveSecurityPolicy | null,
): ThenForecast {
  if (then.mode !== 'auto')
    return refused === 'untrusted' ? 'card_untrusted' : refused ? 'card_not_user_turn' : 'card_asked';
  if (policy === null) return 'policy_unknown';
  if (!policy.autonomy.chatDirect) return 'card_policy';
  if (policy.events[eventOfDraft(thenDraftKind(then), {})]) return 'card_code';
  return 'runs';
}

/** The forecast as the model reads it in the create_watch result (`then.onMet`). */
export const FORECAST_TEXT: Readonly<Record<ThenForecast, string>> = {
  runs: 'runs by itself for the user when the condition is met — no card (the security policy allows it now and is checked again then; the workflow’s own approval steps and the project’s deploy policy — e.g. a production approval — still apply); the link follows in this conversation',
  card_asked:
    'a card is prepared when the condition is met; the user confirms it (they asked to confirm first)',
  card_not_user_turn:
    'a card is prepared when the condition is met; the user confirms it (this turn was not started by the user’s own message, so nothing runs by itself)',
  card_untrusted:
    'a card is prepared when the condition is met; the user confirms it (this turn read content from outside the user — a job log, a file, a web response — so nothing it set up runs by itself)',
  card_policy:
    'a card is prepared when the condition is met; the user confirms it (the security policy keeps confirmation cards for the assistant — Settings → Security)',
  card_code:
    'a card is prepared when the condition is met; the user confirms it with an authenticator code (the security policy asks for a code for this step)',
  policy_unknown:
    'runs by itself when the condition is met if the security policy allows it then; otherwise a card waits for the user',
};

/** What preparing / running the `then` step did. */
export type ThenOutcome =
  | {
      readonly ok: true;
      readonly draftId: string;
      readonly executed: true;
      readonly action: WatchThen['action'];
      /** The workflow's name / the job id / the deployed project (shown in the note). */
      readonly name: string;
      /** Console link of what ran (the workflow run, the job). */
      readonly link: string | null;
    }
  | {
      readonly ok: true;
      readonly draftId: string;
      readonly executed: false;
      /** Why a card waits: the user asked, or the direct path said so. */
      readonly why:
        | 'ask'
        | 'cards_required'
        | 'needs_code'
        | 'failed'
        | 'unavailable'
        | 'not_user_turn'
        // p16-assistant-admin (never for a watch's job_message / workflow_run step; the type is the direct outcome's).
        | 'card_only'
        | 'destructive'
        // p20-scope-preview (never for a watch's `then` step: it passes no goal grant; the type is the outcome's).
        | 'out_of_scope'
        // oss-sec3 (never for a watch's `then` step: the step runs on its own, not in a turn; the outcome's type).
        | 'untrusted_content';
      readonly message: string | null;
    }
  | { readonly ok: false; readonly message: string };

export interface WatchThenRunnerDeps {
  /** The assistant's tools (the draft tool builds the card with its own checks). */
  readonly tools: () => {
    run(caller: ToolCaller, tool: ThenTool, input: unknown): Promise<ToolOutcome>;
  } | null;
  readonly direct: () => ChatDirectActions | null;
}

/**
 * Builds the `then` card for the watch's owner (fresh subject) and, for `mode: auto`, sends it through the chat's direct
 * path at once. Runs once per fire: the caller invokes it only for the evaluation that recorded the fire, and the
 * card's confirmation locks the draft row (a second confirmation finds it decided).
 */
export class WatchThenRunner {
  constructor(private readonly deps: WatchThenRunnerDeps) {}

  async run(caller: ToolCaller & { readonly watchId: string }, then: WatchThen): Promise<ThenOutcome> {
    const tools = this.deps.tools();
    if (tools === null) return { ok: false, message: 'the assistant tools are not available' };
    const out =
      then.action === 'job_message'
        ? await tools.run(caller, 'draft_job_message', { jobId: then.jobId, text: then.text })
        : then.action === 'deploy'
          ? await tools.run(caller, 'draft_deploy', deployInput(then))
          : await tools.run(caller, 'draft_workflow_run', {
              workflowId: then.workflowId,
              ...(then.inputs === undefined ? {} : { inputs: then.inputs }),
            });
    if (!out.ok) return { ok: false, message: out.message };
    const draft = out.draft;
    if (draft === undefined) return { ok: false, message: 'no card was created' };
    if (then.mode !== 'auto')
      return { ok: true, draftId: draft.id, executed: false, why: 'ask', message: null };
    const direct = this.deps.direct();
    if (direct === null)
      return {
        ok: true,
        draftId: draft.id,
        executed: false,
        why: 'unavailable',
        message: 'Direct actions are not available.',
      };
    const subject: Subject = caller.subject;
    const done = await direct.execute(subject, subject.role, undefined, draft, 'watch', {
      watchId: caller.watchId,
      approvedBy: 'policy',
    });
    if (!done.executed)
      return { ok: true, draftId: draft.id, executed: false, why: done.reason, message: done.message };
    const p = draft.payload;
    if (then.action === 'deploy') {
      // p19-watch-deploy: the ops action's console page (`/deploys/:id`), else the project's deploy tab.
      const link = done.result.link;
      return {
        ok: true,
        draftId: draft.id,
        executed: true,
        action: 'deploy',
        name: then.env === undefined ? then.project : `${then.project} (${then.env})`,
        link: typeof link === 'string' ? link : `/projects/${encodeURIComponent(then.project)}?tab=deploy`,
      };
    }
    if (then.action === 'workflow_run') {
      const runId = done.result.runId;
      return {
        ok: true,
        draftId: draft.id,
        executed: true,
        action: 'workflow_run',
        name: typeof p.workflow === 'string' ? p.workflow : 'workflow',
        link: typeof runId === 'string' ? `/jobs/workflows/${encodeURIComponent(runId)}` : null,
      };
    }
    return {
      ok: true,
      draftId: draft.id,
      executed: true,
      action: 'job_message',
      name: then.jobId,
      link: `/jobs/${encodeURIComponent(then.jobId)}`,
    };
  }
}
