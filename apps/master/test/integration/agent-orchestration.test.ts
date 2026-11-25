import { randomUUID } from 'node:crypto';
import { FakeRuntimeAdapter, type FakeScript } from '@remyral/agent-adapters';
import type { CapabilitiesPayload } from '@remyral/worker';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeIntegration, redisUrlWithDb } from '../helpers/env.js';
import { type Client, enroll, fullLogin, Harness } from '../helpers/harness.js';
import { createBareRepo, JOB_CAPS, type JobWorker, startJobWorker } from '../helpers/job-worker.js';
import { pairRealWorker, removeDirs, tempDataDir } from '../helpers/real-worker.js';

const PW = 'quartz-meadow-lantern-7';
const HINT_DB = 12;
const PROJECT = 'studio';
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const T = 60_000;

/**
 * One fake runtime script for every job of this suite, keyed by the prompt:
 * - "Make a video" (parent, claude-code): writes a script, asks a codex sub-job for a thumbnail (waits), copies the
 *   delivered file into out/images/ and finishes;
 * - "a sub-job requested" (child, codex): reads its input, writes out/thumb.png;
 * - "Fire and forget" (parent): starts a sleeping sub-job without waiting and finishes at once (cascade);
 * - "Try pi" (parent): asks for a runtime the project does not allow;
 * - "Nest" (parent) → child asks for its own sub-job ("Nest deeper") → that grandchild has no tools (depth limit).
 */
const script: FakeScript = (prompt) => {
  if (prompt.includes('a sub-job requested')) {
    if (prompt.includes('Sleep long')) return [{ kind: 'sleep', ms: 120_000 }];
    // p22-previews-inputs: the staged 300 KiB input arrives as an ordinary input file.
    if (prompt.includes('Count the lines')) {
      return [
        { kind: 'read-file', path: 'in/data.txt' },
        { kind: 'summary', text: 'Counted.' },
      ];
    }
    if (prompt.includes('Nest deeper')) {
      return [
        {
          kind: 'subtask',
          tool: 'request_subtask',
          args: { title: 'Too deep', prompt: 'Nest deepest', wait: false },
        },
        { kind: 'summary', text: 'grandchild done' },
      ];
    }
    if (prompt.includes('Nest child')) {
      return [
        {
          kind: 'subtask',
          tool: 'request_subtask',
          args: { title: 'Grandchild', prompt: 'Nest deeper', wait: true, waitSec: 60 },
        },
        { kind: 'summary', text: 'child done' },
      ];
    }
    return [
      { kind: 'read-file', path: 'in/script.md' },
      { kind: 'write-file', path: 'out/thumb.png', content: PNG.toString('base64'), encoding: 'base64' },
      { kind: 'summary', text: 'Generated one thumbnail.' },
    ];
  }
  if (prompt.includes('Make a video')) {
    return [
      { kind: 'write-file', path: 'out/script.md', content: '# Script\n\nA short video.\n' },
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: {
          title: 'Thumbnail',
          prompt: 'Generate one thumbnail for the script.',
          requires: ['image-generation'],
          inputs: ['out/script.md'],
          wait: true,
          waitSec: 90,
        },
        copyDeliveredTo: 'images',
      },
      { kind: 'summary', text: 'Video assembled.' },
    ];
  }
  if (prompt.includes('Large input')) {
    return [
      { kind: 'write-file', path: 'out/data.txt', content: 'row\n'.repeat(75 * 1024) },
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: {
          title: 'Count',
          prompt: 'Count the lines.',
          runtime: 'codex',
          inputs: ['out/data.txt'],
          wait: true,
          waitSec: 90,
        },
      },
      { kind: 'summary', text: 'large input handed over' },
    ];
  }
  if (prompt.includes('Fire and forget')) {
    return [
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: { title: 'Sleeper', prompt: 'Sleep long', runtime: 'codex', wait: false },
      },
      { kind: 'sleep', ms: 1_500 },
      { kind: 'summary', text: 'parent done' },
    ];
  }
  if (prompt.includes('Try pi')) {
    return [
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: { title: 'Pi', prompt: 'x', runtime: 'pi', wait: false },
      },
      { kind: 'summary', text: 'tried' },
    ];
  }
  if (prompt.includes('Nest')) {
    return [
      {
        kind: 'subtask',
        tool: 'request_subtask',
        args: { title: 'Child', prompt: 'Nest child', runtime: 'claude-code', wait: true, waitSec: 90 },
      },
      { kind: 'summary', text: 'nest done' },
    ];
  }
  if (prompt.includes('step "plan"')) {
    const plan = prompt.includes('PLAN-PI')
      ? { tasks: [{ id: 'bad', title: 'Bad', prompt: 'x', runtime: 'pi' }] }
      : {
          tasks: [
            {
              id: 'images',
              title: 'Images',
              prompt: 'Draw',
              requires: ['image-generation'],
              machine: 'no-such-pc',
            },
            { id: 'edit', title: 'Edit', prompt: 'Cut', dependsOn: ['images'] },
          ],
        };
    return [{ kind: 'summary', text: `Plan.\n\`\`\`remyral-plan\n${JSON.stringify(plan)}\n\`\`\`` }];
  }
  return [{ kind: 'summary', text: 'ok' }];
};

const capsWith = (runtime: 'claude-code' | 'codex'): CapabilitiesPayload => ({
  ...JOB_CAPS,
  runtimes: [{ ...(JOB_CAPS.runtimes[0] as CapabilitiesPayload['runtimes'][number]), runtime }],
  projects: [PROJECT],
  features: ['workspace-v1'],
  maxParallelJobs: 4,
});

/**
 * p8-orchestration (ADR-0031) end to end: real master (Postgres, BullMQ), two real worker daemons — one runs Claude
 * Code (fake), the other Codex (fake) — and the fake runtime calling the sub-job tools. Covers the project switch,
 * delegation runtimes, the codex sub-job placed on the other machine, inline inputs, waiting, delivered files in the
 * parent's in/subtasks/, the job tree route, audit, refusals (runtime, depth), the cancel cascade, a stale lease, and
 * planner runtime selection (hints resolved against the allowlist, placement on the run view, rejected plans).
 */
describeIntegration('agent orchestration (integration, p8-orchestration)', { timeout: 240_000 }, () => {
  let h: Harness;
  let url: string;
  let admin: Client;
  let secret: string;
  let fileUrl: string;
  const dirs: string[] = [];
  const workers: JobWorker[] = [];
  const ids: Record<string, string> = {};

  async function stepUp(): Promise<void> {
    h.clock.advance(30_000);
    expect((await admin.req('POST', '/auth/step-up', { code: h.code(secret) })).statusCode).toBe(200);
  }

  async function newWorker(runtime: 'claude-code' | 'codex'): Promise<void> {
    const dir = await tempDataDir(dirs);
    const id = await pairRealWorker(h, url, admin, secret, dir);
    const fake = new FakeRuntimeAdapter({ runtime, script });
    const w = await startJobWorker(url, dir, {
      fileUrl,
      capabilities: capsWith(runtime),
      workspaces: { [PROJECT]: { egress: 'none', allowHosts: [] } },
      features: ['subtasks-v1', 'subtask-staged-inputs-v1'],
      ...(runtime === 'codex' ? { adapter: fake } : { extraAdapters: { 'claude-code': fake } }),
    });
    workers.push(w);
    ids[runtime] = id;
    await expect.poll(() => h.app.fleetSessions.hasReported(id), { timeout: 15_000 }).toBe(true);
  }

  beforeAll(async () => {
    h = new Harness();
    await h.start({
      workers: {
        connectRateLimit: { perIp: 1_000, windowMs: 60_000 },
        pairing: { perIp: 50 },
        sweepIntervalMs: 3_600_000,
      },
      orchestration: {
        redisUrl: redisUrlWithDb(HINT_DB),
        hintPrefix: `t${randomUUID().slice(0, 8)}`,
        tickIntervalMs: 50,
        timing: { leaseTtlMs: 3_600_000, reconnectGraceMs: 60_000, retryBackoffMs: 0, effectRetryAfterMs: 0 },
      },
    });
    url = await h.listen();
    await h.createUser('owner1', PW);
    ({ secret } = await enroll(h, 'owner1', PW));
    admin = await fullLogin(h, 'owner1', PW, secret);
    fileUrl = await createBareRepo(dirs);
    await stepUp();
    const res = await admin.req('POST', '/projects', {
      id: PROJECT,
      name: 'Studio',
      kind: 'workspace',
      egress: 'none',
    });
    expect(res.statusCode, res.body).toBe(201);
  });
  // Paired inside the first test (expect.poll needs a test); they serve the whole suite.
  beforeEach(async () => {
    if (workers.length === 0) {
      await newWorker('claude-code');
      await newWorker('codex');
    }
  });
  afterAll(async () => {
    await Promise.all(workers.splice(0).map((w) => w.stop().catch(() => undefined)));
    await h.stop();
    await removeDirs(dirs);
  });

  const spec = (prompt: string, runtime = 'claude-code', over: Record<string, unknown> = {}) => ({
    runtime,
    prompt,
    sandboxProfile: 'host-restricted',
    sourceTrust: 'trusted',
    approvalPolicy: 'ask-sensitive',
    limits: { maxDurationSec: 1800, maxTokens: 100_000 },
    ...over,
  });

  async function submit(prompt: string): Promise<string> {
    const res = await admin.req('POST', '/jobs', { project: PROJECT, spec: spec(prompt) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ job: { id: string } }>().job.id;
  }

  const jobState = async (id: string): Promise<string> =>
    (await admin.req('GET', `/jobs/${id}`)).json<{ job: { state: string } }>().job.state;

  async function execution(body: Record<string, unknown>) {
    await stepUp();
    return admin.req('PUT', `/projects/${PROJECT}/execution`, {
      hostExecution: true,
      unconfined: false,
      ...body,
    });
  }

  async function toolResults(jobId: string): Promise<string[]> {
    const { rows } = await h.db.pool.query<{
      kind: string;
      payload: { outputSummary?: string; code?: string };
    }>(`SELECT kind, payload FROM job_events WHERE job_id = $1 ORDER BY stream_seq`, [jobId]);
    return rows
      .filter((r) => r.kind === 'tool_result' || r.kind === 'error')
      .map((r) => r.payload.outputSummary ?? r.payload.code ?? '');
  }

  async function children(parent: string) {
    const res = await admin.req('GET', `/jobs/${parent}/subtasks`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{
      parent: { jobId: string } | null;
      children: {
        jobId: string;
        state: string;
        runtime: string;
        deliveredFiles: number;
        placement: { source: string };
      }[];
    }>();
  }

  it('switch off (default): the agent gets no sub-job tools', async () => {
    const view = (await admin.req('GET', `/projects/${PROJECT}/execution`)).json<Record<string, unknown>>();
    expect(view).toMatchObject({ subtasks: false, delegationRuntimes: [] });
    const id = await submit('Make a video about cats');
    await expect.poll(() => jobState(id), { timeout: T }).toBe('SUCCEEDED');
    expect(await toolResults(id)).toContain('subtask_tools_unavailable');
    expect((await children(id)).children).toEqual([]);
  });

  it('a Claude Code job hands image generation to a Codex sub-job on the other machine and gets the file back', async () => {
    const on = await execution({ subtasks: true, delegationRuntimes: ['codex'] });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toMatchObject({ subtasks: true, delegationRuntimes: ['codex'] });
    const parent = await submit('Make a video about cats');
    await expect.poll(() => jobState(parent), { timeout: T }).toBe('SUCCEEDED');
    const tree = await children(parent);
    expect(tree.children).toHaveLength(1);
    const child = tree.children[0];
    if (child === undefined) throw new Error('no child');
    expect(child).toMatchObject({ state: 'SUCCEEDED', runtime: 'codex', deliveredFiles: 2 });
    expect(child.placement.source).toBe('requires');
    expect((await children(child.jobId)).parent?.jobId).toBe(parent);
    // Placed on the codex machine; spec derived from the parent's (sandbox, policy, trust), limits carved.
    const { rows } = await h.db.pool.query<{ worker_id: string; spec: Record<string, unknown> }>(
      `SELECT a.worker_id, j.spec FROM jobs j JOIN job_attempts a ON a.id = j.current_attempt_id WHERE j.id = $1`,
      [child.jobId],
    );
    expect(rows[0]?.worker_id).toBe(ids.codex);
    expect(rows[0]?.spec).toMatchObject({
      runtime: 'codex',
      sandboxProfile: 'host-restricted',
      approvalPolicy: 'ask-sensitive',
      sourceTrust: 'trusted',
      role: 'execute',
    });
    const limits = rows[0]?.spec.limits as { maxDurationSec: number; maxTokens: number };
    expect(limits.maxTokens).toBeLessThanOrEqual(50_000);
    expect(limits.maxDurationSec).toBeLessThanOrEqual(1800);
    // The child got the parent's script as an input; the parent got the thumbnail back and delivered it.
    const childFiles = (await admin.req('GET', `/jobs/${child.jobId}/artifacts`)).json<{
      inputs: { name: string }[];
    }>();
    expect(childFiles.inputs.map((i) => i.name)).toEqual(['script.md']);
    const parentFiles = (await admin.req('GET', `/jobs/${parent}/artifacts`)).json<{
      artifacts: { id: string; name: string }[];
      inputs: { name: string; source: string }[];
    }>();
    expect(
      parentFiles.inputs
        .filter((i) => i.source === 'subtask')
        .map((i) => i.name)
        .sort(),
    ).toEqual([
      `${child.jobId.replaceAll('-', '').slice(0, 8)}-summary.md`,
      `${child.jobId.replaceAll('-', '').slice(0, 8)}-thumb.png`,
    ]);
    const thumb = parentFiles.artifacts.find((a) => a.name === 'images/thumb.png');
    expect(thumb).toBeDefined();
    const content = await admin.req('GET', `/jobs/${parent}/artifacts/${thumb?.id ?? ''}`);
    expect(content.rawPayload.equals(PNG)).toBe(true);
    expect(
      (await toolResults(parent)).some(
        (t) => t.includes(`Sub-job ${child.jobId}`) && t.includes('succeeded'),
      ),
    ).toBe(true);
    const audit = await h.db.pool.query<{ action: string; outcome: string }>(
      `SELECT action, outcome FROM audit_events WHERE action LIKE 'job.subtask.%' AND target = $1 ORDER BY id`,
      [`job:${parent}`],
    );
    expect(audit.rows).toEqual([
      { action: 'job.subtask.create', outcome: 'success' },
      { action: 'job.subtask.deliver', outcome: 'success' },
    ]);
  });

  it('p22-previews-inputs: a 300 KiB input is staged as a hidden parent artifact and becomes the sub-job input', async () => {
    await execution({ subtasks: true, delegationRuntimes: ['codex'] });
    const parent = await submit('Large input');
    await expect.poll(() => jobState(parent), { timeout: T }).toBe('SUCCEEDED');
    const child = (await children(parent)).children[0];
    expect(child?.state).toBe('SUCCEEDED');
    const childFiles = (await admin.req('GET', `/jobs/${child?.jobId ?? ''}/artifacts`)).json<{
      inputs: { name: string; sizeBytes: number }[];
    }>();
    expect(childFiles.inputs.map((i) => i.name)).toEqual(['data.txt']);
    // Staged on the parent's attempt as kind subtask-input — never listed as an output.
    const staged = await h.db.pool.query<{ artifact_id: string; size_bytes: number }>(
      `SELECT artifact_id, size_bytes FROM job_artifacts WHERE job_id = $1 AND kind = 'subtask-input'`,
      [parent],
    );
    expect(staged.rows).toHaveLength(1);
    expect(staged.rows[0]?.artifact_id).toMatch(/^ws-subin-[0-9a-f]{24}$/);
    // The parent's own out/data.txt is a real output; the staged copy (ws-subin-…) never is.
    const parentFiles = (await admin.req('GET', `/jobs/${parent}/artifacts`)).json<{
      artifacts: { id: string; name: string }[];
    }>();
    expect(parentFiles.artifacts.map((a) => a.id)).not.toContain(staged.rows[0]?.artifact_id);
    expect(
      (await h.db.pool.query('SELECT 1 FROM job_artifact_chunks WHERE job_id = $1', [parent])).rowCount,
    ).toBe(0);
  });

  it('refusals: a runtime outside the allowlist; depth limit (the grandchild of a child gets no tools)', async () => {
    const pi = await submit('Try pi');
    await expect.poll(() => jobState(pi), { timeout: T }).toBe('SUCCEEDED');
    expect((await toolResults(pi)).some((t) => /runtime pi is not allowed/.test(t))).toBe(true);
    const denied = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'job.subtask.create' AND outcome = 'denied' AND target = $1`,
      [`job:${pi}`],
    );
    // Refused locally by the worker (not in the assigned runtimes): no request reached the master.
    expect(denied.rowCount).toBe(0);
    await execution({ subtasks: true, delegationRuntimes: ['codex', 'claude-code'] });
    const root = await submit('Nest');
    await expect.poll(() => jobState(root), { timeout: T }).toBe('SUCCEEDED');
    const child = (await children(root)).children[0];
    expect(child?.state).toBe('SUCCEEDED');
    const grand = (await children(child?.jobId ?? '')).children[0];
    expect(grand?.state).toBe('SUCCEEDED');
    expect(await toolResults(grand?.jobId ?? '')).toContain('subtask_tools_unavailable');
    const { rows } = await h.db.pool.query<{ depth: number }>(
      'SELECT depth FROM job_subtasks WHERE root_job_id = $1 ORDER BY depth',
      [root],
    );
    expect(rows.map((r) => r.depth)).toEqual([1, 2]);
  });

  it('cancel cascades: a sub-job still running when its parent ends is cancelled', async () => {
    const parent = await submit('Fire and forget');
    await expect.poll(() => jobState(parent), { timeout: T }).toBe('SUCCEEDED');
    const child = (await children(parent)).children[0];
    expect(child).toBeDefined();
    await expect.poll(() => jobState(child?.jobId ?? ''), { timeout: T }).toBe('CANCELLED');
    const audit = await h.db.pool.query<{ metadata: { by: string } }>(
      `SELECT metadata FROM audit_events WHERE action = 'job.subtask.cancel' AND target = $1`,
      [`job:${parent}`],
    );
    expect(audit.rows[0]?.metadata.by).toBe('cascade');
  });

  it('a SUBTASK_REQUEST without the live lease is refused and audited', async () => {
    const sent: { type: string; payload: Record<string, unknown> }[] = [];
    const session = {
      workerId: ids.codex ?? '',
      send: (type: string, payload: Record<string, unknown>) => {
        sent.push({ type, payload });
        return Promise.resolve();
      },
    };
    const jobId = randomUUID();
    await h.app.fleetSessions.onMessage(
      session as never,
      {
        protocolVersion: '1.0',
        type: 'SUBTASK_REQUEST',
        messageId: randomUUID(),
        seq: 0,
        ts: new Date().toISOString(),
        workerId: ids.codex ?? '',
        jobId,
        payload: {
          attemptId: randomUUID(),
          epoch: 1,
          requestId: randomUUID(),
          op: { kind: 'create', title: 't', prompt: 'p', wait: false },
        },
      } as never,
    );
    expect(sent[0]).toMatchObject({
      type: 'SUBTASK_STATUS',
      payload: { state: 'refused', reason: 'stale_lease' },
    });
    const audit = await h.db.pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'job.subtask.request' AND outcome = 'denied' AND target = $1`,
      [`job:${jobId}`],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('planner hints: runtime from capability tags, unknown machine hint ignored with a note, shown on the run view', async () => {
    const def = (name: string, prompt: string) => ({
      name,
      defaults: {
        runtime: 'claude-code',
        sandboxProfile: 'host-restricted',
        sourceTrust: 'trusted',
        approvalPolicy: 'ask-sensitive',
        limits: { maxDurationSec: 600 },
      },
      nodes: [{ id: 'plan', role: 'planner', prompt, dynamic: { maxNodes: 3 } }],
      edges: [],
    });
    const created = await admin.req('POST', '/workflows', {
      project: PROJECT,
      definition: def('video', 'Plan it'),
    });
    expect(created.statusCode, created.body).toBe(201);
    const run = await admin.req('POST', `/workflows/${created.json<{ id: string }>().id}/runs`, {
      inputs: {},
    });
    expect(run.statusCode, run.body).toBe(201);
    const runId = run.json<{ runId: string }>().runId;
    type View = {
      run: { state: string; reason: string | null };
      nodes: { id: string; runtime: string; placement: { source: string; notes: string[] } | null }[];
    };
    const view = async (): Promise<View> => (await admin.req('GET', `/workflows/runs/${runId}`)).json<View>();
    await expect.poll(async () => (await view()).run.state, { timeout: T }).toBe('succeeded');
    const v = await view();
    const images = v.nodes.find((n) => n.id === 'plan.images');
    expect(images).toMatchObject({ runtime: 'codex', placement: { source: 'requires' } });
    expect(images?.placement?.notes.join(' ')).toMatch(/no-such-pc.*not an enrolled machine/);
    expect(v.nodes.find((n) => n.id === 'plan')?.placement?.source).toBe('default');
    expect(v.nodes.find((n) => n.id === 'plan.edit')?.runtime).toBe('claude-code');
    const imagesJob = await h.db.pool.query<{ worker_id: string }>(
      `SELECT a.worker_id FROM workflow_job_links n JOIN jobs j ON j.id = n.job_id JOIN job_attempts a ON a.id = j.current_attempt_id
        WHERE n.run_id = $1 AND n.node_id = 'plan.images'`,
      [runId],
    );
    expect(imagesJob.rows[0]?.worker_id).toBe(ids.codex);

    // A runtime outside the allowlist rejects the plan; the reason names the allowed runtimes.
    await execution({ subtasks: true, delegationRuntimes: [] });
    const bad = await admin.req('POST', '/workflows', {
      project: PROJECT,
      definition: def('bad', 'PLAN-PI'),
    });
    const badRun = await admin.req('POST', `/workflows/${bad.json<{ id: string }>().id}/runs`, {
      inputs: {},
    });
    const badId = badRun.json<{ runId: string }>().runId;
    const badView = async () => (await admin.req('GET', `/workflows/runs/${badId}`)).json<View>();
    await expect.poll(async () => (await badView()).run.state, { timeout: T }).toBe('failed');
    expect((await badView()).run.reason).toMatch(
      /tasks\.0\.runtime:not_allowed.*allowed for planned tasks: claude-code/,
    );
  });
});
