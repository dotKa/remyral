import { describe, expect, it } from 'vitest';
import {
  ArtifactChunk,
  ArtifactName,
  contentMatchesType,
  EgressHost,
  InputName,
  JobInputData,
  JobInputRequest,
  JobSpec,
  minEgress,
  WorkerConfigDocument,
  workerConfigIssues,
  workspaceFileType,
} from '../src/index.js';

const base = {
  runtime: 'codex',
  prompt: 'research',
  sandboxProfile: 'container',
  approvalPolicy: 'ask-sensitive',
  limits: { maxDurationSec: 600 },
};
const repository = { url: 'https://github.com/acme/app.git', baseRef: 'main', workBranch: 'w' };
const env = {
  protocolVersion: '1.0',
  messageId: '7a1f2c84-4d0b-4b7e-9e43-1f3b2a8d9c10',
  seq: 1,
  ts: '2026-10-14T08:00:00.000Z',
  correlationId: 'c-1',
  workerId: 'wrk_a',
  jobId: '0b9a2c84-4d0b-4b7e-9e43-1f3b2a8d9c11',
};

describe('JobSpec repository / workspace (p5-research-workspace)', () => {
  it('accepts exactly one of repository and workspace', () => {
    expect(JobSpec.safeParse({ ...base, repository }).success).toBe(true);
    expect(JobSpec.safeParse({ ...base, workspace: { egress: 'web' } }).success).toBe(true);
    expect(JobSpec.safeParse(base).success).toBe(false);
    expect(JobSpec.safeParse({ ...base, repository, workspace: { egress: 'none' } }).success).toBe(false);
  });

  it('validates workspace inputs and hosts', () => {
    const input = {
      inputId: 'in-0123456789abcdef',
      name: 'notes.md',
      mediaType: 'text/markdown',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
    };
    expect(
      JobSpec.safeParse({
        ...base,
        workspace: { egress: 'allowlist', allowHosts: ['example.com'], inputs: [input] },
      }).success,
    ).toBe(true);
    for (const bad of [
      { ...input, name: '../x.md' },
      { ...input, name: 'x.html' },
      { ...input, inputId: 'x' },
      { ...input, sizeBytes: 6 * 1024 * 1024 },
    ]) {
      expect(JobSpec.safeParse({ ...base, workspace: { egress: 'none', inputs: [bad] } }).success).toBe(
        false,
      );
    }
    expect(
      JobSpec.safeParse({ ...base, workspace: { egress: 'allowlist', allowHosts: ['10.0.0.1'] } }).success,
    ).toBe(false);
  });

  it('egress modes order none < allowlist < web', () => {
    expect(minEgress('web', 'allowlist')).toBe('allowlist');
    expect(minEgress('none', 'web')).toBe('none');
    expect(minEgress('web', 'web')).toBe('web');
  });

  it('host names: lower-case DNS names with optional port, never IP literals', () => {
    for (const ok of ['example.com', 'api.example.co.uk:8443'])
      expect(EgressHost.safeParse(ok).success).toBe(true);
    for (const bad of ['Example.com', '127.0.0.1', 'localhost', 'a b.com', 'x.com/path', '[::1]']) {
      expect(EgressHost.safeParse(bad).success).toBe(false);
    }
  });
});

describe('workspace files', () => {
  it('allowlists types by extension; no HTML, SVG or scripts', () => {
    expect(workspaceFileType('report.md')?.mediaType).toBe('text/markdown');
    expect(workspaceFileType('chart.PNG')?.mediaType).toBe('image/png');
    for (const bad of ['a.html', 'a.svg', 'a.js', 'noext', 'a.sh', 'a.bat'])
      expect(workspaceFileType(bad)).toBeNull();
    // p17-object-storage: archives and installers are large, download-only outputs (never inputs, never inline).
    for (const large of ['a.zip', 'a.exe']) expect(workspaceFileType(large)?.large).toBe(true);
  });

  it('names: inputs one safe segment, artifacts a relative path of ≤ 4 safe segments', () => {
    expect(InputName.safeParse('Q3 notes (draft).md').success).toBe(true);
    expect(InputName.safeParse('dir/notes.md').success).toBe(false);
    expect(InputName.safeParse('.hidden.md').success).toBe(false);
    expect(ArtifactName.safeParse('charts/q3/a.png').success).toBe(true);
    expect(ArtifactName.safeParse('a/b/c/d/e.png').success).toBe(false);
    expect(ArtifactName.safeParse('../x.md').success).toBe(false);
    expect(ArtifactName.safeParse('/abs.md').success).toBe(false);
  });

  it('content must match the declared type', () => {
    expect(contentMatchesType(Buffer.from('# hi\n'), 'text/markdown')).toBe(true);
    expect(contentMatchesType(Buffer.from([0x23, 0x00]), 'text/plain')).toBe(false);
    expect(contentMatchesType(Buffer.from([0xc3, 0x28]), 'text/plain')).toBe(false);
    expect(contentMatchesType(Buffer.from('%PDF-1.7'), 'application/pdf')).toBe(true);
    expect(contentMatchesType(Buffer.from('<svg/>'), 'image/png')).toBe(false);
  });
});

describe('workspace messages', () => {
  it('ARTIFACT_CHUNK carries bounded base64 under a lease', () => {
    const msg = {
      ...env,
      type: 'ARTIFACT_CHUNK',
      payload: { attemptId: 'att-1', epoch: 1, artifactId: 'ws-o0-abc', index: 0, data: 'aGVsbG8=' },
    };
    expect(ArtifactChunk.safeParse(msg).success).toBe(true);
    expect(ArtifactChunk.safeParse({ ...msg, payload: { ...msg.payload, data: '' } }).success).toBe(false);
    expect(
      ArtifactChunk.safeParse({ ...msg, payload: { ...msg.payload, data: 'x'.repeat(200_000) } }).success,
    ).toBe(false);
  });

  it('JOB_INPUT_REQUEST / JOB_INPUT_DATA', () => {
    const req = {
      ...env,
      seq: 0,
      type: 'JOB_INPUT_REQUEST',
      payload: {
        attemptId: 'att-1',
        epoch: 1,
        requestId: '7a1f2c84-4d0b-4b7e-9e43-1f3b2a8d9c12',
        inputId: 'in-abc',
        offset: 0,
      },
    };
    expect(JobInputRequest.safeParse(req).success).toBe(true);
    const data = {
      ...req,
      type: 'JOB_INPUT_DATA',
      payload: { ...req.payload, status: 'ok', data: 'aGk=', eof: true },
    };
    expect(JobInputData.safeParse(data).success).toBe(true);
    expect(
      JobInputData.safeParse({ ...data, payload: { ...data.payload, data: 'not base64!' } }).success,
    ).toBe(false);
  });
});

describe('managed config document workspaces', () => {
  const doc = {
    schemaVersion: 1,
    projects: { acme: { repositories: ['https://github.com/acme/app.git'] } },
    workspaces: { genel: { egress: 'web' } },
    allowedRuntimes: ['codex'],
    maxParallelJobs: 1,
    sandboxProfiles: ['container'],
    workspace: {},
    labels: {},
    runtimes: {},
  };

  it('is additive and refuses a project that is both', () => {
    const parsed = WorkerConfigDocument.parse(doc);
    expect(workerConfigIssues(parsed)).toEqual([]);
    const both = WorkerConfigDocument.parse({ ...doc, workspaces: { acme: { egress: 'none' } } });
    expect(workerConfigIssues(both)).toContainEqual({ path: 'workspaces.acme', code: 'duplicate' });
    const { workspaces: _w, ...legacy } = doc;
    expect(WorkerConfigDocument.parse(legacy).workspaces).toBeUndefined();
  });
});
