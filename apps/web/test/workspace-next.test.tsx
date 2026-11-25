// p5-research-workspace-next: the workspace storage policy and usage, removed files on job pages, automation input
// files / continue-from, workflow run files.
import { configure } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAutomationDetail } from '../src/api/automations';
import { parseRun } from '../src/api/workflows';
import { parseWorkspaceSettings } from '../src/api/workspaces';
import { EMPTY_FILES, filesFromDetail, filesTarget, validateFiles } from '../src/screens/automations/files';
import { parseBound } from '../src/screens/workspace/storage';
import { USER } from './helpers';

configure({ asyncUtilTimeout: 5_000 });

const MiB = 1024 * 1024;
const JOB = '66666666-6666-4666-8666-666666666666';
const A1 = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-10-16T10:00:00.000Z';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function wsSettings(over: Record<string, unknown> = {}) {
  return {
    project: 'genel',
    kind: 'workspace',
    egress: 'web',
    allowHosts: [],
    artifactRetentionDays: null,
    storageQuotaBytes: 100 * MiB,
    usage: {
      bytes: 90 * MiB,
      files: 12,
      artifactBytes: 60 * MiB,
      artifactFiles: 8,
      inputBytes: 30 * MiB,
      inputFiles: 4,
      prunedFiles: 3,
      oldestAt: '2026-10-01T00:00:00.000Z',
    },
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

describe('workspace storage helpers', () => {
  it('parses settings from an older master (no policy, no usage) and a new one', () => {
    const old = parseWorkspaceSettings({
      project: 'p',
      kind: 'workspace',
      egress: 'none',
      allowHosts: [],
      updatedAt: null,
      updatedBy: null,
    });
    expect(old.artifactRetentionDays).toBeNull();
    expect(old.storageQuotaBytes).toBeNull();
    expect(old.usage.bytes).toBe(0);
    const now = parseWorkspaceSettings(wsSettings({ artifactRetentionDays: 30 }));
    expect(now).toMatchObject({ artifactRetentionDays: 30, storageQuotaBytes: 100 * MiB });
    expect(now.usage).toMatchObject({ bytes: 90 * MiB, prunedFiles: 3 });
  });

  it('parseBound: empty is none, whole numbers within bounds', () => {
    expect(parseBound('', 1, 10, 'days')).toEqual({ value: null, error: null });
    expect(parseBound(' 7 ', 1, 10, 'days')).toEqual({ value: 7, error: null });
    expect(parseBound('0', 1, 10, 'days').error).toContain('Between 1 and 10');
    expect(parseBound('1.5', 1, 10, 'days').error).toContain('whole number');
  });

  it('automation files: the full desired set (kept ids + uploads) and the continue-from rule', () => {
    const s = filesFromDetail(
      [{ id: 'in-a1', name: 'brief.md', mediaType: 'text/markdown', sizeBytes: 10 }],
      {
        kind: 'last-run',
      },
    );
    expect(s.continueKind).toBe('last-run');
    const withNew = { ...s, newFiles: [{ name: 'x.csv', sizeBytes: 3, contentBase64: 'YSxi' }] };
    expect(filesTarget(withNew)).toEqual({
      files: [{ inputId: 'in-a1' }, { name: 'x.csv', contentBase64: 'YSxi' }],
      continueFrom: { kind: 'last-run' },
    });
    expect(filesTarget(EMPTY_FILES)).toEqual({ files: [], continueFrom: null });
    expect(
      filesTarget({ ...EMPTY_FILES, continueKind: 'job', continueJob: ` ${JOB} ` }).continueFrom,
    ).toEqual({
      kind: 'job',
      jobId: JOB,
    });
    expect(
      validateFiles(
        { ...EMPTY_FILES, continueKind: 'job', continueJob: 'x' },
        { target: 'job', trigger: 'cron' },
      ),
    ).toHaveProperty('continueJob');
    expect(
      validateFiles({ ...EMPTY_FILES, continueKind: 'last-run' }, { target: 'workflow', trigger: 'cron' }),
    ).toHaveProperty('continueKind');
    expect(
      validateFiles({ ...EMPTY_FILES, continueKind: 'chain-source' }, { target: 'job', trigger: 'cron' }),
    ).toHaveProperty('continueKind');
    expect(
      validateFiles({ ...EMPTY_FILES, continueKind: 'chain-source' }, { target: 'job', trigger: 'chain' }),
    ).toEqual({});
  });

  it('parses automation detail files / continue-from and workflow run files (older masters: none)', () => {
    const base = {
      id: A1,
      project: 'genel',
      name: 'n',
      description: null,
      state: 'active',
      enabled: true,
      trigger: { kind: 'cron', cron: '0 3 * * *' },
      triggerSummary: 's',
      target: {
        kind: 'job',
        runtime: 'codex',
        workflowId: null,
        title: null,
        approvalPolicy: null,
        sandboxProfile: null,
      },
      approvalTimeoutMinutes: 60,
      waiting: null,
      concurrency: 'skip',
      catchUp: 'once',
      maxRunsPerHour: 30,
      notifyOnFailure: true,
      nextRunAt: null,
      lastRun: null,
      runCount: 0,
      successRate: null,
      webhook: null,
      runAs: USER.id,
      createdBy: USER.id,
      createdAt: NOW,
      updatedAt: NOW,
      stats: { finished: 0, succeeded: 0, failed: 0, skipped: 0, lastFailure: null },
      chainSource: null,
      chainedBy: [],
      github: null,
    };
    const old = parseAutomationDetail({
      ...base,
      targetSpec: { spec: {}, priority: 0, workflowInputs: null, workflowRepository: null },
    });
    expect(old.targetSpec.files).toEqual([]);
    expect(old.targetSpec.continueFrom).toBeNull();
    const now = parseAutomationDetail({
      ...base,
      targetSpec: {
        spec: {},
        priority: 0,
        workflowInputs: null,
        workflowRepository: null,
        files: [{ id: 'in-1', name: 'brief.md', mediaType: 'text/markdown', sizeBytes: 5 }],
        continueFrom: { kind: 'job', jobId: JOB },
      },
    });
    expect(now.targetSpec.files[0]?.name).toBe('brief.md');
    expect(now.targetSpec.continueFrom).toEqual({ kind: 'job', jobId: JOB });
    const run = parseRun({
      run: {
        id: A1,
        project: 'genel',
        name: 'r',
        version: 1,
        state: 'running',
        createdAt: NOW,
        endedAt: null,
        reason: null,
        repository: null,
        files: [{ name: 'brief.md', sizeBytes: 5, pruned: false }],
      },
      nodes: [],
      edges: [],
      mergeRequests: [],
    });
    expect(run.run.files).toEqual([{ name: 'brief.md', sizeBytes: 5, pruned: false }]);
  });
});
