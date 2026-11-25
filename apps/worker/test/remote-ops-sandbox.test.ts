import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSeatbeltProfile } from '../src/sandbox/host/seatbelt.js';
import { tempDir } from './helpers.js';

/**
 * p5-remote-ops: managed runtime installs live in `<dataDir>/runtimes`. The macOS host profile keeps the rest
 * of the data dir unreadable but opens that subtree read-only, so a job can execute its runtime and cannot
 * read the device key or modify an install.
 */
describe('Seatbelt carve-out for managed runtime installs', () => {
  const spec = {
    workspace: '/r/jobs/j/a',
    sandboxDir: '/r/sandboxes/j/a',
    workspaceRoot: '/r',
    workerDataDir: '/d',
    homes: ['/Users/_remyral'],
  };

  it('without a carve-out the whole data dir is unreadable (unchanged)', () => {
    const { profile } = buildSeatbeltProfile(spec);
    expect(profile).toMatch(/^\(deny file-read\* \(subpath \(param "P\d+"\)\)\)$/m);
  });

  it('with a carve-out: data dir denied except the installs (and metadata of the data dir itself)', () => {
    const { profile, params } = buildSeatbeltProfile({ ...spec, readableInDataDir: ['/d/runtimes'] });
    expect(profile).toContain('(deny file-read* (require-all (subpath');
    expect(profile).toMatch(/require-not \(subpath \(param "P\d+"\)\)\) \(require-not \(literal/);
    expect(profile).toMatch(/^\(deny file-read-data file-read-xattr \(literal \(param "P\d+"\)\)\)$/m);
    expect(Object.values(params)).toContain('/d/runtimes');
    // Writes stay limited to the attempt's own dirs.
    expect(profile).toContain('(deny file-write*)');
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))(
    'live: runs a managed binary, cannot read the device key, cannot modify the install',
    async () => {
      const root = await realpath(await tempDir('ro-sb-'));
      const data = join(root, 'data');
      const work = join(root, 'work');
      const ws = join(work, 'jobs', 'j', 'a');
      const sb = join(work, 'sandboxes', 'j', 'a');
      const bin = join(data, 'runtimes', 'codex', '1.0.0', 'bin');
      for (const d of [ws, sb, bin]) await mkdir(d, { recursive: true });
      await writeFile(join(data, 'device-key.json'), 'SECRET-KEY');
      await writeFile(join(bin, 'codex'), '#!/bin/sh\necho managed-ok\n');
      await chmod(join(bin, 'codex'), 0o755);
      const { argv } = buildSeatbeltProfile({
        workspace: ws,
        sandboxDir: sb,
        workspaceRoot: work,
        workerDataDir: data,
        readableInDataDir: [join(data, 'runtimes')],
        homes: [],
      });
      const run = (cmd: string[]) =>
        spawnSync(argv[0] ?? '', [...argv.slice(1), ...cmd], { encoding: 'utf8', cwd: ws });
      expect(run([join(bin, 'codex')]).stdout.trim()).toBe('managed-ok');
      expect(run(['/bin/cat', join(data, 'device-key.json')]).status).not.toBe(0);
      expect(run(['/bin/ls', data]).status).not.toBe(0);
      const write = run(['/bin/sh', '-c', `echo x > ${join(bin, 'codex')}`]);
      expect(write.status).not.toBe(0);
    },
  );
});
