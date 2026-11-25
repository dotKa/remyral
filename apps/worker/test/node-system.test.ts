import { describe, expect, it } from 'vitest';
import { serverAuthSelfTest, type ServerSpec } from '../src/runtimes/selftest.js';
import { createNodeSystem } from '../src/system/node.js';

// Real process handling on the CI/dev host (Linux, macOS, Windows): timeouts kill the
// child, servers are stopped, and the loopback guard refuses other hosts.
const sys = createNodeSystem();
const node = process.execPath;

describe('node System (real processes)', () => {
  it('exec returns output and exit code', async () => {
    const r = await sys.exec(node, ['-e', 'process.stdout.write("v1.2.3"); process.exit(3)'], {
      timeoutMs: 20_000,
    });
    expect(r).toMatchObject({ exitCode: 3, stdout: 'v1.2.3', timedOut: false });
  });

  it('exec kills a hanging child at the timeout', { timeout: 20_000 }, async () => {
    const started = Date.now();
    const r = await sys.exec(node, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('exec reports a missing binary as a spawn error, not a throw', async () => {
    const r = await sys.exec('/definitely/not/here/remyral-x', ['--version'], { timeoutMs: 5_000 });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).toBeDefined();
  });

  it('httpGetLoopback refuses non-loopback hosts', async () => {
    await expect(sys.httpGetLoopback('http://example.com/', {}, 1_000)).rejects.toThrow(/127\.0\.0\.1/);
    await expect(sys.httpGetLoopback('http://localhost:1/', {}, 1_000)).rejects.toThrow(/127\.0\.0\.1/);
  });

  it(
    'runs the server auth self-test against a real loopback server and stops it',
    { timeout: 60_000 },
    async () => {
      // A tiny stand-in for OpenCode: 401 unless the per-run secret is presented.
      const script = `
      const http = require('node:http');
      const [host, port] = [process.argv[1], Number(process.argv[2])];
      http.createServer((req, res) => {
        const ok = req.headers['x-test-key'] === process.env.TEST_SECRET;
        res.statusCode = ok ? 200 : 401;
        res.end(ok ? JSON.stringify({ version: '1.19.4' }) : '');
      }).listen(port, host);`;
      const spec: ServerSpec = {
        runtime: 'opencode',
        args: (port) => ['-e', script, '127.0.0.1', String(port)],
        env: (secret) => ({ TEST_SECRET: secret }),
        authHeaders: (secret) => ({ 'x-test-key': secret }),
        protectedPath: '/global/health',
        versionPath: '/global/health',
        startTimeoutMs: 20_000,
      };
      const { result, problems } = await serverAuthSelfTest(sys, spec, { file: node, prefixArgs: [] });
      expect(problems).toEqual([]);
      expect(result.status).toBe('passed');
      expect(result.checks.find((c) => c.name === 'server process stopped')?.ok).toBe(true);
    },
  );

  it('flags a real fail-open server', { timeout: 60_000 }, async () => {
    const script = `require('node:http').createServer((q, s) => s.end('{"version":"1.19.4"}')).listen(Number(process.argv[1]), '127.0.0.1');`;
    const spec: ServerSpec = {
      runtime: 'opencode',
      args: (port) => ['-e', script, String(port)],
      env: () => ({}),
      authHeaders: (secret) => ({ 'x-test-key': secret }),
      protectedPath: '/global/health',
      versionPath: '/global/health',
      startTimeoutMs: 20_000,
    };
    const { problems } = await serverAuthSelfTest(sys, spec, { file: node, prefixArgs: [] });
    expect(problems.map((p) => p.code)).toEqual(['selftest.fail_open']);
  });
});
