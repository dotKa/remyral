import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApprovalPolicy,
  ASKING_APPROVAL_POLICIES,
  AUTO_APPROVE_POLICY,
  FULL_ACCESS_FEATURE,
  MasterToWorker,
  parseFrame,
  WorkerFeature,
  WorkerToMaster,
  PACKAGE_CACHE_MANAGERS,
  PackageCacheReport,
} from '../src/index.js';
import { MAX_FRAME_BYTES } from '../src/parse.js';
import { envelope, jobId, lease, masterMessages, workerId, workerMessages } from './fixtures.js';

const ARCHITECTURE_WORKER_TYPES = [
  'HELLO',
  'CAPABILITIES',
  'HEARTBEAT',
  'LEASE_ACK',
  'EVENT',
  'LOG_CHUNK',
  'JOB_RESULT',
  'ARTIFACT_REF',
];
const ARCHITECTURE_MASTER_TYPES = [
  'ENROLL_APPROVED',
  'ASSIGN_JOB',
  'RENEW_LEASE',
  'CANCEL_JOB',
  'DRAIN',
  'ROTATE_CREDENTIAL',
  'UPDATE_POLICY',
];

describe('protocol coverage of ARCHITECTURE.md', () => {
  it('defines every worker -> master message type', () => {
    for (const type of ARCHITECTURE_WORKER_TYPES) expect(Object.keys(workerMessages)).toContain(type);
  });
  it('defines every master -> worker message type', () => {
    for (const type of ARCHITECTURE_MASTER_TYPES) expect(Object.keys(masterMessages)).toContain(type);
  });
});

describe('valid messages', () => {
  it.each(Object.entries(workerMessages))('worker %s parses', (_type, msg) => {
    expect(WorkerToMaster.safeParse(msg).error).toBeUndefined();
  });
  it.each(Object.entries(masterMessages))('master %s parses', (_type, msg) => {
    expect(MasterToWorker.safeParse(msg).error).toBeUndefined();
  });
});

describe('rejections', () => {
  it('rejects unknown message types', () => {
    expect(WorkerToMaster.safeParse(envelope('SHELL_EXEC', { workerId, payload: {} })).success).toBe(false);
  });

  it('rejects master messages on the worker channel and vice versa', () => {
    expect(WorkerToMaster.safeParse(masterMessages.ASSIGN_JOB).success).toBe(false);
    expect(MasterToWorker.safeParse(workerMessages.JOB_RESULT).success).toBe(false);
  });

  it('requires jobId in the envelope of job-scoped messages', () => {
    const { jobId: _omit, ...withoutJob } = workerMessages.EVENT;
    expect(WorkerToMaster.safeParse(withoutJob).success).toBe(false);
  });

  it('requires workerId once enrolled', () => {
    const { workerId: _omit, ...anonymous } = workerMessages.HEARTBEAT;
    expect(WorkerToMaster.safeParse(anonymous).success).toBe(false);
  });

  it('HELLO may carry the process instance id and the pair-only flag (p5-live-fixes-2)', () => {
    const hello = structuredClone(workerMessages.HELLO) as { payload: Record<string, unknown> };
    hello.payload.instanceId = '7f3c2a10-5b7e-4d7a-9c1e-2f4b6a8d0e12';
    hello.payload.pairOnly = true;
    expect(WorkerToMaster.safeParse(hello).success).toBe(true);
    hello.payload.instanceId = 'not-a-uuid';
    expect(WorkerToMaster.safeParse(hello).success).toBe(false);
  });

  it('allows HELLO before a workerId exists', () => {
    expect('workerId' in workerMessages.HELLO).toBe(false);
    expect(WorkerToMaster.safeParse(workerMessages.HELLO).success).toBe(true);
  });

  it('rejects log chunks that do not assert redaction (ADR-0006)', () => {
    const msg = envelope('LOG_CHUNK', {
      workerId,
      jobId,
      payload: { ...lease, stream: 'stdout', chunkSeq: 1, data: 'x', redacted: false },
    });
    expect(WorkerToMaster.safeParse(msg).success).toBe(false);
  });

  it('rejects job messages without a fencing epoch (ADR-0004)', () => {
    const msg = envelope('JOB_RESULT', {
      workerId,
      jobId,
      payload: { attemptId: 'att_01', outcome: 'succeeded', summary: '', commits: [] },
    });
    expect(WorkerToMaster.safeParse(msg).success).toBe(false);
  });

  it('accepts measured resources on JOB_RESULT and rejects invalid ones (p6-capacity-advice)', () => {
    const base = workerMessages.JOB_RESULT as { payload: Record<string, unknown> };
    const withRes = (resources: unknown) => ({ ...base, payload: { ...base.payload, resources } });
    const ok = WorkerToMaster.safeParse(withRes({ peakMemoryBytes: 1_288_490_188, samples: 12 }));
    expect(ok.success).toBe(true);
    expect(WorkerToMaster.safeParse(base).success).toBe(true);
    expect(WorkerToMaster.safeParse(withRes({ peakMemoryBytes: -1, samples: 1 })).success).toBe(false);
    expect(WorkerToMaster.safeParse(withRes({ peakMemoryBytes: 1, samples: 0 })).success).toBe(false);
    expect(WorkerToMaster.safeParse(withRes({ peakMemoryBytes: 1.5, samples: 1 })).success).toBe(false);
  });

  it('rejects malformed identifiers', () => {
    const msg = { ...workerMessages.HEARTBEAT, workerId: '../../etc/passwd' };
    expect(WorkerToMaster.safeParse(msg).success).toBe(false);
  });

  it('rejects non-https/ssh repository URLs', () => {
    const bad = structuredClone(masterMessages.ASSIGN_JOB);
    (bad.payload as { spec: { repository: { url: string } } }).spec.repository.url = 'file:///etc';
    expect(MasterToWorker.safeParse(bad).success).toBe(false);
  });

  it('rejects malformed pairing codes', () => {
    const bad = structuredClone(workerMessages.HELLO);
    (bad.payload as { pairingCode: string }).pairingCode = 'abcd-0000';
    expect(WorkerToMaster.safeParse(bad).success).toBe(false);
  });
});

describe('unknown fields are stripped, not passed through (ADR-0011)', () => {
  it('strips extra envelope and payload fields', () => {
    const msg = {
      ...workerMessages.HEARTBEAT,
      smuggled: 'x',
      payload: { ...(workerMessages.HEARTBEAT.payload as object), alsoSmuggled: 1 },
    };
    const parsed = WorkerToMaster.parse(msg);
    expect(parsed).not.toHaveProperty('smuggled');
    expect(parsed.payload).not.toHaveProperty('alsoSmuggled');
  });
});

describe('parseFrame', () => {
  it('parses a valid frame', () => {
    const res = parseFrame(WorkerToMaster, JSON.stringify(workerMessages.LEASE_ACK));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message.type).toBe('LEASE_ACK');
  });

  it('reports invalid JSON without throwing', () => {
    expect(parseFrame(WorkerToMaster, '{not json')).toEqual({ ok: false, error: 'invalid_json' });
  });

  it('reports schema issues with paths', () => {
    const res = parseFrame(WorkerToMaster, JSON.stringify({ ...workerMessages.LEASE_ACK, seq: -1 }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('invalid_message');
      expect(res.issues?.length).toBeGreaterThan(0);
    }
  });

  it('rejects oversized frames before parsing', () => {
    const res = parseFrame(WorkerToMaster, 'x'.repeat(MAX_FRAME_BYTES + 1));
    expect(res).toEqual({ ok: false, error: 'frame_too_large' });
  });
});

describe('JSON Schema export', () => {
  it('converts both directions', () => {
    for (const schema of [WorkerToMaster, MasterToWorker]) {
      const json = z.toJSONSchema(schema, { io: 'input' });
      expect(json).toHaveProperty('oneOf');
    }
  });
});

describe('usage events (p6-cost)', () => {
  const usageEvent = (event: Record<string, unknown>) =>
    envelope('EVENT', { workerId, jobId, payload: { ...lease, event } });

  it('accepts the 1.0 minimum and the optional attribution fields', () => {
    expect(WorkerToMaster.safeParse(usageEvent({ kind: 'usage', provenance: 'unknown' })).success).toBe(true);
    const full = usageEvent({
      kind: 'usage',
      provenance: 'reported-by-runtime',
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
      turns: 1,
      durationMs: 1200,
      costUsd: 0.01,
      provider: 'anthropic',
      model: 'claude-x/1@2026-01-01',
      authMode: 'local-login',
    });
    expect(WorkerToMaster.safeParse(full).success).toBe(true);
  });

  it('rejects malformed attribution fields', () => {
    for (const bad of [
      { provider: 'Anthropic Inc' },
      { model: ' spaced' },
      { authMode: 'oauth-token' },
      { turns: -1 },
      { cacheReadTokens: 1.5 },
    ]) {
      const msg = usageEvent({ kind: 'usage', provenance: 'unknown', ...bad });
      expect(WorkerToMaster.safeParse(msg).success).toBe(false);
    }
  });
});

describe('full access: approval policy allow-all (p5-full-access, ADR-0020)', () => {
  const assign = (spec: Record<string, unknown>, execution?: Record<string, unknown>) => {
    const base = masterMessages.ASSIGN_JOB as { payload: { spec: Record<string, unknown> } };
    return {
      ...masterMessages.ASSIGN_JOB,
      payload: {
        ...base.payload,
        spec: { ...base.payload.spec, ...spec },
        ...(execution === undefined ? {} : { execution }),
      },
    };
  };

  it('ASSIGN_JOB carries allow-all and execution.autoApproveOptIn', () => {
    const parsed = MasterToWorker.safeParse(
      assign(
        { approvalPolicy: 'allow-all', sourceTrust: 'trusted' },
        { hostExecutionOptIn: true, autoApproveOptIn: true },
      ),
    );
    expect(parsed.error).toBeUndefined();
    expect(parsed.data?.type === 'ASSIGN_JOB' && parsed.data.payload.execution?.autoApproveOptIn).toBe(true);
  });

  it('p6-warm-caches: ASSIGN_JOB carries execution.packageCaches; CAPABILITIES carries packageCaches', () => {
    const parsed = MasterToWorker.safeParse(assign({}, { hostExecutionOptIn: true, packageCaches: true }));
    expect(parsed.error).toBeUndefined();
    expect(parsed.data?.type === 'ASSIGN_JOB' && parsed.data.payload.execution?.packageCaches).toBe(true);
    const report = {
      enabled: false,
      disabledReason: 'limit_zero',
      maxBytes: 0,
      usedBytes: 0,
      projects: [],
      scannedAt: null,
      lastEviction: null,
    };
    expect(PackageCacheReport.safeParse(report).success).toBe(true);
    expect(PackageCacheReport.safeParse({ ...report, disabledReason: 'other' }).success).toBe(false);
    expect(PACKAGE_CACHE_MANAGERS).toEqual(['npm', 'pnpm', 'yarn', 'yarn-berry', 'pip', 'uv', 'cargo', 'go']);
  });

  it('every asking policy still parses; unknown policies are refused', () => {
    for (const approvalPolicy of ASKING_APPROVAL_POLICIES) {
      expect(MasterToWorker.safeParse(assign({ approvalPolicy })).success).toBe(true);
    }
    expect(MasterToWorker.safeParse(assign({ approvalPolicy: 'never' })).success).toBe(false);
    expect(ApprovalPolicy.options).toEqual([...ASKING_APPROVAL_POLICIES, AUTO_APPROVE_POLICY]);
  });

  it('workers can advertise full-access-v1', () => {
    const caps = workerMessages.CAPABILITIES as { payload: Record<string, unknown> };
    const msg = { ...caps, payload: { ...caps.payload, features: [FULL_ACCESS_FEATURE] } };
    expect(WorkerToMaster.safeParse(msg).error).toBeUndefined();
    expect(WorkerFeature.options).toContain(FULL_ACCESS_FEATURE);
  });
});
