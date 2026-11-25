import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_TOOLS,
  assistantToolInput,
  FunctionProbeResult,
  FunctionProbeSpec,
  FunctionSpec,
  functionFeatureOf,
  WATCH_CHECKS_FEATURE,
  WATCH_THEN_MODES,
  WatchCheckCondition,
  WatchThen,
  WorkerFeature,
} from '../src/index.js';

/** p15-watches: the typed conditions of a watch and the `probe` function type (watch-checks-v1). */
describe('watch conditions (p15-watches)', () => {
  const job = '6f1c0e3a-5b8d-4f7e-9a1b-2c3d4e5f6a7b';

  it('accepts every kind with bounded fields', () => {
    const ok = [
      { kind: 'job_state', jobId: job, states: ['succeeded', 'needs_you'] },
      { kind: 'job_event', jobId: job, contains: 'tests passed', eventKinds: ['message'] },
      { kind: 'job_output', jobId: job, name: '*.apk' },
      { kind: 'preview_up', jobId: job, http: true },
      { kind: 'preview_up', project: 'alpha', name: 'web' },
      {
        kind: 'http',
        project: 'alpha',
        url: 'https://example.com/health',
        expect: { jsonata: 'body.ok = true' },
      },
      { kind: 'worker_probe', project: 'alpha', workerId: 'mac', probe: { type: 'tcp', port: 8080 } },
      { kind: 'machine', workerId: 'mac', state: 'runtime_ready', runtime: 'codex' },
      { kind: 'workflow_run', runId: job, states: ['waiting'], nodeId: 'review' },
      { kind: 'service_url', serviceId: 'svc-1' },
    ];
    for (const c of ok) expect(WatchCheckCondition.safeParse(c).success, JSON.stringify(c)).toBe(true);
  });

  it('refuses free code, regex-free patterns too long, service ports and ambiguous previews', () => {
    const bad = [
      { kind: 'command', command: 'curl localhost:3000' },
      { kind: 'job_event', jobId: job, contains: 'x'.repeat(201) },
      { kind: 'job_output', jobId: job, name: '../etc/passwd' },
      { kind: 'preview_up', jobId: job, tunnelId: job },
      { kind: 'preview_up', project: 'alpha' },
      { kind: 'http', project: 'alpha', url: 'file:///etc/passwd' },
      { kind: 'worker_probe', project: 'alpha', workerId: 'mac', probe: { type: 'tcp', port: 22 } },
      { kind: 'worker_probe', project: 'alpha', workerId: 'mac', probe: { type: 'http', port: 2375 } },
      {
        kind: 'worker_probe',
        project: 'alpha',
        workerId: 'mac',
        probe: { type: 'http', port: 3000, path: '//x' },
      },
      { kind: 'machine', workerId: 'mac', state: 'runtime_ready' },
      { kind: 'machine', workerId: 'mac', state: 'online', runtime: 'codex' },
    ];
    for (const c of bad) expect(WatchCheckCondition.safeParse(c).success, JSON.stringify(c)).toBe(false);
  });

  it('then is a card the user confirms: a job message or a workflow run', () => {
    expect(WatchThen.safeParse({ action: 'job_message', jobId: job, text: 'go on' }).success).toBe(true);
    expect(
      WatchThen.safeParse({ action: 'workflow_run', workflowId: job, inputs: { env: 'preview' } }).success,
    ).toBe(true);
    expect(WatchThen.safeParse({ action: 'deploy', target: 'production' }).success).toBe(false);
  });

  it('p15-watch-autorun: then takes mode auto | ask (absent on older rows), nothing else', () => {
    for (const mode of ['auto', 'ask'] as const) {
      expect(WatchThen.safeParse({ action: 'workflow_run', workflowId: job, mode }).success).toBe(true);
      expect(WatchThen.safeParse({ action: 'job_message', jobId: job, text: 'go', mode }).success).toBe(true);
    }
    expect(WatchThen.safeParse({ action: 'workflow_run', workflowId: job }).success).toBe(true);
    expect(WatchThen.safeParse({ action: 'workflow_run', workflowId: job, mode: 'always' }).success).toBe(
      false,
    );
    expect(WATCH_THEN_MODES).toEqual(['auto', 'ask']);
    const tool = assistantToolInput('create_watch');
    const condition = { kind: 'job_state', jobId: job, states: ['succeeded'] };
    expect(
      tool.safeParse({ condition, then: { action: 'workflow_run', workflowId: job, mode: 'auto' } }).success,
    ).toBe(true);
    expect(ASSISTANT_TOOLS.create_watch.description).toContain('mode "auto"');
    expect(ASSISTANT_TOOLS.create_watch.description).toContain('then.onMet');
    expect(ASSISTANT_TOOLS.create_watch.description).not.toContain('the user confirms it.');
  });
});

describe('workflow read tools (p15-watch-autorun)', () => {
  const id = '0b0bd1f0-efc0-479e-84de-4c60f201d86c';

  it('list_workflows searches by text and project with paging; read-only', () => {
    const list = assistantToolInput('list_workflows');
    expect(ASSISTANT_TOOLS.list_workflows.kind).toBe('read');
    expect(list.safeParse({}).success).toBe(true);
    expect(
      list.safeParse({ query: 'whatsapp', project: 'genel', includeArchived: true, limit: 50, offset: 20 })
        .success,
    ).toBe(true);
    expect(list.safeParse({ limit: 51 }).success).toBe(false);
    expect(list.safeParse({ query: '' }).success).toBe(false);
    expect(list.safeParse({ offset: -1 }).success).toBe(false);
    expect(list.safeParse({ execute: true }).success).toBe(false);
  });

  it('describe_workflow takes an id or project + name', () => {
    const d = assistantToolInput('describe_workflow');
    expect(ASSISTANT_TOOLS.describe_workflow.kind).toBe('read');
    expect(d.safeParse({ workflowId: id }).success).toBe(true);
    expect(d.safeParse({ project: 'genel', name: 'whatsapp-mesaj-gonder', runs: 20 }).success).toBe(true);
    expect(d.safeParse({ workflowId: 'whatsapp' }).success).toBe(false);
    expect(d.safeParse({ project: 'genel', name: 'Bad Name' }).success).toBe(false);
    expect(d.safeParse({ workflowId: id, runs: 21 }).success).toBe(false);
  });

  it('the run tools point at list_workflows for ids', () => {
    for (const name of ['draft_workflow_run', 'create_watch', 'draft_automation'] as const)
      expect(ASSISTANT_TOOLS[name].description, name).toContain('list_workflows');
  });
});

describe('probe function jobs (watch-checks-v1)', () => {
  it('is a function spec of its own feature', () => {
    const spec = {
      type: 'probe',
      idempotencyKey: 'watch-abc-1',
      probe: {
        kind: 'http',
        port: 3000,
        path: '/health',
        method: 'GET',
        timeoutSec: 15,
        maxResponseBytes: 65536,
      },
    };
    expect(FunctionProbeSpec.safeParse(spec).success).toBe(true);
    expect(FunctionSpec.safeParse(spec).success).toBe(true);
    expect(functionFeatureOf({ type: 'probe' })).toBe(WATCH_CHECKS_FEATURE);
    expect(WorkerFeature.safeParse(WATCH_CHECKS_FEATURE).success).toBe(true);
  });

  it('refuses hosts, denied ports, big bodies, other methods and backslash paths', () => {
    const base = { type: 'probe', idempotencyKey: 'k' };
    for (const probe of [
      { kind: 'http', port: 3000, path: '/', method: 'POST', timeoutSec: 5, maxResponseBytes: 10 },
      { kind: 'http', port: 6379, path: '/', method: 'GET', timeoutSec: 5, maxResponseBytes: 10 },
      { kind: 'http', port: 3000, path: '/', method: 'GET', timeoutSec: 5, maxResponseBytes: 1024 * 1024 },
      { kind: 'http', port: 3000, path: '/a\\b', method: 'GET', timeoutSec: 5, maxResponseBytes: 10 },
      {
        kind: 'http',
        port: 3000,
        path: '/',
        method: 'GET',
        timeoutSec: 5,
        maxResponseBytes: 10,
        host: 'evil',
      },
      { kind: 'tcp', port: 80, timeoutSec: 5 },
    ])
      expect(FunctionProbeSpec.safeParse({ ...base, probe }).success, JSON.stringify(probe)).toBe(false);
  });

  it('an unreachable port is a result, not a failure', () => {
    expect(
      FunctionProbeResult.safeParse({
        type: 'probe',
        kind: 'http',
        reachable: false,
        bodyEncoding: 'none',
        truncated: false,
        error: 'connection_refused',
        durationMs: 3,
      }).success,
    ).toBe(true);
  });
});
