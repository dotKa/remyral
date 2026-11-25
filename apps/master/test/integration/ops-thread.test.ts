import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalService } from '../../src/approvals/index.js';
import { AuditLog } from '../../src/audit/audit.js';
import type { Role } from '../../src/auth/users.js';
import { type JobActor, JobStore } from '../../src/jobs/index.js';
import type { NotificationService } from '../../src/notifications/index.js';
import { describeIntegration } from '../helpers/env.js';
import { type Client, enroll, Harness } from '../helpers/harness.js';

/**
 * p12-diyalog Faz 1 (docs/design/p12-diyalog.md §9): `GET /ops-thread` — the caller's notifications merged with
 * the open cards they can see. Merge order (newest first, stable ids, one card per entity), keyset cursor
 * (`before`, no repeats or gaps, open counts on the first page only), authorization per role and project (cards
 * and the entities behind a notification), and no secret in any item.
 */
const PW = 'quartz-meadow-lantern-7';
const ALPHA = 'alpha';
const BETA = 'beta';
const HOUR = 3_600_000;
const SECRET = `ghp_${'Qa7Ws8Ed9Rf0'.repeat(3)}`;
const CREATOR: JobActor = { type: 'user', id: '00000000-0000-4000-8000-000000000001' };

interface Person {
  readonly id: string;
  readonly client: Client;
}
interface Item {
  id: string;
  type: string;
  at: string;
  subject: string | null;
  unread: boolean;
  event: { notificationId: string; kind: string; link: string | null } | null;
  payload: Record<string, unknown> | null;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
  open: Record<string, number> | null;
}

let h: Harness;
let jobs: JobStore;
let approvals: ApprovalService;
let notes: NotificationService;
const p = {} as Record<'owner' | 'opA' | 'viewerA' | 'opB', Person>;
let approvalId = '';
let failedBeta = '';

async function person(username: string, role: Role, projects: string[]): Promise<Person> {
  const id = await h.createUser(username, PW, role);
  if (role === 'operator' || role === 'viewer') await h.grant(id, projects, role);
  const { client } = await enroll(h, username, PW);
  return { id, client };
}

async function runningJob(project: string, workerId: string) {
  const { job } = await jobs.create({
    project,
    actor: CREATOR,
    submit: true,
    spec: {
      runtime: 'codex',
      prompt: `Rotate the deploy key ${SECRET}`,
      repository: { url: 'https://example.com/acme/repo.git', baseRef: 'main', workBranch: 'rac/thread' },
      sandboxProfile: 'container',
      approvalPolicy: 'ask-sensitive',
      limits: { maxDurationSec: 3600 },
    },
  });
  const grant = await jobs.acquireLease(job.id, workerId, HOUR);
  const actor: JobActor = { type: 'worker', id: workerId };
  const epoch = grant.lease.epoch;
  await jobs.transition(job.id, 'lease_acked', { actor, epoch });
  await jobs.transition(job.id, 'runtime_started', { actor, epoch });
  return { jobId: job.id, attemptId: grant.attempt.id, epoch, actor };
}

async function page(x: Person, query = ''): Promise<Page> {
  const res = await x.client.req('GET', `/ops-thread${query}`);
  expect(res.statusCode, res.body).toBe(200);
  expect(res.body).not.toContain(SECRET);
  return res.json<Page>();
}

/** A plain notification for `who` at `at` (history ordering / cursor tests). */
async function note(
  who: Person,
  at: Date,
  link: string | null = null,
  kind = 'monitor.down',
): Promise<string> {
  const id = randomUUID();
  await h.db.pool.query(
    `INSERT INTO notifications (id, recipient_id, kind, severity, title, body, link, dedupe_key, created_at)
     VALUES ($1, $2, $3, 'warning', 'Monitor down', 'site answers 502', $4, $5, $6)`,
    [id, who.id, kind, link, `test:${id}`, at],
  );
  return id;
}

function ids(items: readonly Item[]): string[] {
  return items.map((i) => i.id);
}

function isNewestFirst(items: readonly Item[]): boolean {
  return items.every(
    (it, i) =>
      i === 0 ||
      Date.parse(items[i - 1]?.at ?? '') > Date.parse(it.at) ||
      (Date.parse(items[i - 1]?.at ?? '') === Date.parse(it.at) && (items[i - 1]?.id ?? '') > it.id),
  );
}

describeIntegration('ops thread (integration)', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    h = new Harness();
    await h.start();
    notes = h.app.notifications;
    const audit = new AuditLog(h.db.pool, h.clock.now);
    jobs = new JobStore({ pool: h.db.pool, audit, clock: h.clock.now });
    approvals = new ApprovalService({ pool: h.db.pool, audit, jobs, clock: h.clock.now });

    p.owner = await person('owner', 'owner', []);
    p.opA = await person('op.alpha', 'operator', [ALPHA]);
    p.viewerA = await person('viewer.alpha', 'viewer', [ALPHA]);
    p.opB = await person('op.beta', 'operator', [BETA]);

    // Alpha: a running job asks for an in-run approval (operators decide → owner and op.alpha are notified).
    const a = await runningJob(ALPHA, 'worker-a');
    const ev = await approvals.evaluate({
      action: 'bash',
      jobId: a.jobId,
      approvalKey: 'call-1',
      attemptId: a.attemptId,
      epoch: a.epoch,
      summary: `curl -H "Authorization: Bearer ${SECRET}" https://example.org`,
      risk: 'high',
      requestedBy: { type: 'runtime', id: 'worker-a' },
    });
    if (ev.outcome !== 'pending') throw new Error('expected pending');
    approvalId = ev.requestId;

    // Beta: a job fails (owner and op.beta are notified).
    h.clock.advance(60_000);
    const b = await runningJob(BETA, 'worker-b');
    await jobs.transition(b.jobId, 'attempt_failed', {
      actor: b.actor,
      epoch: b.epoch,
      reason: `exit 1 ${SECRET}`,
    });
    failedBeta = b.jobId;
    h.clock.advance(60_000);
    await notes.runOnce();
  });

  afterAll(async () => {
    await h.stop();
  });

  describe('merge', () => {
    it('owner: the approval and the failure are cards (one per entity), newest first, with open counts', async () => {
      const pg = await page(p.owner);
      expect(isNewestFirst(pg.items)).toBe(true);
      expect(new Set(ids(pg.items)).size).toBe(pg.items.length);
      const approval = pg.items.find((i) => i.id === `approval:${approvalId}`);
      expect(approval).toMatchObject({
        type: 'approval:request',
        subject: `approval:${approvalId}`,
        unread: true,
      });
      // The announcing notification and the open card became one item: event attached, current payload.
      expect(approval?.event?.kind).toBe('approval.requested');
      expect(approval?.payload).toMatchObject({ id: approvalId, status: 'pending', project: ALPHA });
      const failure = pg.items.find((i) => i.id === `job:${failedBeta}`);
      expect(failure).toMatchObject({ type: 'job:failed', subject: `job:${failedBeta}` });
      expect(failure?.payload).toMatchObject({ id: failedBeta, state: 'FAILED', project: BETA });
      // No notification item left over for either entity.
      expect(pg.items.filter((i) => i.event?.link === `/approvals/${approvalId}`)).toHaveLength(1);
      expect(pg.open).toMatchObject({ approvals: 1, failures: 1, deploys: 0, merges: 0, limits: 0 });
    });

    it('a decided approval stays as its card with the outcome; follow-ups are events naming the card', async () => {
      const fresh = await note(p.opA, h.clock.now(), `/approvals/${approvalId}`, 'approval.stale');
      h.clock.advance(1_000);
      await approvals.decide(
        approvalId,
        'deny',
        { id: p.owner.id, role: 'owner', mfaAt: h.clock.now() },
        { reason: 'not on a Friday' },
      );
      const pg = await page(p.opA);
      const card = pg.items.find((i) => i.id === `approval:${approvalId}`);
      expect(card?.type).toBe('approval:request');
      expect(card?.payload).toMatchObject({ status: 'denied', decisionReason: 'not on a Friday' });
      expect(card?.payload?.decidedBy).toMatchObject({ username: 'owner' });
      const follow = pg.items.find((i) => i.id === `n:${fresh}`);
      expect(follow).toMatchObject({
        type: 'event:approval.stale',
        subject: `approval:${approvalId}`,
        payload: null,
      });
      // Not pending any more: no longer counted.
      expect(pg.open?.approvals).toBe(0);
    });
  });

  describe('authorization', () => {
    it('op.beta never sees alpha: no card, no payload behind a notification that points at it', async () => {
      const leaked = await note(p.opB, h.clock.now(), `/approvals/${approvalId}`, 'approval.stale');
      const pg = await page(p.opB);
      expect(pg.items.some((i) => i.id === `approval:${approvalId}`)).toBe(false);
      const item = pg.items.find((i) => i.id === `n:${leaked}`);
      // Its own notification text stays (it already received it); the alpha entity is not attached.
      expect(item).toMatchObject({ type: 'event:approval.stale', subject: null, payload: null });
      expect(pg.items.some((i) => i.id === `job:${failedBeta}`)).toBe(true);
      expect(pg.items.some((i) => i.payload?.project === ALPHA)).toBe(false);
    });

    it('viewer.alpha: sees what it may read (alpha cards from the open set) and nothing of beta', async () => {
      const a = await runningJob(ALPHA, 'worker-c');
      const ev = await approvals.evaluate({
        action: 'bash',
        jobId: a.jobId,
        approvalKey: 'call-2',
        attemptId: a.attemptId,
        epoch: a.epoch,
        summary: 'rm -rf node_modules',
        risk: 'high',
        requestedBy: { type: 'runtime', id: 'worker-c' },
      });
      if (ev.outcome !== 'pending') throw new Error('expected pending');
      const pg = await page(p.viewerA);
      // A viewer is not notified (cannot decide), but can read the pending approval: an open card.
      expect(pg.items.find((i) => i.id === `approval:${ev.requestId}`)).toMatchObject({
        type: 'approval:request',
        event: null,
        unread: false,
      });
      expect(pg.items.some((i) => i.id === `job:${failedBeta}`)).toBe(false);
      expect(pg.open?.approvals).toBe(1);
    });

    it('an integration waiting for its pull request to be merged is a merge card for alpha only', async () => {
      const root = await runningJob(ALPHA, 'worker-d');
      const id = randomUUID();
      const now = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO integrations (id, project, source, root_job_id, branch, target_branch, repository_url, base_sha,
                                   head_sha, order_mode, state, max_resolutions, max_fixes, pr_number, pr_url,
                                   created_by, created_at, updated_at)
         VALUES ($1, $2, 'coordinator', $3, 'int/7c1e09ab', 'main', 'https://example.com/acme/repo.git', $4, $4,
                 'dependency', 'ready', 3, 1, 218, 'https://github.com/acme/repo/pull/218', $5, $6, $6)`,
        [id, ALPHA, root.jobId, 'a'.repeat(40), p.owner.id, now],
      );
      const mine = await page(p.opA);
      expect(mine.items.find((i) => i.id === `merge:${id}`)).toMatchObject({
        type: 'merge:integration',
        payload: { state: 'ready', branch: 'int/7c1e09ab', pullRequest: { number: 218 } },
      });
      expect(mine.open?.merges).toBe(1);
      const other = await page(p.opB);
      expect(other.items.some((i) => i.id === `merge:${id}`)).toBe(false);
      expect(other.open?.merges).toBe(0);
      // The repository URL never travels with the card.
      expect(JSON.stringify(mine.items.find((i) => i.id === `merge:${id}`))).not.toContain(
        'example.com/acme',
      );
    });

    it('unauthenticated: 401', async () => {
      const res = await h.client().req('GET', '/ops-thread');
      expect(res.statusCode).toBe(401);
    });
  });

  describe('cursor', () => {
    it('pages history newest first without repeats or gaps; open cards only on the first page', async () => {
      const base = h.clock.now().getTime();
      const made: string[] = [];
      for (let i = 0; i < 7; i++) made.push(await note(p.opB, new Date(base - (i + 1) * 60_000)));
      // Two notifications in the same millisecond: the id breaks the tie.
      made.push(
        await note(p.opB, new Date(base - 8 * 60_000)),
        await note(p.opB, new Date(base - 8 * 60_000)),
      );
      const seen: Item[] = [];
      let cursor: string | null = null;
      let first = true;
      do {
        const q: string = cursor === null ? '?limit=3' : `?limit=3&before=${encodeURIComponent(cursor)}`;
        const pg = await page(p.opB, q);
        if (first) expect(pg.open).not.toBeNull();
        else {
          expect(pg.open).toBeNull();
          expect(pg.items.every((i) => i.id.startsWith('n:'))).toBe(true);
        }
        expect(isNewestFirst(pg.items)).toBe(true);
        seen.push(...pg.items);
        cursor = pg.nextCursor;
        first = false;
      } while (cursor !== null);
      const seenIds = ids(seen);
      expect(new Set(seenIds).size).toBe(seenIds.length);
      for (const id of made) expect(seenIds).toContain(`n:${id}`);
    });

    it('a malformed or foreign cursor is a 400', async () => {
      const res = await p.opB.client.req('GET', '/ops-thread?before=bm90LWEtY3Vyc29y');
      expect(res.statusCode).toBe(400);
      const jobsCursor = (await p.opB.client.req('GET', '/jobs?limit=1')).json<{
        nextCursor: string | null;
      }>();
      if (jobsCursor.nextCursor !== null) {
        const r2 = await p.opB.client.req(
          'GET',
          `/ops-thread?before=${encodeURIComponent(jobsCursor.nextCursor)}`,
        );
        expect(r2.statusCode).toBe(400);
      }
    });
  });

  // p15-rerun-thread: a failed job's card names the caller's own conversation that started it (its re-run is drafted
  // there), never "the latest conversation" and never another user's.
  describe('failed job: the conversation that started it', () => {
    async function thread(who: Person, title: string, archived = false): Promise<string> {
      const id = randomUUID();
      const at = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO chat_threads (id, user_id, title, archived_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [id, who.id, title, archived ? at : null, at],
      );
      return id;
    }
    async function confirmed(
      who: Person,
      threadId: string,
      kind: string,
      result: Record<string, unknown>,
    ): Promise<void> {
      const at = h.clock.now();
      await h.db.pool.query(
        `INSERT INTO chat_drafts (id, thread_id, user_id, turn_id, kind, title, payload, payload_hash, project, state,
                                  result, created_at, expires_at, decided_at)
         VALUES ($1, $2, $3, $4, $5, 'card', '{}', $6, $7, 'confirmed', $8, $9, $9, $9)`,
        [
          randomUUID(),
          threadId,
          who.id,
          randomUUID(),
          kind,
          'a'.repeat(64),
          BETA,
          JSON.stringify(result),
          at,
        ],
      );
    }
    async function failedJob(): Promise<string> {
      const b = await runningJob(BETA, `worker-${randomUUID().slice(0, 6)}`);
      await jobs.transition(b.jobId, 'attempt_failed', { actor: b.actor, epoch: b.epoch, reason: 'exit 1' });
      return b.jobId;
    }
    const threadOf = (pg: Page, jobId: string): unknown =>
      pg.items.find((i) => i.id === `job:${jobId}`)?.payload?.chatThreadId;

    it('a chat-started job names its conversation, not the newer one the user chatted in last', async () => {
      const jobId = await failedJob();
      const started = await thread(p.owner, 'started the job');
      await confirmed(p.owner, started, 'job', { jobId });
      h.clock.advance(1_000);
      // The user moved on: a newer conversation (the home used to draft the re-run here).
      const latest = await thread(p.owner, 'something else');
      await confirmed(p.owner, latest, 'job_action', { action: 'cancel', jobId });
      const pg = await page(p.owner);
      expect(threadOf(pg, jobId)).toBe(started);
      expect(threadOf(pg, jobId)).not.toBe(latest);
    });

    it('a job started by a run-again card names the conversation of that card', async () => {
      const jobId = await failedJob();
      const rerunIn = await thread(p.owner, 'ran it again here');
      await confirmed(p.owner, rerunIn, 'job_action', { action: 'run_again', jobId });
      expect(threadOf(await page(p.owner), jobId)).toBe(rerunIn);
    });

    it('none for a job not started from chat, an archived conversation, or another user', async () => {
      const plain = await failedJob();
      const archivedJob = await failedJob();
      await confirmed(p.owner, await thread(p.owner, 'archived', true), 'job', { jobId: archivedJob });
      const theirs = await failedJob();
      await confirmed(p.owner, await thread(p.owner, 'owner only'), 'job', { jobId: theirs });
      const owner = await page(p.owner);
      expect(threadOf(owner, plain)).toBeNull();
      expect(threadOf(owner, archivedJob)).toBeNull();
      // op.beta sees the failure, but not the owner's private conversation.
      const other = await page(p.opB);
      expect(other.items.some((i) => i.id === `job:${theirs}`)).toBe(true);
      expect(threadOf(other, theirs)).toBeNull();
    });
  });

  it('no secret from prompts, summaries or failure reasons reaches any item', async () => {
    for (const x of [p.owner, p.opA, p.viewerA, p.opB]) {
      const res = await x.client.req('GET', '/ops-thread?limit=100');
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(SECRET);
    }
  });
});
