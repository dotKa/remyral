import type { ManagedRuntimeReport, ToolInventoryReport, VersionCatalog } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/fleet-tools/catalog.js';
import type { FeedRow } from '../../src/fleet-tools/feed.js';
import { buildCatalog, buildMachine, type MachineInput } from '../../src/fleet-tools/matrix.js';

/** p17-update-channel: the fleet matrix with the version catalog's versions (docs/design/p17-update-channel.md §5). */
const NOW = '2026-10-26T10:00:00.000Z';
const feed = new Map<string, FeedRow>();

function machine(over: Partial<MachineInput> = {}): MachineInput {
  return {
    workerId: 'wrk_a',
    name: 'pc',
    os: 'linux',
    arch: 'x64',
    state: 'online',
    connected: true,
    features: ['remote-ops-v1', 'tools-v1', 'runtime-unverified-v1', 'version-catalog-v1'],
    inventory: null,
    inventoryAt: null,
    remoteOps: null,
    runtimes: [],
    machineAdminEnabled: false,
    canary: false,
    policy: null,
    ...over,
  };
}
const codex = (over: Partial<ManagedRuntimeReport> = {}): ManagedRuntimeReport => ({
  runtime: 'codex',
  method: 'npm',
  supported: true,
  pinned: '0.164.0',
  available: ['0.164.0'],
  installed: [{ version: '0.164.0', installedAt: NOW, integrity: 'ok' }],
  active: '0.164.0',
  ...over,
});
const installedCodex = [{ runtime: 'codex', version: '0.164.0', installed: true, pinned: '0.164.0' }];
const catalog = {
  schema: 1,
  name: 'remyral-version-catalog',
  sequence: 7,
  generatedAt: NOW,
  runtimes: {
    codex: [
      { version: '0.165.0', verified: true },
      { version: '0.166.0', verified: false },
    ],
  },
  tools: { uv: [{ version: '0.13.6', verified: true }] },
} as unknown as VersionCatalog;

describe('fleet matrix with the version catalog', () => {
  it('a verified catalog version the worker accepted is its pin: "Güncelle" installs it through the pinned path', () => {
    const m = buildMachine(
      machine({
        runtimes: installedCodex,
        remoteOps: [codex({ pinned: '0.165.0', releasePin: '0.164.0', available: ['0.164.0', '0.165.0'] })],
      }),
      feed,
      [],
      { unverifiedRuntimeUpdates: false },
      catalog,
    );
    expect(m.cells.find((c) => c.item === 'codex')).toMatchObject({
      pinned: '0.165.0',
      releasePin: '0.164.0',
      action: { kind: 'runtime.install', version: '0.165.0' },
    });
  });

  it('a newer verified catalog version the worker has not accepted yet is "catalog_pending" (older workers: update)', () => {
    const cell = (features: string[]) =>
      buildMachine(
        machine({ features, runtimes: installedCodex, remoteOps: [codex()] }),
        feed,
        [],
        { unverifiedRuntimeUpdates: false },
        catalog,
      ).cells.find((c) => c.item === 'codex');
    expect(cell(['remote-ops-v1', 'version-catalog-v1'])?.blocked).toBe('catalog_pending');
    expect(cell(['remote-ops-v1'])?.blocked).toBe('worker_update_required');
  });

  it('an unverified catalog version is offered only while the owner allows unverified updates', () => {
    const input = machine({
      runtimes: installedCodex,
      remoteOps: [
        codex({
          pinned: '0.165.0',
          releasePin: '0.164.0',
          available: ['0.164.0', '0.165.0'],
          catalogUnverified: ['0.166.0'],
        }),
      ],
    });
    const on = buildMachine(input, feed, [], { unverifiedRuntimeUpdates: true }, catalog);
    expect(on.cells.find((c) => c.item === 'codex')).toMatchObject({
      unverifiedAction: { kind: 'runtime.install', version: '0.166.0' },
      catalogUnverified: ['0.166.0'],
    });
    const off = buildMachine(input, feed, [], { unverifiedRuntimeUpdates: false }, catalog);
    expect(off.cells.find((c) => c.item === 'codex')?.unverifiedAction).toBeUndefined();
  });

  it('tools: the verified catalog recipe is the default, an unverified one only under the policy', () => {
    const inv: ToolInventoryReport = {
      detectedAt: NOW,
      ttlSec: 3600,
      tools: [{ name: 'cloudflared', found: true, version: '2026.10.3', source: 'managed' }],
      recipes: [
        {
          tool: 'cloudflared',
          version: '2026.10.4',
          elevated: false,
          supported: true,
          installed: false,
          catalog: { verified: true, sequence: 7 },
        },
        { tool: 'cloudflared', version: '2026.10.3', elevated: false, supported: true, installed: true },
        {
          tool: 'cloudflared',
          version: '2026.10.5',
          elevated: false,
          supported: true,
          installed: false,
          catalog: { verified: false, sequence: 7 },
        },
      ],
    };
    const on = buildMachine(
      machine({ inventory: inv }),
      feed,
      [],
      { unverifiedRuntimeUpdates: true },
      catalog,
    );
    expect(on.cells.find((c) => c.item === 'cloudflared')).toMatchObject({
      pinned: '2026.10.4',
      action: { kind: 'tool.install', version: '2026.10.4' },
      unverifiedAction: { kind: 'tool.install', version: '2026.10.5' },
    });
    const off = buildMachine(
      machine({ inventory: inv }),
      feed,
      [],
      { unverifiedRuntimeUpdates: false },
      catalog,
    );
    expect(off.cells.find((c) => c.item === 'cloudflared')?.unverifiedAction).toBeUndefined();
  });

  it('the catalog view names the catalog version of each item (verified first)', () => {
    const view = buildCatalog(feed, true, [], [], catalog);
    expect(view.find((c) => c.id === 'codex')?.catalog).toEqual({
      version: '0.165.0',
      verified: true,
      sequence: 7,
    });
    expect(view.find((c) => c.id === 'uv')?.catalog).toEqual({
      version: '0.13.6',
      verified: true,
      sequence: 7,
    });
    expect(view.find((c) => c.id === 'pi')?.catalog).toBeNull();
    expect(buildCatalog(feed, true, [], []).every((c) => c.catalog === null || c.catalog === undefined)).toBe(
      true,
    );
    expect(CATALOG.length).toBeGreaterThan(5);
  });
});
