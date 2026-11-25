import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  buildChildEnv,
  CancelTimeoutError,
  posixTreeKiller,
  RuntimeCrashedError,
  SecretInArgvError,
  SecretValue,
  spawnOwnedProcess,
  TailBuffer,
  windowsTreeKiller,
  type OwnedProcess,
  type ProcessConfiner,
  type ProcessTreeKiller,
  type SpawnPlan,
} from '../src/index.js';

const TREE_PARENT = fileURLToPath(new URL('./fixtures/tree-parent.mjs', import.meta.url));
const posixOnly = process.platform === 'win32' ? it.skip : it;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

async function readPids(proc: OwnedProcess): Promise<{ parent: number; grandchild: number }> {
  return new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)) as { parent: number; grandchild: number });
    });
    setTimeout(() => {
      reject(new Error('fixture did not report pids'));
    }, 5000);
  });
}

async function startTree(mode: 'default' | 'ignore-term' | 'exit-on-term') {
  const proc = await spawnOwnedProcess({
    command: process.execPath,
    args: [TREE_PARENT, mode],
    cwd: process.cwd(),
  });
  const pids = await readPids(proc);
  expect(pids.parent).toBe(proc.pid);
  expect(alive(pids.grandchild)).toBe(true);
  return { proc, pids };
}

describe('spawnOwnedProcess (real children on this host)', () => {
  posixOnly('graceful terminate kills parent and grandchild', async () => {
    const { proc, pids } = await startTree('default');
    const out = await proc.terminate({ graceMs: 2000 });
    expect(out.mode).toBe('graceful');
    expect(out.exit.signal).toBe('SIGTERM');
    expect(await waitDead(pids.parent)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
  });

  posixOnly('forced terminate kills a tree that ignores SIGTERM after the grace period', async () => {
    const { proc, pids } = await startTree('ignore-term');
    const t0 = Date.now();
    const out = await proc.terminate({ graceMs: 300 });
    expect(out.mode).toBe('forced');
    expect(out.exit.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(await waitDead(pids.parent)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
  });

  posixOnly('a grandchild that ignores SIGTERM does not survive its parent exiting gracefully', async () => {
    const { proc, pids } = await startTree('exit-on-term');
    const out = await proc.terminate({ graceMs: 2000 });
    expect(out.mode).toBe('graceful');
    expect(await waitDead(pids.parent)).toBe(true);
    expect(await waitDead(pids.grandchild)).toBe(true);
  });

  posixOnly('terminate after the leader exited still reaps orphaned descendants', async () => {
    const { proc, pids } = await startTree('default');
    process.kill(pids.parent, 'SIGKILL');
    await proc.exited;
    expect(alive(pids.grandchild)).toBe(true);
    const out = await proc.terminate({ graceMs: 100 });
    expect(out.mode).toBe('already-exited');
    expect(await waitDead(pids.grandchild)).toBe(true);
  });

  it('concurrent terminate calls share one termination', async () => {
    const { proc } = await startTree('default');
    const [a, b] = await Promise.all([proc.terminate({ graceMs: 1000 }), proc.terminate({ graceMs: 1000 })]);
    expect(a).toBe(b);
  });

  it('passes secrets via env only and redacts them from captured output', async () => {
    const secret = new SecretValue('s3cr3t-value-123');
    const proc = await spawnOwnedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("key=" + process.env.MY_KEY + " home=" + typeof process.env.HOME)'],
      cwd: process.cwd(),
      secretEnv: { MY_KEY: secret },
    });
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    await new Promise((r) => setImmediate(r));
    expect(proc.stdoutTail()).toBe('key=[REDACTED] home=string');
    expect(proc.child.spawnargs.join(' ')).not.toContain(secret.reveal());
  });

  it('refuses a secret in argv', async () => {
    const secret = new SecretValue('argv-secret-xyz');
    await expect(
      spawnOwnedProcess({
        command: process.execPath,
        args: ['--key=argv-secret-xyz'],
        cwd: '/',
        secretEnv: { K: secret },
      }),
    ).rejects.toBeInstanceOf(SecretInArgvError);
  });

  it('does not inherit worker env beyond the allowlist', () => {
    const env = buildChildEnv({
      command: 'x',
      args: [],
      cwd: '/',
      sourceEnv: { PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'nope', HOME: '/h' },
      env: { EXTRA: '1' },
      secretEnv: { API_KEY: new SecretValue('k') },
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', EXTRA: '1', API_KEY: 'k' });
  });

  it('rejects with RuntimeCrashedError when the binary cannot start', async () => {
    await expect(
      spawnOwnedProcess({ command: '/nonexistent/remyral-binary', args: [], cwd: process.cwd() }),
    ).rejects.toBeInstanceOf(RuntimeCrashedError);
  });

  it('bounds captured stdout', async () => {
    const proc = await spawnOwnedProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("a".repeat(10000) + "END")'],
      cwd: process.cwd(),
      maxBufferBytes: 100,
    });
    await proc.exited;
    await new Promise((r) => setImmediate(r));
    const tail = proc.stdoutTail();
    expect(tail.length).toBe(100);
    expect(tail.endsWith('END')).toBe(true);
  });
});

describe('onSpawned observer (p6-capacity-advice)', () => {
  it('reports the pid of the started process and survives a throwing observer', async () => {
    const seen: number[] = [];
    const proc = await spawnOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 50)'],
      cwd: process.cwd(),
      onSpawned: (pid) => {
        seen.push(pid);
        throw new Error('observer bug');
      },
    });
    expect(seen).toEqual([proc.pid]);
    await proc.exited;
  });
});

describe('tree killers (platform fakes)', () => {
  it('posix: signals the negative pid (process group) and ignores ESRCH', async () => {
    const calls: [number, NodeJS.Signals | number][] = [];
    const killer = posixTreeKiller((pid, sig) => {
      calls.push([pid, sig]);
      if (calls.length > 1) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return true;
    });
    expect(killer.detached).toBe(true);
    expect(killer.signal(4242, 'SIGTERM')).toBe(true);
    await killer.kill(4242);
    expect(calls).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL'],
    ]);
  });

  it('posix: EPERM (zombie-only group on macOS) counts as gone; other errors propagate', async () => {
    const fail = (code: string) =>
      posixTreeKiller(() => {
        throw Object.assign(new Error(code), { code });
      });
    expect(fail('EPERM').signal(4242, 'SIGTERM')).toBe(false);
    await fail('EPERM').kill(4242);
    expect(() => fail('EINVAL').signal(4242, 'SIGTERM')).toThrow('EINVAL');
  });

  it('posix: refuses pid <= 1 (would signal every process)', () => {
    const killer = posixTreeKiller(() => true);
    expect(() => killer.signal(1, 'SIGTERM')).toThrow(RangeError);
    expect(() => killer.signal(0, 'SIGTERM')).toThrow(RangeError);
  });

  it('windows: uses taskkill /PID <pid> /T /F, tolerates not-found, surfaces other failures', async () => {
    const run = vi.fn<(args: readonly string[]) => Promise<{ exitCode: number; stderr: string }>>();
    run.mockResolvedValueOnce({ exitCode: 0, stderr: '' });
    run.mockResolvedValueOnce({ exitCode: 128, stderr: 'not found' });
    run.mockResolvedValueOnce({ exitCode: 1, stderr: 'access denied' });
    const killer = windowsTreeKiller(run);
    expect(killer.detached).toBe(false);
    expect(killer.signal(10, 'SIGTERM')).toBe(false);
    await killer.kill(10);
    expect(run).toHaveBeenCalledWith(['/PID', '10', '/T', '/F']);
    await killer.kill(10);
    await expect(killer.kill(10)).rejects.toThrow(/access denied/);
  });

  it('terminate uses the injected killer: no tree signal (windows) -> grace -> kill', async () => {
    const events: string[] = [];
    const fakeWindows: ProcessTreeKiller = {
      kind: 'windows-taskkill',
      detached: false,
      signal: (_pid, sig) => {
        events.push(`signal:${sig}`);
        return false;
      },
      kill: (pid) => {
        events.push('kill');
        process.kill(pid, 'SIGKILL');
        return Promise.resolve();
      },
    };
    const proc = await spawnOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      treeKiller: fakeWindows,
    });
    const realPid = proc.pid;
    const out = await proc.terminate({ graceMs: 100 });
    expect(out.mode).toBe('forced');
    expect(events).toEqual(['signal:SIGTERM', 'kill']);
    expect(await waitDead(realPid)).toBe(true);
  });

  posixOnly('terminate throws CancelTimeoutError if the tree survives the kill', async () => {
    const proc = await spawnOwnedProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      treeKiller: {
        kind: 'posix-process-group',
        detached: true,
        signal: () => true,
        kill: () => Promise.resolve(),
      },
    });
    await expect(proc.terminate({ graceMs: 50, killWaitMs: 50 })).rejects.toBeInstanceOf(CancelTimeoutError);
    process.kill(-proc.pid, 'SIGKILL');
    await proc.exited;
  });
});

describe('ProcessConfiner hook (p3-sandbox)', () => {
  it('rewrites the plan, passes the full env incl. secrets, uses its killer and disposes once', async () => {
    const secret = new SecretValue('confined-secret-42');
    const seen: SpawnPlan[] = [];
    const dispose = vi.fn(() => Promise.resolve());
    const confiner: ProcessConfiner = {
      kind: 'test:wrapper',
      confine: (plan) => {
        seen.push(plan);
        // Wrap: run the original command through node -e re-exec, with an extra marker env.
        return Promise.resolve({
          command: process.execPath,
          args: ['-e', 'process.stdout.write(process.env.WRAPPED + ":" + process.env.MY_KEY)'],
          cwd: plan.cwd,
          env: { ...plan.env, WRAPPED: 'yes' },
          treeKiller: posixTreeKiller(),
          dispose,
        });
      },
    };
    const proc = await spawnOwnedProcess({
      command: '/bin/original',
      args: ['--flag'],
      cwd: process.cwd(),
      secretEnv: { MY_KEY: secret },
      confiner,
    });
    expect(seen[0]?.command).toBe('/bin/original');
    expect(seen[0]?.secretNames).toEqual(['MY_KEY']);
    expect(seen[0]?.env.MY_KEY).toBe(secret.reveal());
    expect(proc.confinement).toBe('test:wrapper');
    await proc.exited;
    await new Promise((r) => setImmediate(r));
    expect(proc.stdoutTail()).toBe('yes:[REDACTED]');
    await Promise.all([proc.dispose(), proc.dispose()]);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses a confinement that puts a secret into argv, and disposes it', async () => {
    const secret = new SecretValue('leaky-secret-77');
    const dispose = vi.fn(() => Promise.resolve());
    const confiner: ProcessConfiner = {
      kind: 'test:leaky',
      confine: (plan) =>
        Promise.resolve({
          command: 'docker',
          args: ['run', '-e', `MY_KEY=${plan.env.MY_KEY ?? ''}`],
          cwd: plan.cwd,
          env: plan.env,
          dispose,
        }),
    };
    await expect(
      spawnOwnedProcess({ command: 'x', args: [], cwd: '/', secretEnv: { MY_KEY: secret }, confiner }),
    ).rejects.toBeInstanceOf(SecretInArgvError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the confinement when the confined command cannot start', async () => {
    const dispose = vi.fn(() => Promise.resolve());
    const confiner: ProcessConfiner = {
      kind: 'test:missing',
      confine: (plan) =>
        Promise.resolve({
          command: '/nonexistent/sandbox-wrapper',
          args: [],
          cwd: plan.cwd,
          env: {},
          dispose,
        }),
    };
    await expect(
      spawnOwnedProcess({ command: 'x', args: [], cwd: process.cwd(), confiner }),
    ).rejects.toBeInstanceOf(RuntimeCrashedError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('TailBuffer', () => {
  it('keeps the last maxBytes and counts dropped bytes', () => {
    const t = new TailBuffer(5);
    t.push(Buffer.from('abc'));
    t.push(Buffer.from('defg'));
    expect(t.toString()).toBe('cdefg');
    t.push(Buffer.from('0123456789'));
    expect(t.toString()).toBe('56789');
    expect(t.droppedBytes).toBe(12);
  });
});
