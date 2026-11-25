import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  CustomToolInstall,
  CustomToolRecipe,
  customPackageCommands,
  customPackagePrompt,
  customToolRecipeIssues,
  isAllowedCustomToolUrl,
  isSafeRelativePath,
  normalizeVersion,
  OpsOperation,
  resolveEffectiveTools,
  ToolInventoryReport,
  versionStatus,
} from '../src/index.js';

const SHA = 'a'.repeat(64);

describe('versions', () => {
  it('normalizes upstream spellings', () => {
    expect(normalizeVersion('v2.56.0.windows.2')).toBe('2.56.0.2');
    expect(normalizeVersion('n7.1')).toBe('7.1');
    expect(normalizeVersion('2.1.296 (Claude Code)')).toBe('2.1.296');
    expect(normalizeVersion('7.1.1-1ubuntu1')).toBe('7.1.1');
    expect(normalizeVersion('cloudflared')).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
  });

  it('compares numerically', () => {
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.56.0.2', 'v2.56.0.windows.2')).toBe(0);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.162.1', '0.163.0')).toBe(-1);
    expect(compareVersions('x', '1')).toBeNull();
  });

  it('derives the status chip', () => {
    expect(versionStatus({ installed: null, pinned: '1.0.0', latest: '1.0.0' })).toBe('not_found');
    expect(versionStatus({ installed: '1.0.0', pinned: '1.1.0', latest: '1.1.0' })).toBe('pin_differs');
    expect(versionStatus({ installed: '1.1.0', pinned: '1.1.0', latest: '1.2.0' })).toBe('update_available');
    expect(versionStatus({ installed: '1.1.0', pinned: '1.1.0', latest: null })).toBe('current');
    expect(versionStatus({ installed: '1.1.0', latest: '1.1.0' })).toBe('current');
    expect(versionStatus({ installed: '1.1.0' })).toBe('unknown');
    // A newer local build than the feed (pre-release) is not an update.
    expect(versionStatus({ installed: '2.0.0', latest: '1.9.0' })).toBe('current');
  });
});

describe('resolveEffectiveTools', () => {
  it('prefers a found managed install over the system one and leaves out tools found nowhere', () => {
    const eff = resolveEffectiveTools([
      { name: 'git', found: false, source: 'system' },
      { name: 'node', found: true, source: 'system', version: '24.21.0', path: 'C:\\node\\node.exe' },
      { name: 'git', found: true, source: 'managed', version: '2.56.0.2', path: 'D:\\t\\git.exe' },
      { name: 'python', found: true, source: 'system', version: '3.12.1' },
      { name: 'python', found: true, source: 'managed', version: '3.13.16' },
      { name: 'docker', found: false, source: 'system' },
    ]);
    expect(eff).toEqual([
      { name: 'git', source: 'managed', version: '2.56.0.2', path: 'D:\\t\\git.exe' },
      { name: 'node', source: 'system', version: '24.21.0', path: 'C:\\node\\node.exe' },
      { name: 'python', source: 'managed', version: '3.13.16' },
    ]);
  });

  it('the newest managed install wins; the configured gitBinary wins over everything', () => {
    const tools = [
      { name: 'git', found: true, source: 'system' as const, version: '2.40.0', path: '/usr/bin/git' },
      { name: 'git', found: true, source: 'managed' as const, version: '2.50.0' },
      { name: 'git', found: true, source: 'managed' as const, version: '2.56.0.2' },
    ];
    expect(resolveEffectiveTools(tools)[0]?.version).toBe('2.56.0.2');
    expect(resolveEffectiveTools(tools, { gitBinary: '/usr/bin/git' })[0]).toEqual({
      name: 'git',
      source: 'config',
      path: '/usr/bin/git',
      version: '2.40.0',
    });
  });

  it('is additive on the inventory report', () => {
    const base = { detectedAt: new Date().toISOString(), ttlSec: 60, tools: [], recipes: [] };
    expect(ToolInventoryReport.parse(base).effective).toBeUndefined();
    expect(
      ToolInventoryReport.parse({ ...base, effective: [{ name: 'git', source: 'managed' }] }).effective,
    ).toHaveLength(1);
  });
});

describe('custom tool recipes', () => {
  const download = {
    kind: 'download' as const,
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/ripgrep-15.0.0-x86_64-pc-windows-msvc.zip',
    sha256: SHA,
    size: 2_000_000,
    format: 'zip' as const,
    strip: 'ripgrep-15.0.0-x86_64-pc-windows-msvc',
    entry: 'rg.exe',
  };

  it('accepts a valid recipe and defaults the version check', () => {
    const r = CustomToolRecipe.parse({
      name: 'ripgrep',
      title: 'ripgrep',
      version: '15.0.0',
      platforms: { 'win32-x64': download },
      check: {},
    });
    expect(r.check.args).toEqual(['--version']);
    expect(r.pinPackageVersion).toBe(true);
    expect(customToolRecipeIssues(r)).toEqual([]);
  });

  it('refuses hosts outside the allowlist, plain http, credentials and ports', () => {
    expect(isAllowedCustomToolUrl('https://github.com/a/b/releases/download/1/x.zip')).toBe(true);
    expect(isAllowedCustomToolUrl('http://github.com/x.zip')).toBe(false);
    expect(isAllowedCustomToolUrl('https://evil.example/x.zip')).toBe(false);
    expect(isAllowedCustomToolUrl('https://github.com.evil.example/x.zip')).toBe(false);
    expect(isAllowedCustomToolUrl('https://u:p@github.com/x.zip')).toBe(false);
    expect(isAllowedCustomToolUrl('https://github.com:8443/x.zip')).toBe(false);
    const bad = CustomToolRecipe.safeParse({
      name: 'evil',
      title: 'x',
      version: '1.0.0',
      platforms: { 'linux-x64': { ...download, url: 'https://evil.example/x.zip' } },
      check: {},
    });
    expect(bad.success).toBe(false);
  });

  it('requires a checksum and a size', () => {
    const { sha256: _s, ...noSha } = download;
    expect(
      CustomToolRecipe.safeParse({
        name: 'x1',
        title: 'x',
        version: '1.0.0',
        platforms: { 'win32-x64': noSha },
        check: {},
      }).success,
    ).toBe(false);
    expect(
      CustomToolRecipe.safeParse({
        name: 'x1',
        title: 'x',
        version: '1.0.0',
        platforms: { 'win32-x64': { ...download, size: 0 } },
        check: {},
      }).success,
    ).toBe(false);
  });

  it('refuses reserved names and unsafe paths', () => {
    expect(
      CustomToolRecipe.safeParse({
        name: 'git',
        title: 'x',
        version: '1.0.0',
        platforms: { 'win32-x64': download },
        check: {},
      }).success,
    ).toBe(false);
    for (const p of ['../x', '/abs', 'a/../b', 'C:\\x.exe', 'a\\b', './x', '']) {
      expect(isSafeRelativePath(p)).toBe(false);
    }
    expect(isSafeRelativePath('bin/tool.exe')).toBe(true);
  });

  it('refuses free-form check arguments', () => {
    expect(
      CustomToolRecipe.safeParse({
        name: 'x1',
        title: 'x',
        version: '1.0.0',
        platforms: { 'win32-x64': download },
        check: { args: ['--version; rm -rf /'] },
      }).success,
    ).toBe(false);
  });

  it('checks package managers against the OS and their id syntax', () => {
    const r = CustomToolRecipe.parse({
      name: 'jq-tool',
      title: 'jq',
      version: '1.8.1',
      platforms: {
        'win32-x64': { kind: 'package', manager: 'apt', package: 'jq' },
        'linux-x64': { kind: 'package', manager: 'apt', package: 'jq; curl evil' },
        'darwin-arm64': { kind: 'package', manager: 'brew', package: 'jq' },
      },
      check: {},
    });
    expect(customToolRecipeIssues(r)).toEqual(
      expect.arrayContaining([
        { path: 'platforms.win32-x64.manager', code: 'manager_not_for_os' },
        { path: 'platforms.linux-x64.package', code: 'package_id_invalid' },
        { path: 'check.binary', code: 'binary_required' },
      ]),
    );
  });

  it('builds exact package commands and a fixed prompt', () => {
    expect(customPackageCommands({ manager: 'npm', package: '@scope/cli' }, '2.0.0').commands).toEqual([
      'npm install -g @scope/cli@2.0.0',
    ]);
    expect(customPackageCommands({ manager: 'winget', package: 'jqlang.jq' }, null).commands[0]).toContain(
      'winget install --id jqlang.jq --exact',
    );
    expect(() => customPackageCommands({ manager: 'apt', package: 'jq && curl x' }, null)).toThrow();
    const r = CustomToolRecipe.parse({
      name: 'jq-tool',
      title: 'jq',
      version: '1.8.1',
      platforms: { 'linux-x64': { kind: 'package', manager: 'apt', package: 'jq' } },
      check: { binary: 'jq' },
    });
    const prompt = customPackagePrompt(r, 'linux-x64');
    expect(prompt).toContain(
      '`DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq=1.8.1`',
    );
    expect(prompt).toContain('`jq --version`');
  });

  it('carries only a download in the ops command', () => {
    const { kind: _kind, ...dl } = download;
    const recipe = CustomToolInstall.parse({
      name: 'ripgrep',
      version: '15.0.0',
      download: dl,
      check: { args: ['--version'] },
    });
    expect(OpsOperation.parse({ kind: 'tool.install.custom', recipe }).kind).toBe('tool.install.custom');
    expect(
      OpsOperation.safeParse({
        kind: 'tool.install.custom',
        recipe: { ...recipe, download: { ...recipe.download, url: 'https://evil.example/a' } },
      }).success,
    ).toBe(false);
  });
});
