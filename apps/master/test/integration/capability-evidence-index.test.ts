import { verificationKeyId } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CapabilityEvidenceService } from '../../src/capability-evidence/service.js';
import type { Pool } from '../../src/db/pool.js';
import { fleetOverview } from '../../src/fleetview/overview.js';
import {
  cachedVerifiedIndex,
  invalidateVerifiedIndex,
  loadVerifiedIndex,
} from '../../src/capability-evidence/overlay.js';
import { createTestDatabase, describeIntegration, type TestDatabase } from '../helpers/env.js';

/**
 * p17-runtime-verify review fixes: the verified index has no global row cap (precedence is "newest run that decided,
 * per tuple and capability"), the cached index follows stored evidence at once, the machine view reads the evidence
 * of all its runtimes in a fixed number of queries and the matrix poll does not rebuild the index each time.
 */

/** The pool with every SQL text recorded (the same object identity for the cache: one proxy per test). */
function recording(pool: Pool): { pool: Pool; sql: string[] } {
  const sql: string[] = [];
  const proxy = new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (text: unknown, ...rest: unknown[]) => {
          sql.push(typeof text === 'string' ? text : JSON.stringify(text));
          return (target.query as (...a: unknown[]) => unknown).call(target, text, ...rest);
        };
      }
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { pool: proxy, sql };
}

const builds = (sql: readonly string[]) =>
  sql.filter((q) => q.includes('jsonb_array_elements(e.results)')).length;
const evidenceReads = (sql: readonly string[]) =>
  sql.filter((q) => q.includes('runtime_capability_evidence')).length;

const WORKER = 'wrk_evidenceindexaaaaaaaaaaaaa';
const SIG = 'A'.repeat(86);
const LIVE = {
  runtime: 'pi',
  runtimeVersion: '1.4.0',
  os: 'win32',
  arch: 'x64',
  adapterVersion: 'pi-adapter/1',
};

describeIntegration('capability evidence index (integration)', () => {
  let db: TestDatabase;

  async function insertRuns(opts: {
    count: number;
    version: string;
    finishedAt: Date;
    status: 'passed' | 'failed';
  }): Promise<void> {
    await db.pool.query(
      `INSERT INTO runtime_capability_evidence
         (id, worker_id, runtime, runtime_version, adapter_version, os, arch, worker_version, auth_mode,
          sandbox_profile, started_at, finished_at, duration_ms, input_tokens, output_tokens, passed, failed, results,
          declared, evidence, signature, received_at)
       SELECT gen_random_uuid(), $1, 'pi', $2, 'pi-adapter/1', 'win32', 'x64', '1.3.0', 'local-login',
              'host-restricted', $3::timestamptz - interval '1 minute', $3::timestamptz + make_interval(secs => g),
              60000, 1, 1, 1, 0, $4::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $3::timestamptz + make_interval(secs => g)
         FROM generate_series(1, $6::int) AS g`,
      [
        WORKER,
        opts.version,
        opts.finishedAt,
        JSON.stringify([{ capability: 'streaming', status: opts.status, reason: 'r', durationMs: 1 }]),
        SIG,
        opts.count,
      ],
    );
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    const now = new Date('2026-10-27T10:00:00Z');
    await db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, approved_at, created_at, updated_at)
       VALUES ($1, $1, 'online', '{"os":"win32","arch":"x64"}'::jsonb, '1.3.0', $2, $2, $2)`,
      [WORKER, now],
    );
  });

  afterAll(async () => {
    await db.drop();
  });

  it('an old pass on a live tuple survives many newer runs of other tuples', async () => {
    await insertRuns({
      count: 1,
      version: '1.4.0',
      finishedAt: new Date('2026-01-01T00:00:00Z'),
      status: 'passed',
    });
    // 6000 newer runs of another version (more than the old 5000-row cap), all failing their streaming check.
    await insertRuns({
      count: 6000,
      version: '1.3.9',
      finishedAt: new Date('2026-06-01T00:00:00Z'),
      status: 'failed',
    });
    const index = await loadVerifiedIndex(db.pool);
    expect(index.get(verificationKeyId(LIVE))?.get('streaming')?.outcome).toBe('passed');
    expect(
      index.get(verificationKeyId({ ...LIVE, runtimeVersion: '1.3.9' }))?.get('streaming')?.outcome,
    ).toBe('failed');
  });

  it('the cached index is reused while nothing changed and follows a newly stored run', async () => {
    invalidateVerifiedIndex(db.pool);
    const a = await cachedVerifiedIndex(db.pool);
    expect(await cachedVerifiedIndex(db.pool)).toBe(a);
    // A newer failure of the live tuple revokes its pass (stored by any master instance: the stamp changes).
    await insertRuns({
      count: 1,
      version: '1.4.0',
      finishedAt: new Date('2026-09-01T00:00:00Z'),
      status: 'failed',
    });
    const b = await cachedVerifiedIndex(db.pool);
    expect(b).not.toBe(a);
    expect(b.get(verificationKeyId(LIVE))?.get('streaming')?.outcome).toBe('failed');
  });

  it('the machine view reads the evidence of all its runtimes in a fixed number of queries', async () => {
    const now = new Date('2026-10-27T10:00:00Z');
    for (const runtime of ['pi', 'codex', 'opencode', 'claude-code']) {
      await db.pool.query(
        `INSERT INTO worker_runtimes (worker_id, runtime, version, os, arch, installed, authenticated, pinned_version,
                                      pin_status, capabilities, present, first_reported_at, last_reported_at,
                                      adapter_version)
         VALUES ($1, $2, '1.4.0', 'win32', 'x64', true, 'yes', '1.4.0', 'match', '{}'::jsonb, true, $3, $3, $4)`,
        [WORKER, runtime, now, runtime === 'pi' ? 'pi-adapter/1' : `${runtime}-adapter/1`],
      );
    }
    const rec = recording(db.pool);
    const svc = new CapabilityEvidenceService({
      pool: rec.pool,
      audit: { record: () => Promise.resolve() } as never,
      clock: () => now,
      log: { warn: () => undefined, error: () => undefined, info: () => undefined } as never,
      limiter: { hit: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
      remoteOps: () => ({ expire: () => Promise.resolve() }) as never,
      connected: () => true,
    });
    const view = await svc.status(WORKER);
    expect(view.runtimes.map((r) => r.runtime)).toEqual(['claude-code', 'codex', 'opencode', 'pi']);
    const pi = view.runtimes.find((r) => r.runtime === 'pi');
    expect(pi?.lastRun?.runtimeVersion).toBe('1.4.0');
    expect(pi?.history.length).toBe(10);
    expect(pi?.history[0]?.applies).toBe(true);
    expect(view.runtimes.find((r) => r.runtime === 'codex')?.lastRun).toBeNull();
    // Index stamp + build, the latest runs of the tuples, the histories: not two queries per runtime.
    expect(evidenceReads(rec.sql)).toBeLessThanOrEqual(4);
    rec.sql.length = 0;
    await svc.status(WORKER);
    // Cached index: the stamp only.
    expect(builds(rec.sql)).toBe(0);
    expect(evidenceReads(rec.sql)).toBeLessThanOrEqual(3);
  });

  it('the compatibility matrix poll reuses the index while no evidence was stored', async () => {
    const rec = recording(db.pool);
    const policyOf = () => Promise.resolve({ assignedPolicy: null, inSync: true, effective: null });
    await fleetOverview(rec.pool, policyOf);
    await fleetOverview(rec.pool, policyOf);
    await fleetOverview(rec.pool, policyOf);
    expect(builds(rec.sql)).toBe(1);
  });
});
