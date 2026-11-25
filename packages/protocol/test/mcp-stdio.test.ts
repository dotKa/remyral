import { describe, expect, it } from 'vitest';
import {
  McpInstallOp,
  McpInstallReport,
  McpSpec,
  OpsOperation,
  OpsUpdatePayload,
  pypiNormalize,
  WorkerFeature,
} from '../src/index.js';

/** p14-mcp-stdio: the stdio spec rules and the P4 wire shapes (additive in 1.0). */
const base = {
  schema: 1,
  kind: 'remana.mcp',
  id: 'files',
  version: '1.0.0',
  transport: 'stdio',
  secrets: [],
  egressHosts: [],
  runtimes: ['codex'],
  limits: { startupTimeoutSec: 30, toolTimeoutSec: 120 },
  createdAt: '2026-10-21T10:00:00.000Z',
};
const npm = {
  manager: 'npm',
  name: '@acme/mcp-files',
  version: '1.0.0',
  integrity: `sha512-${'A'.repeat(86)}==`,
};

describe('stdio specs', () => {
  it('npm needs a sha512 integrity, PyPI a sha256 of a release file', () => {
    expect(McpSpec.safeParse({ ...base, stdio: { package: npm, bin: 'mcp-files' } }).success).toBe(true);
    expect(
      McpSpec.safeParse({
        ...base,
        stdio: { package: { ...npm, integrity: `sha256:${'a'.repeat(64)}` }, bin: 'x' },
      }).success,
    ).toBe(false);
    expect(
      McpSpec.safeParse({
        ...base,
        stdio: {
          package: {
            manager: 'pypi',
            name: 'mcp-server-time',
            version: '2026.10.10',
            integrity: `sha256:${'a'.repeat(64)}`,
          },
          bin: 'mcp-server-time',
        },
      }).success,
    ).toBe(true);
    expect(
      McpSpec.safeParse({ ...base, stdio: { package: { ...npm, name: 'Upper' }, bin: 'x' } }).success,
    ).toBe(false);
  });

  it('refuses env names the launcher owns or that change what code runs', () => {
    for (const name of [
      'PATH',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
      'PYTHONPATH',
      'HTTPS_PROXY',
      'REMYRAL_X',
    ]) {
      expect(
        McpSpec.safeParse({ ...base, stdio: { package: npm, bin: 'x', env: { [name]: 'v' } } }).success,
        name,
      ).toBe(false);
    }
    expect(
      McpSpec.safeParse({ ...base, stdio: { package: npm, bin: 'x', env: { FILES_MODE: 'safe' } } }).success,
    ).toBe(true);
  });

  it('wire shapes: mcp.install / mcp.remove ops, OPS_UPDATE mcpInstall, the feature', () => {
    const signed = {
      spec: Buffer.from('{}').toString('base64'),
      signature: { keyId: 'k'.repeat(16), signature: 'x' },
    };
    expect(
      McpInstallOp.safeParse({ kind: 'mcp.install', server: signed, lock: { manager: 'npm' } }).success,
    ).toBe(false);
    expect(OpsOperation.safeParse({ kind: 'mcp.remove', id: 'files', version: '1.0.0' }).success).toBe(true);
    const report = {
      id: 'files',
      version: '1.0.0',
      manager: 'npm',
      digest: `sha256:${'d'.repeat(64)}`,
      lockSha256: 'e'.repeat(64),
      bytes: 1,
      files: 1,
    };
    expect(McpInstallReport.safeParse(report).success).toBe(true);
    expect(
      OpsUpdatePayload.safeParse({
        commandId: '00000000-0000-4000-8000-000000000000',
        seq: 1,
        kind: 'mcp.install',
        state: 'succeeded',
        mcpInstall: report,
      }).success,
    ).toBe(true);
    expect(WorkerFeature.safeParse('mcp-stdio-v1').success).toBe(true);
    expect(pypiNormalize('MCP_Server.Time')).toBe('mcp-server-time');
  });
});
