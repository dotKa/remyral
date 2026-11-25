import { describe, expect, it } from 'vitest';
import type { HttpResponse } from '../src/system/types.js';
import { OPENCODE_SPEC, cliHelpSelfTest, serverAuthSelfTest } from '../src/runtimes/selftest.js';
import { FakeSystem, fail, ok } from './fake-system.js';

const SECRET = new FakeSystem().randomSecret();
const basic = `Basic ${Buffer.from(`opencode:${SECRET}`).toString('base64')}`;

/** A well-behaved OpenCode 1.19.4: everything behind Basic auth. */
function opencodeHttp(url: string, headers: Readonly<Record<string, string>>): HttpResponse {
  if (headers.authorization !== basic) return { status: 401, body: '' };
  if (url.endsWith('/global/health')) return { status: 200, body: '{"healthy":true,"version":"1.19.4"}' };
  return { status: 404, body: '' };
}

const parentEnv = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'sk-ant-leak',
  OPENCODE_SERVER_PASSWORD: 'operator-pw',
};

describe('server auth self-test', () => {
  it('passes for OpenCode when 401 without and 200 with the per-run secret', async () => {
    const sys = new FakeSystem({ platform: 'darwin', env: parentEnv, http: opencodeHttp });
    const { result, problems } = await serverAuthSelfTest(sys, OPENCODE_SPEC, {
      file: '/bin/opencode',
      prefixArgs: [],
    });
    expect(result.status).toBe('passed');
    expect(result.checks.every((c) => c.ok)).toBe(true);
    expect(problems).toEqual([]);

    const [call] = sys.serverCalls;
    expect(call?.args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678', '--pure']);
    // Secret only via env, never argv; operator's own env secrets are not inherited.
    expect(call?.args.join(' ')).not.toContain(SECRET);
    expect(call?.env.OPENCODE_SERVER_PASSWORD).toBe(SECRET);
    expect(call?.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call?.env.HOME).toBe('/tmp/remyral-probe-x1');
    expect(call?.cwd).toBe('/tmp/remyral-probe-x1');
    expect(sys.httpCalls.every((c) => c.url.startsWith('http://127.0.0.1:45678/'))).toBe(true);
    expect(sys.stoppedServers).toBe(1);
    expect(sys.removedDirs).toEqual(['/tmp/remyral-probe-x1']);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('detects a fail-open server (200 without credentials)', async () => {
    const sys = new FakeSystem({
      env: parentEnv,
      http: (url) => ({
        status: 200,
        body: url.endsWith('/global/health') ? '{"healthy":true,"version":"1.19.4"}' : '',
      }),
    });
    const { result, problems } = await serverAuthSelfTest(sys, OPENCODE_SPEC, {
      file: '/bin/opencode',
      prefixArgs: [],
    });
    expect(result.status).toBe('failed');
    expect(result.checks.find((c) => c.name.startsWith('unauthenticated'))).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/FAIL-OPEN/) as unknown,
    });
    expect(problems).toMatchObject([{ code: 'selftest.fail_open', severity: 'error' }]);
    expect(sys.stoppedServers).toBe(1);
  });

  it('fails a version that differs from the pin', async () => {
    const sys = new FakeSystem({
      http: (url, headers) =>
        headers.authorization === basic
          ? { status: 200, body: '{"version":"1.20.0"}' }
          : { status: 401, body: url },
    });
    const { result, problems } = await serverAuthSelfTest(sys, OPENCODE_SPEC, {
      file: '/bin/opencode',
      prefixArgs: [],
    });
    expect(result.status).toBe('failed');
    expect(problems.map((p) => p.code)).toEqual(['selftest.failed']);
  });

  it('fails and cleans up when the server exits before listening', async () => {
    const sys = new FakeSystem({ serverExitsWith: 1 });
    const { result, problems } = await serverAuthSelfTest(sys, OPENCODE_SPEC, {
      file: '/bin/opencode',
      prefixArgs: [],
    });
    expect(result.status).toBe('failed');
    expect(result.checks[0]).toMatchObject({ ok: false, detail: 'server exited before listening (exit 1)' });
    expect(problems.map((p) => p.code)).toEqual(['selftest.failed']);
    expect(sys.stoppedServers).toBe(1);
    expect(sys.removedDirs).toHaveLength(1);
  });

  it('times out when the server never listens', async () => {
    const sys = new FakeSystem({});
    const { result } = await serverAuthSelfTest(sys, OPENCODE_SPEC, {
      file: '/bin/opencode',
      prefixArgs: [],
    });
    expect(result.checks[0]).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/timeout/) as unknown,
    });
    expect(sys.stoppedServers).toBe(1);
  });

  it('cleans up when a check throws midway', async () => {
    let n = 0;
    const sys = new FakeSystem({
      http: () => {
        if (++n > 1) throw new Error('socket hang up');
        return { status: 401, body: '' };
      },
    });
    const { result } = await serverAuthSelfTest(sys, OPENCODE_SPEC, {
      file: '/bin/opencode',
      prefixArgs: [],
    });
    expect(result.status).toBe('failed');
    expect(result.checks.find((c) => c.name === 'self-test ran to completion')?.detail).toBe(
      'socket hang up',
    );
    expect(sys.stoppedServers).toBe(1);
    expect(sys.removedDirs).toHaveLength(1);
  });
});

describe('cli --help self-test', () => {
  it('passes on exit 0 with output and runs in an isolated env', async () => {
    const sys = new FakeSystem({
      env: parentEnv,
      exec: (_f, args) => (args[0] === '--help' ? ok('Usage: codex') : undefined),
    });
    const { result, problems } = await cliHelpSelfTest(sys, 'codex', { file: '/bin/codex', prefixArgs: [] });
    expect(result).toMatchObject({ kind: 'cli-help', status: 'passed' });
    expect(problems).toEqual([]);
    expect(sys.execCalls[0]?.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sys.execCalls[0]?.options.timeoutMs).toBeGreaterThan(0);
  });

  it('fails on a non-zero exit', async () => {
    const sys = new FakeSystem({ exec: () => fail(3) });
    const { result, problems } = await cliHelpSelfTest(sys, 'pi', { file: '/bin/pi', prefixArgs: [] });
    expect(result.status).toBe('failed');
    expect(problems.map((p) => p.code)).toEqual(['selftest.failed']);
  });
});
