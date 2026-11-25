import { describe, expect, it } from 'vitest';
import { combineAdvice, type PlacementAdvice, ProjectDefaults } from '../../src/composer/defaults.js';
import type { PreviewDeps } from '../../src/composer/preview.js';
import type { Queryable } from '../../src/db/pool.js';

/**
 * p6-chat-job-defaults (docs/design/p6-automations.md §2b): the shared project defaults service used by automations
 * and the assistant's one-off drafts, and the combined placement advice of a workflow run.
 */

const placed = (...machines: string[]): PlacementAdvice => ({
  verdict: 'placed',
  machines,
  warning: null,
  note: null,
});

describe('combineAdvice (workflow runs)', () => {
  it('one step setup: its advice unchanged', () => {
    expect(combineAdvice([{ steps: ['a', 'b'], advice: placed('win') }])).toEqual(placed('win'));
  });

  it('no advice at all (no preview): null', () => {
    expect(combineAdvice([{ steps: ['a'], advice: null }])).toBeNull();
  });

  it('the worst verdict wins; warnings name their steps; machines of every step', () => {
    const out = combineAdvice([
      { steps: ['build'], advice: placed('win') },
      {
        steps: ['check', 'ship'],
        advice: { verdict: 'infeasible', machines: [], warning: 'No machine can run this.', note: null },
      },
      { steps: ['notify'], advice: { verdict: 'waiting', machines: [], warning: null, note: 'Busy.' } },
    ]);
    expect(out).toEqual({
      verdict: 'infeasible',
      machines: ['win'],
      warning: 'Steps check, ship: No machine can run this.',
      // A warning outranks notes (the card shows the warning).
      note: null,
    });
  });

  it('only notes: the note per step group', () => {
    expect(
      combineAdvice([
        { steps: ['a'], advice: placed('mac', 'win') },
        { steps: ['b'], advice: { verdict: 'held', machines: [], warning: null, note: 'Quota.' } },
      ]),
    ).toEqual({ verdict: 'held', machines: ['mac', 'win'], warning: null, note: 'Step b: Quota.' });
  });
});

/** A project row with host execution allowed and a registered repository. */
function fakeDb(): Queryable {
  return {
    query: (sql: string) =>
      Promise.resolve(
        sql.includes('FROM projects')
          ? { rows: [{ kind: 'repository', host_execution: true, auto_approve_execution: false }] }
          : { rows: [{ repository_url: 'https://github.com/acme/app.git' }] },
      ),
  } as unknown as Queryable;
}

describe('ProjectDefaults', () => {
  const spec = {
    runtime: 'codex',
    prompt: 'x',
    repository: { url: 'https://github.com/acme/app.git', baseRef: 'main', workBranch: 'agent/x' },
  };

  it('without the composer preview: trusted own repository, container (no fleet facts), no placement advice', async () => {
    const d = new ProjectDefaults({ db: fakeDb() });
    const applied = await d.apply('acme', spec);
    expect(applied.spec).toMatchObject({
      sourceTrust: 'trusted',
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    });
    expect(applied.filled).toEqual(['sourceTrust', 'sandboxProfile', 'approvalPolicy', 'limits']);
    expect(await d.placement('acme', applied.spec)).toBeNull();
  });

  it('a preview that is not ready yet or fails falls back to the project row and reports the failure', async () => {
    const errors: string[] = [];
    const notReady = new ProjectDefaults({
      db: fakeDb(),
      preview: () => {
        throw new Error('services not initialised');
      },
    });
    expect((await notReady.apply('acme', spec)).spec).toMatchObject({ sandboxProfile: 'container' });
    const failing = new ProjectDefaults({
      db: fakeDb(),
      preview: () =>
        ({
          db: {
            query: () => Promise.reject(new Error('db down')),
          },
        }) as unknown as PreviewDeps,
      onError: (_err, what) => errors.push(what),
    });
    expect((await failing.apply('acme', spec)).spec).toMatchObject({ sandboxProfile: 'container' });
    expect(await failing.placement('acme', { ...spec, sandboxProfile: 'container' })).toBeNull();
    expect(errors).toEqual(['defaults', 'placement']);
  });

  it('keeps explicit values', async () => {
    const d = new ProjectDefaults({ db: fakeDb() });
    const applied = await d.apply('acme', {
      ...spec,
      sandboxProfile: 'runtime-sandbox',
      approvalPolicy: 'deny-sensitive',
      limits: { maxDurationSec: 120 },
    });
    expect(applied.spec).toMatchObject({
      sandboxProfile: 'runtime-sandbox',
      approvalPolicy: 'deny-sensitive',
      limits: { maxDurationSec: 120 },
    });
    expect(applied.filled).toEqual(['sourceTrust']);
  });
});
