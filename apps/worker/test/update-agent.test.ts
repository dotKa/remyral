import type { FileOps } from '../src/fs/ops.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { describe, expect, it } from 'vitest';
import { updateSettingsSchema } from '../src/config/schema.js';
import {
  type UpdateHost,
  type UpdateOffer,
  UpdateAgent,
  type UpdateStatusPayload,
} from '../src/update/agent.js';
import { DownloadError, type Downloader } from '../src/update/download.js';
import { trustedReleaseKeys } from '../src/update/keys.js';
import { dataLayout, installLayout } from '../src/update/layout.js';
import { nodeOps, tempDir } from './helpers.js';
import { releaseKey, type SignedRelease, signedRelease } from './release-fixtures.js';

const key = releaseKey();
const other = releaseKey();

function offerFor(r: SignedRelease, over: Partial<UpdateOffer> = {}): UpdateOffer {
  const manifest = JSON.parse(r.manifest.toString()) as {
    sha256: string;
    size: number;
    channel: 'stable' | 'canary';
  };
  return {
    attemptId: randomUUID(),
    version: r.version,
    channel: manifest.channel,
    sha256: manifest.sha256,
    size: manifest.size,
    manifestUrl: `/v1/worker/releases/${r.version}/manifest`,
    artifactUrl: `/v1/worker/releases/${r.version}/artifact`,
    downloadToken: 'T'.repeat(43),
    tokenExpiresAt: '2026-10-13T12:15:00.000Z',
    rollback: false,
    force: false,
    ...over,
  };
}

/** A master that serves exactly one release (as the download endpoint would). */
function serving(r: SignedRelease, calls: string[] = []): Downloader {
  return (path, token, maxBytes) => {
    calls.push(path);
    if (token !== 'T'.repeat(43)) return Promise.reject(new DownloadError('http_status', 'HTTP 401', 401));
    const body = path.endsWith('/manifest')
      ? Buffer.from(JSON.stringify({ manifest: r.manifest.toString('base64'), signature: r.signature }))
      : r.artifact;
    if (body.byteLength > maxBytes) return Promise.reject(new DownloadError('too_large', 'too large'));
    return Promise.resolve(body);
  };
}

interface Setup {
  agent: UpdateAgent;
  sent: UpdateStatusPayload[];
  host: UpdateHost & { jobs: number; drains: string[]; started: number; failed: number };
  data: ReturnType<typeof dataLayout>;
  install: ReturnType<typeof installLayout>;
}

async function setup(
  download: Downloader,
  opts: {
    settings?: Record<string, unknown>;
    current?: string;
    node?: string;
    keys?: string[];
    activationTimeoutMs?: number;
    ops?: FileOps;
  } = {},
): Promise<Setup> {
  const root = await tempDir('rw-agent-');
  const data = dataLayout(process.platform, join(root, 'data'));
  const install = installLayout(process.platform, join(root, 'opt'));
  await mkdir(data.dataDir, { recursive: true });
  const sent: UpdateStatusPayload[] = [];
  const host = {
    jobs: 0,
    drains: [] as string[],
    started: 0,
    failed: 0,
    send: (p: UpdateStatusPayload) => {
      sent.push(p);
      return Promise.resolve();
    },
    runningJobs: () => host.jobs,
    beginLocalDrain: () => host.drains.push('begin'),
    endLocalDrain: () => host.drains.push('end'),
    updateStarted: () => {
      host.started += 1;
      return host.jobs === 0;
    },
    updateFailed: () => {
      host.failed += 1;
    },
  };
  const agent = new UpdateAgent({
    ops: opts.ops ?? nodeOps(),
    healthWriteRetryMs: 1,
    data,
    install,
    settings: updateSettingsSchema(process.platform).parse(opts.settings ?? {}),
    currentVersion: opts.current ?? '1.0.0',
    trustedKeys: opts.keys ?? [key.publicKey],
    download,
    logger: createLogger({ sink: () => undefined }),
    nodeVersion: opts.node ?? '24.11.0',
    idlePollMs: 5,
    activationTimeoutMs: opts.activationTimeoutMs ?? 60_000,
    pid: 4242,
  });
  agent.attach(host);
  agent.onSessionEstablished('1.0');
  return { agent, sent, host, data, install };
}

/** The privileged updater's state as after an activation from `r` (its `previous`). */
async function writePrevious(s: Setup, r: SignedRelease): Promise<void> {
  const sha256 = (JSON.parse(r.manifest.toString()) as { sha256: string }).sha256;
  await mkdir(s.install.stateDir, { recursive: true });
  await writeFile(
    s.install.stateFile,
    JSON.stringify({
      schema: 1,
      lastAttemptId: null,
      phase: 'idle',
      target: null,
      previous: { version: r.version, sha256 },
      attemptId: null,
      restartedAt: null,
    }),
  );
}

const phases = (s: Setup) => s.sent.map((p) => (p.reason === undefined ? p.phase : `${p.phase}:${p.reason}`));

describe('update agent (unprivileged half)', () => {
  it('verifies, stages in the data dir and asks the privileged updater to activate', async () => {
    const r = signedRelease(key, '1.1.0');
    const s = await setup(serving(r));
    const offer = offerFor(r);
    s.agent.onUpdateAvailable(offer);
    await s.agent.settled();
    expect(phases(s)).toEqual(['downloading', 'activating']);
    expect(await readFile(join(s.data.stagedDir, '1.1.0', 'remyral-worker.mjs'))).toEqual(r.artifact);
    expect(await readFile(join(s.data.stagedDir, '1.1.0', 'manifest.json'))).toEqual(r.manifest);
    expect(JSON.parse(await readFile(s.data.requestFile, 'utf8'))).toMatchObject({
      schema: 1,
      attemptId: offer.attemptId,
      version: '1.1.0',
      rollback: false,
    });
    if (process.platform !== 'win32') expect((await stat(s.data.requestFile)).mode & 0o777).toBe(0o600);
    expect(s.host.started).toBe(1);
    s.agent.stop();
  });

  const refusals: [
    string,
    () => { release: SignedRelease; offer?: Partial<UpdateOffer>; served?: SignedRelease },
    string,
  ][] = [
    [
      'tampered artifact',
      () => {
        const r = signedRelease(key, '1.1.0');
        const a = Buffer.from(r.artifact);
        a[3] = 0x5a;
        return { release: r, served: { ...r, artifact: a } };
      },
      'refused:sha256_mismatch',
    ],
    [
      'tampered manifest',
      () => {
        const r = signedRelease(key, '1.1.0');
        return {
          release: r,
          served: { ...r, manifest: Buffer.from(r.manifest.toString().replace('24.0.0', '20.0.0')) },
        };
      },
      'refused:bad_signature',
    ],
    [
      'artifact larger than signed (download stops at the signed size)',
      () => {
        const r = signedRelease(key, '1.1.0');
        return { release: r, served: { ...r, artifact: Buffer.concat([r.artifact, Buffer.from('evil()')]) } };
      },
      'refused:size_mismatch',
    ],
    [
      'release signed with the wrong key',
      () => ({ release: signedRelease(other, '1.1.0') }),
      'refused:unknown_key',
    ],
    [
      'manifest that does not match the offer',
      () => ({ release: signedRelease(key, '1.1.0'), offer: { sha256: 'e'.repeat(64) } }),
      'refused:manifest_mismatch',
    ],
    [
      'protocol-incompatible release',
      () => ({ release: signedRelease(key, '2.0.0', { protocolVersions: ['2.0'] }) }),
      'refused:protocol_incompatible',
    ],
    [
      'release for a newer Node',
      () => ({ release: signedRelease(key, '1.1.0', { minNode: '26.0.0' }) }),
      'refused:node_too_old',
    ],
    [
      'canary build on a stable worker',
      () => ({ release: signedRelease(key, '1.1.0', { channel: 'canary' }), offer: { channel: 'stable' } }),
      'refused:channel_not_allowed',
    ],
  ];
  it.each(refusals)('refuses a %s and stages nothing', async (_name, make, expected) => {
    const { release, offer, served } = make();
    const s = await setup(serving(served ?? release));
    s.agent.onUpdateAvailable(offerFor(release, offer));
    await s.agent.settled();
    expect(phases(s)).toEqual(['downloading', expected]);
    await expect(stat(s.data.requestFile)).rejects.toThrow();
    await expect(stat(join(s.data.stagedDir, release.version, 'remyral-worker.mjs'))).rejects.toThrow();
    expect(s.host.started).toBe(0);
  });

  it('refuses a downgrade (rollback attack) before downloading anything, unless it is an explicit rollback', async () => {
    const r = signedRelease(key, '0.9.0');
    const calls: string[] = [];
    const s = await setup(serving(r, calls), { current: '1.0.0' });
    s.agent.onUpdateAvailable(offerFor(r));
    await s.agent.settled();
    expect(phases(s)).toEqual(['refused:downgrade_refused']);
    expect(calls).toEqual([]);

    // Only to the previous version the privileged updater recorded (and retains): here none is recorded yet.
    s.agent.onUpdateAvailable(offerFor(r, { rollback: true }));
    await s.agent.settled();
    expect(phases(s).slice(1)).toEqual(['refused:rollback_not_retained']);
    expect(calls).toEqual([]);

    await writePrevious(s, r);
    s.agent.onUpdateAvailable(offerFor(r, { rollback: true }));
    await s.agent.settled();
    expect(phases(s).slice(2)).toEqual(['downloading', 'activating']);
    s.agent.stop();
  });

  it('a rollback offer to any other older signed release is refused before downloading', async () => {
    const previous = signedRelease(key, '0.9.0');
    const older = signedRelease(key, '0.8.0');
    const calls: string[] = [];
    const s = await setup(serving(older, calls), { current: '1.0.0' });
    await writePrevious(s, previous);
    s.agent.onUpdateAvailable(offerFor(older, { rollback: true }));
    await s.agent.settled();
    expect(phases(s)).toEqual(['refused:rollback_not_retained']);
    expect(s.sent[0]?.detail).toContain('(0.9.0)');
    // Same version, other bytes: refused too.
    const forged = signedRelease(key, '0.9.0', {}, Buffer.from('#!/usr/bin/env node\n// other bytes\n'));
    s.agent.onUpdateAvailable(offerFor(forged, { rollback: true }));
    await s.agent.settled();
    expect(phases(s).slice(1)).toEqual(['refused:rollback_not_retained']);
    expect(calls).toEqual([]);
  });

  it('refuses below the owner floor even as a rollback, and when no release key is pinned', async () => {
    const r = signedRelease(key, '0.9.0');
    const s = await setup(serving(r), { settings: { minVersion: '0.9.5' } });
    s.agent.onUpdateAvailable(offerFor(r, { rollback: true }));
    await s.agent.settled();
    expect(phases(s)).toEqual(['refused:below_minimum_version']);

    const noKeys = await setup(serving(r), { keys: [...trustedReleaseKeys(undefined, [])] });
    noKeys.agent.onUpdateAvailable(offerFor(signedRelease(key, '1.1.0')));
    await noKeys.agent.settled();
    expect(phases(noKeys)).toEqual(['refused:no_trusted_keys']);
  });

  it('treats the current version as success and canary offers as opt-in', async () => {
    const r = signedRelease(key, '1.0.0');
    const s = await setup(serving(r));
    s.agent.onUpdateAvailable(offerFor(r));
    await s.agent.settled();
    expect(phases(s)).toEqual(['succeeded:already_current']);

    const c = signedRelease(key, '1.1.0-rc.1', { channel: 'canary' });
    const canary = await setup(serving(c), { settings: { channel: 'canary' } });
    canary.agent.onUpdateAvailable(offerFor(c));
    await canary.agent.settled();
    expect(phases(canary)).toEqual(['downloading', 'activating']);
    canary.agent.stop();
  });

  it('never activates while jobs run: drains, reports deferred, activates once idle', async () => {
    const r = signedRelease(key, '1.1.0');
    const s = await setup(serving(r));
    s.host.jobs = 1;
    s.agent.onUpdateAvailable(offerFor(r));
    await expect.poll(() => phases(s)).toEqual(['downloading', 'deferred:jobs_running']);
    expect(s.host.drains).toEqual(['begin']);
    await expect(stat(s.data.requestFile)).rejects.toThrow();
    s.host.jobs = 0;
    await s.agent.settled();
    expect(phases(s)).toEqual(['downloading', 'deferred:jobs_running', 'activating']);
    await stat(s.data.requestFile);
    s.agent.stop();
  });

  it('a forced update does not wait for jobs', async () => {
    const r = signedRelease(key, '1.1.0');
    const s = await setup(serving(r));
    s.host.jobs = 2;
    s.agent.onUpdateAvailable(offerFor(r, { force: true }));
    await s.agent.settled();
    expect(phases(s)).toEqual(['downloading', 'activating']);
    expect(s.host.drains).toEqual([]);
    s.agent.stop();
  });

  it('reports failure when the privileged updater never acts, and gives up the drain', async () => {
    const r = signedRelease(key, '1.1.0');
    const s = await setup(serving(r), { activationTimeoutMs: 30 });
    s.host.jobs = 1;
    s.agent.onUpdateAvailable(offerFor(r));
    await expect.poll(() => s.host.drains).toEqual(['begin']);
    s.host.jobs = 0;
    await expect.poll(() => phases(s).at(-1)).toBe('failed:updater_unavailable');
    expect(s.host.drains).toEqual(['begin', 'end']);
    expect(s.host.failed).toBe(1);
    await expect(stat(s.data.requestFile)).rejects.toThrow();
  });

  it('does not queue a new request while the privileged updater is still checking (e.g. rolling back)', async () => {
    const r = signedRelease(key, '1.1.0');
    const s = await setup(serving(r));
    await mkdir(s.install.stateDir, { recursive: true });
    await writeFile(
      s.install.stateFile,
      JSON.stringify({
        schema: 1,
        lastAttemptId: null,
        phase: 'health_check',
        target: null,
        previous: null,
        attemptId: null,
        restartedAt: null,
      }),
    );
    s.agent.onUpdateAvailable(offerFor(r));
    await s.agent.settled();
    expect(phases(s)).toEqual(['failed:updater_busy']);
    await expect(stat(s.data.requestFile)).rejects.toThrow();
  });

  it('download failures are reported as failed, not refused', async () => {
    const r = signedRelease(key, '1.1.0');
    const s = await setup(() => Promise.reject(new DownloadError('http_status', 'HTTP 401', 401)));
    s.agent.onUpdateAvailable(offerFor(r));
    await s.agent.settled();
    expect(phases(s)).toEqual(['downloading', 'failed:download_http_status']);
  });

  it('a health write that loses the Windows rename race is retried on the next heartbeat', async () => {
    const base = nodeOps();
    let failures = 6; // more than one heartbeat's attempts
    const ops: FileOps = {
      ...base,
      rename: (from, to) => {
        if (to.endsWith('update-health.json') && failures > 0) {
          failures -= 1;
          return Promise.reject(
            Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }),
          );
        }
        return base.rename(from, to);
      },
    };
    const s = await setup(serving(signedRelease(key, '1.1.0')), { current: '1.1.0', ops });
    s.agent.onHeartbeatSent();
    await expect.poll(() => failures).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    await expect(readFile(s.data.healthFile, 'utf8')).rejects.toThrow();
    s.agent.onHeartbeatSent();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(s.data.healthFile, 'utf8').catch(() => '{}')) as Record<string, unknown>,
      )
      .toMatchObject({ schema: 1, version: '1.1.0', pid: 4242 });
  });

  it('proves health after session + heartbeat and reports the updater outcome exactly once', async () => {
    const s = await setup(serving(signedRelease(key, '1.1.0')), { current: '1.1.0' });
    s.agent.onHeartbeatSent();
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(s.data.healthFile, 'utf8').catch(() => '{}')) as Record<string, unknown>,
      )
      .toMatchObject({ schema: 1, version: '1.1.0', pid: 4242 });

    const attemptId = randomUUID();
    await mkdir(s.install.stateDir, { recursive: true });
    await writeFile(
      s.install.resultFile,
      JSON.stringify({
        schema: 1,
        attemptId,
        version: '1.1.0',
        outcome: 'succeeded',
        reason: null,
        detail: null,
        activeVersion: '1.1.0',
        finishedAt: '2026-10-13T12:01:00.000Z',
      }),
    );
    await s.agent.reportResult();
    await s.agent.reportResult();
    expect(s.sent).toEqual([{ attemptId, version: '1.1.0', phase: 'succeeded', currentVersion: '1.1.0' }]);
  });
});
