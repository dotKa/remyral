import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { createLogger } from '@remyral/observability';
import { PROTOCOL_VERSION, type WorkerToMaster } from '@remyral/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { type BridgeAnswer, IdeBridgeServer } from '../src/ide/bridge.js';
import {
  bridgeExtensionFiles,
  bridgeExtensionsJson,
  BRIDGE_EXTENSION_DIR,
} from '../src/ide/bridge-extension.js';
import { IdeStreams } from '../src/ide/streams.js';
import type { IdeGateway } from '../src/ide/gateway.js';

/**
 * p19-ide W2: the loopback bridge the IDE's extension calls (token per workspace start, validation, rate limit), the
 * extension files the worker writes, and the worker's stream plane mapping `STREAM_OPEN{ide}` to running workspaces.
 */

const logger = createLogger({ sink: () => undefined });
const servers: IdeBridgeServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function bridge(calls: string[]) {
  const ok = (what: string): Promise<BridgeAnswer> => {
    calls.push(what);
    return Promise.resolve({ status: 'ok', message: what });
  };
  const s = new IdeBridgeServer(
    {
      reference: (id, r) => ok(`reference ${id} ${r.path}:${String(r.startLine)}-${String(r.endLine)}`),
      push: (_id, r) => ok(`push ${r.message} ${String(r.pullRequest)}`),
      terminal: (_id, r) => ok(`terminal ${r.name}`),
    },
    logger,
  );
  await s.start();
  servers.push(s);
  return s;
}

async function post(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: BridgeAnswer }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as BridgeAnswer };
}

describe('IDE bridge endpoint (p19-ide W2)', () => {
  it('answers only the workspace token and validates the calls', async () => {
    const calls: string[] = [];
    const s = await bridge(calls);
    const id = randomUUID();
    const { url, token } = s.register(id);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ide\//);
    expect(
      (await post(`${url}/reference`, token, { path: 'src/a.ts', startLine: 2, endLine: 5 })).json,
    ).toEqual({
      status: 'ok',
      message: `reference ${id} src/a.ts:2-5`,
    });
    expect((await post(`${url}/push`, token, { message: ' fix ', pullRequest: true })).json.message).toBe(
      'push fix true',
    );
    expect((await post(`${url}/terminal`, token, { name: 'bash' })).json.message).toBe('terminal bash');
    expect((await post(`${url}/reference`, 'wrong', { path: 'a', startLine: 1, endLine: 1 })).status).toBe(
      401,
    );
    expect(
      (await post(`${url}/reference`, token, { path: '../etc/passwd', startLine: 1, endLine: 1 })).status,
    ).toBe(400);
    expect((await post(`${url}/reference`, token, { path: 'a', startLine: 5, endLine: 2 })).status).toBe(400);
    expect((await post(`${url}/push`, token, { message: '' })).status).toBe(400);
    expect((await post(`${url}/shell`, token, {})).status).toBe(404);
    // Another workspace's token does not reach this one; an unregistered workspace answers nobody.
    const other = s.register(randomUUID());
    expect((await post(`${url}/terminal`, other.token, { name: 'x' })).status).toBe(401);
    s.unregister(id);
    expect((await post(`${url}/terminal`, token, { name: 'x' })).status).toBe(401);
    expect(calls).toHaveLength(3);
  });

  it('rate-limits a workspace', async () => {
    const s = await bridge([]);
    const { url, token } = s.register(randomUUID());
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await post(`${url}/terminal`, token, { name: 't' })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it('writes the bridge extension and its registration', () => {
    const files = bridgeExtensionFiles();
    const pkg = JSON.parse(files['package.json'] ?? '{}') as {
      publisher: string;
      name: string;
      main: string;
      license: string;
      contributes: { commands: { command: string }[] };
    };
    expect(`${pkg.publisher}.${pkg.name}`).toBe('remyral.ide-bridge');
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.main).toBe('./extension.js');
    expect(pkg.contributes.commands.map((c) => c.command)).toEqual([
      'remyral.addToChat',
      'remyral.send',
      'remyral.openConsole',
      'remyral.syncSettings',
    ]);
    const js = files['extension.js'] ?? '';
    expect(js).toContain('onDidOpenTerminal');
    expect(js).toContain('process.env.REMYRAL_IDE_BRIDGE_TOKEN');
    // The extension never sees a git token or a console session: only its bridge URL and token.
    expect(js).not.toMatch(/GIT_TOKEN|ghp_|__Host-/);
    // It compiles as a CommonJS module body.
    expect(() => new Script(`(function (require, module) {${js}\n})`)).not.toThrow();
    const reg = JSON.parse(bridgeExtensionsJson('/x/ext/', new Date(0))) as {
      relativeLocation: string;
      location: { path: string };
    }[];
    expect(reg[0]).toMatchObject({
      relativeLocation: BRIDGE_EXTENSION_DIR,
      location: { path: `/x/ext/${BRIDGE_EXTENSION_DIR}` },
    });
  });
});

describe('IDE stream plane on the worker (p19-ide W2)', () => {
  it('accepts streams only for running workspaces and answers in envelopes', async () => {
    const sent: WorkerToMaster[] = [];
    const running = '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e002';
    const handled: unknown[] = [];
    const streams = new IdeStreams({
      logger,
      transport: {
        send: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
        sendBinary: () => Promise.resolve(),
      },
      workerId: () => 'wrk_1',
      gateway: (id) =>
        id === running ? ({ handle: (s: unknown) => handled.push(s) } as unknown as IdeGateway) : null,
    });
    const h = streams.handler();
    h.onSessionStart();
    const open = (streamId: number, workspaceId: string) => {
      h.onControl({
        protocolVersion: PROTOCOL_VERSION,
        type: 'STREAM_OPEN',
        messageId: randomUUID(),
        seq: 0,
        ts: new Date().toISOString(),
        correlationId: 'x',
        workerId: 'wrk_1',
        payload: { streamId, target: 'ide', workspaceId, window: 4096 },
      } as never);
    };
    open(1, running);
    open(2, '0f9d6a52-7c1e-4b8e-9f43-2a51c2a9e003');
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((m) => [m.type, (m.payload as { streamId: number }).streamId])).toEqual([
      ['STREAM_ACCEPT', 1],
      ['STREAM_CLOSE', 2],
    ]);
    expect((sent[1]?.payload as { reason?: string }).reason).toBe('not_found');
    expect(handled).toHaveLength(1);
    expect(streams.countFor(running)).toBe(1);
    expect(streams.openStreams).toBe(1);
    streams.resetWorkspace(running);
    expect(streams.countFor(running)).toBe(0);
    // Malformed data frames count as violations; too many drop the connection.
    expect(h.onData(Buffer.from([9]))).toBe(true);
    for (let i = 0; i < 4; i++) h.onData(Buffer.from([9]));
    expect(h.onData(Buffer.from([9]))).toBe(true);
    h.onSessionEnd();
    expect(streams.openStreams).toBe(0);
  });
});
