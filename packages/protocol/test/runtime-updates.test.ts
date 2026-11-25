import { describe, expect, it } from 'vitest';
import {
  ManagedRuntimeReport,
  OpsOperation,
  opsOperationDigest,
  OpsUpdatePayload,
  RUNTIME_PINS,
  RUNTIME_UNVERIFIED_FEATURE,
  runtimePackageVersion,
  RuntimeCapabilities,
  UnverifiedRuntimeSource,
  WorkerFeature,
} from '../src/index.js';

/** p16-runtime-updates: the wire additions for unverified runtime installs and the verification op. */

const INTEGRITY = `sha512-${'A'.repeat(86)}==`;
const source = { package: '@openai/codex', packageVersion: '0.164.0', integrity: INTEGRITY };

describe('unverified runtime source', () => {
  it('names one exact package version with a sha512 integrity and nothing else', () => {
    expect(UnverifiedRuntimeSource.parse(source)).toEqual(source);
    expect(UnverifiedRuntimeSource.safeParse({ ...source, url: 'https://evil.example/x.tgz' }).success).toBe(
      false,
    );
    expect(UnverifiedRuntimeSource.safeParse({ ...source, packageVersion: 'latest' }).success).toBe(false);
    expect(UnverifiedRuntimeSource.safeParse({ ...source, packageVersion: '^0.164.0' }).success).toBe(false);
    expect(UnverifiedRuntimeSource.safeParse({ ...source, integrity: 'sha1-abc' }).success).toBe(false);
    expect(UnverifiedRuntimeSource.safeParse({ ...source, package: 'Not A Package' }).success).toBe(false);
  });

  it('runtime.install carries it (optional) and the operation digest covers it', () => {
    const pinned = OpsOperation.parse({ kind: 'runtime.install', runtime: 'codex', version: '0.162.1' });
    const unverified = OpsOperation.parse({
      kind: 'runtime.install',
      runtime: 'codex',
      version: '0.164.0',
      unverified: source,
    });
    expect(unverified).toMatchObject({ unverified: source });
    const swapped = OpsOperation.parse({
      kind: 'runtime.install',
      runtime: 'codex',
      version: '0.164.0',
      unverified: { ...source, integrity: `sha512-${'B'.repeat(86)}==` },
    });
    expect(opsOperationDigest(unverified)).not.toBe(opsOperationDigest(swapped));
    expect(opsOperationDigest(pinned)).not.toBe(opsOperationDigest(unverified));
  });

  it('runtime.verify requires the source; its report lists required and skipped checks', () => {
    expect(OpsOperation.safeParse({ kind: 'runtime.verify', runtime: 'pi', version: '1.4.0' }).success).toBe(
      false,
    );
    expect(
      OpsOperation.parse({
        kind: 'runtime.verify',
        runtime: 'pi',
        version: '1.4.0',
        source: { ...source, package: '@earendil-works/pi-coding-agent', packageVersion: '1.4.0' },
      }).kind,
    ).toBe('runtime.verify');
    const update = OpsUpdatePayload.parse({
      commandId: '00000000-0000-4000-8000-000000000001',
      seq: 2,
      kind: 'runtime.verify',
      state: 'succeeded',
      runtimeVerify: {
        runtime: 'pi',
        version: '1.4.0',
        passed: true,
        checks: [
          { id: 'integrity', status: 'passed', required: true },
          { id: 'headless_prompt', status: 'skipped', required: false, detail: 'needs a credential' },
        ],
      },
    });
    expect(update.runtimeVerify?.checks).toHaveLength(2);
    expect(
      OpsUpdatePayload.safeParse({
        ...update,
        runtimeVerify: {
          ...update.runtimeVerify,
          checks: [{ id: 'made_up', status: 'passed', required: true }],
        },
      }).success,
    ).toBe(false);
  });

  it('reports mark unverified installs and runtimes (additive fields)', () => {
    const r = ManagedRuntimeReport.parse({
      runtime: 'codex',
      method: 'npm',
      supported: true,
      pinned: '0.162.1',
      available: ['0.162.1'],
      installed: [
        {
          version: '0.164.0',
          installedAt: '2026-10-23T10:00:00.000Z',
          integrity: 'ok',
          unverified: { pin: '0.162.1' },
        },
      ],
      active: '0.164.0',
      unverifiedSupported: true,
    });
    expect(r.installed[0]?.unverified).toEqual({ pin: '0.162.1' });
    const cap = RuntimeCapabilities.parse({
      runtime: 'codex',
      version: '0.164.0',
      installed: true,
      authenticated: 'unknown',
      capabilities: {},
      pinnedVersion: '0.162.1',
      pinStatus: 'mismatch',
      unverifiedUpdate: true,
    });
    expect(cap.unverifiedUpdate).toBe(true);
    expect(WorkerFeature.options).toContain(RUNTIME_UNVERIFIED_FEATURE);
  });
});

describe('runtime package versions', () => {
  it('maps a runtime version to the version of the package that brings it', () => {
    expect(runtimePackageVersion('codex', '0.164.0')).toBe('0.164.0');
    expect(runtimePackageVersion('pi', '1.4.0')).toBe('1.4.0');
    // Claude Code: the agent SDK of the pinned SDK line with the CLI's patch (confirmed by the master).
    expect(RUNTIME_PINS['claude-code'].packageVersion).toBe('0.3.310');
    expect(runtimePackageVersion('claude-code', '2.1.309')).toBe('0.3.309');
    expect(runtimePackageVersion('claude-code', '2.2.0')).toBeNull();
    expect(runtimePackageVersion('claude-code', 'x')).toBeNull();
    for (const pin of Object.values(RUNTIME_PINS))
      expect(pin.install).toContain(`${pin.package}@${pin.packageVersion}`);
  });
});
