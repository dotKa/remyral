import { lstat, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Redactor, SecretSet } from '@remyral/observability';
import type { WorkfilesDataPayload, WorkfilesReadOp, WorkfilesStatusPayload } from '@remyral/protocol';
import { describe, expect, it } from 'vitest';
import { workspacePreamble } from '../src/jobs/workspace-job.js';
import { KeptWorkdirs, seedFromRemote } from '../src/workspace/kept.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { isWindows, tempDir } from './helpers.js';

/**
 * p15-workspace-retention (docs/design/p15-workspace-retention.md §3): kept working directories on the machine —
 * kept after success and failure, scanned, listed and read without following links, evicted oldest-first under the
 * cap (never a pinned one), extended / removed by the master, swept after the local grace, and copied into a follow-up
 * attempt (same machine) or fetched through the master (relay).
 */

const DAY = 86_400_000;

async function setup(now: { t: number } = { t: Date.parse('2026-10-22T10:00:00.000Z') }) {
  const root = await tempDir('rw-kept-');
  const m = await WorkspaceManager.create({ root, projects: {}, minFreeBytes: 0 });
  const events: WorkfilesStatusPayload[] = [];
  const kept = await KeptWorkdirs.create({
    root: m.root,
    clock: () => new Date(now.t),
    onChange: (s) => events.push(s),
  });
  return { m, kept, events, now };
}

const iso = (t: number) => new Date(t).toISOString();

async function scratchWith(m: WorkspaceManager, jobId: string, files: Record<string, string | Buffer>) {
  const ws = await m.prepareScratch({ jobId, attemptId: 'a1', epoch: 1 });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(ws.path, ...rel.split('/'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }
  return ws;
}

describe.skipIf(isWindows)('kept working directories (p15-workspace-retention)', () => {
  it('keeps the whole directory after a success and after a failure, with a record and a status event', async () => {
    const { m, kept, events, now } = await setup();
    const ok = await scratchWith(m, 'job-ok', {
      'out/index.html': '<h1>Sunum</h1>',
      'notes/plan.md': '# plan',
    });
    const r1 = await kept.keep(ok, {
      projectId: 'genel',
      outcome: 'succeeded',
      expiresAt: iso(now.t + 14 * DAY),
      maxBytes: 1024 ** 3,
    });
    expect(r1.record).toMatchObject({ jobId: 'job-ok', outcome: 'succeeded', files: 2, pinnedUntil: null });
    // The scratch dir moved (nothing left under jobs/), the kept copy holds everything (also non-out files).
    expect(await lstat(ok.path).catch(() => null)).toBeNull();
    expect(await readFile(join(m.root, 'kept', 'job-ok', 'a1', 'out', 'index.html'), 'utf8')).toBe(
      '<h1>Sunum</h1>',
    );
    expect((await stat(join(m.root, 'kept', 'job-ok', 'a1'))).mode & 0o077).toBe(0);

    now.t += 1000;
    const failed = await scratchWith(m, 'job-fail', { 'out/draft.md': 'half' });
    await kept.keep(failed, {
      projectId: 'genel',
      outcome: 'failed',
      expiresAt: iso(now.t + 14 * DAY),
      maxBytes: 1024 ** 3,
    });
    expect(kept.list().map((r) => [r.jobId, r.outcome])).toEqual([
      ['job-fail', 'failed'],
      ['job-ok', 'succeeded'],
    ]);
    expect(events.at(-1)?.kept.map((k) => k.jobId)).toEqual(['job-fail']);
    expect(kept.report().usedBytes).toBe(r1.record.sizeBytes + 4);

    // Records survive a worker restart.
    const again = await KeptWorkdirs.create({ root: m.root, clock: () => new Date(now.t) });
    expect(
      again
        .list()
        .map((r) => r.jobId)
        .sort(),
    ).toEqual(['job-fail', 'job-ok']);
  });

  it('redacts text and drops a binary carrying a secret when keeping', async () => {
    const { m, kept, now } = await setup();
    const secrets = new SecretSet();
    secrets.add('canary-VALUE-0123456789', 'MY_TOKEN');
    const ws = await scratchWith(m, 'job-sec', {
      'out/report.md': 'key canary-VALUE-0123456789 end',
      'out/blob.bin': Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('canary-VALUE-0123456789')]),
      'out/ok.txt': 'fine',
    });
    const { record } = await kept.keep(ws, {
      projectId: 'genel',
      outcome: 'succeeded',
      expiresAt: iso(now.t + DAY),
      maxBytes: 1024 ** 3,
      redactor: new Redactor({ secrets }),
    });
    expect(record.redacted).toBe(1);
    expect(record.dropped).toBe(1);
    const base = join(m.root, 'kept', 'job-sec', 'a1', 'out');
    expect(await readFile(join(base, 'report.md'), 'utf8')).not.toContain('canary-VALUE');
    expect(await lstat(join(base, 'blob.bin')).catch(() => null)).toBeNull();
  });

  it('lists and reads without following links, refuses unsafe paths', async () => {
    const { m, kept, now } = await setup();
    const ws = await scratchWith(m, 'job-r', { 'out/a.txt': 'A'.repeat(300_000) });
    await symlink('/etc/hosts', join(ws.path, 'out', 'hosts'));
    await mkdir(join(ws.path, 'out', 'sub'));
    await symlink('/etc', join(ws.path, 'out', 'etc-link'));
    await kept.keep(ws, {
      projectId: 'genel',
      outcome: 'succeeded',
      expiresAt: iso(now.t + DAY),
      maxBytes: 1024 ** 3,
    });
    const list = await kept.entries('job-r', 'a1');
    const kinds = Object.fromEntries((list?.entries ?? []).map((e) => [e.path, e.kind]));
    expect(kinds).toMatchObject({
      in: 'dir',
      out: 'dir',
      'out/a.txt': 'file',
      'out/hosts': 'other',
      'out/sub': 'dir',
    });
    const c1 = await kept.read('job-r', 'a1', 'out/a.txt', 0);
    expect(c1?.data.length).toBe(192 * 1024);
    expect(c1?.eof).toBe(false);
    const c2 = await kept.read('job-r', 'a1', 'out/a.txt', 192 * 1024);
    expect(c2?.eof).toBe(true);
    expect((c1?.data.length ?? 0) + (c2?.data.length ?? 0)).toBe(300_000);
    expect(await kept.read('job-r', 'a1', 'out/hosts', 0)).toBeNull();
    expect(await kept.read('job-r', 'a1', 'out/etc-link/hosts', 0)).toBeNull();
    expect(await kept.read('job-r', 'a1', '../../../etc/hosts', 0)).toBeNull();
    expect(await kept.read('job-x', 'a1', 'out/a.txt', 0)).toBeNull();
    // The request handler answers the same.
    const nf = await kept.handle({
      requestId: '00000000-0000-4000-8000-000000000001',
      jobId: 'job-r',
      attemptId: 'a1',
      op: { op: 'read', path: 'out/hosts', offset: 0 },
    });
    expect(nf.status).toBe('not_found');
  });

  it('evicts the oldest unpinned directories first when the machine cap is exceeded', async () => {
    const { m, kept, now } = await setup();
    const keep = async (id: string, size: number) => {
      const ws = await scratchWith(m, id, { 'out/f.bin': Buffer.alloc(size, 1) });
      const r = await kept.keep(ws, {
        projectId: 'genel',
        outcome: 'succeeded',
        expiresAt: iso(now.t + 30 * DAY),
        maxBytes: 2500,
      });
      now.t += 1000;
      return r;
    };
    await keep('job-1', 1000);
    await keep('job-2', 1000);
    // job-1 is pinned by the master (a pending deploy): it must survive although it is the oldest.
    await kept.extend('job-1', 'a1', iso(now.t + 30 * DAY), iso(now.t + DAY));
    const r3 = await keep('job-3', 1000);
    expect(r3.evicted.map((e) => e.jobId)).toEqual(['job-2']);
    expect(
      kept
        .list()
        .map((r) => r.jobId)
        .sort(),
    ).toEqual(['job-1', 'job-3']);
    // Even a single directory larger than the cap stays (the one kept now is never evicted).
    const r4 = await keep('job-4', 3000);
    expect(r4.evicted.map((e) => e.jobId)).toEqual(['job-3']);
    expect(
      kept
        .list()
        .map((r) => r.jobId)
        .sort(),
    ).toEqual(['job-1', 'job-4']);
  });

  it('removes on request and sweeps only after expiry + grace, honouring a pin', async () => {
    const { m, kept, events, now } = await setup();
    for (const id of ['job-a', 'job-b', 'job-c']) {
      const ws = await scratchWith(m, id, { 'out/x.md': id });
      await kept.keep(ws, {
        projectId: 'genel',
        outcome: 'succeeded',
        expiresAt: iso(now.t + DAY),
        maxBytes: 1024 ** 3,
      });
    }
    const del = await kept.handle({
      requestId: '00000000-0000-4000-8000-000000000002',
      jobId: 'job-a',
      attemptId: 'a1',
      op: { op: 'delete', reason: 'user' },
    });
    expect(del.status).toBe('ok');
    expect(events.at(-1)?.removed).toEqual([{ jobId: 'job-a', attemptId: 'a1', reason: 'deleted' }]);
    expect(await lstat(join(m.root, 'kept', 'job-a')).catch(() => null)).toBeNull();
    await kept.extend('job-b', 'a1', iso(now.t + DAY), iso(now.t + 5 * DAY));
    now.t += DAY + 60_000; // expired, but within the local grace
    expect(await kept.sweep()).toEqual([]);
    now.t += DAY; // past the grace: job-c goes, job-b is still pinned
    expect((await kept.sweep()).map((r) => r.jobId)).toEqual(['job-c']);
    expect(kept.list().map((r) => r.jobId)).toEqual(['job-b']);
  });

  it('seeds a new attempt from kept files on the same machine (inputs read-only, nothing replaced)', async () => {
    const { m, kept, now } = await setup();
    const src = await scratchWith(m, 'job-src', {
      'in/brief.md': 'brief',
      'out/index.html': '<p>v1</p>',
      'assets/logo.png': Buffer.from([0x89, 0x50]),
    });
    await kept.keep(src, {
      projectId: 'genel',
      outcome: 'failed',
      expiresAt: iso(now.t + DAY),
      maxBytes: 1024 ** 3,
    });
    const next = await m.prepareScratch({ jobId: 'job-next', attemptId: 'b1', epoch: 1 });
    await writeFile(join(next.inDir, 'brief.md'), 'new brief');
    const r = await kept.seedLocal('job-src', 'a1', { path: next.path, inDir: next.inDir });
    expect(r).toMatchObject({ files: 2, truncated: false });
    expect(await readFile(join(next.path, 'out', 'index.html'), 'utf8')).toBe('<p>v1</p>');
    expect(await readFile(join(next.path, 'assets', 'logo.png'))).toEqual(Buffer.from([0x89, 0x50]));
    // The new job's own input wins over the kept one.
    expect(await readFile(join(next.inDir, 'brief.md'), 'utf8')).toBe('new brief');
    // The source is untouched.
    expect(await readFile(join(m.root, 'kept', 'job-src', 'a1', 'out', 'index.html'), 'utf8')).toBe(
      '<p>v1</p>',
    );
    expect(await kept.seedLocal('job-missing', 'a1', { path: next.path, inDir: next.inDir })).toBeNull();
  });

  it('seeds through the master (relay) from another machine', async () => {
    const a = await setup();
    const src = await scratchWith(a.m, 'job-src', {
      'in/data.csv': 'a,b',
      'out/deck/index.html': `<h1>${'x'.repeat(250_000)}</h1>`,
    });
    await a.kept.keep(src, {
      projectId: 'genel',
      outcome: 'succeeded',
      expiresAt: iso(a.now.t + DAY),
      maxBytes: 1024 ** 3,
    });
    const b = await setup();
    const next = await b.m.prepareScratch({ jobId: 'job-next', attemptId: 'b1', epoch: 1 });
    const calls: string[] = [];
    // The master relays each read op to machine A (here: directly).
    const relay = (op: WorkfilesReadOp): Promise<WorkfilesDataPayload> => {
      calls.push(op.op === 'list' ? 'list' : `read ${op.path}@${String(op.offset)}`);
      return a.kept.answerRead('job-src', 'a1', op, '00000000-0000-4000-8000-000000000003');
    };
    const r = await seedFromRemote(relay, { path: next.path, inDir: next.inDir });
    expect(r).toMatchObject({ files: 2, skipped: 0 });
    expect(calls[0]).toBe('list');
    expect(calls.filter((c) => c.startsWith('read out/deck/index.html'))).toHaveLength(2);
    expect((await readFile(join(next.path, 'out', 'deck', 'index.html'), 'utf8')).length).toBe(250_009);
    expect((await stat(join(next.inDir, 'data.csv'))).mode & 0o777).toBe(0o444);
    // A source that is gone: nothing seeded, no throw.
    const gone = await seedFromRemote(
      () => Promise.resolve({ requestId: '00000000-0000-4000-8000-000000000004', status: 'not_found' }),
      { path: next.path, inDir: next.inDir },
    );
    expect(gone).toBeNull();
  });

  it('tells the agent the directory is kept and that it continues from earlier files', () => {
    const text = workspacePreamble([], 'none', {
      keepDays: 14,
      seeded: { jobId: 'job-src', files: 3, truncated: false },
    });
    expect(text).toContain('kept on this machine for 14 day(s)');
    expect(text).toContain('continues the work of job job-src');
    expect(workspacePreamble([], 'none')).toContain('discarded when the job ends');
  });
});
