import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config/load.js';
import { configLocations } from '../src/config/paths.js';
import { workerConfigSchema } from '../src/config/schema.js';
import { isWindows, nodeOps, opsWithStats, pathHost, tempDir } from './helpers.js';

const base = {
  masterUrl: 'wss://master.example.com/v1/worker',
  workspaceRoot: '/srv/remyral/work',
};

describe('config schema', () => {
  const linux = workerConfigSchema('linux');

  it('applies defaults', () => {
    expect(linux.parse(base)).toEqual({
      ...base,
      maxParallelJobs: 1,
      allowedRuntimes: [],
      logLevel: 'info',
      keystore: 'file',
      workspace: {
        projects: {},
        retainFailed: 5,
        minFreeBytes: 2 * 1024 ** 3,
        submodules: 'skip',
        symlinks: 'refuse-escaping',
        scratch: { enabled: true, maxEgress: 'web', projects: {} },
      },
      secretStore: 'file',
      runtimeAuth: {},
      runtimes: {},
      devFakeRuntime: false,
      updates: { enabled: true, channel: 'stable', healthTimeoutSec: 90, catalog: true },
      skills: {},
      remoteOps: { disabled: [], logFileBytes: 4 * 1024 * 1024 },
      assistant: { disabled: false, maxSessions: 8, sandbox: 'auto' },
      packageCaches: { enabled: true, maxBytes: 10 * 1024 ** 3 },
      sandbox: {
        seatbelt: 'required',
        protectedHomes: [],
        keepHome: false,
        hostExtraWritable: [],
        allowKeychain: false,
        linuxHostIsolation: 'auto',
        linuxPrivateNetwork: 'off',
        linuxLoginStoreView: false,
        egressAllow: ['api.anthropic.com', 'api.openai.com'],
        limits: {},
        container: {
          engine: 'docker',
          images: {},
          proxyImage: 'remyral/egress-proxy:0.1.0',
          egressNetwork: 'bridge',
          user: '10001:10001',
        },
      },
    });
  });

  it('runtime adapter settings: absolute binaries, no literal credentials, fake runtime only on a dev master', () => {
    const ok = linux.parse({
      ...base,
      runtimes: {
        pi: { binary: '/opt/pi/bin/pi', provider: 'anthropic', model: 'anthropic/claude-x' },
        opencode: {
          binary: '/opt/oc/opencode',
          config: { provider: { x: { options: { apiKey: '{env:X_API_KEY}' } } } },
        },
      },
    });
    expect(ok.runtimes.pi).toMatchObject({ binary: '/opt/pi/bin/pi', extensions: [] });
    expect(linux.safeParse({ ...base, runtimes: { pi: { binary: 'pi' } } }).success).toBe(false);
    const literal = linux.safeParse({
      ...base,
      runtimes: { opencode: { config: { provider: { x: { options: { apiKey: 'sk-live-123' } } } } } },
    });
    expect(literal.success).toBe(false);
    expect(JSON.stringify(literal.error?.issues)).toContain('provider.x.options.apiKey');
    expect(JSON.stringify(literal.error?.issues)).not.toContain('sk-live-123');
    // The fake runtime reports success without running anything: refused for a real master.
    expect(linux.safeParse({ ...base, devFakeRuntime: true }).success).toBe(false);
    expect(
      linux.safeParse({ ...base, masterUrl: 'ws://127.0.0.1:8080/v1/worker', devFakeRuntime: true }).success,
    ).toBe(true);
  });

  it('validates the workspace project allowlist (p3-workspace)', () => {
    const ok = linux.parse({
      ...base,
      workspace: { projects: { web: ['https://github.com/org/web.git', 'ssh://git@github.com/org/lib'] } },
    });
    expect(ok.workspace.projects.web).toHaveLength(2);
    for (const projects of [
      { web: ['https://x-access-token:t0ken@github.com/org/web'] },
      { web: ['http://github.com/org/web'] },
      { web: ['file:///srv/repos/web.git'] },
      { '../web': ['https://github.com/org/web'] },
      { 'a:b': ['https://github.com/org/web'] },
    ]) {
      expect(linux.safeParse({ ...base, workspace: { projects } }).success, JSON.stringify(projects)).toBe(
        false,
      );
    }
    expect(linux.safeParse({ ...base, workspace: { projectz: {} } }).success).toBe(false);
  });

  it('validates secret store and per-runtime auth (p3-secrets-worker)', () => {
    const ok = linux.parse({
      ...base,
      secretStore: 'macos-keychain',
      keychainPath: '/Users/w/Library/Keychains/remyral.keychain-db',
      runtimeAuth: {
        'claude-code': { mode: 'local-login' },
        codex: { mode: 'secret-ref', ref: 'secret:openai' },
        opencode: { mode: 'secret-ref', ref: 'worker:w-1/secret:anthropic', env: 'ANTHROPIC_API_KEY' },
      },
    });
    expect(ok.runtimeAuth.codex).toEqual({ mode: 'secret-ref', ref: 'secret:openai' });
    for (const bad of [
      { secretStore: 'vault' },
      { keychainPath: 'relative/kc' },
      { runtimeAuth: { cursor: { mode: 'local-login' } } },
      { runtimeAuth: { codex: { mode: 'secret-ref', ref: 'openai' } } },
      { runtimeAuth: { codex: { mode: 'secret-ref', ref: 'secret:a/b' } } },
      {
        runtimeAuth: {
          'claude-code': { mode: 'secret-ref', ref: 'secret:x', env: 'CLAUDE_CODE_OAUTH_TOKEN' },
        },
      },
      { runtimeAuth: { codex: { mode: 'local-login', ref: 'secret:x' } } },
      { runtimeAuth: { codex: { mode: 'api-key-in-config', value: 'sk-...' } } },
    ]) {
      expect(linux.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it.each([
    ['wss://master.example.com/v1/worker', true],
    ['wss://10.0.0.5:8443/v1/worker', true],
    ['ws://127.0.0.1:3000/v1/worker', true],
    ['ws://localhost:3000/v1/worker', true],
    ['ws://[::1]:3000/v1/worker', true],
    ['ws://master.example.com/v1/worker', false],
    ['ws://192.168.1.10/v1/worker', false],
    ['ws://127.0.0.1.nip.io/v1/worker', false],
    ['https://master.example.com', false],
    ['wss://user:pw@master.example.com/v1/worker', false],
    ['wss://master.example.com/v1/worker?token=abc', false],
    ['master.example.com', false],
  ])('masterUrl %s → valid=%s', (masterUrl, ok) => {
    expect(linux.safeParse({ ...base, masterUrl }).success).toBe(ok);
  });

  it('rejects unknown keys, bad ranges, duplicate or unknown runtimes, relative paths', () => {
    for (const bad of [
      { ...base, maxParalelJobs: 2 },
      { ...base, maxParallelJobs: 0 },
      { ...base, maxParallelJobs: 65 },
      { ...base, maxParallelJobs: 1.5 },
      { ...base, allowedRuntimes: ['codex', 'codex'] },
      { ...base, allowedRuntimes: ['gpt'] },
      { ...base, workspaceRoot: 'work' },
      { ...base, dataDir: './data' },
      { ...base, logLevel: 'verbose' },
      { ...base, keystore: 'tpm' },
    ]) {
      expect(linux.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('checks absolute paths for the target platform', () => {
    const win = workerConfigSchema('win32');
    expect(win.safeParse({ ...base, workspaceRoot: 'C:\\RemyralWork' }).success).toBe(true);
    expect(win.safeParse({ ...base, workspaceRoot: '\\\\server\\share\\work' }).success).toBe(true);
    expect(win.safeParse({ ...base, workspaceRoot: '/srv/work' }).success).toBe(false);
    expect(linux.safeParse({ ...base, workspaceRoot: 'C:\\RemyralWork' }).success).toBe(false);
  });
});

describe('config locations', () => {
  it('linux: user XDG then /etc; root only /etc; relative XDG ignored', () => {
    const user = configLocations(
      pathHost({ platform: 'linux', env: (n) => (n === 'XDG_CONFIG_HOME' ? '/x/cfg' : undefined) }),
    );
    expect(user.map((l) => l.configPath)).toEqual([
      '/x/cfg/remyral-worker/config.json',
      '/etc/remyral-worker/config.json',
    ]);
    expect(user[0]?.defaultDataDir).toBe('/home/w/.local/state/remyral-worker');
    const root = configLocations(pathHost({ platform: 'linux', isPrivileged: true }));
    expect(root).toEqual([
      {
        scope: 'system',
        configPath: '/etc/remyral-worker/config.json',
        defaultDataDir: '/var/lib/remyral-worker',
      },
    ]);
    const rel = configLocations(
      pathHost({ platform: 'linux', env: (n) => (n === 'XDG_CONFIG_HOME' ? 'cfg' : undefined) }),
    );
    expect(rel[0]?.configPath).toBe('/home/w/.config/remyral-worker/config.json');
  });

  it('macOS: user Library then /Library', () => {
    expect(configLocations(pathHost({ platform: 'darwin' })).map((l) => l.configPath)).toEqual([
      '/home/w/Library/Application Support/RemyralWorker/config.json',
      '/Library/Application Support/RemyralWorker/config.json',
    ]);
  });

  it('windows: %ProgramData%', () => {
    const locs = configLocations(
      pathHost({
        platform: 'win32',
        isPrivileged: true,
        env: (n) => (n === 'ProgramData' ? 'D:\\PD' : undefined),
      }),
    );
    expect(locs).toEqual([
      {
        scope: 'system',
        configPath: 'D:\\PD\\RemyralWorker\\config.json',
        defaultDataDir: 'D:\\PD\\RemyralWorker\\data',
      },
    ]);
  });
});

describe('loadConfig', () => {
  async function setup(content: unknown, mode = 0o600) {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    const config = {
      masterUrl: 'wss://m.example.com/v1/worker',
      workspaceRoot: join(dir, 'work'),
      dataDir: join(dir, 'data'),
      ...(content as object),
    };
    await writeFile(path, typeof content === 'string' ? content : JSON.stringify(config), { mode });
    return { dir, path, config };
  }

  it('loads a valid file and creates dataDir 0700', async () => {
    const { path, config, dir } = await setup({ maxParallelJobs: 3, allowedRuntimes: ['codex'] });
    const loaded = await loadConfig(nodeOps(), pathHost(), { explicitPath: path });
    expect(loaded).toMatchObject({ ...config, maxParallelJobs: 3, source: path });
    const st = await nodeOps().stat(join(dir, 'data'));
    expect(st?.isDirectory).toBe(true);
    if (!isWindows) expect(st?.mode).toBe(0o700);
  });

  it('honours REMYRAL_WORKER_CONFIG', async () => {
    const { path } = await setup({});
    const loaded = await loadConfig(
      nodeOps(),
      pathHost({ env: (n) => (n === 'REMYRAL_WORKER_CONFIG' ? path : undefined) }),
    );
    expect(loaded.source).toBe(path);
  });

  it('reports every schema problem with its path', async () => {
    const { path } = await setup({ masterUrl: 'ws://evil.example.com', maxParallelJobs: 0, extra: 1 });
    const error = await loadConfig(nodeOps(), pathHost(), { explicitPath: path }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    const msg = (error as Error).message;
    expect(msg).toContain('masterUrl: plain ws:// is only allowed');
    expect(msg).toContain('maxParallelJobs');
    expect(msg).toContain('extra');
  });

  it('rejects invalid JSON, a missing file and a too-large file', async () => {
    const { path } = await setup('{ not json');
    await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: path })).rejects.toThrow(/not valid JSON/);
    await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: `${path}.missing` })).rejects.toThrow(
      /does not exist/,
    );
    const big = await setup(`{"a":"${'x'.repeat(70 * 1024)}"}`);
    await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: big.path })).rejects.toThrow(/64 KiB/);
  });

  it('explains where it looked when no config exists', async () => {
    const dir = await tempDir();
    const host = pathHost({ platform: 'linux', env: (n) => (n === 'XDG_CONFIG_HOME' ? dir : undefined) });
    await expect(loadConfig(nodeOps(), host)).rejects.toThrow(
      /no config file found[\s\S]*remyral-worker\/config.json/,
    );
  });

  it('refuses dataDir inside workspaceRoot', async () => {
    const dir = await tempDir();
    const { path } = await setup({ workspaceRoot: join(dir, 'w'), dataDir: join(dir, 'w', 'data') });
    await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: path })).rejects.toThrow(
      /inside workspaceRoot/,
    );
  });

  describe.skipIf(isWindows)('POSIX permissions', () => {
    it('refuses a world-writable config file', async () => {
      const { path } = await setup({});
      await chmod(path, 0o666);
      await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: path })).rejects.toThrow(
        /world-writable/,
      );
    });

    it('refuses a world-writable config directory', async () => {
      const { path, dir } = await setup({});
      await expect(
        loadConfig(opsWithStats({ [dir]: { mode: 0o777 } }), pathHost(), { explicitPath: path }),
      ).rejects.toThrow(/world-writable/);
    });

    it('refuses a config owned by another unprivileged user', async () => {
      const { path } = await setup({});
      await expect(
        loadConfig(opsWithStats({ [path]: { uid: 4242 } }), pathHost(), { explicitPath: path }),
      ).rejects.toThrow(/owned by uid 4242/);
    });

    it('refuses a group/world-writable dataDir and a world-writable workspaceRoot', async () => {
      const { path, config } = await setup({});
      await mkdir(config.dataDir, { mode: 0o700 });
      await chmod(config.dataDir, 0o770);
      await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: path })).rejects.toThrow(/chmod 700/);
      await chmod(config.dataDir, 0o700);
      await mkdir(config.workspaceRoot);
      await chmod(config.workspaceRoot, 0o777);
      await expect(loadConfig(nodeOps(), pathHost(), { explicitPath: path })).rejects.toThrow(
        /world-writable/,
      );
    });
  });
});
