import { type ManagedRuntimeReport, RUNTIME_PINS } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import type { Pool } from '../../src/db/pool.js';
import { type FeedRow, FeedError } from '../../src/fleet-tools/feed.js';
import { buildMachine, type MachineInput, summarize } from '../../src/fleet-tools/matrix.js';
import { RuntimeReleases, versionDocumentUrl } from '../../src/fleet-tools/releases.js';
import { HttpError } from '../../src/http/errors.js';

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md §2, §4): the matrix cells of a runtime newer at the source
 * than the release pin (policy on / off, worker build, npm availability, an unverified version running), the split
 * counter, and the registry resolution of an exact release (never `latest`, sha512 required, Claude Code's bundled
 * CLI version checked).
 */

const NOW = new Date('2026-10-23T10:00:00Z');
const PIN = RUNTIME_PINS.codex.version;
const NEXT = '0.165.0';
const SRI = `sha512-${'A'.repeat(86)}==`;

const feed = (latest: string): Map<string, FeedRow> =>
  new Map([['codex', { item: 'codex', source: 'npm', latest, ok: true, error: null, checkedAt: NOW }]]);

function managed(over: Partial<ManagedRuntimeReport> = {}): ManagedRuntimeReport {
  return {
    runtime: 'codex',
    method: 'npm',
    supported: true,
    pinned: PIN,
    available: [PIN],
    installed: [{ version: PIN, installedAt: NOW.toISOString(), integrity: 'ok' }],
    active: PIN,
    unverifiedSupported: true,
    ...over,
  };
}

function machine(over: Partial<MachineInput> = {}): MachineInput {
  return {
    workerId: 'w1',
    name: 'nova-lnx',
    os: 'linux',
    arch: 'x64',
    state: 'online',
    connected: true,
    features: ['remote-ops-v1', 'runtime-unverified-v1'],
    inventory: null,
    inventoryAt: null,
    remoteOps: [managed()],
    runtimes: [{ runtime: 'codex', version: PIN, installed: true, pinned: PIN }],
    machineAdminEnabled: false,
    canary: false,
    policy: null,
    ...over,
  };
}

const codex = (m: MachineInput, on: boolean) =>
  buildMachine(m, feed(NEXT), [], { unverifiedRuntimeUpdates: on }).cells.find((c) => c.item === 'codex');

describe('runtime cells above the release pin', () => {
  it('policy on + capable worker: an unverified offer instead of "release required"', () => {
    expect(codex(machine(), true)).toMatchObject({
      status: 'update_available',
      action: null,
      unverifiedAction: { kind: 'runtime.install', version: NEXT },
    });
    expect(codex(machine(), true)?.blocked).toBeUndefined();
  });

  it('policy off: today’s behaviour (release_update_required)', () => {
    const c = codex(machine(), false);
    expect(c).toMatchObject({ action: null, blocked: 'release_update_required' });
    expect(c?.unverifiedAction).toBeUndefined();
  });

  it('an older worker build or no npm next to its Node says why', () => {
    expect(codex(machine({ features: ['remote-ops-v1'] }), true)).toMatchObject({
      blocked: 'worker_update_required',
    });
    expect(codex(machine({ remoteOps: [managed({ unverifiedSupported: false })] }), true)).toMatchObject({
      blocked: 'unverified_install_unavailable',
    });
  });

  it('an unverified version running: the badge data and the rollback to the pin, no update counted', () => {
    const m = machine({
      remoteOps: [
        managed({
          installed: [
            { version: PIN, installedAt: NOW.toISOString(), integrity: 'ok' },
            { version: NEXT, installedAt: NOW.toISOString(), integrity: 'ok', unverified: { pin: PIN } },
          ],
          active: NEXT,
        }),
      ],
      runtimes: [{ runtime: 'codex', version: NEXT, installed: true, pinned: PIN }],
    });
    const c = codex(m, true);
    expect(c).toMatchObject({
      installed: NEXT,
      status: 'current',
      unverifiedActive: { version: NEXT, pin: PIN },
      rollback: { kind: 'runtime.install', version: PIN },
    });
    expect(c?.unverifiedAction).toBeUndefined();
  });

  it('the counter splits installable from "needs a worker release"', () => {
    const on = buildMachine(machine(), feed(NEXT), [], { unverifiedRuntimeUpdates: true });
    const off = buildMachine(machine({ workerId: 'w2' }), feed(NEXT), [], {
      unverifiedRuntimeUpdates: false,
    });
    expect(summarize([on, off])).toMatchObject({
      updates: 2,
      installable: 1,
      unverified: 1,
      releaseRequired: 1,
    });
  });
});

/** A pool that keeps runtime_candidates rows in memory (only the statements RuntimeReleases sends). */
function memoryPool(): Pool {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    query: (sql: string, params: unknown[] = []) => {
      const key = `${String(params[0])}@${String(params[1])}`;
      if (sql.startsWith('SELECT')) {
        const r = rows.get(key);
        return Promise.resolve({ rows: r === undefined ? [] : [r], rowCount: r === undefined ? 0 : 1 });
      }
      if (sql.startsWith('INSERT')) {
        if (!rows.has(key))
          rows.set(key, {
            runtime: params[0],
            version: params[1],
            package: params[2],
            package_version: params[3],
            integrity: params[4],
            resolved_at: params[5],
            lock_gz: null,
            lock_sha256: null,
            lock_bytes: null,
            lock_worker_id: null,
            verify_state: 'none',
            verified_at: null,
          });
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      throw new Error(`unexpected ${sql}`);
    },
  } as unknown as Pool;
}

async function refusal(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) return err;
    throw err;
  }
  throw new Error('not refused');
}

describe('RuntimeReleases.resolve', () => {
  it('reads the exact version document and stores package, version and sha512', async () => {
    const urls: string[] = [];
    const r = new RuntimeReleases({
      pool: memoryPool(),
      clock: () => NOW,
      getJson: (url) => {
        urls.push(url);
        return Promise.resolve({ name: '@openai/codex', version: NEXT, dist: { integrity: SRI } });
      },
    });
    const c = await r.resolve('codex', NEXT);
    expect(urls).toEqual([`https://registry.npmjs.org/@openai%2Fcodex/${NEXT}`]);
    expect(c).toMatchObject({ package: '@openai/codex', packageVersion: NEXT, integrity: SRI, lock: null });
    // Stored: a second resolve reads nothing.
    await r.resolve('codex', NEXT);
    expect(urls).toHaveLength(1);
    expect(versionDocumentUrl('opencode-ai', '1.19.4')).toBe('https://registry.npmjs.org/opencode-ai/1.19.4');
  });

  it('refuses: feed off, not on the pinned line, unpublished, another release, a sha1-only answer', async () => {
    const off = new RuntimeReleases({ pool: memoryPool(), clock: () => NOW, getJson: null });
    expect((await refusal(off.resolve('codex', NEXT))).code).toBe('feed_disabled');
    const reply = (doc: unknown) =>
      new RuntimeReleases({ pool: memoryPool(), clock: () => NOW, getJson: () => Promise.resolve(doc) });
    const [maj = '', min = ''] = RUNTIME_PINS['claude-code'].version.split('.');
    expect(
      (await refusal(reply({}).resolve('claude-code', `${maj}.${String(Number(min) + 1)}.0`))).code,
    ).toBe('version_not_on_pinned_line');
    const gone = new RuntimeReleases({
      pool: memoryPool(),
      clock: () => NOW,
      getJson: () => Promise.reject(new FeedError('HTTP 404')),
    });
    expect((await refusal(gone.resolve('codex', NEXT))).code).toBe('runtime_release_not_found');
    expect(
      (
        await refusal(
          reply({ name: '@openai/codex', version: '0.163.0', dist: { integrity: SRI } }).resolve(
            'codex',
            NEXT,
          ),
        )
      ).code,
    ).toBe('release_mismatch');
    expect(
      (
        await refusal(
          reply({ name: '@openai/codex', version: NEXT, dist: { shasum: 'ab' } }).resolve('codex', NEXT),
        )
      ).code,
    ).toBe('release_mismatch');
  });

  it('Claude Code: the SDK must bundle exactly the requested CLI version', async () => {
    const pin = RUNTIME_PINS['claude-code'];
    const [maj = '', min = ''] = pin.version.split('.');
    const cli = `${maj}.${min}.309`;
    const sdk = `${pin.packageVersion.split('.').slice(0, 2).join('.')}.309`;
    const r = (bundled: string) =>
      new RuntimeReleases({
        pool: memoryPool(),
        clock: () => NOW,
        getJson: () =>
          Promise.resolve({
            name: pin.package,
            version: sdk,
            claudeCodeVersion: bundled,
            dist: { integrity: SRI },
          }),
      });
    expect((await refusal(r('2.1.300').resolve('claude-code', cli))).code).toBe('release_mismatch');
    expect(await r(cli).resolve('claude-code', cli)).toMatchObject({ packageVersion: sdk });
  });
});
