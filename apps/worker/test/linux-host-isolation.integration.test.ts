import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBwrap } from '../src/probe/bwrap.js';
import { LinuxIsolationController } from '../src/sandbox/host/linux-isolation.js';
import { HostRestrictedRunner } from '../src/sandbox/host/runner.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

/**
 * p19-linux-host-isolation (ADR-0066): REAL bubblewrap, Linux only (skipped elsewhere and where `bwrap` is not on
 * PATH). Two host attempts run at the same time through the real host runner; the second must not read the first's
 * worktree — directly, through `/proc/<pid>/root`, or through `/proc/<pid>/environ` — nor the worker data dir, and
 * its write into the first's path must never reach it. Verified by hand in Ubuntu 24.04 / bubblewrap 0.9 (with and
 * without a hardened /proc, design §3.3) on 2026-10-29.
 */

const bwrap = process.platform === 'linux' ? await findBwrap() : null;

describe.skipIf(bwrap === null)('Linux per-attempt bubblewrap views (real bwrap)', () => {
  const layout = async () => {
    const data = await realpath(await tempDir('lhi-it-'));
    const root = join(data, 'workspaces');
    await mkdir(join(data, 'runtimes'), { recursive: true });
    await writeFile(join(data, 'device.key'), 'worker secret\n', { mode: 0o600 });
    return { data, root };
  };

  it('the cross-attempt self-check passes on this host', async () => {
    const { data, root } = await layout();
    await mkdir(root, { recursive: true });
    const c = new LinuxIsolationController({
      mode: 'auto',
      workspaceRoot: root,
      dataDir: data,
      readableInDataDir: [join(data, 'runtimes')],
      findBwrap: () => Promise.resolve(bwrap),
      // CI runners may ship bwrap outside root's ownership rules (e.g. a toolcache): trust the one on PATH here.
      trusted: () => Promise.resolve(null),
    });
    const s = await c.verify();
    expect(s, s.detail).toMatchObject({ active: true });
  }, 60_000);

  it('two concurrent attempts: B cannot read or write A’s worktree, nor the data dir', async () => {
    const { data, root } = await layout();
    const isolation = new LinuxIsolationController({
      mode: 'auto',
      workspaceRoot: root,
      dataDir: data,
      readableInDataDir: [join(data, 'runtimes')],
      findBwrap: () => Promise.resolve(bwrap),
      trusted: () => Promise.resolve(null),
    });
    await mkdir(root, { recursive: true });
    expect((await isolation.verify()).active).toBe(true);
    const runner = new HostRestrictedRunner({
      identity: { verified: true, username: 'test', uid: process.getuid?.() ?? 1000, problems: [] },
      workspaceRoot: root,
      workerDataDir: data,
      readableInDataDir: [join(data, 'runtimes')],
      platform: 'linux',
      linuxIsolation: isolation,
    });
    expect(runner.filesystemConfinement).toBe('bwrap');
    const wsA = join(root, 'jobs', 'ja', 'a1');
    const wsB = join(root, 'jobs', 'jb', 'b1');
    await mkdir(wsA, { recursive: true });
    await mkdir(wsB, { recursive: true });
    await writeFile(join(wsA, 'secret.txt'), 'A-ONLY-SECRET\n');
    const ctx = (jobId: string, attemptId: string, workspacePath: string) => ({
      jobId,
      attemptId,
      authMode: 'secret-ref' as const,
      workspacePath,
      network: { mode: 'none' as const },
      limits: DEFAULT_LIMITS,
    });
    // A keeps running while B probes it.
    const a = await runner.launch({
      ...ctx('ja', 'a1', wsA),
      command: '/bin/sh',
      args: ['-c', 'cat secret.txt >/dev/null && echo up > up.txt && exec sleep 20'],
      env: { PATH: '/usr/bin:/bin', MARK: 'A-ENV-SECRET' },
    });
    try {
      for (let i = 0; i < 100 && !(await readdir(wsA)).includes('up.txt'); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await readdir(wsA)).toContain('up.txt');
      const probe = [
        `cat ${wsA}/secret.txt 2>/dev/null && echo LEAK-direct`,
        `for p in /proc/[0-9]*; do cat "$p/root${wsA}/secret.txt" 2>/dev/null && echo LEAK-proc-root; grep -q A-ENV-SECRET "$p/environ" 2>/dev/null && echo LEAK-proc-environ; done`,
        `cat ${data}/device.key 2>/dev/null && echo LEAK-data`,
        `mkdir -p ${wsA} 2>/dev/null; echo planted > ${wsA}/planted 2>/dev/null && echo WROTE`,
        'echo own > own.txt && cat own.txt',
        'echo probe-done',
      ].join('\n');
      const b = await runner.launch({
        ...ctx('jb', 'b1', wsB),
        command: '/bin/sh',
        args: ['-c', probe],
        env: { PATH: '/usr/bin:/bin' },
      });
      await b.exited;
      const out = b.stdoutTail();
      await b.dispose();
      expect(out).toContain('probe-done');
      expect(out).toContain('own');
      expect(out).not.toMatch(/LEAK|A-ONLY-SECRET|worker secret/);
      expect(await readdir(wsA)).not.toContain('planted');
    } finally {
      await a.terminate({ graceMs: 500 }).catch(() => undefined);
      await a.dispose();
    }
  }, 60_000);
});
