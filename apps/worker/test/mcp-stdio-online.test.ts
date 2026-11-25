import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@remyral/observability';
import { type McpSpecInput, packMcpSpec, verifyMcpSpec } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { McpInstaller } from '../src/mcp/install.js';
import { writeMcpLaunch } from '../src/mcp/launcher.js';
import { probeStdioServer } from '../src/mcp/probe.js';
import { removeTree } from '../src/mcp/tree.js';
import { hostPlatform } from '../src/remote-ops/manifest.js';
import { runProcess } from '../src/remote-ops/process.js';
import { ToolInstaller } from '../src/tools/installer.js';
import { recipePlatform, UV_VERSION } from '../src/tools/recipes.js';
import { captureLines, nodeOps, tempDir } from './helpers.js';

/**
 * p14-mcp-stdio, opt-in online check (`REMYRAL_ONLINE_TESTS=1`): the real npm of the worker's Node resolves a real MCP
 * server's lock (`--package-lock-only --ignore-scripts`), a second "machine" installs exactly that lock, the real
 * pinned uv recipe installs a PyPI server with hashes and a uv-managed CPython, and both answer a stdio probe.
 * Network: registry.npmjs.org, pypi.org, files.pythonhosted.org, github.com (uv + CPython). Not run in CI by default.
 */
const ONLINE = process.env.REMYRAL_ONLINE_TESTS === '1';

const skills = generateKeyPairSync('ed25519');
const pub = String(skills.publicKey.export({ format: 'jwk' }).x);

function spec(input: Omit<McpSpecInput, 'secrets' | 'egressHosts' | 'runtimes' | 'limits' | 'createdAt'>) {
  const p = packMcpSpec(
    {
      ...input,
      secrets: [],
      egressHosts: [],
      runtimes: ['claude-code', 'codex', 'pi', 'opencode'],
      limits: { startupTimeoutSec: 60, toolTimeoutSec: 120 },
      createdAt: '2026-10-21T00:00:00.000Z',
    },
    skills.privateKey,
    pub,
  );
  const v = verifyMcpSpec(p.signed, [pub]);
  if (!v.ok) throw new Error(v.reason);
  return v;
}

async function open(dataDir: string, uv: () => Promise<string>) {
  return McpInstaller.open({
    ops: nodeOps(),
    dataDir,
    host: hostPlatform(),
    nodePath: process.execPath,
    run: runProcess,
    uv,
    logger: createLogger({ sink: captureLines().sink }),
  });
}

async function probe(i: McpInstaller, v: ReturnType<typeof spec>) {
  const ready = await i.ready(v.spec, v.specSha256);
  if (!ready.ok) throw new Error(ready.message);
  const dir = await tempDir('rw-online-probe-');
  const { launcher, specFile } = await writeMcpLaunch(dir, v.spec, ready.exec, {});
  return probeStdioServer(() => {
    const child = spawn(process.execPath, [launcher, specFile], {
      env: { PATH: process.env.PATH ?? '', HOME: dir },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise((r) => child.on('exit', r));
    return Promise.resolve({
      stdin: child.stdin,
      stdout: child.stdout,
      exited,
      stop: async () => {
        child.kill();
        await exited;
      },
    });
  });
}

describe.skipIf(!ONLINE)(
  'p14-mcp-stdio online: real npm, real uv, real servers',
  { timeout: 600_000 },
  () => {
    it('npm: canary lock → identical install elsewhere → stdio probe', async () => {
      const v = spec({
        id: 'everything',
        version: '2026.8.31',
        transport: 'stdio',
        stdio: {
          package: {
            manager: 'npm',
            name: '@modelcontextprotocol/server-everything',
            version: '2026.8.31',
            integrity:
              'sha512-5U3OZh8Xq0Li4nA26l6uNvV9/1suMDuWSn+NjLZIhzinhMY6N3A4DCrxVecBGPf2PsNFKTEv5krxGPRwzxc7jQ==',
          },
          bin: 'mcp-server-everything',
        },
      });
      const a = await tempDir('rw-online-a-');
      const b = await tempDir('rw-online-b-');
      const noUv = () => Promise.reject(new Error('npm only'));
      const canary = await open(a, noUv);
      const other = await open(b, noUv);
      try {
        const r1 = await canary.install(v.spec, v.specSha256, undefined);
        expect(r1.lock).toBeDefined();
        const r2 = await other.install(v.spec, v.specSha256, r1.lock);
        expect(r2.lockSha256).toBe(r1.lockSha256);
        expect(r2.digest).toBe(r1.digest);
        const report = await probe(other, v);
        expect(report.tools.length).toBeGreaterThan(0);
      } finally {
        await removeTree(join(a, 'mcp'));
        await removeTree(join(b, 'mcp'));
      }
    });

    it('PyPI: the pinned uv recipe, hashes, uv-managed CPython → stdio probe', async () => {
      const data = await tempDir('rw-online-py-');
      const tools = await ToolInstaller.open({
        ops: nodeOps(),
        dataDir: data,
        platform: recipePlatform(process.platform, process.arch),
        logger: createLogger({ sink: captureLines().sink }),
      });
      const i = await open(data, async () => (await tools.install('uv', UV_VERSION)).entry);
      const v = spec({
        id: 'time',
        version: '2026.10.10',
        transport: 'stdio',
        stdio: {
          package: {
            manager: 'pypi',
            name: 'mcp-server-time',
            version: '2026.10.10',
            integrity: 'sha256:32983d5193af219359ccdac46c558bed75f9c930360e7437cc040a73984cc17c',
          },
          bin: 'mcp-server-time',
        },
      });
      try {
        const r = await i.install(v.spec, v.specSha256, undefined);
        expect(r.manager).toBe('pypi');
        expect(r.lock).toBeDefined();
        const report = await probe(i, v);
        expect(report.tools.map((t) => t.name)).toContain('get_current_time');
      } finally {
        await removeTree(join(data, 'mcp'));
      }
    });
  },
);
