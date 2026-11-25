import {
  ASSISTANT_BROWSER_TOOLS,
  ASSISTANT_CARD_DEFAULT_TOOLS,
  ASSISTANT_PROPOSE_FEATURE,
  ASSISTANT_TOOL_NAMES,
  ASSISTANT_TOOLS,
  WorkerFeature,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import {
  autonomyBlock,
  directDecision,
  type DirectDecisionInput,
  machineAdminByPolicy,
  type TurnHuman,
} from '../../src/chat/direct.js';
import { effectivePolicy } from '../../src/security-policy/model.js';

/**
 * p15-chat-execute-default (docs/design/p15-chat-execute-default.md): the platform, not the model, decides whether a
 * draft created in a chat turn runs at once.
 */
const base: DirectDecisionInput = {
  tool: 'suggest_approval_decision',
  execute: false,
  propose: false,
  byUser: true,
  proposeAware: true,
};

describe('directDecision (p15-chat-execute-default)', () => {
  it('runs a draft of the user’s own turn by default, without any flag from the model', () => {
    expect(directDecision(base)).toEqual({ run: 'default' });
    expect(directDecision({ ...base, tool: 'draft_deploy' })).toEqual({ run: 'default' });
  });

  it('keeps the assistant’s own proposal a card, even with execute', () => {
    expect(directDecision({ ...base, propose: true })).toEqual({ run: null });
    expect(directDecision({ ...base, propose: true, execute: true })).toEqual({ run: null });
  });

  it('never acts in a turn no person started; an explicit execute there is refused', () => {
    expect(directDecision({ ...base, byUser: false })).toEqual({ run: null });
    expect(directDecision({ ...base, byUser: false, execute: true })).toEqual({
      run: null,
      refused: 'not_user_turn',
    });
  });

  it('keeps execute: true working (p15-autonomy), also on older workers', () => {
    expect(directDecision({ ...base, execute: true })).toEqual({ run: 'execute' });
    expect(directDecision({ ...base, execute: true, proposeAware: false })).toEqual({ run: 'execute' });
  });

  it('an older assistant worker (no assistant-propose-v1) keeps cards unless execute is passed', () => {
    expect(directDecision({ ...base, proposeAware: false })).toEqual({ run: null });
  });

  it('draft_workflow stays a card by default (the editor applies it); execute still saves it', () => {
    expect(ASSISTANT_CARD_DEFAULT_TOOLS.has('draft_workflow')).toBe(true);
    expect(directDecision({ ...base, tool: 'draft_workflow' })).toEqual({ run: null });
    expect(directDecision({ ...base, tool: 'draft_workflow', execute: true })).toEqual({ run: 'execute' });
  });

  it('every card-by-default tool is a draft tool, and the worker feature is known', () => {
    for (const t of ASSISTANT_CARD_DEFAULT_TOOLS) {
      expect(ASSISTANT_TOOL_NAMES).toContain(t);
      expect(ASSISTANT_TOOLS[t].kind).toBe('draft');
    }
    expect(WorkerFeature.safeParse(ASSISTANT_PROPOSE_FEATURE).success).toBe(true);
  });
});

/**
 * p18-plan-autonomy (docs/design/p18-plan-mode.md, "Implementation (autonomy)"): a continuation turn of an approved,
 * executing, autonomous plan runs its drafts (`plan`); everything else of a system turn stays a card.
 */
describe('directDecision — plan continuation turns (p18-plan-autonomy)', () => {
  const turn: DirectDecisionInput = {
    ...base,
    tool: 'draft_job',
    byUser: false,
    plan: { state: 'executing', autonomous: true },
  };

  it('an executing (or approved) autonomous plan runs the draft with trigger plan', () => {
    expect(directDecision(turn)).toEqual({ run: 'plan' });
    expect(directDecision({ ...turn, plan: { state: 'approved', autonomous: true } })).toEqual({
      run: 'plan',
    });
    expect(directDecision({ ...turn, execute: true })).toEqual({ run: 'plan' });
    // Whether the worker knows `propose` does not matter: the owner approved the plan.
    expect(directDecision({ ...turn, proposeAware: false })).toEqual({ run: 'plan' });
  });

  it('paused, in review, cancelled or not autonomous → a card (execute there is refused as before)', () => {
    for (const state of ['paused', 'in_review', 'drafting', 'cancelled', 'done', 'superseded'])
      expect(directDecision({ ...turn, plan: { state, autonomous: true } })).toEqual({ run: null });
    expect(directDecision({ ...turn, plan: { state: 'executing', autonomous: false } })).toEqual({
      run: null,
    });
    expect(
      directDecision({ ...turn, execute: true, plan: { state: 'executing', autonomous: false } }),
    ).toEqual({ run: null, refused: 'not_user_turn' });
    expect(directDecision({ ...turn, plan: undefined })).toEqual({ run: null });
  });

  it('propose, confirm-only, browser and card-by-default tools stay cards; so does an item at its failure cap', () => {
    expect(directDecision({ ...turn, propose: true })).toEqual({ run: null });
    expect(directDecision({ ...turn, tool: 'draft_project_create' })).toEqual({ run: null });
    for (const tool of ASSISTANT_BROWSER_TOOLS)
      expect(directDecision({ ...turn, tool })).toEqual({ run: null });
    expect(directDecision({ ...turn, tool: 'coolify_delete_app' })).toEqual({ run: null });
    expect(directDecision({ ...turn, plan: { state: 'executing', autonomous: true, capped: true } })).toEqual(
      { run: null },
    );
  });

  it('the approved plan saves a workflow draft (the explicit request draft_workflow needs)', () => {
    expect(directDecision({ ...turn, tool: 'draft_workflow' })).toEqual({ run: 'plan' });
    expect(
      directDecision({ ...turn, tool: 'draft_workflow', plan: { state: 'executing', autonomous: false } }),
    ).toEqual({
      run: null,
    });
  });

  it('a plan never makes a person’s own turn act differently', () => {
    expect(directDecision({ ...turn, byUser: true })).toEqual({ run: 'default' });
    expect(directDecision({ ...turn, byUser: true, propose: true })).toEqual({ run: null });
  });
});

describe('autonomyBlock (p19-autonomy-aware)', () => {
  const policy = (preset: 'serbest' | 'siki') => effectivePolicy({ preset });
  const base = { byUser: true, proposeAware: true, plan: null, codeFreshUntil: null };

  it('a user turn on a propose-aware worker: drafts run at once; card-by-default tools are named', () => {
    const b = autonomyBlock({ ...base, policy: policy('serbest') });
    expect(b).toContain('run_at_once:');
    expect(b).toContain('coolify_delete_app');
    expect(b).toContain('draft_project_create');
    expect(b).toContain('not fresh');
  });

  it('the strict preset keeps cards; a system turn keeps cards; an autonomous plan runs', () => {
    expect(autonomyBlock({ ...base, policy: policy('siki') })).toContain('cards: every draft');
    expect(autonomyBlock({ ...base, byUser: false, policy: policy('serbest') })).toContain(
      'not started by the user',
    );
    expect(
      autonomyBlock({
        ...base,
        byUser: false,
        plan: { state: 'executing', autonomous: true },
        policy: policy('serbest'),
      }),
    ).toContain('run_at_once_plan');
  });

  it('a fresh code is reported with its end', () => {
    const until = new Date('2026-10-29T20:00:00Z');
    expect(autonomyBlock({ ...base, codeFreshUntil: until, policy: policy('serbest') })).toContain(
      'fresh until 2026-10-29T20:00:00.000Z',
    );
  });
});

describe('machine administration from the chat (p19-chat-machine-admin)', () => {
  const human: TurnHuman = { mfaAt: null, ip: '127.0.0.1', userAgent: 'vitest' };
  const serbest = effectivePolicy({ preset: 'serbest' });
  const off = effectivePolicy({ preset: 'serbest', autonomy: { chatMachineAdmin: false } });

  it('applies only to the user’s own turn (default / execute, a person’s session) with the switch on', () => {
    expect(machineAdminByPolicy(serbest, 'default', human)).toBe(true);
    expect(machineAdminByPolicy(serbest, 'execute', human)).toBe(true);
    // System-written turns: a watch's then step / follow-up, a plan continuation — never.
    expect(machineAdminByPolicy(serbest, 'watch', human)).toBe(false);
    expect(machineAdminByPolicy(serbest, 'plan', human)).toBe(false);
    expect(machineAdminByPolicy(serbest, 'default', undefined)).toBe(false);
    expect(machineAdminByPolicy(off, 'execute', human)).toBe(false);
    expect(machineAdminByPolicy(effectivePolicy({ preset: 'siki' }), 'execute', human)).toBe(false);
  });

  it('machine drafts follow the ordinary decision: a user turn runs them, a system turn keeps a card', () => {
    for (const tool of ['draft_machine_task', 'draft_machine_prepare', 'draft_tool_install'] as const) {
      expect(directDecision({ ...base, tool })).toEqual({ run: 'default' });
      expect(directDecision({ ...base, tool, byUser: false, followUp: true })).toEqual({ run: null });
      expect(ASSISTANT_CARD_DEFAULT_TOOLS.has(tool)).toBe(false);
    }
  });

  it('p22-watch-next-step: a follow-up carrying the person’s next step runs its drafts like their turn', () => {
    const f = { ...base, byUser: false, followUp: true } as const;
    for (const tool of [
      'export_workfiles',
      'coolify_create_app',
      'draft_dns_change',
      'draft_deploy',
    ] as const) {
      if (ASSISTANT_CARD_DEFAULT_TOOLS.has(tool)) continue;
      expect(directDecision({ ...f, tool, nextStep: true })).toEqual({ run: 'watch' });
      // Without the consent it stays a card, as before.
      expect(directDecision({ ...f, tool })).toEqual({ run: null });
    }
    // Machine administration and card-by-default tools are not covered.
    expect(directDecision({ ...f, tool: 'draft_machine_task', nextStep: true })).toEqual({ run: null });
    for (const tool of ASSISTANT_CARD_DEFAULT_TOOLS)
      expect(directDecision({ ...f, tool, nextStep: true }).run).toBeNull();
    // Only in a follow-up turn.
    expect(directDecision({ ...base, byUser: false, tool: 'draft_deploy', nextStep: true })).toEqual({
      run: null,
    });
  });

  it('the otonomi block tells the assistant to do machine work itself when on, and when it stays behind approvals', () => {
    const b = { byUser: true, proposeAware: true, plan: null, codeFreshUntil: null };
    const on = autonomyBlock({ ...b, policy: serbest });
    expect(on).toContain('machineAdminFromChat');
    expect(on).toMatch(/draft_machine_task/);
    expect(on).toMatch(/draft_machine_prepare/);
    expect(on).toMatch(/pass by policy/);
    expect(on).toMatch(/Never send the user to Machines/);
    expect(autonomyBlock({ ...b, policy: off })).toMatch(/off: machine administration/);
    // p20-scope-preview: a continuation inherits it only inside the goal's scope (goalGrants, on in serbest).
    expect(autonomyBlock({ ...b, byUser: false, policy: serbest })).toMatch(/inherited only/);
    expect(
      autonomyBlock({
        ...b,
        byUser: false,
        policy: effectivePolicy({ preset: 'serbest', autonomy: { goalGrants: false } }),
      }),
    ).toMatch(/not for this turn/);
    // Otomatik mod no longer claims machine administration always asks.
    expect(autonomyBlock({ ...b, policy: serbest })).toMatch(
      /machine administration as machineAdminFromChat says/,
    );
  });
});
