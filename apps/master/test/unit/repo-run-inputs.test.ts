import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/pool.js';
import { inputFilesAvailability } from '../../src/jobs/repo-inputs.js';

/**
 * p19-repo-inputs-composer-workflows: what the composer is told about input files (job) / run files (workflow run)
 * for a project — workspace always, repository while a machine advertises `repo-inputs-v1` ("makine güncellenmeli"
 * otherwise), anything else never.
 */
function fakeDb(machines: number): Queryable & { calls: number } {
  const db = {
    calls: 0,
    query: () => {
      db.calls += 1;
      return Promise.resolve({ rows: [{ n: machines }], rowCount: 1 });
    },
  };
  return db as unknown as Queryable & { calls: number };
}

describe('inputFilesAvailability', () => {
  it('a workspace project always takes files (no fleet query)', async () => {
    const db = fakeDb(0);
    expect(await inputFilesAvailability(db, 'workspace')).toEqual({ available: true, reason: null });
    expect(db.calls).toBe(0);
  });

  it('a repository project takes them while a machine has repo-inputs-v1', async () => {
    expect(await inputFilesAvailability(fakeDb(1), 'repository')).toEqual({ available: true, reason: null });
    expect(await inputFilesAvailability(fakeDb(0), 'repository')).toEqual({
      available: false,
      reason: 'inputs_worker_update',
    });
  });

  it('an unknown project never does', async () => {
    expect(await inputFilesAvailability(fakeDb(3), null)).toEqual({
      available: false,
      reason: 'inputs_project',
    });
  });
});
