import { createHash, generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { MasterToWorker } from '@remyral/protocol';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PanelSkillsKey } from '../../src/skills/panel-key.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { RawWorker, TestKey } from '../helpers/raw-worker.js';
import { removeDirs, tempDataDir } from '../helpers/real-worker.js';

/**
 * p14-mcp-stdio (ADR-0054 P4, design §2.7 / §14): local npm / PyPI MCP servers over the REST API and the worker
 * protocol — stdio publish (package + integrity, no URL), installs only through the fleet pipeline with admin +
 * always-fresh step-up, canary first without a stored lock (the canary resolves it, the others wait), the canary's
 * lockfile stored once (first write wins, hash re-checked) and handed to every other machine exactly, a machine that
 * installed another lock marked failed, CAPABILITIES `mcpInstalls` reconciling, the stdio probe only where the
 * version is installed (the master never runs a server), and the generic fleet routes refusing MCP actions.
 */
const PW = 'quartz-meadow-lantern-7';
type OpsCommand = Extract<MasterToWorker, { type: 'OPS_COMMAND' }>;
const INTEGRITY = `sha512-${'Q'.repeat(86)}==`;
const DIGEST = `sha256:${'d'.repeat(64)}`;

function lockOf(text: string) {
  const raw = Buffer.from(text);
  return {
    manager: 'npm' as const,
    sha256: createHash('sha256').update(raw).digest('hex'),
    bytes: raw.byteLength,
    gz: gzipSync(raw).toString('base64'),
  };
}

describeIntegration('local (stdio) MCP servers (integration, p14-mcp-stdio)', { timeout: 300_000 }, () => {
  let h: Harness;
  let owner: Client;
  let secret: string;
  const workers: { raw: RawWorker; id: string; seq: number }[] = [];
  const dirs: string[] = [];

  async function stepUp(): Promise<void> {
    h.clock.advance(31_000);
    expect((await owner.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  function capabilities(
    w: { raw: RawWorker; id: string },
    features: string[],
    mcpInstalls?: unknown[],
  ): void {
    w.raw.sendJson(
      w.raw.envelope(
        'CAPABILITIES',
        {
          runtimes: [],
          sandboxProfiles: ['host-restricted'],
          maxParallelJobs: 1,
          tools: [],
          features,
          ...(mcpInstalls === undefined ? {} : { mcpInstalls }),
        },
        { workerId: w.id },
      ),
    );
  }

  async function features(id: string): Promise<string[]> {
    const { rows } = await h.db.pool.query<{ features: string[] }>(
      'SELECT features FROM workers WHERE id = $1',
      [id],
    );
    return rows[0]?.features ?? [];
  }

  function update(w: { raw: RawWorker; id: string; seq: number }, payload: Record<string, unknown>): void {
    w.seq += 1;
    w.raw.sendJson(w.raw.envelope('OPS_UPDATE', { seq: w.seq, ...payload }, { workerId: w.id }));
  }

  async function installs(): Promise<{ worker_id: string; state: string; error: string | null }[]> {
    const { rows } = await h.db.pool.query<{ worker_id: string; state: string; error: string | null }>(
      `SELECT worker_id, state, error FROM mcp_worker_installs WHERE server_id = 'files' ORDER BY worker_id`,
    );
    return rows;
  }

  beforeAll(async () => {
    const root = await tempDataDir(dirs);
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = join(root, 'skills-panel.pem');
    await writeFile(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const panel = await PanelSkillsKey.fromFile(pem);
    h = new Harness(Date.now());
    await h.start({
      skills: { publicKeys: [], panelKey: panel },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
      remoteOpsLimits: {
        perWorker: { max: 1000, windowMs: 60_000 },
        heavyPerWorker: { max: 100, windowMs: 60_000 },
        perUser: { max: 1000, windowMs: 60_000 },
      },
    });
    const url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    owner = await fullLogin(h, 'owner1', PW, secret);
    for (const code of ['MCPA-ABCD', 'MCPB-ABCD']) {
      const raw = await RawWorker.connect(url, new TestKey());
      const pending = await raw.handshake({ pairingCode: code });
      const id = pending.workerId ?? '';
      await stepUp();
      expect((await owner.req('POST', `/workers/${id}/approve`, { pairingCode: code })).statusCode).toBe(200);
      await raw.next('SESSION_ESTABLISHED');
      workers.push({ raw, id, seq: 0 });
    }
  });

  afterAll(async () => {
    for (const w of workers) w.raw.close();
    await h.stop();
    await removeDirs(dirs);
  });

  it('publish → canary resolves the lock → the rest install exactly it; probe only where installed', async () => {
    const [a, b] = workers;
    if (a === undefined || b === undefined) throw new Error('workers');
    await stepUp();
    const body = {
      id: 'files',
      title: 'Files',
      version: '1.0.0',
      transport: 'stdio',
      package: {
        manager: 'npm',
        name: '@acme/mcp-files',
        version: '1.0.0',
        integrity: INTEGRITY,
        bin: 'mcp-files',
        args: ['--read-only'],
        env: { FILES_MODE: 'safe' },
      },
      egressHosts: ['files.example.com'],
      runtimes: ['claude-code', 'codex', 'pi', 'opencode'],
    };
    const withUrl = await owner.req('POST', '/mcp/servers', { ...body, url: 'https://x.example.com/mcp' });
    expect(withUrl.json()).toMatchObject({ error: 'mcp_stdio_spec_invalid' });
    const bad = await owner.req('POST', '/mcp/servers', {
      ...body,
      package: { ...body.package, integrity: `sha256:${'a'.repeat(64)}` },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: 'mcp_spec_invalid' });
    const pub = await owner.req('POST', '/mcp/servers', body);
    expect(pub.statusCode, pub.body).toBe(201);
    expect(pub.json()).toMatchObject({
      version: {
        transport: 'stdio',
        url: null,
        package: { manager: 'npm', name: '@acme/mcp-files', integrity: INTEGRITY, bin: 'mcp-files' },
      },
    });

    // Old workers (no mcp-stdio-v1) cannot take an install.
    capabilities(a, ['remote-ops-v1', 'mcp-v1']);
    capabilities(b, ['remote-ops-v1', 'mcp-v1']);
    await expect.poll(() => features(b.id)).toEqual(['remote-ops-v1', 'mcp-v1']);
    await stepUp();
    const old = await owner.req('POST', '/mcp/servers/files/versions/1.0.0/install', { workers: 'all' });
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ error: 'mcp_install_unsupported' });

    capabilities(a, ['remote-ops-v1', 'mcp-v1', 'mcp-stdio-v1']);
    capabilities(b, ['remote-ops-v1', 'mcp-v1', 'mcp-stdio-v1']);
    await expect.poll(() => features(b.id)).toContain('mcp-stdio-v1');
    // No stored lock yet: canary-first is forced, and needs a canary.
    const noCanary = await owner.req('POST', '/mcp/servers/files/versions/1.0.0/install', {
      workers: 'all',
      rollout: 'all',
    });
    expect(noCanary.json()).toMatchObject({ error: 'no_canary_machine' });
    expect(
      (await owner.req('PUT', `/workers/${a.id}/runtime-policy`, { policy: null, canary: true })).statusCode,
    ).toBe(200);
    a.raw.received.length = 0;
    // ADR-0054 decision 2: a fresh code for every install.
    h.clock.advance(11 * 60_000);
    const stale = await owner.req('POST', '/mcp/servers/files/versions/1.0.0/install', { workers: 'all' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ error: 'step_up_required' });
    await stepUp();
    const res = await owner.req('POST', '/mcp/servers/files/versions/1.0.0/install', { workers: 'all' });
    expect(res.statusCode, res.body).toBe(201);
    const action = res.json<{
      id: string;
      kind: string;
      rollout: string;
      targets: { workerId: string; phase: number; state: string }[];
    }>();
    expect(action).toMatchObject({ kind: 'mcp.install', rollout: 'canary-first' });
    expect(action.targets.find((t) => t.workerId === b.id)).toMatchObject({ phase: 2, state: 'held' });
    const cmd: OpsCommand = await a.raw.next('OPS_COMMAND');
    expect(cmd.payload.op).toMatchObject({ kind: 'mcp.install' });
    expect('lock' in cmd.payload.op).toBe(false);
    const params = await h.db.pool.query<{ params: Record<string, unknown> }>(
      'SELECT params FROM worker_ops WHERE id = $1',
      [cmd.payload.commandId],
    );
    expect(params.rows[0]?.params).toEqual({
      serverId: 'files',
      version: '1.0.0',
      specSha256: expect.stringMatching(/^[a-f0-9]{64}$/) as unknown,
      lockSha256: null,
    });

    // Generic fleet routes never continue / retry an MCP action; the MCP route needs the lock first.
    expect((await owner.req('POST', `/fleet/tools/actions/${action.id}/continue`, {})).json()).toMatchObject({
      error: 'wrong_route',
    });
    await stepUp();
    expect((await owner.req('POST', `/mcp/install-actions/${action.id}/continue`, {})).json()).toMatchObject({
      error: 'mcp_lock_missing',
    });

    const lock = lockOf('{"lockfileVersion":3,"packages":{}}\n');
    update(a, { commandId: cmd.payload.commandId, kind: 'mcp.install', state: 'accepted' });
    update(a, {
      commandId: cmd.payload.commandId,
      kind: 'mcp.install',
      state: 'succeeded',
      mcpInstall: {
        id: 'files',
        version: '1.0.0',
        manager: 'npm',
        digest: DIGEST,
        lockSha256: lock.sha256,
        lock,
        bytes: 1234,
        files: 10,
        acl: 'not_windows',
      },
    });
    await expect
      .poll(async () => (await installs()).find((r) => r.worker_id === a.id)?.state)
      .toBe('installed');
    const stored = await h.db.pool.query<{ sha256: string; produced_on_worker: string }>(
      `SELECT sha256, produced_on_worker FROM mcp_lockfiles WHERE server_id = 'files'`,
    );
    expect(stored.rows).toEqual([{ sha256: lock.sha256, produced_on_worker: a.id }]);

    await expect
      .poll(
        async () =>
          (await owner.req('GET', `/fleet/tools/actions/${action.id}`)).json<{ state: string }>().state,
      )
      .toBe('held');
    await stepUp();
    const cont = await owner.req('POST', `/mcp/install-actions/${action.id}/continue`, {});
    expect(cont.statusCode, cont.body).toBe(200);
    const next: OpsCommand = await b.raw.next('OPS_COMMAND');
    expect(next.payload.op).toMatchObject({ kind: 'mcp.install', lock: { sha256: lock.sha256 } });
    // B reports another lock than the canary's: not installed.
    update(b, {
      commandId: next.payload.commandId,
      kind: 'mcp.install',
      state: 'succeeded',
      mcpInstall: {
        id: 'files',
        version: '1.0.0',
        manager: 'npm',
        digest: DIGEST,
        lockSha256: 'e'.repeat(64),
        bytes: 1,
        files: 1,
      },
    });
    await expect.poll(async () => (await installs()).find((r) => r.worker_id === b.id)?.state).toBe('failed');
    expect((await installs()).find((r) => r.worker_id === b.id)?.error).toMatch(/^lock_mismatch/);

    // Detail: installs, lockfile, the action, the stdio machines.
    const detail = (await owner.req('GET', '/mcp/servers/files')).json<{
      installs: { workerId: string; state: string }[];
      lockfiles: { sha256: string }[];
      installActions: { id: string }[];
      stdioWorkers: { id: string; canary: boolean }[];
    }>();
    expect(detail.lockfiles).toEqual([expect.objectContaining({ sha256: lock.sha256 })]);
    expect(detail.installActions[0]?.id).toBe(action.id);
    expect(detail.stdioWorkers.find((w) => w.id === a.id)?.canary).toBe(true);

    // Probe: only where installed (the worker starts the server; the master never does).
    await stepUp();
    const notHere = await owner.req('POST', '/mcp/servers/files/versions/1.0.0/probe', { workerId: b.id });
    expect(notHere.statusCode).toBe(409);
    expect(notHere.json()).toMatchObject({ error: 'mcp_not_installed' });
    const probe = await owner.req('POST', '/mcp/servers/files/versions/1.0.0/probe', { workerId: a.id });
    expect(probe.statusCode, probe.body).toBe(202);
    expect((await a.raw.next('OPS_COMMAND')).payload.op).toMatchObject({ kind: 'mcp.probe' });

    // CAPABILITIES reconcile: A no longer reports it → removed.
    capabilities(a, ['remote-ops-v1', 'mcp-v1', 'mcp-stdio-v1'], []);
    await expect
      .poll(async () => (await installs()).find((r) => r.worker_id === a.id)?.state)
      .toBe('removed');
    capabilities(
      a,
      ['remote-ops-v1', 'mcp-v1', 'mcp-stdio-v1'],
      [{ id: 'files', version: '1.0.0', digest: DIGEST, lockSha256: lock.sha256 }],
    );
    await expect
      .poll(async () => (await installs()).find((r) => r.worker_id === a.id)?.state)
      .toBe('installed');

    const audit = await h.db.pool.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action IN ('mcp.install', 'mcp.lock.stored', 'mcp.install.result') ORDER BY id`,
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['mcp.install', 'mcp.lock.stored', 'mcp.install.result']);
  });
});
