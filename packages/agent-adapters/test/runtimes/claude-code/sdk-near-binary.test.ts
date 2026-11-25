// A worker-managed Claude Code install (p5-remote-ops): the single-file worker bundle cannot resolve the SDK
// package, so its version is read next to the binary the worker runs (found on a real Windows worker:
// "claude-code 2.1.296+sdk.unknown differs from the policy pin 2.1.296").
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readClaudeSdkPackageInfoNear } from '../../../src/runtimes/claude-code/binary.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function layout(sdkPkg: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), 'sdk-near-'));
  dirs.push(root);
  const scope = join(root, 'node_modules', '@anthropic-ai');
  mkdirSync(join(scope, 'claude-agent-sdk-win32-x64'), { recursive: true });
  writeFileSync(join(scope, 'claude-agent-sdk-win32-x64', 'claude.exe'), '');
  if (sdkPkg !== null) {
    mkdirSync(join(scope, 'claude-agent-sdk'), { recursive: true });
    writeFileSync(join(scope, 'claude-agent-sdk', 'package.json'), JSON.stringify(sdkPkg));
  }
  return join(scope, 'claude-agent-sdk-win32-x64', 'claude.exe');
}

describe('readClaudeSdkPackageInfoNear', () => {
  it('reads the SDK version beside the managed platform binary', () => {
    const bin = layout({
      name: '@anthropic-ai/claude-agent-sdk',
      version: '0.3.296',
      claudeCodeVersion: '2.1.296',
    });
    const info = readClaudeSdkPackageInfoNear(bin);
    expect(info?.sdkVersion).toBe('0.3.296');
    expect(info?.claudeCodeVersion).toBe('2.1.296');
  });
  it('returns undefined without the SDK package or for a foreign package', () => {
    expect(readClaudeSdkPackageInfoNear(layout(null))).toBeUndefined();
    expect(
      readClaudeSdkPackageInfoNear(layout({ name: 'something-else', version: '1.0.0' })),
    ).toBeUndefined();
  });
});
