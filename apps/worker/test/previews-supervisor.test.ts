import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import {
  type ConnectorState,
  type LeaseKey,
  leaseKeyId,
  type MasterToWorker,
  type PreviewRequestPayload,
  PROTOCOL_VERSION,
  signTunnelStart,
  signTunnelStop,
  type TunnelStatusPayload,
} from '@remyral/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewManager, previewInfoText, previewSupport } from '../src/previews/manager.js';
import { classifyConnectorOutput, TunnelSupervisor } from '../src/previews/supervisor.js';

/**
 * p8-preview-tunnels (ADR-0032): the cloudflared supervisor with a fake connector (a node script that logs like
 * cloudflared), and the manager's TUNNEL_START / STOP checks and tool round trip.
 */

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const logger = createLogger({ sink: () => undefined });
const WORKER = 'wrk_abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'eyJhIjoiNWFiNGU5ZiIsInQiOiJjMTc0NGY4YiIsInMiOiJzZWNyZXQtY2FuYXJ5LXRva2VuLXZhbHVlIn0=';

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--token-file') + 1];
let token = '', mode = 0;
try { token = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch {}
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, token, mode, envToken: process.env.TUNNEL_TOKEN ?? null, home: process.env.HOME }) + '\\n');
if (process.env.FAKE_MODE === 'fail') { console.error('ERR Unauthorized: Invalid tunnel secret'); process.exit(1); }
setTimeout(() => console.error('2026-10-16T00:00:00Z INF Registered tunnel connection connIndex=0'), 50);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;

let dir = '';
let bin = '';
let log = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rw-previews-'));
  bin = join(dir, 'fake-cloudflared');
  log = join(dir, 'calls.jsonl');
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function calls(): Promise<{ args: string[]; token: string; mode: number; envToken: string | null }[]> {
  const text = await readFile(log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { args: string[]; token: string; mode: number; envToken: string | null });
}

function supervisor(
  mode: 'ready' | 'fail',
  states: [string, ConnectorState, string | undefined][],
  extra = {},
) {
  return new TunnelSupervisor({
    dataDir: join(dir, 'data'),
    cloudflared: () => Promise.resolve(bin),
    logger,
    onState: (id, s, d) => states.push([id, s, d]),
    env: { FAKE_LOG: log, FAKE_MODE: mode },
    backoffMs: [20],
    stopGraceMs: 1_000,
    ...extra,
  });
}

const spec = (over: Partial<Parameters<TunnelSupervisor['start']>[0]> = {}) => ({
  tunnelId: randomUUID(),
  jobId: 'job-1',
  attemptId: 'att-1',
  port: 5173,
  hostname: 'web-abcdefghij.example.com',
  expiresAt: new Date(Date.now() + 3600_000),
  connectorToken: TOKEN,
  ...over,
});

describePosix('TunnelSupervisor', () => {
  it('starts cloudflared with --token-file (0600, never on argv / env), reports running, stops and deletes the file', async () => {
    const states: [string, ConnectorState, string | undefined][] = [];
    const s = supervisor('ready', states);
    const sp = spec();
    expect(await s.start(sp)).toBe('started');
    expect(await s.waitRunning(sp.tunnelId, 5_000)).toBe(true);
    const c = (await calls())[0];
    expect(c?.args.slice(0, 4)).toEqual(['tunnel', '--no-autoupdate', 'run', '--token-file']);
    expect(c?.args.join(' ')).not.toContain(TOKEN);
    expect(c?.token).toBe(TOKEN);
    expect(c?.mode).toBe(0o600);
    expect(c?.envToken).toBeNull();
    expect(((await stat(join(dir, 'data', 'previews'))).mode & 0o777).toString(8)).toBe('700');
    expect(s.list()[0]).toMatchObject({ tunnelId: sp.tunnelId, state: 'running', jobId: 'job-1' });
    expect(await s.stop(sp.tunnelId, 'closed')).toBe(true);
    await expect(stat(s.tokenPath(sp.tunnelId))).rejects.toThrow();
    expect(states.map((x) => x[1])).toEqual(['starting', 'running', 'stopped']);
    expect(s.list()).toEqual([]);
  });

  it('restarts with backoff, then fails with a classified reason (never the output itself)', async () => {
    const states: [string, ConnectorState, string | undefined][] = [];
    const s = supervisor('fail', states, { maxRestarts: 2 });
    const sp = spec();
    await s.start(sp);
    expect(await s.waitRunning(sp.tunnelId, 5_000)).toBe(false);
    for (let i = 0; i < 100 && states.at(-1)?.[1] !== 'failed'; i++)
      await new Promise((r) => setTimeout(r, 30));
    expect(states.at(-1)).toEqual([
      sp.tunnelId,
      'failed',
      'the tunnel token was rejected (closed or rotated)',
    ]);
    expect((await calls()).length).toBe(3);
    await expect(stat(s.tokenPath(sp.tunnelId))).rejects.toThrow();
  });

  it('a re-start with the same tunnel extends it; a new token restarts the connector', async () => {
    const s = supervisor('ready', []);
    const sp = spec();
    await s.start(sp);
    await s.waitRunning(sp.tunnelId, 5_000);
    expect(await s.start({ ...sp, expiresAt: new Date(Date.now() + 7200_000) })).toBe('updated');
    expect((await calls()).length).toBe(1);
    expect(await s.start({ ...sp, connectorToken: `${TOKEN}AAAA` })).toBe('updated');
    for (let i = 0; i < 100 && (await calls()).length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    expect((await calls())[1]?.token).toBe(`${TOKEN}AAAA`);
    await s.stopAll('test');
  });

  it('the signed lifetime is enforced locally; limits and a missing cloudflared refuse', async () => {
    const states: [string, ConnectorState, string | undefined][] = [];
    const s = supervisor('ready', states, { maxConnectors: 1 });
    const short = spec({ expiresAt: new Date(Date.now() + 400) });
    await s.start(short);
    expect(await s.start(spec())).toBe('refused');
    for (let i = 0; i < 100 && s.get(short.tunnelId) !== undefined; i++)
      await new Promise((r) => setTimeout(r, 30));
    expect(s.get(short.tunnelId)).toBeUndefined();
    expect(states.some(([id, st, d]) => id === short.tunnelId && st === 'stopped' && d === 'expired')).toBe(
      true,
    );
    const none = new TunnelSupervisor({
      dataDir: join(dir, 'data2'),
      cloudflared: () => Promise.resolve(null),
      logger,
      onState: (id, st, d) => states.push([id, st, d]),
    });
    expect(await none.start(spec())).toBe('refused');
    expect(states.at(-1)?.[2]).toMatch(/not installed/);
  });

  it('cleanStale removes token files left by a crash', async () => {
    const s = supervisor('ready', []);
    await writeFile(join(dir, 'x.token'), 'x');
    const dataDir = join(dir, 'data', 'previews');
    await (await import('node:fs/promises')).mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, `${randomUUID()}.token`), TOKEN);
    await s.cleanStale();
    expect(
      (await (await import('node:fs/promises')).readdir(dataDir)).filter((n) => n.endsWith('.token')),
    ).toEqual([]);
  });
});

describe('classified connector output', () => {
  it('maps known cloudflared failures to short reasons', () => {
    expect(classifyConnectorOutput('ERR Unauthorized: Invalid tunnel secret')).toMatch(/token was rejected/);
    expect(classifyConnectorOutput('flag provided but not defined: -token-file')).toMatch(/2025\.4\.0/);
    expect(classifyConnectorOutput('INF Starting tunnel')).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------- manager

function keyPair(): { privateKey: KeyObject; key: LeaseKey } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = String(publicKey.export({ format: 'jwk' }).x);
  return { privateKey, key: { kid: leaseKeyId(raw), publicKey: raw } };
}

function envelope(type: MasterToWorker['type'], payload: unknown, jobId?: string): MasterToWorker {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    messageId: randomUUID(),
    seq: 0,
    ts: new Date().toISOString(),
    correlationId: 'c-1',
    workerId: WORKER,
    ...(jobId === undefined ? {} : { jobId }),
    payload,
  } as unknown as MasterToWorker;
}

describe('PreviewManager', () => {
  const signing = keyPair();
  function setup(
    over: {
      lease?: { attemptId: string; epoch: number } | undefined;
      containers?: NonNullable<ConstructorParameters<typeof PreviewManager>[0]['containers']>;
    } = {},
  ) {
    const started: unknown[] = [];
    const stopped: string[] = [];
    const statuses: TunnelStatusPayload[] = [];
    const requests: PreviewRequestPayload[] = [];
    let running = new Set<string>();
    const supervisor = {
      start: (s: { tunnelId: string }) => {
        started.push(s);
        running.add(s.tunnelId);
        return Promise.resolve('started');
      },
      stop: (id: string) => {
        stopped.push(id);
        const had = running.has(id);
        running.delete(id);
        return Promise.resolve(had);
      },
      stopJob: () => Promise.resolve(),
      stopAll: () => Promise.resolve(),
      list: () => [],
      get: (id: string) => (running.has(id) ? { tunnelId: id, state: 'running' } : undefined),
      waitRunning: (id: string) => Promise.resolve(running.has(id)),
    } as unknown as TunnelSupervisor;
    let mgr: PreviewManager | null = null;
    mgr = new PreviewManager({
      supervisor,
      channel: {
        request: (jobId, payload) => {
          requests.push(payload);
          // The master answers asynchronously.
          setTimeout(() => {
            const tunnelId = randomUUID();
            if (payload.op.kind === 'open') running.add(tunnelId);
            void mgr?.onMessage(
              envelope(
                'PREVIEW_RESULT',
                {
                  attemptId: payload.attemptId,
                  epoch: payload.epoch,
                  requestId: payload.requestId,
                  status: 'ok',
                  tunnels: [
                    {
                      id: tunnelId,
                      name: 'web',
                      url: 'https://web-abcdefghij.example.com',
                      protection: payload.op.kind === 'open' ? payload.op.protect : 'none',
                      stable: false,
                      state: 'active',
                      port: 5173,
                      expiresAt: '2026-10-16T20:00:00.000Z',
                    },
                  ],
                },
                jobId,
              ),
            );
          }, 5);
          return Promise.resolve();
        },
        status: (p) => {
          statuses.push(p);
          return Promise.resolve();
        },
        workerId: () => WORKER,
      },
      keys: () => [signing.key],
      lease: () => ('lease' in over ? over.lease : { attemptId: 'att-1', epoch: 3 }),
      cloudflared: () => Promise.resolve({ version: '2026.10.0', source: 'managed' }),
      ports: {
        listening: () => Promise.resolve(true),
        processTable: () =>
          Promise.resolve([
            { pid: 10, ppid: 1, rssBytes: 0 },
            { pid: 11, ppid: 10, rssBytes: 0 },
          ]),
        listeners: () => Promise.resolve([11]),
        workerPid: 1,
      },
      logger,
      readyWaitMs: 100,
      ...(over.containers === undefined ? {} : { containers: over.containers }),
    });
    const attached = mgr.attach({
      jobId: 'job-1',
      attemptId: 'att-1',
      epoch: 3,
      runtime: 'claude-code',
      profile: 'host-restricted',
      assigned: { tools: true, declaredPorts: [], protections: ['none', 'service-token'] },
    });
    attached?.onPid(10);
    running = new Set();
    return { mgr, attached, started, stopped, statuses, requests };
  }

  function start(over: Partial<Record<string, unknown>> = {}, sign = true) {
    const b = {
      workerId: WORKER,
      tunnelId: randomUUID(),
      jobId: 'job-1',
      attemptId: 'att-1',
      epoch: 3,
      port: 5173,
      hostname: 'web-abcdefghij.example.com',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      check: 'owned' as const,
      issuedAt: new Date().toISOString(),
      connectorToken: TOKEN,
      ...over,
    };
    const signature = signTunnelStart(b, signing.key.kid, signing.privateKey);
    const { workerId: _w, ...payload } = b;
    return envelope('TUNNEL_START', { ...payload, ...(sign ? { signature } : {}) });
  }

  it('starts a signed, fresh TUNNEL_START for the live attempt after the port re-check', async () => {
    const s = setup();
    await s.mgr.onMessage(start());
    expect(s.started).toHaveLength(1);
    expect(s.statuses).toEqual([]);
  });

  it('refuses unsigned, tampered, stale, foreign-attempt and expired starts (TUNNEL_STATUS refused)', async () => {
    const s = setup();
    await s.mgr.onMessage(start({}, false));
    const tampered = start();
    (tampered.payload as { port: number }).port = 5174;
    await s.mgr.onMessage(tampered);
    await s.mgr.onMessage(start({ issuedAt: new Date(Date.now() - 3600_000).toISOString() }));
    await s.mgr.onMessage(start({ attemptId: 'att-2' }));
    await s.mgr.onMessage(start({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(s.started).toEqual([]);
    expect(s.statuses.map((x) => x.state)).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']);
    expect(s.statuses[0]?.detail).toMatch(/signature/);
    expect(s.statuses[3]?.detail).toMatch(/attempt/);
  });

  it('TUNNEL_STOP needs the master signature', async () => {
    const s = setup();
    const tunnelId = randomUUID();
    const issuedAt = new Date().toISOString();
    await s.mgr.onMessage(envelope('TUNNEL_STOP', { tunnelId, reason: 'x', issuedAt }));
    expect(s.stopped).toEqual([]);
    const signature = signTunnelStop(
      { workerId: WORKER, tunnelId, issuedAt },
      signing.key.kid,
      signing.privateKey,
    );
    await s.mgr.onMessage(envelope('TUNNEL_STOP', { tunnelId, reason: 'closed', issuedAt, signature }));
    expect(s.stopped).toEqual([tunnelId]);
  });

  it('open_preview: local checks, a fenced request, and the link text (public warning, service token headers)', async () => {
    const s = setup();
    const tools = s.attached?.tools;
    if (tools === null || tools === undefined) throw new Error('no tools');
    const refused = await tools.open({ port: 5173, protect: 'access' });
    expect(refused.ok).toBe(false);
    expect(refused.text).toMatch(/not available/);
    const out = await tools.open({ port: 5173 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('https://web-abcdefghij.example.com');
    expect(out.text).toContain('PUBLIC LINK');
    expect(s.requests[0]).toMatchObject({
      attemptId: 'att-1',
      epoch: 3,
      op: { kind: 'open', port: 5173, check: 'owned' },
    });
    expect((await tools.list()).text).toContain('web-abcdefghij');
    expect((await tools.close({ name: 'web' })).ok).toBe(true);
    expect(
      previewInfoText(
        {
          id: randomUUID(),
          name: 'api',
          url: 'https://api-x.example.com',
          protection: 'service-token',
          stable: true,
          state: 'active',
          port: 8080,
          expiresAt: 'x',
          serviceToken: { clientId: 'cid.access', clientSecret: 'sec' },
        },
        true,
      ),
    ).toContain('CF-Access-Client-Secret: sec');
  });

  it('no tools without a live lease answer; container and Codex runtime-sandbox get no previews', async () => {
    const s = setup({ lease: undefined });
    const out = await s.attached?.tools?.open({ port: 5173 });
    expect(out?.ok).toBe(false);
    expect(previewSupport('claude-code', 'container').reason).toMatch(/container/);
    expect(previewSupport('codex', 'runtime-sandbox').reason).toMatch(/Codex/);
    // p22-previews-inputs: every runtime carries the tools; container jobs with a port forwarder.
    for (const r of ['codex', 'pi', 'opencode'] as const) {
      expect(previewSupport(r, 'host-restricted')).toMatchObject({
        tools: true,
        autoOpen: true,
        reason: null,
      });
    }
    expect(previewSupport('pi', 'container', true)).toMatchObject({ tools: true, reason: null });
    expect(previewSupport('claude-code', 'runtime-sandbox')).toMatchObject({ tools: true, reason: null });
  });

  it('publish_site (ADR-0038): offered only with assigned.publish (Claude Code, any profile), sent as op publish', async () => {
    const s = setup();
    // The preview job of setup(): preview tools only.
    expect(s.attached?.tools?.tools).toEqual(['open_preview', 'close_preview', 'list_previews']);
    const pub = s.mgr.attach({
      jobId: 'job-2',
      attemptId: 'att-1',
      epoch: 3,
      runtime: 'claude-code',
      profile: 'container',
      assigned: { tools: false, declaredPorts: [], protections: ['none'], publish: true },
    });
    expect(pub?.tools?.tools).toEqual(['publish_site']);
    expect(pub?.allowLocalBinding).toBe(false);
    expect(pub?.preamble).toMatch(/publish_site/);
    expect(pub?.preamble).not.toMatch(/open_preview/);
    const out = await pub?.tools?.publish?.({ env: 'preview', domain: 'site.demo.test', dns: 'auto' });
    expect(out?.ok).toBe(true);
    expect(s.requests.at(-1)).toMatchObject({
      attemptId: 'att-1',
      epoch: 3,
      op: { kind: 'publish', env: 'preview', domain: 'site.demo.test', dns: 'auto' },
    });
    // p22-previews-inputs: Codex gets it on its job-tool channel; container without publish (no forwarder) gets nothing.
    expect(
      s.mgr.attach({
        jobId: 'job-3',
        attemptId: 'att-1',
        epoch: 3,
        runtime: 'codex',
        profile: 'container',
        assigned: { tools: false, declaredPorts: [], protections: ['none'], publish: true },
      })?.tools?.tools,
    ).toEqual(['publish_site']);
    expect(
      s.mgr.attach({
        jobId: 'job-4',
        attemptId: 'att-1',
        epoch: 3,
        runtime: 'claude-code',
        profile: 'container',
        assigned: { tools: true, declaredPorts: [], protections: ['none'] },
      }),
    ).toBeNull();
  });

  it('p22-previews-inputs: container jobs check the port inside the container and publish it on the loopback', async () => {
    const checks: [string, number][] = [];
    const stoppedJobs: string[] = [];
    let listening = false;
    const containers = {
      check: (jobId: string, port: number) => {
        checks.push([jobId, port]);
        return Promise.resolve(
          listening
            ? ({ ok: true } as const)
            : ({
                ok: false,
                reason: 'not_listening',
                detail: 'nothing listens inside the container',
              } as const),
        );
      },
      ports: () => [5173],
      stopJob: (jobId: string) => {
        stoppedJobs.push(jobId);
        return Promise.resolve();
      },
      stopAll: () => Promise.resolve(),
    };
    const s = setup({ containers });
    const c = s.mgr.attach({
      jobId: 'job-c',
      attemptId: 'att-1',
      epoch: 3,
      runtime: 'opencode',
      profile: 'container',
      assigned: { tools: true, declaredPorts: [], protections: ['none'] },
    });
    expect(c?.tools?.tools).toEqual(['open_preview', 'close_preview', 'list_previews']);
    expect(c?.allowLocalBinding).toBe(false);
    // Known service ports are refused before the container is asked.
    expect((await c?.tools?.open({ port: 5432 }))?.ok).toBe(false);
    expect(checks).toEqual([]);
    const notYet = await c?.tools?.open({ port: 5173 });
    expect(notYet?.text).toMatch(/inside the container/);
    listening = true;
    const n = s.requests.length;
    expect((await c?.tools?.open({ port: 5173 }))?.ok).toBe(true);
    expect(s.requests[n]).toMatchObject({ op: { kind: 'open', port: 5173, check: 'owned' } });
    expect(checks).toEqual([
      ['job-c', 5173],
      ['job-c', 5173],
    ]);
    await s.mgr.detach('job-c');
    expect(stoppedJobs).toEqual(['job-c']);
  });

  it('p22-previews-inputs: a forwarded container port counts as the worker’s own for host jobs', async () => {
    const s = setup({
      containers: {
        check: () => Promise.resolve({ ok: true }),
        ports: () => [5173],
        stopJob: () => Promise.resolve(),
        stopAll: () => Promise.resolve(),
      },
    });
    const out = await s.attached?.tools?.open({ port: 5173 });
    expect(out?.ok).toBe(false);
    expect(out?.text).toMatch(/belongs to the worker/);
  });

  it('deploy tools (ADR-0048): offered with assigned.deploy to every runtime and profile, sent as deploy ops', async () => {
    const s = setup();
    expect(s.attached?.deployTools).toBeNull();
    const d = s.mgr.attach({
      jobId: 'job-5',
      attemptId: 'att-1',
      epoch: 3,
      runtime: 'codex',
      profile: 'container',
      assigned: { tools: false, declaredPorts: [], protections: ['none'], deploy: true },
    });
    expect(d?.tools).toBeNull();
    expect(d?.deployTools).not.toBeNull();
    expect(d?.preamble).toMatch(/deploy_logs/);
    expect((await d?.deployTools?.logs({ kind: 'runtime', env: 'preview', lines: 50 }))?.ok).toBe(true);
    expect(s.requests.at(-1)).toMatchObject({
      attemptId: 'att-1',
      epoch: 3,
      op: { kind: 'deploy_logs', logKind: 'runtime', env: 'preview', lines: 50 },
    });
    await d?.deployTools?.status({});
    expect(s.requests.at(-1)?.op).toEqual({ kind: 'deploy_status' });
    await d?.deployTools?.redeploy({ target: 'coolify' });
    expect(s.requests.at(-1)?.op).toEqual({ kind: 'redeploy', target: 'coolify' });
  });

  it('report lists the cloudflared and the connectors', async () => {
    const s = setup();
    expect(await s.mgr.report()).toEqual({
      cloudflared: { version: '2026.10.0', source: 'managed' },
      connectors: [],
    });
  });
});
