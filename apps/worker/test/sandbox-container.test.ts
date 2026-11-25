import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretValue } from '@remyral/agent-adapters';
import { describe, expect, it } from 'vitest';
import { buildRunArgs, attemptMounts, type ContainerRunSpec } from '../src/sandbox/container/args.js';
import { ContainerEngine, type EngineExec } from '../src/sandbox/container/engine.js';
import { ContainerSandboxRunner } from '../src/sandbox/container/runner.js';
import { SandboxRequestError, SandboxUnavailableError } from '../src/sandbox/errors.js';
import { DEFAULT_LIMITS, type SandboxContext } from '../src/sandbox/types.js';

const spec = (over: Partial<ContainerRunSpec> = {}): ContainerRunSpec => ({
  name: 'remyral-job-abc',
  image: 'remyral/runtime-pi:0.1.0',
  labels: { 'remyral.job': 'job1' },
  network: 'none',
  user: '10001:10001',
  limits: DEFAULT_LIMITS,
  mounts: attemptMounts({ workspacePath: '/w/jobs/job1/a1' }),
  workdir: '/workspace',
  envNames: ['ANTHROPIC_API_KEY', 'HOME'],
  stdin: true,
  command: 'pi',
  args: ['--mode', 'rpc'],
  ...over,
});

function pairs(args: readonly string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1] ?? '');
  });
  return out;
}

describe('container run args (ADR-0007 hardening)', () => {
  it('applies every hardening flag and puts the image after --', () => {
    const a = buildRunArgs(spec());
    expect(a[0]).toBe('run');
    expect(a).toContain('--read-only');
    expect(a).toContain('--init');
    expect(pairs(a, '--cap-drop')).toEqual(['ALL']);
    expect(pairs(a, '--security-opt')).toEqual(['no-new-privileges']);
    expect(pairs(a, '--user')).toEqual(['10001:10001']);
    expect(pairs(a, '--network')).toEqual(['none']);
    expect(pairs(a, '--pids-limit')).toEqual(['512']);
    expect(pairs(a, '--memory')).toEqual([`${String(4 * 1024 ** 3)}b`]);
    expect(pairs(a, '--memory-swap')).toEqual([`${String(4 * 1024 ** 3)}b`]);
    expect(pairs(a, '--pull')).toEqual(['never']);
    expect(pairs(a, '--log-driver')).toEqual(['none']);
    expect(pairs(a, '--tmpfs').every((t) => /nosuid,nodev/.test(t))).toBe(true);
    expect(pairs(a, '--mount')).toEqual(['type=bind,source=/w/jobs/job1/a1,target=/workspace']);
    expect(pairs(a, '--env')).toEqual(['ANTHROPIC_API_KEY', 'HOME']);
    const sep = a.indexOf('--');
    expect(a.slice(sep)).toEqual(['--', 'remyral/runtime-pi:0.1.0', 'pi', '--mode', 'rpc']);
    // Never: privileged, host namespaces, the engine socket, seccomp/apparmor off, published ports.
    const joined = a.join(' ');
    for (const bad of [
      '--privileged',
      'seccomp=unconfined',
      'apparmor=unconfined',
      '--pid host',
      '--network host',
      'docker.sock',
      '--publish',
      '-p ',
      '--cap-add',
    ]) {
      expect(joined).not.toContain(bad);
    }
  });

  it('mounts a git view: own git dir rw, .git overlay and mirror objects read-only', () => {
    const m = attemptMounts({
      workspacePath: '/w/jobs/j/a',
      git: {
        gitDir: '/w/sandboxes/j/a/git',
        mirrorObjects: '/w/mirrors/x.git/objects',
        containerDotGit: '/w/sandboxes/j/a/dotgit',
      },
    });
    expect(pairs(buildRunArgs(spec({ mounts: m })), '--mount')).toEqual([
      'type=bind,source=/w/jobs/j/a,target=/workspace',
      'type=bind,source=/w/sandboxes/j/a/dotgit,target=/workspace/.git,readonly',
      'type=bind,source=/w/sandboxes/j/a/git,target=/remyral/git',
      'type=bind,source=/w/mirrors/x.git/objects,target=/w/mirrors/x.git/objects,readonly',
    ]);
  });

  it('refuses root users, unsafe names/images/mount paths and bad env names', () => {
    for (const over of [
      { user: '0' },
      { user: '0:0' },
      { user: 'root' },
      { name: '../x' },
      { image: '--privileged' },
      { network: 'host;rm' },
      { envNames: ['A=B'] },
      { mounts: [{ source: '/a,readonly=false', target: '/workspace', readOnly: false }] },
      { mounts: [{ source: 'relative', target: '/workspace', readOnly: false }] },
    ] satisfies Partial<ContainerRunSpec>[]) {
      expect(() => buildRunArgs(spec(over)), JSON.stringify(over)).toThrow(SandboxRequestError);
    }
  });
});

interface Call {
  args: readonly string[];
}

function fakeEngine(over: { info?: object; images?: string[]; failOn?: string } = {}) {
  const calls: Call[] = [];
  const exec: EngineExec = (_bin, args) => {
    calls.push({ args });
    const sub = args[0] ?? '';
    if (over.failOn !== undefined && args.join(' ').includes(over.failOn)) {
      return Promise.resolve({ code: 1, stdout: '', stderr: 'boom' });
    }
    if (sub === 'info') {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(
          over.info ?? {
            SecurityOptions: ['name=seccomp,profile=builtin', 'name=rootless'],
            OSType: 'linux',
            Architecture: 'aarch64',
          },
        ),
        stderr: '',
      });
    }
    if (sub === 'image') {
      const ref = args[args.length - 1] ?? '';
      return Promise.resolve({
        code: (over.images ?? []).includes(ref) ? 0 : 1,
        stdout: 'sha256:x',
        stderr: '',
      });
    }
    if (sub === 'logs')
      return Promise.resolve({ code: 0, stdout: '{"event":"ready","port":3128}\n', stderr: '' });
    if (sub === 'container')
      return Promise.resolve({
        code: 0,
        stdout: '{"Running":false,"ExitCode":137,"OOMKilled":true}',
        stderr: '',
      });
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return {
    engine: new ContainerEngine({
      exec,
      sourceEnv: { PATH: '/usr/bin', HOME: '/home/w', AWS_SECRET_ACCESS_KEY: 'nope' },
    }),
    calls,
  };
}

const ctx: SandboxContext = {
  jobId: 'job1',
  attemptId: 'a1',
  runtime: 'pi',
  workspacePath: '/w/jobs/job1/a1',
  network: { mode: 'allowlist', targets: [{ host: 'api.anthropic.com', port: 443 }] },
  limits: DEFAULT_LIMITS,
};

describe('ContainerSandboxRunner (fake engine)', () => {
  const images = { pi: 'remyral/runtime-pi:0.1.0' };

  it('readiness: Linux only, rootless only, images present', async () => {
    const ok = fakeEngine({ images: ['remyral/runtime-pi:0.1.0', 'remyral/egress-proxy:0.1.0'] });
    const r = new ContainerSandboxRunner({
      engine: ok.engine,
      images,
      proxyImage: 'remyral/egress-proxy:0.1.0',
      platform: 'linux',
    });
    expect(await r.check('pi')).toEqual({ ready: true });
    expect(
      (
        await new ContainerSandboxRunner({
          engine: ok.engine,
          images,
          proxyImage: 'remyral/egress-proxy:0.1.0',
          platform: 'darwin',
        }).check('pi')
      ).reasonCode,
    ).toBe('profile_unsupported_on_os');
    const rootful = fakeEngine({
      info: { SecurityOptions: ['name=seccomp'] },
      images: ['remyral/runtime-pi:0.1.0', 'remyral/egress-proxy:0.1.0'],
    });
    expect(
      (
        await new ContainerSandboxRunner({
          engine: rootful.engine,
          images,
          proxyImage: 'remyral/egress-proxy:0.1.0',
          platform: 'linux',
        }).check('pi')
      ).reason,
    ).toMatch(/not rootless/);
    const noImg = fakeEngine({ images: ['remyral/egress-proxy:0.1.0'] });
    expect(
      (
        await new ContainerSandboxRunner({
          engine: noImg.engine,
          images,
          proxyImage: 'remyral/egress-proxy:0.1.0',
          platform: 'linux',
        }).check('pi')
      ).reasonCode,
    ).toBe('image_unavailable');
  });

  it('confines: internal network + proxy sidecar, secrets only by name, engine env allowlisted', async () => {
    const { engine, calls } = fakeEngine();
    const runner = new ContainerSandboxRunner({
      engine,
      images,
      proxyImage: 'remyral/egress-proxy:0.1.0',
      platform: 'linux',
    });
    const secret = new SecretValue('sk-canary-value-0123456789');
    const confined = await runner.confiner(ctx).confine({
      command: 'pi',
      args: ['--mode', 'rpc'],
      cwd: '/w/jobs/job1/a1',
      env: { PATH: '/host/bin', HOME: '/Users/w', ANTHROPIC_API_KEY: secret.reveal(), LANG: 'en_US.UTF-8' },
      secretNames: ['ANTHROPIC_API_KEY'],
    });
    expect(confined.command).toBe('docker');
    expect(confined.args.join(' ')).not.toContain(secret.reveal());
    expect(confined.env.ANTHROPIC_API_KEY).toBe(secret.reveal());
    expect(confined.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(confined.env.HOME).toBe('/home/remyral');
    expect(confined.env.HTTPS_PROXY).toBe('http://egress-proxy:3128');
    const net = pairs(confined.args, '--network')[0] ?? '';
    expect(net).toMatch(/^remyral-net-/);
    const created = calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create');
    expect(created?.args).toContain('--internal');
    const proxyRun = calls.find((c) => c.args[0] === 'run' && c.args.includes('--detach'));
    expect(proxyRun?.args).toContain('REMYRAL_EGRESS_ALLOW=api.anthropic.com:443');
    expect(proxyRun?.args).toContain('--read-only');
    expect(
      calls.some((c) => c.args[0] === 'network' && c.args[1] === 'connect' && c.args[2] === 'bridge'),
    ).toBe(true);
    expect(confined.treeKiller?.kind).toBe('container');

    await confined.dispose?.();
    const rm = calls.find((c) => c.args[0] === 'rm');
    expect(rm?.args.filter((a) => a.startsWith('remyral-'))).toHaveLength(2);
    expect(calls.some((c) => c.args[0] === 'network' && c.args[1] === 'rm' && c.args[2] === net)).toBe(true);
  });

  it('network none: no network, no proxy', async () => {
    const { engine, calls } = fakeEngine();
    const runner = new ContainerSandboxRunner({ engine, images, proxyImage: 'p', platform: 'linux' });
    const confined = await runner
      .confiner({ ...ctx, network: { mode: 'none' } })
      .confine({ command: 'pi', args: [], cwd: '/', env: {}, secretNames: [] });
    expect(pairs(confined.args, '--network')).toEqual(['none']);
    expect(confined.env.HTTPS_PROXY).toBeUndefined();
    expect(calls.filter((c) => c.args[0] === 'network')).toEqual([]);
  });

  it('cleans up the network when the proxy fails to start', async () => {
    const { engine, calls } = fakeEngine({ failOn: '--detach' });
    const runner = new ContainerSandboxRunner({ engine, images, proxyImage: 'p', platform: 'linux' });
    await expect(
      runner.confiner(ctx).confine({ command: 'pi', args: [], cwd: '/', env: {}, secretNames: [] }),
    ).rejects.toThrow(/run egress proxy/);
    expect(calls.some((c) => c.args[0] === 'network' && c.args[1] === 'rm')).toBe(true);
  });

  it('p6-warm-caches (ADR-0029): refuses a context that carries a shared package cache; nothing is started', async () => {
    const { engine, calls } = fakeEngine();
    const runner = new ContainerSandboxRunner({ engine, images, proxyImage: 'p', platform: 'linux' });
    await expect(
      runner
        .confiner({ ...ctx, packageCaches: { dirs: ['/d/caches/host/k'], env: { npm_config_cache: '/x' } } })
        .confine({ command: 'pi', args: [], cwd: '/', env: {}, secretNames: [] }),
    ).rejects.toBeInstanceOf(SandboxRequestError);
    expect(calls).toEqual([]);
  });

  it('refuses a runtime without a configured image', async () => {
    const { engine } = fakeEngine();
    const runner = new ContainerSandboxRunner({ engine, images: {}, proxyImage: 'p', platform: 'linux' });
    await expect(
      runner.confiner(ctx).confine({ command: 'pi', args: [], cwd: '/', env: {}, secretNames: [] }),
    ).rejects.toBeInstanceOf(SandboxUnavailableError);
  });

  it('runtime state and operator files: same-path mounts, image command; never writable outside the attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-ctr-'));
    const sandboxDir = join(dir, 'sandboxes', 'job1', 'a1');
    const state = join(sandboxDir, 'runtime');
    await mkdir(state, { recursive: true });
    const ext = join(dir, 'ext.mjs');
    await writeFile(ext, 'export default () => {}\n');
    const git = {
      sandboxDir,
      gitDir: join(sandboxDir, 'git'),
      mirrorObjects: '/w/mirrors/x.git/objects',
      containerDotGit: join(sandboxDir, 'dotgit'),
      branch: 'rac/job1/a1',
      hostEnv: {},
    };
    const { engine } = fakeEngine();
    const runner = new ContainerSandboxRunner({ engine, images, proxyImage: 'p', platform: 'linux' });
    const confined = await runner
      .confiner({
        ...ctx,
        network: { mode: 'none' },
        git,
        containerCommand: 'pi',
        runtimeMounts: [
          { path: state, readOnly: false },
          { path: ext, readOnly: true },
        ],
      })
      .confine({ command: '/opt/host/bin/pi', args: ['-e', ext], cwd: '/', env: {}, secretNames: [] });
    const mounts = pairs(confined.args, '--mount');
    const realState = await realpath(state);
    const realExt = await realpath(ext);
    expect(mounts).toContain(`type=bind,source=${realState},target=${state}`);
    expect(mounts).toContain(`type=bind,source=${realExt},target=${ext},readonly`);
    const sep = confined.args.indexOf('--');
    expect(confined.args.slice(sep + 2)).toEqual(['pi', '-e', ext]);
    for (const bad of [
      [{ path: dir, readOnly: false }], // the whole root, writable
      [{ path: sandboxDir, readOnly: false }], // the sandbox dir itself (git dir inside)
      [{ path: state, readOnly: true }], // read-only mounts must be files
      [{ path: join(dir, 'missing'), readOnly: true }],
    ]) {
      await expect(
        runner
          .confiner({ ...ctx, network: { mode: 'none' }, git, runtimeMounts: bad })
          .confine({ command: 'pi', args: [], cwd: '/', env: {}, secretNames: [] }),
        JSON.stringify(bad),
      ).rejects.toBeInstanceOf(SandboxRequestError);
    }
    await rm(dir, { recursive: true, force: true });
  });
});
