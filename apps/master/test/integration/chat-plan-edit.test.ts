import { FakeAssistantEngine, fakeToolData } from '@remyral/agent-adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import {
  CAPS,
  pairRealWorker,
  removeDirs,
  type RunningWorker,
  runRealWorker,
  tempDataDir,
} from '../helpers/real-worker.js';

/**
 * p18-plan-mode W3 (docs/design/p18-plan-mode.md §3 "Editing", §6 W3) end to end through the real transport: the owner
 * edits the plan (rename, add, remove + undo, skip, reorder, move between phases, owner / estimate) with the revision
 * they saw; every edit survives a reload and shows in a second session; a stale revision is 409 with the current plan
 * (the console's merge view); structural edits make user versions without re-approval and the assistant's next turn
 * reads them as a diff; the versions list and the diff between any two versions; shared readers and a closed plan
 * cannot be edited.
 */
const PW = 'amber-kettle-orchard-62';

interface PlanItem {
  key: string;
  title: string;
  phase: number;
  phaseTitle: string;
  position: number;
  status: string;
  owner: string;
  estimate: string | number | null;
}
interface Plan {
  id: string;
  state: string;
  version: number;
  rev: number;
  items: PlanItem[];
  lastChange: { author: string; added: number; removed: number; changed: number; moved: number } | null;
}

describeIntegration('plan editing (integration, p18-plan-mode W3)', { timeout: 300_000 }, () => {
  const h = new Harness();
  const engine = new FakeAssistantEngine();
  const dirs: string[] = [];
  let worker: RunningWorker | undefined;
  let owner: Client;
  let ownerSecret = '';
  let second: Client;
  let reader: Client;
  let readerId = '';
  let thread = '';
  let planId = '';
  let seenContext = '';
  let url = '';

  async function stepUp(c: Client, secret: string): Promise<void> {
    h.clock.advance(30_000);
    expect((await c.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }
  async function plan(c: Client = owner): Promise<Plan> {
    const r = await c.req('GET', `/chat/threads/${thread}`);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json<{ plan?: { active: Plan | null } }>().plan?.active;
    if (p == null) throw new Error('no active plan');
    return p;
  }
  async function edit(ops: unknown[], baseRev?: number): Promise<Plan> {
    const rev = baseRev ?? (await plan()).rev;
    const r = await owner.req('PATCH', `/chat/plans/${planId}/items`, { baseRev: rev, ops });
    expect(r.statusCode, r.body).toBe(200);
    return r.json<Plan>();
  }
  const order = (p: Plan): string[] => p.items.map((i) => `${i.phaseTitle}:${i.key}`);
  async function ask(text: string): Promise<string> {
    const r = await owner.req('POST', `/chat/threads/${thread}/messages`, { text });
    expect(r.statusCode, r.body).toBe(202);
    const seq = r.json<{ message: { seq: number } }>().message.seq;
    let last = '';
    await expect
      .poll(
        async () => {
          const d = (await owner.req('GET', `/chat/threads/${thread}`)).json<{
            turn: unknown;
            messages: { seq: number; role: string; content: string }[];
          }>();
          last =
            d.messages.filter((m) => m.seq > seq && (m.role === 'assistant' || m.role === 'error')).at(-1)
              ?.content ?? '';
          return d.turn === null && last !== '';
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    return last;
  }

  beforeAll(async () => {
    await h.start({
      securityPolicy: { preset: 'serbest' },
      workers: { connectRateLimit: { perIp: 1_000, windowMs: 60_000 }, pairing: { perIp: 50 } },
    });
    url = await h.listen();
    const ownerId = await h.createUser('owner.planedit', PW);
    ({ secret: ownerSecret } = await enroll(h, 'owner.planedit', PW));
    owner = await fullLogin(h, 'owner.planedit', PW, ownerSecret);
    second = await fullLogin(h, 'owner.planedit', PW, ownerSecret);
    await h.grant(ownerId, ['alpha'], 'operator');
    readerId = await h.createUser('reader.planedit', PW, 'viewer');
    await h.grant(readerId, ['alpha'], 'viewer');
    const { secret: rs } = await enroll(h, 'reader.planedit', PW);
    reader = await fullLogin(h, 'reader.planedit', PW, rs);

    engine.script(/PLAN-E/, async (ctx) => {
      const created = await ctx.call('plan_create', {
        title: 'Sürüm 2.5',
        goal: 'Sürüm 2.5 yayında.',
        phases: [
          {
            title: 'Hazırlık',
            items: [
              { key: 'analiz', title: 'Değişiklikleri incele', owner: 'assistant' },
              { key: 'testler', title: 'Testleri düzelt', owner: 'job', estimate: 'M' },
            ],
          },
          { title: 'Yayın', items: [{ key: 'notlar', title: 'Changelog yaz', owner: 'assistant' }] },
        ],
      });
      return `plan ${(fakeToolData(created.content) as { planId: string }).planId}`;
    });
    // The next turn reports what its plan block said about the person's edits.
    engine.script(/SEE-EDITS/, (ctx) => {
      seenContext = ctx.context ?? '';
      return Promise.resolve('gördüm');
    });
  });
  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    await h.stop();
    await removeDirs(dirs);
  });

  it('sets up the assistant machine and a plan in review', async () => {
    const dataDir = await tempDataDir(dirs);
    const workerId = await pairRealWorker(h, url, owner, ownerSecret, dataDir);
    worker = await runRealWorker(url, dataDir, {
      capabilities: CAPS,
      assistant: { engine, clock: h.clock.now },
    });
    await stepUp(owner, ownerSecret);
    const s = await owner.req('PUT', '/chat/settings', {
      enabled: true,
      workerId,
      runtime: 'claude-code',
      modelProfile: null,
      expectedVersion: 1,
    });
    expect(s.statusCode, s.body).toBe(200);
    await expect
      .poll(async () => (await owner.req('GET', '/chat/status')).json<{ plan: boolean }>().plan, {
        timeout: 20_000,
      })
      .toBe(true);
    thread = (await owner.req('POST', '/chat/threads', {})).json<{ id: string }>().id;
    expect((await owner.req('PUT', `/chat/threads/${thread}/plan-mode`, { on: true })).statusCode).toBe(200);
    expect(await ask('PLAN-E 2.5 sürümünü planla')).toMatch(/^plan /);
    const p = await plan();
    planId = p.id;
    expect(p).toMatchObject({ state: 'in_review', version: 1 });
  });

  describe('edits persist (reload, second session)', () => {
    it('rename → a user version, no re-approval needed; a second session reads it', async () => {
      const p = await edit([{ op: 'rename', key: 'testler', title: 'Testleri onar' }]);
      expect(p).toMatchObject({ state: 'in_review', version: 2 });
      expect(p.lastChange).toMatchObject({ author: 'user', changed: 1 });
      expect((await plan(second)).items.find((i) => i.key === 'testler')?.title).toBe('Testleri onar');
      const audit = await h.db.pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events WHERE action = 'chat.plan.edit' AND target = $1 ORDER BY id DESC LIMIT 1`,
        [`chat-plan:${planId}`],
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ by: 'user', version: 2, ops: ['rename'] });
    });

    it('add (per phase, with owner and estimate) lands where asked', async () => {
      const p = await edit([
        {
          op: 'add',
          item: { title: 'Smoke test', owner: 'assistant', estimate: 'S' },
          phase: 0,
          after: 'testler',
        },
      ]);
      expect(order(p)).toEqual(['Hazırlık:analiz', 'Hazırlık:testler', 'Hazırlık:u1', 'Yayın:notlar']);
      expect(p.items.find((i) => i.key === 'u1')).toMatchObject({ owner: 'assistant', estimate: 'S' });
      expect(order(await plan(second))).toEqual(order(p));
    });

    it('delete, then undo (restore) — the item comes back where it was; delete persists without undo', async () => {
      const gone = await edit([{ op: 'remove', key: 'u1' }]);
      expect(gone.items.some((i) => i.key === 'u1')).toBe(false);
      expect((await plan(second)).items.some((i) => i.key === 'u1')).toBe(false);
      const back = await edit([{ op: 'restore', key: 'u1' }]);
      expect(order(back)).toEqual(['Hazırlık:analiz', 'Hazırlık:testler', 'Hazırlık:u1', 'Yayın:notlar']);
      expect(order(await plan(second))).toEqual(order(back));
      // The only item of a phase: the phase comes back with it.
      await edit([{ op: 'remove', key: 'notlar' }]);
      expect((await plan()).items.some((i) => i.phaseTitle === 'Yayın')).toBe(false);
      const again = await edit([{ op: 'restore', key: 'notlar' }]);
      expect(order(again)).toEqual(['Hazırlık:analiz', 'Hazırlık:testler', 'Hazırlık:u1', 'Yayın:notlar']);
    });

    it('skip / un-skip change only the status (no version)', async () => {
      const before = await plan();
      const s = await edit([{ op: 'skip', key: 'u1' }]);
      expect(s.items.find((i) => i.key === 'u1')?.status).toBe('skipped');
      expect(s.version).toBe(before.version);
      expect(s.rev).toBeGreaterThan(before.rev);
      expect((await plan(second)).items.find((i) => i.key === 'u1')?.status).toBe('skipped');
      const u = await edit([{ op: 'unskip', key: 'u1' }]);
      expect(u.items.find((i) => i.key === 'u1')?.status).toBe('pending');
    });

    it('reorder (keyboard and pointer send the same move) and move between phases persist', async () => {
      // Keyboard: "u1" up twice → first of its phase.
      const k = await edit([{ op: 'move', key: 'u1', phase: 0, after: null }]);
      expect(order(k)).toEqual(['Hazırlık:u1', 'Hazırlık:analiz', 'Hazırlık:testler', 'Yayın:notlar']);
      // Pointer: "testler" dropped into the next phase, after "notlar".
      const d = await edit([{ op: 'move', key: 'testler', phase: 1, after: 'notlar' }]);
      expect(order(d)).toEqual(['Hazırlık:u1', 'Hazırlık:analiz', 'Yayın:notlar', 'Yayın:testler']);
      expect(order(await plan(second))).toEqual(order(d));
      const reloaded = await owner.req('GET', `/chat/plans/${planId}`);
      expect(order(reloaded.json<Plan>())).toEqual(order(d));
    });

    it('owner / estimate edits are structural', async () => {
      const p = await edit([
        { op: 'set_owner', key: 'notlar', owner: 'user' },
        { op: 'set_estimate', key: 'notlar', estimate: 45 },
      ]);
      expect(p.items.find((i) => i.key === 'notlar')).toMatchObject({ owner: 'user', estimate: 45 });
      expect(p.lastChange).toMatchObject({ author: 'user', changed: 1 });
    });
  });

  describe('conflicts and the assistant', () => {
    it('an edit at a stale revision is 409 plan_rev_conflict with the current plan', async () => {
      const cur = await plan();
      const r = await owner.req('PATCH', `/chat/plans/${planId}/items`, {
        baseRev: cur.rev - 1,
        ops: [{ op: 'rename', key: 'analiz', title: 'Eski' }],
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'plan_rev_conflict', plan: { id: planId, rev: cur.rev } });
      // Re-applied at the current revision it goes through (the merge view's "Yeniden uygula").
      const again = await edit(
        [{ op: 'rename', key: 'analiz', title: 'Değişiklikleri gözden geçir' }],
        cur.rev,
      );
      expect(again.items.find((i) => i.key === 'analiz')?.title).toBe('Değişiklikleri gözden geçir');
    });

    it('the assistant’s next turn reads the person’s edits as a diff against its own version', async () => {
      expect(await ask('SEE-EDITS planı gördün mü?')).toBe('gördüm');
      expect(seenContext).toContain('Kullanıcı planı düzenledi');
      expect(seenContext).toContain('your v1 → their v');
      expect(seenContext).toContain('Değişiklikleri gözden geçir');
      expect(seenContext).toContain('Smoke test');
      expect(seenContext).toMatch(/"moved": \[[^\]]*"testler"/);
    });

    it('versions list the user versions; the diff of any two versions is right', async () => {
      const r = await second.req('GET', `/chat/plans/${planId}/versions`);
      expect(r.statusCode, r.body).toBe(200);
      const versions = r.json<{ versions: { version: number; author: string; added: number }[] }>().versions;
      const cur = await plan();
      expect(versions[0]).toMatchObject({ version: cur.version, author: 'user' });
      expect(versions.at(-1)).toMatchObject({ version: 1, author: 'assistant' });
      expect(versions.filter((v) => v.author === 'user').length).toBe(cur.version - 1);
      const d = await second.req('GET', `/chat/plans/${planId}/diff?from=1&to=${String(cur.version)}`);
      expect(d.statusCode, d.body).toBe(200);
      const diff = d.json<{
        added: string[];
        removed: string[];
        changed: { key: string; fields: string[] }[];
        moved: string[];
        from: { version: number; author: string };
        to: { version: number; author: string };
        items: {
          key: string;
          change: string;
          before: { title: string } | null;
          after: { title: string } | null;
        }[];
      }>();
      expect(diff.added).toEqual(['u1']);
      expect(diff.removed).toEqual([]);
      expect(diff.changed).toEqual(
        expect.arrayContaining([
          { key: 'analiz', fields: ['title'] },
          { key: 'testler', fields: ['title'] },
          { key: 'notlar', fields: ['owner', 'estimate'] },
        ]),
      );
      expect(diff.moved).toEqual(expect.arrayContaining(['testler']));
      expect(diff.from).toMatchObject({ version: 1, author: 'assistant' });
      expect(diff.to).toMatchObject({ version: cur.version, author: 'user' });
      expect(diff.items.find((i) => i.key === 'testler')).toMatchObject({
        change: 'changed',
        before: { title: 'Testleri düzelt' },
        after: { title: 'Testleri onar' },
      });
    });
  });

  describe('who may edit', () => {
    it('a shared reader reads versions and diffs but cannot edit', async () => {
      expect((await owner.req('PUT', `/chat/threads/${thread}/shares/${readerId}`)).statusCode).toBe(200);
      expect((await reader.req('GET', `/chat/plans/${planId}/versions`)).statusCode).toBe(200);
      expect((await reader.req('GET', `/chat/plans/${planId}/diff?from=1&to=2`)).statusCode).toBe(200);
      const cur = await plan();
      const r = await reader.req('PATCH', `/chat/plans/${planId}/items`, {
        baseRev: cur.rev,
        ops: [{ op: 'rename', key: 'analiz', title: 'Okur' }],
      });
      expect(r.statusCode).toBe(404);
      expect((await plan()).items.find((i) => i.key === 'analiz')?.title).toBe('Değişiklikleri gözden geçir');
    });

    it('a cancelled plan cannot be edited', async () => {
      expect((await owner.req('POST', `/chat/plans/${planId}/cancel`, {})).statusCode).toBe(200);
      const p = (await owner.req('GET', `/chat/plans/${planId}`)).json<Plan>();
      const r = await owner.req('PATCH', `/chat/plans/${planId}/items`, {
        baseRev: p.rev,
        ops: [{ op: 'skip', key: 'analiz' }],
      });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ error: 'plan_state_conflict' });
    });
  });
});
