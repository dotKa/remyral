import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/audit.js';
import { loadSubject } from '../../src/authz/authorizer.js';
import { ChatImageTools } from '../../src/chat/image-tools.js';
import { ChatStore } from '../../src/chat/store.js';
import { ChatTools, type ChatToolsDeps } from '../../src/chat/tools.js';
import { JobStore } from '../../src/jobs/store.js';
import { describeIntegration } from '../helpers/env.js';
import { Harness } from '../helpers/harness.js';

/**
 * p20-chat-images (docs/design/p20-chat-images.md §2, §3) on real Postgres through ChatTools:
 *
 * - both tools answer only a turn on a worker with `assistant-images-v1` (older worker: unavailable);
 * - show_image returns cards (ids, never a URL) for a reader of the job's project; another project's member gets
 *   "not found";
 * - draft_screenshot: no machine with a browser → unavailable with the draft_tool_install step; a repository project
 *   is refused; a viewer may not create jobs; otherwise a job card with the master-built spec (workspace mode, the
 *   fixed prompt, `requirements.tools: [browser]`, 15 minutes) and the screenshot payload.
 */
const PW = 'quartz-meadow-lantern-8';
const WS = 'shots';
const REPO = 'alpha';
const OTHER = 'beta';
const WORKER = `wrk_${'b'.repeat(26)}`;

describeIntegration('p20-chat-images: show_image and draft_screenshot', { timeout: 300_000 }, () => {
  const h = new Harness();
  let opId = '';
  let viewerId = '';
  let outsiderId = '';
  let jobId = '';
  let store: ChatStore;

  beforeAll(async () => {
    await h.start();
    await h.createUser('owner.p20', PW, 'owner');
    opId = await h.createUser('op.p20', PW, 'operator');
    await h.grant(opId, [WS, REPO], 'operator');
    viewerId = await h.createUser('viewer.p20', PW, 'viewer');
    await h.grant(viewerId, [WS], 'viewer');
    outsiderId = await h.createUser('outsider.p20', PW, 'operator');
    await h.grant(outsiderId, [OTHER], 'operator');
    await h.db.pool.query(`UPDATE projects SET kind = 'workspace' WHERE id = $1`, [WS]);
    await h.db.pool.query(
      `INSERT INTO project_workspaces (project, egress, updated_at) VALUES ($1, 'web', now()) ON CONFLICT DO NOTHING`,
      [WS],
    );
    store = new ChatStore({ pool: h.db.pool, clock: h.clock.now });
    const jobs = new JobStore({
      pool: h.db.pool,
      audit: new AuditLog(h.db.pool, h.clock.now),
      clock: h.clock.now,
    });
    jobId = (
      await jobs.create({
        project: WS,
        actor: { type: 'user', id: opId },
        submit: true,
        spec: {
          runtime: 'codex',
          prompt: 'Take a screenshot',
          sandboxProfile: 'container',
          approvalPolicy: 'ask-sensitive',
          limits: { maxDurationSec: 900 },
        },
      })
    ).job.id;
    const attempt = randomUUID();
    for (const [artifactId, name, mediaType, data] of [
      [
        'ws-home-desktop',
        'screenshots/01-home-desktop.png',
        'image/png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      ],
      ['ws-summary', 'summary.md', 'text/markdown', Buffer.from('# hi\n')],
    ] as const)
      await h.db.pool.query(
        `INSERT INTO job_artifacts (attempt_id, job_id, artifact_id, name, media_type, size_bytes, sha256, kind,
                                    redacted, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'output', false, $8, now())`,
        [
          attempt,
          jobId,
          artifactId,
          name,
          mediaType,
          data.length,
          createHash('sha256').update(data).digest('hex'),
          data,
        ],
      );
  });
  afterAll(async () => {
    await h.stop();
  });

  const tools = (): ChatTools =>
    new ChatTools({
      db: h.db.pool,
      store,
      clock: h.clock.now,
      images: () => new ChatImageTools({ db: h.db.pool }),
    } as unknown as ChatToolsDeps);
  const ctx = async (userId: string, role: 'owner' | 'operator' | 'viewer', imageTools = true) => ({
    userId,
    subject: await loadSubject(h.db.pool, { id: userId, role }),
    threadId: (await store.createThread(userId, 'images')).id,
    turnId: randomUUID(),
    imageTools,
  });

  it('an older worker gets "unavailable"; show_image shows the job’s image outputs to a reader only', async () => {
    const legacy = await tools().run(await ctx(opId, 'operator', false), 'show_image', { jobId });
    expect(!legacy.ok && legacy.code).toBe('unavailable');
    const shown = await tools().run(await ctx(viewerId, 'viewer'), 'show_image', {
      jobId,
      caption: 'Ana sayfa',
    });
    expect(shown.ok, JSON.stringify(shown)).toBe(true);
    expect(shown.ok && shown.images).toEqual([
      {
        source: 'output',
        jobId,
        artifactId: 'ws-home-desktop',
        name: 'screenshots/01-home-desktop.png',
        mediaType: 'image/png',
        sizeBytes: 4,
        caption: 'Ana sayfa',
      },
    ]);
    expect(JSON.stringify(shown)).not.toContain('/api/');
    const text = await tools().run(await ctx(viewerId, 'viewer'), 'show_image', {
      jobId,
      artifactIds: ['ws-summary'],
    });
    expect(!text.ok && text.code).toBe('not_found');
    const hidden = await tools().run(await ctx(outsiderId, 'operator'), 'show_image', { jobId });
    expect(!hidden.ok && hidden.code).toBe('not_found');
  });

  it('draft_screenshot: no browser → the install step; repository project and viewer refused; then a job card', async () => {
    const input = {
      urls: [{ url: 'https://example.com/', label: 'Ana sayfa' }],
      viewports: ['desktop', 'mobile'],
    };
    const none = await tools().run(await ctx(opId, 'operator'), 'draft_screenshot', input);
    expect(!none.ok && none.code).toBe('unavailable');
    expect(!none.ok && none.message).toContain('draft_tool_install');

    await h.db.pool.query(
      `INSERT INTO workers (id, display_name, state, facts, worker_version, tools, approved_at, created_at, updated_at)
       VALUES ($1, 'mac', 'online', '{"os":"darwin","arch":"arm64"}'::jsonb, '1.2.13', '[{"name":"browser"}]'::jsonb,
               now(), now(), now())`,
      [WORKER],
    );
    const repo = await tools().run(await ctx(opId, 'operator'), 'draft_screenshot', {
      ...input,
      project: REPO,
    });
    expect(!repo.ok && repo.code).toBe('invalid');
    const viewer = await tools().run(await ctx(viewerId, 'viewer'), 'draft_screenshot', {
      ...input,
      project: WS,
    });
    expect(!viewer.ok && viewer.code).toBe('forbidden');
    const creds = await tools().run(await ctx(opId, 'operator'), 'draft_screenshot', {
      urls: [{ url: 'https://user:pw@example.com/' }],
    });
    expect(!creds.ok && creds.code).toBe('invalid');

    const out = await tools().run(await ctx(opId, 'operator'), 'draft_screenshot', input);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok || out.draft === undefined) throw new Error('draft');
    expect(out.draft.kind).toBe('job');
    expect(out.draft.project).toBe(WS);
    const payload = out.draft.payload as {
      spec: {
        mode?: string;
        prompt: string;
        requirements?: { tools?: string[] };
        limits?: { maxDurationSec?: number };
      };
      screenshot: { files: string[]; viewports: string[] };
    };
    expect(payload.spec.requirements?.tools).toEqual(['browser']);
    expect(payload.spec.limits?.maxDurationSec).toBe(900);
    expect(payload.spec.prompt).toContain('https://example.com/');
    expect(payload.spec.prompt).toContain('out/screenshots/01-ana-sayfa-mobile.png');
    expect(payload.screenshot.files).toEqual([
      'screenshots/01-ana-sayfa-desktop.png',
      'screenshots/01-ana-sayfa-mobile.png',
    ]);
  });
});
