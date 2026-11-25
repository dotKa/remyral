import type { ToolInventoryReport } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { CATALOG, feedUrl } from '../../src/fleet-tools/catalog.js';
import { allowedFeedUrl, type FeedRow, parseFeed } from '../../src/fleet-tools/feed.js';
import { buildMachine, type MachineInput, summarize } from '../../src/fleet-tools/matrix.js';
import { validateRecipe } from '../../src/fleet-tools/recipes.js';
import { isoWeek } from '../../src/fleet-tools/service.js';
import { HttpError } from '../../src/http/errors.js';

const SHA = 'ab'.repeat(32);

describe('version feeds', () => {
  it('every catalog feed URL is on an allowlisted host', () => {
    for (const c of CATALOG) if (c.feed !== null) expect(allowedFeedUrl(feedUrl(c.feed)), c.id).toBe(true);
    expect(feedUrl({ kind: 'npm', pkg: '@openai/codex' })).toBe(
      'https://registry.npmjs.org/@openai%2Fcodex/latest',
    );
  });

  it('refuses other hosts, http, userinfo and ports', () => {
    expect(allowedFeedUrl('https://evil.example/x')).toBe(false);
    expect(allowedFeedUrl('http://registry.npmjs.org/x')).toBe(false);
    expect(allowedFeedUrl('https://u:p@api.github.com/x')).toBe(false);
    expect(allowedFeedUrl('https://api.github.com:444/x')).toBe(false);
    expect(allowedFeedUrl('https://api.github.com.evil.example/x')).toBe(false);
  });

  it('parses npm, GitHub, NuGet and the Node.js index', () => {
    expect(parseFeed({ kind: 'npm', pkg: 'x' }, { version: '2.1.300' })).toBe('2.1.300');
    expect(parseFeed({ kind: 'github', repo: 'a/b' }, { tag_name: 'v2.57.0.windows.1' })).toBe('2.57.0.1');
    expect(parseFeed({ kind: 'github', repo: 'a/b' }, { tag_name: 'v1', prerelease: true })).toBeNull();
    expect(
      parseFeed({ kind: 'nuget', pkg: 'python' }, { versions: ['3.13.16', '3.14.0', '3.15.0-a1', '3.9.1'] }),
    ).toBe('3.14.0');
    expect(
      parseFeed({ kind: 'node-lts' }, [
        { version: 'v25.1.0', lts: false },
        { version: 'v24.21.0', lts: 'Krypton' },
      ]),
    ).toBe('24.21.0');
    expect(parseFeed({ kind: 'npm', pkg: 'x' }, 'garbage')).toBeNull();
  });
});

const NOW = new Date('2026-10-20T10:00:00Z');
const feed = (rows: Record<string, string | null>): Map<string, FeedRow> =>
  new Map(
    Object.entries(rows).map(([item, latest]) => [
      item,
      {
        item,
        source: 'x',
        latest,
        ok: latest !== null,
        error: latest === null ? 'HTTP 500' : null,
        checkedAt: NOW,
      },
    ]),
  );

function inventory(
  tools: ToolInventoryReport['tools'],
  recipes: ToolInventoryReport['recipes'] = [],
): ToolInventoryReport {
  return { detectedAt: NOW.toISOString(), ttlSec: 3600, tools, recipes };
}

function machine(over: Partial<MachineInput> = {}): MachineInput {
  return {
    workerId: 'wrk_a',
    name: 'desktop-pc',
    os: 'win32',
    arch: 'x64',
    state: 'online',
    connected: true,
    features: ['remote-ops-v1', 'tools-v1', 'custom-tools-v1', 'machine-admin-v1'],
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

describe('fleet matrix', () => {
  const recipes: ToolInventoryReport['recipes'] = [
    { tool: 'git', version: '2.56.0.2', elevated: false, supported: true, installed: true },
    { tool: 'python', version: '3.13.16', elevated: false, supported: true, installed: false },
  ];

  it('git: system not found + worker 2.56 ⇒ effective managed, current against the recipe, nothing to do', () => {
    const m = buildMachine(
      machine({
        inventory: inventory(
          [
            { name: 'git', found: false, source: 'system' },
            { name: 'git', found: true, source: 'managed', version: '2.56.0.2' },
            { name: 'node', found: true, source: 'system', version: '24.21.0' },
          ],
          recipes,
        ),
      }),
      feed({ git: '2.56.0.2', node: '24.21.0', python: '3.14.0' }),
      [],
    );
    const git = m.cells.find((c) => c.item === 'git');
    expect(git).toMatchObject({ installed: '2.56.0.2', source: 'managed', status: 'current', action: null });
    expect(m.cells.find((c) => c.item === 'node')).toMatchObject({ source: 'system', status: 'current' });
    // Python: not found, the release recipe installs it.
    expect(m.cells.find((c) => c.item === 'python')).toMatchObject({
      status: 'not_found',
      action: { kind: 'tool.install', version: '3.13.16' },
    });
  });

  it('a managed install older than the recipe differs from the pin and can be updated; a newer upstream needs a release', () => {
    const m = buildMachine(
      machine({
        inventory: inventory([{ name: 'git', found: true, source: 'managed', version: '2.50.0.1' }], recipes),
      }),
      feed({ git: '2.57.0.1' }),
      [],
    );
    expect(m.cells.find((c) => c.item === 'git')).toMatchObject({
      status: 'pin_differs',
      action: { kind: 'tool.install', version: '2.56.0.2' },
    });
    const cur = buildMachine(
      machine({
        inventory: inventory([{ name: 'git', found: true, source: 'managed', version: '2.56.0.2' }], recipes),
      }),
      feed({ git: '2.57.0.1' }),
      [],
    );
    expect(cur.cells.find((c) => c.item === 'git')).toMatchObject({
      status: 'update_available',
      action: null,
      blocked: 'release_update_required',
    });
  });

  it('a shadowed system install is reported next to the effective one', () => {
    const m = buildMachine(
      machine({
        inventory: inventory(
          [
            { name: 'git', found: true, source: 'system', version: '2.40.0' },
            { name: 'git', found: true, source: 'managed', version: '2.56.0.2' },
          ],
          recipes,
        ),
      }),
      feed({}),
      [],
    );
    expect(m.cells.find((c) => c.item === 'git')).toMatchObject({
      source: 'managed',
      shadowed: { version: '2.40.0', source: 'system' },
    });
  });

  it('runtimes: installed vs policy pin vs latest; installable only from the pinned set', () => {
    const m = buildMachine(
      machine({
        runtimes: [{ runtime: 'codex', version: '0.162.1', installed: true, pinned: '0.162.1' }],
        remoteOps: [
          {
            runtime: 'codex',
            method: 'npm',
            supported: true,
            pinned: '0.162.1',
            available: ['0.162.1'],
            installed: [{ version: '0.162.1', installedAt: NOW.toISOString(), integrity: 'ok' }],
            active: '0.162.1',
          },
          {
            runtime: 'claude-code',
            method: 'npm',
            supported: true,
            pinned: '2.1.296',
            available: ['2.1.296'],
            installed: [],
            active: null,
          },
        ],
      }),
      feed({ codex: '0.170.0', 'claude-code': '2.1.296' }),
      [],
    );
    expect(m.cells.find((c) => c.item === 'codex')).toMatchObject({
      installed: '0.162.1',
      source: 'managed',
      pinned: '0.162.1',
      latest: '0.170.0',
      status: 'update_available',
      action: null,
      blocked: 'release_update_required',
    });
    expect(m.cells.find((c) => c.item === 'claude-code')).toMatchObject({
      status: 'not_found',
      action: { kind: 'runtime.install', version: '2.1.296' },
    });
    // A version that differs from the policy pin.
    const drift = buildMachine(
      machine({ runtimes: [{ runtime: 'pi', version: '1.0.9', installed: true, pinned: '1.1.0' }] }),
      feed({}),
      [],
    );
    expect(drift.cells.find((c) => c.item === 'pi')?.status).toBe('pin_differs');
  });

  it('the Linux distribution recipe needs machine administration', () => {
    const inv = inventory(
      [{ name: 'git', found: false, source: 'system' }],
      [{ tool: 'git', version: 'distro', elevated: true, supported: true, installed: false }],
    );
    const off = buildMachine(machine({ os: 'linux', inventory: inv }), feed({}), []);
    expect(off.cells.find((c) => c.item === 'git')).toMatchObject({
      action: null,
      blocked: 'machine_admin_not_enabled',
    });
    const on = buildMachine(
      machine({ os: 'linux', inventory: inv, machineAdminEnabled: true }),
      feed({}),
      [],
    );
    expect(on.cells.find((c) => c.item === 'git')?.action).toEqual({
      kind: 'tool.elevated',
      version: 'distro',
    });
  });

  it('custom tools: installable where the recipe has a step, machine administration is on and the worker can', () => {
    const recipe = validateRecipe({
      name: 'ripgrep',
      title: 'ripgrep',
      version: '15.0.0',
      platforms: {
        'win32-x64': {
          kind: 'download',
          url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/rg.zip',
          sha256: SHA,
          size: 100,
          format: 'zip',
          entry: 'rg.exe',
        },
      },
      check: {},
    });
    const on = buildMachine(machine({ machineAdminEnabled: true, inventory: inventory([]) }), feed({}), [
      recipe,
    ]);
    expect(on.cells.find((c) => c.item === 'custom:ripgrep')).toMatchObject({
      status: 'not_found',
      action: { kind: 'custom.install', version: '15.0.0' },
    });
    const off = buildMachine(machine({ inventory: inventory([]) }), feed({}), [recipe]);
    expect(off.cells.find((c) => c.item === 'custom:ripgrep')?.blocked).toBe('machine_admin_not_enabled');
    const linux = buildMachine(machine({ os: 'linux', machineAdminEnabled: true }), feed({}), [recipe]);
    expect(linux.cells.find((c) => c.item === 'custom:ripgrep')?.blocked).toBe('platform_unsupported');
    const old = buildMachine(
      machine({ machineAdminEnabled: true, features: ['remote-ops-v1', 'tools-v1'] }),
      feed({}),
      [recipe],
    );
    expect(old.cells.find((c) => c.item === 'custom:ripgrep')?.blocked).toBe('worker_update_required');
  });

  it('summarizes updates and actionable cells', () => {
    const a = buildMachine(
      machine({ runtimes: [{ runtime: 'pi', version: '1.0.9', installed: true, pinned: '1.1.0' }] }),
      feed({}),
      [],
    );
    const s = summarize([a]);
    expect(s.updates).toBeGreaterThanOrEqual(1);
    expect(s.machinesWithUpdates).toBe(1);
  });
});

describe('custom recipe validation', () => {
  const base = {
    name: 'mytool',
    title: 'My tool',
    version: '1.0.0',
    platforms: {
      'linux-x64': {
        kind: 'download',
        url: 'https://github.com/x/y/releases/download/1.0.0/t.tgz',
        sha256: SHA,
        size: 10,
        format: 'tgz',
        entry: 'bin/t',
      },
    },
    check: {},
  };
  const issues = (raw: unknown): { path: string; code: string }[] => {
    try {
      validateRecipe(raw);
      return [];
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      expect(err.code).toBe('recipe_invalid');
      return (err.details as { issues: { path: string; code: string }[] }).issues;
    }
  };

  it('accepts a valid recipe', () => {
    expect(issues(base)).toEqual([]);
  });

  it('names the allowlist, checksum, reserved-name and path problems', () => {
    expect(
      issues({
        ...base,
        platforms: { 'linux-x64': { ...base.platforms['linux-x64'], url: 'https://evil.example/t' } },
      }),
    ).toContainEqual({ path: 'platforms.linux-x64.url', code: 'host_not_allowed' });
    expect(
      issues({ ...base, platforms: { 'linux-x64': { ...base.platforms['linux-x64'], sha256: 'abc' } } }),
    ).toContainEqual({ path: 'platforms.linux-x64.sha256', code: 'sha256_invalid' });
    expect(issues({ ...base, name: 'git' })).toContainEqual({ path: 'name', code: 'reserved_name' });
    expect(
      issues({ ...base, platforms: { 'linux-x64': { ...base.platforms['linux-x64'], entry: '../x' } } }),
    ).toContainEqual({ path: 'platforms.linux-x64.entry', code: 'path_invalid' });
    expect(
      issues({ ...base, platforms: { 'linux-x64': { kind: 'package', manager: 'winget', package: 'jq' } } }),
    ).toEqual(
      expect.arrayContaining([
        { path: 'platforms.linux-x64.manager', code: 'manager_not_for_os' },
        { path: 'check.binary', code: 'binary_required' },
      ]),
    );
  });

  it('refuses secret-looking text', () => {
    expect(
      issues({ ...base, description: 'token ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }),
    ).toContainEqual({
      path: 'title',
      code: 'secret_detected',
    });
  });
});

describe('isoWeek', () => {
  it('numbers weeks per ISO 8601', () => {
    expect(isoWeek(new Date('2026-10-19T08:00:00Z'))).toBe('2026-W43');
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-03T00:00:00Z'))).toBe('2026-W53');
  });
});
