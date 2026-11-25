import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprint } from '../src/identity/device-key.js';
import { adminBindingPath, readAdminBinding } from '../src/machine-admin/binding.js';
import { adminBind } from '../src/update/helper/bind.js';
import { tempDir } from './helpers.js';

/** Security fix: the root helper's own record of the worker id it serves (admin-bind, installer migration). */

const PUB = 'A'.repeat(43);
const uid = process.getuid?.() ?? 0;

async function machine(identity: { workerId: string; publicKey: string } | null) {
  const root = await tempDir('bind-');
  const dataDir = join(root, 'data');
  const installDir = join(root, 'install');
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(installDir, 'state'), { recursive: true, mode: 0o755 });
  await chmod(join(installDir, 'state'), 0o755);
  await writeFile(
    join(dataDir, 'state.json'),
    JSON.stringify({
      version: 1,
      identity: identity === null ? null : { ...identity, enrolledAt: '2026-10-12T00:00:00.000Z' },
      leases: [],
      cursors: { lastMasterSeq: 0, ackedOutboundSeq: 0 },
    }),
  );
  const out: string[] = [];
  const bind = (o: { workerId?: string; ifUnbound?: boolean; replace?: boolean } = {}) =>
    adminBind({
      platform: process.platform,
      dataDir,
      installDir,
      workerId: o.workerId,
      ifUnbound: o.ifUnbound ?? false,
      replace: o.replace ?? false,
      now: () => new Date('2026-10-12T00:00:00.000Z'),
      out: (t) => out.push(t),
      ownerUid: uid,
    });
  const read = () =>
    readAdminBinding(installDir, { platform: process.platform, rootOnly: true, ownerUid: uid });
  return { root, dataDir, installDir, out, bind, read };
}

describe.skipIf(process.platform === 'win32')('admin-bind and the root-owned binding', () => {
  it('binds the enrolled identity, prints the fingerprint, is idempotent', async () => {
    const m = await machine({ workerId: 'wrk_a', publicKey: PUB });
    expect(await m.read()).toEqual({ state: 'unbound' });
    expect(await m.bind()).toBe(0);
    expect(m.out.join('')).toContain(`wrk_a (device key ${fingerprint(PUB)})`);
    expect(await m.read()).toMatchObject({
      state: 'bound',
      binding: { workerId: 'wrk_a', source: 'operator' },
    });
    expect(await m.bind()).toBe(0);
    expect(m.out.at(-1)).toContain('nothing to do');
  });

  it('--worker-id must match the enrolled identity; an unenrolled worker cannot be bound', async () => {
    const m = await machine({ workerId: 'wrk_a', publicKey: PUB });
    expect(await m.bind({ workerId: 'wrk_b' })).toBe(1);
    expect(await m.read()).toEqual({ state: 'unbound' });
    expect(await m.bind({ workerId: 'wrk_a' })).toBe(0);
    const fresh = await machine(null);
    expect(await fresh.bind()).toBe(1);
    expect(fresh.out.join('')).toContain('not enrolled yet');
    // Installer mode never fails the install.
    expect(await fresh.bind({ ifUnbound: true })).toBe(0);
    expect(await fresh.read()).toEqual({ state: 'unbound' });
  });

  it('migration: the installer binds an existing enrolled install once and never overwrites another binding', async () => {
    const m = await machine({ workerId: 'wrk_a', publicKey: PUB });
    expect(await m.bind({ ifUnbound: true })).toBe(0);
    expect(await m.read()).toMatchObject({
      state: 'bound',
      binding: { workerId: 'wrk_a', source: 'installer' },
    });
    // Paired again (new id): the installer leaves the binding; the owner replaces it explicitly.
    await writeFile(
      join(m.dataDir, 'state.json'),
      JSON.stringify({
        version: 1,
        identity: { workerId: 'wrk_new', publicKey: PUB, enrolledAt: '2026-10-12T00:00:00.000Z' },
        leases: [],
        cursors: { lastMasterSeq: 0, ackedOutboundSeq: 0 },
      }),
    );
    expect(await m.bind({ ifUnbound: true })).toBe(0);
    expect(await m.read()).toMatchObject({ binding: { workerId: 'wrk_a' } });
    expect(await m.bind()).toBe(1);
    expect(m.out.at(-1)).toContain('--replace');
    expect(await m.bind({ replace: true })).toBe(0);
    expect(await m.read()).toMatchObject({ binding: { workerId: 'wrk_new', source: 'operator' } });
  });

  it('the helper trusts only a regular file owned by root (here: the test uid), not writable by others', async () => {
    const m = await machine({ workerId: 'wrk_a', publicKey: PUB });
    await m.bind();
    const path = adminBindingPath(m.installDir);
    await chmod(path, 0o666);
    expect(await m.read()).toMatchObject({ state: 'invalid' });
    await chmod(path, 0o644);
    expect(
      await readAdminBinding(m.installDir, { platform: process.platform, rootOnly: true, ownerUid: uid + 1 }),
    ).toMatchObject({ state: 'invalid' });
    await chmod(join(m.installDir, 'state'), 0o777);
    expect(await m.read()).toMatchObject({ state: 'invalid' });
    await chmod(join(m.installDir, 'state'), 0o755);
    const content = await readFile(path, 'utf8');
    const other = join(m.root, 'elsewhere.json');
    await writeFile(other, content);
    const { rm } = await import('node:fs/promises');
    await rm(path);
    await symlink(other, path);
    expect(await m.read()).toMatchObject({ state: 'invalid' });
    await rm(path);
    await writeFile(path, '{"v":1}');
    expect(await m.read()).toMatchObject({ state: 'invalid' });
  });
});
