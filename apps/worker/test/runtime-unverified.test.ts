import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProbeResult } from '@remyral/agent-adapters';
import { createLogger, Redactor } from '@remyral/observability';
import {
  type LeaseKey,
  leaseKeyId,
  type OpsCommandPayload,
  OpsOperation,
  OpsUpdatePayload,
  signOpsCommand,
  type UnverifiedRuntimeSource,
} from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { packLockfile } from '../src/mcp/lockfile.js';
import { RemoteOpsAgent, type RemoteOpsDeps } from '../src/remote-ops/agent.js';
import { LoginManager } from '../src/remote-ops/login.js';
import { InstallError } from '../src/remote-ops/fetch.js';
import { InstallRefusal, RuntimeInstaller } from '../src/remote-ops/installer.js';
import { hostPlatform, type InstallManifest, type NpmPackageSpec } from '../src/remote-ops/manifest.js';
import { runProcess } from '../src/remote-ops/process.js';
import { RuntimeVerifyRefusal, verifyRuntime } from '../src/remote-ops/verify-runtime.js';
import { checkRuntimeForJob, cliVersionOf } from '../src/runtime-policy/enforce.js';
import { captureLines, isWindows, nodeOps, tempDir } from './helpers.js';
import {
  codexFixture,
  codexManifest,
  fixtureServer,
  type Registry,
  sri512,
  tgz,
} from './remote-ops-fixtures.js';

/**
 * p16-runtime-updates (docs/design/p16-runtime-updates.md §2–§3): installs of a runtime version outside the release's
 * pinned set — the lock (received or resolved), the root integrity, every tarball's sha512 before extraction, the
 * runtime's own `--version`, the `unverified` record, rollback to the pin without a download — and the verification
 * checks in a scratch dir. Fixture registry on 127.0.0.1, no network.
 */

const host = hostPlatform();
const servers: Registry[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const PIN = '1.0.0';
const NEXT = '1.1.0';

/** npm lockfile v3 for a package list (what `npm install --package-lock-only` writes). */
function lockOf(packages: readonly NpmPackageSpec[], root = '@openai/codex', rootVersion = NEXT): Buffer {
  const out: Record<string, unknown> = {
    '': { name: 'remyral-runtime-codex', version: '0.1.0', dependencies: { [root]: rootVersion } },
  };
  for (const p of packages) {
    out[p.path] = {
      ...(p.path === `node_modules/${p.name}` ? {} : { name: p.name }),
      version: p.version,
      resolved: p.resolved,
      integrity: p.integrity,
      ...(p.optional === true ? { optional: true } : {}),
      ...(p.os === undefined ? {} : { os: p.os }),
      ...(p.cpu === undefined ? {} : { cpu: p.cpu }),
    };
  }
  return Buffer.from(
    JSON.stringify({
      name: 'remyral-runtime-codex',
      version: '0.1.0',
      lockfileVersion: 3,
      requires: true,
      packages: out,
    }),
  );
}

async function setup(opts: { mutate?: (lock: Record<string, unknown>) => void; next?: string } = {}) {
  const pinned = codexFixture(PIN, host);
  const next = codexFixture(opts.next ?? NEXT, host);
  const registry = await fixtureServer({ ...pinned.files, ...next.files });
  servers.push(registry);
  const manifest: InstallManifest = codexManifest({ [PIN]: pinned.packages }, PIN);
  let lockBytes = lockOf(next.packages, '@openai/codex', opts.next ?? NEXT);
  if (opts.mutate !== undefined) {
    const j = JSON.parse(lockBytes.toString('utf8')) as Record<string, unknown>;
    opts.mutate(j);
    lockBytes = Buffer.from(JSON.stringify(j));
  }
  let resolves = 0;
  const dataDir = await tempDir('unv-');
  const log = captureLines();
  const i = await RuntimeInstaller.open({
    ops: nodeOps(),
    dataDir,
    manifest,
    host,
    nodePath: process.execPath,
    source: { npmRegistry: registry.base },
    logger: createLogger({ sink: log.sink }),
    minFreeBytes: 1,
    run: runProcess,
    resolveNpm: async (dir) => {
      resolves += 1;
      await writeFile(join(dir, 'package-lock.json'), lockBytes);
    },
  });
  const root = next.packages[0];
  if (root === undefined) throw new Error('fixture');
  const source: UnverifiedRuntimeSource = {
    package: '@openai/codex',
    packageVersion: opts.next ?? NEXT,
    integrity: root.integrity,
  };
  return { i, dataDir, registry, source, lockBytes, resolves: () => resolves, pinned, next };
}

const progress = () => undefined;

describe.skipIf(isWindows)('unverified runtime installs (owner policy)', () => {
  it('installs a version outside the pinned set: lock resolved here, sha512 per tarball, --version checked, recorded unverified', async () => {
    const t = await setup();
    await t.i.install('codex', PIN, { progress });
    const r = await t.i.installUnverified('codex', NEXT, t.source, { progress });
    expect(r).toMatchObject({ action: 'upgrade', version: NEXT });
    expect(r.lock?.equals(t.lockBytes)).toBe(true);
    expect(t.resolves()).toBe(1);
    expect(t.i.activeVersion('codex')).toBe(NEXT);
    expect(t.i.unverifiedActive('codex')).toEqual({ version: NEXT, pin: PIN });
    const [report] = await t.i.report();
    expect(report?.installed.find((x) => x.version === NEXT)).toMatchObject({
      integrity: 'ok',
      unverified: { pin: PIN },
    });
    expect(report?.installed.find((x) => x.version === PIN)?.unverified).toBeUndefined();
    expect(report?.unverifiedSupported).toBe(true);
    // The foreign platform package was never fetched.
    expect(t.registry.requests.some((p) => p.includes('darwin-arm64') && host.os !== 'darwin')).toBe(false);
    const state = JSON.parse(await readFile(join(t.dataDir, 'runtimes', 'codex', 'state.json'), 'utf8')) as {
      installs: Record<string, { unverified?: unknown }>;
    };
    expect(state.installs[NEXT]?.unverified).toMatchObject({
      pin: PIN,
      package: '@openai/codex',
      packageVersion: NEXT,
    });
  });

  it('installs exactly a received lock (no resolve) and re-activates an intact install without work', async () => {
    const t = await setup();
    const lock = packLockfile('npm', t.lockBytes);
    const r = await t.i.installUnverified('codex', NEXT, { ...t.source, lock }, { progress });
    expect(r.lock).toBeUndefined();
    expect(r.lockSha256).toBe(lock.sha256);
    expect(t.resolves()).toBe(0);
    const before = t.registry.requests.length;
    const again = await t.i.installUnverified('codex', NEXT, { ...t.source, lock }, { progress });
    expect(again).toMatchObject({ action: 'reinstall', lockSha256: lock.sha256 });
    expect(t.registry.requests.length).toBe(before);
  });

  it('rolls back to the pin in one step: the intact pinned install is re-activated without a download', async () => {
    const t = await setup();
    await t.i.install('codex', PIN, { progress });
    await t.i.installUnverified('codex', NEXT, t.source, { progress });
    const before = t.registry.requests.length;
    const back = await t.i.install('codex', PIN, { progress });
    expect(back).toEqual({ action: 'downgrade', version: PIN });
    expect(t.registry.requests.length).toBe(before);
    expect(t.i.activeVersion('codex')).toBe(PIN);
    expect(t.i.unverifiedActive('codex')).toBeNull();
  });

  it('downloads the pin when it was never installed (rollback from an unverified first install)', async () => {
    const t = await setup();
    await t.i.installUnverified('codex', NEXT, t.source, { progress });
    await expect(t.i.install('codex', PIN, { progress })).resolves.toEqual({
      action: 'downgrade',
      version: PIN,
    });
    expect(t.i.activeVersion('codex')).toBe(PIN);
  });

  it('refuses before touching disk: another package, a pinned / older version, no process runner', async () => {
    const t = await setup();
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e,
      );
    const other = await refusal(
      t.i.installUnverified('codex', NEXT, { ...t.source, package: 'evil-codex' }, { progress }),
    );
    expect(other).toBeInstanceOf(InstallRefusal);
    expect((other as InstallRefusal).reason).toBe('package_mismatch');
    const pinned = await refusal(
      t.i.installUnverified('codex', PIN, { ...t.source, packageVersion: PIN }, { progress }),
    );
    expect((pinned as InstallRefusal).reason).toBe('version_pinned');
    const older = await refusal(
      t.i.installUnverified('codex', '0.9.0', { ...t.source, packageVersion: '0.9.0' }, { progress }),
    );
    expect((older as InstallRefusal).reason).toBe('version_not_newer');
    const wrongPkgVersion = await refusal(
      t.i.installUnverified('codex', NEXT, { ...t.source, packageVersion: '1.2.0' }, { progress }),
    );
    expect((wrongPkgVersion as InstallRefusal).reason).toBe('package_mismatch');
    expect(t.resolves()).toBe(0);
    const dataDir = await tempDir('unv-norun-');
    const noRun = await RuntimeInstaller.open({
      ops: nodeOps(),
      dataDir,
      manifest: codexManifest({ [PIN]: t.pinned.packages }, PIN),
      host,
      nodePath: process.execPath,
      logger: createLogger({ sink: captureLines().sink }),
      minFreeBytes: 1,
    });
    expect(noRun.unverifiedSupported('codex')).toBe(false);
    const e = await refusal(noRun.installUnverified('codex', NEXT, t.source, { progress }));
    expect((e as InstallRefusal).reason).toBe('unverified_install_unavailable');
  });

  it('refuses a lock whose root is not the registry integrity the master signed', async () => {
    const t = await setup();
    const forged = sri512(Buffer.from('another tarball'));
    const e = await t.i
      .installUnverified('codex', NEXT, { ...t.source, integrity: forged }, { progress })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(e).toBeInstanceOf(InstallError);
    expect((e as InstallError).reason).toBe('integrity_mismatch');
    expect(t.i.activeVersion('codex')).toBeNull();
    expect(existsSync(join(t.dataDir, 'runtimes', 'codex', NEXT))).toBe(false);
  });

  it('refuses a tampered tarball (sha512 checked before extraction) and leaves nothing behind', async () => {
    const t = await setup();
    const plat = `${host.os}-${host.arch}`;
    t.registry.set(`/@openai/codex/-/codex-${NEXT}-${plat}.tgz`, tgz([{ path: 'package/evil', data: 'x' }]));
    const e = await t.i.installUnverified('codex', NEXT, t.source, { progress }).then(
      () => null,
      (x: unknown) => x,
    );
    expect((e as InstallError).reason).toBe('integrity_mismatch');
    expect(t.i.activeVersion('codex')).toBeNull();
  });

  it('refuses a lock with a new install-script package and a non-registry tarball', async () => {
    const scripts = await setup({
      mutate: (j) => {
        const pk = j.packages as Record<string, Record<string, unknown>>;
        const root = pk['node_modules/@openai/codex'];
        if (root !== undefined) root.hasInstallScript = true;
      },
    });
    const e = await scripts.i.installUnverified('codex', NEXT, scripts.source, { progress }).then(
      () => null,
      (x: unknown) => x,
    );
    expect((e as InstallError).reason).toBe('install_scripts_required');
    const git = await setup({
      mutate: (j) => {
        const pk = j.packages as Record<string, Record<string, unknown>>;
        const root = pk['node_modules/@openai/codex'];
        if (root !== undefined) root.resolved = 'git+https://example.com/codex.git';
      },
    });
    const e2 = await git.i.installUnverified('codex', NEXT, git.source, { progress }).then(
      () => null,
      (x: unknown) => x,
    );
    expect((e2 as InstallError).reason).toBe('lock_invalid');
  });

  it('refuses an install whose binary reports another version (stage removed, nothing activated)', async () => {
    // The fixture binary of "1.1.0" prints 1.1.0; a lock for it requested as 1.2.0 fails the --version check.
    const t = await setup({ next: '1.2.0' });
    const plat = `${host.os}-${host.arch}`;
    const lying = codexFixture('1.3.0', host);
    // Serve the 1.3.0 native package under the 1.2.0 name and point the lock at its integrity.
    const native = lying.files[`/@openai/codex/-/codex-1.3.0-${plat}.tgz`];
    if (native === undefined) throw new Error('fixture');
    t.registry.set(`/@openai/codex/-/codex-1.2.0-${plat}.tgz`, native);
    const j = JSON.parse(t.lockBytes.toString('utf8')) as {
      packages: Record<string, Record<string, unknown>>;
    };
    const entry = j.packages[`node_modules/@openai/codex-${plat}`];
    if (entry !== undefined) entry.integrity = sri512(native);
    const lock = packLockfile('npm', Buffer.from(JSON.stringify(j)));
    const e = await t.i.installUnverified('codex', '1.2.0', { ...t.source, lock }, { progress }).then(
      () => null,
      (x: unknown) => x,
    );
    expect((e as InstallError).reason).toBe('version_mismatch');
    expect(t.i.activeVersion('codex')).toBeNull();
  });
});

describe.skipIf(isWindows)('runtime.verify (automatable checks in a scratch dir)', () => {
  const op = (source: UnverifiedRuntimeSource) =>
    OpsOperation.parse({ kind: 'runtime.verify', runtime: 'codex', version: NEXT, source }) as Extract<
      OpsOperation,
      { kind: 'runtime.verify' }
    >;
  const probe = (version: string): ProbeResult =>
    ({
      runtime: 'codex',
      installed: true,
      version,
      pinnedVersion: PIN,
      versionMatchesPin: false,
      authenticated: 'unknown',
      os: 'linux',
      arch: 'x64',
      capabilities: {
        key: { runtime: 'codex', version, os: 'linux', arch: 'x64' },
        capabilities: {
          streaming: { status: 'unverified', reason: 'differs from pin' },
          cancel: { status: 'unverified', reason: 'differs from pin' },
          approval: { status: 'unverified', reason: 'differs from pin' },
          cost_reporting: { status: 'unsupported', reason: 'tokens only' },
        },
      },
      notes: [],
    }) as unknown as ProbeResult;

  it('passes the required checks, reports skipped ones honestly, returns the lock it made and cleans up', async () => {
    const t = await setup();
    let probedFile = '';
    const report = await verifyRuntime(
      {
        installer: t.i,
        selfTest: () => Promise.resolve({ ok: true, detail: '`--help` exits 0 with output' }),
        probe: (_rt, launch) => {
          probedFile = launch.file;
          return Promise.resolve(probe(NEXT));
        },
      },
      op(t.source),
      { progress },
    );
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['integrity', 'passed'],
      ['version', 'passed'],
      ['help', 'passed'],
      ['adapter_probe', 'passed'],
      ['headless_prompt', 'skipped'],
      ['contract_suite', 'skipped'],
    ]);
    expect(report.checks.find((c) => c.id === 'headless_prompt')?.required).toBe(false);
    expect(report.lock).toBeDefined();
    expect(probedFile).toContain(join('runtime-verify', 'codex'));
    // Never the active version, and the scratch dir is gone.
    expect(t.i.activeVersion('codex')).toBeNull();
    expect(existsSync(join(t.dataDir, 'runtime-verify', 'codex'))).toBe(false);
  });

  it('checks the candidate version, not the pin: the self-test gets it and a `+sdk.` probe suffix is ignored (prod 2026-10-23)', async () => {
    const t = await setup();
    let expected = '';
    const report = await verifyRuntime(
      {
        installer: t.i,
        selfTest: (_rt, _launch, version) => {
          expected = version;
          return Promise.resolve({ ok: true, detail: '' });
        },
        // Claude Code's probe reads `<cli>+sdk.<sdk>`; the CLI part is what the candidate is.
        probe: () => Promise.resolve(probe(`${NEXT}+sdk.0.3.999`)),
      },
      op(t.source),
      { progress },
    );
    expect(expected).toBe(NEXT);
    expect(report.checks.find((c) => c.id === 'adapter_probe')?.status).toBe('passed');
  });

  it('fails (not passes) when the self-test or the adapter probe disagrees, and on a bad tarball', async () => {
    const t = await setup();
    const bad = await verifyRuntime(
      {
        installer: t.i,
        selfTest: () => Promise.resolve({ ok: false, detail: '`--help` exited 1' }),
        probe: () => Promise.resolve(probe('9.9.9')),
      },
      op(t.source),
      { progress },
    );
    expect(bad.passed).toBe(false);
    expect(bad.checks.find((c) => c.id === 'help')?.status).toBe('failed');
    expect(bad.checks.find((c) => c.id === 'adapter_probe')?.status).toBe('failed');
    const plat = `${host.os}-${host.arch}`;
    t.registry.set(`/@openai/codex/-/codex-${NEXT}-${plat}.tgz`, tgz([{ path: 'package/x', data: 'x' }]));
    const tampered = await verifyRuntime(
      {
        installer: t.i,
        selfTest: () => Promise.resolve({ ok: true, detail: '' }),
        probe: () => Promise.resolve(probe(NEXT)),
      },
      op(t.source),
      { progress },
    );
    expect(tampered.passed).toBe(false);
    expect(tampered.checks[0]).toMatchObject({ id: 'integrity', status: 'failed' });
  });

  it('refuses a source for another package before installing anything', async () => {
    const t = await setup();
    await expect(
      verifyRuntime(
        {
          installer: t.i,
          selfTest: () => Promise.resolve({ ok: true, detail: '' }),
          probe: () => Promise.resolve(probe(NEXT)),
        },
        op({ ...t.source, package: 'not-codex' }),
        { progress },
      ),
    ).rejects.toBeInstanceOf(RuntimeVerifyRefusal);
  });
});

describe('job admission of an owner-approved unverified install', () => {
  it('admits exactly the approved version despite the pin mismatch; any other mismatch is still refused', () => {
    const base = { policy: null, authMode: 'secret-ref' as const, project: 'p', runtime: 'codex' as const };
    expect(checkRuntimeForJob({ ...base, installedVersion: '0.165.0' })).toMatchObject({
      ok: false,
      code: 'runtime_pin_mismatch',
    });
    expect(
      checkRuntimeForJob({ ...base, installedVersion: '0.165.0', approvedUnverified: '0.165.0' }),
    ).toMatchObject({ ok: true, pinMatches: false });
    expect(
      checkRuntimeForJob({ ...base, installedVersion: '0.166.0', approvedUnverified: '0.165.0' }),
    ).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
  });

  it('p22-harness-gaps: Claude Code with a non-pinned agent SDK (`<cli>+sdk.<sdk>`) is admitted by its CLI version', () => {
    const base = {
      policy: null,
      authMode: 'secret-ref' as const,
      project: 'p',
      runtime: 'claude-code' as const,
    };
    expect(
      checkRuntimeForJob({ ...base, installedVersion: '2.1.40+sdk.0.3.9', approvedUnverified: '2.1.40' }),
    ).toMatchObject({ ok: true, pinMatches: false });
    expect(
      checkRuntimeForJob({ ...base, installedVersion: '2.1.41+sdk.0.3.9', approvedUnverified: '2.1.40' }),
    ).toMatchObject({ ok: false, code: 'runtime_pin_mismatch' });
    expect(cliVersionOf('2.1.40+sdk.0.3.9')).toBe('2.1.40');
    expect(cliVersionOf('0.165.0')).toBe('0.165.0');
  });
});

describe.skipIf(isWindows)('remote-ops agent: unverified install and runtime.verify on the wire', () => {
  async function harness(t: Awaited<ReturnType<typeof setup>>, verify?: RemoteOpsDeps['verifyRuntime']) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'jwk' }).x as string;
    const lease: LeaseKey = { kid: leaseKeyId(raw), publicKey: raw };
    const logger = createLogger({ sink: () => undefined });
    const sent: OpsUpdatePayload[] = [];
    const a = await RemoteOpsAgent.open({
      ops: nodeOps(),
      dataDir: t.dataDir,
      installer: t.i,
      login: new LoginManager({ binary: () => Promise.resolve(null), env: {}, run: runProcess, logger }),
      log: null,
      redactor: new Redactor(),
      logger,
      keySource: () => ({ keys: [lease], pinned: false }),
      disabled: [],
      service: { manager: 'systemd', restartable: true },
      restart: () => Promise.resolve('restarting' as const),
      restartRuntime: () => Promise.resolve({ ok: true }),
      runtimeInUse: () => false,
      diagnostics: () => Promise.reject(new Error('unused')),
      changed: () => undefined,
      ...(verify === undefined ? {} : { verifyRuntime: verify }),
    });
    a.attach((p) => {
      sent.push(OpsUpdatePayload.parse(p));
      return Promise.resolve();
    });
    const cmd = (op: OpsOperation, tamper?: (o: OpsOperation) => OpsOperation): OpsCommandPayload => {
      const now = new Date();
      const base = {
        commandId: randomUUID(),
        issuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        op,
      };
      const signature = signOpsCommand({ ...base, workerId: 'w-1' }, lease.kid, privateKey);
      return { ...base, op: tamper === undefined ? op : tamper(op), signature };
    };
    return { a, sent, cmd };
  }

  it('routes runtime.install with an unverified source to the unverified path and reports the lock it made', async () => {
    const t = await setup();
    const h = await harness(t);
    await h.a.onCommand(
      'w-1',
      h.cmd({ kind: 'runtime.install', runtime: 'codex', version: NEXT, unverified: t.source }),
    );
    const last = h.sent.at(-1);
    expect(last).toMatchObject({
      state: 'succeeded',
      runtimeInstall: { runtime: 'codex', version: NEXT, unverified: true },
    });
    expect(last?.runtimeInstall?.lock?.sha256).toBe(last?.runtimeInstall?.lockSha256);
    expect(last?.detail).toContain('(unverified)');
    expect(last?.runtime?.installed.find((x) => x.version === NEXT)?.unverified).toEqual({ pin: PIN });
    // Without the source a version outside the pinned set is refused as before.
    await h.a.onCommand('w-1', h.cmd({ kind: 'runtime.install', runtime: 'codex', version: '1.2.0' }));
    expect(h.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'version_not_pinned' });
  });

  it('the signature covers the unverified source (a swapped integrity is refused before anything runs)', async () => {
    const t = await setup();
    const h = await harness(t);
    await h.a.onCommand(
      'w-1',
      h.cmd({ kind: 'runtime.install', runtime: 'codex', version: NEXT, unverified: t.source }, (o) =>
        o.kind === 'runtime.install' && o.unverified !== undefined
          ? { ...o, unverified: { ...o.unverified, integrity: sri512(Buffer.from('x')) } }
          : o,
      ),
    );
    expect(h.sent).toEqual([expect.objectContaining({ state: 'refused', reason: 'bad_signature' })]);
    expect(t.resolves()).toBe(0);
  });

  it('runtime.verify answers runtimeVerify, and is refused where the worker cannot verify', async () => {
    const t = await setup();
    const h = await harness(t, (op, o) =>
      verifyRuntime(
        {
          installer: t.i,
          selfTest: () => Promise.resolve({ ok: true, detail: 'ok' }),
          probe: () => Promise.resolve(null),
        },
        op,
        o,
      ),
    );
    await h.a.onCommand(
      'w-1',
      h.cmd({ kind: 'runtime.verify', runtime: 'codex', version: NEXT, source: t.source }),
    );
    const last = h.sent.at(-1);
    expect(last?.state).toBe('succeeded');
    expect(last?.runtimeVerify?.passed).toBe(true);
    expect(last?.runtimeVerify?.checks.find((c) => c.id === 'adapter_probe')).toMatchObject({
      status: 'skipped',
      required: false,
    });
    const none = await harness(await setup());
    await none.a.onCommand(
      'w-1',
      none.cmd({ kind: 'runtime.verify', runtime: 'codex', version: NEXT, source: t.source }),
    );
    expect(none.sent.at(-1)).toMatchObject({ state: 'refused', reason: 'unsupported' });
  });
});
