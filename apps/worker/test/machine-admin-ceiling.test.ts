import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setMachineAdminCeiling } from '../src/update/helper/ceiling.js';
import { tempDir } from './helpers.js';

/** The installers' --allow-machine-admin / --no-machine-admin on an existing config (updater machine-admin-ceiling). */

async function config(doc: unknown): Promise<string> {
  const dir = await tempDir('ceiling-');
  const path = join(dir, 'config.json');
  await writeFile(path, typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  await chmod(path, 0o640);
  return path;
}

const base = (dir = '/tmp/x') => ({
  masterUrl: 'wss://m.example.com/v1/worker',
  workspaceRoot: dir,
  sandbox: { workerUser: 'remyral-worker' },
  localCeiling: { maxParallelJobs: 2 },
});

async function set(path: string, value: 'allow' | 'forbid' | 'unset') {
  const out: string[] = [];
  const code = await setMachineAdminCeiling({
    platform: 'linux',
    configPath: path,
    value,
    out: (t) => out.push(t),
  });
  return {
    code,
    out: out.join(''),
    doc: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>,
  };
}

describe('machine-admin-ceiling (local ceiling of machine administration)', () => {
  it('forbid / allow / unset change only that key and keep owner and mode', async () => {
    const path = await config(base());
    const forbid = await set(path, 'forbid');
    expect(forbid.code).toBe(0);
    expect(forbid.doc).toEqual({ ...base(), localCeiling: { maxParallelJobs: 2, allowMachineAdmin: false } });
    expect(forbid.out).toContain('unset (default) -> false');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect((await set(path, 'allow')).doc).toMatchObject({ localCeiling: { allowMachineAdmin: true } });
    expect((await set(path, 'allow')).out).toContain('nothing to do');
    expect((await set(path, 'unset')).doc).toEqual(base());
  });

  it('an empty ceiling is dropped; a config the worker would refuse is never written', async () => {
    const minimal = { masterUrl: 'wss://m.example.com/v1/worker', workspaceRoot: '/tmp/x' };
    const path = await config(minimal);
    expect((await set(path, 'forbid')).doc).toEqual({
      ...minimal,
      localCeiling: { allowMachineAdmin: false },
    });
    expect((await set(path, 'unset')).doc).toEqual(minimal);
    const broken = await config({ ...minimal, typoKey: 1 });
    const r = await set(broken, 'forbid');
    expect(r.code).toBe(1);
    expect(r.out).toContain('typoKey');
    expect(r.doc).toEqual({ ...minimal, typoKey: 1 });
    const notJson = await config('{ nope');
    expect(
      await setMachineAdminCeiling({
        platform: 'linux',
        configPath: notJson,
        value: 'allow',
        out: () => undefined,
      }),
    ).toBe(1);
    expect(await readFile(notJson, 'utf8')).toBe('{ nope');
  });
});
