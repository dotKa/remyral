import { describe, expect, it } from 'vitest';
import { effectivePolicy } from '../../src/security-policy/model.js';
import { WatchCheckCondition, WatchThen } from '@remyral/protocol';
import {
  FORECAST_TEXT,
  deployInput,
  thenDraftKind,
  thenForecast,
  thenModeAtCreate,
  thenTool,
} from '../../src/chat/watch-then.js';
import { inputsOf, stepsOf } from '../../src/chat/workflow-read.js';

/** p15-watch-autorun: the stored mode of a watch's `then` step and what happens when its condition is met. */
const WF = '0b0bd1f0-efc0-479e-84de-4c60f201d86c';
const run = (mode?: 'auto' | 'ask') =>
  ({ action: 'workflow_run', workflowId: WF, ...(mode === undefined ? {} : { mode }) }) as const;
const turn = (byUser: boolean, aware: boolean) => ({ byUser, proposeAware: () => Promise.resolve(aware) });

describe('then mode at creation (directDecision of the creating turn)', () => {
  it('auto on the user’s request; ask when they want to confirm; never auto outside a user turn', async () => {
    expect(await thenModeAtCreate(run('auto'), turn(true, false))).toEqual({ mode: 'auto', refused: false });
    expect(await thenModeAtCreate(run('ask'), turn(true, true))).toEqual({ mode: 'ask', refused: false });
    // Left out: the platform's default for a propose-aware worker, the old card for an older one.
    expect(await thenModeAtCreate(run(), turn(true, true))).toEqual({ mode: 'auto', refused: false });
    expect(await thenModeAtCreate(run(), turn(true, false))).toEqual({ mode: 'ask', refused: false });
    expect(await thenModeAtCreate(run('auto'), turn(false, true))).toEqual({ mode: 'ask', refused: true });
    expect(await thenModeAtCreate(run('auto'), undefined)).toEqual({ mode: 'ask', refused: true });
    expect(
      await thenModeAtCreate(
        { action: 'job_message', jobId: WF, text: 'go', mode: 'auto' },
        turn(true, true),
      ),
    ).toEqual({ mode: 'auto', refused: false });
  });
});

describe('then mode in a plan continuation turn (p18-plan-autonomy)', () => {
  const planTurn = (state: 'executing' | 'paused', autonomous: boolean) => ({
    byUser: false,
    proposeAware: () => Promise.resolve(true),
    plan: () => Promise.resolve({ planId: 'p1', version: 2, state, autonomous }),
  });
  it('an approved, autonomous plan stores auto; ask still asks; off or paused stays a card', async () => {
    expect(await thenModeAtCreate(run(), planTurn('executing', true))).toEqual({
      mode: 'auto',
      refused: false,
    });
    expect(await thenModeAtCreate(run('auto'), planTurn('executing', true))).toEqual({
      mode: 'auto',
      refused: false,
    });
    expect(await thenModeAtCreate(run('ask'), planTurn('executing', true))).toEqual({
      mode: 'ask',
      refused: false,
    });
    expect(await thenModeAtCreate(run('auto'), planTurn('executing', false))).toEqual({
      mode: 'ask',
      refused: true,
    });
    expect(await thenModeAtCreate(run('auto'), planTurn('paused', true))).toEqual({
      mode: 'ask',
      refused: true,
    });
    expect(
      await thenModeAtCreate(run(), {
        byUser: false,
        proposeAware: () => Promise.resolve(true),
        plan: () => Promise.resolve(null),
      }),
    ).toEqual({ mode: 'ask', refused: false });
  });
});

describe('forecast from the security policy (read again when the condition is met)', () => {
  it('runs under Serbest; a card under Sıkı, with chatDirect off or with a code for chat cards', () => {
    expect(thenForecast(run('auto'), false, effectivePolicy({ preset: 'serbest' }))).toBe('runs');
    expect(thenForecast(run('auto'), false, effectivePolicy({ preset: 'dengeli' }))).toBe('runs');
    expect(thenForecast(run('auto'), false, effectivePolicy({ preset: 'siki' }))).toBe('card_policy');
    expect(
      thenForecast(
        run('auto'),
        false,
        effectivePolicy({ preset: 'serbest', autonomy: { chatDirect: false } }),
      ),
    ).toBe('card_policy');
    expect(
      thenForecast(
        run('auto'),
        false,
        effectivePolicy({ preset: 'serbest', events: { 'chat.cards': true } }),
      ),
    ).toBe('card_code');
    expect(thenForecast(run('ask'), false, effectivePolicy({ preset: 'serbest' }))).toBe('card_asked');
    expect(thenForecast(run('ask'), true, effectivePolicy({ preset: 'serbest' }))).toBe('card_not_user_turn');
    expect(thenForecast(run(), false, effectivePolicy({ preset: 'serbest' }))).toBe('card_asked');
    expect(thenForecast(run('auto'), false, null)).toBe('policy_unknown');
    for (const t of Object.values(FORECAST_TEXT)) expect(t.length).toBeGreaterThan(20);
  });
});

describe('deploy step (p19-watch-deploy)', () => {
  const deploy = { action: 'deploy', project: 'boxing-king', env: 'production', mode: 'auto' } as const;
  it('parses, maps to draft_deploy and an ops_action card', () => {
    expect(WatchThen.parse(deploy)).toEqual(deploy);
    expect(WatchThen.safeParse({ ...deploy, project: 'a b' }).success).toBe(false);
    expect(WatchThen.safeParse({ ...deploy, extra: 1 }).success).toBe(false);
    expect(thenTool(deploy)).toBe('draft_deploy');
    expect(thenTool(run())).toBe('draft_workflow_run');
    expect(thenDraftKind(deploy)).toBe('ops_action');
    expect(deployInput(deploy)).toEqual({
      project: 'boxing-king',
      action: 'coolify.deploy',
      env: 'production',
    });
    expect(deployInput({ ...deploy, restart: true, force: true })).toEqual({
      project: 'boxing-king',
      action: 'coolify.restart',
      env: 'production',
    });
    expect(deployInput({ action: 'deploy', project: 'p', force: true })).toEqual({
      project: 'p',
      action: 'coolify.deploy',
      force: true,
    });
  });
  it('forecast follows the deploy event of the security policy', async () => {
    expect(thenForecast(deploy, false, effectivePolicy({ preset: 'serbest' }))).toBe('runs');
    expect(
      thenForecast(
        deploy,
        false,
        effectivePolicy({ preset: 'serbest', events: { 'deploy.production': true } }),
      ),
    ).toBe('card_code');
    expect(await thenModeAtCreate(deploy, turn(true, true))).toEqual({ mode: 'auto', refused: false });
  });
  it('the merged job state is a condition', () => {
    const id = WF;
    expect(WatchCheckCondition.safeParse({ kind: 'job_state', jobId: id, states: ['merged'] }).success).toBe(
      true,
    );
  });
});

describe('workflow summaries for the assistant (no prompts, no config)', () => {
  it('v1: AI steps, gates, a manual trigger, documented inputs', () => {
    const def = {
      name: 'x',
      inputs: { mesaj: { required: true, description: 'Metin' }, ton: {} },
      nodes: [
        { id: 'plan', role: 'planner', prompt: 'SECRET PROMPT' },
        { id: 'ship', role: 'executor', prompt: 'p', approval: { approverRole: 'operator' } },
      ],
      edges: [],
    };
    expect(inputsOf(def)).toEqual([
      { name: 'mesaj', required: true, description: 'Metin' },
      { name: 'ton', required: false },
    ]);
    const s = stepsOf(def);
    expect(s).toMatchObject({
      schemaVersion: 1,
      nodes: 2,
      types: { 'ai.step': 2 },
      triggers: ['trigger.manual'],
      approvalGates: [{ node: 'ship', approverRole: 'operator' }],
      integrations: [],
    });
    expect(JSON.stringify(s)).not.toContain('SECRET PROMPT');
  });

  it('v2: triggers, approval nodes and external integrations by catalog category', () => {
    const s = stepsOf({
      schemaVersion: 2,
      nodes: [
        { id: 'start', type: 'trigger.chat', config: {} },
        { id: 'ok', type: 'control.approval', config: { approverRole: 'admin' } },
        {
          id: 'call',
          type: 'http.request',
          label: 'WhatsApp API',
          config: { origin: 'https://x', token: 'T' },
        },
        { id: 'mail', type: 'email.send', config: {} },
        { id: 'calc', type: 'code.js', config: { source: 'return 1' } },
        { id: 'shape', type: 'data.set', config: {} },
      ],
    });
    expect(s.triggers).toEqual(['trigger.chat']);
    expect(s.approvalGates).toEqual([{ node: 'ok', approverRole: 'admin' }]);
    expect(s.integrations.map((i) => i.node)).toEqual(['call', 'mail', 'calc']);
    expect(s.integrations[0]).toEqual({ node: 'call', type: 'http.request', label: 'WhatsApp API' });
    expect(JSON.stringify(s)).not.toContain('return 1');
    expect(JSON.stringify(s)).not.toContain('"T"');
  });
});
