import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostRestrictedRunner, SHORT_TMP_MAX } from '../src/sandbox/host/runner.js';
import { DEFAULT_LIMITS } from '../src/sandbox/types.js';
import { tempDir } from './helpers.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

/**
 * p21-short-tmp (docs/design/p21-service-egress.md §6): a deep attempt dir made `$TMPDIR` too long for Unix socket
 * paths — `tsx` in a service failed with `listen EINVAL … .pipe`. An unconfined attempt gets a short private dir
 * of its own (removed with the attempt); a restricted one without a bubblewrap view keeps its own tmp.
 */
// POSIX: the short private tmp lives below /tmp.
describePosix('host runner: short $TMPDIR (p21-short-tmp)', () => {
  const identity = { verified: true, username: 'remyral', uid: 1001, problems: [] };

  async function confine(mode: 'restricted' | 'unconfined', jobId: string) {
    const root = await realpath(await tempDir('st-host-'));
    // The OS temp dir of a test machine can itself be long (macOS /var/folders/…): a short base like a server's /tmp.
    const short = await realpath(await mkdtemp('/tmp/st-'));
    const ws = join(root, 'jobs', jobId, 'att');
    await mkdir(ws, { recursive: true });
    const runner = new HostRestrictedRunner({
      identity,
      workspaceRoot: root,
      workerDataDir: join(root, 'data'),
      platform: 'linux',
      mode,
      unconfinedAllowed: () => ({ allowed: true }),
      shortTmpBase: short,
    });
    const confined = await runner
      .confiner({
        jobId,
        attemptId: 'att',
        workspacePath: ws,
        network: { mode: 'none' },
        limits: DEFAULT_LIMITS,
      })
      .confine({ command: '/bin/true', args: [], cwd: '/', env: { PATH: '/usr/bin' }, secretNames: [] });
    return { confined, root, short };
  }

  const longId = `svc-${'a'.repeat(60)}`;

  it('unconfined with a long attempt dir: a short private TMPDIR, removed on dispose', async () => {
    const { confined, root, short } = await confine('unconfined', longId);
    const tmp = confined.env.TMPDIR ?? '';
    expect(tmp.startsWith(join(short, 'rmy-'))).toBe(true);
    expect(tmp.length).toBeLessThanOrEqual(SHORT_TMP_MAX);
    expect(tmp.startsWith(root)).toBe(false);
    expect(confined.env.TMP).toBe(tmp);
    expect(existsSync(tmp)).toBe(true);
    await confined.dispose?.();
    expect(existsSync(tmp)).toBe(false);
    await rm(short, { recursive: true, force: true });
  });

  it('a short attempt dir keeps its own tmp; restricted without bubblewrap keeps it even when long', async () => {
    const a = await confine('unconfined', 'j');
    if (join(a.root, 'sandboxes', 'j', 'att', 'tmp').length <= SHORT_TMP_MAX)
      expect(a.confined.env.TMPDIR).toBe(join(a.root, 'sandboxes', 'j', 'att', 'tmp'));
    await a.confined.dispose?.();
    const b = await confine('restricted', longId);
    expect(b.confined.env.TMPDIR).toBe(join(b.root, 'sandboxes', longId, 'att', 'tmp'));
    await b.confined.dispose?.();
  });
});
