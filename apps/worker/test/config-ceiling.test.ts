import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { nodeOps, pathHost, tempDir } from './helpers.js';

describe('local ceiling (ADR-0015)', () => {
  async function load(content: Record<string, unknown>) {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        masterUrl: 'wss://m.example.com/v1/worker',
        workspaceRoot: join(dir, 'work'),
        dataDir: join(dir, 'data'),
        ...content,
      }),
      { mode: 0o600 },
    );
    return loadConfig(nodeOps(), pathHost(), { explicitPath: path });
  }

  it('a minimal file has no ceiling and no pins', async () => {
    const c = await load({});
    expect(c.ceiling).toEqual({
      projects: null,
      repoHosts: null,
      allowedRuntimes: null,
      maxParallelJobs: null,
      sandboxProfiles: null,
    });
    expect(c.pins).toEqual({
      runtimeAuth: [],
      runtimeSettings: {},
      minFreeBytes: null,
      retainFailed: false,
      submodules: false,
      // p17-worker-managed: no panel-managed local setting is written in the file.
      settings: [],
    });
  });

  it('localCeiling is validated strictly', async () => {
    await expect(load({ localCeiling: { maxParalelJobs: 2 } })).rejects.toThrow(/maxParalelJobs/);
    await expect(load({ localCeiling: { repoHosts: ['GitHub.com'] } })).rejects.toThrow(/repoHosts/);
    const c = await load({
      localCeiling: {
        repoHosts: ['github.com', '*.example.com'],
        sandboxProfiles: ['container'],
        maxParallelJobs: 0,
      },
    });
    expect(c.ceiling).toMatchObject({
      repoHosts: ['github.com', '*.example.com'],
      sandboxProfiles: ['container'],
      maxParallelJobs: 0,
    });
  });

  it('legacy operational keys become the ceiling and pins (meaning migrated)', async () => {
    const c = await load({
      maxParallelJobs: 3,
      allowedRuntimes: ['codex', 'pi'],
      workspace: {
        projects: { alpha: ['https://github.com/acme/alpha.git'], beta: ['https://github.com/acme/beta'] },
        minFreeBytes: 1024,
        submodules: 'skip',
      },
      runtimeAuth: { codex: { mode: 'secret-ref', ref: 'secret:openai' } },
      runtimes: { pi: { model: 'anthropic/x' } },
      localCeiling: {
        projects: { alpha: ['https://github.com/acme/alpha'] },
        allowedRuntimes: ['codex'],
        maxParallelJobs: 2,
      },
    });
    // Both ceilings apply: the intersection (URL identity = canonical key, `.git` optional).
    expect(c.ceiling?.projects).toEqual({ alpha: ['https://github.com/acme/alpha'] });
    expect(c.ceiling?.allowedRuntimes).toEqual(['codex']);
    expect(c.ceiling?.maxParallelJobs).toBe(2);
    expect(c.pins).toEqual({
      runtimeAuth: ['codex'],
      runtimeSettings: { pi: ['model'] },
      minFreeBytes: 1024,
      retainFailed: false,
      submodules: true,
      settings: [],
    });
  });

  it('an explicit empty allowedRuntimes is not a ceiling; defaults are never mistaken for values', async () => {
    const c = await load({ allowedRuntimes: [], workspace: { projects: {} } });
    expect(c.ceiling?.allowedRuntimes).toBeNull();
    expect(c.ceiling?.projects).toBeNull();
    expect(c.ceiling?.maxParallelJobs).toBeNull();
  });
});
