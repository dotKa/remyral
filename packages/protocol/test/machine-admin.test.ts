import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_HELPER_REASONS,
  adminCommandStatement,
  adminGrantWindow,
  AdminOp,
  AdminPurpose,
  MACHINE_ADMIN_PURPOSE_FEATURE,
  MachineAdminReport,
  normalizeAdminPurpose,
  adminOpDigest,
  adminOpSummary,
  ASSISTANT_TOOLS,
  assistantToolInput,
  Capabilities,
  EffectiveConfigReport,
  JobSpec,
  leaseKeyId,
  MasterToWorker,
  MAX_ADMIN_GRANT_TTL_MS,
  OpsCommandPayload,
  OpsUpdatePayload,
  packSkillBundle,
  satisfiedToolNames,
  signAdminCommand,
  signAdminSession,
  skillKeyId,
  toolAliases,
  ToolInventoryReport,
  verifyAdminCommand,
  verifyAdminSession,
  verifySkillBundle,
  WorkerConfigDocument,
  workerConfigIssues,
  WorkerFeature,
  WorkerToMaster,
} from '../src/index.js';
import { masterMessages, workerMessages } from './fixtures.js';

function masterKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'jwk' }).x as string;
  return { privateKey, raw, lease: { kid: leaseKeyId(raw), publicKey: raw } };
}

const exec: AdminOp = {
  kind: 'exec',
  shell: 'powershell',
  command: 'Install-WindowsFeature Web-Server',
  timeoutSec: 600,
};
const binding = {
  workerId: 'wrk_win1',
  jobId: '00000000-0000-4000-8000-000000000001',
  attemptId: '00000000-0000-4000-8000-000000000002',
  epoch: 1,
  requestId: '00000000-0000-4000-8000-000000000003',
  issuedAt: '2026-10-14T10:00:00.000Z',
  expiresAt: '2026-10-14T10:05:00.000Z',
  op: exec,
};

describe('elevated command grants (ADR-0021)', () => {
  it('verify only for the exact worker, job, attempt, epoch, request, window and operation', () => {
    const k = masterKey();
    const sig = signAdminCommand(binding, k.lease.kid, k.privateKey);
    expect(verifyAdminCommand(binding, sig, [k.lease])).toBe('ok');
    const variants = [
      { ...binding, workerId: 'wrk_other' },
      { ...binding, jobId: '00000000-0000-4000-8000-000000000009' },
      { ...binding, attemptId: '00000000-0000-4000-8000-000000000009' },
      { ...binding, epoch: 2 },
      { ...binding, requestId: '00000000-0000-4000-8000-000000000009' },
      { ...binding, expiresAt: '2026-10-14T10:04:00.000Z' },
      { ...binding, op: { ...exec, command: 'Remove-Item C:\\ -Recurse' } },
      { ...binding, op: { ...exec, shell: 'cmd' as const } },
      { ...binding, op: { ...exec, timeoutSec: 601 } },
    ];
    for (const v of variants) expect(verifyAdminCommand(v, sig, [k.lease])).toBe('bad_signature');
    expect(verifyAdminCommand(binding, undefined, [k.lease])).toBe('missing');
    expect(verifyAdminCommand(binding, sig, [masterKey().lease])).toBe('unknown_key');
  });

  it('is domain-separated from session grants and canonical in key order', () => {
    const k = masterKey();
    const session = {
      workerId: binding.workerId,
      jobId: binding.jobId,
      attemptId: binding.attemptId,
      epoch: 1,
      sessionId: binding.requestId,
      issuedAt: binding.issuedAt,
      expiresAt: binding.expiresAt,
    };
    const ssig = signAdminSession(session, k.lease.kid, k.privateKey);
    expect(verifyAdminSession(session, ssig, [k.lease])).toBe('ok');
    expect(verifyAdminCommand(binding, ssig, [k.lease])).toBe('bad_signature');
    const reordered = {
      timeoutSec: 600,
      command: exec.command,
      shell: 'powershell',
      kind: 'exec',
    } as AdminOp;
    expect(adminOpDigest(reordered)).toBe(adminOpDigest(exec));
    expect(adminCommandStatement(binding).toString('utf8')).toContain('remana-machine-admin/v1\n');
  });

  it('enforces a short window with clock skew', () => {
    const g = { issuedAt: binding.issuedAt, expiresAt: binding.expiresAt };
    expect(adminGrantWindow(g, new Date('2026-10-14T10:01:00Z'))).toBe('ok');
    expect(adminGrantWindow(g, new Date('2026-10-14T10:08:00Z'))).toBe('expired');
    expect(adminGrantWindow(g, new Date('2026-10-14T09:55:00Z'))).toBe('not_yet_valid');
    const long = {
      issuedAt: binding.issuedAt,
      expiresAt: new Date(Date.parse(binding.issuedAt) + MAX_ADMIN_GRANT_TTL_MS + 1000).toISOString(),
    };
    expect(adminGrantWindow(long, new Date('2026-10-14T10:01:00Z'))).toBe('window_too_long');
  });

  it('operations are strict: absolute paths only, bounded, no extra fields', () => {
    expect(AdminOp.safeParse({ kind: 'read_file', path: 'relative/x', maxBytes: 10 }).success).toBe(false);
    expect(AdminOp.safeParse({ kind: 'read_file', path: 'C:\\Windows\\win.ini', maxBytes: 10 }).success).toBe(
      true,
    );
    expect(AdminOp.safeParse({ kind: 'read_file', path: '/etc/hosts', maxBytes: 10 }).success).toBe(true);
    expect(AdminOp.safeParse({ ...exec, timeoutSec: 0 }).success).toBe(false);
    expect(AdminOp.safeParse({ ...exec, command: 'x'.repeat(17 * 1024) }).success).toBe(false);
    expect(
      AdminOp.safeParse({ kind: 'write_file', path: '/etc/x', content: 'not base64!', mode: 'create' })
        .success,
    ).toBe(false);
    expect(AdminOp.safeParse({ kind: 'download', url: 'https://example.com/x' }).success).toBe(false);
    expect(adminOpSummary(exec)).toBe('[powershell] Install-WindowsFeature Web-Server');
  });
});

describe('messages and reports', () => {
  it('parse in the message unions', () => {
    expect(WorkerToMaster.safeParse(workerMessages.MACHINE_ADMIN_REQUEST).success).toBe(true);
    expect(WorkerToMaster.safeParse(workerMessages.MACHINE_ADMIN_RESULT).success).toBe(true);
    expect(MasterToWorker.safeParse(masterMessages.MACHINE_ADMIN_DECISION).success).toBe(true);
    for (const f of ['machine-admin-v1', 'tools-v1', 'panel-skills-v1'])
      expect(WorkerFeature.safeParse(f).success).toBe(true);
  });

  it('p17-worker-1-1-1: MACHINE_ADMIN_REQUEST may carry a one-line purpose, outside the digest', () => {
    const base = workerMessages.MACHINE_ADMIN_REQUEST;
    const withPurpose = (purpose: unknown) =>
      WorkerToMaster.safeParse({ ...base, payload: { ...base.payload, purpose } });
    expect(withPurpose('Check the Spooler service before restarting it').success).toBe(true);
    expect(withPurpose('two\nlines').success).toBe(false);
    expect(withPurpose('').success).toBe(false);
    expect(withPurpose(' padded ').success).toBe(false);
    expect(withPurpose('x'.repeat(301)).success).toBe(false);
    expect(withPurpose('bidi ‮ trick').success).toBe(false);
    expect(WorkerFeature.safeParse(MACHINE_ADMIN_PURPOSE_FEATURE).success).toBe(true);
    // Normalised text always passes the schema; nothing (or only whitespace) gives null.
    for (const raw of ['  a\tb\r\nc  ', 'x'.repeat(1000), 'zero​width', `${'é'.repeat(299)}😀😀`]) {
      const n = normalizeAdminPurpose(raw);
      expect(n === null ? false : AdminPurpose.safeParse(n).success).toBe(true);
    }
    expect(normalizeAdminPurpose('  a\tb\r\nc  ')).toBe('a b c');
    expect(normalizeAdminPurpose(' \n ')).toBeNull();
    expect(normalizeAdminPurpose(42)).toBeNull();
    // The signed statement binds the operation only: the purpose cannot change what a grant covers.
    expect(adminCommandStatement(binding).toString()).not.toContain('purpose');
  });

  it('p17-worker-1-1-1: the machine-admin report carries an optional helper reason code', () => {
    const report = {
      enabled: true,
      autoApprove: false,
      localVeto: false,
      helper: 'missing',
      helperReason: 'state_dir_not_traversable',
      runtimes: ['claude-code'],
    };
    expect(MachineAdminReport.safeParse(report).success).toBe(true);
    expect(MachineAdminReport.safeParse({ ...report, helperReason: 'Not A Code' }).success).toBe(false);
    expect(ADMIN_HELPER_REASONS).toContain('admin_task_missing');
  });

  it('CAPABILITIES carries the tool inventory and the machine-admin report', () => {
    const inventory = {
      detectedAt: '2026-10-14T10:00:00.000Z',
      ttlSec: 600,
      tools: [
        { name: 'edge', found: true, version: '141.0.3537.57', source: 'system' },
        { name: 'python', found: false, source: 'system' },
      ],
      recipes: [{ tool: 'browser', version: '1248', elevated: false, supported: true, installed: false }],
    };
    expect(ToolInventoryReport.safeParse(inventory).success).toBe(true);
    const caps = Capabilities.safeParse({
      ...workerMessages.CAPABILITIES,
      payload: {
        ...workerMessages.CAPABILITIES.payload,
        toolInventory: inventory,
        machineAdmin: {
          enabled: true,
          autoApprove: false,
          localVeto: false,
          helper: 'available',
          runtimes: ['claude-code'],
        },
      },
    });
    expect(caps.success).toBe(true);
    expect(satisfiedToolNames(ToolInventoryReport.parse(inventory))).toEqual(['browser', 'edge']);
    expect(toolAliases('podman')).toEqual(['podman', 'container']);
  });

  it('OPS_COMMAND has the tool and inspect operations without any URL or command field', () => {
    const base = {
      commandId: '00000000-0000-4000-8000-0000000000a1',
      issuedAt: '2026-10-14T10:00:00.000Z',
      expiresAt: '2026-10-14T10:02:00.000Z',
    };
    expect(
      OpsCommandPayload.safeParse({ ...base, op: { kind: 'tool.install', tool: 'browser', version: '1248' } })
        .success,
    ).toBe(true);
    const stripped = OpsCommandPayload.parse({
      ...base,
      op: { kind: 'tool.install', tool: 'browser', version: '1248', url: 'https://evil.example/x.zip' },
    });
    expect(stripped.op).toEqual({ kind: 'tool.install', tool: 'browser', version: '1248' });
    expect(
      OpsCommandPayload.safeParse({ ...base, op: { kind: 'tool.install', tool: 'curl', version: '1' } })
        .success,
    ).toBe(false);
    expect(
      OpsCommandPayload.safeParse({
        ...base,
        op: { kind: 'machine.inspect', sections: ['software', 'disk'] },
      }).success,
    ).toBe(true);
    expect(
      OpsUpdatePayload.safeParse({
        commandId: base.commandId,
        seq: 1,
        kind: 'machine.inspect',
        state: 'succeeded',
        inspect: {
          collectedAt: base.issuedAt,
          platform: 'win32',
          software: [{ name: 'Git', version: '2.56.0' }],
          truncated: false,
        },
      }).success,
    ).toBe(true);
  });

  it('a machine-admin job spec is a workspace job with its target worker', () => {
    const spec = JobSpec.safeParse({
      projectId: 'machines',
      runtime: 'claude-code',
      prompt: 'Install a persistent Chrome profile for the browser tool.',
      workspace: { egress: 'web' },
      sandboxProfile: 'host-restricted',
      approvalPolicy: 'ask-all',
      limits: { maxDurationSec: 3600 },
      sourceTrust: 'trusted',
      kind: 'machine-admin',
      machineAdmin: { workerId: 'wrk_win1' },
      requirements: { workers: ['wrk_win1'] },
    });
    expect(spec.success).toBe(true);
  });
});

describe('worker configuration additions', () => {
  const doc = {
    schemaVersion: 1,
    projects: {},
    allowedRuntimes: ['claude-code'],
    maxParallelJobs: 1,
    sandboxProfiles: ['host-restricted'],
    workspace: {},
    labels: {},
    runtimes: {},
  };

  it('accepts machineAdmin (enabled only) and panel skill keys', () => {
    const k = masterKey();
    const parsed = WorkerConfigDocument.parse({
      ...doc,
      machineAdmin: { enabled: true, autoApprove: false },
      panelSkillKeys: [k.raw],
    });
    expect(workerConfigIssues(parsed)).toEqual([]);
    expect(
      WorkerConfigDocument.safeParse({ ...doc, machineAdmin: { enabled: false, autoApprove: false } })
        .success,
    ).toBe(false);
    expect(WorkerConfigDocument.safeParse({ ...doc, panelSkillKeys: ['short'] }).success).toBe(false);
    expect(
      EffectiveConfigReport.safeParse({
        projects: [],
        allowedRuntimes: [],
        maxParallelJobs: 1,
        sandboxProfiles: [],
        runtimeAuth: {},
        labels: {},
        machineAdmin: { enabled: true, autoApprove: true },
        panelSkillKeyIds: [skillKeyId(k.raw)],
      }).success,
    ).toBe(true);
  });
});

describe('panel-signed skills', () => {
  it('packSkillBundle produces a bundle the worker verifier accepts (and only with that key)', () => {
    const k = masterKey();
    const { bundle, manifestSha256 } = packSkillBundle(
      {
        id: 'persistent-browser',
        title: 'Persistent browser',
        version: '1.0.0',
        description: 'Use the worker-managed Chromium with a persistent profile.',
        runtimes: ['claude-code'],
        files: { 'SKILL.md': '---\nname: persistent-browser\n---\nUse it.\n', 'scripts/run.sh': 'echo hi\n' },
        createdAt: '2026-10-14T10:00:00.000Z',
      },
      k.privateKey,
      k.raw,
    );
    const v = verifySkillBundle(bundle, [k.raw]);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.manifestSha256).toBe(manifestSha256);
      expect(v.manifest.files.find((f) => f.path === 'scripts/run.sh')?.executable).toBe(true);
    }
    expect(verifySkillBundle(bundle, [masterKey().raw]).ok).toBe(false);
  });
});

describe('assistant tools', () => {
  it('the new tools are strict and draft-only where they write', () => {
    expect(ASSISTANT_TOOLS.machine_inspect.kind).toBe('read');
    expect(ASSISTANT_TOOLS.draft_machine_task.kind).toBe('draft');
    expect(ASSISTANT_TOOLS.draft_tool_install.kind).toBe('draft');
    expect(ASSISTANT_TOOLS.draft_skill.kind).toBe('draft');
    expect(
      assistantToolInput('draft_machine_task').safeParse({
        workerId: 'wrk_win1',
        title: 't',
        prompt: 'p',
        approvalPolicy: 'deny-sensitive',
      }).success,
    ).toBe(false);
    expect(
      assistantToolInput('draft_tool_install').safeParse({ workerId: 'w', tool: 'browser', url: 'x' })
        .success,
    ).toBe(false);
  });
});
