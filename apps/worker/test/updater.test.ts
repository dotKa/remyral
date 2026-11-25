import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { sha256Hex } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { updateSettingsSchema } from '../src/config/schema.js';
import { dataLayout, installLayout } from '../src/update/layout.js';
import { type ServiceControl, Updater, UpdaterError } from '../src/update/helper/updater.js';
import { isWindows, nodeOps, tempDir } from './helpers.js';
import { releaseKey, type SignedRelease, signedRelease } from './release-fixtures.js';

const key = releaseKey();
const otherKey = releaseKey();

interface Env {
  updater: Updater;
  install: ReturnType<typeof installLayout>;
  data: ReturnType<typeof dataLayout>;
  restarts: number;
  /** What the "new daemon" does after a restart (write a health proof or not). */
  onRestart: (n: number) => Promise<void>;
  clock: { t: number };
  logs: string[];
}

async function env(
  settings: Record<string, unknown> = {},
  opts: { pid?: number | null; trusted?: string[] } = {},
): Promise<Env> {
  const root = await tempDir('rw-upd-');
  const install = installLayout(process.platform, join(root, 'opt'));
  const data = dataLayout(process.platform, join(root, 'data'));
  await mkdir(install.installDir, { recursive: true });
  await mkdir(data.dataDir, { recursive: true });
  const clock = { t: Date.parse('2026-10-13T12:00:00.000Z') };
  const logs: string[] = [];
  const e: Env = {
    updater: undefined as unknown as Updater,
    install,
    data,
    restarts: 0,
    onRestart: () => Promise.resolve(),
    clock,
    logs,
  };
  const service: ServiceControl = {
    restart: async () => {
      e.restarts += 1;
      await e.onRestart(e.restarts);
    },
    mainPid: () => Promise.resolve(opts.pid === undefined ? 4242 : opts.pid),
  };
  e.updater = new Updater({
    ops: nodeOps(),
    install,
    data,
    settings: updateSettingsSchema(process.platform).parse({ healthTimeoutSec: 30, ...settings }),
    trustedKeys: opts.trusted ?? [key.publicKey],
    service,
    logger: createLogger({ sink: (l) => logs.push(l) }),
    nodeVersion: '24.11.0',
    now: () => new Date(clock.t),
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
    healthPollMs: 1000,
  });
  return e;
}

async function install(e: Env, r: SignedRelease): Promise<void> {
  await e.updater.adopt({
    manifest: r.manifest,
    signature: r.signature,
    artifact: r.artifact,
    allowDowngrade: false,
  });
}

async function stage(e: Env, r: SignedRelease, rollback = false): Promise<string> {
  const dir = join(e.data.stagedDir, r.version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'remyral-worker.mjs'), r.artifact);
  await writeFile(join(dir, 'manifest.json'), r.manifest);
  await writeFile(join(dir, 'manifest.sig.json'), JSON.stringify(r.signature));
  const attemptId = randomUUID();
  await mkdir(e.data.updatesDir, { recursive: true });
  await writeFile(
    e.data.requestFile,
    JSON.stringify({
      schema: 1,
      attemptId,
      version: r.version,
      rollback,
      requestedAt: new Date(e.clock.t).toISOString(),
    }),
  );
  return attemptId;
}

/** The restarted daemon proves health: session + heartbeat with its version, as the manager's pid. */
function healthy(e: Env, version: string, pid = 4242) {
  return writeFile(
    e.data.healthFile,
    JSON.stringify({
      schema: 1,
      version,
      pid,
      sessionEstablishedAt: new Date(e.clock.t).toISOString(),
      heartbeatAt: new Date(e.clock.t + 1).toISOString(),
    }),
  );
}

const bundle = (e: Env) => readFile(e.install.bundle);

describe('privileged updater: activation', () => {
  it('verifies, switches the active bundle atomically, restarts and keeps the version after a healthy start', async () => {
    const e = await env();
    const v1 = signedRelease(key, '1.0.0');
    const v2 = signedRelease(key, '1.1.0');
    await install(e, v1);
    expect(sha256Hex(await bundle(e))).toBe(sha256Hex(v1.artifact));
    const attemptId = await stage(e, v2);
    e.onRestart = () => healthy(e, '1.1.0');

    const out = await e.updater.apply();
    expect(out).toMatchObject({
      kind: 'done',
      result: { attemptId, outcome: 'succeeded', activeVersion: '1.1.0' },
    });
    expect(e.restarts).toBe(1);
    expect(await bundle(e)).toEqual(v2.artifact);
    // Verified copies retained for rollback; state and result are root-owned files in the install dir.
    expect(await readFile(join(e.install.versionsDir, '1.0.0', 'remyral-worker.mjs'))).toEqual(v1.artifact);
    expect(await readFile(join(e.install.versionsDir, '1.1.0', 'manifest.json'))).toEqual(v2.manifest);
    expect(JSON.parse(await readFile(e.install.activeFile, 'utf8'))).toMatchObject({ version: '1.1.0' });
    expect(JSON.parse(await readFile(e.install.resultFile, 'utf8'))).toMatchObject({
      attemptId,
      outcome: 'succeeded',
    });
    if (!isWindows) {
      const { stat } = await import('node:fs/promises');
      expect((await stat(e.install.bundle)).mode & 0o777).toBe(0o644);
    }
    // Each attempt is processed exactly once.
    expect(await e.updater.apply()).toEqual({ kind: 'idle' });
    expect(e.restarts).toBe(1);
  });

  it('rolls back automatically when the new version does not connect and heartbeat in time', async () => {
    const e = await env({ healthTimeoutSec: 20 });
    const v1 = signedRelease(key, '1.0.0');
    const v2 = signedRelease(key, '1.1.0', {}, Buffer.from('process.exit(1) // broken build\n'));
    await install(e, v1);
    await stage(e, v2);
    // New version never becomes healthy; the restored one does.
    e.onRestart = (n) => (n === 2 ? healthy(e, '1.0.0') : Promise.resolve());

    const out = await e.updater.apply();
    expect(out).toMatchObject({
      kind: 'done',
      result: { outcome: 'rolled_back', reason: 'health_check_failed', activeVersion: '1.0.0' },
    });
    expect(e.restarts).toBe(2);
    expect(await bundle(e)).toEqual(v1.artifact);
    expect(JSON.parse(await readFile(e.install.activeFile, 'utf8'))).toMatchObject({ version: '1.0.0' });
    if (out.kind === 'done') expect(out.result.detail).toMatch(/restored and healthy/);
  });

  it('does not accept a health proof from another process than the service manager’s main pid', async () => {
    const e = await env({ healthTimeoutSec: 15 });
    await install(e, signedRelease(key, '1.0.0'));
    await stage(e, signedRelease(key, '1.1.0'));
    e.onRestart = (n) => (n === 1 ? healthy(e, '1.1.0', 999) : healthy(e, '1.0.0'));
    const out = await e.updater.apply();
    expect(out).toMatchObject({ result: { outcome: 'rolled_back' } });
  });

  it('resumes an interrupted health check after a crash/reboot and rolls back if still unhealthy', async () => {
    const e = await env({ healthTimeoutSec: 15 });
    const v1 = signedRelease(key, '1.0.0');
    const v2 = signedRelease(key, '1.1.0');
    await install(e, v1);
    await install(e, v2); // v2 active, v1 retained — as right after the switch
    // The updater died during the health check (power loss): its state says so.
    await writeFile(
      e.install.stateFile,
      JSON.stringify({
        schema: 1,
        lastAttemptId: null,
        phase: 'health_check',
        target: { version: '1.1.0', sha256: sha256Hex(v2.artifact) },
        previous: { version: '1.0.0', sha256: sha256Hex(v1.artifact) },
        attemptId: randomUUID(),
        restartedAt: new Date(e.clock.t).toISOString(),
      }),
    );
    e.onRestart = () => healthy(e, '1.0.0');
    await expect(e.updater.apply()).resolves.toMatchObject({ result: { outcome: 'rolled_back' } });
    expect(await bundle(e)).toEqual(v1.artifact);
    const state = JSON.parse(await readFile(e.install.stateFile, 'utf8')) as { phase: string };
    expect(state.phase).toBe('idle');
  });
});

describe('privileged updater: re-verification of staged input (T-SUP-2)', () => {
  const cases: [string, (r: SignedRelease) => SignedRelease, string][] = [
    [
      'artifact swapped after the worker verified it',
      (r) => ({ ...r, artifact: Buffer.from(`${r.artifact.toString()}evil();\n`) }),
      'size_mismatch',
    ],
    [
      'artifact bytes altered (same size)',
      (r) => {
        const a = Buffer.from(r.artifact);
        a[a.length - 2] = 0x21;
        return { ...r, artifact: a };
      },
      'sha256_mismatch',
    ],
    [
      'manifest edited (e.g. hash of an evil build)',
      (r) => ({
        ...r,
        manifest: Buffer.from(
          r.manifest.toString().replace(/"sha256": "[a-f0-9]+"/, `"sha256": "${'0'.repeat(64)}"`),
        ),
      }),
      'bad_signature',
    ],
    ['signed with an untrusted key', () => signedRelease(otherKey, '1.1.0'), 'unknown_key'],
  ];
  it.each(cases)('refuses: %s', async (_name, tamper, reason) => {
    const e = await env();
    const v1 = signedRelease(key, '1.0.0');
    await install(e, v1);
    await stage(e, tamper(signedRelease(key, '1.1.0')));
    const out = await e.updater.apply();
    expect(out).toMatchObject({ result: { outcome: 'refused', reason, activeVersion: '1.0.0' } });
    expect(e.restarts).toBe(0);
    expect(await bundle(e)).toEqual(v1.artifact);
  });

  it('refuses a downgrade unless it is an explicit rollback, and never below the owner floor', async () => {
    const e = await env();
    const v1 = signedRelease(key, '1.0.0');
    const v2 = signedRelease(key, '1.1.0');
    await install(e, v1);
    await install(e, v2);
    await stage(e, v1);
    expect(await e.updater.apply()).toMatchObject({
      result: { outcome: 'refused', reason: 'downgrade_refused' },
    });

    await stage(e, v1, true);
    e.onRestart = () => healthy(e, '1.0.0');
    expect(await e.updater.apply()).toMatchObject({
      result: { outcome: 'succeeded', activeVersion: '1.0.0' },
    });
    expect(await bundle(e)).toEqual(v1.artifact);

    // Only the retained previous version: not any older signed release, not other bytes under its version.
    const v09 = signedRelease(key, '0.9.0');
    const other = await env();
    await install(other, v09);
    await install(other, v1);
    await install(other, v2);
    await stage(other, v09, true);
    expect(await other.updater.apply()).toMatchObject({
      result: { outcome: 'refused', reason: 'rollback_not_retained', activeVersion: '1.1.0' },
    });
    expect(await bundle(other)).toEqual(v2.artifact);
    await stage(
      other,
      signedRelease(key, '1.0.0', {}, Buffer.from('#!/usr/bin/env node\n// forged\n')),
      true,
    );
    expect(await other.updater.apply()).toMatchObject({
      result: { outcome: 'refused', reason: 'rollback_not_retained' },
    });
    expect(other.restarts).toBe(0);

    const floored = await env({ minVersion: '1.1.0' });
    await install(floored, v2);
    await stage(floored, v1, true);
    expect(await floored.updater.apply()).toMatchObject({
      result: { outcome: 'refused', reason: 'below_minimum_version' },
    });
  });

  it('refuses a canary-signed build on a stable machine and a build for a newer Node', async () => {
    const e = await env();
    await install(e, signedRelease(key, '1.0.0'));
    await stage(e, signedRelease(key, '1.1.0', { channel: 'canary' }));
    expect(await e.updater.apply()).toMatchObject({ result: { reason: 'channel_not_allowed' } });
    await stage(e, signedRelease(key, '1.2.0', { minNode: '26.0.0' }));
    expect(await e.updater.apply()).toMatchObject({ result: { reason: 'node_too_old' } });
  });

  it.skipIf(isWindows)('never follows a symlink planted in the worker-writable staging dir', async () => {
    const e = await env();
    await install(e, signedRelease(key, '1.0.0'));
    const v2 = signedRelease(key, '1.1.0');
    await stage(e, v2);
    const target = join(e.data.dataDir, 'elsewhere.mjs');
    await writeFile(target, v2.artifact);
    const staged = join(e.data.stagedDir, '1.1.0', 'remyral-worker.mjs');
    const { rm } = await import('node:fs/promises');
    await rm(staged);
    await symlink(target, staged);
    expect(await e.updater.apply()).toMatchObject({
      result: { outcome: 'refused', reason: 'unsafe_staged_file' },
    });
  });

  it('ignores a malformed request and a request without staged files', async () => {
    const e = await env();
    await install(e, signedRelease(key, '1.0.0'));
    await mkdir(e.data.updatesDir, { recursive: true });
    await writeFile(e.data.requestFile, '{"schema":1,"version":"../../etc"}');
    expect(await e.updater.apply()).toEqual({ kind: 'idle' });
    await writeFile(
      e.data.requestFile,
      JSON.stringify({
        schema: 1,
        attemptId: randomUUID(),
        version: '1.5.0',
        rollback: false,
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(await e.updater.apply()).toMatchObject({ result: { outcome: 'refused', reason: 'not_staged' } });
  });
});

describe('privileged updater: installer and owner commands', () => {
  it('adopt refuses an unsigned or downgraded bundle and is idempotent', async () => {
    const e = await env();
    const v2 = signedRelease(key, '1.1.0');
    await install(e, v2);
    await expect(
      e.updater.adopt({
        manifest: v2.manifest,
        signature: v2.signature,
        artifact: v2.artifact,
        allowDowngrade: false,
      }),
    ).resolves.toEqual({ version: '1.1.0', changed: false });
    const v1 = signedRelease(key, '1.0.0');
    await expect(
      e.updater.adopt({
        manifest: v1.manifest,
        signature: v1.signature,
        artifact: v1.artifact,
        allowDowngrade: false,
      }),
    ).rejects.toMatchObject({ reason: 'downgrade_refused' });
    const forged = signedRelease(otherKey, '1.2.0');
    await expect(
      e.updater.adopt({
        manifest: forged.manifest,
        signature: forged.signature,
        artifact: forged.artifact,
        allowDowngrade: false,
      }),
    ).rejects.toBeInstanceOf(UpdaterError);
  });

  it('rollback switches to the retained previous version', async () => {
    const e = await env();
    const v1 = signedRelease(key, '1.0.0');
    await install(e, v1);
    await stage(e, signedRelease(key, '1.1.0'));
    e.onRestart = () => healthy(e, '1.1.0');
    await e.updater.apply();
    e.onRestart = () => healthy(e, '1.0.0');
    const result = await e.updater.rollback();
    expect(result).toMatchObject({ outcome: 'succeeded', reason: 'manual_rollback', activeVersion: '1.0.0' });
    expect(await bundle(e)).toEqual(v1.artifact);
    const st = await e.updater.status();
    expect(st.active?.version).toBe('1.0.0');
    expect(st.retained.sort()).toEqual(['1.0.0', '1.1.0']);
  });

  it('keeps an unsigned development install addressable for rollback by its hash', async () => {
    const e = await env();
    await writeFile(e.install.bundle, 'console.log("dev build")\n');
    await stage(e, signedRelease(key, '1.0.0'));
    e.onRestart = (n) => (n === 1 ? Promise.resolve() : healthy(e, '0.1.0'));
    expect(await e.updater.apply()).toMatchObject({ result: { outcome: 'rolled_back' } });
    expect((await bundle(e)).toString()).toBe('console.log("dev build")\n');
  });

  it('serialises runs with a lock', async () => {
    const e = await env();
    await mkdir(e.install.stateDir, { recursive: true });
    await writeFile(e.install.lockFile, `${String(process.pid)} ${new Date(e.clock.t).toISOString()}\n`);
    await expect(e.updater.apply()).rejects.toMatchObject({ reason: 'locked' });
    // A stale lock (dead pid) is taken over.
    await writeFile(e.install.lockFile, `999999 ${new Date(e.clock.t).toISOString()}\n`);
    await expect(e.updater.apply()).resolves.toEqual({ kind: 'idle' });
  });
});
