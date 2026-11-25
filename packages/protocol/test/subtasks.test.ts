import { describe, expect, it } from 'vitest';
import {
  AssignJob,
  CAPABILITY_TAG_NAMES,
  MasterToWorker,
  resolveCapabilities,
  stricterApprovalPolicy,
  SUBTASK_LIMITS,
  SUBTASKS_FEATURE,
  SubtaskPath,
  SubtaskRequestPayload,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { lease, masterMessages, workerMessages } from './fixtures.js';

describe('p8-orchestration sub-job messages', () => {
  it('SUBTASK_REQUEST / SUBTASK_STATUS parse and are job-scoped control messages', () => {
    expect(WorkerToMaster.safeParse(workerMessages.SUBTASK_REQUEST).success).toBe(true);
    expect(MasterToWorker.safeParse(masterMessages.SUBTASK_STATUS).success).toBe(true);
    const { jobId: _j, ...noJob } = workerMessages.SUBTASK_REQUEST;
    expect(WorkerToMaster.safeParse(noJob).success).toBe(false);
  });

  it('advertises the feature', () => {
    expect(WorkerFeature.options).toContain(SUBTASKS_FEATURE);
  });

  it('bounds the request: prompt, tags, inline inputs, unknown runtimes', () => {
    const base = {
      ...lease,
      requestId: '00000000-0000-4000-8000-0000000000e1',
      op: { kind: 'create', title: 't', prompt: 'p', wait: false },
    };
    expect(SubtaskRequestPayload.safeParse(base).success).toBe(true);
    const bad = [
      { ...base.op, prompt: 'x'.repeat(SUBTASK_LIMITS.maxPromptChars + 1) },
      { ...base.op, runtime: 'openhands' },
      { ...base.op, requires: Array.from({ length: SUBTASK_LIMITS.maxRequires + 1 }, () => 'git') },
      { ...base.op, requires: ['Bad Tag'] },
      { ...base.op, inputs: [{ name: '../escape.md', contentBase64: '' }] },
      {
        ...base.op,
        inputs: Array.from({ length: SUBTASK_LIMITS.maxInputs + 1 }, (_, i) => ({
          name: `f${String(i)}.md`,
          contentBase64: '',
        })),
      },
      { kind: 'status', subtaskId: 'not-a-uuid' },
    ];
    for (const op of bad)
      expect(SubtaskRequestPayload.safeParse({ ...base, op }).success, JSON.stringify(op).slice(0, 80)).toBe(
        false,
      );
  });

  it('p11-merge-pipeline: paths (file ownership) accepts relative paths, prefixes and globs only', () => {
    for (const ok of [
      'src/api/',
      'src/**/*.ts',
      'README.md',
      'docs/api.md',
      '@scope/pkg/',
      'a+b/c-d_e.txt',
      '*',
    ]) {
      expect(SubtaskPath.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      '',
      '/etc',
      '../x',
      'a/../b',
      'a/..',
      '..',
      'a\\b',
      'a//b',
      'a/b//',
      '/',
      'has space',
      'tab\tname',
      'x'.repeat(201),
    ]) {
      expect(SubtaskPath.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    const base = {
      ...lease,
      requestId: '00000000-0000-4000-8000-0000000000e2',
      op: { kind: 'create', title: 't', prompt: 'p', wait: false, paths: ['src/api/', 'docs/api.md'] },
    };
    const parsed = SubtaskRequestPayload.parse(base);
    expect(parsed.op.kind === 'create' ? parsed.op.paths : null).toEqual(['src/api/', 'docs/api.md']);
    // Additive: absent is fine; more than maxPaths or a bad entry refuses the request.
    expect(SubtaskRequestPayload.safeParse({ ...base, op: { ...base.op, paths: undefined } }).success).toBe(
      true,
    );
    const many = Array.from({ length: SUBTASK_LIMITS.maxPaths + 1 }, (_, i) => `f${String(i)}.md`);
    expect(SubtaskRequestPayload.safeParse({ ...base, op: { ...base.op, paths: many } }).success).toBe(false);
    expect(SubtaskRequestPayload.safeParse({ ...base, op: { ...base.op, paths: ['/etc'] } }).success).toBe(
      false,
    );
  });

  it('ASSIGN_JOB execution.subtasks is optional and bounded', () => {
    const assign = structuredClone(masterMessages.ASSIGN_JOB) as { payload: Record<string, unknown> };
    assign.payload.execution = {
      hostExecutionOptIn: false,
      subtasks: { runtimes: ['claude-code', 'codex'], depthLeft: 2 },
    };
    expect(AssignJob.safeParse(assign).success).toBe(true);
    assign.payload.execution = { hostExecutionOptIn: false, subtasks: { runtimes: [], depthLeft: 2 } };
    expect(AssignJob.safeParse(assign).success).toBe(false);
    assign.payload.execution = { hostExecutionOptIn: false, subtasks: { runtimes: ['codex'], depthLeft: 3 } };
    expect(AssignJob.safeParse(assign).success).toBe(false);
  });
});

describe('capability tags', () => {
  it('maps tool tags to tool requirements and image-generation to codex', () => {
    expect(resolveCapabilities(['browser', 'ffmpeg'])).toEqual({
      tools: ['browser', 'ffmpeg'],
      runtimes: null,
      unknown: [],
    });
    expect(resolveCapabilities(['image-generation', 'ffmpeg'])).toEqual({
      tools: ['ffmpeg'],
      runtimes: ['codex'],
      unknown: [],
    });
  });
  it('reports unknown tags (and never treats prototype keys as tags)', () => {
    expect(resolveCapabilities(['teleport', 'constructor', '__proto__']).unknown).toEqual([
      'teleport',
      'constructor',
      '__proto__',
    ]);
    expect(CAPABILITY_TAG_NAMES).toContain('image-generation');
  });
});

describe('stricterApprovalPolicy', () => {
  it('never loosens', () => {
    expect(stricterApprovalPolicy('allow-all', 'ask-sensitive')).toBe('ask-sensitive');
    expect(stricterApprovalPolicy('ask-all', 'ask-sensitive')).toBe('ask-all');
    expect(stricterApprovalPolicy('ask-sensitive', 'deny-sensitive')).toBe('deny-sensitive');
    expect(stricterApprovalPolicy('allow-all', 'allow-all')).toBe('allow-all');
  });
});
