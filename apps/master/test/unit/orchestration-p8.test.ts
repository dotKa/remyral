import type { JobSpec } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import {
  carveLimits,
  chooseRuntime,
  delegationAllowlist,
  SubtaskRefusal,
  subtaskStateOf,
} from '../../src/subtasks/service.js';
import { parseDefinition, parsePlan } from '../../src/workflows/definition.js';
import { definitionRuntimes, resolvePlanTasks, staticPlacement } from '../../src/workflows/placement.js';

const now = new Date('2026-10-16T12:00:00Z');
const zero = { costUsd: 0, tokens: 0, turns: 0 };

describe('sub-job limits (carveLimits)', () => {
  it('bounds the duration by the parent deadline minus the margin and halves what remains of each budget', () => {
    const out = carveLimits({
      parent: { maxDurationSec: 3600, maxTokens: 100_000, maxTurns: 40, maxCostUsd: 2 },
      deadline: new Date(now.getTime() + 1000 * 1000),
      now,
      used: { costUsd: 0.5, tokens: 20_000, turns: 10 },
      granted: { costUsd: 0.5, tokens: 30_000, turns: 10 },
    });
    expect(out).toEqual({ maxDurationSec: 940, maxTokens: 25_000, maxTurns: 10, maxCostUsd: 0.5 });
  });
  it('omits budgets the parent does not have', () => {
    expect(
      carveLimits({
        parent: { maxDurationSec: 600 },
        deadline: new Date(now.getTime() + 7200_000),
        now,
        used: zero,
        granted: zero,
      }),
    ).toEqual({ maxDurationSec: 600 });
  });
  it('refuses when too little time or budget remains', () => {
    const base = { now, used: zero, granted: zero };
    expect(() =>
      carveLimits({ ...base, parent: { maxDurationSec: 600 }, deadline: new Date(now.getTime() + 150_000) }),
    ).toThrow(SubtaskRefusal);
    expect(() =>
      carveLimits({
        ...base,
        parent: { maxDurationSec: 600, maxTokens: 10 },
        deadline: new Date(now.getTime() + 3600_000),
        used: { ...zero, tokens: 9 },
      }),
    ).toThrow(/token budget/);
  });
});

describe('sub-job runtime (chooseRuntime)', () => {
  const allowed = delegationAllowlist('claude-code', { subtasks: true, delegationRuntimes: ['codex'] });
  it('allowlist: the parent runtime first, then the project list', () => {
    expect(allowed).toEqual(['claude-code', 'codex']);
    expect(delegationAllowlist('codex', { subtasks: true, delegationRuntimes: ['codex'] })).toEqual([
      'codex',
    ]);
  });
  it('image-generation picks codex; a requested runtime must be allowed and match the tags', () => {
    const base = { allowed, parent: 'claude-code' as const, routed: null };
    expect(
      chooseRuntime({ ...base, requested: undefined, requires: ['image-generation', 'ffmpeg'] }),
    ).toEqual({
      runtime: 'codex',
      source: 'requires',
      tools: ['ffmpeg'],
    });
    expect(() => chooseRuntime({ ...base, requested: 'pi', requires: [] })).toThrow(/not allowed/);
    expect(() =>
      chooseRuntime({ ...base, requested: 'claude-code', requires: ['image-generation'] }),
    ).toThrow(/needs runtime codex/);
    expect(() => chooseRuntime({ ...base, requested: undefined, requires: ['teleport'] })).toThrow(
      /Unknown capability/,
    );
    expect(() =>
      chooseRuntime({
        allowed: ['claude-code'],
        parent: 'claude-code',
        routed: null,
        requested: undefined,
        requires: ['image-generation'],
      }),
    ).toThrow(/not allowed/);
  });
  it('without hints: an allowed routing rule, else the parent runtime', () => {
    const base = { allowed, parent: 'claude-code' as const, requested: undefined, requires: [] };
    expect(chooseRuntime({ ...base, routed: 'codex' }).source).toBe('routing');
    expect(chooseRuntime({ ...base, routed: 'pi' })).toMatchObject({
      runtime: 'claude-code',
      source: 'parent',
    });
  });
  it('maps job states to what the agent sees', () => {
    expect(
      ['QUEUED', 'BLOCKED', 'RUNNING', 'AWAITING_APPROVAL', 'SUCCEEDED', 'CANCELLED'].map(subtaskStateOf),
    ).toEqual(['queued', 'queued', 'running', 'running', 'succeeded', 'cancelled']);
  });
});

describe('planner hints (parsePlan + resolvePlanTasks)', () => {
  const def = parseDefinition({
    name: 'video',
    defaults: {
      runtime: 'claude-code',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 600 },
    },
    nodes: [
      { id: 'plan', role: 'planner', prompt: 'p', dynamic: { maxNodes: 4 } },
      { id: 'review', role: 'verifier', prompt: 'r', runtime: 'opencode' },
    ],
    edges: [{ from: 'plan', to: 'review' }],
  });
  const planner = {
    runtime: 'claude-code',
    model: 'sonnet',
    prompt: 'p',
    sandboxProfile: 'container',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 600 },
    requirements: { tools: ['git'] },
  } as unknown as JobSpec;

  function db(
    opts: { delegation?: string[]; workers?: { id: string; display_name: string }[] } = {},
  ): Queryable {
    return {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM projects')) {
          return Promise.resolve({
            rows: [{ subtasks_enabled: false, delegation_runtimes: opts.delegation ?? [] }],
          });
        }
        if (sql.includes('FROM model_catalog')) {
          const entry = (id: string, runtimes: string[], enabled = true) => ({
            id,
            version: 1,
            entry: { id, displayName: id, runtimes, provider: 'openai', model: id, enabled },
          });
          return Promise.resolve({
            rows: [entry('gpt-img', ['codex']), entry('off', ['codex'], false)],
          });
        }
        if (sql.includes('FROM workers')) {
          const key = (typeof params?.[0] === 'string' ? params[0] : '').toLowerCase();
          return Promise.resolve({
            rows: (opts.workers ?? []).filter((w) => w.id === key || w.display_name.toLowerCase() === key),
          });
        }
        throw new Error(`unexpected SQL ${sql}`);
      },
    } as unknown as Queryable;
  }

  it('parses the hints strictly (unknown keys still reject the plan)', () => {
    const ok = parsePlan(
      '```remyral-plan\n{"tasks":[{"id":"a","title":"A","prompt":"x","runtime":"codex","requires":["image-generation"],"machine":"pc"}]}\n```',
    );
    expect(ok.ok && ok.tasks[0]).toMatchObject({
      runtime: 'codex',
      requires: ['image-generation'],
      machine: 'pc',
    });
    expect(
      parsePlan(
        '```remyral-plan\n{"tasks":[{"id":"a","title":"A","prompt":"x","sandboxProfile":"unconfined"}]}\n```',
      ),
    ).toEqual({
      ok: false,
      code: 'plan_invalid',
    });
  });

  it('definition runtimes are part of the allowlist', () => {
    expect(definitionRuntimes(def).sort()).toEqual(['claude-code', 'opencode']);
  });

  it('resolves tags, models and machine hints; keeps the planner model only on its own runtime', async () => {
    const r = await resolvePlanTasks(
      db({ delegation: ['codex'], workers: [{ id: 'w-1', display_name: 'Desktop-PC' }] }),
      {
        project: 'p',
        def,
        planner,
        tasks: [
          { id: 'img', requires: ['image-generation'], model: 'gpt-img', machine: 'desktop-pc' },
          { id: 'edit' },
          { id: 'ghost', machine: 'nowhere' },
          { id: 'rev', role: 'verifier', runtime: 'opencode' },
        ],
        routeRuntime: () => Promise.resolve(null),
      },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.tasks.get('img')).toMatchObject({
      patch: { runtime: 'codex', model: 'gpt-img', requirements: { tools: ['git'], workers: ['w-1'] } },
      placement: { runtime: 'codex', source: 'requires', machine: { id: 'w-1', name: 'Desktop-PC' } },
    });
    expect(r.tasks.get('edit')).toMatchObject({
      patch: { runtime: 'claude-code', model: 'sonnet' },
      placement: { source: 'planner' },
    });
    expect(r.tasks.get('ghost')?.placement.notes.join(' ')).toMatch(/not an enrolled machine/);
    expect(r.tasks.get('ghost')?.patch.requirements?.workers).toBeUndefined();
    expect(r.tasks.get('rev')).toMatchObject({
      patch: { runtime: 'opencode', model: undefined },
      placement: { source: 'plan' },
    });
  });

  it('rejects runtimes outside the allowlist, disabled or foreign models, unknown tags and conflicts', async () => {
    const r = await resolvePlanTasks(db(), {
      project: 'p',
      def,
      planner,
      tasks: [
        { id: 'a', runtime: 'codex' },
        { id: 'b', runtime: 'openhands' },
        { id: 'c', requires: ['image-generation'] },
        { id: 'd', requires: ['teleport'] },
        { id: 'e', model: 'off' },
        { id: 'f', runtime: 'opencode', requires: ['image-generation'] },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => `${i.path}:${i.code}`)).toEqual([
      'tasks.0.runtime:not_allowed',
      'tasks.1.runtime:not_allowed',
      'tasks.2.requires:runtime_not_allowed',
      'tasks.3.requires:unknown_capability:teleport',
      'tasks.4.model:not_allowed',
      'tasks.5.requires:runtime_conflict',
    ]);
    expect(r.allowed.sort()).toEqual(['claude-code', 'opencode']);
  });

  it('a routing rule decides when the plan names nothing and the rule picks an allowed runtime', async () => {
    const r = await resolvePlanTasks(db({ delegation: ['codex'] }), {
      project: 'p',
      def,
      planner,
      tasks: [{ id: 'x' }, { id: 'y', role: 'verifier' }],
      routeRuntime: (_p, role) => Promise.resolve(role === 'execute' ? 'codex' : 'pi'),
    });
    if (!r.ok) throw new Error('rejected');
    expect(r.tasks.get('x')?.placement).toMatchObject({ runtime: 'codex', source: 'routing' });
    expect(r.tasks.get('y')?.placement).toMatchObject({ runtime: 'claude-code', source: 'planner' });
  });

  it('static steps explain their runtime', () => {
    expect(
      staticPlacement({
        nodeRuntime: 'opencode',
        routed: undefined,
        spec: { ...planner, runtime: 'opencode' },
      }).source,
    ).toBe('node');
    expect(
      staticPlacement({ nodeRuntime: undefined, routed: 'codex', spec: { ...planner, runtime: 'codex' } })
        .source,
    ).toBe('routing');
    expect(staticPlacement({ nodeRuntime: undefined, routed: undefined, spec: planner })).toMatchObject({
      source: 'default',
      tools: ['git'],
    });
  });
});
