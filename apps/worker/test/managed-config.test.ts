import { generateKeyPairSync } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  signWorkerConfig,
  type WorkerConfigDelivery,
  type WorkerConfigDocument,
  workerConfigHash,
} from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { deriveCeiling } from '../src/config/ceiling.js';
import { hygieneSettings } from '../src/disk/index.js';
import { type WorkerConfig, workerConfigSchema } from '../src/config/schema.js';
import { defaultProfileFor } from '../src/jobs/runtime-gate.js';
import { effectiveConfig, ManagedConfig, WORKER_CONFIG_FILE } from '../src/managed-config/index.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';

const WORKER = 'wrk_1';
const logger = createLogger({ level: 'silent', sink: () => undefined });

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  const key: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
  return { privateKey, key };
}
const master = keyPair();

/** A config as loadConfig would build it from `raw` (ceiling/pins derived from the written keys). */
function configFrom(raw: Record<string, unknown>, dataDir = '/var/lib/rw'): WorkerConfig {
  const parsed = workerConfigSchema('linux').parse({
    masterUrl: 'wss://m.example.com/v1/worker',
    workspaceRoot: '/srv/work',
    ...raw,
  });
  const { dataDir: _d, $schema: _s, ...rest } = parsed;
  const base = { ...rest, dataDir, source: '/etc/remyral-worker/config.json' };
  return { ...base, ...deriveCeiling(raw, base) };
}

const DOC: WorkerConfigDocument = {
  schemaVersion: 1,
  projects: {
    alpha: { repositories: ['https://github.com/acme/alpha.git'] },
    beta: { repositories: ['https://gitlab.example.com/acme/beta'] },
  },
  allowedRuntimes: ['codex', 'opencode', 'pi'],
  maxParallelJobs: 4,
  sandboxProfiles: ['container', 'runtime-sandbox'],
  workspace: { retainFailed: 2, minFreeBytes: 1024, submodules: 'allowlisted' },
  labels: { site: 'home' },
  runtimes: {
    codex: {
      auth: {
        mode: 'secret-ref',
        credentialRef: { source: 'worker-store', name: 'openai', env: 'OPENAI_API_KEY' },
      },
      modelProfile: 'fast',
    },
    pi: { model: 'anthropic/claude-x', provider: 'anthropic' },
    opencode: { model: 'anthropic/claude-x', options: { provider: { x: { apiKey: '{env:X_KEY}' } } } },
  },
};

function delivery(
  generation: number,
  doc: WorkerConfigDocument = DOC,
  opts: { sign?: boolean; workerId?: string; hash?: string } = {},
): WorkerConfigDelivery {
  const documentHash = opts.hash ?? workerConfigHash(doc);
  const issuedAt = '2026-10-14T10:00:00.000Z';
  const base = { generation, documentHash, issuedAt, document: doc };
  if (opts.sign === false) return base;
  return {
    ...base,
    signature: signWorkerConfig(
      { workerId: opts.workerId ?? WORKER, generation, documentHash, issuedAt },
      master.key.kid,
      master.privateKey,
    ),
  };
}

async function open(config: WorkerConfig, keys: readonly LeaseKey[] = [master.key], pinned = false) {
  return (await ManagedConfig.open(nodeOps(), config, () => ({ keys, pinned }), logger)).managed;
}

describe('vault references and model settings (p5-credentials-models)', () => {
  const VDOC: WorkerConfigDocument = {
    ...DOC,
    allowedRuntimes: ['claude-code', 'codex', 'pi', 'opencode'],
    runtimes: {
      'claude-code': {
        auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'anthropic' } },
        model: 'claude-sonnet-4-5',
      },
      codex: { auth: { mode: 'local-login' }, model: 'gpt-5-codex' },
      pi: {
        auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'openrouter' } },
        provider: 'openrouter',
        model: 'anthropic/claude-x',
      },
      opencode: {
        auth: { mode: 'secret-ref', credentialRef: { source: 'vault', id: 'openrouter', env: 'OR_KEY' } },
        model: 'openrouter/anthropic/claude-x',
      },
    },
  };
  const vault = {
    held: (id: string) => id === 'openrouter',
    env: (id: string) => (id === 'openrouter' ? 'OPENROUTER_API_KEY' : undefined),
  };

  it('maps vault refs to vault-<id> secrets with the runtime default or the credential env var', () => {
    const { config: e, blocked } = effectiveConfig(configFrom({}), delivery(1, VDOC), vault);
    expect(blocked).toEqual([]);
    // Claude Code has a default auth env (ANTHROPIC_API_KEY): none is set on the ref.
    expect(e.runtimeAuth['claude-code']).toEqual({ mode: 'secret-ref', ref: 'secret:vault-anthropic' });
    // Pi has no default auth env: the credential's own target variable is used.
    expect(e.runtimeAuth.pi).toEqual({
      mode: 'secret-ref',
      ref: 'secret:vault-openrouter',
      env: 'OPENROUTER_API_KEY',
    });
    // An env var named on the reference wins over the credential's variable.
    expect(e.runtimeAuth.opencode).toEqual({
      mode: 'secret-ref',
      ref: 'secret:vault-openrouter',
      env: 'OR_KEY',
    });
    expect(e.runtimeSettings['claude-code']).toMatchObject({ model: 'claude-sonnet-4-5' });
    expect(e.runtimeSettings.codex).toMatchObject({ model: 'gpt-5-codex' });
  });

  it('applies a vault-referencing document and reports what each runtime runs with (no values)', async () => {
    const m = await open(configFrom({}, await tempDir()));
    m.setVault(vault);
    const r = await m.apply(WORKER, delivery(1, VDOC));
    expect(r.status.outcome).toBe('applied');
    const runtimes = r.status.report.effective.runtimes;
    expect(runtimes?.['claude-code']).toEqual({
      auth: {
        mode: 'secret-ref',
        source: 'vault',
        credential: 'anthropic',
        present: false,
        env: 'ANTHROPIC_API_KEY',
      },
      model: 'claude-sonnet-4-5',
    });
    expect(runtimes?.opencode).toEqual({
      auth: {
        mode: 'secret-ref',
        source: 'vault',
        credential: 'openrouter',
        present: true,
        env: 'OR_KEY',
      },
      model: 'openrouter/anthropic/claude-x',
    });
    expect(runtimes?.codex).toEqual({ auth: { mode: 'local-login' }, model: 'gpt-5-codex' });
  });

  it('recomputes when the vault changes (a credential env var arrives later)', async () => {
    const m = await open(configFrom({}, await tempDir()));
    await m.apply(WORKER, delivery(1, VDOC));
    expect(m.effective.runtimeAuth.pi).toEqual({ mode: 'secret-ref', ref: 'secret:vault-openrouter' });
    const seen: unknown[] = [];
    m.subscribe((e) => seen.push(e.runtimeAuth.pi));
    expect(m.setVault(vault)).toBe(true);
    expect(seen).toEqual([{ mode: 'secret-ref', ref: 'secret:vault-openrouter', env: 'OPENROUTER_API_KEY' }]);
    expect(m.refresh()).toBe(false);
  });
});

describe('effective configuration (panel ∩ local ceiling)', () => {
  it('without a panel document, the local file applies exactly as before (source: local)', () => {
    const config = configFrom({
      maxParallelJobs: 2,
      allowedRuntimes: ['codex'],
      workspace: { projects: { alpha: ['https://github.com/acme/alpha'] } },
    });
    const { config: e, blocked } = effectiveConfig(config, null);
    expect(e.projects).toEqual({ alpha: ['https://github.com/acme/alpha'] });
    expect(e.allowedRuntimes).toEqual(['codex']);
    expect(e.maxParallelJobs).toBe(2);
    expect(e.sandboxProfiles).toEqual(['container', 'runtime-sandbox', 'host-restricted']);
    expect(blocked).toEqual([]);
  });

  it('without a ceiling the panel document is in effect; credential refs map to secret refs', () => {
    const { config: e, blocked } = effectiveConfig(configFrom({}), delivery(1));
    expect(blocked).toEqual([]);
    expect(e.projects).toEqual({
      alpha: ['https://github.com/acme/alpha.git'],
      beta: ['https://gitlab.example.com/acme/beta'],
    });
    expect(e.maxParallelJobs).toBe(4);
    expect(e.runtimeAuth.codex).toEqual({ mode: 'secret-ref', ref: 'secret:openai', env: 'OPENAI_API_KEY' });
    expect(e.modelProfiles).toEqual({ codex: 'fast' });
    expect(e.runtimeSettings.pi).toMatchObject({ model: 'anthropic/claude-x', provider: 'anthropic' });
    expect(e.runtimeSettings.opencode).toMatchObject({
      model: 'anthropic/claude-x',
      config: { provider: { x: { apiKey: '{env:X_KEY}' } } },
    });
    expect(e.workspace).toEqual({
      retainFailed: 2,
      minFreeBytes: 1024,
      submodules: 'allowlisted',
      packageCacheMaxBytes: 10 * 1024 ** 3,
    });
    expect(e.labels).toEqual({ site: 'home' });
  });

  it('p6-warm-caches: the panel limit of the package caches wins over the local file; absent → local value', () => {
    const local = configFrom({ packageCaches: { maxBytes: 5 * 1024 ** 3 } });
    expect(effectiveConfig(local, delivery(1)).config.workspace.packageCacheMaxBytes).toBe(5 * 1024 ** 3);
    const withLimit = delivery(1, { ...DOC, workspace: { ...DOC.workspace, packageCacheMaxBytes: 0 } });
    expect(effectiveConfig(local, withLimit).config.workspace.packageCacheMaxBytes).toBe(0);
    expect(effectiveConfig(local, null).config.workspace.packageCacheMaxBytes).toBe(5 * 1024 ** 3);
  });

  it('p17-disk-selfclean: the panel disk hygiene settings reach the effective config; absent → on by default', () => {
    const local = configFrom({});
    expect(effectiveConfig(local, delivery(1)).config.workspace.diskHygiene).toBeUndefined();
    const off = delivery(1, {
      ...DOC,
      workspace: { ...DOC.workspace, diskHygiene: { enabled: false, marginBytes: 3 * 1024 ** 3 } },
    });
    const e = effectiveConfig(local, off).config.workspace;
    expect(e.diskHygiene).toEqual({ enabled: false, marginBytes: 3 * 1024 ** 3 });
    expect(hygieneSettings(e.minFreeBytes, e.diskHygiene)).toMatchObject({
      enabled: false,
      marginBytes: 3 * 1024 ** 3,
    });
    expect(hygieneSettings(1024, undefined)).toEqual({
      enabled: true,
      thresholdBytes: 1024,
      marginBytes: 1024 ** 3,
    });
  });

  it('the local ceiling wins and every removal is reported with a reason', () => {
    const config = configFrom({
      runtimeAuth: { codex: { mode: 'local-login' } },
      runtimes: { pi: { binary: '/opt/pi/bin/pi', model: 'local/model' } },
      workspace: { minFreeBytes: 4096, submodules: 'skip' },
      localCeiling: {
        repoHosts: ['github.com'],
        allowedRuntimes: ['codex', 'pi'],
        maxParallelJobs: 1,
        sandboxProfiles: ['container'],
      },
    });
    const { config: e, blocked } = effectiveConfig(config, delivery(1));
    expect(Object.keys(e.projects)).toEqual(['alpha']);
    expect(e.allowedRuntimes).toEqual(['codex', 'pi']);
    expect(e.maxParallelJobs).toBe(1);
    expect(e.sandboxProfiles).toEqual(['container']);
    // Locally pinned auth and settings win; the local binary is always the local one.
    expect(e.runtimeAuth.codex).toEqual({ mode: 'local-login' });
    expect(e.runtimeSettings.pi).toMatchObject({
      binary: '/opt/pi/bin/pi',
      model: 'local/model',
      provider: 'anthropic',
    });
    expect(e.workspace).toEqual({
      retainFailed: 2,
      minFreeBytes: 4096,
      submodules: 'skip',
      packageCacheMaxBytes: 10 * 1024 ** 3,
    });
    const paths = blocked.map((b) => `${b.path}:${b.code}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'projects.beta.repositories.0:blocked_by_local_ceiling',
        'projects.beta:blocked_by_local_ceiling',
        'allowedRuntimes.opencode:blocked_by_local_ceiling',
        'maxParallelJobs:blocked_by_local_ceiling',
        'sandboxProfiles.runtime-sandbox:blocked_by_local_ceiling',
        'runtimes.codex.auth:blocked_by_local_ceiling',
        'runtimes.pi.model:blocked_by_local_ceiling',
        'workspace.minFreeBytes:blocked_by_local_ceiling',
        'workspace.submodules:blocked_by_local_ceiling',
      ]),
    );
    expect(blocked.every((b) => (b.detail ?? '').length > 0)).toBe(true);
  });

  it('a legacy workspace.projects is the project ceiling (repositories compared by canonical key)', () => {
    const config = configFrom({ workspace: { projects: { alpha: ['https://github.com/acme/alpha'] } } });
    const { config: e, blocked } = effectiveConfig(config, delivery(1));
    expect(e.projects).toEqual({ alpha: ['https://github.com/acme/alpha.git'] });
    expect(blocked.map((b) => b.path)).toEqual(['projects.beta']);
  });

  it('values the worker refuses are blocked as invalid, never applied', () => {
    const doc: WorkerConfigDocument = {
      ...DOC,
      projects: {
        'bad:id': { repositories: ['https://github.com/acme/x'] },
        gamma: { repositories: ['https://github.com/acme/%2e%2e/x'] },
      },
    };
    const { config: e, blocked } = effectiveConfig(configFrom({}), delivery(1, doc));
    expect(e.projects).toEqual({});
    expect(blocked.map((b) => `${b.path}:${b.code}`)).toEqual(
      expect.arrayContaining([
        'projects.bad:id:invalid_value',
        'projects.gamma.repositories.0:invalid_value',
      ]),
    );
  });
});

describe('panel default model profile (runtime gate)', () => {
  it('is used only when the policy allows it for the project', () => {
    const policy = {
      name: 'default',
      version: 1,
      stage: 'active' as const,
      documentHash: 'a'.repeat(64),
      document: {
        runtimes: {
          codex: {
            version: '1.0.0',
            authModes: ['secret-ref' as const],
            allowUnpinned: false,
            modelProfiles: [
              { name: 'fast', provider: 'openai', model: 'm1', params: {} },
              { name: 'deep', provider: 'openai', model: 'm2', params: {} },
            ],
            defaultProfile: 'fast',
          },
        },
        projectProfiles: { alpha: { codex: ['fast'] } },
      },
    };
    expect(defaultProfileFor(policy, 'codex', 'beta', 'deep')).toBe('deep');
    expect(defaultProfileFor(policy, 'codex', 'alpha', 'deep')).toBeNull();
    expect(defaultProfileFor(policy, 'codex', 'alpha', undefined)).toBeNull();
    expect(defaultProfileFor(null, 'codex', 'alpha', 'deep')).toBeNull();
  });
});

describe('ManagedConfig apply', () => {
  it('applies a signed document, persists it 0600, reports it and survives a restart', async () => {
    const dataDir = await tempDir();
    const config = configFrom({}, dataDir);
    const m = await open(config);
    const seen: number[] = [];
    m.subscribe((e) => seen.push(e.maxParallelJobs));
    expect(m.report()).toMatchObject({ source: 'local', generation: 0 });
    const r = await m.apply(WORKER, delivery(1));
    expect(r.changed).toBe(true);
    expect(r.status).toMatchObject({ generation: 1, outcome: 'applied' });
    expect(r.status.report).toMatchObject({
      source: 'panel',
      generation: 1,
      documentHash: workerConfigHash(DOC),
      effective: { projects: ['alpha', 'beta'], maxParallelJobs: 4, runtimeAuth: { codex: 'secret-ref' } },
      blocked: [],
    });
    expect(seen).toEqual([4]);
    const file = join(dataDir, WORKER_CONFIG_FILE);
    if (!isWindows) expect((await stat(file)).mode & 0o777).toBe(0o600);
    const reopened = await open(config);
    expect(reopened.effective.maxParallelJobs).toBe(4);
    expect(reopened.report()).toMatchObject({ source: 'panel', generation: 1 });
  });

  it('stale, unchanged and conflicting generations', async () => {
    const m = await open(configFrom({}, await tempDir()));
    await m.apply(WORKER, delivery(2));
    expect((await m.apply(WORKER, delivery(1))).status.outcome).toBe('stale');
    const same = await m.apply(WORKER, delivery(2));
    expect(same.status.outcome).toBe('unchanged');
    expect(same.changed).toBe(false);
    const conflict = await m.apply(WORKER, delivery(2, { ...DOC, maxParallelJobs: 1 }));
    expect(conflict.status.outcome).toBe('rejected');
    expect(conflict.status.report.generation).toBe(2);
  });

  it('rejects with a reason the panel shows and keeps the previous document', async () => {
    const dataDir = await tempDir();
    const m = await open(configFrom({}, dataDir));
    await m.apply(WORKER, delivery(1));
    const cases: [WorkerConfigDelivery, string][] = [
      [delivery(2, DOC, { hash: 'f'.repeat(64) }), 'hash_mismatch'],
      [delivery(3, { ...DOC, allowedRuntimes: ['codex', 'codex'] }), 'invalid_document'],
      [delivery(5, DOC, { sign: false }), 'unsigned'],
      [delivery(6, DOC, { workerId: 'wrk_other' }), 'bad_signature'],
    ];
    for (const [d, reason] of cases) {
      const r = await m.apply(WORKER, d);
      expect(r.status.outcome, reason).toBe('rejected');
      expect(r.changed).toBe(false);
      expect(r.status.report.rejected, reason).toMatchObject({ generation: d.generation, reason });
      expect(r.status.report.generation).toBe(1);
    }
    const invalid = await m.apply(
      WORKER,
      delivery(7, { ...DOC, sandboxProfiles: ['container', 'container'] }),
    );
    expect(invalid.status.report.rejected?.issues).toContainEqual({
      path: 'sandboxProfiles',
      code: 'duplicate',
    });
    expect(m.effective.maxParallelJobs).toBe(4);
    // The rejection survives a restart; a newer applied document clears it.
    const reopened = await open(configFrom({}, dataDir));
    expect(reopened.report().rejected?.generation).toBe(7);
    await reopened.apply(WORKER, delivery(8));
    expect(reopened.report().rejected).toBeUndefined();
  });

  it('pinned master keys: an unsigned or foreign-signed document is refused', async () => {
    const other = keyPair();
    const m = await open(configFrom({}, await tempDir()), [other.key], true);
    expect((await m.apply(WORKER, delivery(1, DOC, { sign: false }))).status.report.rejected?.reason).toBe(
      'unsigned',
    );
    expect((await m.apply(WORKER, delivery(2))).status.report.rejected?.reason).toBe('bad_signature');
  });

  it('without any master key (master has no lease signer) an unsigned document is accepted', async () => {
    const m = await open(configFrom({}, await tempDir()), [], false);
    expect((await m.apply(WORKER, delivery(1, DOC, { sign: false }))).status.outcome).toBe('applied');
  });

  it('a corrupt or tampered file falls back to the local file', async () => {
    const dataDir = await tempDir();
    const m = await open(configFrom({}, dataDir));
    await m.apply(WORKER, delivery(1));
    const file = join(dataDir, WORKER_CONFIG_FILE);
    const tampered = (await readFile(file, 'utf8')).replace('"maxParallelJobs": 4', '"maxParallelJobs": 9');
    await writeFile(file, tampered);
    const r1 = await ManagedConfig.open(
      nodeOps(),
      configFrom({}, dataDir),
      () => ({ keys: [], pinned: false }),
      logger,
    );
    expect(r1.corrupt).toBe(true);
    expect(r1.managed.report().source).toBe('local');
    await writeFile(file, '{ not json');
    const r2 = await ManagedConfig.open(
      nodeOps(),
      configFrom({}, dataDir),
      () => ({ keys: [], pinned: false }),
      logger,
    );
    expect(r2.corrupt).toBe(true);
    expect(r2.managed.effective.maxParallelJobs).toBe(1);
  });
});

describe('machine administration and panel skills keys (p5-machine-admin, ADR-0021)', () => {
  const panel = keyPair().key.publicKey;
  const MDOC: WorkerConfigDocument = {
    ...DOC,
    machineAdmin: { enabled: true, autoApprove: true },
    panelSkillKeys: [panel],
  };

  it('the panel enables machine admin and adds its skills key; the report carries both', async () => {
    const m = await open(configFrom({}, await tempDir()));
    const r = await m.apply(WORKER, delivery(1, MDOC));
    expect(r.status.outcome).toBe('applied');
    expect(m.effective.machineAdmin).toEqual({ enabled: true, autoApprove: true, forbiddenLocally: false });
    expect(m.effective.panelSkillKeys).toEqual([panel]);
    const rep = m.report();
    expect(rep.effective.machineAdmin).toEqual({ enabled: true, autoApprove: true });
    expect(rep.effective.panelSkillKeyIds).toHaveLength(1);
  });

  it('the local veto wins over the panel for both', () => {
    const vetoed = configFrom({ localCeiling: { allowMachineAdmin: false, allowPanelSkills: false } });
    const { config: e, blocked } = effectiveConfig(vetoed, delivery(1, MDOC));
    expect(e.machineAdmin).toEqual({ enabled: false, autoApprove: false, forbiddenLocally: true });
    expect(e.panelSkillKeys).toEqual([]);
    expect(blocked.map((b) => b.path)).toEqual(expect.arrayContaining(['machineAdmin', 'panelSkillKeys']));
  });

  it('p14-mcp-core: panel MCP keys follow the panel-skills veto unless allowPanelMcp says otherwise; vetoes are reported', () => {
    expect(effectiveConfig(configFrom({}), delivery(1, MDOC)).config.panelMcpKeys).toEqual([panel]);
    const skillsVeto = configFrom({ localCeiling: { allowPanelSkills: false } });
    expect(effectiveConfig(skillsVeto, delivery(1, MDOC)).config.panelMcpKeys).toEqual([]);
    const mcpAllowed = configFrom({ localCeiling: { allowPanelSkills: false, allowPanelMcp: true } });
    expect(effectiveConfig(mcpAllowed, delivery(1, MDOC)).config.panelMcpKeys).toEqual([panel]);
    const mcpVeto = configFrom({ localCeiling: { allowPanelMcp: false } });
    const { config } = effectiveConfig(mcpVeto, delivery(1, MDOC));
    expect(config.panelMcpKeys).toEqual([]);
    expect(config.panelSkillKeys).toEqual([panel]);
  });

  it('p14-mcp-core: allowMcp / allowMcpEgress vetoes are reported in the local ceiling', async () => {
    const m = await open(
      configFrom({ localCeiling: { allowMcp: false, allowMcpEgress: false } }, await tempDir()),
    );
    expect(m.report().ceiling).toMatchObject({ allowMcp: false, allowMcpEgress: false });
  });

  it('without a panel document nothing is enabled; an unsigned document never brings a skills key', async () => {
    expect(effectiveConfig(configFrom({}), null).config.machineAdmin).toBeUndefined();
    const m = await open(configFrom({}, await tempDir()), []);
    const r = await m.apply(WORKER, delivery(1, MDOC, { sign: false }));
    expect(r.status.outcome).toBe('rejected');
    expect(m.effective.panelSkillKeys ?? []).toEqual([]);
    // The same document without the key is accepted unsigned (dev master without lease keys, as before).
    const { panelSkillKeys: _k, ...withoutKeys } = MDOC;
    expect((await m.apply(WORKER, delivery(2, withoutKeys, { sign: false }))).status.outcome).toBe('applied');
  });
});
