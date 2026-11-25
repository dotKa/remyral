import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../src/fs/atomic.js';
import { OutboxFullError } from '../src/store/outbox.js';
import { OUTBOX_FILE, STATE_FILE, StaleEpochError, WorkerStore } from '../src/store/store.js';
import { isWindows, nodeOps, patchOps, tempDir } from './helpers.js';

const lease = (jobId: string, epoch: number, attemptId = `a-${jobId}-${String(epoch)}`) => ({
  jobId,
  attemptId,
  epoch,
  expiresAt: '2026-10-12T10:00:00.000Z',
});

const crash = () => Promise.reject(Object.assign(new Error('simulated crash'), { code: 'ECRASH' }));

describe('WorkerStore', () => {
  it('starts empty, persists identity, leases and cursors across reopen', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    expect(store.state).toMatchObject({
      identity: null,
      leases: [],
      cursors: { lastMasterSeq: 0, ackedOutboundSeq: 0 },
    });
    await store.setIdentity({
      workerId: 'w-1',
      publicKey: 'A'.repeat(43),
      enrolledAt: '2026-10-12T00:00:00.000Z',
    });
    await store.putLease(lease('j1', 1));
    await store.putLease(lease('j2', 4));
    expect(await store.recordMasterSeq(7)).toBe(true);
    expect(await store.recordMasterSeq(5)).toBe(false);

    const { store: again } = await WorkerStore.open(nodeOps(), dir);
    expect(again.identity?.workerId).toBe('w-1');
    expect(again.leases.map((l) => l.jobId).sort()).toEqual(['j1', 'j2']);
    expect(again.state.cursors.lastMasterSeq).toBe(7);
    if (!isWindows) expect((await nodeOps().stat(join(dir, STATE_FILE)))?.mode).toBe(0o600);
  });

  it('fences leases: lower epoch rejected, higher epoch replaces, same epoch renews', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir());
    await store.putLease(lease('j1', 3));
    await expect(store.putLease(lease('j1', 2))).rejects.toBeInstanceOf(StaleEpochError);
    await expect(store.putLease({ ...lease('j1', 3), attemptId: 'other' })).rejects.toBeInstanceOf(
      StaleEpochError,
    );
    await store.putLease({ ...lease('j1', 3), expiresAt: '2026-10-12T11:00:00.000Z' });
    expect(store.leases[0]?.expiresAt).toBe('2026-10-12T11:00:00.000Z');
    await store.putLease(lease('j1', 4));
    expect(store.leases).toEqual([lease('j1', 4)]);
    expect(await store.removeLease('j1')).toBe(true);
    expect(await store.removeLease('j1')).toBe(false);
  });

  it('serializes concurrent updates without losing any', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir());
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.putLease(lease(`j${String(i)}`, 1))));
    expect(store.leases).toHaveLength(20);
  });

  it('validates input', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir());
    await expect(store.putLease({ ...lease('j1', 1), epoch: -1 })).rejects.toThrow();
    await expect(store.putLease({ ...lease('bad id!', 1) })).rejects.toThrow();
  });

  it('crash between temp write and rename keeps the previous state and cleans the temp up', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    await store.putLease(lease('j1', 1));

    // Simulate the process dying right before rename: the fsynced temp stays behind.
    const dying = patchOps({ rename: crash, unlink: crash });
    const { store: doomed } = await WorkerStore.open(dying, dir);
    await expect(doomed.putLease(lease('j2', 1))).rejects.toThrow('simulated crash');
    expect((await readdir(dir)).some((f) => f.startsWith(`${STATE_FILE}.tmp-`))).toBe(true);

    const { store: recovered, report } = await WorkerStore.open(nodeOps(), dir);
    expect(report.removedTemps).toBe(1);
    expect(recovered.leases).toEqual([lease('j1', 1)]);
    expect((await readdir(dir)).some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('crash in the middle of writing the temp file (torn temp) does not affect the state', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    await store.putLease(lease('j1', 1));
    await writeFile(join(dir, `${STATE_FILE}.tmp-999-deadbeef`), '{"version":1,"identity":nu');
    const { store: recovered } = await WorkerStore.open(nodeOps(), dir);
    expect(recovered.leases).toEqual([lease('j1', 1)]);
  });

  it('a corrupt state file is moved aside, never silently trusted', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, STATE_FILE), '{"version":1,"leases":"garbage"}', { mode: 0o600 });
    const { store, report } = await WorkerStore.open(nodeOps(), dir, {
      now: () => new Date('2026-10-12T00:00:00Z'),
    });
    expect(report.quarantinedCorruptState).toMatch(/state\.json\.corrupt-2026-10-12T00-00-00-000Z$/);
    expect(store.leases).toEqual([]);
    expect(await readFile(report.quarantinedCorruptState ?? '', 'utf8')).toContain('garbage');
  });

  it('retries a transient Windows sharing violation on rename', async () => {
    const dir = await tempDir();
    let failures = 2;
    const base = nodeOps();
    const ops = patchOps({
      platform: 'win32',
      rename: (from, to) => {
        if (failures-- > 0) return Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' }));
        return base.rename(from, to);
      },
      fsyncDir: () => Promise.resolve(),
    });
    await atomicWriteFile(ops, join(dir, 'x.json'), 'data', { mode: 0o600, sleep: () => Promise.resolve() });
    expect(await readFile(join(dir, 'x.json'), 'utf8')).toBe('data');
    // Non-transient errors and POSIX are not retried.
    const posix = patchOps({
      rename: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' })),
    });
    await expect(atomicWriteFile(posix, join(dir, 'y.json'), 'd', { mode: 0o600 })).rejects.toThrow('busy');
    expect((await readdir(dir)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('Outbox', () => {
  it('assigns monotonic seqs, persists, replays pending after reopen, and acks', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) seqs.push(await store.outbox.append((seq) => ({ type: 'EVENT', seq, n: i })));
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    await store.ackOutbound(2);

    const { store: again } = await WorkerStore.open(nodeOps(), dir);
    expect(again.outbox.pending().map((p) => p.seq)).toEqual([3, 4, 5]);
    expect(again.outbox.pending(4).map((p) => p.message)).toEqual([{ type: 'EVENT', seq: 5, n: 4 }]);
    expect(await again.outbox.append((seq) => ({ seq }))).toBe(6);
    await again.ackOutbound(6);
    expect(again.outbox.size).toBe(0);
    expect(await readFile(join(dir, OUTBOX_FILE), 'utf8')).toBe('');
    // seq continues after a full ack + reopen.
    const { store: third } = await WorkerStore.open(nodeOps(), dir);
    expect(third.outbox.nextSeq).toBe(7);
    await expect(third.ackOutbound(99)).rejects.toThrow(RangeError);
  });

  it('concurrent appends get distinct seqs', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir());
    const seqs = await Promise.all(Array.from({ length: 25 }, () => store.outbox.append((seq) => ({ seq }))));
    expect(new Set(seqs).size).toBe(25);
    expect(store.outbox.pending().map((p) => p.seq)).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('is bounded: refuses with OutboxFullError instead of dropping', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir(), {
      outboxLimits: { maxEntries: 3, maxBytes: 1024 * 1024 },
    });
    for (let i = 0; i < 3; i++) await store.outbox.append(() => ({ i }));
    await expect(store.outbox.append(() => ({ i: 4 }))).rejects.toBeInstanceOf(OutboxFullError);
    await store.ackOutbound(1);
    await expect(store.outbox.append(() => ({ i: 4 }))).resolves.toBe(4);

    const { store: small } = await WorkerStore.open(nodeOps(), await tempDir(), {
      outboxLimits: { maxEntries: 100, maxBytes: 100 },
    });
    await expect(small.outbox.append(() => ({ blob: 'x'.repeat(200) }))).rejects.toBeInstanceOf(
      OutboxFullError,
    );
  });

  it('drops a torn last line (crash during append) and keeps the complete ones', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    await store.outbox.append((seq) => ({ seq }));
    await store.outbox.append((seq) => ({ seq }));
    await appendFile(join(dir, OUTBOX_FILE), '{"seq":3,"message":{"se');
    const { store: again, report } = await WorkerStore.open(nodeOps(), dir);
    expect(report.outbox).toEqual({ restored: 2, droppedTornTail: true, droppedCorrupt: 0 });
    expect(again.outbox.nextSeq).toBe(3);
    expect((await readFile(join(dir, OUTBOX_FILE), 'utf8')).endsWith('\n')).toBe(true);
  });

  it('crash between ack cursor write and compaction: acked entries are not replayed', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    for (let i = 0; i < 4; i++) await store.outbox.append((seq) => ({ seq }));
    const before = await readFile(join(dir, OUTBOX_FILE), 'utf8');
    await store.ackOutbound(3);
    // Put the uncompacted file back, as if the compaction never ran.
    await writeFile(join(dir, OUTBOX_FILE), before);
    const { store: again } = await WorkerStore.open(nodeOps(), dir);
    expect(again.outbox.pending().map((p) => p.seq)).toEqual([4]);
  });

  it('after a failed append the next append rewrites the file first (no glued lines)', async () => {
    const dir = await tempDir();
    const base = nodeOps();
    let fail = true;
    const ops = patchOps({
      append: async (path, data, mode) => {
        if (fail) {
          fail = false;
          await base.append(path, data.slice(0, 5), mode); // partial write, then error
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        }
        await base.append(path, data, mode);
      },
    });
    const { store } = await WorkerStore.open(ops, dir);
    await expect(store.outbox.append(() => ({ a: 1 }))).rejects.toThrow('ENOSPC');
    expect(await store.outbox.append((seq) => ({ seq }))).toBe(1);
    const { store: again, report } = await WorkerStore.open(nodeOps(), dir);
    expect(report.outbox.droppedCorrupt + Number(report.outbox.droppedTornTail)).toBe(0);
    expect(again.outbox.pending()).toEqual([{ seq: 1, message: { seq: 1 } }]);
  });

  it('p11: a master behind its own acknowledgements (restored from a backup): pending entries follow its cursor', async () => {
    const dir = await tempDir();
    const { store } = await WorkerStore.open(nodeOps(), dir);
    for (let i = 0; i < 6; i++) await store.outbox.append((seq) => ({ type: 'EVENT', seq, n: i }));
    await store.ackOutbound(4); // the old master processed 1..4; 5 and 6 are pending
    // The restored master only knows seq 2.
    expect(await store.resumeOutbound(2)).toBe(false);
    expect(store.takeRollback()).toBe(true);
    expect(store.takeRollback()).toBe(false);
    expect(store.outbox.pending(2)).toEqual([
      { seq: 3, message: { type: 'EVENT', seq: 3, n: 4 } },
      { seq: 4, message: { type: 'EVENT', seq: 4, n: 5 } },
    ]);
    expect(store.state.cursors.ackedOutboundSeq).toBe(2);
    expect(await store.outbox.append((seq) => ({ seq }))).toBe(5);
    // Survives a restart with the new numbering.
    const { store: again } = await WorkerStore.open(nodeOps(), dir);
    expect(again.outbox.pending().map((p) => p.seq)).toEqual([3, 4, 5]);
    // Normal resume afterwards: no renumbering.
    expect(await again.resumeOutbound(3)).toBe(false);
    expect(again.takeRollback()).toBe(false);
    expect(again.outbox.pending().map((p) => p.seq)).toEqual([4, 5]);
  });

  it('p11: nothing pending and the master rolled back: numbering restarts after its cursor', async () => {
    const { store } = await WorkerStore.open(nodeOps(), await tempDir());
    for (let i = 0; i < 3; i++) await store.outbox.append((seq) => ({ seq }));
    await store.ackOutbound(3);
    await store.resumeOutbound(1);
    expect(store.takeRollback()).toBe(true);
    expect(await store.outbox.append((seq) => ({ seq }))).toBe(2);
  });
});
